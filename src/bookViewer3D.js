import { clamp, stripHtml } from './epub.js';
import { loadReaderPrefs, saveReaderPrefs } from './storage.js';

export const FONT_SCALE_MIN = 0.75;
export const FONT_SCALE_MAX = 1.65;

export class BookViewer3D {
  constructor({ onProgressChange, onDeleteBook, onClose } = {}) {
    this.onProgressChange = onProgressChange;
    this.onDeleteBook = onDeleteBook;
    this.onClose = onClose;

    const prefs = loadReaderPrefs();
    this.fontScale = prefs.fontScale;
    this.theme = prefs.theme;
    this.lineHeight = prefs.lineHeight;

    this.isOpen = false;
    this.tocOpen = false;
    this.chromeVisible = false;
    this.toolbarHovered = false;
    this.activeBook = null;
    this.originRuntime = null;

    this.chapters = [];
    this.chapterCharCounts = [];
    this.totalBookChars = 1;
    this.toc = [];

    this.currentChapter = 0;
    this.currentSpread = 0;
    this.chapterSpreadCount = 1;
    this.colsPerSpread = 2;
    this.spreadStride = 1;

    this.returnAnchor = null;
    this.contentToken = 0;
    this.contentReady = false;
    this.resizeTimer = 0;
    this.chromeTimer = 0;
    this.wheelAccum = 0;
    this.wheelLocked = false;
    this.wheelResetTimer = 0;
    this.flipRaf = 0;
    this.deleteConfirmPending = false;

    if (typeof document !== 'undefined') {
      this.buildHUD();
    }
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
      <article class="hud-sheet" id="hud-sheet">
        <div class="hud-spine-fold" id="hud-spine-fold" aria-hidden="true"></div>

        <nav class="hud-toolbar" id="hud-toolbar" aria-label="阅读控制栏">
          <div class="hud-toolbar-group">
            <button class="hud-ctrl-btn" id="hud-close" type="button" title="合上书本 (Esc)">← 书架</button>
            <button class="hud-ctrl-btn" id="hud-toc-toggle" type="button" aria-expanded="false" title="目录 (T)">目录</button>
            <button class="hud-ctrl-btn hud-return-btn" id="hud-return-pos" type="button" hidden>返回原位置</button>
          </div>
          <span class="hud-toolbar-divider" aria-hidden="true"></span>
          <div class="hud-toolbar-group">
            <button type="button" class="hud-ctrl-btn" id="hud-font-dec" title="缩小字号 (⌘-)">A−</button>
            <button type="button" class="hud-ctrl-btn" id="hud-font-inc" title="放大字号 (⌘+)">A+</button>
            <button type="button" class="hud-ctrl-btn" id="hud-lh-toggle" title="切换行距">行距</button>
            <div class="hud-theme-dots" role="group" aria-label="阅读主题">
              <button type="button" class="hud-theme-dot is-cream" data-theme="cream" title="米黄纸张"></button>
              <button type="button" class="hud-theme-dot is-white" data-theme="white" title="纯白纸张"></button>
              <button type="button" class="hud-theme-dot is-night" data-theme="night" title="夜间模式"></button>
            </div>
          </div>
        </nav>

        <header class="hud-page-header">
          <span class="hud-header-book" id="hud-header-book"></span>
          <span class="hud-header-chapter" id="hud-header-chapter"></span>
        </header>

        <div class="hud-viewport" id="hud-viewport">
          <div class="hud-columns-track" id="hud-columns-track"></div>
        </div>

        <footer class="hud-page-footer" id="hud-page-footer">
          <span class="hud-footer-progress" id="hud-footer-progress"></span>
        </footer>

        <div class="hud-flip-stage" id="hud-flip-stage" aria-hidden="true"></div>
      </article>

      <div class="hud-toc-scrim" id="hud-toc-scrim"></div>
      <aside class="hud-toc-drawer" id="hud-toc-panel" aria-hidden="true">
        <header class="hud-toc-head">
          <div class="hud-toc-head-titles">
            <h2 class="hud-toc-heading">目录</h2>
            <p class="hud-toc-book" id="hud-toc-title"></p>
          </div>
          <button type="button" class="hud-toc-close" id="hud-toc-close" aria-label="关闭目录">×</button>
        </header>
        <div class="hud-toc-search">
          <input id="hud-toc-search" type="search" placeholder="搜索章节或正文片段…" autocomplete="off" />
        </div>
        <div class="hud-toc-list" id="hud-toc-list"></div>
        <footer class="hud-toc-footnote">
          <span id="hud-toc-count"></span>
          <button type="button" class="hud-delete-book" id="hud-delete-book">删除本书</button>
        </footer>
      </aside>
    `;

    const $ = (id) => hud.querySelector(`#${id}`);
    this.hud = hud;
    this.hudSheet = $('hud-sheet');
    this.hudToolbar = $('hud-toolbar');
    this.hudSpineFold = $('hud-spine-fold');
    this.hudHeaderBook = $('hud-header-book');
    this.hudHeaderChapter = $('hud-header-chapter');
    this.hudViewport = $('hud-viewport');
    this.hudTrack = $('hud-columns-track');
    this.hudFooter = $('hud-page-footer');
    this.hudFlipStage = $('hud-flip-stage');
    this.hudProgress = $('hud-footer-progress');
    this.hudReturnBtn = $('hud-return-pos');
    this.hudTocToggle = $('hud-toc-toggle');
    this.hudTocScrim = $('hud-toc-scrim');
    this.hudTocPanel = $('hud-toc-panel');
    this.hudTocTitle = $('hud-toc-title');
    this.hudTocSearch = $('hud-toc-search');
    this.hudTocList = $('hud-toc-list');
    this.hudTocCount = $('hud-toc-count');
    this.hudDeleteBtn = $('hud-delete-book');

    $('hud-close').addEventListener('click', (e) => {
      e.stopPropagation();
      this.closeBook();
    });
    $('hud-toc-close').addEventListener('click', () => this.closeToc());

    $('hud-font-dec').addEventListener('click', (e) => {
      e.stopPropagation();
      this.adjustFontScale(-0.08);
      this.scheduleHideChrome();
    });
    $('hud-font-inc').addEventListener('click', (e) => {
      e.stopPropagation();
      this.adjustFontScale(0.08);
      this.scheduleHideChrome();
    });
    $('hud-lh-toggle').addEventListener('click', (e) => {
      e.stopPropagation();
      const steps = [1.6, 1.8, 2.05];
      const next = steps[(steps.indexOf(this.lineHeight) + 1) % steps.length] || 1.8;
      this.setLineHeight(next);
      this.scheduleHideChrome();
    });

    hud.querySelectorAll('[data-theme]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.setTheme(btn.dataset.theme);
        this.scheduleHideChrome();
      });
    });

    this.hudReturnBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!this.returnAnchor) return;
      const target = this.returnAnchor;
      this.returnAnchor = null;
      this.hudReturnBtn.hidden = true;
      this.goToAnchor(target);
      this.hideChrome();
    });

    this.hudToolbar.addEventListener('pointerenter', () => {
      this.toolbarHovered = true;
      clearTimeout(this.chromeTimer);
    });
    this.hudToolbar.addEventListener('pointerleave', () => {
      this.toolbarHovered = false;
      this.scheduleHideChrome(1600);
    });

    this.hudSheet.addEventListener('pointermove', (e) => {
      if (!this.isOpen || this.tocOpen) return;
      if (e.clientY <= 52) {
        this.showChrome();
      } else if (this.chromeVisible && !this.toolbarHovered && !this.chromeTimer) {
        this.scheduleHideChrome(1800);
      }
    });

    this.hudViewport.addEventListener('click', (e) => {
      const sel = window.getSelection?.();
      if (sel && sel.toString().trim().length > 0) return;
      const rect = this.hudViewport.getBoundingClientRect();
      const relX = (e.clientX - rect.left) / Math.max(1, rect.width);
      if (relX < 0.35) {
        this.hideChrome();
        this.flipPrev();
      } else if (relX > 0.65) {
        this.hideChrome();
        this.flipNext();
      } else {
        this.toggleChrome();
      }
    });

    this.hudSheet.addEventListener(
      'wheel',
      (e) => {
        if (!this.isOpen || this.tocOpen) return;
        e.preventDefault();

        if (e.ctrlKey) {
          this.adjustFontScale(e.deltaY < 0 ? 0.04 : -0.04);
          return;
        }

        clearTimeout(this.wheelResetTimer);
        this.wheelResetTimer = setTimeout(() => {
          this.wheelAccum = 0;
          this.wheelLocked = false;
        }, 140);

        if (this.wheelLocked) return;
        const primary = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
        this.wheelAccum += primary;
        if (Math.abs(this.wheelAccum) >= 52) {
          this.hideChrome();
          if (this.wheelAccum > 0) this.flipNext();
          else this.flipPrev();
          this.wheelAccum = 0;
          this.wheelLocked = true;
        }
      },
      { passive: false }
    );

    this.hudTocToggle.addEventListener('click', (e) => {
      e.stopPropagation();
      this.toggleToc();
    });
    this.hudTocScrim.addEventListener('click', () => this.closeToc());

    this.hudTocSearch.addEventListener('input', () => this.renderTocList(this.hudTocSearch.value));
    this.hudTocList.addEventListener('click', (e) => {
      const item = e.target.closest('[data-chapter]');
      if (!item) return;
      const targetChapter = Number(item.dataset.chapter);
      this.returnAnchor = this.getCurrentAnchor();
      this.hudReturnBtn.hidden = false;
      this.loadChapter(targetChapter, 0);
      this.closeToc();
      this.hideChrome();
    });

    this.hudDeleteBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!this.activeBook) return;
      if (!this.deleteConfirmPending) {
        this.deleteConfirmPending = true;
        this.hudDeleteBtn.textContent = '确认删除？';
        this.hudDeleteBtn.classList.add('is-confirming');
        return;
      }
      const bookId = this.activeBook.id;
      this.closeBook(true);
      this.onDeleteBook?.(bookId);
    });

    this.boundKeyDown = (e) => {
      if (!this.isOpen) return;
      const el = e.target;
      const typing = el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);

      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        if (this.tocOpen) this.closeToc();
        else if (this.chromeVisible) this.hideChrome();
        else this.closeBook();
        return;
      }
      if (typing) return;

      if ((e.metaKey || e.ctrlKey) && (e.key === '=' || e.key === '+')) {
        e.preventDefault();
        this.adjustFontScale(0.08);
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.key === '-') {
        e.preventDefault();
        this.adjustFontScale(-0.08);
        return;
      }

      if (
        e.key === 'ArrowRight' ||
        e.key === 'ArrowDown' ||
        e.key === 'PageDown' ||
        (e.key === ' ' && !e.shiftKey)
      ) {
        e.preventDefault();
        e.stopPropagation();
        this.hideChrome();
        this.flipNext();
      } else if (
        e.key === 'ArrowLeft' ||
        e.key === 'ArrowUp' ||
        e.key === 'PageUp' ||
        (e.key === ' ' && e.shiftKey)
      ) {
        e.preventDefault();
        e.stopPropagation();
        this.hideChrome();
        this.flipPrev();
      } else if (e.key === 't' || e.key === 'T' || e.key === 'm' || e.key === 'M') {
        e.preventDefault();
        this.toggleToc();
      } else if (e.key === 'Home') {
        e.preventDefault();
        this.loadChapter(0, 0);
      } else if (e.key === 'End') {
        e.preventDefault();
        this.loadChapter(Math.max(0, this.chapters.length - 1), Infinity);
      }
    };

    this.applyThemeAndMetrics();
  }

  showChrome() {
    if (!this.hud) return;
    this.chromeVisible = true;
    this.hud.classList.add('is-chrome-visible');
    this.scheduleHideChrome(2600);
  }

  hideChrome() {
    if (!this.hud) return;
    this.chromeVisible = false;
    clearTimeout(this.chromeTimer);
    this.chromeTimer = 0;
    this.hud.classList.remove('is-chrome-visible');
  }

  toggleChrome() {
    if (this.chromeVisible) this.hideChrome();
    else this.showChrome();
  }

  scheduleHideChrome(delayMs = 2400) {
    clearTimeout(this.chromeTimer);
    this.chromeTimer = setTimeout(() => {
      this.chromeTimer = 0;
      if (!this.toolbarHovered && !this.tocOpen) {
        this.hideChrome();
      }
    }, delayMs);
  }

  applyThemeAndMetrics() {
    if (!this.hud) return;
    this.hud.dataset.theme = this.theme;
    this.hud.querySelectorAll('[data-theme]').forEach((btn) => {
      btn.classList.toggle('is-active', btn.dataset.theme === this.theme);
    });
    const fontSizePx = Math.round(19 * this.fontScale);
    this.hudSheet.style.setProperty('--reader-font-size', `${fontSizePx}px`);
    this.hudSheet.style.setProperty('--reader-line-height', String(this.lineHeight));
  }

  setTheme(theme) {
    if (!['cream', 'white', 'night'].includes(theme)) return;
    this.theme = theme;
    this.applyThemeAndMetrics();
    saveReaderPrefs({ fontScale: this.fontScale, theme: this.theme, lineHeight: this.lineHeight });
  }

  setLineHeight(lh) {
    const anchor = this.getCurrentAnchor();
    this.lineHeight = clamp(lh, 1.45, 2.2);
    this.applyThemeAndMetrics();
    saveReaderPrefs({ fontScale: this.fontScale, theme: this.theme, lineHeight: this.lineHeight });
    if (this.contentReady) this.reflowCurrentChapter(anchor?.charOffset ?? 0);
  }

  adjustFontScale(delta) {
    const next = clamp(Number((this.fontScale + delta).toFixed(2)), FONT_SCALE_MIN, FONT_SCALE_MAX);
    if (next === this.fontScale) return;
    const anchor = this.getCurrentAnchor();
    this.fontScale = next;
    this.applyThemeAndMetrics();
    saveReaderPrefs({ fontScale: this.fontScale, theme: this.theme, lineHeight: this.lineHeight });
    if (this.contentReady) this.reflowCurrentChapter(anchor?.charOffset ?? 0);
  }

  prepareBookMetadata(book) {
    const rawChapters =
      Array.isArray(book?.chapters) && book.chapters.length > 0
        ? book.chapters
        : [{ title: book?.title || '', paragraphs: ['（本书暂无正文内容）'] }];

    this.chapters = rawChapters;
    this.chapterCharCounts = [];
    let totalChars = 0;

    for (let i = 0; i < rawChapters.length; i++) {
      const ch = rawChapters[i];
      let chChars = 0;
      for (const p of ch.paragraphs || []) {
        chChars += stripHtml(p).length + 1;
      }
      const count = Math.max(1, chChars);
      this.chapterCharCounts.push(count);
      totalChars += count;
    }
    this.totalBookChars = Math.max(1, totalChars);

    const hasExplicitToc = rawChapters.some((ch) => ch.inToc);
    let cumulativeChars = 0;
    this.toc = [];

    for (let i = 0; i < rawChapters.length; i++) {
      const ch = rawChapters[i];
      const includeInToc = !hasExplicitToc || ch.inToc || Boolean(ch.title) || i === 0;
      if (includeInToc) {
        const estPage =
          Math.max(
            1,
            Math.round(
              (cumulativeChars / this.totalBookChars) *
                Math.max(1, Math.round(this.totalBookChars / 550))
            ) + 1
          );
        this.toc.push({
          chapterIndex: i,
          title: String(ch.title || '').trim() || `第 ${i + 1} 节`,
          excerpt: stripHtml(ch.paragraphs?.[0] || '').replace(/\s+/g, ' ').slice(0, 60),
          level: clamp(Number(ch.level) || 0, 0, 2),
          pageNum: estPage,
        });
      }
      cumulativeChars += this.chapterCharCounts[i];
    }

    if (this.hudTocCount) {
      this.hudTocCount.textContent = `共 ${this.toc.length} 章`;
    }
  }

  loadChapter(chapterIndex, targetCharOffset = 0) {
    if (!this.chapters.length) return;
    this.currentChapter = clamp(chapterIndex, 0, this.chapters.length - 1);
    const chapter = this.chapters[this.currentChapter];

    const frag = document.createDocumentFragment();
    if (chapter.title) {
      const h1 = document.createElement('h1');
      h1.className = 'reader-chapter-heading';
      h1.textContent = chapter.title;
      h1.dataset.offset = '0';
      frag.appendChild(h1);
    }

    let offset = 0;
    const paragraphs = Array.isArray(chapter.paragraphs) ? chapter.paragraphs : [];
    for (let i = 0; i < paragraphs.length; i++) {
      const raw = String(paragraphs[i] || '').trim();
      if (!raw) continue;
      const p = document.createElement('p');
      p.className = 'reader-para';
      p.dataset.offset = String(offset);
      p.innerHTML = raw;
      frag.appendChild(p);
      offset += stripHtml(raw).length + 1;
    }

    this.hudTrack.replaceChildren(frag);
    this.reflowCurrentChapter(targetCharOffset);
  }

  reflowCurrentChapter(targetCharOffset = 0) {
    if (!this.hudViewport || !this.hudTrack) return;

    this.stopPageFlipAnimation();
    const viewW = Math.max(260, Math.floor(this.hudViewport.clientWidth));
    const viewH = Math.max(240, Math.floor(this.hudViewport.clientHeight));

    this.colsPerSpread =
      window.innerWidth >= 860 && window.innerWidth / window.innerHeight > 1.0 ? 2 : 1;
    this.hudSheet.classList.toggle('is-dual-page', this.colsPerSpread === 2);
    if (this.hudSpineFold) {
      this.hudSpineFold.hidden = this.colsPerSpread !== 2;
    }

    const gap =
      this.colsPerSpread === 2 ? clamp(Math.round(viewW * 0.068), 52, 108) : 48;
    const colW = this.colsPerSpread === 2 ? Math.floor((viewW - gap) / 2) : viewW;
    const effectiveW = this.colsPerSpread === 2 ? colW * 2 + gap : colW;

    this.colW = colW;
    this.colGap = gap;
    this.viewH = viewH;

    this.hudTrack.style.width = `${effectiveW}px`;
    this.hudTrack.style.height = `${viewH}px`;
    this.hudTrack.style.columnWidth = `${colW}px`;
    this.hudTrack.style.columnGap = `${gap}px`;
    this.hudTrack.style.transform = 'translate3d(0, 0, 0)';

    this.spreadStride = effectiveW + gap;
    const totalScrollW = Math.max(effectiveW, this.hudTrack.scrollWidth);
    const totalCols = Math.max(1, Math.round((totalScrollW + gap) / (colW + gap)));
    this.chapterSpreadCount = Math.max(1, Math.ceil(totalCols / this.colsPerSpread));

    if (!Number.isFinite(targetCharOffset)) {
      this.currentSpread = this.chapterSpreadCount - 1;
    } else if (targetCharOffset <= 0) {
      this.currentSpread = 0;
    } else {
      let targetEl = null;
      const children = this.hudTrack.children;
      for (let i = 0; i < children.length; i++) {
        const el = children[i];
        const off = Number(el.dataset.offset || 0);
        if (off <= targetCharOffset) targetEl = el;
        else break;
      }
      if (targetEl) {
        const colIdx = Math.floor(Math.max(0, targetEl.offsetLeft) / (colW + gap));
        this.currentSpread = clamp(
          Math.floor(colIdx / this.colsPerSpread),
          0,
          this.chapterSpreadCount - 1
        );
      } else {
        this.currentSpread = 0;
      }
    }

    this.applySpreadTransform();
  }

  applySpreadTransform() {
    const x = -this.currentSpread * this.spreadStride;
    this.hudTrack.style.transform = `translate3d(${x}px, 0, 0)`;
    this.updateHUD();
    this.saveCurrentProgress();
  }

  getCurrentCharOffset() {
    if (!this.hudTrack || this.currentSpread <= 0) return 0;
    const targetLeft = this.currentSpread * this.spreadStride - 8;
    const children = this.hudTrack.children;
    for (let i = 0; i < children.length; i++) {
      const el = children[i];
      if (el.offsetLeft >= targetLeft) {
        return Number(el.dataset.offset || 0);
      }
    }
    const last = children[children.length - 1];
    return Number(last?.dataset.offset || 0);
  }

  getCurrentAnchor() {
    const charOffset = this.getCurrentCharOffset();
    let charsBefore = 0;
    for (let i = 0; i < this.currentChapter; i++) {
      charsBefore += this.chapterCharCounts[i] || 0;
    }
    const chTotal = this.chapterCharCounts[this.currentChapter] || 1;
    const chFraction =
      this.chapterSpreadCount > 1
        ? this.currentSpread / (this.chapterSpreadCount - 1)
        : 0;
    const ratio = clamp((charsBefore + chTotal * chFraction) / this.totalBookChars, 0, 1);

    return {
      chapterIndex: this.currentChapter,
      charOffset,
      ratio: Number(ratio.toFixed(4)),
    };
  }

  saveCurrentProgress() {
    if (!this.activeBook || !this.contentReady) return;
    const progress = this.getCurrentAnchor();
    this.activeBook.progress = progress;
    this.onProgressChange?.(this.activeBook, progress);
  }

  goToAnchor(anchor) {
    if (!anchor) return;
    this.loadChapter(anchor.chapterIndex || 0, anchor.charOffset || 0);
  }

  updateHUD() {
    if (!this.hud) return;
    const ch = this.chapters[this.currentChapter];
    if (this.hudHeaderBook) {
      this.hudHeaderBook.textContent = this.activeBook?.title || '';
    }
    if (this.hudHeaderChapter) {
      this.hudHeaderChapter.textContent = ch?.title || '';
    }

    if (this.hudProgress) {
      const anchor = this.getCurrentAnchor();
      const pct = Math.round(anchor.ratio * 100);
      this.hudProgress.textContent = `${this.currentSpread + 1} / ${this.chapterSpreadCount}  ·  ${pct}%`;
    }

    this.highlightTocItem();
  }

  flipNext() {
    if (!this.isOpen || !this.contentReady || this.flipRaf) return;
    const canFlipSpread = this.currentSpread < this.chapterSpreadCount - 1;
    const canFlipChapter = this.currentChapter < this.chapters.length - 1;
    if (!canFlipSpread && !canFlipChapter) return;

    const oldTrack = this.hudFlipStage ? this.hudTrack.cloneNode(true) : null;
    const oldSpread = this.currentSpread;

    if (canFlipSpread) {
      this.currentSpread += 1;
      this.applySpreadTransform();
    } else {
      this.loadChapter(this.currentChapter + 1, 0);
    }

    if (oldTrack) {
      this.runPageFlipAnimation(1, oldTrack, oldSpread);
    }
  }

  flipPrev() {
    if (!this.isOpen || !this.contentReady || this.flipRaf) return;
    const canFlipSpread = this.currentSpread > 0;
    const canFlipChapter = this.currentChapter > 0;
    if (!canFlipSpread && !canFlipChapter) return;

    const oldTrack = this.hudFlipStage ? this.hudTrack.cloneNode(true) : null;
    const oldSpread = this.currentSpread;

    if (canFlipSpread) {
      this.currentSpread -= 1;
      this.applySpreadTransform();
    } else {
      this.loadChapter(this.currentChapter - 1, Infinity);
    }

    if (oldTrack) {
      this.runPageFlipAnimation(-1, oldTrack, oldSpread);
    }
  }

  stopPageFlipAnimation() {
    if (this.flipRaf) {
      cancelAnimationFrame(this.flipRaf);
      this.flipRaf = 0;
    }
    if (this.hudFlipStage) {
      this.hudFlipStage.classList.remove('is-flipping');
      this.hudFlipStage.replaceChildren();
    }
  }

  runPageFlipAnimation(direction, oldTrack, oldSpread) {
    if (!this.hudFlipStage || !this.hudSheet || !this.hudViewport) return;
    this.stopPageFlipAnimation();

    const sheetRect = this.hudSheet.getBoundingClientRect();
    const viewRect = this.hudViewport.getBoundingClientRect();
    if (sheetRect.width < 10 || viewRect.width < 10) return;

    const isDual = this.colsPerSpread === 2;
    const scale = this.hudSheet.clientWidth / sheetRect.width;
    const sheetWidth = this.hudSheet.clientWidth;
    const padLeft = (viewRect.left - sheetRect.left) * scale;
    const padTop = (viewRect.top - sheetRect.top) * scale;
    const colW = this.colW || Math.floor(viewRect.width);
    const colGap = this.colGap || 48;
    const viewH = this.viewH || Math.floor(viewRect.height);
    const stride = this.spreadStride;

    const makePagePlane = (side, trackNode, spreadIdx) => {
      const plane = document.createElement('div');
      plane.className = `hud-flip-page is-${side}`;
      plane.style.backgroundSize = `${sheetWidth}px ${this.hudSheet.clientHeight}px`;
      plane.style.backgroundPosition = side === 'right' ? `${-sheetWidth / 2}px 0` : '0 0';
      if (trackNode) {
        const win = document.createElement('div');
        win.className = 'hud-flip-window';
        win.style.top = `${padTop}px`;
        win.style.width = `${colW}px`;
        win.style.height = `${viewH}px`;
        if (side === 'right') {
          win.style.left = `${padLeft + colW + colGap - sheetWidth / 2}px`;
          trackNode.style.transform = `translate3d(${-(spreadIdx * stride + colW + colGap)}px, 0, 0)`;
        } else {
          win.style.left = `${padLeft}px`;
          trackNode.style.transform = `translate3d(${-spreadIdx * stride}px, 0, 0)`;
        }
        win.appendChild(trackNode);
        plane.appendChild(win);
      }
      return plane;
    };

    const frag = document.createDocumentFragment();
    const castFrom = document.createElement('div');
    const castTo = document.createElement('div');
    const leaf = document.createElement('div');
    const frontFace = document.createElement('div');
    const backFace = document.createElement('div');
    const frontShade = document.createElement('div');
    const backShade = document.createElement('div');

    frontFace.className = 'hud-flip-face is-front';
    backFace.className = 'hud-flip-face is-back';
    frontShade.className = 'hud-flip-curl-shade';
    backShade.className = 'hud-flip-curl-shade';

    if (isDual) {
      if (direction > 0) {
        const underlayLeft = makePagePlane('left', oldTrack.cloneNode(true), oldSpread);
        castFrom.className = 'hud-flip-cast is-right';
        castTo.className = 'hud-flip-cast is-left';
        leaf.className = 'hud-flip-leaf is-next';

        frontFace.append(makePagePlane('right', oldTrack, oldSpread), frontShade);
        backFace.append(
          makePagePlane('left', this.hudTrack.cloneNode(true), this.currentSpread),
          backShade
        );
        leaf.append(frontFace, backFace);
        frag.append(underlayLeft, castFrom, castTo, leaf);
      } else {
        const underlayRight = makePagePlane('right', oldTrack.cloneNode(true), oldSpread);
        castFrom.className = 'hud-flip-cast is-left';
        castTo.className = 'hud-flip-cast is-right';
        leaf.className = 'hud-flip-leaf is-prev';

        frontFace.append(makePagePlane('left', oldTrack, oldSpread), frontShade);
        backFace.append(
          makePagePlane('right', this.hudTrack.cloneNode(true), this.currentSpread),
          backShade
        );
        leaf.append(frontFace, backFace);
        frag.append(underlayRight, castFrom, castTo, leaf);
      }
    } else {
      castFrom.className = 'hud-flip-cast is-full';
      leaf.className = 'hud-flip-leaf is-single';
      if (direction > 0) {
        frontFace.append(makePagePlane('full', oldTrack, oldSpread), frontShade);
        backFace.append(makePagePlane('full', null, 0), backShade);
        leaf.append(frontFace, backFace);
        frag.append(castFrom, leaf);
      } else {
        const underlayFull = makePagePlane('full', oldTrack, oldSpread);
        frontFace.append(
          makePagePlane('full', this.hudTrack.cloneNode(true), this.currentSpread),
          frontShade
        );
        backFace.append(makePagePlane('full', null, 0), backShade);
        leaf.append(frontFace, backFace);
        frag.append(underlayFull, castFrom, leaf);
      }
    }

    this.hudFlipStage.replaceChildren(frag);
    this.hudFlipStage.classList.add('is-flipping');

    const leafWidth = isDual ? sheetWidth / 2 : sheetWidth;
    const strips = [];
    const stripCount = 12;
    const stripWidth = leafWidth / stripCount;
    for (let i = 0; i < stripCount; i++) {
      const strip = document.createElement('div');
      strip.className = 'hud-flip-strip';
      strip.style.width = `${stripWidth + 0.75}px`;
      for (const [face, isBack] of [[frontFace, false], [backFace, true]]) {
        const side = document.createElement('div');
        side.className = `hud-flip-strip-side${isBack ? ' is-back' : ''}`;
        const content = face.cloneNode(true);
        content.style.width = `${leafWidth}px`;
        content.style.left = `${isBack ? -(leafWidth - (i + 1) * stripWidth - 0.75) : -i * stripWidth}px`;
        content.style.transform = 'none';
        side.appendChild(content);
        strip.appendChild(side);
      }
      strips.push(strip);
    }
    leaf.replaceChildren(...strips);
    const shades = leaf.querySelectorAll('.hud-flip-curl-shade');
    const startTime = performance.now();
    const duration = isDual ? 680 : 560;

    const tick = (now) => {
      const raw = clamp((now - startTime) / duration, 0, 1);
      const eased = raw < 0.5 ? 4 * raw * raw * raw : 1 - Math.pow(-2 * raw + 2, 3) / 2;

      const p = isDual || direction > 0 ? eased : 1 - eased;
      const arc = Math.sin(p * Math.PI);
      const sign = isDual && direction < 0 ? 1 : -1;
      const angle = sign * 180 * p;
      leaf.style.transform = `rotateY(${angle}deg)`;
      const bend = sign * 0.24 * arc;
      let x = 0;
      let z = 0;
      for (let n = 0; n < stripCount; n++) {
        const i = sign > 0 ? stripCount - 1 - n : n;
        const theta = bend * (n + 0.5) / stripCount;
        const origin = sign > 0 ? leafWidth - x - stripWidth : x;
        strips[i].style.transformOrigin = sign > 0 ? 'right center' : 'left center';
        strips[i].style.transform = `translate3d(${origin}px, 0, ${z}px) rotateY(${theta * 180 / Math.PI}deg)`;
        x += stripWidth * Math.cos(theta);
        z += (sign > 0 ? 1 : -1) * stripWidth * Math.sin(theta);
      }
      for (const shade of shades) shade.style.opacity = (arc * 0.55).toFixed(3);
      castFrom.style.opacity = (arc * 0.3).toFixed(3);
      castFrom.style.transformOrigin = isDual && direction > 0 ? 'left center' : 'right center';
      castFrom.style.transform = `scaleX(${0.35 + arc * 0.65})`;
      castTo.style.opacity = (arc * p * 0.38).toFixed(3);

      if (raw < 1) {
        this.flipRaf = requestAnimationFrame(tick);
      } else {
        this.stopPageFlipAnimation();
      }
    };

    tick(startTime);
  }

  toggleToc() {
    if (this.tocOpen) this.closeToc();
    else this.openToc();
  }

  openToc() {
    if (!this.isOpen) return;
    this.tocOpen = true;
    this.hideChrome();
    this.deleteConfirmPending = false;
    if (this.hudDeleteBtn) {
      this.hudDeleteBtn.textContent = '删除本书';
      this.hudDeleteBtn.classList.remove('is-confirming');
    }
    this.hud.classList.add('toc-open');
    this.hudTocPanel.setAttribute('aria-hidden', 'false');
    this.hudTocToggle.setAttribute('aria-expanded', 'true');
    this.hudTocSearch.value = '';
    this.renderTocList();
  }

  closeToc() {
    if (!this.tocOpen) return;
    this.tocOpen = false;
    this.hud.classList.remove('toc-open');
    this.hudTocPanel.setAttribute('aria-hidden', 'true');
    this.hudTocToggle.setAttribute('aria-expanded', 'false');
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
      empty.textContent = '未找到匹配的章节';
      frag.appendChild(empty);
    }

    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      const item = document.createElement('button');
      item.type = 'button';
      item.className = `hud-toc-item hud-toc-level-${entry.level}`;
      item.dataset.chapter = String(entry.chapterIndex);

      const index = document.createElement('span');
      index.className = 'hud-toc-index';
      index.textContent = String(i + 1).padStart(2, '0');

      const name = document.createElement('span');
      name.className = 'hud-toc-item-title';
      name.textContent = entry.title;

      const page = document.createElement('span');
      page.className = 'hud-toc-item-page';
      page.textContent = `${entry.pageNum}`;

      item.append(index, name, page);
      frag.appendChild(item);
    }

    this.hudTocList.replaceChildren(frag);
    this.highlightTocItem();
  }

  highlightTocItem() {
    if (!this.hudTocList) return;
    let activeTocChapter = 0;
    for (const entry of this.toc) {
      if (entry.chapterIndex <= this.currentChapter) {
        activeTocChapter = entry.chapterIndex;
      } else {
        break;
      }
    }
    this.hudTocList.querySelectorAll('[data-chapter]').forEach((item) => {
      item.classList.toggle('is-current', Number(item.dataset.chapter) === activeTocChapter);
    });
  }

  onResize() {
    if (!this.isOpen || !this.contentReady) return;
    const anchor = this.getCurrentAnchor();
    clearTimeout(this.resizeTimer);
    this.resizeTimer = setTimeout(() => {
      if (this.isOpen && this.contentReady) {
        this.reflowCurrentChapter(anchor.charOffset);
      }
    }, 100);
  }

  revealSheet() {
    if (!this.isOpen || !this.hud) return;
    this.hud.classList.add('is-active');
  }

  async openBook(runtime, bookData, chaptersPromise = null) {
    if (this.isOpen) return;

    this.isOpen = true;
    this.activeBook = bookData;
    this.originRuntime = runtime;
    this.returnAnchor = null;
    if (this.hudReturnBtn) this.hudReturnBtn.hidden = true;

    const addDock = document.getElementById('add-dock');
    if (addDock) addDock.style.display = 'none';

    this.hudTocTitle.textContent = bookData.title || '';
    this.hudTocSearch.value = '';
    this.closeToc();
    this.hideChrome();
    this.applyThemeAndMetrics();

    window.addEventListener('keydown', this.boundKeyDown, { capture: true });

    this.hudTrack.replaceChildren();
    this.contentReady = false;

    const token = ++this.contentToken;
    if (chaptersPromise) {
      const chapters = await chaptersPromise;
      if (token !== this.contentToken || !this.isOpen) return;
      if (chapters && this.activeBook) {
        this.activeBook.chapters = chapters;
      }
    }

    if (token !== this.contentToken || !this.isOpen) return;
    this.prepareBookMetadata(this.activeBook);
    this.contentReady = true;

    const saved = this.activeBook.progress;
    this.loadChapter(saved?.chapterIndex || 0, saved?.charOffset || 0);
    this.renderTocList();

    if (document.fonts?.ready) {
      document.fonts.ready.then(() => {
        if (token === this.contentToken && this.isOpen && this.contentReady) {
          const curOffset = this.getCurrentCharOffset();
          this.reflowCurrentChapter(curOffset);
        }
      });
    }
  }

  closeBook(wasDeleted = false) {
    if (!this.isOpen) return;

    const originRuntime = this.originRuntime;
    this.contentToken++;
    this.contentReady = false;
    clearTimeout(this.resizeTimer);
    clearTimeout(this.chromeTimer);
    this.stopPageFlipAnimation();
    window.removeEventListener('keydown', this.boundKeyDown, { capture: true });
    this.closeToc();
    this.hideChrome();
    this.hud.classList.remove('is-active');

    if (this.activeBook) {
      delete this.activeBook.chapters;
    }
    this.chapters = [];
    this.hudTrack.replaceChildren();

    const addDock = document.getElementById('add-dock');
    if (addDock) addDock.style.display = '';

    this.isOpen = false;
    this.activeBook = null;
    this.originRuntime = null;
    this.onClose?.(originRuntime, wasDeleted);
  }
}
