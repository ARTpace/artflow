/**
 * obsidian-compat — `require("obsidian")` 的同名 shim（方案 D2 第一版）。
 *
 * 目标不是完整复刻 Obsidian API，而是让「只依赖 Plugin 基类门面」的插件源码
 * 接近零改动跑起来：loadData/saveData、addCommand、声明式设置页（settingsSchema）。
 * DOM 画法（PluginSettingTab.display / Modal / Editor）没有 DOM 可用，明确报错而非静默失败。
 *
 * Production runs inside the sandboxed guest window (no Node here), loaded as a
 * plain UMD script before module-table.cjs. The main process (guards/tests)
 * requires it through the same UMD wrapper.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ArtflowObsidianCompat = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /**
   * @param {object} options
   * @param {object} options.api     module-table 构造的沙箱 api（10 个能力面）
   * @param {string} options.pluginId 形如 local.xxx 的插件 id
   * @param {object} options.manifest { id, name, version }
   * @param {function(string): never} options.fail 校验失败即抛错的辅助
   */
  function createObsidianCompat({ api, pluginId, manifest, fail }) {
    const manifestInfo = Object.freeze({
      id: pluginId,
      name: manifest && typeof manifest.name === 'string' ? manifest.name : pluginId,
      version: manifest && typeof manifest.version === 'string' ? manifest.version : '0.0.0',
    });

    /** 访问任何属性都报错的宿主对象占位 —— 第一版 compat 不提供 vault/workspace。 */
    function unsupportedHostObject(hostPath) {
      return new Proxy(Object.create(null), {
        get(_target, prop) {
          if (prop === 'then' || prop === Symbol.toPrimitive) return undefined;
          throw new Error(
            `${hostPath}.${String(prop)} is not available in the artflow compat layer (yet). ` +
            'Command/setting/storage facades are supported; vault/workspace access maps to api.host.assets.',
          );
        },
      });
    }

    const appShim = {
      get manifest() { return manifestInfo; },
      get vault() { return unsupportedHostObject('app.vault'); },
      get workspace() { return unsupportedHostObject('app.workspace'); },
      get metadataCache() { return unsupportedHostObject('app.metadataCache'); },
      get fileManager() { return unsupportedHostObject('app.fileManager'); },
    };

    class Plugin {
      constructor(app, manifest) {
        this.app = app || appShim;
        this.manifest = manifest || manifestInfo;
        this._registeredEvents = [];
      }

      /** Obsidian: 从插件目录读 data.json。等价 api.storage.load()。 */
      async loadData() {
        const result = await api.storage.load();
        return result === null ? null : result;
      }

      /** Obsidian: 写插件目录 data.json。等价 api.storage.save()。 */
      async saveData(data) {
        return api.storage.save(data === undefined ? null : data);
      }

      /** Obsidian: { id, name, callback } → artflow 命令（id 自动加插件前缀）。 */
      addCommand(definition) {
        if (!definition || typeof definition.id !== 'string' || definition.id.length === 0) {
          fail('addCommand requires an id');
        }
        if (typeof definition.callback !== 'function') {
          fail(`addCommand "${definition.id}" requires a callback (checkCallback/editorCallback are not supported)`);
        }
        api.commands.register({
          id: `${manifestInfo.id}.${definition.id}`,
          title: typeof definition.name === 'string' && definition.name.length > 0
            ? definition.name.slice(0, 80)
            : definition.id.slice(0, 80),
          run: definition.callback,
        });
      }

      /**
       * Obsidian 的 addSettingTab 接受 DOM 画法的 PluginSettingTab 实例。
       * artflow 用声明式 schema：给 tab 对象一个 settingsSchema 数组即可。
       */
      addSettingTab(tab) {
        if (tab && Array.isArray(tab.settingsSchema) && tab.settingsSchema.length > 0) {
          api.ui.registerSettingsTab({
            id: `${manifestInfo.id}.settings`,
            title: manifestInfo.name,
            controls: tab.settingsSchema,
          });
          return;
        }
        console.warn(
          '[obsidian-compat] addSettingTab: DOM-based PluginSettingTab.display() has no DOM here. ' +
          'Provide a settingsSchema array on the tab object instead (see the artflow plugin dev guide).',
        );
      }
      /**
       * artflow 扩展（非 Obsidian API）：声明式交互面板。
       * 控件由宿主渲染，按钮动作回推 onAction；content 只进隔离 iframe。
       */
      addPanel(definition) {
        if (!definition || typeof definition !== 'object') {
          console.warn('[obsidian-compat] addPanel expects a definition object');
          return;
        }
        api.ui.registerPanel(Object.assign({}, definition, { id: definition.id || `${manifestInfo.id}.panel` }));
      }

      /** 接受 { unsubscribe() } 形状的事件引用，onunload 时逐个退订。 */
      registerEvent(reference) {
        if (reference && typeof reference.unsubscribe === 'function') {
          this._registeredEvents.push(reference);
        }
      }

      registerDomEvent() {
        throw new Error('registerDomEvent: the plugin sandbox has no DOM');
      }

      registerInterval() {
        throw new Error('registerInterval: the plugin sandbox has no timer (setInterval/setTimeout are unavailable)');
      }

      async onload() {}
      onunload() {}
    }

    /** Obsidian toast 的降级版：沙箱没有 UI 通道，先走插件日志（主进程可见）。 */
    class Notice {
      constructor(message) {
        const text = typeof message === 'string' ? message : String(message);
        try { console.log(`[notice] ${text.slice(0, 200)}`); } catch { /* 日志不能打断插件 */ }
      }
      setMessage(message) {
        try { console.log(`[notice] ${typeof message === 'string' ? message : String(message)}`); } catch { /* ignore */ }
        return this;
      }
      hide() {}
    }

    /** DOM 画法的设置页：没有 DOM，实例化即报错（转换器 D3 负责改写成 settingsSchema）。 */
    class PluginSettingTab {
      constructor(app, plugin) {
        this.app = app;
        this.plugin = plugin;
      }
      display() {
        throw new Error('PluginSettingTab.display(): no DOM in the sandbox — use a settingsSchema array on the tab object instead');
      }
    }

    /** 纯工具：路径归一化（够 Obsidian 常用的范围，不碰真实文件系统）。 */
    function normalizePath(path) {
      if (typeof path !== 'string') fail('normalizePath expects a string');
      return path.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/^\/+|\/+$/g, '');
    }

    /**
     * Obsidian requestUrl 的等价物：走沙箱 net 桥（主进程代发，https + manifest
     * network 域名白名单）。返回 { status, text, json }；throw 默认 true（非 2xx 抛错）。
     */
    function requestUrl(options) {
      if (!options || typeof options.url !== 'string') {
        return Promise.reject(new Error('requestUrl expects { url }'));
      }
      const shouldThrow = options.throw !== false;
      return api.net.fetch(options.url, {
        method: typeof options.method === 'string' ? options.method : 'GET',
        headers: options.headers && typeof options.headers === 'object' && !Array.isArray(options.headers)
          ? Object.fromEntries(Object.entries(options.headers).map(([key, value]) => [key, String(value)]))
          : undefined,
        body: typeof options.body === 'string' ? options.body : undefined,
      }).then(result => {
        if (!result || !result.ok) {
          const message = (result && result.message) || 'request failed';
          const error = new Error(`requestUrl: ${message}`);
          error.status = 0;
          if (shouldThrow) throw error;
          return { status: 0, text: '', json: () => { throw new Error('request failed'); } };
        }
        const body = result.result || { status: 0, text: '' };
        return {
          status: body.status,
          text: body.text,
          json: () => {
            try { return JSON.parse(body.text); } catch (error) {
              throw new Error(`requestUrl: response is not JSON (${error.message})`);
            }
          },
        };
      });
    }

    function debounce(fn, timeout, resetTimer) {
      if (typeof fn !== 'function') fail('debounce expects a function');
      let timer = null;
      const debounced = (...args) => {
        if (timer && resetTimer) { clearTimeout(timer); timer = null; }
        if (timer) return;
        timer = setTimeout(() => {
          timer = null;
          fn(...args);
        }, Math.max(0, Number(timeout) || 0));
      };
      debounced.cancel = () => { if (timer) { clearTimeout(timer); timer = null; } };
      debounced.run = () => { debounced.cancel(); fn(); };
      return debounced;
    }

    const Platform = Object.freeze({
      isMobile: false,
      isDesktop: true,
      isDesktopApp: true,
      isMobileApp: false,
      isIosApp: false,
      isAndroidApp: false,
    });

    /** 最小 moment：只做 format 令牌替换（YYYY MM DD HH mm ss SSS），不做时区/语言。 */
    function pad(value, width) {
      return String(value).padStart(width || 2, '0');
    }
    function moment(input) {
      const date = input instanceof Date ? input : (typeof input === 'number' ? new Date(input) : new Date());
      if (Number.isNaN(date.getTime())) fail('moment received an invalid date');
      return {
        toDate: () => date,
        valueOf: () => date.getTime(),
        format(pattern) {
          const patternText = typeof pattern === 'string' && pattern.length > 0 ? pattern : 'YYYY-MM-DD HH:mm:ss';
          return patternText
            .replace(/YYYY/g, String(date.getFullYear()))
            .replace(/MM/g, pad(date.getMonth() + 1))
            .replace(/DD/g, pad(date.getDate()))
            .replace(/HH/g, pad(date.getHours()))
            .replace(/mm/g, pad(date.getMinutes()))
            .replace(/ss/g, pad(date.getSeconds()))
            .replace(/SSS/g, pad(date.getMilliseconds(), 3));
        },
      };
    }

    /** 需要真实编辑器 / 文件树对象的导出：明确报错，给转换器指路。 */
    function makeUnsupportedClass(exportName, reason) {
      const message = `obsidian.${exportName} is not supported by the artflow compat layer: ${reason}`;
      return class Unsupported { constructor() { throw new Error(message); } };
    }

    const obsidian = Object.freeze({
      Plugin,
      Notice,
      Platform,
      moment,
      normalizePath,
      debounce,
      requestUrl,
      PluginSettingTab,
      TFile: makeUnsupportedClass('TFile', 'artflow assets are not files; use api.host.assets'),
      TFolder: makeUnsupportedClass('TFolder', 'artflow assets have no folder tree'),
      TAbstractFile: makeUnsupportedClass('TAbstractFile', 'artflow assets are not files'),
      MarkdownView: makeUnsupportedClass('MarkdownView', 'artflow has no Markdown editor'),
      Editor: makeUnsupportedClass('Editor', 'artflow has no Markdown editor'),
      Modal: makeUnsupportedClass('Modal', 'build DOM-free dialogs with declarative settings controls instead'),
      SuggestModal: makeUnsupportedClass('SuggestModal', 'build DOM-free dialogs with declarative settings controls instead'),
      Setting: makeUnsupportedClass('Setting', 'use the declarative settingsSchema controls'),
      Component: makeUnsupportedClass('Component', 'extend Plugin instead'),
    });

    /**
     * Obsidian 风格插件的激活：module.exports 是 Plugin 子类 → 实例化并调 onload。
     * onload 是 async 时返回 whenReady；失败会向上传播（guest 以激活失败回宿主）。
     */
    function activateExported(exported) {
      if (typeof exported !== 'function') {
        fail('obsidian compat mode expects module.exports to be a Plugin subclass');
      }
      const plugin = new exported(appShim, manifestInfo);
      if (!(plugin instanceof Plugin)) {
        fail('module.exports must extend the Plugin class from require("obsidian")');
      }
      const result = plugin.onload();
      const whenReady = Promise.resolve(result).then(() => plugin);
      return { plugin, whenReady };
    }

    return { obsidian, activateExported, manifest: manifestInfo };
  }

  return { createObsidianCompat };
});
