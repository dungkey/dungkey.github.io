import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

const threeUrl = new URL('../vendor/three/three.module.min.js', import.meta.url).href;
const addonsBase = new URL('../vendor/three/addons/', import.meta.url).href;
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'three') return { url: threeUrl, shortCircuit: true };
    if (specifier.startsWith('three/addons/')) {
      return { url: addonsBase + specifier.slice('three/addons/'.length), shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});

const { BookViewer3D } = await import('../src/bookViewer3D.js');
const { BookTransitionRig, buildGeometry, buildMaterials, textures } = await import('../src/bookMesh.js');
const { computeBookThickness, stripHtml, parseZipDirectory } = await import('../src/epub.js');
const THREE = await import('three');

let savedProgress = null;
const viewer = new BookViewer3D({
  onProgressChange: (_book, progress) => {
    savedProgress = progress;
  },
});

viewer.isOpen = true;
viewer.contentReady = true;
viewer.activeBook = {
  id: 'book-test',
  title: '测试书名',
  chapters: [
    { title: '第一章 开始', inToc: true, paragraphs: ['第一段<em>强调</em>文字。', '第二段文字。'] },
    { title: '第二章 经过', inToc: true, paragraphs: ['第二章内容。'] },
  ],
};

viewer.prepareBookMetadata(viewer.activeBook);
assert.equal(viewer.toc.length, 2);
assert.equal(viewer.toc[0].title, '第一章 开始');
assert.equal(viewer.toc[0].excerpt, '第一段强调文字。');

viewer.currentChapter = 0;
viewer.currentSpread = 0;
viewer.chapterSpreadCount = 3;
viewer.spreadStride = 600;
let flipDirs = [];
viewer.hudFlipStage = { classList: { remove() {}, add() {} }, replaceChildren() {} };
viewer.hudTrack = { style: {}, children: [], cloneNode: () => ({ style: {} }) };
viewer.runPageFlipAnimation = (dir) => { flipDirs.push(dir); };

viewer.flipNext();
assert.equal(viewer.currentSpread, 1);
assert.equal(flipDirs[0], 1);
assert.ok(savedProgress && savedProgress.chapterIndex === 0);
assert.ok(savedProgress.ratio > 0 && savedProgress.ratio < 1);

viewer.flipPrev();
assert.equal(viewer.currentSpread, 0);
assert.equal(flipDirs[1], -1);

viewer.flipRaf = 99;
viewer.flipNext();
assert.equal(viewer.currentSpread, 0);
assert.equal(flipDirs.length, 2);
viewer.flipRaf = 0;
let chapterTarget;
let animatedSpread;
viewer.loadChapter = (chapterIndex, offset) => {
  chapterTarget = [chapterIndex, offset];
  viewer.currentChapter = chapterIndex;
  viewer.currentSpread = offset === Infinity ? 2 : 0;
};
viewer.runPageFlipAnimation = (_direction, _track, spread) => { animatedSpread = spread; };
viewer.currentSpread = 2;
viewer.flipNext();
assert.deepEqual(chapterTarget, [1, 0]);
assert.equal(animatedSpread, 2);
viewer.flipPrev();
assert.deepEqual(chapterTarget, [0, Infinity]);
assert.equal(animatedSpread, 0);

class FlipNode {
  constructor() {
    this.style = {};
    this.children = [];
    this.className = '';
    this.classList = { add() {}, remove() {} };
  }
  append(...nodes) { this.children.push(...nodes); }
  appendChild(node) { this.append(node); }
  replaceChildren(...nodes) { this.children = nodes; }
  cloneNode() {
    const node = new FlipNode();
    node.style = { ...this.style };
    node.className = this.className;
    node.children = this.children.map((child) => child.cloneNode(true));
    return node;
  }
  querySelectorAll(selector) {
    return this.children.flatMap((child) => [
      ...(child.className.split(' ').includes(selector.slice(1)) ? [child] : []),
      ...child.querySelectorAll(selector),
    ]);
  }
}

const rafCallbacks = new Map();
let rafId = 0;
globalThis.document = {
  createElement: () => new FlipNode(),
  createDocumentFragment: () => new FlipNode(),
};
globalThis.requestAnimationFrame = (callback) => {
  rafCallbacks.set(++rafId, callback);
  return rafId;
};
globalThis.cancelAnimationFrame = (id) => rafCallbacks.delete(id);
const animationViewer = Object.create(BookViewer3D.prototype);
animationViewer.hudSheet = {
  clientWidth: 1000,
  clientHeight: 700,
  getBoundingClientRect: () => ({ left: 0, top: 0, width: 950 }),
};
animationViewer.hudViewport = {
  getBoundingClientRect: () => ({ left: 76, top: 57, width: 798, height: 570 }),
};
animationViewer.hudTrack = new FlipNode();
animationViewer.hudFlipStage = new FlipNode();
animationViewer.colW = 390;
animationViewer.colGap = 60;
animationViewer.viewH = 600;
animationViewer.spreadStride = 900;
animationViewer.currentSpread = 0;
for (const columns of [1, 2]) {
  animationViewer.colsPerSpread = columns;
  for (const direction of [-1, 1]) {
    const oldTrack = new FlipNode();
    animationViewer.runPageFlipAnimation(direction, oldTrack, 3);
    const leaf = animationViewer.hudFlipStage.children[0].children.at(-1);
    assert.equal(leaf.children.length, 12);
    assert.equal(leaf.style.transform, `rotateY(${columns === 1 && direction < 0 ? -180 : 0}deg)`);
    assert.ok(oldTrack.style.transform.includes(String(-3 * 900)) ||
      oldTrack.style.transform.includes(String(-(3 * 900 + 450))));
    assert.equal(animationViewer.hudFlipStage.querySelectorAll('.hud-flip-window')[0].style.top, '60px');
    let callback = rafCallbacks.get(animationViewer.flipRaf);
    rafCallbacks.delete(animationViewer.flipRaf);
    callback(performance.now() + 300);
    assert.ok(leaf.children.some((strip) => !strip.style.transform.includes('rotateY(0deg)')));
    callback = rafCallbacks.get(animationViewer.flipRaf);
    rafCallbacks.delete(animationViewer.flipRaf);
    callback(performance.now() + 1000);
    assert.equal(animationViewer.flipRaf, 0);
    assert.equal(animationViewer.hudFlipStage.children.length, 0);
    animationViewer.runPageFlipAnimation(direction, new FlipNode(), 0);
    animationViewer.stopPageFlipAnimation();
    assert.equal(rafCallbacks.size, 0);
  }
}
delete globalThis.document;
delete globalThis.requestAnimationFrame;
delete globalThis.cancelAnimationFrame;

assert.equal(stripHtml('<p>Hello <strong>World</strong> &amp; Friends</p>'), 'Hello World & Friends');
assert.ok(computeBookThickness(300) >= 0.09 && computeBookThickness(300) <= 0.42);
assert.throws(() => parseZipDirectory(new ArrayBuffer(32)));

globalThis.window = { innerWidth: 1440, innerHeight: 900 };
buildMaterials();
buildGeometry();
const testScene = new THREE.Scene();
const testCamera = new THREE.PerspectiveCamera(32, 1440 / 900, 0.1, 100);
testCamera.position.set(0, 2.5, 9.6);
const rig = new BookTransitionRig(testScene);
const dummyRuntime = {
  group: new THREE.Group(),
  bookW: 0.84,
  bookH: 1.12,
  thickness: 0.2,
  archDepth: 0.01,
  cloth: { cover: new THREE.MeshStandardMaterial(), spine: new THREE.MeshStandardMaterial() },
  coverMaterial: new THREE.MeshStandardMaterial(),
  spineMat: new THREE.MeshStandardMaterial(),
};
let revealed = false;
let openDone = false;
rig.startOpen(dummyRuntime, 'cream', () => { revealed = true; }, () => { openDone = true; });
assert.equal(dummyRuntime.group.visible, false);
for (let i = 0; i < 30; i++) rig.update(0.03, testCamera);
assert.equal(revealed, true);
assert.equal(openDone, true);

let closeDone = false;
rig.startClose(dummyRuntime, 'cream', () => { closeDone = true; });
for (let i = 0; i < 30; i++) rig.update(0.03, testCamera);
assert.equal(closeDone, true);
assert.equal(dummyRuntime.group.visible, true);

console.log('reader tests passed');
