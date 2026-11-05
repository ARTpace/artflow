/** Capture DOM metadata only after React commits, never on live camera frames. */
interface CullEntry {
  node: SVGGElement;
  x: number;
  y: number;
  width: number;
  height: number;
  hidden: boolean;
  clearLegacyStyles: boolean;
}

export const CULL_SHOW_SCREEN = 96;
export const CULL_HIDE_SCREEN = 240;

export const captureViewportCullEntries = (group: SVGGElement): CullEntry[] => {
  const entries: CullEntry[] = [];
  for (const node of group.querySelectorAll<SVGGElement>('[data-cull-w]')) {
    // Stable HTML/image cards move through their outer SVG wrapper.
    const parent = node.parentElement;
    const x = Number(node.dataset.cullX) + Number(parent?.getAttribute('data-bp-drag-x') ?? 0);
    const y = Number(node.dataset.cullY) + Number(parent?.getAttribute('data-bp-drag-y') ?? 0);
    const width = Number(node.dataset.cullW);
    const height = Number(node.dataset.cullH);
    if (![x, y, width, height].every(Number.isFinite)) continue;
    entries.push({
      node, x, y, width, height,
      hidden: node.dataset.cullState === 'out',
      clearLegacyStyles: Boolean(node.style.opacity || node.style.transition),
    });
  }
  return entries;
};

/** Pure AABB decisions followed by changed-state writes; no live DOM reads. */
export const cullViewportEntries = (
  entries: ReturnType<typeof captureViewportCullEntries>,
  zoom: number,
  panX: number,
  panY: number,
  viewW: number,
  viewH: number,
): void => {
  if (!(zoom > 0) || viewW <= 0 || viewH <= 0) return;
  const left = -panX / zoom;
  const top = -panY / zoom;
  const right = left + viewW / zoom;
  const bottom = top + viewH / zoom;
  for (const entry of entries) {
    const pad = (entry.hidden ? CULL_SHOW_SCREEN : CULL_HIDE_SCREEN) / zoom;
    const hidden = entry.x + entry.width < left - pad || entry.y + entry.height < top - pad
      || entry.x > right + pad || entry.y > bottom + pad;
    if (hidden !== entry.hidden) {
      entry.hidden = hidden;
      if (hidden) entry.node.dataset.cullState = 'out';
      else delete entry.node.dataset.cullState;
      entry.node.style.display = hidden ? 'none' : '';
      entry.clearLegacyStyles = true;
    }
    if (entry.clearLegacyStyles) {
      entry.node.style.opacity = '';
      entry.node.style.transition = '';
      entry.clearLegacyStyles = false;
    }
  }
};
