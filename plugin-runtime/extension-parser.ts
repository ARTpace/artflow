import { invariant, type ExtensionData } from './extension-package';
export interface ParseProgress { stage: 'reading' | 'parsing'; done: number; total: number }
export interface ParserProvider { parse(file: File, signal: AbortSignal, progress: (value: ParseProgress) => void): Promise<ExtensionData[]> }
/** Executed only as host-owned Worker code. Packages never supply executable source. */
function parserWorkerMain() {
  self.onmessage = async (event: MessageEvent<File>) => {
    try {
      const file = event.data; if (!(file instanceof Blob) || file.size > 2 * 1024 * 1024) throw new Error('File exceeds 2 MiB parser limit');
      const decoder = new TextDecoder('utf-8', { fatal: true }); let text = '';
      for (let offset = 0; offset < file.size; offset += 65536) {
        const buffer = await file.slice(offset, offset + 65536).arrayBuffer(); text += decoder.decode(buffer, { stream: true });
        self.postMessage({ progress: { stage: 'reading', done: Math.min(file.size, offset + 65536), total: file.size } });
      }
      text += decoder.decode(); const lines: string[] = [];
      for (let start = 0; start < text.length;) {
        const end = text.indexOf('\n', start); const line = text.slice(start, end < 0 ? text.length : end).trim();
        if (line) { if (line.length > 65536 || lines.length >= 1000) throw new Error('Record/line limit exceeded'); lines.push(line); }
        start = end < 0 ? text.length : end + 1;
      }
      if (!lines.length) throw new Error('No records'); const result: unknown[] = [];
      self.postMessage({ progress: { stage: 'parsing', done: 0, total: lines.length } });
      for (let i = 0; i < lines.length; i++) {
        result.push(JSON.parse(lines[i]));
        if ((i + 1) % 16 === 0 || i + 1 === lines.length) {
          self.postMessage({ progress: { stage: 'parsing', done: i + 1, total: lines.length } });
          await new Promise(resolve => setTimeout(resolve, 0));
        }
      }
      self.postMessage({ result });
    } catch (error) { self.postMessage({ error: error instanceof Error ? error.message : String(error) }); }
  };
}
export function createWorkerParser(): ParserProvider {
  return { parse: (file, signal, progress) => new Promise((resolve, reject) => {
    invariant(typeof Worker !== 'undefined', 'Background Worker unavailable; parser will not fall back to main thread');
    if (signal.aborted) { reject(new Error('Cancelled')); return; }
    invariant(file.size <= 2 * 1024 * 1024, 'File exceeds 2 MiB parser limit');
    const url = URL.createObjectURL(new Blob([`(${parserWorkerMain.toString()})()`], { type: 'text/javascript' }));
    let worker: Worker;
    try { worker = new Worker(url); } catch (error) { URL.revokeObjectURL(url); reject(error); return; }
    let settled = false; let timer: ReturnType<typeof setTimeout>;
    const finish = (error?: Error, result?: ExtensionData[]) => {
      if (settled) return; settled = true; clearTimeout(timer); signal.removeEventListener('abort', abort); worker.terminate(); URL.revokeObjectURL(url);
      if (error) reject(error); else resolve(result!);
    };
    const abort = () => finish(new Error('Cancelled'));
    signal.addEventListener('abort', abort, { once: true }); timer = setTimeout(() => finish(new Error('Parser timed out')), 30000);
    worker.onerror = () => finish(new Error('Parser Worker crashed'));
    worker.onmessage = event => {
      if (settled) return;
      if (event.data?.error) finish(new Error(String(event.data.error)));
      else if (Array.isArray(event.data?.result)) finish(undefined, event.data.result);
      else if (event.data?.progress) { try { progress(event.data.progress); } catch { /* observation only */ } }
    };
    try { worker.postMessage(file); } catch (error) { finish(error instanceof Error ? error : new Error(String(error))); }
  }) };
}
