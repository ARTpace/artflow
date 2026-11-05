const { parentPort } = require('node:worker_threads');

const cancelledJobs = new Set();
const yieldToMessageLoop = () => new Promise(resolve => setImmediate(resolve));

function escapeXml(value) {
  return String(value).replace(/[&<>'"]/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&apos;', '"': '&quot;',
  }[character]));
}

function formatBytes(byteSize) {
  if (byteSize < 1024) return `${byteSize} B`;
  if (byteSize < 1024 * 1024) return `${(byteSize / 1024).toFixed(1)} KB`;
  return `${(byteSize / (1024 * 1024)).toFixed(1)} MB`;
}

function previewSvg(asset) {
  const label = `${asset.kind.toUpperCase()} • ${formatBytes(asset.byteSize)}`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360" viewBox="0 0 640 360" role="img" aria-label="${escapeXml(label)}">
  <rect width="640" height="360" fill="#111827"/>
  <rect x="32" y="32" width="576" height="296" rx="18" fill="#1f2937" stroke="#374151"/>
  <circle cx="96" cy="112" r="32" fill="#facc15"/>
  <text x="144" y="106" fill="#f9fafb" font-family="system-ui, sans-serif" font-size="26" font-weight="700">${escapeXml(asset.kind.toUpperCase())}</text>
  <text x="144" y="140" fill="#9ca3af" font-family="system-ui, sans-serif" font-size="17">${escapeXml(asset.mimeType || 'application/octet-stream')}</text>
  <text x="64" y="248" fill="#e5e7eb" font-family="ui-monospace, monospace" font-size="16">${escapeXml(asset.id)}</text>
  <text x="64" y="282" fill="#9ca3af" font-family="system-ui, sans-serif" font-size="16">${escapeXml(label)}</text>
</svg>`;
}

async function derivePreview(message) {
  const bytes = new Uint8Array(message.bytes);
  const chunkSize = 64 * 1024;
  parentPort.postMessage({ type: 'progress', jobId: message.jobId, progress: 0 });
  for (let offset = 0; offset < bytes.byteLength; offset += chunkSize) {
    if (cancelledJobs.has(message.jobId)) {
      parentPort.postMessage({ type: 'cancelled', jobId: message.jobId });
      cancelledJobs.delete(message.jobId);
      return;
    }
    if (offset === 0 || offset + chunkSize >= bytes.byteLength) {
      parentPort.postMessage({
        type: 'progress',
        jobId: message.jobId,
        progress: Math.min(0.9, (offset + chunkSize) / Math.max(1, bytes.byteLength)),
      });
    }
    await yieldToMessageLoop();
  }
  if (cancelledJobs.has(message.jobId)) {
    parentPort.postMessage({ type: 'cancelled', jobId: message.jobId });
    cancelledJobs.delete(message.jobId);
    return;
  }
  const output = Buffer.from(previewSvg(message.asset), 'utf8');
  const transferred = output.buffer.slice(output.byteOffset, output.byteOffset + output.byteLength);
  parentPort.postMessage({ type: 'complete', jobId: message.jobId, bytes: transferred }, [transferred]);
}

parentPort.on('message', message => {
  if (message?.type === 'cancel' && typeof message.jobId === 'string') {
    cancelledJobs.add(message.jobId);
    return;
  }
  if (message?.type !== 'derive' || typeof message.jobId !== 'string' || !(message.bytes instanceof ArrayBuffer)) return;
  derivePreview(message).catch(error => {
    parentPort.postMessage({ type: 'failed', jobId: message.jobId, error: error instanceof Error ? error.message : String(error) });
  });
});
