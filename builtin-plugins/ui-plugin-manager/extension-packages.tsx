import React, { useState } from 'react';
import { CompactPluginRow } from './compact-row';
import { InlinePluginDetails } from './details-dialog';
import type { InstalledPackage } from '../../plugin-runtime/extension-package';
import type { ExtensionRuntime } from '../../plugin-runtime/extension-registry';
import type { SettingsSectionLanguage } from '../../plugin-runtime/settings-contributions';

const copyFor = (language: SettingsSectionLanguage) => language === 'zho' ? {
  source: 'JSON 扩展包', live: '即时生效', enabled: '已启用', disabled: '已停用',
  details: '详情与操作', closeDetails: '关闭扩展包详情', version: '版本', was: '原版本',
  id: '标识', permissions: '已授权', requires: '依赖', none: '无',
  replace: '替换版本', uninstall: '卸载',
  installTitle: '安装 JSON 扩展包', install: '验证并安装', close: '关闭安装表单',
  installHint: '只接受声明式 JSON，不运行扩展包里的脚本。安装、启停与替换会立即生效。',
  replacePrompt: '粘贴新版本的扩展包 JSON：',
  uninstallConfirm: (id: string) => `卸载 ${id}？画布上已有的节点数据会保留。`,
  installed: '已安装并启用，无需重新加载。',
  changed: (id: string, enabled: boolean) => `${id} 已${enabled ? '启用' : '停用'}，立即生效。`,
  replaced: (id: string) => `${id} 已替换版本，立即生效。请检查新版所需权限。`,
  removed: '已卸载；画布上的节点数据已保留。',
  failed: '操作失败：',
} : {
  source: 'JSON package', live: 'Applies immediately', enabled: 'Enabled', disabled: 'Disabled',
  details: 'Details & actions', closeDetails: 'Close package details', version: 'Version', was: 'previously',
  id: 'ID', permissions: 'Granted', requires: 'Requires', none: 'None',
  replace: 'Replace version', uninstall: 'Uninstall',
  installTitle: 'Install JSON package', install: 'Validate & install', close: 'Close installer',
  installHint: 'Declarative JSON only; package scripts cannot execute. Install, enable and replace take effect immediately.',
  replacePrompt: 'Paste the new version of the package JSON:',
  uninstallConfirm: (id: string) => `Uninstall ${id}? Nodes already on the canvas will keep their data.`,
  installed: 'Installed and enabled immediately. No reload needed.',
  changed: (id: string, enabled: boolean) => `${id} ${enabled ? 'enabled' : 'disabled'} immediately.`,
  replaced: (id: string) => `${id} replaced immediately. Review the new version's permissions.`,
  removed: 'Uninstalled; existing node data was preserved.',
  failed: 'Operation failed:',
};

interface PackageProps {
  runtime: ExtensionRuntime;
  language: SettingsSectionLanguage;
  onNotice: (message: string | null, kind?: 'success' | 'error') => void;
}

export const PackageInstaller: React.FC<PackageProps & { onClose: () => void; onInstalled: () => void }> = ({ runtime, language, onNotice, onClose, onInstalled }) => {
  const copy = copyFor(language);
  const [installText, setInstallText] = useState('');
  const install = () => {
    try {
      runtime.install(JSON.parse(installText));
      setInstallText('');
      onNotice(copy.installed, 'success');
      onInstalled();
    } catch (error) {
      onNotice(`${copy.failed} ${error instanceof Error ? error.message : String(error)}`, 'error');
    }
  };
  return (
    <section aria-label={copy.installTitle} className="space-y-2 rounded-xl border border-violet-300/20 bg-violet-400/[0.055] p-3">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-xs font-medium text-violet-100">{copy.installTitle}</h3>
        <button type="button" onClick={onClose} aria-label={copy.close} className="rounded-md px-2 py-0.5 text-xs text-neutral-400 hover:bg-white/10 hover:text-white">✕</button>
      </div>
      <p className="text-[11px] leading-5 text-neutral-400">{copy.installHint}</p>
      <textarea
        value={installText}
        onChange={event => setInstallText(event.target.value)}
        rows={6}
        spellCheck={false}
        aria-label={copy.installTitle}
        placeholder='{"manifestVersion":2,"engine":"declarative-v1","id":"ext.example",...}'
        className="w-full rounded-lg border border-white/10 bg-black/40 p-2 font-mono text-[11px] text-neutral-200 outline-none focus:border-violet-300/40"
      />
      <button type="button" onClick={install} disabled={!installText.trim()}
        className="rounded-lg bg-violet-500 px-3 py-1.5 text-xs font-semibold text-white hover:bg-violet-400 disabled:cursor-not-allowed disabled:opacity-40">
        {copy.install}
      </button>
    </section>
  );
};

export const PackageRows: React.FC<PackageProps & {
  installed: readonly InstalledPackage[];
}> = ({ runtime, installed, language, onNotice }) => {
  const copy = copyFor(language);
  const [openId, setOpenId] = useState<string | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const run = (action: () => void, success: string | null): boolean => {
    try { action(); setDetailError(null); onNotice(success, success ? 'success' : undefined); return true; }
    catch (error) {
      const message = `${copy.failed} ${error instanceof Error ? error.message : String(error)}`;
      setDetailError(message); onNotice(message, 'error'); return false;
    }
  };
  return (
    <ul className="overflow-hidden rounded-lg border border-white/[0.08]">
      {installed.map(entry => {
        const id = entry.package.id;
        return <React.Fragment key={id}>
          <CompactPluginRow
            id={id} name={entry.package.name} enabled={entry.enabled}
            enabledLabel={copy.enabled} disabledLabel={copy.disabled}
            helpLabel={copy.details}
            helpLines={[
              `${copy.id}: ${id} · v${entry.package.version}`,
              entry.enabled ? copy.live : copy.disabled,
              `${copy.permissions}: ${entry.grants.join(', ') || copy.none}`,
              ...(entry.package.requires?.length ? [`${copy.requires}: ${entry.package.requires.join(', ')}`] : []),
              copy.details,
            ]}
            onDetails={() => { setDetailError(null); setOpenId(id); }}
            onToggle={() => { run(() => runtime.setEnabled(id, !entry.enabled), null); }}
          />
          {openId === id && <InlinePluginDetails id={id} title={entry.package.name} closeLabel={copy.closeDetails} onClose={() => setOpenId(null)}>
            {detailError && <p role="alert" className="rounded-md bg-rose-500/10 px-2 py-1 text-rose-200">{detailError}</p>}
            <dl className="grid gap-x-2 gap-y-0.5 text-xs sm:grid-cols-[auto_1fr]">
              <dt className="text-right text-neutral-500">{copy.id}</dt><dd className="break-all font-mono">{id}</dd>
              <dt className="text-right text-neutral-500">{copy.version}</dt><dd>v{entry.package.version}{entry.previous ? ` (${copy.was} v${entry.previous.version})` : ''}</dd>
              <dt className="text-right text-neutral-500">{copy.permissions}</dt><dd>{entry.grants.join(', ') || copy.none}</dd>
              <dt className="text-right text-neutral-500">{copy.requires}</dt><dd>{entry.package.requires?.join(', ') || copy.none}</dd>
            </dl>
            <div className="flex flex-wrap gap-1.5">
              <button type="button" onClick={() => {
                const text = window.prompt(copy.replacePrompt);
                if (text) run(() => runtime.replaceVersion(id, JSON.parse(text)), copy.replaced(id));
              }} className="rounded-lg bg-white/[0.07] px-2.5 py-1 text-xs text-neutral-200 hover:bg-white/10">{copy.replace}</button>
              <button type="button" onClick={() => {
                if (window.confirm(copy.uninstallConfirm(id)) && run(() => runtime.uninstall(id), copy.removed)) setOpenId(null);
              }} className="rounded-lg bg-rose-500/10 px-2.5 py-1 text-xs text-rose-200 hover:bg-rose-500/20">{copy.uninstall}</button>
            </div>
          </InlinePluginDetails>}
        </React.Fragment>;
      })}
    </ul>
  );
};
