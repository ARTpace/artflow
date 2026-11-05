/**
 * Small session-only reference baseline tracker. Board state is already updated immutably,
 * so this intentionally avoids serializing or deep-diffing project data in the render path.
 */
export interface ProjectChangeState<T> {
  baseline: T;
  isDirty: boolean;
}

export const createProjectChangeState = <T>(boards: T): ProjectChangeState<T> => ({
  baseline: boards,
  isDirty: false,
});

/** Observe the current Board[] reference after a normal immutable update. */
export const observeProjectBoards = <T>(
  state: ProjectChangeState<T>,
  currentBoards: T,
): ProjectChangeState<T> => ({
  baseline: state.baseline,
  isDirty: currentBoards === state.baseline ? false : !isCameraOnlyChange(state.baseline, currentBoards),
});

/**
 * 相机字段（panOffset/zoom）只是视图元数据：平移/缩放提交后不应该让项目立刻变脏、
 * 更不应该据此触发自动保存。这里按"忽略相机键"逐项引用比较，未知/新增字段仍按内容对待。
 */
const CAMERA_KEYS = new Set(['panOffset', 'zoom']);

const boardsMatchExceptCamera = (previous: unknown, next: unknown): boolean => {
  if (previous === next) return true;
  if (!Array.isArray(previous) || !Array.isArray(next)) return false;
  if (previous.length !== next.length) return false;
  return previous.every((previousBoard, index) => {
    const nextBoard = next[index];
    if (previousBoard === nextBoard) return true;
    if (typeof previousBoard !== 'object' || previousBoard === null) return false;
    if (typeof nextBoard !== 'object' || nextBoard === null) return false;
    const previousRecord = previousBoard as Record<string, unknown>;
    const nextRecord = nextBoard as Record<string, unknown>;
    const previousContentKeys = Object.keys(previousRecord).filter(key => !CAMERA_KEYS.has(key));
    const nextContentKeys = Object.keys(nextRecord).filter(key => !CAMERA_KEYS.has(key));
    if (previousContentKeys.length !== nextContentKeys.length) return false;
    return previousContentKeys.every(
      key => nextRecord[key] === previousRecord[key] && Object.prototype.hasOwnProperty.call(nextRecord, key),
    );
  });
};

/** 只有相机变化时为 true；结构/内容/历史/书签等任何其它字段变化都为 false。 */
export const isCameraOnlyChange = (previous: unknown, next: unknown): boolean =>
  boardsMatchExceptCamera(previous, next);

/** A successful nonempty project load establishes a fresh in-memory baseline. */
export const acceptLoadedProjectBoards = <T>(loadedBoards: T): ProjectChangeState<T> =>
  createProjectChangeState(loadedBoards);

/**
 * A save only clears the UI signal when the captured save snapshot is still current.
 * If a later Board[] arrived while saving, retain the previous baseline and dirty state.
 */
export const completeProjectSave = <T>(
  state: ProjectChangeState<T>,
  savedBoards: T,
  currentBoards: T,
): ProjectChangeState<T> => currentBoards === savedBoards
  ? createProjectChangeState(savedBoards)
  : { baseline: state.baseline, isDirty: true };
