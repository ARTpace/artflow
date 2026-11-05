/**
 * editable-loader —— 内置可编辑插件通道的渲染端加载器。
 *
 * 数据流：主进程读 userData/plugins/builtin/<id>/plugin.js 源码文本 → 这里**受信任执行**
 * （new Function，注入宿主 API）→ 产出 BuiltinPluginModule（manifest + activate）→
 * 交给现有 loadBuiltinPlugins 走同一条激活路径。
 *
 * 安全边界：editable 插件是我们播种的**内置**插件（id 保留 builtin.），信任级等同编译进
 * bundle 的内置插件 —— 因此这里**不做 API 白名单**（区别于 sandbox 的 guest 窗口）。
 * 它只应来自播种目录；installExternalPlugin 只写 local.*，不会污染这里。
 *
 * 为什么不用 sandbox：sandbox 只给受限 Artflow API 且 id 强制 local.，无法满足
 * "保留 builtin. 前缀 + 可改逻辑"的诉求；内置插件的信任模型本就允许直接宿主能力。
 */
import type { Kernel } from './kernel';
import type { BuiltinPluginModule } from './loader';
import { normalizeCardCapabilityManifest } from './card-capability-compat';
import {
  CODE_EXTENSIONS_MAP,
  FONT_EXTENSIONS,
  MARKDOWN_EXTENSIONS,
  MODEL_3D_EXTENSIONS,
  URL_EXTENSIONS,
  getLanguageFromExt,
  loadFontFile,
  parseUrlFile,
  readTextFile,
} from '../utils/docUtils';
import { IMAGE_EXTENSIONS, AUDIO_EXTENSIONS, VIDEO_EXTENSIONS } from '../utils/formatDetector';
import { readAndCompressImage, fileToDataUrl } from '../utils/fileUtils';
import { hasManagedProjectStorage } from '../utils/managedProjectStorage';
import { parsePsdFile } from '../utils/psdUtils';
import { parsePdfFile } from '../utils/pdfUtils';
import { parseAudioFile } from '../utils/audioUtils';
import type { FormatImageResult, FormatSceneItem } from './format-handlers';
import { FORMAT_LIMITS, bindFormatLimitConfig, limitBytes, limitMessage } from './format-limits';
import { HOST_PLATFORM_SERVICE } from './host-platform';
import { CANVAS_EXPORT_SOURCE_SERVICE } from './canvas-export-source';
import { CANVAS_MUTATION_SERVICE } from './canvas-mutation';
import { CANVAS_VIEW_STATE_SERVICE } from './canvas-view-state';
import { DOCUMENT_SERVICE, OPERATIONS_SERVICE } from './document-contract';
import { ELEMENT_COMMAND_ACTIONS_SERVICE } from './element-command-actions';
import { WORKSPACE_COMMAND_ACTIONS_SERVICE } from './workspace-command-actions';
import { EXTENSION_RUNTIME_SERVICE } from './extension-service';
import { createOperationGuardHook } from './operation-guard';
import { zipSync, unzipSync, strToU8, strFromU8 } from 'fflate';
import { uiText } from '../utils/language-store';
import { bi } from './i18n';

/**
 * PureRef 单条场景项的最小形状（避免 host 静态 import purParser 造成体积/循环问题；
 * 实际解析走动态 import）。
 */
interface PurSceneItemLike {
  kind: 'text' | 'image';
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
  rotation?: number;
  text?: string;
  fontSize?: number;
  fontColor?: string;
  bytes?: Uint8Array;
  mimeType?: string;
}

/** Uint8Array → data URL（分块避免 apply 参数溢出）。 */
export const bytesToDataUrl = (bytes: Uint8Array, mimeType: string): string => {
  const parts: string[] = [];
  const chunk = 4096;
  for (let offset = 0; offset < bytes.length; offset += chunk) {
    const slice = bytes.subarray(offset, Math.min(offset + chunk, bytes.length));
    parts.push(String.fromCharCode(...slice));
  }
  return `data:${mimeType};base64,${btoa(parts.join(''))}`;
};

/** PureRef 场景项 → FormatSceneItem；无法转换（缺字段）时返回 undefined。 */
export const purItemToSceneItem = (item: PurSceneItemLike): FormatSceneItem | undefined => {
  if (item.kind === 'text' && item.text) {
    return {
      kind: 'text',
      name: item.name,
      x: item.x,
      y: item.y,
      width: item.width,
      height: item.height,
      rotation: item.rotation,
      text: item.text,
      fontSize: item.fontSize ?? 16,
      fontColor: item.fontColor ?? '#111111',
    };
  }
  if (item.kind === 'image' && item.bytes && item.mimeType) {
    return {
      kind: 'image',
      name: item.name,
      x: item.x,
      y: item.y,
      width: item.width,
      height: item.height,
      rotation: item.rotation,
      dataUrl: bytesToDataUrl(item.bytes, item.mimeType),
      mimeType: item.mimeType,
    };
  }
  return undefined;
};

/**
 * 保留 fileUtils 产出的全部档位（缩略图/中档/原图），否则画布会把每张 JPG 静默按 1024px 渲染。
 * 导出以便自检脚本直接验证；editable 插件也可经 Artflow.host.imageFrom 调用。
 */
export const imageFrom = (
  name: string,
  parsed: Pick<FormatImageResult, 'width' | 'height' | 'dataUrl' | 'thumbnailDataUrl' | 'mediumDataUrl' | 'originalDataUrl' | 'mimeType'>,
): FormatImageResult => ({
  kind: 'image',
  name,
  width: parsed.width,
  height: parsed.height,
  dataUrl: parsed.dataUrl,
  thumbnailDataUrl: parsed.thumbnailDataUrl,
  mediumDataUrl: parsed.mediumDataUrl,
  originalDataUrl: parsed.originalDataUrl,
  mimeType: parsed.mimeType,
});

/** 已执行过的 editable 插件（避免重复求值；按 id 缓存激活结果）。 */
const loaded = new Map<string, BuiltinPluginModule>();
/** 上次执行失败的原因，供设置页/日志查询。 */
const failures = new Map<string, string>();

interface EditableRaw {
  id: string;
  name: string;
  version: string;
  description: string;
  manifest: Record<string, unknown>;
  source: string;
}

/** 注入给 plugin.js 的宿主 API（受信任，能力等同内置插件）。 */
function createHostApi(pluginId: string): Record<string, unknown> {
  return {
    /** 声明插件：setup 收到带 definePlugin 的 Artflow 对象，直接返回 module。 */
    definePlugin(module: BuiltinPluginModule): BuiltinPluginModule { return module; },
    /** 宿主工具函数（与内置插件源码同源）。 */
    host: {
      readTextFile,
      parseUrlFile,
      loadFontFile,
      getLanguageFromExt,
      /** 便利：把 (file) => dataURL 的常见需求包一层（受信任代码可用 URL）。 */
      createObjectUrl: (file: Blob) => URL.createObjectURL(file),
      // —— 重型解析器（依赖 ag-psd / pdfjs-dist / 图像代理链）：作为宿主能力注入，
      //    避免把第三方库内联进 plugin.js，同时让插件源码保持精简可编辑。 ——
      /** PSD/PSB 解析（内置 utils/psdUtils，依赖 ag-psd）。 */
      parsePsdFile,
      /** PDF 分页解析（内置 utils/pdfUtils，依赖 pdfjs-dist）。 */
      parsePdfFile,
      /** 音频元数据读取（内置 utils/audioUtils）。 */
      parseAudioFile,
      /** 图像读取 + 多档压缩（内置 utils/fileUtils，覆盖 svg/tga/exr 分支）。 */
      readAndCompressImage,
      /** 整文件 → data URL（视频/音频导入在非托管工程下的回退路径）。 */
      fileToDataUrl,
      /** 当前工程是否托管存储（决定视频用 blob: 运行态引用还是内联 dataURL）。 */
      hasManagedProjectStorage,
      /** 把 fileUtils 的读取结果映射成 FormatImageResult（保留全部档位）。 */
      imageFrom,
      // —— 阅读 / 漫画解析器（依赖 fflate、format-limits 与内部交叉引用）：同样作为宿主能力注入。 ——
      /** TXT/HTML 纯文本阅读。 */
      parseBookFile: (file: File) => import('../capabilities/formats-book/bookParser').then(m => m.parseBookFile(file)),
      /** EPUB 阅读（依赖 fflate）。 */
      parseEpubFile: (file: File) => import('../capabilities/formats-book/epubParser').then(m => m.parseEpubFile(file)),
      /** CBZ 漫画（主进程档案仓，懒加载解页）。 */
      parseComicFile: (file: File) => import('../capabilities/formats-comic/comicParser').then(m => m.parseComicFile(file)),
      /** MOBI/AZW/AZW3 阅读。 */
      parsePalmFile: (file: File) => import('../capabilities/formats-packaged/palmDoc').then(m => m.parsePalmFile(file)),
      /** CBR/CB7/7Z 漫画页（依赖 fflate）。 */
      parsePackedComicFile: (file: File) => import('../capabilities/formats-packaged/packedArchive').then(m => m.parsePackedComicFile(file)),
      /** PureRef .pur 原始字节解析（自研 purParser，无外部依赖）。 */
      parsePurBytes: (bytes: Uint8Array) => import('../capabilities/formats-pureref/purParser').then(m => m.parsePurBytes(bytes)),
      /** Uint8Array → data URL（PureRef 场景内嵌图片用）。 */
      bytesToDataUrl,
      /** PureRef 单条场景项 → FormatSceneItem（无法转换时返回 undefined）。 */
      purItemToSceneItem: (item: unknown) => purItemToSceneItem(item as PurSceneItemLike),
      // —— 阈值配置缝（format-limits）：把 plugin.configSchema 的数值接成解析器阈值来源。 ——
      /** 读某条阈值当前生效的字节上限（未注入 provider 时回退契约默认值）。 */
      limitBytes,
      /** 阈值超限的报错文案（报**实际生效**的值，不是常量）。 */
      limitMessage,
      /** activate 里调一次：把 profileManager 接成 config 来源，返回 dispose。 */
      bindFormatLimitConfig: (kernel: Kernel) => bindFormatLimitConfig(kernel as never),
      /** 全部阈值声明（按名字取，如 FORMAT_LIMITS.purFileMiB）。 */
      formatLimits: FORMAT_LIMITS,
      /**
       * 操作守卫 hooks 工厂（内置 plugins/operation-guard）。
       * 注入宿主原函数，插件侧只提供 isPackageActive / packagePermissions 两个查询口。
       */
      createOperationGuardHook: (context: {
        isPackageActive: (id: string) => boolean;
        packagePermissions: (id: string) => string[];
      }) => createOperationGuardHook(context as never),
      /** zip 容器读写（依赖 fflate）：单文件工程 .artflow 用。 */
      zip: {
        zipSync: (files: Record<string, Uint8Array>, options?: Parameters<typeof zipSync>[1]) => zipSync(files, options),
        unzipSync: (bytes: Uint8Array) => unzipSync(bytes),
        strToU8,
        strFromU8,
      },
      /** 按当前界面语言取文案（语言无关的运行时文案用）。 */
      uiText,
    },
    /** 扩展名表 / 常量。 */
    constants: {
      CODE_EXTENSIONS_MAP,
      MARKDOWN_EXTENSIONS: [...MARKDOWN_EXTENSIONS],
      FONT_EXTENSIONS: [...FONT_EXTENSIONS],
      URL_EXTENSIONS: [...URL_EXTENSIONS],
      MODEL_3D_EXTENSIONS: [...MODEL_3D_EXTENSIONS],
      IMAGE_EXTENSIONS: [...IMAGE_EXTENSIONS],
      AUDIO_EXTENSIONS: [...AUDIO_EXTENSIONS],
      VIDEO_EXTENSIONS: [...VIDEO_EXTENSIONS],
    },
    /**
     * 宿主服务名常量表（字符串字面量，供 plugin.js 里 ctx.use(...) 取服务）。
     * 受信任代码经 ctx.use(name) 拿到的就是 App 提供的那个服务对象本身 ——
     * 与编译进 bundle 的内置插件完全同源，不额外开权限面。
     */
    services: {
      HOST_PLATFORM: HOST_PLATFORM_SERVICE,
      CANVAS_EXPORT_SOURCE: CANVAS_EXPORT_SOURCE_SERVICE,
      CANVAS_MUTATION: CANVAS_MUTATION_SERVICE,
      CANVAS_VIEW_STATE: CANVAS_VIEW_STATE_SERVICE,
      DOCUMENT: DOCUMENT_SERVICE,
      OPERATIONS: OPERATIONS_SERVICE,
      ELEMENT_COMMAND_ACTIONS: ELEMENT_COMMAND_ACTIONS_SERVICE,
      WORKSPACE_COMMAND_ACTIONS: WORKSPACE_COMMAND_ACTIONS_SERVICE,
      EXTENSION_RUNTIME: EXTENSION_RUNTIME_SERVICE,
    },
    /** 双语文案构造（与内置插件同源）：bi('中文', 'English') → (lang) => string。 */
    bi,
    pluginId,
  };
}

/**
 * 执行一个 editable 插件的源码，返回 BuiltinPluginModule。
 * 源码形如：Artflow.definePlugin({ manifest, activate })。
 * 若源码未调用 definePlugin（或返回值形状不对），抛出并记录原因。
 */
export function evaluateEditableSource(raw: EditableRaw): BuiltinPluginModule {
  const api = createHostApi(raw.id);
  // 受信任执行：与内置插件同信任级。锁定的全局仅用于"防手滑"，不构成安全边界。
  let captured: BuiltinPluginModule | undefined;
  const Artflow = {
    ...api,
    definePlugin(module: BuiltinPluginModule) {
      captured = module;
      return module;
    },
  };
  // 用 new Function 在同一主世界执行；插件可直接用 fetch/document 等宿主能力（受信任）。
  const runner = new Function('Artflow', `"use strict";\n${raw.source}`);
  runner(Artflow);
  if (!captured || typeof captured !== 'object' || !('manifest' in captured)) {
    throw new Error('plugin.js did not call Artflow.definePlugin({ manifest, activate })');
  }
  // manifest 以磁盘上的为准（避免源码里 id 与目录名不一致导致注册错位）。
  return { manifest: normalizeCardCapabilityManifest(raw.manifest), activate: captured.activate as BuiltinPluginModule['activate'] };
}

/**
 * 拉取并执行所有 editable 插件。返回可交给 loadBuiltinPlugins 的模块列表。
 * 失败只警告不抛出 —— 一个坏插件不该让启动链断掉。
 */
export async function loadEditablePlugins(kernel: Kernel): Promise<BuiltinPluginModule[]> {
  const read = window.artflowApp?.readEditablePlugins;
  if (!read) return [];
  let result: Awaited<ReturnType<typeof read>>;
  try {
    result = await read();
  } catch (error) {
    console.warn('[editable] read failed', error);
    return [];
  }
  const modules: BuiltinPluginModule[] = [];
  for (const raw of result.plugins) {
    try {
      const module = evaluateEditableSource(raw);
      loaded.set(raw.id, module);
      failures.delete(raw.id);
      modules.push(module);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failures.set(raw.id, message);
      console.error(`[editable] ${raw.id} failed to evaluate:`, error);
      kernel.emit('plugin:load-failed', { id: raw.id, reason: message });
    }
  }
  return modules;
}

/** 诊断：列出已成功执行的 editable 插件 id。 */
export function listLoadedEditableIds(): string[] {
  return [...loaded.keys()];
}

/** 诊断：列出执行失败的 editable 插件。 */
export function listEditableFailures(): Array<{ id: string; reason: string }> {
  return [...failures.entries()].map(([id, reason]) => ({ id, reason }));
}
