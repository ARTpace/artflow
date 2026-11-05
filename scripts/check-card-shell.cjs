const assert = require('node:assert/strict');
require('./register-typescript.cjs');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const { CanvasCardShell } = require('../components/cards/CanvasCardShell.tsx');
const { BookmarkCanvasCard } = require('../components/cards/BookmarkCanvasCard.tsx');
const { OnlineVideoCard } = require('../builtin-plugins/online-video/OnlineVideoCard.tsx');

const shell = CanvasCardShell({
  header: 'Header', actions: React.createElement('button', null, 'Action'), interactiveContent: true,
  children: 'Body', footer: 'Footer', className: 'custom-root', style: { borderRadius: 17 },
  headerClassName: 'custom-header', headerStyle: { height: 40 }, contentClassName: 'custom-content',
});
const [header, content] = React.Children.toArray(shell.props.children).filter(node => node?.props?.['data-card-header'] !== undefined || node?.props?.['data-card-content'] !== undefined);
const actions = React.Children.toArray(header.props.children).find(node => node?.props?.['data-card-actions'] !== undefined);
assert.ok(shell.props.className.includes('w-full h-full'));
assert.ok(shell.props.className.includes('custom-root'));
assert.equal(shell.props.style.borderRadius, 17);
assert.equal(header.props.style.height, 40);
for (const name of ['onPointerDown', 'onMouseDown', 'onTouchStart']) {
  assert.equal(header.props[name], undefined, 'title bar must keep bubbling for canvas dragging');
  for (const region of [actions, content]) {
    let stopped = 0;
    region.props[name]({ stopPropagation() { stopped++; } });
    assert.equal(stopped, 1, name);
  }
}
for (const name of ['onDoubleClick', 'onWheel', 'onKeyDown', 'onKeyUp']) {
  let stopped = false;
  content.props[name]({ stopPropagation() { stopped = true; } });
  assert.ok(stopped, name);
}
const bookmark = Object.freeze({ url: 'https://example.com/page', title: 'Saved page', description: 'Unique description' });
const bookmarkMarkup = renderToStaticMarkup(React.createElement(BookmarkCanvasCard, { element: bookmark }));
for (const text of ['data-canvas-card-shell', 'data-card-header', 'data-card-actions', 'data-card-content', 'WEB LINK', 'example.com', 'Saved page', 'Unique description', 'HTTPS READY', 'BOOKMARK', '复制网址', '访问', '--bp-card-accent-bookmark', 'p-3']) assert.ok(bookmarkMarkup.includes(text), text);
for (const sourceUrl of ['https://www.bilibili.com/video/BV1B7411m7LV', 'https://b23.tv/abc123', 'https://youtu.be/dQw4w9WgXcQ', 'https://cdn.example.com/a.mp4']) {
  const markup = renderToStaticMarkup(React.createElement(OnlineVideoCard, { element: { data: { sourceUrl, playerUrl: 'https://evil.test' } } }));
  assert.ok(markup.includes('data-canvas-card-shell'));
  assert.ok(!markup.includes('height:40px'), 'media must not reserve a title bar');
  assert.ok(markup.includes('absolute top-2 left-2 right-2'), 'media chrome stays inside the content top');
  assert.ok(markup.includes('data-online-video-drag-handle'));
  assert.ok(markup.includes('group-focus-within/online-video:opacity-100'));
  assert.ok(markup.includes('group-focus-within/online-video:pointer-events-auto'));
  assert.ok(markup.includes('pointer-events-none opacity-0'), 'hidden controls must not block the player');
  assert.ok(markup.includes('[@media(hover:none)]:opacity-100'));
  assert.ok(markup.includes('aria-label="打开视频原网页"'));
  assert.ok(markup.includes('加载播放器'));
  assert.ok(markup.includes('<svg'));
  assert.ok(!/[🔗↗✓×]/u.test(markup), 'tool icons must use SVG rather than text glyphs');
  assert.ok(!markup.includes('<iframe') && !markup.includes('<video'));
  assert.ok(!markup.includes('evil.test'));
}

// Small hook harness: exercise retained handlers without a browser or renderer dependency.
const originalState = React.useState;
const originalEffect = React.useEffect;
const originalWindow = global.window;
let states = [], cursor = 0;
React.useState = initial => {
  const index = cursor++;
  if (!(index in states)) states[index] = initial;
  return [states[index], value => { states[index] = value; }];
};
React.useEffect = () => {};
const buttons = tree => React.Children.toArray(tree.props.actions.props.children);
const loadButton = card => React.Children.toArray(React.Children.toArray(card.props.children)[0].props.children).find(node => node.type === 'button');
const renderVideo = (sourceUrl, isSelected = false) => { cursor = 0; return OnlineVideoCard({ element: { data: { sourceUrl } }, isSelected }); };
(async () => {
  try {
    let resolved = 0, opened = '';
    const source = 'https://b23.tv/abc123';
    global.window = { artflowApp: {
      resolveVideoShortUrl: async url => { assert.equal(url, source); resolved++; return 'https://www.bilibili.com/video/BV1B7411m7LV'; },
      openVideoLink: async url => { opened = url; },
    } };
    let card = renderVideo(source);
    assert.equal(card.type, CanvasCardShell);
    assert.equal(resolved, 0);
    await buttons(card).at(-1).props.onClick();
    assert.equal(opened, source);
    assert.equal(card.props.variant, 'media');
    const mediaShell = CanvasCardShell(card.props);
    const mediaHeader = React.Children.toArray(mediaShell.props.children).find(node => node?.props?.['data-card-header'] !== undefined);
    const mediaActions = React.Children.toArray(mediaHeader.props.children).find(node => node?.props?.['data-card-actions'] !== undefined);
    assert.ok(mediaHeader.props.className.includes('pointer-events-none'));
    assert.ok(card.props.header.props.className.includes('pointer-events-auto'));
    assert.equal(card.props.header.props.onPointerDown, undefined, 'content handle must bubble to the canvas');
    for (const name of ['onPointerDown', 'onMouseDown', 'onTouchStart', 'onDoubleClick', 'onKeyDown', 'onKeyUp']) {
      let stopped = false;
      mediaActions.props[name]({ stopPropagation() { stopped = true; } });
      assert.ok(stopped, `media actions isolate ${name}`);
    }
    assert.ok(renderVideo(source, true).props.actionsClassName.endsWith('opacity-100'), 'selected card exposes controls');
    await loadButton(card).props.onClick();
    assert.equal(resolved, 1);
    card = renderVideo(source);
    assert.equal(React.Children.toArray(card.props.children)[0].type, 'iframe');
    assert.equal(buttons(card)[0].props['aria-label'], '停止播放');
    assert.equal(buttons(card)[0].props.children.type, 'svg');
    buttons(card)[0].props.onClick();
    card = renderVideo(source);
    assert.ok(!renderToStaticMarkup(card).includes('<iframe'));
    states = [];
    card = renderVideo('https://cdn.example.com/a.mp4');
    await loadButton(card).props.onClick();
    card = renderVideo('https://cdn.example.com/a.mp4');
    assert.equal(React.Children.toArray(card.props.children)[0].type, 'video');
    cursor = 0; states = [];
    const bookmarkCard = BookmarkCanvasCard({ element: bookmark });
    assert.equal(bookmarkCard.type, CanvasCardShell);
    assert.equal(buttons(bookmarkCard).length, 2);
    const passiveShell = CanvasCardShell(bookmarkCard.props);
    const passiveHeader = React.Children.toArray(passiveShell.props.children).find(node => node?.props?.['data-card-header'] !== undefined);
    assert.ok(!passiveHeader.props.className.includes('absolute'), 'bookmark retains its normal-flow header');
    const passiveContent = React.Children.toArray(passiveShell.props.children).find(node => node?.props?.['data-card-content'] !== undefined);
    for (const name of ['onPointerDown', 'onMouseDown', 'onTouchStart', 'onDoubleClick', 'onWheel', 'onKeyDown', 'onKeyUp']) {
      assert.equal(passiveContent.props[name], undefined, `bookmark must retain canvas gestures: ${name}`);
    }
    assert.equal(card.props.interactiveContent, true, 'video must isolate player gestures');
  } finally {
    React.useState = originalState;
    React.useEffect = originalEffect;
    if (originalWindow === undefined) delete global.window;
    else global.window = originalWindow;
  }
  console.log('card-shell: shared chrome, drag/event boundaries, bookmark content, lazy playback, short-link load, stop and external open passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
