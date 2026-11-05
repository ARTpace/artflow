import React, { useEffect, useState } from 'react';
import type { PluginNodeElement } from '../../types';
import { parseVideoUrl, type OnlineVideoLink } from './links';
import { CanvasCardShell } from '../../components/cards/CanvasCardShell';

export function OnlineVideoCard({ element, isSelected = false }: { element: PluginNodeElement; isSelected?: boolean }) {
  const source = typeof element.data?.sourceUrl === 'string' ? element.data.sourceUrl : '';
  const [player, setPlayer] = useState<OnlineVideoLink | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const link = parseVideoUrl(source);
  useEffect(() => { setPlayer(null); setError(''); setBusy(false); }, [source]);

  const load = async () => {
    if (!link || busy) return;
    setBusy(true); setError('');
    try {
      let resolved = link;
      if (link.provider === 'bilibili-short') {
        if (!window.artflowApp?.resolveVideoShortUrl) throw new Error('短链解析需要桌面版；网页版请粘贴 B 站完整视频地址。');
        const url = await window.artflowApp.resolveVideoShortUrl(source);
        const parsed = parseVideoUrl(url);
        if (!parsed || parsed.provider !== 'bilibili') throw new Error('该分享链接未指向支持的 B 站视频。');
        resolved = parsed;
      }
      setPlayer(resolved);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '加载失败，请重试或打开原网页。');
    } finally { setBusy(false); }
  };
  const open = async () => {
    if (!link) return;
    try {
      if (window.artflowApp?.openVideoLink) await window.artflowApp.openVideoLink(source);
      else window.open(source, '_blank', 'noopener,noreferrer');
    } catch { setError('无法打开原网页，请复制原链接后在浏览器访问。'); }
  };
  const controlStyle = { background: 'var(--bp-card-bg, #18181b)', color: 'var(--bp-text-primary, #fff)' };
  const buttonClassName = 'px-2 py-1.5 rounded-md text-[11px] hover:bg-white/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 disabled:opacity-40';
  return (
    <CanvasCardShell data-online-video-card variant="media" className="rounded-lg group/online-video" interactiveContent
      headerClassName="justify-between"
      header={<div data-online-video-drag-handle title="拖动移动视频卡片" aria-label="拖动移动视频卡片"
        className="pointer-events-auto flex h-7 w-10 shrink-0 items-center justify-center rounded-md cursor-grab active:cursor-grabbing"
        style={controlStyle}>
        <span aria-hidden="true" className="h-1 w-5 rounded-full bg-current opacity-40" />
      </div>}
      actionsClassName={`flex items-center gap-0.5 rounded-md transition-opacity group-hover/online-video:opacity-100 group-hover/online-video:pointer-events-auto group-focus-within/online-video:opacity-100 group-focus-within/online-video:pointer-events-auto [@media(hover:none)]:opacity-100 [@media(hover:none)]:pointer-events-auto ${isSelected ? 'pointer-events-auto opacity-100' : 'pointer-events-none opacity-0'}`}
      actions={<div className="flex items-center rounded-md" style={controlStyle}>
        {player && <button type="button" aria-label="停止播放" title="停止播放" className={buttonClassName} onClick={() => { setPlayer(null); setError(''); }}><svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2" /></svg></button>}
        <button type="button" aria-label="打开视频原网页" title="打开视频原网页" className={buttonClassName} disabled={!link} onClick={open}><svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M14 3h7v7m0-7L10 14M10 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-5" /></svg></button>
      </div>}>
        {player?.provider === 'direct' ? (
          <video src={player.playerUrl} controls preload="metadata" playsInline className="w-full h-full" onError={() => setError('视频无法播放，可能是格式、防盗链或链接过期。可打开原网页查看。')} />
        ) : player?.playerUrl ? (
          <iframe title={player.label} src={player.playerUrl} className="w-full h-full border-0" allow="fullscreen; encrypted-media; picture-in-picture"
            allowFullScreen referrerPolicy="strict-origin-when-cross-origin" sandbox="allow-scripts allow-same-origin allow-presentation"
            onError={() => setError('播放器加载失败，可停止后重试或打开原网页。')} />
        ) : (
          <div className="w-full h-full flex flex-col items-center justify-center gap-2 px-5 py-12 text-center">
            <span className="text-xs" style={{ color: 'var(--bp-text-muted, #a1a1aa)' }}>{link?.label ?? '无效的视频链接'}</span>
            <button type="button" aria-label={busy ? '正在解析视频链接' : '加载播放器'} title="加载播放器" disabled={!link || busy} onClick={load}
              className="flex items-center gap-2 px-3 py-2 rounded-md text-sm hover:bg-white/5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 disabled:opacity-50">
              <svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none"><path d="m9 5 11 7-11 7V5Z" fill="currentColor" /></svg>
              {busy ? '正在解析链接…' : '加载播放器'}
            </button>
            <span title={source} className="max-w-full text-[10px] opacity-40 truncate">{source || '缺少原链接'}</span>
          </div>
        )}
        {error && <div role="alert" className="absolute top-11 left-2 right-2 p-2 rounded-md text-xs" style={controlStyle}>{error}</div>}
    </CanvasCardShell>
  );
}
