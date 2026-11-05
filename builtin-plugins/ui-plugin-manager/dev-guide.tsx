/**
 * 「插件开发指南」内联区块。
 *
 * 面向只安装了 artflow、不持有它源码的第三方开发者。内容与
 * `types/artflow-plugin.d.ts`（类型契约）和 `examples/local.asset-rename`
 * （可运行的完整示例）保持同源 —— 改这里时三处要一起改。
 */
import React from 'react';

const MANIFEST_SAMPLE = `{
  "id": "local.my-plugin",
  "name": "我的插件",
  "description": "一句话说明这个插件做什么。",
  "runtime": { "mode": "sandboxed", "entry": "plugin.js" },
  "minHostVersion": "1.0.0",
  "permissions": { "host": ["assets.read"] }
}`;

const PLUGIN_SAMPLE = `// plugin.js —— 在沙箱里运行，只能用 api 暴露出来的能力
Artflow.modules.definePlugin(function (api) {
  // 1) 命令：出现在命令面板里
  api.commands.register({
    id: 'local.my-plugin.hello',
    title: '打个招呼',
    description: '在控制台输出一句话。',
    run: function () {
      console.log('hello from my plugin');
    },
  });

  // 2) 格式：右键文件时可用本插件打开
  api.formats.register({
    id: 'local.my-plugin.note',
    extensions: ['note'],
    parse: async function (file) {
      var text = await file.text();
      return {
        kind: 'card',
        cardType: 'markdown',
        name: file.name,
        width: 420,
        height: 320,
        fields: { content: text },
      };
    },
  });

  // 3) 宿主对象：读宿主自己的资产库
  //    必须在清单里声明 permissions.host，否则调用会被拒绝（不是返回空）。
  api.commands.register({
    id: 'local.my-plugin.count',
    title: '数一下资产',
    run: async function () {
      var assets = await api.host.assets.list({ limit: 100 });
      var unused = assets.filter(function (a) { return a.usage === 'none'; });
      console.log('共 ' + assets.length + ' 个资产，未引用 ' + unused.length + ' 个');
    },
  });

  // 4) 宿主事件：资产变化时被回调（权限 events.subscribe）
  //    handler 留在沙箱里；on() 同步返回订阅 id，off(id) 退订。
  //    可用事件：asset.added / asset.renamed / asset.removed（api.host.events.names() 取权威列表）。
  api.host.events.on('asset.added', function (event) {
    console.log('新资产进库：' + event.asset.name + '（' + event.asset.id + '）');
  });

  // 5) 插件自有持久化：存设置与状态（无需权限，落插件目录的 data.json，≤256KB）
  api.storage.load().then(function (state) {
    var current = (state && state.count) || 0;
    return api.storage.save({ count: current + 1 });
  });

  // 6) 声明式设置页：宿主替你画表单（无需权限，值自动存进 data.json）
  //    每插件最多 1 个 tab、16 个控件；用户改完 400ms 后自动保存。
  api.ui.registerSettingsTab({
    id: 'local.my-plugin.settings',
    title: 'My Plugin',
    controls: [
      { type: 'text', key: 'endpoint', label: '服务地址', default: 'https://example.com' },
      { type: 'toggle', key: 'verbose', label: '详细日志', default: false },
      { type: 'select', key: 'mode', label: '模式', options: [{ value: 'fast', label: '快速' }, { value: 'best', label: '最佳' }] },
      { type: 'button', key: 'run_now', label: '立即同步', commandId: 'local.my-plugin.sync' },
    ],
  });
});`;

const CAPABILITIES: ReadonlyArray<{ name: string; zh: string; en: string }> = [
  { name: 'formats', zh: '按扩展名注册解析器，产出卡片', en: 'Parse files by extension into cards' },
  { name: 'commands', zh: '命令面板里可执行的动作', en: 'Actions runnable from the command palette' },
  { name: 'panels', zh: '画布上的面板（HTML 片段 / React 组件）', en: 'Panels on the canvas (HTML or React)' },
  { name: 'cards', zh: '声明自定义卡片类型', en: 'Declare custom card types' },
  { name: 'assets', zh: '外部资产源：探活与提交', en: 'External asset sources: probe and submit' },
  { name: 'files', zh: '文件读写（由宿主代劳）', en: 'File access, proxied by the host' },
  { name: 'net', zh: '网络请求（由宿主代发）', en: 'Network requests, proxied by the host' },
  { name: 'storage', zh: '插件自己的 KV 持久化（data.json，≤256KB，无需权限）', en: 'Plugin-owned KV persistence (data.json, ≤256KB, no permission needed)' },
  { name: 'ui', zh: '声明式设置页：宿主画表单，值自动存 data.json（无需权限）', en: 'Declarative settings tab: the host renders the form, values land in data.json (no permission needed)' },
  { name: 'host', zh: '宿主对象：读资产库、订阅资产事件（需在 permissions.host 声明权限）', en: 'Host objects: controlled access to assets and events (declare it in permissions.host)' },
];

const LIMITS: ReadonlyArray<{ zh: string; en: string }> = [
  { zh: '插件 id 必须以 local. 开头，这就是「外部插件」与内置插件的分界线', en: 'The plugin id must start with local. — that is the boundary from built-in plugins' },
  { zh: '每条贡献 id 都必须以插件 id 开头，例如 local.my-plugin.hello', en: 'Every contribution id must start with the plugin id, e.g. local.my-plugin.hello' },
  { zh: 'plugin.js 不超过 64 KB，且必须同步调用 Artflow.modules.definePlugin（或用 Obsidian 写法：require("obsidian") + module.exports = class extends Plugin）', en: 'plugin.js must be under 64 KB and call Artflow.modules.definePlugin synchronously (or use the Obsidian style: require("obsidian") + module.exports = class extends Plugin)' },
  { zh: 'Obsidian 兼容层支持 loadData/saveData、addCommand、声明式设置页（settingsSchema）；DOM 画法与 vault 对象不支持', en: 'The Obsidian compat layer supports loadData/saveData, addCommand, and declarative settings (settingsSchema); DOM painting and vault objects are not supported' },
  { zh: '面板最多 4 个、内联 HTML 不超过 8000 字符；自定义卡片最多 8 个', en: 'At most 4 panels (8000-char inline HTML) and 8 custom card types' },
  { zh: '沙箱里 window / document / fetch 等 20 个全局都是 undefined；require 只认 "obsidian"（同名兼容层）', en: 'Inside the sandbox 20 globals including window / document / fetch are undefined; require only accepts "obsidian" (the compat shim)' },
  { zh: 'api.host 每个方法都要在 permissions.host 里声明权限，没声明会被拒绝调用（不是返回空）', en: 'Every api.host method needs its permission in permissions.host — otherwise the call is refused, not left empty' },
  { zh: 'api.host.events.on(...) 同步返回订阅 id；登记失败会撤销 handler 并 console.error（不会静默哑掉）', en: 'api.host.events.on(...) returns a subscription id synchronously; a failed registration removes the handler and console.errors (never silent)' },
  { zh: '设置页每插件最多 1 个、控件 1~16 个；值自动存 data.json（≤256KB）', en: 'At most 1 settings tab with 1-16 controls per plugin; values auto-save into data.json (≤256KB)' },
  { zh: 'console.log 会转发到主进程终端：前缀 [plugin] <你的插件 id>', en: 'console.log is forwarded to the host terminal, prefixed [plugin] <your plugin id>' },
];

const CopyableCode: React.FC<{ label: string; code: string; copyLabel: string; copiedLabel: string }> = ({ label, code, copyLabel, copiedLabel }) => {
  const [copied, setCopied] = React.useState(false);
  const copy = () => {
    void navigator.clipboard.writeText(code).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    }).catch(() => {});
  };
  return (
    <div className="overflow-hidden rounded-lg border border-white/10 bg-black/40">
      <div className="flex items-center justify-between gap-2 border-b border-white/10 px-2 py-1">
        <span className="truncate font-mono text-[10px] text-neutral-400">{label}</span>
        <button type="button" onClick={copy}
          className="shrink-0 rounded border border-white/10 px-1.5 py-0.5 text-[10px] text-neutral-300 hover:bg-white/10 hover:text-neutral-100">
          {copied ? copiedLabel : copyLabel}
        </button>
      </div>
      <pre className="max-h-60 overflow-auto px-2 py-1.5 text-[11px] leading-4 text-neutral-200"><code>{code}</code></pre>
    </div>
  );
};

export const PluginDevGuide: React.FC<{ language: 'zh' | 'en'; onClose: () => void }> = ({ language, onClose }) => {
  const zh = language !== 'en';
  const t = zh ? {
    title: '插件开发指南',
    close: '关闭指南',
    intro: '这份指南面向只安装了 artflow、没有它源码的开发者 —— 整个流程不需要看 artflow 任何一行源码。',
    step1: '建一个文件夹，放两个文件：manifest.json 与 plugin.js。',
    step2: '在 artflow 里执行「安装插件」命令，选中这个文件夹。',
    step3: '重新加载后插件生效，可随时在「打开插件目录」里改代码。',
    step3Note: '如果插件带了 client.js（React 组件），安装时会先弹出权限确认框。',
    apiTitle: '可以调用的十个能力面',
    limitTitle: '会被真实校验的硬限制',
    footer: '完整示例与 TypeScript 类型声明都在安装目录的 resources/plugin-sdk/ 下，可直接拷出来改。',
    copy: '复制', copied: '已复制',
  } : {
    title: 'Plugin development guide',
    close: 'Close guide',
    intro: 'This guide is for developers who only installed artflow and have no access to its source — nothing below requires reading a single line of it.',
    step1: 'Create a folder with two files: manifest.json and plugin.js.',
    step2: 'Run the “Install plugin” command in artflow and pick that folder.',
    step3: 'Reload and the plugin is live; edit the code any time via “Open plugin folder”.',
    step3Note: 'If the plugin ships a client.js (React component), a permission prompt appears first.',
    apiTitle: 'The ten capabilities you can call',
    limitTitle: 'Limits that are actually enforced',
    footer: 'Full examples and TypeScript definitions ship in resources/plugin-sdk/ of the install folder — copy them out and edit.',
    copy: 'Copy', copied: 'Copied',
  };

  return (
    <section data-bp-plugin-dev-guide="" aria-label={t.title}
      className="space-y-2 rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2">
      <header className="flex items-center justify-between gap-2">
        <h3 className="text-xs font-semibold text-neutral-100">{t.title}</h3>
        <button type="button" onClick={onClose} aria-label={t.close} title={t.close}
          className="flex h-5 w-5 items-center justify-center rounded text-neutral-400 hover:bg-white/10 hover:text-neutral-100">
          <svg viewBox="0 0 16 16" aria-hidden className="h-3 w-3"><path d="M4 4l8 8M12 4l-8 8" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>
        </button>
      </header>

      <p className="text-[11px] leading-4 text-neutral-400">{t.intro}</p>

      <ol className="list-decimal space-y-2 pl-4">
        <li className="text-[11px] leading-4 text-neutral-300">
          <span>{t.step1}</span>
          <div className="mt-1.5"><CopyableCode label="manifest.json" code={MANIFEST_SAMPLE} copyLabel={t.copy} copiedLabel={t.copied} /></div>
        </li>
        <li className="text-[11px] leading-4 text-neutral-300">
          <span>{t.step2}</span>
          <div className="mt-1.5"><CopyableCode label="plugin.js" code={PLUGIN_SAMPLE} copyLabel={t.copy} copiedLabel={t.copied} /></div>
        </li>
        <li className="text-[11px] leading-4 text-neutral-300">
          <span>{t.step3}</span>
          <p className="mt-0.5 text-[10px] leading-4 text-neutral-500">{t.step3Note}</p>
        </li>
      </ol>

      <div className="rounded-lg border border-white/10 bg-white/[0.02] px-2 py-1.5">
        <h4 className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-neutral-400">{t.apiTitle}</h4>
        <ul className="space-y-0.5">
          {CAPABILITIES.map(item => (
            <li key={item.name} className="flex gap-2 text-[11px] leading-4">
              <code className="w-16 shrink-0 font-mono text-neutral-200">{item.name}</code>
              <span className="text-neutral-400">{zh ? item.zh : item.en}</span>
            </li>
          ))}
        </ul>
      </div>

      <div className="rounded-lg border border-amber-300/20 bg-amber-300/[0.06] px-2 py-1.5">
        <h4 className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-amber-200/90">{t.limitTitle}</h4>
        <ul className="space-y-0.5">
          {LIMITS.map(item => (
            <li key={item.zh} className="text-[11px] leading-4 text-amber-100/85">· {zh ? item.zh : item.en}</li>
          ))}
        </ul>
      </div>

      <p className="text-[10px] leading-4 text-neutral-500">{t.footer}</p>
    </section>
  );
};
