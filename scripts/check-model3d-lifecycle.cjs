const assert = require('node:assert/strict');
const Module = require('node:module');
require('./register-typescript.cjs');
const THREE = require('three');
let nextFrame = 0;
let time = 0;
const frames = new Map();
const visibility = new Set();
global.requestAnimationFrame = callback => { frames.set(++nextFrame, callback); return nextFrame; };
global.cancelAnimationFrame = id => frames.delete(id);
global.document = { hidden: false, addEventListener: (_, fn) => visibility.add(fn), removeEventListener: (_, fn) => visibility.delete(fn) };
global.window = { devicePixelRatio: 1 };
function step() {
  const batch = [...frames.values()]; frames.clear(); time += 16;
  batch.forEach(fn => fn(time));
}
const { createModel3DRenderLoop, disposeModel3DObject, observeModel3DSize } = require('../utils/model3dLifecycle.ts');
let renders = 0, moving = false, active = true, damping = 0;
const deltas = [];
const loop = createModel3DRenderLoop({
  update: delta => { deltas.push(delta); return damping-- > 0; },
  render: () => renders++, continuous: () => moving, active: () => active,
});
step(); assert.equal(renders, 1); assert.equal(frames.size, 0, 'static viewport settles');
loop.invalidate(); loop.invalidate(); assert.equal(frames.size, 1, 'invalidations coalesce');
damping = 2; step(); step(); step(); assert.equal(frames.size, 0, 'damping runs to completion');
moving = true; loop.invalidate(); step(); step(); assert.equal(frames.size, 1, 'auto rotation / animation retains RAF cadence');
active = false; step(); assert.equal(frames.size, 0, 'covered inline viewport pauses');
time += 10000; active = true; loop.invalidate(); step(); assert.equal(deltas.at(-1), 0, 'resume does not jump animation time');
document.hidden = true; visibility.forEach(fn => fn()); assert.equal(frames.size, 0);
document.hidden = false; visibility.forEach(fn => fn()); step(); assert.equal(deltas.at(-1), 0);
loop.dispose(); loop.invalidate(); assert.equal(frames.size, 0); assert.equal(visibility.size, 0);

const counts = { geometry: 0, material: 0, texture: 0 };
function objectWithResources() {
  const geometry = new THREE.BoxGeometry(); geometry.dispose = () => counts.geometry++;
  const texture = new THREE.Texture(); texture.dispose = () => counts.texture++;
  const material = new THREE.MeshStandardMaterial({ map: texture }); material.dispose = () => counts.material++;
  const root = new THREE.Group(); root.add(new THREE.Mesh(geometry, material), new THREE.Mesh(geometry, material));
  return root;
}
disposeModel3DObject(objectWithResources());
assert.deepEqual(counts, { geometry: 1, material: 1, texture: 1 }, 'shared GPU resources disposed once');

// Run the actual component effects with deterministic hooks, renderer and loader.
// No DOM, WebGL or headless browser needed; real Three scene / resources remain.
let current;
const pendingLoads = [], renderers = [], controls = [], observers = [];
const intersections = [];
global.IntersectionObserver = class {
  constructor(fn) { this.fn = fn; intersections.push(this); }
  observe(target) { this.target = target; }
  emit(visible) { this.fn([{ target: this.target, isIntersecting: visible, intersectionRect: { width: visible ? 400 : 0, height: visible ? 280 : 0 } }]); }
  disconnect() { this.disconnected = true; }
};
const makeContainer = () => ({ clientWidth: 400, clientHeight: 280, innerHTML: '', appendChild() {} });
const hookReact = {
  ...require('react'),
  memo: (component, compare) => { component.compare = compare; return component; },
  useRef: initial => { const i = current.index++; return current.slots[i] ??= { current: i === 0 ? current.container : initial }; },
  useState: initial => {
    const owner = current, i = owner.index++;
    if (!(i in owner.slots)) owner.slots[i] = initial;
    return [owner.slots[i], value => { owner.updates++; owner.slots[i] = typeof value === 'function' ? value(owner.slots[i]) : value; }];
  },
  useEffect: (effect, deps) => {
    const owner = current, i = owner.index++, old = owner.slots[i];
    if (!old || deps.some((value, index) => value !== old.deps[index])) owner.effects.push(() => {
      old?.cleanup?.(); owner.slots[i] = { deps, cleanup: effect() };
    });
  },
};
class Renderer {
  constructor() { this.renders = 0; this.disposed = 0; this.shadowMap = {}; this.sizes = []; this.domElement = { style: {}, remove() {} }; renderers.push(this); }
  setSize(...args) { this.sizes.push(args); } setPixelRatio(value) { this.pixelRatio = value; } render() { this.renders++; } dispose() { this.disposed++; }
}
class Controls {
  constructor() { this.target = new THREE.Vector3(); this.listeners = new Set(); controls.push(this); }
  addEventListener(_, fn) { this.listeners.add(fn); } removeEventListener(_, fn) { this.listeners.delete(fn); }
  update() { return false; } dispose() { this.disposed = true; }
}
global.ResizeObserver = class { constructor(fn) { this.fn = fn; observers.push(this); } observe(target) { this.target = target; } emit(width, height) { this.fn([{ target: this.target, contentRect: { width, height } }]); } disconnect() { this.disconnected = true; } };
const originalLoad = Module._load;
Module._load = function(request, parent, main) {
  if (request === 'react') return { ...hookReact, default: hookReact, __esModule: true };
  if (request === 'three') return { ...THREE, WebGLRenderer: Renderer };
  if (request.includes('/controls/OrbitControls.js')) return { OrbitControls: Controls };
  if (request.endsWith('/model3dUtils')) return {
    isPreviewable3DFile: () => true,
    load3DModel: (url, ext, progress) => new Promise((resolve, reject) => pendingLoads.push({ url, resolve, reject, progress })),
  };
  if (request.endsWith('/language-store')) return { useTranslation: () => ({ t: key => key }) };
  if (request.endsWith('/docUtils')) return { formatBytes: String };
  return originalLoad.call(this, request, parent, main);
};
const { Model3DCanvasCard } = require('../components/cards/Model3DCanvasCard.tsx');
Module._load = originalLoad;
function instance(component, props, visible = true) {
  const owner = { slots: [], container: makeContainer(), updates: 0, effects: [], index: 0 };
  owner.render = next => {
    if (next) props = next;
    current = owner; owner.index = 0; owner.effects = [];
    owner.tree = component(props); current = null;
    owner.effects.forEach(fn => fn());
    intersections.filter(observer => observer.target === owner.container && !observer.disconnected).forEach(observer => observer.emit(visible));
    return owner.tree;
  };
  owner.unmount = () => owner.slots.forEach(slot => slot?.cleanup?.());
  owner.render(); return owner;
}
function find(node, predicate) {
  if (!node || typeof node !== 'object') return;
  if (predicate(node)) return node;
  for (const child of [node.props?.children].flat(Infinity)) { const hit = find(child, predicate); if (hit) return hit; }
}
const element = { id: '3d', type: 'model3d', name: 'model', width: 400, height: 320, fileUrl: 'one.glb', fileExtension: 'glb', autoRotate: false };
const props = { element, isSelected: false };
const result = object => ({ object, animations: [], stats: { vertexCount: 16, triangleCount: 4, meshCount: 2 } });
(async () => {
  const card = instance(Model3DCanvasCard, props);
  const first = pendingLoads.shift();
  card.render({ ...props, element: { ...element, fileUrl: 'two.glb' } });
  assert.equal(renderers[0].disposed, 1); assert.equal(controls[0].disposed, true);
  const updates = card.updates;
  const before = { ...counts };
  first.progress(90); first.resolve(result(objectWithResources())); await Promise.resolve();
  assert.equal(card.updates, updates, 'stale load cannot write React state');
  assert.equal(counts.geometry, before.geometry + 1, 'stale result disposed');
  const second = pendingLoads.shift(); second.resolve(result(objectWithResources())); await Promise.resolve();
  step(); assert.equal(frames.size, 0, 'actual static card stops');
  controls.at(-1).listeners.forEach(fn => fn()); step(); assert.equal(frames.size, 0, 'orbit change wakes one settled render');
  const inlineRenderer = renderers.at(-1), inlineObserver = observers.at(-1);
  const initialSizes = inlineRenderer.sizes.length;
  for (let i = 0; i < 100; i++) inlineObserver.emit(400, 280);
  assert.equal(inlineRenderer.sizes.length, initialSizes, '100 unchanged resize notifications perform zero buffer resizes');
  inlineObserver.emit(520, 330); inlineObserver.emit(520, 330); inlineObserver.emit(0, 0);
  assert.equal(inlineRenderer.sizes.length, initialSizes + 1, 'one actual content resize reallocates once');
  assert.deepEqual(inlineRenderer.sizes.at(-1), [520, 330, false], 'resize cannot write layout dimensions');
  assert.equal(inlineRenderer.domElement.style.width, '100%');
  const rendererCount = renderers.length;
  assert(Model3DCanvasCard.compare(props, { ...props, element: { ...element, x: 99, y: 42 } }), 'position-only updates skip card React render');
  assert(!Model3DCanvasCard.compare(props, { ...props, element: { ...element, name: 'changed' } }));
  assert(!Model3DCanvasCard.compare(props, { ...props, isSelected: true }));
  assert(!Model3DCanvasCard.compare(props, { ...props, onUpdate() {} }));
  assert.equal(renderers.length, rendererCount, 'rerender does not recreate renderer');
  card.render();
  find(card.tree, node => node.props?.title === 'model3d.fullscreen').props.onClick({ stopPropagation() {} });
  card.render();
  const modalNode = find(card.tree, node => typeof node.type === 'function' && node.props?.fileUrl);
  assert(modalNode, 'fullscreen remains mounted through existing UI');
  const modal = instance(modalNode.type, modalNode.props);
  const modalLoad = pendingLoads.shift();
  const animatedObject = objectWithResources();
  const clip = new THREE.AnimationClip('move', 1, [new THREE.NumberKeyframeTrack('.position[x]', [0, 1], [0, 1])]);
  modalLoad.resolve({ ...result(animatedObject), animations: [clip] }); await Promise.resolve(); step(); step();
  assert(animatedObject.position.x > 0, 'fullscreen model animation updates');
  assert.equal(frames.size, 1, 'model animation continues with auto rotation disabled');
  const modalSizeCount = renderers.at(-1).sizes.length;
  observers.at(-1).emit(400, 280); observers.at(-1).emit(600, 420); observers.at(-1).emit(600, 420);
  assert.equal(renderers.at(-1).sizes.length, modalSizeCount + 1, 'modal uses identical deduplicated size path');
  const modalVisibility = intersections.at(-1);
  modalVisibility.emit(false);
  const pausedPosition = animatedObject.position.x;
  step(); step(); assert.equal(animatedObject.position.x, pausedPosition, 'offscreen animation does no updates');
  time += 10000; modalVisibility.emit(true); step();
  assert.equal(animatedObject.position.x, pausedPosition, 'animation resumes with zero delta');
  step(); assert(animatedObject.position.x > pausedPosition);
  const modalRendererCount = renderers.length;
  modal.render({ ...modalNode.props, autoRotate: true, wireframe: true }); step(); step();
  assert.equal(renderers.length, modalRendererCount, 'modal setting changes do not reload scene');
  assert.equal(frames.size, 1, 'modal auto rotation remains continuous');
  modal.unmount(); card.unmount();
  assert.equal(frames.size, 0); assert.equal(visibility.size, 0);
  assert(observers.every(observer => observer.disconnected));
  assert(controls.every(control => control.disposed));
  assert(renderers.every(renderer => renderer.disposed === 1));
  // Loading after modal close must also be discarded and freed.
  const lateModal = instance(modalNode.type, modalNode.props);
  const late = pendingLoads.shift(); lateModal.unmount();
  const priorUpdates = lateModal.updates; const priorGeometry = counts.geometry;
  late.resolve(result(objectWithResources())); await Promise.resolve();
  assert.equal(lateModal.updates, priorUpdates); assert.equal(counts.geometry, priorGeometry + 1);
  // Same default settings as imported cards: no explicit autoRotate override.
  const defaultElement = { ...element }; delete defaultElement.autoRotate;
  const fleet = Array.from({ length: 12 }, (_, i) => instance(Model3DCanvasCard, { ...props, element: { ...defaultElement, id: `fleet-${i}` } }, false));
  const fleetRenderers = renderers.slice(-12), fleetVisibility = intersections.slice(-12);
  for (let i = 0; i < 12; i++) pendingLoads.shift().resolve(result(objectWithResources()));
  await Promise.resolve();
  assert.equal(frames.size, 0, '12 offscreen default rotating models never queue frames');
  fleetVisibility[0].emit(true); fleetVisibility[1].emit(true);
  fleetVisibility[0].fn([{ target: fleetVisibility[0].target, isIntersecting: true, intersectionRect: { width: 0, height: 280 } }]);
  assert.equal(frames.size, 2, 'edge contact must wake: threshold zero need not notify again when area becomes positive');
  const beforeFleetRenders = fleetRenderers.map(renderer => renderer.renders);
  for (let i = 0; i < 10; i++) step();
  const fleetCounts = fleetRenderers.map((renderer, i) => renderer.renders - beforeFleetRenders[i]);
  assert.deepEqual(fleetCounts, [10, 10, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  assert.equal(frames.size, 2, 'visible defaults still rotate at unchanged RAF cadence');
  fleetVisibility.forEach(observer => observer.emit(false));
  assert.equal(frames.size, 0, 'leaving screen cancels pending frames immediately');
  fleet.forEach(card => card.unmount());
  assert(intersections.every(observer => observer.disconnected));
  console.log('OPERATIONS: 12 default-rotating models x 10 frames, 2 visible: renders=20, offscreen renders=0; 100 same-size notifications: setSize=0; one changed size: setSize=1');
  console.log('PASS model3d: demand frames, damping, rotation/animation scheduling, visibility, covered viewport, memo boundary, stale loads, modal settings, GPU/control/observer cleanup');
})().catch(error => { console.error(error); process.exitCode = 1; });
