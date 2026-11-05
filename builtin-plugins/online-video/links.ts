export const ONLINE_VIDEO_NODE = 'builtin.online-video';
export interface OnlineVideoLink {
  provider: 'bilibili' | 'youtube' | 'direct' | 'bilibili-short';
  sourceUrl: string;
  playerUrl?: string;
  label: string;
}

/** Only construct known embed URLs; never trust iframe HTML or persisted player URLs. */
export function parseVideoUrl(value: string): OnlineVideoLink | null {
  let url: URL;
  try { url = new URL(value); } catch { return null; }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.port) return null;
  const host = url.hostname.toLowerCase();
  if (host === 'b23.tv' && url.protocol === 'https:' && /^\/[a-zA-Z0-9]+\/?$/.test(url.pathname)) {
    return { provider: 'bilibili-short', sourceUrl: url.href, label: '哔哩哔哩分享视频' };
  }
  if (['www.bilibili.com', 'bilibili.com', 'm.bilibili.com'].includes(host)) {
    const match = /^\/video\/(BV[0-9A-Za-z]{10}|av[0-9]+)\/?$/i.exec(url.pathname);
    if (!match) return null;
    const player = new URL('https://player.bilibili.com/player.html');
    player.searchParams.set(match[1].toLowerCase().startsWith('av') ? 'aid' : 'bvid', match[1].replace(/^av/i, ''));
    const p = url.searchParams.get('p');
    if (p && /^[1-9]\d{0,4}$/.test(p)) player.searchParams.set('p', p);
    player.searchParams.set('autoplay', '0');
    player.searchParams.set('danmaku', '0');
    return { provider: 'bilibili', sourceUrl: url.href, playerUrl: player.href, label: '哔哩哔哩视频' };
  }
  let youtubeId: string | null = null;
  if (host === 'youtu.be') youtubeId = url.pathname.slice(1);
  if (['youtube.com', 'www.youtube.com', 'm.youtube.com'].includes(host)) {
    youtubeId = url.pathname === '/watch' ? url.searchParams.get('v') : /^\/(?:shorts|embed|live)\/([^/]+)\/?$/.exec(url.pathname)?.[1] ?? null;
  }
  if (youtubeId && /^[\w-]{11}$/.test(youtubeId)) {
    return { provider: 'youtube', sourceUrl: url.href, playerUrl: `https://www.youtube.com/embed/${youtubeId}?autoplay=0`, label: 'YouTube 视频' };
  }
  if (/\.(?:mp4|webm|ogv)$/i.test(url.pathname)) {
    return { provider: 'direct', sourceUrl: url.href, playerUrl: url.href, label: '在线视频' };
  }
  return null;
}

export function findVideoLink(text: string): OnlineVideoLink | null {
  // Share text is accepted only when it contains a single URL; ordinary notes remain notes.
  const urls = text.match(/https?:\/\/[^\s<>"“”]+/gi) ?? [];
  if (urls.length !== 1) return null;
  return parseVideoUrl(urls[0].replace(/[，。！？；、）)\]】]+$/g, ''));
}
