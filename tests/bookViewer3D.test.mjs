import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const coreUrl = new URL('../vendor/three/three.core.js', import.meta.url).href;
const source = (await readFile(new URL('../src/bookViewer3D.js', import.meta.url), 'utf8'))
  .replace("from 'three'", `from '${coreUrl}'`);
const { BookViewer3D, PageLayoutEngine } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);

const viewer = Object.create(BookViewer3D.prototype);
viewer.spreads = [{ left: 'L0', right: 'R0' }, { left: 'L1', right: 'R1' }, { left: 'L2', right: 'R2' }];
viewer.currentSpread = 0;
viewer.isOpen = true;
viewer.pageTexture = null;
viewer.hudPages = {
  scrollTop: 80,
  replaceChildren(...pages) { this.pages = pages; },
};
viewer.layoutEngine = {
  renderPageTexture(page) {
    return { page, image: { page }, disposed: false, dispose() { this.disposed = true; } };
  },
};
viewer.updateHUD = () => {};
viewer.notifyState = () => {};

viewer.updateSpreadTextures(0);
for (const [direction, target] of [['next', null], ['prev', null], ['next', 2], ['prev', 0]]) {
  const old = viewer.pageTexture;
  const expected = target ?? viewer.currentSpread + (direction === 'next' ? 1 : -1);
  viewer[direction === 'next' ? 'flipNext' : 'flipPrev'](target);
  assert.equal(viewer.currentSpread, expected);
  assert.equal(old.disposed, true);
  assert.equal(viewer.pageTexture.page, viewer.spreads[expected].left);
  assert.deepEqual(viewer.hudPages.pages, [viewer.pageTexture.image]);
  assert.equal(viewer.hudPages.scrollTop, 0);
}
viewer.flipPrev();
assert.equal(viewer.currentSpread, 0);
viewer.jumpToSpread(2);
viewer.flipNext();
assert.equal(viewer.currentSpread, 2);

const layout = Object.create(PageLayoutEngine.prototype);
Object.assign(layout, {
  metrics: { indent: 0, lineHeight: 20, headingHeight: 20, paragraphGap: 0 },
  canvasWidth: 600, paddingSpine: 40, paddingEdge: 40, maxBodyH: 40,
  breakParagraph(chars) { return chars.map((text, charOffset) => ({ text, charOffset })); },
});
const pagination = layout.paginateBook({ title: '', chapters: [
  { title: '', paragraphs: ['a'] },
  { title: '', paragraphs: ['b'] },
] });
assert.equal(pagination.spreads.length, pagination.totalPages);
assert.ok(pagination.spreads.every(page => page.left.type === 'content' && page.right === null));
for (const entry of pagination.toc) {
  assert.equal(pagination.spreads[entry.spreadIndex].left.chapterIndex, entry.chapterIndex);
  assert.equal(entry.spreadIndex + 1, entry.pageNum);
}
