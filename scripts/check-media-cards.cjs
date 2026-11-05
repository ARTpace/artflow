const assert = require('node:assert/strict');
require('./register-typescript.cjs');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const { AudioCanvasPlayer } = require('../components/AudioCanvasPlayer.tsx');
const { AudioCanvasCard } = require('../components/cards/AudioCanvasCard.tsx');
const { VideoCanvasCard } = require('../components/cards/VideoCanvasCard.tsx');
const element = { id: 'media', name: 'Quiet track.mp3', href: 'blob:local-media', width: 320, height: 120, duration: 90 };
const walk = node => !node || typeof node !== 'object' ? [] : [node, ...React.Children.toArray(node.props?.children).flatMap(walk)];
const events = ['onPointerDown', 'onPointerMove', 'onPointerUp', 'onMouseDown', 'onMouseMove', 'onMouseUp', 'onTouchStart', 'onTouchMove', 'onTouchEnd', 'onClick', 'onDoubleClick', 'onWheel', 'onKeyDown', 'onKeyUp'];
const assertIsolated = node => {
  for (const name of events) {
    let stopped = 0;
    node.props[name]({ stopPropagation() { stopped++; } });
    assert.equal(stopped, 1, name);
  }
};
const audioMarkup = renderToStaticMarkup(React.createElement(AudioCanvasCard, { element, isSelected: true }));
for (const text of ['data-selected="true"', 'preload="none"', 'Quiet track.mp3', '播放进度', '音量', '切换播放倍速', '循环播放', '静音']) assert.ok(audioMarkup.includes(text), text);
for (const text of ['data-card-header', 'animate-', 'vinyl', 'bg-gradient', '<img']) assert.ok(!audioMarkup.includes(text), text);
assert.equal(AudioCanvasCard({ element, isSelected: true }).props.isSelected, true);
const video = VideoCanvasCard({ element, isSelected: true, croppingState: { elementId: 'other' } });
const videoNodes = walk(video);
const player = videoNodes.find(node => node.type === 'video');
const handle = videoNodes.find(node => node.props['data-video-drag-handle'] !== undefined);
assert.equal(player.props.controls, true);
assert.equal(player.props.preload, 'none');
assert.equal(player.props.className, 'opacity-30');
assert.equal(player.props.style.borderRadius, '8px');
assert.equal(video.props['data-selected'], true);
assert.equal(handle.props.tabIndex, 0);
assert.equal(handle.props.style.touchAction, 'none');
assertIsolated(player);
for (const name of ['onMouseDown', 'onTouchStart', 'onPointerDown']) {
  assert.equal(video.props[name], undefined, 'root must not block dragging');
  assert.equal(handle.props[name], undefined, 'handle must bubble dragging');
}
const videoMarkup = renderToStaticMarkup(video);
assert.ok(!videoMarkup.includes('data-card-header'));
assert.ok(videoMarkup.includes('移动视频'));

// Exercise keyboard delegation without a DOM/browser: exact gesture dispatched to the existing host.
const savedMouseEvent = global.MouseEvent;
const savedWindow = global.window;
try {
  global.window = {};
  global.MouseEvent = class { constructor(type, options) { this.type = type; Object.assign(this, options); } };
  const dispatched = [];
  const svg = { dispatchEvent: event => dispatched.push(event) };
  const target = { closest: () => svg, getBoundingClientRect: () => ({ left: 10, top: 20, width: 64, height: 24 }), dispatchEvent: event => dispatched.push(event) };
  let prevented = 0;
  handle.props.onKeyDown({ key: 'ArrowRight', shiftKey: true, currentTarget: target, stopPropagation() {}, preventDefault() { prevented++; } });
  assert.equal(prevented, 1);
  assert.deepEqual(dispatched.map(event => event.type), ['mousedown', 'mousemove', 'mouseup']);
  assert.equal(dispatched[1].clientX - dispatched[0].clientX, 30);
  assert.equal(dispatched[1].clientY, dispatched[0].clientY);
  handle.props.onKeyDown({ key: 'Delete', currentTarget: target, stopPropagation() {}, preventDefault() { throw Error('unhandled key'); } });
  assert.equal(dispatched.length, 3);
} finally {
  if (savedMouseEvent === undefined) delete global.MouseEvent; else global.MouseEvent = savedMouseEvent;
  if (savedWindow === undefined) delete global.window; else global.window = savedWindow;
}

// Existing hook-harness pattern keeps media handler coverage dependency-free.
const originals = { useState: React.useState, useRef: React.useRef, useEffect: React.useEffect };
let states = [], stateCursor = 0, refs = [], refCursor = 0, effects = [];
React.useState = initial => { const index = stateCursor++; if (!(index in states)) states[index] = initial; return [states[index], value => { states[index] = value; }]; };
React.useRef = initial => { const index = refCursor++; return refs[index] ||= { current: initial }; };
React.useEffect = callback => { effects.push(callback); };
const renderAudio = () => { stateCursor = 0; refCursor = 0; effects = []; return AudioCanvasPlayer({ element, isSelected: true }); };
const event = { stopPropagation() {} };
(async () => {
  try {
    let tree = renderAudio();
    const controls = walk(tree).find(node => node.props['data-audio-controls'] !== undefined);
    assertIsolated(controls);
    for (const name of events) assert.equal(tree.props[name], undefined, 'non-control content stays draggable');
    const listeners = {};
    let played = 0, paused = 0;
    const audio = { currentTime: 0, duration: 90, play: () => { played++; return Promise.resolve(); }, pause: () => paused++, addEventListener: (name, fn) => { listeners[name] = fn; }, removeEventListener: name => { delete listeners[name]; } };
    refs[0].current = audio;
    refs[1].current = { value: '', style: {} };
    refs[2].current = { textContent: '' };
    const cleanup = effects[0]();
    const byLabel = label => walk(tree).find(node => node.props['aria-label'] === label);
    byLabel('播放').props.onClick(event);
    await Promise.resolve();
    tree = renderAudio();
    assert.equal(played, 1);
    byLabel('暂停').props.onClick(event);
    assert.equal(paused, 1);
    byLabel('播放进度').props.onChange({ ...event, target: { value: '25' } });
    assert.equal(audio.currentTime, 25);
    assert.equal(refs[2].current.textContent, '0:25');
    byLabel('切换播放倍速').props.onClick(event);
    assert.equal(audio.playbackRate, 1.25);
    byLabel('循环播放').props.onClick(event);
    assert.equal(audio.loop, true);
    byLabel('音量').props.onChange({ ...event, target: { value: '0.4' } });
    assert.equal(audio.volume, 0.4);
    tree = renderAudio();
    byLabel('静音').props.onClick(event);
    assert.equal(audio.muted, true);
    tree = renderAudio();
    assert.equal(byLabel('音量').props.value, 0);
    byLabel('取消静音').props.onClick(event);
    assert.equal(audio.muted, false);
    audio.currentTime = 42;
    listeners.timeupdate();
    assert.equal(refs[2].current.textContent, '0:42');
    cleanup();
    assert.equal(Object.keys(listeners).length, 0);
  } finally { Object.assign(React, originals); }
  console.log('media-cards: SSR, selected state, lazy native video, crop dimming, control isolation, passive drag areas, keyboard gesture delegation and retained audio controls passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
