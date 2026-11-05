const assert = require('node:assert/strict');
require('./register-typescript.cjs');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const { ElementToolbar } = require('../components/ElementToolbar.tsx');
const { ToolbarOverlay } = require('../components/ToolbarOverlay.tsx');
let called = '';
const props = { zoom: 1, t: key => key, handleCopyElement: () => called = 'copy', handleDownloadImage: () => called = 'download', handleStartCrop: () => called = 'crop', handleDeleteElement: () => called = 'delete', handlePropertyChange: () => {}, handleFrameAspectRatioChange: () => {}, handleUngroup: () => {}, handleMergeGroup: () => {} };
const walk = (node, result = []) => { if (!React.isValidElement(node)) return result; result.push(node); React.Children.forEach(node.props.children, child => walk(child, result)); return result; };
for (const type of ['image', 'video', 'audio']) {
  const element = { id: type, type, x: 50, y: 60, width: 400, height: 240, href: 'https://example.com/media' };
  const tree = ElementToolbar({ ...props, element });
  assert.equal(tree.props['data-media-toolbar'], true);
  for (const name of ['onPointerDown', 'onMouseDown', 'onTouchStart', 'onWheel', 'onKeyDown', 'onKeyUp']) {
    let stopped = false; tree.props[name]({ stopPropagation() { stopped = true; } }); assert.ok(stopped);
  }
  const nodes = walk(tree);
  for (const action of ['copy', 'delete', ...(type === 'image' ? ['download', 'crop'] : [])]) {
    const button = nodes.find(node => node.type === 'button' && node.props.title === `contextMenu.${action}`);
    button.props.onClick(); assert.equal(called, action);
  }
  if (type === 'image') assert.ok(nodes.some(node => node.type === 'details'));
  const markup = renderToStaticMarkup(tree); assert.ok(!markup.includes('shadow-2xl'));
  for (const zoom of [0.1, 1, 3]) {
    const overlay = ToolbarOverlay({ ...props, zoom, elements: [element], selectedElementIds: [element.id], singleSelectedElement: element });
    assert.equal(overlay.type, 'foreignObject');
    assert.ok(overlay.props.x >= element.x && overlay.props.y >= element.y);
    assert.ok(overlay.props.x + overlay.props.width <= element.x + element.width);
    assert.ok(overlay.props.y + overlay.props.height <= element.y + element.height);
  }
}
console.log('media-toolbar: inside-media placement, zoom, actions and event isolation passed');
