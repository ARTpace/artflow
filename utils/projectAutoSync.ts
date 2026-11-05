/**
 * projectAutoSync.ts —— Startup project session persistence helpers.
 * （自动保存已被移除：数据只在用户点保存时落盘，关闭时由 App.tsx 的关闭确认模态兜底。）
 */

export interface SessionData {
  lastProjectRoot: string;
  savedAt?: number;
}

export const formatSessionPayload = (projectRoot: string): string =>
  JSON.stringify({ lastProjectRoot: projectRoot, savedAt: Date.now() }, null, 2);

export const parseSessionPayload = (text: string): string | null => {
  try {
    const data = JSON.parse(text) as unknown;
    if (typeof data === 'object' && data !== null && 'lastProjectRoot' in data) {
      const root = (data as SessionData).lastProjectRoot;
      return typeof root === 'string' && root.trim().length > 0 ? root.trim() : null;
    }
    return null;
  } catch {
    return null;
  }
};
