import React, { useCallback, useEffect, useMemo, useState } from 'react';
import type { PluginPanelProps } from '../../plugin-runtime/panel-contributions';
import type { SettingsSectionProps } from '../../plugin-runtime/settings-contributions';
import {
  listProviderProfiles,
  saveProviderProfiles,
  normalizeProviderProfile,
  secretKeyForProfile,
  subscribeProviderProfiles,
  type AIProviderProfile,
} from '../../plugin-runtime/ai-provider-profiles';
import { clearSecret, maskSecret, readSecret, writeSecret } from '../../plugin-runtime/secrets-store';
import { useLanguage } from '../../utils/language-store';
import type { AIProviderCapability } from '../../plugin-runtime/ai-providers';
import { createFetchTransport } from './openai-compatible-provider';

/**
 * AiModelsPanel —— 「AI 模型」设置面板（复刻 art-canvas 的 API 设置页，视觉适配 Artflow）。
 *
 * 形态：`ui_panels` + `presentation: 'floating'`，宿主 `PluginPanelHost` 提供非模态可拖拽窗口壳，
 * 组件在 `chromeless` 时不自带头部。样式走 `data-bp-ui-*` 作用域 + Artflow 主题变量，深浅色自适应。
 *
 * 功能对齐：左侧平台列表 + 右侧配置区；单行工具栏；API Key 脱敏；连通性测试；模型列表。
 * 不搬：RunningHub / CLI / LoRA 等 art-canvas 特化面板。
 */

const transport = createFetchTransport();
const text = (zh: boolean, cn: string, en: string) => (zh ? cn : en);

/** 可勾选的能力：决定该 provider 参与哪些操作（provider 决议按能力匹配）。 */
const CAPABILITY_OPTIONS: readonly { value: AIProviderCapability; zh: string; en: string }[] = [
  { value: 'text-to-image', zh: '文生图', en: 'Text → Image' },
  { value: 'image-to-image', zh: '图生图', en: 'Image → Image' },
  { value: 'inpainting', zh: '局部重绘', en: 'Inpaint' },
  { value: 'prompt-enhancement', zh: '提示词增强', en: 'Prompt enhance' },
  { value: 'video', zh: '视频', en: 'Video' },
];

/** 常见供应商快速添加模板（baseUrl 取自各官方 OpenAI 兼容端点）。 */
const PROVIDER_PRESETS: readonly { name: string; baseUrl: string; capabilities: AIProviderCapability[] }[] = [
  { name: 'ModelScope', baseUrl: 'https://api-inference.modelscope.cn/v1', capabilities: ['text-to-image', 'image-to-image'] },
  { name: '火山方舟', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3', capabilities: ['text-to-image', 'video'] },
];

/** 生成一个未被占用的新档案 id。 */
const nextProfileId = (existing: readonly AIProviderProfile[]): string => {
  const used = new Set(existing.map(profile => profile.id));
  let index = existing.length + 1;
  let id = `config.provider-${index}`;
  while (used.has(id)) {
    index += 1;
    id = `config.provider-${index}`;
  }
  return id;
};

const INPUT = 'w-full rounded-lg border border-white/15 bg-black/25 px-2.5 py-1.5 text-xs text-slate-100 outline-none focus:border-white/45';
const LABEL = 'text-[10px] font-semibold uppercase tracking-wide text-white/45';
const GHOST = 'rounded-lg border border-white/15 px-2.5 py-1.5 text-xs font-medium text-white/80 transition hover:border-white/40 hover:text-white disabled:cursor-default disabled:opacity-45';

export const AiModelsPanel: React.FC<PluginPanelProps> = ({ chromeless, onClose }) => {
  const zh = useLanguage() === 'zho';
  const [profiles, setProfiles] = useState<AIProviderProfile[]>(() => listProviderProfiles());
  const [selectedId, setSelectedId] = useState<string>(() => listProviderProfiles()[0]?.id ?? '');
  const [draft, setDraft] = useState<AIProviderProfile | null>(null);
  const [keyInput, setKeyInput] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [upstreamModels, setUpstreamModels] = useState<string[]>([]);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerQuery, setPickerQuery] = useState('');

  // 档案变化（含面板内保存）→ 刷新列表
  useEffect(() => subscribeProviderProfiles(() => setProfiles(listProviderProfiles())), []);

  // 选中项 / 列表变化 → 重置草稿
  useEffect(() => {
    const found = profiles.find(profile => profile.id === selectedId) ?? null;
    setDraft(found ? { ...found } : null);
    setKeyInput('');
    setNotice('');
    setUpstreamModels([]);
    setPickerOpen(false);
    setPickerQuery('');
  }, [selectedId, profiles]);

  // 依赖 notice：保存 / 清除 Key 后刷新脱敏状态
  const keyInfo = useMemo(
    () => (draft ? maskSecret(secretKeyForProfile(draft.id)) : { hasKey: false, preview: '' }),
    [draft, notice],
  );

  const updateDraft = useCallback((patch: Partial<AIProviderProfile>) => {
    setDraft(current => (current ? { ...current, ...patch } : current));
  }, []);

  const addProfile = useCallback(() => {
    const fresh = normalizeProviderProfile({
      id: nextProfileId(profiles),
      name: zh ? '新供应商' : 'New Provider',
      protocol: 'openai',
      baseUrl: 'https://',
      imageModels: [],
      capabilities: ['text-to-image'],
    });
    if (!fresh) {
      setNotice(zh ? '创建失败：档案字段不合法' : 'Failed: invalid profile');
      return;
    }
    try {
      saveProviderProfiles([...profiles, fresh]);
      setSelectedId(fresh.id);
    } catch (error) {
      setNotice(zh ? `创建失败：${String(error)}` : `Failed: ${String(error)}`);
    }
  }, [profiles, zh]);

  // 从预置模板一键创建（名称 / baseUrl / 能力已填好，用户只需补 Key）
  const addPreset = useCallback((preset: { name: string; baseUrl: string; capabilities: AIProviderCapability[] }) => {
    const fresh = normalizeProviderProfile({
      id: nextProfileId(profiles),
      name: preset.name,
      protocol: 'openai',
      baseUrl: preset.baseUrl,
      imageModels: [],
      capabilities: preset.capabilities,
    });
    if (!fresh) return;
    try {
      saveProviderProfiles([...profiles, fresh]);
      setSelectedId(fresh.id);
    } catch (error) {
      setNotice(zh ? `创建失败：${String(error)}` : `Failed: ${String(error)}`);
    }
  }, [profiles, zh]);

  // 设为唯一默认（provider 决议在「用户未显式选择」时优先选它）
  const setDefault = useCallback(() => {
    if (!draft) return;
    try {
      saveProviderProfiles(profiles.map(profile => ({ ...profile, isDefault: profile.id === draft.id })));
      setNotice(zh ? '已设为默认' : 'Set as default');
    } catch (error) {
      setNotice(zh ? `设置默认失败：${String(error)}` : `Failed: ${String(error)}`);
    }
  }, [draft, profiles, zh]);

  const saveDraft = useCallback(() => {
    if (!draft) return;
    const normalized = normalizeProviderProfile(draft);
    if (!normalized) {
      setNotice(zh ? '字段不合法：请检查 ID / 名称 / 请求地址' : 'Invalid fields: check id / name / base URL');
      return;
    }
    try {
      saveProviderProfiles(profiles.map(profile => (profile.id === draft.id ? normalized : profile)));
      setNotice(zh ? '已保存' : 'Saved');
    } catch (error) {
      setNotice(zh ? `保存失败：${String(error)}` : `Save failed: ${String(error)}`);
    }
  }, [draft, profiles, zh]);

  const deleteProfile = useCallback(() => {
    if (!draft) return;
    try {
      saveProviderProfiles(profiles.filter(profile => profile.id !== draft.id));
      clearSecret(secretKeyForProfile(draft.id));
      setSelectedId(profiles.find(profile => profile.id !== draft.id)?.id ?? '');
    } catch (error) {
      setNotice(zh ? `删除失败：${String(error)}` : `Delete failed: ${String(error)}`);
    }
  }, [draft, profiles, zh]);

  const saveKey = useCallback(() => {
    if (!draft || keyInput.trim().length === 0) return;
    try {
      writeSecret(secretKeyForProfile(draft.id), keyInput.trim());
      setKeyInput('');
      setNotice(zh ? 'API Key 已保存' : 'API Key saved');
    } catch (error) {
      setNotice(zh ? `保存 Key 失败：${String(error)}` : `Save key failed: ${String(error)}`);
    }
  }, [draft, keyInput, zh]);

  const clearKey = useCallback(() => {
    if (!draft) return;
    try {
      clearSecret(secretKeyForProfile(draft.id));
      setNotice(zh ? 'API Key 已清除' : 'API Key cleared');
    } catch (error) {
      setNotice(zh ? `清除 Key 失败：${String(error)}` : `Clear key failed: ${String(error)}`);
    }
  }, [draft, zh]);

  const testConnection = useCallback(async () => {
    if (!draft) return;
    const apiKey = readSecret(secretKeyForProfile(draft.id));
    if (!apiKey) {
      setNotice(zh ? '请先保存 API Key' : 'Save an API Key first');
      return;
    }
    setBusy(true);
    setNotice(zh ? '正在测试…' : 'Testing…');
    try {
      const models = await transport.listModels({ apiKey, baseUrl: draft.baseUrl });
      setUpstreamModels(models);
      setNotice(zh ? `连接成功 · ${models.length} 个模型` : `OK · ${models.length} models`);
    } catch (error) {
      setNotice(zh ? `连接失败：${error instanceof Error ? error.message : String(error)}` : `Failed: ${String(error)}`);
    } finally {
      setBusy(false);
    }
  }, [draft, zh]);

  // 打开模型选择器：首次无缓存则自动拉取上游模型列表（拉不到则保留提示由用户先测连接）
  const openPicker = useCallback(async () => {
    if (!draft) return;
    setPickerOpen(true);
    if (upstreamModels.length > 0) return;
    const apiKey = readSecret(secretKeyForProfile(draft.id));
    if (!apiKey) {
      setNotice(zh ? '请先保存 API Key' : 'Save an API Key first');
      return;
    }
    setBusy(true);
    try {
      setUpstreamModels(await transport.listModels({ apiKey, baseUrl: draft.baseUrl }));
    } catch {
      /* 保持空列表：UI 会提示先「测试连接」 */
    } finally {
      setBusy(false);
    }
  }, [draft, upstreamModels.length, zh]);

  return (
    <div
      data-bp-ui-panel=""
      className={`flex min-h-0 flex-col gap-3 ${chromeless ? 'min-h-0 flex-1' : 'max-h-[min(40rem,calc(100vh-10rem))] text-slate-100'}`}
    >
      {/* 单行紧凑工具栏：标题 · 状态 · 新增 · 保存 · 关闭 */}
      <div className="flex items-center gap-2 border-b border-white/10 pb-2">
        <span className="shrink-0 text-sm font-semibold">{text(zh, 'AI 模型', 'AI Models')}</span>
        <span className="min-w-0 flex-1 truncate text-[11px] text-white/45" title={notice}>{notice}</span>
        <button type="button" className={GHOST} onClick={addProfile}>＋ {text(zh, '新增', 'Add')}</button>
        <button type="button" data-bp-ui-action="primary" className={GHOST} onClick={saveDraft} disabled={!draft}>{text(zh, '保存', 'Save')}</button>
        <button type="button" className={GHOST} onClick={onClose} aria-label={text(zh, '关闭', 'Close')}>✕</button>
      </div>

      <div className="grid min-h-0 flex-1 grid-cols-[10.5rem_minmax(0,1fr)] gap-3">
        {/* 左：平台列表 */}
        <aside className="flex min-h-0 flex-col gap-1 overflow-y-auto pr-1">
          {profiles.length === 0 ? (
            <p className="rounded-lg border border-dashed border-white/15 px-3 py-4 text-center text-[11px] text-white/40">
              {text(zh, '暂无供应商，点「新增」', 'No providers yet')}
            </p>
          ) : profiles.map(profile => {
            const hasKey = maskSecret(secretKeyForProfile(profile.id)).hasKey;
            return (
              <button
                key={profile.id}
                type="button"
                data-bp-ui-active={profile.id === selectedId}
                onClick={() => setSelectedId(profile.id)}
                className={`flex items-center gap-2 rounded-lg border px-2.5 py-2 text-left transition ${profile.id === selectedId ? 'border-white/30 bg-white/10' : 'border-transparent hover:border-white/20 hover:bg-white/5'}`}
              >
                <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${hasKey ? 'bg-emerald-400' : 'bg-white/25'}`} title={hasKey ? text(zh, '已配置 Key', 'Key set') : text(zh, '未配置 Key', 'No key')} />
                <span className="min-w-0 flex-1 truncate text-xs font-semibold">{profile.name}</span>
                {profile.isDefault && <span className="shrink-0 text-[10px] text-amber-300" title={text(zh, '默认', 'Default')}>★</span>}
                <span className="shrink-0 rounded bg-white/10 px-1.5 py-0.5 text-[9px] font-semibold uppercase text-white/55">{profile.protocol}</span>
              </button>
            );
          })}
          <div className="mt-1 flex flex-col gap-1 border-t border-white/10 pt-2">
            <span className="px-1 text-[9px] font-semibold uppercase tracking-wide text-white/30">{text(zh, '快速添加', 'Quick add')}</span>
            {PROVIDER_PRESETS.map(preset => (
              <button
                key={preset.name}
                type="button"
                onClick={() => addPreset(preset)}
                className="rounded-lg border border-dashed border-white/15 px-2 py-1.5 text-left text-[11px] text-white/60 transition hover:border-white/35 hover:text-white"
              >
                ＋ {preset.name}
              </button>
            ))}
          </div>
        </aside>

        {/* 右：配置区 */}
        <section className="flex min-h-0 flex-col gap-3 overflow-y-auto pr-1">
          {!draft ? (
            profiles.length === 0 ? (
              <div className="mt-3 flex flex-col gap-2 rounded-lg border border-dashed border-white/15 p-4">
                <p className="text-xs font-semibold text-white/80">{text(zh, '接入第一个 AI 供应商', 'Add your first provider')}</p>
                <ol className="list-decimal space-y-1 pl-4 text-[11px] leading-relaxed text-white/50">
                  <li>{text(zh, '点右上「＋ 新增」创建供应商', 'Click "+ Add" at top-right')}</li>
                  <li>{text(zh, '填写请求地址（任意 OpenAI 兼容服务，如 ModelScope / 火山）', 'Fill the base URL (any OpenAI-compatible service)')}</li>
                  <li>{text(zh, '填写并保存 API Key（仅本地保存）', 'Save the API Key (stored locally)')}</li>
                  <li>{text(zh, '点「测试连接」拉取模型 → 勾选 → 保存', 'Test connection → pick models → save')}</li>
                </ol>
              </div>
            ) : (
              <p className="mt-6 text-center text-[11px] text-white/40">{text(zh, '选择左侧供应商进行配置', 'Select a provider to configure')}</p>
            )
          ) : (
            <>
              <label className="flex flex-col gap-1">
                <span className={LABEL}>{text(zh, '平台名称', 'Name')}</span>
                <input className={INPUT} value={draft.name} onChange={event => updateDraft({ name: event.target.value })} />
              </label>

              <div className="grid grid-cols-2 gap-2">
                <label className="flex flex-col gap-1">
                  <span className={LABEL}>ID</span>
                  <input className={`${INPUT} opacity-60`} value={draft.id} readOnly />
                </label>
                <label className="flex flex-col gap-1">
                  <span className={LABEL}>{text(zh, '协议', 'Protocol')}</span>
                  <select className={INPUT} value={draft.protocol} onChange={event => updateDraft({ protocol: event.target.value === 'gemini' ? 'gemini' : 'openai' })}>
                    <option value="openai">OpenAI</option>
                    <option value="gemini">Gemini</option>
                  </select>
                </label>
              </div>

              <label className="flex flex-col gap-1">
                <span className={LABEL}>{text(zh, '请求地址', 'Base URL')}</span>
                <input className={INPUT} value={draft.baseUrl} placeholder="https://api.example.com" onChange={event => updateDraft({ baseUrl: event.target.value })} />
              </label>

              <div className="flex flex-col gap-1.5">
                <span className={LABEL}>{text(zh, '支持能力', 'Capabilities')}</span>
                <div className="flex flex-wrap gap-x-3 gap-y-1.5">
                  {CAPABILITY_OPTIONS.map(option => {
                    const checked = draft.capabilities.includes(option.value);
                    return (
                      <label key={option.value} className="flex cursor-pointer items-center gap-1.5 text-[11px] text-white/70">
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => updateDraft({
                            capabilities: checked
                              ? draft.capabilities.filter(item => item !== option.value)
                              : [...draft.capabilities, option.value],
                          })}
                        />
                        <span>{zh ? option.zh : option.en}</span>
                      </label>
                    );
                  })}
                </div>
              </div>

              <div className="flex flex-col gap-1.5">
                <div className="flex items-center gap-2">
                  <span className={LABEL}>{text(zh, '图像模型', 'Image models')}</span>
                  <span className="flex-1" />
                  <button type="button" className={GHOST} onClick={() => void openPicker()}>
                    {text(zh, '选择模型', 'Pick models')}
                  </button>
                </div>
                <textarea
                  className={`${INPUT} min-h-[3rem] resize-y font-mono`}
                  value={draft.imageModels.join(', ')}
                  placeholder={text(zh, '逗号 / 换行分隔，或点右上「选择模型」', 'Comma / newline separated, or use "Pick models"')}
                  onChange={event => updateDraft({ imageModels: event.target.value.split(/[,，\n]/).map(s => s.trim()).filter(Boolean) })}
                />
                {pickerOpen && (
                  <div className="rounded-lg border border-white/15 bg-black/25 p-2">
                    <div className="mb-2 flex items-center gap-2">
                      <input
                        className={INPUT}
                        placeholder={text(zh, '搜索模型', 'Search')}
                        value={pickerQuery}
                        onChange={event => setPickerQuery(event.target.value)}
                      />
                      <button type="button" className={GHOST} onClick={() => setPickerOpen(false)}>{text(zh, '收起', 'Done')}</button>
                    </div>
                    <div className="max-h-40 overflow-y-auto">
                      {upstreamModels.length === 0 ? (
                        <p className="py-3 text-center text-[11px] text-white/40">{text(zh, '先点「测试连接」拉取模型列表', 'Run "Test connection" first')}</p>
                      ) : upstreamModels
                        .filter(model => model.toLowerCase().includes(pickerQuery.toLowerCase()))
                        .map(model => {
                          const checked = draft.imageModels.includes(model);
                          return (
                            <label key={model} className="flex cursor-pointer items-center gap-2 rounded px-1.5 py-1 text-xs hover:bg-white/5">
                              <input
                                type="checkbox"
                                checked={checked}
                                onChange={() => updateDraft({
                                  imageModels: checked
                                    ? draft.imageModels.filter(item => item !== model)
                                    : [...draft.imageModels, model],
                                })}
                              />
                              <span className="min-w-0 flex-1 truncate font-mono">{model}</span>
                            </label>
                          );
                        })}
                    </div>
                  </div>
                )}
              </div>

              <label className="flex flex-col gap-1">
                <span className={LABEL}>{text(zh, '视频模型（可选）', 'Video models (optional)')}</span>
                <textarea
                  className={`${INPUT} min-h-[2.25rem] resize-y font-mono`}
                  value={draft.videoModels.join(', ')}
                  placeholder={text(zh, '逗号 / 换行分隔', 'Comma / newline separated')}
                  onChange={event => updateDraft({ videoModels: event.target.value.split(/[,，\n]/).map(s => s.trim()).filter(Boolean) })}
                />
              </label>

              <div className="flex flex-col gap-1">
                <span className={LABEL}>API Key</span>
                <div className="flex items-center gap-1.5">
                  <input
                    type="password"
                    className={INPUT}
                    value={keyInput}
                    placeholder={keyInfo.hasKey ? keyInfo.preview : text(zh, '未配置', 'Not set')}
                    onChange={event => setKeyInput(event.target.value)}
                  />
                  <button type="button" className={GHOST} onClick={saveKey} disabled={keyInput.trim().length === 0} title={text(zh, '保存 Key', 'Save key')}>✓</button>
                  <button type="button" className={`${GHOST} !text-red-300 hover:!border-red-400/60`} onClick={clearKey} disabled={!keyInfo.hasKey} title={text(zh, '清除 Key', 'Clear key')}>✕</button>
                </div>
                <span className="text-[10px] text-white/35">{keyInfo.hasKey ? text(zh, '已配置 · 保存后即时生效', 'Configured · applies immediately') : text(zh, '密钥仅本地保存，不会明文回显', 'Stored locally; never echoed in full')}</span>
              </div>

              <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                <button type="button" className={GHOST} onClick={() => void testConnection()} disabled={busy}>{text(zh, '测试连接', 'Test connection')}</button>
                <label className="flex cursor-pointer items-center gap-1.5 text-[11px] text-white/70">
                  <input type="checkbox" checked={draft.enabled} onChange={event => updateDraft({ enabled: event.target.checked })} />
                  <span>{text(zh, '启用', 'Enabled')}</span>
                </label>
                <button type="button" className={GHOST} onClick={setDefault} disabled={draft.isDefault}>
                  {draft.isDefault ? text(zh, '★ 默认', '★ Default') : text(zh, '设为默认', 'Set default')}
                </button>
                <span className="flex-1" />
                <button type="button" className={`${GHOST} !text-red-300 hover:!border-red-400/60`} onClick={deleteProfile}>{text(zh, '删除', 'Delete')}</button>
              </div>
            </>
          )}
        </section>
      </div>
    </div>
  );
};

/**
 * 设置页入口：复用同一面板组件（设置宿主提供 kernel；`onClose` 在设置内无意义）。
 * 与 ui-plugin-manager 同款模式 —— 浮层与设置节共用一份内容，避免两套实现。
 */
export const AiModelsSettingsSection: React.FC<SettingsSectionProps> = ({ kernel }) => (
  <AiModelsPanel kernel={kernel} onClose={() => undefined} chromeless={false} />
);
