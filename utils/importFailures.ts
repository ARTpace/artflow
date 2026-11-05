/**
 * 单文件导入故障记账（加固项④）。
 *
 * 批量导入里任何一个文件都可能因为解析器抛错、或返回了无法使用的结构而失败。
 * 这类失败只该影响它自己：其余文件继续导入，按「部分成功」的结果入库，并把
 * 「跳过了哪些文件、为什么」如实报出来。
 *
 * 记账形状与受管扩展批次的失败态（plugin-runtime/extension-registry 的
 * ImportBatchEntry：status 'failed' + error 文案）保持一致 —— 两条批量通路
 * 报出的失败明细是同一种东西；错误文案的归一化也与 markBatchEntryFailed 共用
 * 本模块的实现，避免同一个错误在两处被格式化出两种口径。
 */

export type ImportFailureStage = 'parse' | 'structure';

export interface ImportFileFailure {
    /** 与导入批次 entry 对齐的稳定 id，方便 UI 把明细关联回同一次导入。 */
    id: string;
    name: string;
    /** parse＝解析器/解码器抛错；structure＝解析器跑通了但返回的结构没法装载。 */
    stage: ImportFailureStage;
    error: string;
}

/** 「跑通了但结果用不了」：与「解析器直接抛错」分开记账，便于区分插件 bug 与脏文件。 */
export class ImportStructureError extends Error {
    readonly stage: ImportFailureStage = 'structure';

    constructor(message: string) {
        super(message);
        this.name = 'ImportStructureError';
    }
}

/** 失败文案归一化：永不返回空串或 "[object Object]"。 */
export const describeImportError = (error: unknown): string => {
    if (error instanceof Error && error.message) return error.message;
    if (typeof error === 'string' && error.length > 0) return error;
    const text = error === undefined || error === null ? '' : String(error);
    return text.length > 0 && text !== 'undefined' && text !== 'null' ? text : 'Unknown import error.';
};

export const importFailureFrom = (id: string, name: string, error: unknown): ImportFileFailure => ({
    id,
    name,
    stage: error instanceof ImportStructureError ? 'structure' : 'parse',
    error: describeImportError(error),
});

const MAX_LISTED_FAILURES = 3;
const MAX_NAME_LENGTH = 60;

const truncateName = (name: string): string => (name.length > MAX_NAME_LENGTH ? `${name.slice(0, MAX_NAME_LENGTH)}…` : name);

/** 失败明细的紧凑人话：最多列举 maxListed 条，其余折叠成计数，避免刷屏。 */
export const summarizeImportFailures = (failures: readonly ImportFileFailure[], maxListed = MAX_LISTED_FAILURES): string => {
    if (failures.length === 0) return '';
    const listed = failures.slice(0, Math.max(1, maxListed))
        .map(failure => `"${truncateName(failure.name)}" (${failure.error})`);
    const hidden = failures.length - listed.length;
    const label = failures.length === 1 ? 'file' : 'files';
    return `Skipped ${failures.length} ${label}: ${listed.join('; ')}${hidden > 0 ? `; +${hidden} more` : ''}`;
};

/** 解析器返回的图片资产是否可用：缺 data URL 或尺寸非法都算「结构不合法」。 */
export const isUsableImageAsset = (value: unknown): boolean => {
    const asset = value as { dataUrl?: unknown; width?: unknown; height?: unknown } | null | undefined;
    return Boolean(asset && typeof asset === 'object'
        && typeof asset.dataUrl === 'string' && asset.dataUrl.length > 0
        && typeof asset.width === 'number' && Number.isFinite(asset.width) && asset.width > 0
        && typeof asset.height === 'number' && Number.isFinite(asset.height) && asset.height > 0);
};

export const isNonEmptyString = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
