import * as THREE from 'three';

export const BOOK_FONT = '"KingHwa_OldSong", "京華老宋体", "KingHwaOldSong", "Songti SC", "Noto Serif SC", "STSong", "Baskerville", serif';

export const FONT_SCALE_KEY = 'shelf-reader-font-scale';
export const DEFAULT_FONT_SCALE = 1.4;
export const FONT_SCALE_MIN = 0.9;
export const FONT_SCALE_MAX = 2.2;


const clamp = (v, min, max) => Math.min(Math.max(v, min), max);

function loadFontScale() {
  try {
    const raw = Number.parseFloat(localStorage.getItem(FONT_SCALE_KEY));
    if (Number.isFinite(raw)) return clamp(raw, FONT_SCALE_MIN, FONT_SCALE_MAX);
  } catch {}
  return DEFAULT_FONT_SCALE;
}

let fontLoadPromise = null;
let fontReady = false;
export function isCustomFontReady() {
  return fontReady;
}
export function ensureCustomFontLoaded() {
  if (!fontLoadPromise) {
    fontLoadPromise = (async () => {
      if (typeof document === 'undefined' || !document.fonts?.load) {
        fontReady = true;
        return;
      }
      try {
        await document.fonts.load(`53px "KingHwa_OldSong"`);
        await document.fonts.ready;
      } catch (e) {
        console.warn(e);
      } finally {
        fontReady = true;
      }
    })();
  }
  return fontLoadPromise;
}

export class PageLayoutEngine {
  constructor(fontScale = DEFAULT_FONT_SCALE) {
    this.canvasWidth = 1600;
    this.canvasHeight = 2240;

    this.paddingTop = 180;
    this.paddingBottom = 220;
    this.paddingSpine = 170; 
    this.paddingEdge = 140;  

    this.bodyStartY = 230;
    this.bodyEndY = 1960; 
    this.maxBodyH = this.bodyEndY - this.bodyStartY; 

    this.measuringCanvas = document.createElement('canvas');
    this.measuringCanvas.width = this.canvasWidth;
    this.measuringCanvas.height = this.canvasHeight;
    this.ctx = this.measuringCanvas.getContext('2d');

    this.widthCache = new Map();
    this.prefixBuffer = new Float64Array(2048);

    this.setFontScale(fontScale);
  }

  invalidateWidthCache() {
    this.widthCache.clear();
    
    this.ctx.font = `400 ${this.metrics.bodyFontSize}px ${BOOK_FONT}`;
  }

  setFontScale(scale) {
    this.fontScale = clamp(Number(scale) || DEFAULT_FONT_SCALE, FONT_SCALE_MIN, FONT_SCALE_MAX);
    const s = this.fontScale;
    const body = Math.round(38 * s);
    const chrome = Math.min(s, 1.3); 
    this.metrics = {
      bodyFontSize: body,
      lineHeight: Math.round(68 * s),
      headingFontSize: Math.round(52 * s),
      headingHeight: Math.round(110 * s),
      indent: body * 2,
      paragraphGap: Math.round(24 * s),
      headerFontSize: Math.round(30 * chrome),
      footerFontSize: Math.round(32 * chrome),
    };
    this.ctx.font = `400 ${body}px ${BOOK_FONT}`;
    this.invalidateWidthCache();
    return this.fontScale;
  }

  breakParagraph(chars, contentW, indent, charOffsetBase) {
    const ctx = this.ctx;
    const n = chars.length;
    if (n === 0) return [];

    let sums = this.prefixBuffer;
    if (sums.length < n + 1) {
      sums = new Float64Array(n + 1);
      this.prefixBuffer = sums;
    }
    const cache = this.widthCache;
    for (let i = 0; i < n; i++) {
      const ch = chars[i];
      let w = cache.get(ch);
      if (w === undefined) {
        w = ctx.measureText(ch).width;
        cache.set(ch, w);
      }
      sums[i + 1] = sums[i] + w;
    }

    const lines = [];
    let start = 0;
    const widthOf = (from, to) => ctx.measureText(chars.slice(from, to).join('')).width;

    while (start < n) {
      const curIndent = start === 0 ? indent : 0;
      const avail = contentW - curIndent;

      let lo = start + 1;
      let hi = n;
      let end = start;
      while (lo <= hi) {
        const mid = (lo + hi) >>> 1;
        if (sums[mid] - sums[start] <= avail) {
          end = mid;
          lo = mid + 1;
        } else {
          hi = mid - 1;
        }
      }
      if (end <= start) end = start + 1; 

      const sumW = sums[end] - sums[start];
      let measured = widthOf(start, end);
      if (Math.abs(measured - sumW) >= 0.01 || measured > avail) {
        while (measured > avail && end > start + 1) {
          end--;
          measured = widthOf(start, end);
        }
        while (end < n) {
          if (widthOf(start, end + 1) > avail) break;
          end++;
        }
      }

      lines.push({
        text: chars.slice(start, end).join(''),
        indent: curIndent,
        charOffset: charOffsetBase + start,
      });
      start = end;
    }
    return lines;
  }

  paginateBook(book) {
    let bookContent = null;
    if (book.chapters && book.chapters.length > 0) {
      bookContent = {
        title: book.title || '',
        author: book.author || '',
        chapters: book.chapters,
      };
    } else {
      bookContent = {
        title: book.title || '',
        author: book.author || '',
        chapters: [{ title: '', paragraphs: [''] }],
      };
    }

    const m = this.metrics;
    const pages = [];
    const toc = [];
    const contentW = this.canvasWidth - this.paddingSpine - this.paddingEdge;
    let pageNumber = 1;

    const pushPage = (items, cIdx, chapter) => {
      if (!items.length) return;
      const firstLine = items.find((item) => item.type === 'line');
      pages.push({
        type: 'content',
        pageNum: pageNumber++,
        chapterIndex: cIdx,
        chapterTitle: chapter.title || '',
        bookTitle: bookContent.title || '',
        author: bookContent.author || '',
        anchor: { chapterIndex: cIdx, charOffset: firstLine?.charOffset ?? 0 },
        items,
      });
    };

    for (let cIdx = 0; cIdx < bookContent.chapters.length; cIdx++) {
      const chapter = bookContent.chapters[cIdx];
      const paragraphs = Array.isArray(chapter.paragraphs) ? chapter.paragraphs : [];
      const firstPageIndex = pages.length;

      const chapterLines = [];
      if (chapter.title) {
        chapterLines.push({
          type: 'heading',
          text: chapter.title,
          height: m.headingHeight,
          charOffset: 0,
        });
      }

      const paragraphBlocks = [];
      let chapterCharOffset = 0;

      for (let pIdx = 0; pIdx < paragraphs.length; pIdx++) {
        const chars = Array.from(String(paragraphs[pIdx] || '').trim());
        if (!chars.length) continue;

        const lines = this.breakParagraph(chars, contentW, m.indent, chapterCharOffset);
        chapterCharOffset += chars.length + 1;
        paragraphBlocks.push({ lines, marginBottom: m.paragraphGap });
      }

      let curPageItems = [];
      let curPageUsedH = 0;

      if (chapterLines.length > 0) {
        curPageItems.push(chapterLines[0]);
        curPageUsedH += chapterLines[0].height;
      }

      for (const block of paragraphBlocks) {
        for (const line of block.lines) {
          if (curPageUsedH + m.lineHeight > this.maxBodyH && curPageItems.length > 0) {
            pushPage(curPageItems, cIdx, chapter);
            curPageItems = [];
            curPageUsedH = 0;
          }

          curPageItems.push({
            type: 'line',
            text: line.text,
            indent: line.indent,
            charOffset: line.charOffset,
            height: m.lineHeight,
          });
          curPageUsedH += m.lineHeight;
        }
        curPageUsedH += block.marginBottom;
      }

      pushPage(curPageItems, cIdx, chapter);

      const firstPage = pages[firstPageIndex];
      toc.push({
        chapterIndex: cIdx,
        title: String(chapter.title || '').trim() || String(cIdx + 1),
        excerpt: String(paragraphs[0] || '').replace(/\s+/g, ' ').slice(0, 60),
        level: clamp(Number(chapter.level) || 0, 0, 2),
        pageNum: firstPage?.pageNum ?? Math.max(1, pageNumber - 1),
        spreadIndex: firstPageIndex,
      });
    }

    const spreads = pages.map((page) => ({ left: page, right: null }));

    return { spreads, toc, totalPages: pages.length };
  }

  findSpreadByAnchor(spreads, anchor) {
    if (!anchor || !spreads.length) return 0;
    let fallback = 0;
    for (let i = 0; i < spreads.length; i++) {
      for (const page of [spreads[i].left, spreads[i].right]) {
        if (!page || page.chapterIndex !== anchor.chapterIndex) continue;
        fallback = i;
        if ((page.anchor?.charOffset ?? 0) >= anchor.charOffset) return i;
      }
    }
    return fallback;
  }

  renderPageTexture(pageData, side = 'left') {
    const canvas = document.createElement('canvas');
    canvas.width = this.canvasWidth;
    canvas.height = this.canvasHeight;
    const ctx = canvas.getContext('2d');

    ctx.fillStyle = '#fdfbf6';
    ctx.fillRect(0, 0, this.canvasWidth, this.canvasHeight);

    if (!pageData || pageData.type === 'empty') {
      const tex = new THREE.CanvasTexture(canvas);
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.anisotropy = 8;
      return tex;
    }

    const contentStartX = side === 'left' ? this.paddingEdge : this.paddingSpine;
    const contentEndX = side === 'left' ? this.canvasWidth - this.paddingSpine : this.canvasWidth - this.paddingEdge;
    const headerY = this.paddingTop - 30;

    const m = this.metrics;
    ctx.fillStyle = '#9a8c7b';
    ctx.font = `400 ${m.headerFontSize}px ${BOOK_FONT}`;
    ctx.textBaseline = 'bottom';
    if (side === 'left') {
      ctx.textAlign = 'left';
      if (pageData.bookTitle) ctx.fillText(pageData.bookTitle, contentStartX, headerY);
      ctx.textAlign = 'right';
      if (pageData.author) ctx.fillText(pageData.author, contentEndX, headerY);
    } else {
      ctx.textAlign = 'left';
      if (pageData.chapterTitle) ctx.fillText(pageData.chapterTitle, contentStartX, headerY);
    }

    ctx.strokeStyle = 'rgba(154, 140, 123, 0.28)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(contentStartX, headerY + 12);
    ctx.lineTo(contentEndX, headerY + 12);
    ctx.stroke();

    const footerY = 2120;
    ctx.font = `500 ${m.footerFontSize}px ${BOOK_FONT}`;
    ctx.fillStyle = '#6f6254';
    if (pageData.pageNum) {
      if (side === 'left') {
        ctx.textAlign = 'left';
        ctx.fillText(String(pageData.pageNum), contentStartX, footerY);
      } else {
        ctx.textAlign = 'right';
        ctx.fillText(String(pageData.pageNum), contentEndX, footerY);
      }
    }

    let currentY = this.bodyStartY;
    ctx.textBaseline = 'top';

    if (pageData.items) {
      for (const item of pageData.items) {
        if (item.type === 'heading') {
          ctx.fillStyle = '#2b241e';
          
          const maxW = contentEndX - contentStartX;
          let headingSize = m.headingFontSize;
          ctx.font = `700 ${headingSize}px ${BOOK_FONT}`;
          while (ctx.measureText(item.text).width > maxW && headingSize > m.bodyFontSize) {
            headingSize -= 2;
            ctx.font = `700 ${headingSize}px ${BOOK_FONT}`;
          }
          ctx.textAlign = 'center';
          ctx.fillText(item.text, (contentStartX + contentEndX) * 0.5, currentY + 10);
          currentY += item.height;
        } else if (item.type === 'line') {
          ctx.fillStyle = '#2b241e';
          ctx.font = `400 ${m.bodyFontSize}px ${BOOK_FONT}`;
          ctx.textAlign = 'left';

          const drawX = contentStartX + (item.indent || 0);
          ctx.fillText(item.text, drawX, currentY);
          currentY += item.height;
        }
      }
    }

    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 8;
    return tex;
  }
}

export class BookViewer3D {
  constructor(controls, onStateChange) {
    this.controls = controls;
    this.onStateChange = onStateChange;

    this.fontScale = loadFontScale();
    this.layoutEngine = new PageLayoutEngine(this.fontScale);

    this.isOpen = false;
    this.currentSpread = 0;
    this.spreads = [];
    this.toc = [];
    this.totalPages = 0;
    this.tocOpen = false;
    this.activeBook = null;
    this.originRuntime = null;

    this.paginationCache = new Map();
    this.contentToken = 0;
    this.contentReady = false;
    this.pageTexture = null;

    this.buildHUD();
  }

  buildHUD() {
    let hud = document.getElementById('book-reader-hud');
    if (!hud) {
      hud = document.createElement('div');
      hud.className = 'book-reader-hud';
      hud.id = 'book-reader-hud';
      document.body.appendChild(hud);
    }

    hud.innerHTML = `
      <div class="hud-backdrop-dismiss" id="hud-backdrop-dismiss"></div>
      <div class="hud-flat-pages" id="hud-flat-pages"></div>
      <button class="hud-close" id="hud-close" type="button">×</button>
      <button class="hud-turn-zone hud-turn-left" id="hud-btn-prev-zone" type="button"></button>
      <button class="hud-turn-zone hud-turn-right" id="hud-btn-next-zone" type="button"></button>

      <button class="hud-bookmark" id="hud-bookmark" type="button" aria-expanded="false">
        <span class="hud-bookmark-ribbon" aria-hidden="true">
          <span class="hud-bookmark-label"></span>
        </span>
      </button>

      <div class="hud-toc-scrim" id="hud-toc-scrim"></div>
      <section class="hud-toc-leaf" id="hud-toc-panel" aria-hidden="true">
        <div class="hud-toc-leaf-inner">
          <header class="hud-toc-head">
            <p class="hud-toc-book" id="hud-toc-title"></p>
            <h2 class="hud-toc-heading"></h2>
            <span class="hud-toc-rule" aria-hidden="true"></span>
          </header>
          <div class="hud-toc-search">
            <input id="hud-toc-search" type="search" placeholder="" autocomplete="off" />
          </div>
          <div class="hud-toc-list" id="hud-toc-list"></div>
          <footer class="hud-toc-footnote">
            <span id="hud-toc-count"></span>
            <span class="hud-toc-hint"></span>
          </footer>
        </div>
      </section>

    `;

    const $ = (id) => hud.querySelector(`#${id}`);
    this.hud = hud;
    this.hudPages = $('hud-flat-pages');
    $('hud-close').addEventListener('click', () => this.closeBook());
    this.hudDismiss = $('hud-backdrop-dismiss');
    this.hudPrevZone = $('hud-btn-prev-zone');
    this.hudNextZone = $('hud-btn-next-zone');
    this.hudBookmark = $('hud-bookmark');
    this.hudTocScrim = $('hud-toc-scrim');
    this.hudTocPanel = $('hud-toc-panel');
    this.hudTocTitle = $('hud-toc-title');
    this.hudTocSearch = $('hud-toc-search');
    this.hudTocList = $('hud-toc-list');

    this.hudDismiss.addEventListener('click', () => this.closeBook());
    this.hudPrevZone.addEventListener('click', (e) => {
      e.stopPropagation();
      this.flipPrev();
    });
    this.hudNextZone.addEventListener('click', (e) => {
      e.stopPropagation();
      this.flipNext();
    });

    this.hudBookmark.addEventListener('click', (e) => {
      e.stopPropagation();
      this.toggleToc();
    });
    this.hudTocScrim.addEventListener('click', () => this.closeToc());

    this.hudTocSearch.addEventListener('input', () => this.renderTocList(this.hudTocSearch.value));
    this.hudTocList.addEventListener('click', (e) => {
      const item = e.target.closest('[data-spread]');
      if (!item) return;
      this.jumpToSpread(Number(item.dataset.spread));
      this.closeToc();
    });

    this.boundKeyDown = (e) => {
      if (!this.isOpen) return;
      const el = e.target;
      const typing = el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);

      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        if (this.tocOpen) this.closeToc();
        else this.closeBook();
        return;
      }
      if (typing) return;

      if (e.key === 'ArrowRight' || e.key === 'PageDown' || e.key === ' ') {
        e.preventDefault();
        e.stopPropagation();
        this.flipNext();
      } else if (e.key === 'ArrowLeft' || e.key === 'PageUp') {
        e.preventDefault();
        e.stopPropagation();
        this.flipPrev();
      } else if (e.key === 't' || e.key === 'T' || e.key === 'm' || e.key === 'M') {
        e.preventDefault();
        this.toggleToc();
      } else if (e.key === 'Home') {
        e.preventDefault();
        this.jumpToSpread(0);
      } else if (e.key === 'End') {
        e.preventDefault();
        this.jumpToSpread(this.spreads.length - 1);
      }
    };
  }

  toggleToc() {
    if (this.tocOpen) this.closeToc();
    else this.openToc();
  }

  openToc() {
    if (!this.isOpen) return;
    this.tocOpen = true;
    this.hud.classList.add('toc-open');
    this.hudTocPanel.setAttribute('aria-hidden', 'false');
    this.hudBookmark.setAttribute('aria-expanded', 'true');
    this.hudTocSearch.value = '';
    this.renderTocList();
  }

  closeToc() {
    if (!this.tocOpen) return;
    this.tocOpen = false;
    this.hud.classList.remove('toc-open');
    this.hudTocPanel.setAttribute('aria-hidden', 'true');
    this.hudBookmark.setAttribute('aria-expanded', 'false');
    this.hudTocSearch.blur();
  }

  renderTocList(query = '') {
    if (!this.hudTocList) return;
    const q = String(query || '').trim().toLowerCase();
    const entries = this.toc.filter(
      (entry) => !q || entry.title.toLowerCase().includes(q) || entry.excerpt.toLowerCase().includes(q)
    );
    const frag = document.createDocumentFragment();

    if (!entries.length) {
      const empty = document.createElement('div');
      empty.className = 'hud-toc-empty';
      frag.appendChild(empty);
    }

    for (const entry of entries) {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = `hud-toc-item hud-toc-level-${entry.level}`;
      item.dataset.spread = String(entry.spreadIndex);
      item.dataset.chapter = String(entry.chapterIndex);

      const index = document.createElement('span');
      index.className = 'hud-toc-index';
      index.textContent = String(entry.chapterIndex + 1);

      const name = document.createElement('span');
      name.className = 'hud-toc-item-title';
      name.textContent = entry.title;

      const dots = document.createElement('span');
      dots.className = 'hud-toc-dots';
      dots.setAttribute('aria-hidden', 'true');

      const page = document.createElement('span');
      page.className = 'hud-toc-item-page';
      page.textContent = String(entry.pageNum);

      item.append(index, name, dots, page);
      frag.appendChild(item);
    }

    this.hudTocList.replaceChildren(frag);
    this.highlightTocItem();
  }

  highlightTocItem() {
    if (!this.hudTocList) return;
    const chapter = this.getCurrentChapterIndex();
    this.hudTocList.querySelectorAll('[data-chapter]').forEach((item) => {
      item.classList.toggle('is-current', Number(item.dataset.chapter) === chapter);
    });
  }

  getCurrentChapterIndex() {
    const spread = this.spreads[this.currentSpread];
    return spread?.left?.chapterIndex ?? spread?.right?.chapterIndex ?? -1;
  }


  notifyState() {
    if (typeof this.onStateChange === 'function') {
      this.onStateChange({
        isOpen: true,
        currentSpread: this.currentSpread,
        totalSpreads: this.spreads.length,
      });
    }
  }

  updateHUD() {
    if (!this.hud) return;
    const cur = this.currentSpread;
    const total = this.spreads.length;

    this.hudPrevZone.classList.toggle('is-disabled', cur <= 0);
    this.hudNextZone.classList.toggle('is-disabled', cur >= total - 1);
    this.highlightTocItem();
  }

  repaginate(anchor = null) {
    const result = this.getPagination(this.activeBook);
    this.spreads = result.spreads;
    this.toc = result.toc;
    this.totalPages = result.totalPages;
    this.currentSpread = anchor
      ? this.layoutEngine.findSpreadByAnchor(this.spreads, anchor)
      : 0;

    this.updateSpreadTextures(this.currentSpread);
    this.updateHUD();
    this.renderTocList(this.hudTocSearch.value);
    this.notifyState();
  }

  getPagination(book) {
    const b = book || {};
    const key = `${b.id || b.title || 'book'}|${this.fontScale}|${this.layoutEngine.canvasWidth}|${b.chapters?.length || 0}`;
    let result = this.paginationCache.get(key);
    if (!result) {
      result = this.layoutEngine.paginateBook(b);
      this.paginationCache.set(key, result);
      if (this.paginationCache.size > 3) {
        this.paginationCache.delete(this.paginationCache.keys().next().value);
      }
    }
    return result;
  }

  onResize() {
    if (!this.isOpen) return;

    const anchor = this.spreads[this.currentSpread]?.left?.anchor;
    this.resizeReadingPage();
    if (this.contentReady) this.repaginate(anchor);
  }

  resizeReadingPage() {
    const layout = this.layoutEngine;
    const width = Math.max(1, window.innerWidth);
    const height = Math.max(1, window.innerHeight);
    layout.canvasHeight = 2240;
    layout.canvasWidth = Math.round(layout.canvasHeight * width / height);
    layout.paddingSpine = layout.paddingEdge = Math.round(layout.canvasWidth * 0.08);
  }

  async openBook(runtime, bookData, chaptersPromise = null) {
    if (this.isOpen) return;

    this.isOpen = true;
    this.activeBook = bookData;
    this.originRuntime = runtime;

    this.savedDamping = this.controls.enableDamping;
    this.controls.enableDamping = false;
    if (this.controls._sphericalDelta?.set) this.controls._sphericalDelta.set(0, 0, 0);
    if ('_scale' in this.controls) this.controls._scale = 1;
    this.controls.update();
    this.controls.enabled = false;

    const addDock = document.getElementById('add-dock');
    if (addDock) addDock.style.display = 'none';

    this.hudTocTitle.textContent = bookData.title || '';
    this.hudTocSearch.value = '';
    this.closeToc();
    this.layoutEngine.setFontScale(this.fontScale);
    this.resizeReadingPage();

    window.addEventListener('keydown', this.boundKeyDown, { capture: true });

    runtime.group.visible = false;
    runtime.shadow.visible = false;

    this.hudPages.replaceChildren();
    this.hud.classList.add('is-active');
    this.updateHUD();

    this.contentReady = false;
    this.prepareBookContent(chaptersPromise);
  }

  async prepareBookContent(chaptersPromise = null) {
    const token = ++this.contentToken;
    await ensureCustomFontLoaded();
    if (token !== this.contentToken || !this.isOpen) return;

    if (chaptersPromise) {
      const chapters = await chaptersPromise;
      if (token !== this.contentToken || !this.isOpen) return;
      if (chapters && this.activeBook && !this.activeBook.chapters) {
        this.activeBook.chapters = chapters;
      }
    }

    this.layoutEngine.invalidateWidthCache();

    await new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      requestAnimationFrame(() => requestAnimationFrame(finish));
      setTimeout(finish, 120);
    });
    if (token !== this.contentToken || !this.isOpen) return;

    this.contentReady = true;
    this.repaginate();
  }

  updateSpreadTextures(spreadIndex) {
    const spread = this.spreads[spreadIndex];
    if (!spread) return;

    if (this.pageTexture) this.pageTexture.dispose();
    this.pageTexture = this.layoutEngine.renderPageTexture(spread.left, 'left');
    this.hudPages.replaceChildren(this.pageTexture.image);
    this.hudPages.scrollTop = 0;
  }

  jumpToSpread(index) {
    if (!this.isOpen || !this.spreads.length) return;
    const target = clamp(Math.round(Number(index) || 0), 0, this.spreads.length - 1);
    if (target === this.currentSpread) return;
    if (target > this.currentSpread) this.flipNext(target);
    else this.flipPrev(target);
  }

  flipNext(targetSpreadIndex = null) {
    if (!this.isOpen) return;
    const target = targetSpreadIndex == null ? this.currentSpread + 1 : targetSpreadIndex;
    if (target > this.spreads.length - 1) return;
    this.setFlatSpread(target);
  }

  flipPrev(targetSpreadIndex = null) {
    if (!this.isOpen || !this.spreads.length) return;
    const target = targetSpreadIndex == null ? this.currentSpread - 1 : targetSpreadIndex;
    if (target < 0) return;
    this.setFlatSpread(target);
  }

  setFlatSpread(target) {
    this.currentSpread = target;
    this.updateSpreadTextures(target);
    this.updateHUD();
    this.notifyState();
  }

  closeBook() {
    if (!this.isOpen) return;

    this.contentToken++;
    this.contentReady = false;
    window.removeEventListener('keydown', this.boundKeyDown, { capture: true });
    this.closeToc();
    this.hud.classList.remove('is-active');

    if (this.originRuntime) {
      this.originRuntime.group.visible = true;
      this.originRuntime.shadow.visible = true;
    }
    const addDock = document.getElementById('add-dock');
    if (addDock) addDock.style.display = '';
    this.hudPages.replaceChildren();
    if (this.pageTexture) {
      this.pageTexture.dispose();
      this.pageTexture = null;
    }
    this.isOpen = false;
    this.controls.enableDamping = this.savedDamping ?? true;
    this.controls.enabled = true;
    this.controls.update();
  }
}
