/**
 * main/comfyProxy.cjs —— 外部 AI 工具（ComfyUI）的受限代理实现（REQ-004 通道二 / §12.2 进程原则）。
 *
 * 从 main.cjs 抽出成独立模块，理由有二：
 * 1. main.cjs 只留「IPC 注册 + 发送方校验」，代理策略单独成文件便于审阅与收敛；
 * 2. 能脱离 Electron 被探针/自检直接 require，真实跑一遍 op 白名单、路径穿越防护与错误降级，
 *    而不是只能靠人肉在 Electron 里点。
 *
 * 两条硬约束：
 * - 只实现固定 op 白名单，不接受 (method, url) 形态的任意转发 —— 不得演变成 generic bridge；
 * - 用 node:http 而非 Electron 的 fetch：后者会读系统代理设置，被本机回环代理劫持请求。
 */
const http = require('node:http');

const COMFY_HOST = '127.0.0.1';
const COMFY_PORT = 8188;
const COMFY_ENDPOINT = 'http://' + COMFY_HOST + ':' + COMFY_PORT;
const COMFY_TIMEOUT_MS = 30000;
const COMFY_MAX_BODY_BYTES = 64 * 1024 * 1024;
const COMFY_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const COMFY_VIEW_TYPES = Object.freeze(['input', 'output', 'temp']);

function comfyCall(pathname, options) {
  const settings = options || {};
  const method = settings.method || 'GET';
  const timeoutMs = settings.timeoutMs || COMFY_TIMEOUT_MS;
  const body = settings.payload === undefined ? null : Buffer.from(JSON.stringify(settings.payload), 'utf8');
  return new Promise(function (resolve, reject) {
    const request = http.request({
      host: COMFY_HOST,
      port: COMFY_PORT,
      path: pathname,
      method,
      headers: body ? { 'content-type': 'application/json', 'content-length': body.length } : undefined,
    }, function (response) {
      const chunks = [];
      let size = 0;
      response.on('data', function (chunk) {
        size += chunk.length;
        // 结果图体积可控，超出即判异常，避免被超大响应拖垮主进程。
        if (size > COMFY_MAX_BODY_BYTES) {
          request.destroy(new Error('response too large'));
          return;
        }
        chunks.push(chunk);
      });
      response.on('end', function () {
        resolve({
          status: response.statusCode || 0,
          contentType: String(response.headers['content-type'] || ''),
          buffer: Buffer.concat(chunks),
        });
      });
    });
    request.on('error', reject);
    request.setTimeout(timeoutMs, function () {
      request.destroy(new Error('comfy timeout'));
    });
    if (body) request.write(body);
    request.end();
  });
}

function comfyJsonResult(response) {
  if (response.status < 200 || response.status >= 300) {
    return { ok: false, status: response.status, message: 'comfy http ' + response.status };
  }
  try {
    return { ok: true, status: response.status, data: JSON.parse(response.buffer.toString('utf8')) };
  } catch (error) {
    return { ok: false, status: response.status, message: 'comfy returned invalid json' };
  }
}

/** 结果图 filename/subfolder 由 ComfyUI 侧生成，仍按不可信输入处理：禁路径穿越与查询注入。 */
function comfyViewField(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 260
    && !value.includes('..') && !value.includes('\\') && !value.includes('\0')
    && /^[A-Za-z0-9 _.\-/]+$/.test(value);
}

function comfyViewQuery(request) {
  const params = new URLSearchParams();
  for (const field of ['filename', 'subfolder', 'type']) {
    const value = request[field];
    if (value === undefined || value === null || value === '') continue;
    if (!comfyViewField(value)) return { error: 'rejected: invalid ' + field };
    params.set(field, value);
  }
  if (!params.has('filename')) return { error: 'rejected: filename required' };
  if (params.has('type') && COMFY_VIEW_TYPES.indexOf(params.get('type')) < 0) {
    return { error: 'rejected: invalid type' };
  }
  return { query: params.toString() };
}

async function handleComfyRequest(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    return { ok: false, message: 'rejected: invalid request' };
  }
  try {
    switch (request.op) {
      case 'stats': {
        return comfyJsonResult(await comfyCall('/system_stats'));
      }
      case 'objectInfo': {
        return comfyJsonResult(await comfyCall('/object_info'));
      }
      case 'submit': {
        const workflow = request.workflow;
        if (!workflow || typeof workflow !== 'object' || Array.isArray(workflow)) {
          return { ok: false, message: 'rejected: invalid workflow' };
        }
        const payload = { prompt: workflow };
        if (typeof request.clientId === 'string' && COMFY_ID_PATTERN.test(request.clientId)) {
          payload.client_id = request.clientId;
        }
        // 抠图工作流要内联 base64 原图，提交超时放宽到 2 分钟。
        return comfyJsonResult(await comfyCall('/prompt', { method: 'POST', payload: payload, timeoutMs: 120000 }));
      }
      case 'history': {
        if (typeof request.promptId !== 'string' || !COMFY_ID_PATTERN.test(request.promptId)) {
          return { ok: false, message: 'rejected: invalid prompt id' };
        }
        return comfyJsonResult(await comfyCall('/history/' + request.promptId));
      }
      case 'view': {
        const parsed = comfyViewQuery(request);
        if (parsed.error) return { ok: false, message: parsed.error };
        const response = await comfyCall('/view?' + parsed.query, { timeoutMs: 120000 });
        if (response.status < 200 || response.status >= 300) {
          return { ok: false, status: response.status, message: 'comfy http ' + response.status };
        }
        return {
          ok: true,
          status: response.status,
          contentType: response.contentType,
          bytes: response.buffer.buffer.slice(response.buffer.byteOffset, response.buffer.byteOffset + response.buffer.byteLength),
        };
      }
      case 'interrupt': {
        return comfyJsonResult(await comfyCall('/interrupt', { method: 'POST', payload: {} }));
      }
      default:
        return { ok: false, message: 'rejected: unsupported op' };
    }
  } catch (error) {
    return { ok: false, message: 'comfy unreachable: ' + error.message };
  }
}

module.exports = {
  COMFY_HOST,
  COMFY_PORT,
  COMFY_ENDPOINT,
  COMFY_TIMEOUT_MS,
  COMFY_VIEW_TYPES,
  comfyCall,
  comfyViewQuery,
  handleComfyRequest,
};
