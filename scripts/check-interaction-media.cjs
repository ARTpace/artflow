// Run from project root: node scripts/check-interaction-media.cjs
require('./register-typescript.cjs');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const { resolveImageLODSource, IMAGE_LOD_CONSTANTS } = require('../utils/imageProxy.ts');
let cases = 0;
for (const zoom of [0.05, 0.249, 0.25, 0.5, 1, 1.001, 2]) {
  for (const thumbnailHref of [undefined, 'thumb']) {
    for (const originalHref of [undefined, 'original']) {
      for (const isInteracting of [false, true]) {
        for (const isHighResAdmitted of [false, true]) {
          const options = { zoom, thumbnailHref, originalHref, isInteracting, isHighResAdmitted, href: 'standard' };
          const actual = resolveImageLODSource(options);
          const expected = zoom < 0.25 && thumbnailHref ? 'thumb'
            : !isInteracting && zoom > 1 && originalHref && isHighResAdmitted ? 'original' : 'standard';
          assert.equal(actual.src, expected, JSON.stringify(options));
          if (isInteracting) assert.notEqual(actual.tier, 'original');
          cases++;
        }
      }
    }
  }
}
assert.equal(IMAGE_LOD_CONSTANTS.HIGH_RES_IDLE_DELAY_MS, 180);
const { AudioCanvasPlayer } = require('../components/AudioCanvasPlayer.tsx');
const audio = renderToStaticMarkup(React.createElement(AudioCanvasPlayer, {
  element: { id: 'audio-test', type: 'audio', href: 'test.mp3', x: 0, y: 0, width: 300, height: 200, mimeType: 'audio/mpeg', duration: 60 },
}));
assert.match(audio, /<audio[^>]*preload="none"/);
assert.match(audio, /src="test.mp3"/);
// Source guard complements the existing foundation suite. This is not a browser playback test.
// The video markup moved out of CanvasElement.tsx into cards/VideoCanvasCard.tsx with the card split;
// the preload="none" contract follows it, and the stale comparator guard is still asserted at CanvasElement.
const canvas = fs.readFileSync(path.join(__dirname, '../components/CanvasElement.tsx'), 'utf8');
const videoCard = fs.readFileSync(path.join(__dirname, '../components/cards/VideoCanvasCard.tsx'), 'utf8');
assert.match(videoCard, /<video[^>]*preload="none"[^>]*controls/);
assert.doesNotMatch(canvas, /prev\.element\.type === 'image' && !next\.isInteracting/);
// P0-1 contract: a downgrade must follow "this element is really being transformed",
// not "the mouse button is down". Source guards only - the behavioural proof lives in
// the browser probe (drag one element, the rest must keep their hi-res texture).
const canvasInteractions = fs.readFileSync(path.join(__dirname, '../hooks/useCanvasInteractions.ts'), 'utf8');
const mainCanvas = fs.readFileSync(path.join(__dirname, '../components/MainCanvas.tsx'), 'utf8');
const contentInteraction = fs.readFileSync(path.join(__dirname, '../utils/content-interaction-store.ts'), 'utf8');
// Registering is gated on the same visible-movement threshold as "the element really got dragged".
assert.match(canvasInteractions, /Math\.hypot\(dx, dy\) \* zoom >= DRAG_MOVED_MIN_SCREEN_PX\)[\s\S]{0,80}refreshContentInteraction\(/);
// Resize/rotate have no displacement, so they register on the first real geometry change.
// P1-1 note: the literal "if (angleDiff !== 0) refreshContentInteraction(...)" is gone - the
// same guard is now expressed as "publish nothing when the geometry did not really change",
// and the downgrade must still happen *before* the frame goes out on the transient channel.
// The contract asserted here is therefore: real change -> downgrade -> publish preview.
assert.match(
  canvasInteractions,
  /if \(preview === originalElement\) return;[\s\S]{0,140}refreshContentInteraction\(\[originalElement\.id\]\)[\s\S]{0,80}publishGesturePreview\(preview\)/,
);
assert.match(
  canvasInteractions,
  /if \(scaleX === 1 && scaleY === 1\) return;[\s\S]{0,140}refreshContentInteraction\(\[originalElement\.id\]\)[\s\S]{0,240}publishGesturePreview\(resolveResizedElement\(/,
);
// Session end / cancel must clear the set so every element returns to its own tier.
assert.match(canvasInteractions, /contentInteractionStore\?\.end\(\)/);
// Render side decides per element; only a missing store falls back to the old global boolean.
assert.match(mainCanvas, /contentInteractionStore[\s\S]{0,90}Boolean\(contentInteractingIds\?\.has\(el\.id\)\)[\s\S]{0,60}: isInteracting/);
// Re-announcing the same id set every frame must not notify (one notify = whole board re-tier).
assert.match(contentInteraction, /if \(isSameIdSet\(elementIds, next\)\) return;/);
console.log(`interaction media checks: ok (${cases} LOD cases, audio SSR, video/comparator guards, P0-1 downgrade scoping guards)`);
