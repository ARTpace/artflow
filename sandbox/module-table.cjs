/**
 * The only names a third-party plugin can call.
 * Production runs this file inside the sandboxed guest window, where Node and
 * ipcRenderer do not exist. Do not evaluate plugin source in the main process.
 */
(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ArtflowModuleTable = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  const KNOWN_CARDS = new Set(['markdown', 'code', 'bookmark']);
  /** 与主进程 hostEvents 的上限保持一致（超出会被宿主拒绝）。 */
  const MAX_EVENT_SUBSCRIPTIONS = 16;
  const SETTINGS_CONTROL_TYPES = new Set(['text', 'password', 'toggle', 'number', 'select', 'button', 'note']);
  /** 交互面板控件：textarea 换掉 password（面板不做密码输入，秘密走 settings tab）。 */
  const PANEL_CONTROL_TYPES = new Set(['text', 'textarea', 'toggle', 'number', 'select', 'button', 'note']);
  const SETTINGS_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
  /** obsidian-compat 的获取方式：Node 侧（守卫/测试）走 require，guest 窗口走全局脚本。 */
  const compatFactory = (typeof module === 'object' && module.exports)
    ? require('./obsidian-compat.cjs')
    : (root && root.ArtflowObsidianCompat) || null;
  const LOCKED_GLOBALS = [
    'window', 'document', 'globalThis', 'global', 'self', 'process', 'require', 'module', 'exports',
    'fetch', 'XMLHttpRequest', 'WebSocket', 'localStorage', 'sessionStorage', 'indexedDB',
    'navigator', 'parent', 'top', 'frames', 'Function', 'importScripts',
  ];

  function fail(message) {
    throw new Error(message);
  }

  function cloneFields(fields) {
    let encoded;
    try { encoded = JSON.stringify(fields); } catch { fail('card fields must be plain data'); }
    if (!encoded || encoded.length > 100000) fail('card fields are too large');
    const cloned = JSON.parse(encoded);
    if (!cloned || typeof cloned !== 'object' || Array.isArray(cloned)) fail('card fields are invalid');
    return cloned;
  }

  function validateCardResult(value, pluginId) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail('format result must be an object');
    if (value.kind !== 'card') fail('sandboxed formats can only return a card');
    const custom = typeof pluginId === 'string' && typeof value.cardType === 'string' && value.cardType.startsWith(`${pluginId}.`);
    if (!KNOWN_CARDS.has(value.cardType) && !custom) fail('sandboxed formats can only create markdown, code, bookmark, or their own cards');
    if (typeof value.name !== 'string' || value.name.length === 0 || value.name.length > 180) fail('card name is invalid');
    if (!Number.isFinite(value.width) || !Number.isFinite(value.height) || value.width < 1 || value.height < 1 || value.width > 4000 || value.height > 4000) {
      fail('card size is invalid');
    }
    if (!value.fields || typeof value.fields !== 'object' || Array.isArray(value.fields)) fail('card fields are required');
    const fields = value.fields;
    if (value.cardType === 'markdown' && (typeof fields.content !== 'string' || fields.content.length > 120000)) fail('markdown content is invalid');
    if (value.cardType === 'code' && (typeof fields.code !== 'string' || fields.code.length > 120000 || typeof fields.language !== 'string' || fields.language.length > 32)) {
      fail('code card is invalid');
    }
    if (value.cardType === 'bookmark') {
      if (typeof fields.url !== 'string' || !/^https?:\/\//.test(fields.url) || fields.url.length > 2000) fail('bookmark url is invalid');
      if (typeof fields.title !== 'string' || fields.title.length > 180) fail('bookmark title is invalid');
      if (typeof fields.domain !== 'string' || fields.domain.length > 180) fail('bookmark domain is invalid');
    }
    const plainFields = value.cardType === 'markdown'
      ? { content: fields.content }
      : value.cardType === 'code'
        ? { code: fields.code, language: fields.language }
        : value.cardType === 'bookmark'
          ? { url: fields.url, title: fields.title, domain: fields.domain }
          : cloneFields(fields);
    return {
      kind: 'card',
      cardType: value.cardType,
      name: value.name,
      width: value.width,
      height: value.height,
      fields: plainFields,
    };
  }

  function validateSettingsControl(control, pluginId) {
    if (!control || typeof control !== 'object' || Array.isArray(control)) fail('settings control must be an object');
    if (typeof control.type !== 'string' || !SETTINGS_CONTROL_TYPES.has(control.type)) {
      fail(`settings control type must be one of: ${[...SETTINGS_CONTROL_TYPES].join(', ')}`);
    }
    if (control.type === 'note') {
      if (typeof control.text !== 'string' || control.text.length === 0 || control.text.length > 200) fail('note text is invalid');
      return { type: 'note', text: control.text };
    }
    if (typeof control.key !== 'string' || !SETTINGS_KEY_PATTERN.test(control.key)) fail('settings key must match [A-Za-z_][A-Za-z0-9_]* (max 64)');
    if (typeof control.label !== 'string' || control.label.length === 0 || control.label.length > 80) fail('settings label is invalid');
    if (control.type === 'button') {
      if (typeof control.commandId !== 'string' || !pluginId || !control.commandId.startsWith(`${pluginId}.`)) {
        fail('button commandId must be a command registered by this plugin');
      }
      return { type: 'button', key: control.key, label: control.label, commandId: control.commandId };
    }
    const normalized = { type: control.type, key: control.key, label: control.label };
    if (control.description !== undefined) {
      if (typeof control.description !== 'string' || control.description.length > 200) fail('settings description is invalid');
      normalized.description = control.description;
    }
    if (control.type === 'select') {
      if (!Array.isArray(control.options) || control.options.length < 1 || control.options.length > 32) fail('select requires 1 to 32 options');
      const options = control.options.map(option => {
        if (!option || typeof option !== 'object' || typeof option.value !== 'string' || option.value.length === 0 || option.value.length > 80) {
          fail('select option value is invalid');
        }
        const label = typeof option.label === 'string' && option.label.length > 0 ? option.label.slice(0, 80) : option.value;
        return { value: option.value, label };
      });
      normalized.options = options;
    }
    if (control.type === 'number') {
      for (const field of ['min', 'max', 'step']) {
        if (control[field] !== undefined && !Number.isFinite(control[field])) fail(`number ${field} must be a finite number`);
      }
      for (const field of ['min', 'max', 'step']) {
        if (control[field] !== undefined) normalized[field] = control[field];
      }
    }
    if (control.default !== undefined) {
      const value = control.default;
      const valid = control.type === 'toggle' ? typeof value === 'boolean'
        : control.type === 'number' ? typeof value === 'number' && Number.isFinite(value)
        : control.type === 'select' ? typeof value === 'string' && normalized.options.some(option => option.value === value)
        : typeof value === 'string';
      if (!valid) fail(`settings default does not match the control type (${control.type})`);
      normalized.default = value;
    }
    return normalized;
  }

  /** 交互面板控件：形状与设置控件相近，但 button 携带 action（动作 id）而非 commandId。 */
  function validatePanelControl(control) {
    if (!control || typeof control !== 'object' || Array.isArray(control)) fail('panel control must be an object');
    if (typeof control.type !== 'string' || !PANEL_CONTROL_TYPES.has(control.type)) {
      fail(`panel control type must be one of: ${[...PANEL_CONTROL_TYPES].join(', ')}`);
    }
    if (control.type === 'note') {
      if (typeof control.text !== 'string' || control.text.length === 0 || control.text.length > 200) fail('note text is invalid');
      return { type: 'note', text: control.text };
    }
    if (typeof control.key !== 'string' || !SETTINGS_KEY_PATTERN.test(control.key)) fail('panel key must match [A-Za-z_][A-Za-z0-9_]* (max 64)');
    if (typeof control.label !== 'string' || control.label.length === 0 || control.label.length > 80) fail('panel label is invalid');
    const normalized = { type: control.type, key: control.key, label: control.label };
    if (control.placeholder !== undefined) {
      if (typeof control.placeholder !== 'string' || control.placeholder.length > 120) fail('panel placeholder is invalid');
      normalized.placeholder = control.placeholder;
    }
    if (control.type === 'button') {
      if (typeof control.action !== 'string' || !/^[A-Za-z0-9_-]{1,48}$/.test(control.action)) {
        fail('button action must match [A-Za-z0-9_-]{1,48}');
      }
      normalized.action = control.action;
      return normalized;
    }
    if (control.type === 'textarea') {
      // textarea 复用 text 的值形状（字符串）；只差渲染方式。
      return normalized;
    }
    if (control.type === 'select') {
      if (!Array.isArray(control.options) || control.options.length < 1 || control.options.length > 32) fail('select requires 1 to 32 options');
      normalized.options = control.options.map(option => {
        if (!option || typeof option !== 'object' || typeof option.value !== 'string' || option.value.length === 0 || option.value.length > 80) {
          fail('select option value is invalid');
        }
        return { value: option.value, label: typeof option.label === 'string' && option.label.length > 0 ? option.label.slice(0, 80) : option.value };
      });
    }
    if (control.type === 'number') {
      for (const field of ['min', 'max', 'step']) {
        if (control[field] !== undefined) {
          if (!Number.isFinite(control[field])) fail(`number ${field} must be a finite number`);
          normalized[field] = control[field];
        }
      }
    }
    if (control.default !== undefined) {
      const value = control.default;
      const valid = control.type === 'toggle' ? typeof value === 'boolean'
        : control.type === 'number' ? typeof value === 'number' && Number.isFinite(value)
        : control.type === 'select' ? typeof value === 'string' && normalized.options.some(option => option.value === value)
        : typeof value === 'string';
      if (!valid) fail(`panel default does not match the control type (${control.type})`);
      normalized.default = value;
    }
    return normalized;
  }

  function evaluatePluginSource(source, pluginId, bridge, info) {
    if (typeof source !== 'string' || source.length === 0 || source.length > 65536) fail('plugin source is empty or too large');
    if (typeof pluginId !== 'string' || !/^local\.[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(pluginId)) fail('plugin id is invalid');
    const hostApiVersion = info && typeof info.hostApiVersion === 'string' ? info.hostApiVersion : '1.0.0';
    const formats = new Map();
    const commands = new Map();
    const assets = new Map();
    const panels = [];
    const cards = [];
    /** ui.registerPanel 的动作回调表：panelId → onAction。动作从渲染层经主进程回推到这里执行。 */
    const panelActions = new Map();
    const settingsTabs = [];
    /** subscriptionId -> { name, handler }。handler 只活在这个窗口里。 */
    const eventHandlers = new Map();
    let eventSeq = 0;
    const owns = id => typeof id === 'string' && id.startsWith(`${pluginId}.`) && id.length <= 80;
    const callBridge = (op, fields) => {
      if (typeof bridge !== 'function') fail('file and network calls need a host bridge');
      return bridge(op, fields || {});
    };

    const api = Object.freeze({
      formats: Object.freeze({
        register(definition) {
          if (!definition || !owns(definition.id)) fail('format id must start with the plugin id');
          if (!Array.isArray(definition.extensions) || definition.extensions.length === 0 || definition.extensions.length > 8) fail('extensions are invalid');
          const extensions = definition.extensions.map(extension => {
            if (typeof extension !== 'string' || !/^[a-z0-9]{1,16}$/.test(extension)) fail('extension is invalid');
            return extension;
          });
          if (typeof definition.parse !== 'function') fail('format parse is required');
          formats.set(definition.id, { extensions, parse: definition.parse });
        },
      }),
      commands: Object.freeze({
        register(definition) {
          if (!definition || !owns(definition.id)) fail('command id must start with the plugin id');
          if (typeof definition.title !== 'string' || definition.title.length === 0 || definition.title.length > 80) fail('command title is invalid');
          if (typeof definition.run !== 'function') fail('command run is required');
          const description = typeof definition.description === 'string' ? definition.description.slice(0, 200) : '';
          commands.set(definition.id, { title: definition.title, description, run: definition.run });
        },
      }),
      panels: Object.freeze({
        register(definition) {
          if (!definition || !owns(definition.id)) fail('panel id must start with the plugin id');
          if (panels.length >= 4) fail('too many panels');
          if (typeof definition.title !== 'string' || definition.title.length === 0 || definition.title.length > 80) fail('panel title is invalid');
          if (typeof definition.html !== 'string' || definition.html.length === 0 || definition.html.length > 8000) fail('panel html is invalid');
          panels.push({ id: definition.id, title: definition.title, html: definition.html });
        },
      }),
      cards: Object.freeze({
        register(definition) {
          if (!definition || !owns(definition.nodeType)) fail('card type must start with the plugin id');
          if (cards.length >= 8) fail('too many cards');
          cards.push({ nodeType: definition.nodeType });
        },
      }),
      assets: Object.freeze({
        register(definition) {
          if (!definition || !owns(definition.id)) fail('asset source id must start with the plugin id');
          if (typeof definition.title !== 'string' || definition.title.length === 0 || definition.title.length > 80) fail('asset source title is invalid');
          if (typeof definition.probe !== 'function') fail('asset source probe is required');
          assets.set(definition.id, {
            title: definition.title,
            probe: definition.probe,
            submit: typeof definition.submit === 'function' ? definition.submit : null,
          });
        },
      }),
      files: Object.freeze({
        read: path => callBridge('read', { path }),
        write: (path, text) => callBridge('write', { path, text }),
        /** unrestricted 大字节通道：parse 输入直接落主进程仓拿 ref（fields 只放 ref，不塞字节）。 */
        storeInput: () => callBridge('store-input'),
        store: bytes => {
          if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0) fail('store expects non-empty bytes');
          return callBridge('store', { bytes });
        },
        /** 插件漫画档案通道：暂存输入落仓 + ZIP 引擎解析页清单（与内置阅读器同引擎）。 */
        openArchiveInput: () => callBridge('archive-open'),
      }),
      net: Object.freeze({
        /** 需权限 network 域名白名单。options 可带 { method, headers, body }（POST/GET）。 */
        fetch: (url, options) => callBridge('fetch', {
          url,
          method: options && typeof options.method === 'string' ? options.method : undefined,
          headers: options && options.headers && typeof options.headers === 'object' ? options.headers : undefined,
          body: options && typeof options.body === 'string' ? options.body : undefined,
        }),
      }),
      /**
       * 插件自有 KV 持久化（对应 Obsidian 的 loadData/saveData）。
       * 数据固定落在插件自己目录的 data.json（≤256KB），插件不可选路径，
       * 所以**不需要权限**。第一次用（没有文件）时 load() 返回 null。
       * data.json 损坏时 load() 会抛错 —— 静默返回 null 会在下次 save 时吞掉状态。
       */
      storage: Object.freeze({
        /** 读持久化数据；从未保存过返回 null。损坏的 data.json 抛错。 */
        load: () => callBridge('data-load').then(result => (result && result.data !== undefined ? result.data : null)),
        /** 写持久化数据（须 JSON 可序列化，≤256KB）。 */
        save: data => callBridge('data-save', { data }),
      }),
      /**
       * 声明式 UI（对应 Obsidian 的 `addSettingTab`/`Setting`）。
       *
       * 和 panels 一样是**本地登记**（不过 bridge、不需要权限）：schema 随 catalog 带给
       * 渲染进程，由宿主的插件管理器画出表单，值读写插件自己的 data.json
       * （api.storage）。插件不写任何 UI 代码。
       */
      ui: Object.freeze({
        registerSettingsTab(definition) {
          if (!definition || typeof definition !== 'object') fail('settings tab definition is required');
          if (!owns(definition.id)) fail('settings tab id must start with the plugin id');
          if (settingsTabs.length >= 1) fail('a plugin may register at most one settings tab');
          if (typeof definition.title !== 'string' || definition.title.length === 0 || definition.title.length > 80) fail('settings tab title is invalid');
          if (!Array.isArray(definition.controls) || definition.controls.length < 1 || definition.controls.length > 16) {
            fail('settings tab requires 1 to 16 controls');
          }
          settingsTabs.push({
            id: definition.id,
            title: definition.title,
            controls: definition.controls.map(control => validateSettingsControl(control, pluginId)),
          });
        },
        /**
         * 声明式交互面板（Obsidian `Modal` 的等价物，第一版）：
         * 控件由宿主渲染，按钮动作经主进程回推到插件的 `onAction` 执行，
         * 返回值（content/notice/error）原样带回渲染层。html 内容只进沙箱 iframe，
         * 永不注入宿主 DOM。本地登记，无需权限。
         */
        registerPanel(definition) {
          if (!definition || typeof definition !== 'object') fail('panel definition is required');
          if (!owns(definition.id)) fail('panel id must start with the plugin id');
          if (panels.some(panel => panel.id === definition.id)) fail('panel id is already registered');
          if (panels.length >= 4) fail('too many panels');
          if (typeof definition.title !== 'string' || definition.title.length === 0 || definition.title.length > 80) fail('panel title is invalid');
          if (typeof definition.onAction !== 'function') fail('panel requires an onAction handler');
          const controls = definition.controls === undefined ? [] : definition.controls;
          if (!Array.isArray(controls) || controls.length > 16) fail('panel requires 0 to 16 controls');
          if (definition.content !== undefined && (typeof definition.content !== 'string' || definition.content.length > 8000)) {
            fail('panel content must be a string of at most 8000 characters');
          }
          panels.push({
            id: definition.id,
            title: definition.title,
            schema: {
              controls: controls.map(control => validatePanelControl(control)),
              ...(definition.content !== undefined ? { content: definition.content } : {}),
            },
          });
          panelActions.set(definition.id, definition.onAction);
        },
      }),
      /**
       * 第 8 个能力面：受控宿主对象图。
       *
       * 前七面是「投稿」（登记一个命令/面板/格式），这一面是「读取并操作宿主状态」。
       * 与 `assets.register`（登记一个资产**源**）不是一回事 —— `host.assets` 读的是
       * 宿主自己的资产库。
       *
       * 权限在**主进程**逐方法校验：manifest 的 `permissions.host` 里没声明对应权限时，
       * 调用会被拒绝并抛出 Error（不是静默返回空）。沙箱里没有旁路 —— 这是唯一入口。
       */
      host: Object.freeze({
        meta: Object.freeze({ pluginId, hostApiVersion }),
        assets: Object.freeze({
          /** 需权限 assets.read。返回 AssetRef[]。 */
          list: options => callBridge('host', { namespace: 'assets', method: 'list', args: [options] })
            .then(result => (result && result.assets) || []),
          /** 需权限 assets.read。找不到返回 null。 */
          get: id => callBridge('host', { namespace: 'assets', method: 'get', args: [id] })
            .then(result => (result && result.asset) || null),
          /** 需权限 assets.write。changes 为 { id, name }[]（1~40 条）。 */
          rename: changes => callBridge('host', { namespace: 'assets', method: 'rename', args: [{ changes }] }),
        }),
        /**
         * 宿主事件订阅（需权限 events.subscribe）。
         *
         * handler 本身永不出沙箱：本地存表 + 给宿主登记一个 subscriptionId，
         * 宿主发生变更时回推 `{ subscriptionId, name, payload }`，在这里按 id 找回 handler。
         * 所以 `on()` 同步返回 id，登记是后台异步的 —— 登记失败（最常见是 manifest 里
         * 没声明权限）会立刻撤销本地 handler 并 console.error，不会静默哑掉。
         */
        events: Object.freeze({
          /** 宿主当前支持的事件名（权威列表，别硬编码）。 */
          names: () => callBridge('host', { namespace: 'events', method: 'list', args: [] })
            .then(result => (result && result.events) || []),
          on(name, handler) {
            if (typeof name !== 'string' || name.length === 0 || name.length > 40) fail('event name is invalid');
            if (typeof handler !== 'function') fail('event handler must be a function');
            if (eventHandlers.size >= MAX_EVENT_SUBSCRIPTIONS) fail(`at most ${MAX_EVENT_SUBSCRIPTIONS} subscriptions are allowed`);
            const subscriptionId = `${pluginId}#e${++eventSeq}`;
            eventHandlers.set(subscriptionId, { name, handler });
            callBridge('host', { namespace: 'events', method: 'subscribe', args: [{ subscriptionId, names: [name] }] })
              .catch(error => {
                eventHandlers.delete(subscriptionId);
                console.error(`[events] subscribe "${name}" failed: ${(error && error.message) || error}`);
              });
            return subscriptionId;
          },
          off(subscriptionId) {
            const existed = eventHandlers.delete(subscriptionId);
            if (!existed) return Promise.resolve(false);
            return callBridge('host', { namespace: 'events', method: 'unsubscribe', args: [{ subscriptionId }] })
              .then(() => true);
          },
        }),
      }),
    });

    const table = Object.freeze({
      modules: Object.freeze({
        definePlugin(setup) {
          if (typeof setup !== 'function') fail('definePlugin expects a function');
          setup(api);
        },
      }),
    });

    // 白名单 require：只认 "obsidian"（同名 shim）；@codemirror/* 与其余一切给明确报错。
    const manifestInfo = info && typeof info.manifest === 'object' && info.manifest ? info.manifest : null;
    // compat 上下文必须整个会话只建一次：require("obsidian").Plugin 与
    // activateExported 的 instanceof 检查必须是同一个类，否则永远不匹配。
    let compatContext = null;
    function getCompat() {
      if (!compatFactory) fail('obsidian compat layer is not loaded in this window');
      if (!compatContext) {
        compatContext = compatFactory.createObsidianCompat({ api, pluginId, manifest: manifestInfo, fail });
      }
      return compatContext;
    }
    function boundedRequire(id) {
      if (id === 'obsidian') return getCompat().obsidian;
      if (typeof id === 'string' && id.startsWith('@codemirror/')) {
        throw new Error(`module "${id}" is not available: artflow has no Markdown editor`);
      }
      throw new Error(`module "${id}" is not available in the plugin sandbox (allowlist: obsidian)`);
    }

    const moduleObj = { exports: {} };
    const injectLocked = name => (
      name === 'require' ? boundedRequire
        : name === 'module' ? moduleObj
          : name === 'exports' ? moduleObj.exports
            : undefined
    );
    const runner = new Function('Artflow', ...LOCKED_GLOBALS, `"use strict";\n${source}`);
    runner(table, ...LOCKED_GLOBALS.map(injectLocked));

    // compat 激活：module.exports 是 Plugin 子类，或 esbuild CJS 互操作形状
    // （exports.default = class，Obsidian 官方加载器同样兼容这一形态）。
    // onload 是 async 时 catalog 延迟到 whenReady 之后生成（guest.js 会等它）。
    let whenReady = Promise.resolve();
    const rawExport = moduleObj.exports;
    const compatExport = typeof rawExport === 'function' ? rawExport
      : rawExport && typeof rawExport === 'object' && typeof rawExport.default === 'function' ? rawExport.default
        : null;
    if (compatExport) {
      const hasContributions = commands.size > 0 || formats.size > 0 || assets.size > 0 || panels.length > 0 || cards.length > 0 || settingsTabs.length > 0;
      if (hasContributions) fail('plugin mixed module.exports with Artflow.modules.definePlugin; pick one entry style');
      whenReady = getCompat().activateExported(compatExport).whenReady;
    }

    const buildCatalog = () => ({
        formats: [...formats.entries()].map(([id, format]) => ({ id, extensions: format.extensions })),
        commands: [...commands.entries()].map(([id, command]) => ({ id, title: command.title, description: command.description })),
        assets: [...assets.entries()].map(([id, asset]) => ({ id, title: asset.title, canSubmit: Boolean(asset.submit) })),
        cards,
        panels,
        settingsTabs,
    });

    return {
      catalog: buildCatalog(),
      whenReady,
      buildCatalog,
      async parse(handlerId, file) {
        const format = formats.get(handlerId);
        if (!format) fail('format handler is not registered');
        return validateCardResult(await format.parse(file), pluginId);
      },
      async run(commandId) {
        const command = commands.get(commandId);
        if (!command) fail('command is not registered');
        await command.run();
      },
      /** 渲染层按钮动作回推：执行插件的 onAction 并把结果带回（content/notice/error）。 */
      async dispatchPanelAction(panelId, actionId, values) {
        const handler = panelActions.get(panelId);
        if (!handler) fail('panel is not registered');
        if (typeof actionId !== 'string' || !/^[A-Za-z0-9_-]{1,48}$/.test(actionId)) fail('panel action id is invalid');
        if (!values || typeof values !== 'object' || Array.isArray(values)) fail('panel values are invalid');
        for (const key of Object.keys(values)) {
          if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(key)) fail('panel value key is invalid');
        }
        const result = await handler(actionId, values);
        if (!result || typeof result !== 'object' || Array.isArray(result)) return {};
        const out = {};
        if (typeof result.notice === 'string') out.notice = result.notice.slice(0, 200);
        if (typeof result.error === 'string') out.error = result.error.slice(0, 200);
        if (result.content !== undefined) {
          if (typeof result.content !== 'string' || result.content.length > 8000) fail('panel content must be a string of at most 8000 characters');
          out.content = result.content;
        }
        return out;
      },
      async probe(sourceId) {
        const asset = assets.get(sourceId);
        if (!asset) fail('asset source is not registered');
        const status = await asset.probe();
        if (!status || typeof status.online !== 'boolean') fail('asset probe result is invalid');
        return {
          online: status.online,
          endpoint: `sandbox:${sourceId}`,
          message: typeof status.message === 'string' ? status.message.slice(0, 200) : '',
        };
      },
      async submit(sourceId, submission) {
        const asset = assets.get(sourceId);
        if (!asset || !asset.submit) fail('asset source cannot submit');
        const result = await asset.submit(submission || {});
        if (!result || typeof result.assetDataUrl !== 'string' || !result.assetDataUrl.startsWith('data:') || result.assetDataUrl.length > 1500000) {
          fail('asset data is invalid');
        }
        if (typeof result.mimeType !== 'string' || result.mimeType.length > 80) fail('asset mime type is invalid');
        const metadata = result.metadata && typeof result.metadata === 'object' && !Array.isArray(result.metadata) ? result.metadata : {};
        for (const key of Object.keys(metadata)) {
          if (!key.startsWith(`${pluginId}.`)) fail('asset metadata must use the plugin id prefix');
        }
        return { assetDataUrl: result.assetDataUrl, mimeType: result.mimeType, metadata };
      },
      /**
       * 宿主回推一条事件。返回是否命中了本地 handler（false 多为已 off 或登记失败）。
       * handler 抛错只打日志 —— 插件的事件处理永远不能反过来打断宿主。
       */
      dispatchEvent(message) {
        const subscriptionId = message && typeof message.subscriptionId === 'string' ? message.subscriptionId : '';
        const entry = eventHandlers.get(subscriptionId);
        if (!entry) return false;
        try {
          const outcome = entry.handler(message.payload);
          if (outcome && typeof outcome.then === 'function') {
            outcome.catch(error => console.error(`[events] handler for "${entry.name}" failed: ${(error && error.message) || error}`));
          }
        } catch (error) {
          console.error(`[events] handler for "${entry.name}" failed: ${(error && error.message) || error}`);
        }
        return true;
      },
    };
  }

  return { evaluatePluginSource, validateCardResult };
});
