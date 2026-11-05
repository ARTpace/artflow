/* Keep import commits out of live canvas gestures and give pending browser input
 * priority over document writes. A batch waits rather than accumulating more
 * decoded files; the caller should hold at most one bounded working batch.
 */

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));
const BUSY_POLL_MS = 45;
const INPUT_GRACE_MS = 400;

const hasPendingInput = (): boolean => {
  try {
    const scheduling = (typeof navigator === 'undefined' ? undefined : navigator as Navigator & {
      scheduling?: { isInputPending?: (options?: { includeContinuous?: boolean }) => boolean };
    }).scheduling;
    return scheduling?.isInputPending?.({ includeContinuous: true }) ?? false;
  } catch {
    return false;
  }
};

/** rIC can be suspended in background tabs. The timer keeps import progress
 * alive while still yielding an event-loop turn, with no unbounded wait. */
const idleOpportunity = (): Promise<number> => new Promise(resolve => {
  if (typeof requestIdleCallback !== 'function' || (typeof document !== 'undefined' && document.hidden)) {
    setTimeout(() => resolve(8), 16);
    return;
  }
  let settled = false;
  let fallback: ReturnType<typeof setTimeout> | undefined;
  const finish = (availableMs: number) => {
    if (settled) return;
    settled = true;
    if (fallback) clearTimeout(fallback);
    resolve(availableMs);
  };
  const idle = requestIdleCallback(deadline => finish(deadline.timeRemaining()), { timeout: 100 });
  fallback = setTimeout(() => {
    if (typeof cancelIdleCallback === 'function') cancelIdleCallback(idle);
    finish(0);
  }, 120);
});

/** Wait for a quiet window, but never apply a canvas mutation mid-gesture.
 * If other input continues without a gesture, proceed after a short grace
 * period so import cannot be starved by a continuously moving pointer. */
export async function waitForImportCommit(isCanvasBusy: () => boolean = () => false): Promise<void> {
  const started = Date.now();
  for (;;) {
    if (isCanvasBusy()) {
      await sleep(BUSY_POLL_MS);
      continue;
    }
    const availableMs = await idleOpportunity();
    if (isCanvasBusy()) continue;
    if ((availableMs < 6 || hasPendingInput()) && Date.now() - started < INPUT_GRACE_MS) {
      await sleep(16);
      continue;
    }
    return;
  }
}
