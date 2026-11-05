/**
 * builtin/ai-providers/comfy-client.ts —— ComfyUI 客户端层（REQ-004 通道二）。
 *
 * 分层原则（与 builtin/cutout/matting.ts 同风格）：
 * 1. 纯函数区（stripDataUrlPrefix / buildMattingWorkflow / parseHistoryImages / bytesToBase64）
 *    不依赖 DOM 与网络，可被 node self-check 直接 require；
 * 2. 网络怎么发被外置成 ComfyTransport 依赖 —— 生产用主进程代理桥，自检注入 fake transport，
 *    因此自检在 ComfyUI 未启动时也能完整跑过；
 * 3. renderer 永不直连 ComfyUI（§12.2 进程原则）：默认 transport 走 window.artflowAi.comfyRequest。
 */

import type { ComfyProxyRequest, ComfyProxyResponse } from '../../types';

export type ComfyTransport = (request: ComfyProxyRequest) => Promise<ComfyProxyResponse>;

export const COMFY_ENDPOINT = 'http://127.0.0.1:8188';

/**
 * 横评结论（7 模型多数投票共识前景）：BiRefNet_lite 综合最优 ——
 * IoU 0.9951、误删 0.01%、权重 94MB、单张 1.6s；BiRefNet-portrait/matting 精度同级但更重。
 */
export const DEFAULT_MATTING_MODEL = 'BiRefNet_lite';
export const MATTING_MODELS = Object.freeze([
  'BiRefNet_lite',
  'BiRefNet-portrait',
  'BiRefNet-general',
  'BiRefNet-matting',
]);
export const MATTING_NODE_CLASS = 'BiRefNetRMBG';
export const COMFY_NAMESPACE_PREFIX = 'comfyui.';

// ── 纯函数区 ────────────────────────────────────────────────────────────────

/** data URL → 裸 base64（ComfyUI 的 ETN_LoadImageBase64 只吃裸串，不认 data: 前缀）。 */
export const stripDataUrlPrefix = (value: string): string => {
  if (!value.startsWith('data:')) return value;
  const comma = value.indexOf(',');
  return comma >= 0 ? value.slice(comma + 1) : value;
};

/**
 * 抠图工作流：原图 base64 内联，全程不落地文件、不走 /upload/image。
 * 节点 2 的 0 号输出是带 alpha 的 IMAGE（background='Alpha'），1 号输出是 MASK —— 取 0 号即可省掉 MaskToImage。
 */
export const buildMattingWorkflow = (
  imageBase64: string,
  model: string = DEFAULT_MATTING_MODEL,
  filenamePrefix = 'artflow/cutout',
): Record<string, unknown> => ({
  '1': { class_type: 'ETN_LoadImageBase64', inputs: { image: imageBase64 } },
  '2': {
    class_type: MATTING_NODE_CLASS,
    inputs: {
      image: ['1', 0],
      model,
      sensitivity: 1,
      mask_blur: 0,
      mask_offset: 0,
      invert_output: false,
      refine_foreground: false,
      background: 'Alpha',
    },
  },
  '3': { class_type: 'SaveImage', inputs: { images: ['2', 0], filename_prefix: filenamePrefix } },
});

export interface ComfyImageRef {
  filename: string;
  subfolder: string;
  type: 'input' | 'output' | 'temp';
}

export type ComfyRunState = 'pending' | 'running' | 'completed' | 'error';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** history 条目 → 单轮执行状态。ComfyUI 用 status.completed 与 status_str==='error' 表达终态。 */
export const parseHistoryState = (entry: unknown): ComfyRunState => {
  if (!isRecord(entry)) return 'pending';
  const status = isRecord(entry.status) ? entry.status : null;
  if (status) {
    if (status.status_str === 'error' || status.status === 'error') return 'error';
    if (status.completed === true || status.status_str === 'success') return 'completed';
  }
  return 'running';
};

/** history 条目 → 输出图引用；按节点号升序取第一个，不依赖对象键顺序。 */
export const parseHistoryImages = (entry: unknown): ComfyImageRef[] => {
  if (!isRecord(entry) || !isRecord(entry.outputs)) return [];
  const refs: ComfyImageRef[] = [];
  const nodeIds = Object.keys(entry.outputs).sort((a, b) => Number(a) - Number(b));
  for (const nodeId of nodeIds) {
    const output = entry.outputs[nodeId];
    if (!isRecord(output) || !Array.isArray(output.images)) continue;
    for (const image of output.images) {
      if (!isRecord(image) || typeof image.filename !== 'string') continue;
      const type = image.type === 'input' || image.type === 'temp' ? image.type : 'output';
      refs.push({
        filename: image.filename,
        subfolder: typeof image.subfolder === 'string' ? image.subfolder : '',
        type,
      });
    }
  }
  return refs;
};

/** 执行失败时把 ComfyUI 的 messages 压成一行可读原因（节点校验错误通常藏在里面）。 */
export const describeHistoryError = (entry: unknown): string => {
  if (!isRecord(entry) || !isRecord(entry.status) || !Array.isArray(entry.status.messages)) {
    return 'ComfyUI 执行失败';
  }
  const parts: string[] = [];
  for (const message of entry.status.messages) {
    if (!Array.isArray(message)) continue;
    const detail = message[1];
    if (isRecord(detail) && typeof detail.exception_message === 'string') {
      parts.push(detail.exception_message);
    } else if (typeof detail === 'string') {
      parts.push(detail);
    }
  }
  return parts.length > 0 ? parts.join(' / ').slice(0, 300) : 'ComfyUI 执行失败';
};

export const bytesToBase64 = (bytes: Uint8Array): string => {
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
};

export const toPngDataUrl = (bytes: ArrayBuffer | Uint8Array): string =>
  `data:image/png;base64,${bytesToBase64(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes))}`;

/** /system_stats → 探测结果的字段收敛（口径与 ExternalAssetSourceStatus 对齐）。 */
export const parseSystemStats = (data: unknown): { device?: string; vramFree?: number } => {
  if (!isRecord(data)) return {};
  const devices = Array.isArray(data.devices) ? data.devices : [];
  const first = devices.find(isRecord);
  if (!first) return {};
  const device = typeof first.name === 'string' ? first.name : undefined;
  const vramFree = typeof first.vram_free === 'number' ? first.vram_free : undefined;
  return { device, vramFree };
};

// ── 客户端工厂 ──────────────────────────────────────────────────────────────

export interface ComfyProbeResult {
  online: boolean;
  endpoint: string;
  device?: string;
  vramFree?: number;
  message?: string;
}

export interface ComfyMattingResult {
  imageDataUrl: string;
  metadata: Record<string, unknown>;
}

export interface ComfyClientOptions {
  pollIntervalMs?: number;
  timeoutMs?: number;
  /** 测试用的等待实现注入点；默认 setTimeout。 */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export interface ComfyClient {
  probeStatus(): Promise<ComfyProbeResult>;
  submitMatting(imageDataUrl: string, model?: string): Promise<ComfyMattingResult>;
}

const defaultSleep = (ms: number): Promise<void> => new Promise(resolve => { setTimeout(resolve, ms); });

const transportFailure = (response: ComfyProxyResponse): string | null => {
  if (response.ok) return null;
  return 'message' in response && response.message ? response.message : 'ComfyUI 请求失败';
};

export const createComfyClient = (transport: ComfyTransport, options: ComfyClientOptions = {}): ComfyClient => {
  const pollIntervalMs = options.pollIntervalMs ?? 1200;
  const timeoutMs = options.timeoutMs ?? 180000;
  const sleep = options.sleep ?? defaultSleep;
  const now = options.now ?? (() => Date.now());

  const probeStatus = async (): Promise<ComfyProbeResult> => {
    try {
      const response = await transport({ op: 'stats' });
      const failure = transportFailure(response);
      if (failure) return { online: false, endpoint: COMFY_ENDPOINT, message: failure };
      const stats = parseSystemStats('data' in response ? response.data : null);
      return {
        online: true,
        endpoint: COMFY_ENDPOINT,
        device: stats.device,
        vramFree: stats.vramFree,
        message: 'ComfyUI 在线',
      };
    } catch (error) {
      return {
        online: false,
        endpoint: COMFY_ENDPOINT,
        message: error instanceof Error ? error.message : String(error),
      };
    }
  };

  const submitMatting = async (imageDataUrl: string, model = DEFAULT_MATTING_MODEL): Promise<ComfyMattingResult> => {
    const startedAt = now();
    const workflow = buildMattingWorkflow(stripDataUrlPrefix(imageDataUrl), model);
    const submitted = await transport({ op: 'submit', workflow });
    const submitFailure = transportFailure(submitted);
    if (submitFailure) throw new Error(submitFailure);
    const payload = 'data' in submitted ? submitted.data : null;
    const promptId = isRecord(payload) && typeof payload.prompt_id === 'string' ? payload.prompt_id : null;
    if (!promptId) throw new Error('ComfyUI 未返回 prompt_id');

    let entry: unknown = null;
    while (now() - startedAt <= timeoutMs) {
      const historyResponse = await transport({ op: 'history', promptId });
      const historyFailure = transportFailure(historyResponse);
      if (historyFailure) throw new Error(historyFailure);
      const historyData = 'data' in historyResponse ? historyResponse.data : null;
      entry = isRecord(historyData) ? historyData[promptId] ?? null : null;
      const state = parseHistoryState(entry);
      if (state === 'error') throw new Error(describeHistoryError(entry));
      if (state === 'completed') break;
      await sleep(pollIntervalMs);
    }
    if (parseHistoryState(entry) !== 'completed') throw new Error('ComfyUI 抠图超时');

    const images = parseHistoryImages(entry);
    if (images.length === 0) throw new Error('ComfyUI 没有产出图片');
    const target = images[0];
    const viewResponse = await transport({
      op: 'view',
      filename: target.filename,
      subfolder: target.subfolder,
      type: target.type,
    });
    const viewFailure = transportFailure(viewResponse);
    if (viewFailure) throw new Error(viewFailure);
    if (!('bytes' in viewResponse) || !viewResponse.bytes) throw new Error('ComfyUI 返回了空的图像数据');

    return {
      imageDataUrl: toPngDataUrl(viewResponse.bytes),
      metadata: {
        // asset_sources 契约定死：元数据键必须带声明的前缀，供同参重生成查询。
        [`${COMFY_NAMESPACE_PREFIX}promptId`]: promptId,
        [`${COMFY_NAMESPACE_PREFIX}model`]: model,
        [`${COMFY_NAMESPACE_PREFIX}node`]: MATTING_NODE_CLASS,
        [`${COMFY_NAMESPACE_PREFIX}filename`]: target.filename,
        [`${COMFY_NAMESPACE_PREFIX}durationMs`]: now() - startedAt,
      },
    };
  };

  return { probeStatus, submitMatting };
};

/**
 * 默认 transport：只经主进程桥。每次调用时读取桥，避免模块加载早于 preload 注入时被固化成
 * 一个永久的 undefined；浏览器（vite dev，无 preload）下返回可见失败，由调用方降级。
 */
export const createBridgeTransport = (): ComfyTransport => {
  return async request => {
    const bridge = typeof window === 'undefined' ? undefined : window.artflowAi;
    if (!bridge) {
      return { ok: false, message: 'AI 抠图需要在桌面端运行（浏览器模式没有主进程代理）' };
    }
    return bridge.comfyRequest(request);
  };
};

export const defaultComfyClient = createComfyClient(createBridgeTransport());
