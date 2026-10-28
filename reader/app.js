'use strict';

const SETTINGS_KEY = 'dengxia.settings.v1';
const PROGRESS_KEY = 'dengxia.progress.v1';
const BOOKMARKS_KEY = 'dengxia.bookmarks.v1';
const SHARED_THEME_KEY = 'desk-theme';

const IS_WINDOWS = /Windows/i.test(
  (navigator.userAgentData && navigator.userAgentData.platform)
    || navigator.platform
    || navigator.userAgent
    || ''
);
const DEFAULT_FONT = IS_WINDOWS ? 'sans' : 'serif';
const DARK_MEDIA = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;

const DEFAULT_SETTINGS = Object.freeze({
  theme: 'auto',
  paper: 'paper',
  mode: 'scroll',
  font: DEFAULT_FONT,
  fontSize: 19,
  lineHeight: 1.95,
  width: 760,
  indent: true,
  weight: 400,
});

const THEME_NAMES = { dark: '深色', light: '浅色', auto: '跟随系统' };
const THEME_COLORS = { dark: '#090a0d', light: '#f4f5f8' };
const THEME_ORDER = ['dark', 'light', 'auto'];
const PAPER_ORDER = ['paper', 'cream'];
const PAPER_NAMES = { paper: '纸色', cream: '米色' };
const WEIGHTS = [300, 400, 700];

const $ = (id) => document.getElementById(id);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

const el = {
  libraryView: $('libraryView'),
  readerView: $('readerView'),
  libraryStatus: $('libraryStatus'),
  bookSearch: $('bookSearch'),
  refreshBooksBtn: $('refreshBooksBtn'),
  importBtn: $('importBtn'),
  importInput: $('importInput'),
  libraryLoading: $('libraryLoading'),
  bookGrid: $('bookGrid'),
  shelfSummary: $('shelfSummary'),
  libraryEmpty: $('libraryEmpty'),
  libraryEmptyTitle: $('libraryEmptyTitle'),
  libraryEmptyText: $('libraryEmptyText'),
  emptyImportBtn: $('emptyImportBtn'),
  libraryError: $('libraryError'),
  libraryErrorText: $('libraryErrorText'),
  retryBooksBtn: $('retryBooksBtn'),
  readerBookTitle: $('readerBookTitle'),
  readerBookMeta: $('readerBookMeta'),
  bookProgressBar: $('bookProgressBar'),
  backToLibraryBtn: $('backToLibraryBtn'),
  chapterPrevTop: $('chapterPrevTop'),
  chapterNextTop: $('chapterNextTop'),
  openTocBtn: $('openTocBtn'),
  openSearchBtn: $('openSearchBtn'),
  searchDialog: $('searchDialog'),
  searchBookInput: $('searchBookInput'),
  searchCount: $('searchCount'),
  searchList: $('searchList'),
  searchEmpty: $('searchEmpty'),
  openBookmarksBtn: $('openBookmarksBtn'),
  bookmarkCount: $('bookmarkCount'),
  openSettingsBtn: $('openSettingsBtn'),
  readerMain: $('readerMain'),
  readerBar: document.querySelector('.reader-bar'),
  readerLoading: $('readerLoading'),
  readerError: $('readerError'),
  readerErrorText: $('readerErrorText'),
  retryChapterBtn: $('retryChapterBtn'),
  errorBackBtn: $('errorBackBtn'),
  modeHint: $('modeHint'),
  chapterArticle: $('chapterArticle'),
  chapterKicker: $('chapterKicker'),
  chapterStats: $('chapterStats'),
  chapterTitle: $('chapterTitle'),
  chapterBody: $('chapterBody'),
  chapterProgressLabel: $('chapterProgressLabel'),
  chapterArcLabel: $('chapterArcLabel'),
  prevChapterTitle: $('prevChapterTitle'),
  nextChapterTitle: $('nextChapterTitle'),
  chapterPrevBottom: $('chapterPrevBottom'),
  chapterNextBottom: $('chapterNextBottom'),
  tocDialog: $('tocDialog'),
  tocHeading: $('tocHeading'),
  tocBookName: $('tocBookName'),
  tocSearch: $('tocSearch'),
  tocCount: $('tocCount'),
  tocList: $('tocList'),
  tocEmpty: $('tocEmpty'),
  settingsDialog: $('settingsDialog'),
  fontSizeRange: $('fontSizeRange'),
  fontSizeValue: $('fontSizeValue'),
  lineHeightRange: $('lineHeightRange'),
  lineHeightValue: $('lineHeightValue'),
  widthRange: $('widthRange'),
  widthValue: $('widthValue'),
  indentToggle: $('indentToggle'),
  resetSettingsBtn: $('resetSettingsBtn'),
  bookmarksDialog: $('bookmarksDialog'),
  currentBookmarkTitle: $('currentBookmarkTitle'),
  currentBookmarkMeta: $('currentBookmarkMeta'),
  toggleBookmarkBtn: $('toggleBookmarkBtn'),
  bookmarkList: $('bookmarkList'),
  bookmarkListCount: $('bookmarkListCount'),
  bookmarkEmpty: $('bookmarkEmpty'),
  notePopover: $('notePopover'),
  toast: $('toast'),
  toastText: $('toastText'),
};

const settings = loadSettings();
const state = {
  view: 'library',
  books: [],
  parsed: new Map(),
  booksLoaded: false,
  booksLoading: false,
  importing: false,
  search: '',
  book: null,
  parsedBook: null,
  imageUrls: new Map(),
  searchQuery: '',
  searchTimer: 0,
  chapters: [],
  chapter: null,
  prev: null,
  next: null,
  chapterLoading: false,
  openToken: 0,
  chapterToken: 0,
  tocNodes: [],
  tocGroups: [],
  tocTotalChars: 0,
  hasParts: false,
  lastOpenRequest: null,
  libraryScroll: 0,
  scrollTicking: false,
  lastScrollY: 0,
  barHidden: false,
  progressTimer: 0,
  toastTimer: 0,
};

/* ------------------------------------------------------------------ */
/* 本地存储与设置                                                     */
/* ------------------------------------------------------------------ */

function readStore(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    const value = JSON.parse(raw);
    return value && typeof value === 'object' ? value : fallback;
  } catch {
    return fallback;
  }
}

function writeStore(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* 本地存储不可用时不打断阅读 */ }
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function normalizeTheme(value) {
  if (value === 'dark' || value === 'light' || value === 'auto') return value;
  // 旧版阅读主题迁移：夜色 → 深色，纸色 / 茶色 → 浅色。
  if (value === 'night') return 'dark';
  if (value === 'paper' || value === 'sepia') return 'light';
  return 'auto';
}

function readSharedTheme() {
  try {
    const value = localStorage.getItem(SHARED_THEME_KEY);
    return THEME_ORDER.includes(value) ? value : null;
  } catch {
    return null;
  }
}

function persistSharedTheme(mode) {
  try { localStorage.setItem(SHARED_THEME_KEY, mode); } catch { /* 无法写入时仅影响跨页同步 */ }
}

function resolveTheme(mode) {
  if (mode === 'light' || mode === 'dark') return mode;
  return DARK_MEDIA && DARK_MEDIA.matches ? 'dark' : 'light';
}

function loadSettings() {
  const saved = readStore(SETTINGS_KEY, {});
  const savedFontValid = ['serif', 'sans', 'kai', 'wenkai'].includes(saved.font);
  const fontExplicit = saved.fontExplicit === true;
  let font = savedFontValid ? saved.font : DEFAULT_FONT;
  // 旧版默认使用宋体；Windows 用户没有主动选过字体时，迁移到更适合屏幕的雅黑。
  if (IS_WINDOWS && !fontExplicit && saved.font === 'serif') font = 'sans';
  // 与工作台首页共用 desk-theme；没有共享值时迁移旧版阅读主题。
  const sharedTheme = readSharedTheme();
  const savedWeight = Number(saved.weight);
  return {
    theme: sharedTheme || normalizeTheme(saved.theme),
    paper: PAPER_ORDER.includes(saved.paper) ? saved.paper : DEFAULT_SETTINGS.paper,
    mode: saved.mode === 'pager' ? 'pager' : 'scroll',
    font,
    fontExplicit,
    fontSize: clamp(Number(saved.fontSize) || DEFAULT_SETTINGS.fontSize, 16, 30),
    lineHeight: clamp(Number(saved.lineHeight) || DEFAULT_SETTINGS.lineHeight, 1.4, 2.4),
    width: clamp(Number(saved.width) || DEFAULT_SETTINGS.width, 560, 1120),
    indent: saved.indent !== false,
    weight: WEIGHTS.includes(savedWeight) ? savedWeight : 400,
  };
}

function persistSettings() {
  writeStore(SETTINGS_KEY, settings);
}

function applySettings() {
  const root = document.documentElement;
  const effectiveTheme = resolveTheme(settings.theme);
  root.dataset.themeMode = settings.theme;
  root.dataset.theme = effectiveTheme;
  root.dataset.paper = settings.paper;
  root.dataset.mode = settings.mode;
  root.dataset.font = settings.font;
  root.dataset.os = IS_WINDOWS ? 'windows' : 'other';
  root.style.setProperty('--reader-font-size', `${settings.fontSize}px`);
  root.style.setProperty('--reader-line-height', String(settings.lineHeight));
  root.style.setProperty('--reader-width', `${settings.width}px`);
  root.style.setProperty('--reader-indent', settings.indent ? '2em' : '0em');
  root.style.setProperty('--reader-body-weight', String(settings.weight));

  const metaTheme = document.querySelector('meta[name="theme-color"]');
  if (metaTheme) metaTheme.content = THEME_COLORS[effectiveTheme];

  $$('[data-set-theme]').forEach((button) => {
    const pressed = button.dataset.setTheme === settings.theme;
    button.setAttribute('aria-pressed', String(pressed));
    button.title = THEME_NAMES[button.dataset.setTheme] || '';
  });
  $$('[data-set-font]').forEach((button) => {
    button.setAttribute('aria-pressed', String(button.dataset.setFont === settings.font));
  });
  $$('[data-set-paper]').forEach((button) => {
    const pressed = button.dataset.setPaper === settings.paper;
    button.setAttribute('aria-pressed', String(pressed));
    button.title = PAPER_NAMES[button.dataset.setPaper] || '';
    button.disabled = effectiveTheme === 'dark';
  });
  $$('[data-set-weight]').forEach((button) => {
    const pressed = Number(button.dataset.setWeight) === settings.weight;
    button.setAttribute('aria-pressed', String(pressed));
    button.title = `字重 ${button.dataset.setWeight}`;
  });
  $$('[data-set-mode]').forEach((button) => {
    button.setAttribute('aria-pressed', String(button.dataset.setMode === settings.mode));
  });
  if (el.modeHint) {
    el.modeHint.textContent = settings.mode === 'pager'
      ? '点击翻页：左右点击翻页；支持时会进入全屏。'
      : '滚动阅读：上下滑动浏览。';
  }

  el.fontSizeRange.value = String(settings.fontSize);
  el.fontSizeValue.textContent = `${settings.fontSize} px`;
  el.lineHeightRange.value = String(settings.lineHeight);
  el.lineHeightValue.textContent = settings.lineHeight.toFixed(2);
  el.widthRange.value = String(settings.width);
  el.widthValue.textContent = `${settings.width} px`;
  el.indentToggle.checked = settings.indent;

  updateRangeFill(el.fontSizeRange);
  updateRangeFill(el.lineHeightRange);
  updateRangeFill(el.widthRange);
}

function updateRangeFill(input) {
  const min = Number(input.min);
  const max = Number(input.max);
  const value = Number(input.value);
  const fill = max === min ? 0 : ((value - min) / (max - min)) * 100;
  input.style.setProperty('--fill', `${fill}%`);
}

function changeSetting(key, value) {
  settings[key] = value;
  applySettings();
  persistSettings();
  if (key === 'theme') persistSharedTheme(value);
}

function bindSettings() {
  $$('[data-set-theme]').forEach((button) => {
    button.addEventListener('click', () => changeSetting('theme', button.dataset.setTheme));
  });
  $$('[data-set-font]').forEach((button) => {
    button.addEventListener('click', () => {
      settings.font = button.dataset.setFont;
      settings.fontExplicit = true;
      applySettings();
      persistSettings();
    });
  });

  $$('[data-set-paper]').forEach((button) => {
    button.addEventListener('click', () => changeSetting('paper', button.dataset.setPaper));
  });

  $$('[data-set-weight]').forEach((button) => {
    button.addEventListener('click', () => changeSetting('weight', Number(button.dataset.setWeight)));
  });

  $$('[data-set-mode]').forEach((button) => {
    button.addEventListener('click', () => {
      const mode = button.dataset.setMode === 'pager' ? 'pager' : 'scroll';
      changeSetting('mode', mode);
      if (mode === 'pager') {
        if (isMobileViewport()) requestReaderFullscreen();
      } else {
        exitReaderFullscreen();
      }
    });
  });

  el.fontSizeRange.addEventListener('input', () => {
    changeSetting('fontSize', Number(el.fontSizeRange.value));
  });
  el.lineHeightRange.addEventListener('input', () => {
    changeSetting('lineHeight', Number(el.lineHeightRange.value));
  });
  el.widthRange.addEventListener('input', () => {
    changeSetting('width', Number(el.widthRange.value));
  });
  el.indentToggle.addEventListener('change', () => {
    changeSetting('indent', el.indentToggle.checked);
  });

  el.resetSettingsBtn.addEventListener('click', () => {
    Object.assign(settings, DEFAULT_SETTINGS);
    settings.fontExplicit = false;
    applySettings();
    persistSettings();
    persistSharedTheme(settings.theme);
    exitReaderFullscreen();
    toast('已恢复默认格式');
  });

  const themeMedia = window.matchMedia('(prefers-color-scheme: dark)');
  const onSystemThemeChange = () => {
    if (settings.theme === 'auto') applySettings();
  };
  if (typeof themeMedia.addEventListener === 'function') {
    themeMedia.addEventListener('change', onSystemThemeChange);
  } else if (typeof themeMedia.addListener === 'function') {
    themeMedia.addListener(onSystemThemeChange);
  }

  window.addEventListener('storage', (event) => {
    if (event.key !== SHARED_THEME_KEY || !THEME_ORDER.includes(event.newValue)) return;
    settings.theme = event.newValue;
    applySettings();
    persistSettings();
  });
}

/* ------------------------------------------------------------------ */
/* 进度与书签存储                                                     */
/* ------------------------------------------------------------------ */

function readProgressStore() {
  const value = readStore(PROGRESS_KEY, {});
  return value && !Array.isArray(value) ? value : {};
}

function getSavedProgress(bookId) {
  const entry = readProgressStore()[bookId];
  if (!entry || !Number.isInteger(entry.chapter)) return null;
  return {
    chapter: Math.max(0, entry.chapter),
    ratio: clamp(Number(entry.ratio) || 0, 0, 1),
    updatedAt: Number(entry.updatedAt) || 0,
    chapterTitle: typeof entry.chapterTitle === 'string' ? entry.chapterTitle : '',
  };
}

function readBookmarkStore() {
  const value = readStore(BOOKMARKS_KEY, {});
  return value && !Array.isArray(value) ? value : {};
}

function getBookmarksFor(bookId) {
  const raw = readBookmarkStore()[bookId];
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((item) => item && Number.isInteger(item.chapter) && item.chapter >= 0)
    .map((item) => ({
      chapter: item.chapter,
      title: typeof item.title === 'string' ? item.title : '',
      ratio: clamp(Number(item.ratio) || 0, 0, 1),
      createdAt: Number(item.createdAt) || 0,
    }))
    .sort((a, b) => b.createdAt - a.createdAt);
}

function saveBookmarksFor(bookId, items) {
  const all = readBookmarkStore();
  all[bookId] = items;
  writeStore(BOOKMARKS_KEY, all);
}

function isCurrentChapterBookmarked() {
  if (!state.book || !state.chapter) return false;
  return getBookmarksFor(state.book.id).some((item) => item.chapter === state.chapter.index);
}

/* ------------------------------------------------------------------ */
/* 书库                                                               */
/* ------------------------------------------------------------------ */

const coverUrls = new Map();

function coverUrlFor(record) {
  if (!record.cover) return null;
  const cached = coverUrls.get(record.id);
  if (cached) return cached;
  const url = URL.createObjectURL(record.cover);
  coverUrls.set(record.id, url);
  return url;
}

function releaseCover(id) {
  const url = coverUrls.get(id);
  if (!url) return;
  URL.revokeObjectURL(url);
  coverUrls.delete(id);
}

function bookSummary(record) {
  return {
    id: record.id,
    filename: record.filename,
    title: record.title,
    author: record.author,
    format: record.format,
    chapterCount: record.chapterCount,
    hasCover: Boolean(record.cover),
    coverUrl: coverUrlFor(record),
  };
}

function sortedBooks() {
  const progress = readProgressStore();
  return [...state.books].sort((a, b) => {
    const aRecent = Number(progress[a.id]?.updatedAt) || 0;
    const bRecent = Number(progress[b.id]?.updatedAt) || 0;
    if (aRecent !== bRecent) return bRecent - aRecent;
    return a.title.localeCompare(b.title, 'zh-Hans-CN');
  });
}

let libraryPromise = null;

function ensureLibrary() {
  if (!libraryPromise) libraryPromise = loadBooks();
  return libraryPromise;
}

async function loadBooks({ manual = false, quiet = false } = {}) {
  if (state.booksLoading) return;
  state.booksLoading = true;
  el.refreshBooksBtn.disabled = true;
  el.refreshBooksBtn.classList.add('is-spinning');
  if (!quiet) {
    if (!state.booksLoaded) {
      el.libraryLoading.hidden = false;
      el.bookGrid.hidden = true;
      el.libraryEmpty.hidden = true;
      el.libraryError.hidden = true;
    }
    el.libraryStatus.textContent = '正在整理书架';
    el.shelfSummary.textContent = '正在读取书库…';
  }

  try {
    const records = await window.ReaderStore.all();
    records.sort((a, b) => (Number(b.addedAt) || 0) - (Number(a.addedAt) || 0));
    const alive = new Set(records.map((record) => record.id));
    for (const id of [...coverUrls.keys()]) {
      if (!alive.has(id)) releaseCover(id);
    }
    state.books = records.map(bookSummary);
    state.booksLoaded = true;
    el.libraryError.hidden = true;
    renderLibrary();
    if (manual) toast(`书库已更新，共 ${state.books.length} 本书`);
  } catch (error) {
    el.libraryLoading.hidden = true;
    el.bookGrid.hidden = true;
    if (state.booksLoaded) {
      toast(`刷新失败：${error.message}`);
    } else {
      el.libraryEmpty.hidden = true;
      el.libraryError.hidden = false;
      el.libraryErrorText.textContent = `${error.message}。`;
      el.libraryStatus.textContent = '书库未加载';
      el.shelfSummary.textContent = '读取书库失败';
    }
  } finally {
    state.booksLoading = false;
    el.refreshBooksBtn.disabled = false;
    el.refreshBooksBtn.classList.remove('is-spinning');
    if (state.booksLoaded) renderLibrary();
  }
}

/* ------------------------------------------------------------------ */
/* 导入与移除                                                         */
/* ------------------------------------------------------------------ */

async function importFiles(fileList) {
  const files = [...(fileList || [])].filter((file) => /\.(epub|txt|md|markdown)$/i.test(file.name));
  if (!files.length) {
    toast('只支持 EPUB、TXT 和 Markdown');
    return;
  }
  if (state.importing) {
    toast('正在导入，请稍候');
    return;
  }

  state.importing = true;
  el.importBtn.disabled = true;
  el.libraryStatus.textContent = '正在导入';
  el.shelfSummary.textContent = `正在解析 ${files.length} 个文件…`;

  let imported = 0;
  let failed = '';

  for (const file of files) {
    try {
      if (file.size > 64 * 1024 * 1024) throw new Error('文件超过 64 MB');
      const buffer = await file.arrayBuffer();
      const parsed = await window.ReaderLibrary.parse(file.name, buffer);
      const id = await window.ReaderLibrary.bookId(`${file.name}|${file.size}|${file.lastModified}`);
      await window.ReaderStore.save({
        id,
        filename: file.name,
        title: parsed.title,
        author: parsed.author || '',
        format: parsed.format,
        chapterCount: parsed.chapterCount,
        size: file.size,
        addedAt: Date.now(),
        cover: parsed.cover || null,
      }, file);
      state.parsed.delete(id);
      releaseCover(id);
      imported += 1;
    } catch (error) {
      failed = failed || `${file.name}：${error.message}`;
      console.warn(`[import] ${file.name}: ${error.message}`);
    }
  }

  state.importing = false;
  el.importBtn.disabled = false;
  if (imported) {
    await loadBooks({ quiet: true });
    toast(`已导入 ${imported} 本书`);
  }
  if (failed) toast(`导入失败：${failed}`);
}

async function removeBook(id, title) {
  if (!window.confirm(`从书架移除《${title}》？`)) return;
  try {
    if (state.book?.id === id) backToLibrary();
    await window.ReaderStore.remove(id);
    state.parsed.delete(id);
    releaseCover(id);
    const progress = readProgressStore();
    delete progress[id];
    writeStore(PROGRESS_KEY, progress);
    const bookmarks = readBookmarkStore();
    delete bookmarks[id];
    writeStore(BOOKMARKS_KEY, bookmarks);
    await loadBooks({ quiet: true });
    toast('已移除');
  } catch (error) {
    toast(`移除失败：${error.message}`);
  }
}

async function exportBookFile(id) {
  const record = state.books.find((item) => item.id === String(id));
  if (!record) return;
  try {
    const blob = await window.ReaderStore.file(record.id);
    if (!blob) {
      toast('找不到该书的文件');
      return;
    }
    const ext = record.format || 'txt';
    const filename = record.filename || `${record.title}.${ext}`;
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      a.remove();
      URL.revokeObjectURL(url);
    }, 1200);
    toast(`已导出《${record.title}》`);
  } catch (error) {
    toast(`导出失败：${error.message || '未知错误'}`);
  }
}

async function updateStorageSummary(totalChapters) {
  if (state.search.trim() || !state.books.length) return;
  try {
    if (navigator.storage && navigator.storage.estimate) {
      const { usage } = await navigator.storage.estimate();
      if (usage && usage > 0) {
        const mb = (usage / (1024 * 1024)).toFixed(1);
        el.shelfSummary.textContent = `${state.books.length} 本书 · ${formatNumber(totalChapters)} 章 · 约 ${mb} MB`;
      }
    }
  } catch {}
}

function renderLibrary() {
  if (!state.booksLoaded) return;
  el.libraryLoading.hidden = true;
  el.libraryError.hidden = true;

  const query = state.search.trim().toLocaleLowerCase('zh-CN');
  const sorted = sortedBooks();
  const filtered = query
    ? sorted.filter((book) => `${book.title} ${book.author || ''} ${book.format}`.toLocaleLowerCase('zh-CN').includes(query))
    : sorted;

  const totalChapters = state.books.reduce((sum, book) => sum + (Number(book.chapterCount) || 0), 0);
  el.libraryStatus.textContent = state.books.length ? `${state.books.length} 本书` : '等待入书';
  el.shelfSummary.textContent = query
    ? `找到 ${filtered.length} 本${state.books.length ? ` · 共 ${state.books.length} 本` : ''}`
    : state.books.length
      ? `${state.books.length} 本书 · ${formatNumber(totalChapters)} 章`
      : '书架还空着，放一本书进来吧';

  if (!query && state.books.length) {
    updateStorageSummary(totalChapters);
  }

  if (!state.books.length) {
    el.bookGrid.hidden = true;
    el.bookGrid.replaceChildren();
    el.libraryEmpty.hidden = false;
    el.libraryEmptyTitle.textContent = '书架还是空的';
    el.libraryEmptyText.textContent = '把 .epub 或 .txt 拖进来，或点「导入书籍」。';
    el.emptyImportBtn.hidden = false;
    return;
  }

  if (!filtered.length) {
    el.bookGrid.hidden = true;
    el.bookGrid.replaceChildren();
    el.libraryEmpty.hidden = false;
    el.libraryEmptyTitle.textContent = '没有找到这本书';
    el.libraryEmptyText.textContent = '换一个书名或作者试试。';
    el.emptyImportBtn.hidden = true;
    return;
  }

  el.libraryEmpty.hidden = true;
  el.bookGrid.hidden = false;
  const progress = readProgressStore();
  el.bookGrid.replaceChildren(...filtered.map((book, index) => createBookCard(book, progress[book.id], index)));
}

function createBookCard(book, rawProgress, index) {
  const card = document.createElement('article');
  card.className = 'book-card';
  card.dataset.bookId = book.id;
  card.style.setProperty('--index', String(index));

  const openButton = document.createElement('button');
  openButton.type = 'button';
  openButton.className = 'book-open';
  openButton.setAttribute('aria-label', `阅读《${book.title}》，${book.format.toUpperCase()}，共 ${book.chapterCount} 章`);

  const cover = document.createElement('div');
  const tone = toneForId(book.id);
  cover.className = `book-cover cover-tone-${tone}`;

  const fallback = document.createElement('div');
  fallback.className = 'cover-fallback';
  fallback.dataset.mark = firstCharacter(book.title);

  const coverTop = document.createElement('span');
  coverTop.className = 'cover-top';
  coverTop.textContent = '阅读';
  const copy = document.createElement('div');
  copy.className = 'cover-copy';
  const coverTitle = document.createElement('h3');
  coverTitle.textContent = book.title;
  const coverAuthor = document.createElement('p');
  coverAuthor.textContent = book.author || 'LOCAL LIBRARY';
  copy.append(coverTitle, coverAuthor);
  fallback.append(coverTop, copy);

  const format = document.createElement('span');
  format.className = 'cover-format';
  format.textContent = String(book.format || '').toUpperCase();

  cover.append(fallback, format);

  if (book.hasCover && book.coverUrl) {
    const image = document.createElement('img');
    image.className = 'book-cover-image';
    image.src = book.coverUrl;
    image.alt = '';
    image.loading = 'lazy';
    image.decoding = 'async';
    image.addEventListener('error', () => {
      image.remove();
      cover.classList.remove('has-image');
    });
    cover.append(image);
    cover.classList.add('has-image');
  }

  const info = document.createElement('div');
  info.className = 'book-info';
  const title = document.createElement('h3');
  title.className = 'book-title';
  title.textContent = book.title;
  title.title = book.title;

  const byline = document.createElement('p');
  byline.className = 'book-byline';
  const author = document.createElement('span');
  author.textContent = book.author || '佚名';
  const dot = document.createElement('span');
  dot.className = 'dot';
  const formatText = document.createElement('span');
  formatText.textContent = String(book.format || '').toUpperCase();
  const dot2 = document.createElement('span');
  dot2.className = 'dot';
  const chapters = document.createElement('span');
  chapters.textContent = `${formatNumber(book.chapterCount)} 章`;
  byline.append(author, dot, formatText, dot2, chapters);

  const progressLine = document.createElement('p');
  progressLine.className = 'book-card-progress';
  const progressBar = document.createElement('div');
  progressBar.className = 'book-progress-bar';
  const progressFill = document.createElement('span');

  if (rawProgress && Number.isInteger(rawProgress.chapter)) {
    const chapterIndex = clamp(rawProgress.chapter, 0, Math.max(0, book.chapterCount - 1));
    const ratio = clamp(Number(rawProgress.ratio) || 0, 0, 1);
    const percent = book.chapterCount ? ((chapterIndex + ratio) / book.chapterCount) * 100 : 0;
    progressLine.append(document.createTextNode('上次读到 '));
    const strong = document.createElement('strong');
    const savedTitle = typeof rawProgress.chapterTitle === 'string' && rawProgress.chapterTitle.trim()
      ? rawProgress.chapterTitle
      : `第 ${formatNumber(chapterIndex + 1)} 章`;
    strong.textContent = savedTitle;
    strong.title = savedTitle;
    progressLine.append(strong, document.createTextNode(` · ${formatPercent(percent)}`));
    progressFill.style.width = `${clamp(percent, 0.4, 100)}%`;
    progressBar.append(progressFill);
  } else {
    progressLine.textContent = '尚未开始 · 点击翻开';
    progressBar.hidden = true;
  }

  info.append(title, byline, progressLine, progressBar);
  openButton.append(cover, info);

  const actions = document.createElement('div');
  actions.className = 'book-card-actions';

  const exportButton = document.createElement('button');
  exportButton.type = 'button';
  exportButton.className = 'book-action-btn book-export';
  exportButton.dataset.exportBook = book.id;
  exportButton.setAttribute('aria-label', `导出《${book.title}》文件`);
  exportButton.setAttribute('title', '导出原文件');
  exportButton.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/></svg>';

  const removeButton = document.createElement('button');
  removeButton.type = 'button';
  removeButton.className = 'book-action-btn book-remove';
  removeButton.dataset.removeBook = book.id;
  removeButton.setAttribute('aria-label', `移除《${book.title}》`);
  removeButton.setAttribute('title', '从书架移除');
  removeButton.textContent = '移除';

  actions.append(exportButton, removeButton);
  card.append(openButton, actions);
  return card;
}

function toneForId(id) {
  let hash = 0;
  for (const char of String(id)) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return hash % 6;
}

function firstCharacter(value) {
  return [...String(value || '书')][0] || '书';
}

function formatNumber(value) {
  return new Intl.NumberFormat('zh-CN').format(Number(value) || 0);
}

function formatWordCount(value) {
  const count = Number(value) || 0;
  if (count >= 10000) return `${(count / 10000).toFixed(1)} 万字`;
  return `${formatNumber(Math.max(1, Math.round(count / 1000)))} 千字`;
}

function formatPercent(value) {
  const number = Number(value) || 0;
  if (number > 0 && number < 10) return `${number.toFixed(1)}%`;
  return `${Math.round(number)}%`;
}

function annotateChapterPositions(chapters) {
  const groups = [];
  let currentPart = null;
  for (const chapter of chapters) {
    const part = chapter.part || '';
    if (!groups.length || part !== currentPart) {
      groups.push({ part, chapters: [] });
      currentPart = part;
    }
    groups[groups.length - 1].chapters.push(chapter);
  }
  for (const group of groups) {
    group.chapters.forEach((chapter, index) => {
      chapter.inPart = index + 1;
      chapter.partCount = group.chapters.length;
    });
  }
}

function chapterPartName(chapter) {
  return chapter?.part || '卷首';
}

function chapterUnit(chapter) {
  return chapter?.part ? '章' : '篇';
}

function chapterDisplayLabel(chapter, fallbackIndex = 0) {
  if (!chapter) return `第 ${fallbackIndex + 1} 章`;
  if (!state.hasParts || !chapter.part) return chapter.title;
  return `${chapter.part} · ${chapter.title}`;
}

function chapterLabelAt(index) {
  const chapter = state.chapters[index];
  if (!chapter) return `第 ${index + 1} 章`;
  if (!state.hasParts || !chapter.part) return chapter.title;
  if (state.chapter && state.chapter.part === chapter.part) return chapter.title;
  return `${chapter.part} · ${chapter.title}`;
}

function chapterPositionLabel(chapterOrIndex) {
  const chapter = typeof chapterOrIndex === 'number' ? state.chapters[chapterOrIndex] : chapterOrIndex;
  if (!chapter) return '';
  if (!state.hasParts) {
    return `第 ${formatNumber(chapter.index + 1)} / ${formatNumber(state.chapters.length)} 章`;
  }
  return `${chapterPartName(chapter)} · 第 ${formatNumber(chapter.inPart)} / ${formatNumber(chapter.partCount)} ${chapterUnit(chapter)}`;
}

/* ------------------------------------------------------------------ */
/* 视图切换与打开书籍                                                 */
/* ------------------------------------------------------------------ */

function setView(view) {
  state.view = view;
  const reader = view === 'reader';
  el.libraryView.hidden = reader;
  el.readerView.hidden = !reader;
  document.body.classList.toggle('reading-mode', reader);
  document.documentElement.classList.toggle('reading-mode', reader);
  setReaderBarHidden(false);
  state.lastScrollY = window.scrollY;
  const skip = document.querySelector('.skip-link');
  if (skip) skip.href = reader ? '#chapterBody' : '#mainContent';
  if (!reader) {
    closeAllDialogs();
    exitReaderFullscreen();
  }
}

function showReaderOpening() {
  el.readerLoading.hidden = false;
  el.readerError.hidden = true;
  el.chapterArticle.hidden = true;
  el.readerMain.classList.remove('is-loading');
  el.readerBookTitle.textContent = '正在打开';
  el.readerBookMeta.textContent = '';
  setNavDisabled(true);
  el.bookProgressBar.style.width = '0%';
  el.bookmarkCount.hidden = true;
  el.openBookmarksBtn.classList.remove('has-bookmark');
  closeAllDialogs();
  window.scrollTo(0, 0);
}

function showReaderError(message) {
  state.chapterLoading = false;
  el.readerLoading.hidden = true;
  el.chapterArticle.hidden = true;
  el.readerError.hidden = false;
  el.readerMain.classList.remove('is-loading');
  el.readerErrorText.textContent = `${message}。请稍后重试，或返回书架。`;
  setNavDisabled(true);
}

function setReaderBar(book) {
  el.readerBookTitle.textContent = book.title;
  el.readerBookTitle.title = book.title;
  const pieces = [];
  if (book.author) pieces.push(book.author);
  pieces.push(String(book.format || '').toUpperCase());
  pieces.push(`${formatNumber(book.chapterCount)} 章`);
  el.readerBookMeta.textContent = pieces.join(' · ');
}

function clearChapterImages() {
  for (const url of state.imageUrls.values()) {
    try { URL.revokeObjectURL(url); } catch {}
  }
  state.imageUrls.clear();
}

function getImageUrl(path) {
  if (!state.parsedBook?.images) return null;
  const normalized = String(path || '').replace(/^\/+/, '');
  if (state.imageUrls.has(normalized)) return state.imageUrls.get(normalized);
  const blob = state.parsedBook.images.get(normalized);
  if (!blob) return null;
  const url = URL.createObjectURL(blob);
  state.imageUrls.set(normalized, url);
  return url;
}

function setNavDisabled(disabled) {
  el.chapterPrevTop.disabled = disabled;
  el.chapterNextTop.disabled = disabled;
  el.chapterPrevBottom.disabled = disabled;
  el.chapterNextBottom.disabled = disabled;
}

async function openBook(bookId, chapterIndex = null, options = {}) {
  await ensureLibrary();
  const record = state.books.find((book) => book.id === String(bookId));
  if (!record) {
    toast('没有找到这本书');
    return;
  }

  if (state.book) saveProgressNow();
  clearChapterImages();
  state.openToken += 1;
  state.chapterToken += 1;
  const token = state.openToken;

  state.lastOpenRequest = { bookId, chapterIndex };
  state.book = null;
  state.parsedBook = null;
  state.chapters = [];
  state.chapter = null;
  state.prev = null;
  state.next = null;
  state.tocNodes = [];
  state.tocGroups = [];
  state.hasParts = false;
  state.libraryScroll = window.scrollY;
  state.chapterLoading = false;

  setView('reader');
  showReaderOpening();
  document.title = '正在打开 · 阅读';

  try {
    if (token !== state.openToken) return;

    let parsed = state.parsed.get(record.id);
    if (!parsed) {
      const blob = await window.ReaderStore.file(record.id);
      if (!blob) throw new Error('书文件已丢失，请重新导入');
      parsed = await window.ReaderLibrary.parse(record.filename || record.title, await blob.arrayBuffer());
      if (token !== state.openToken) return;
      parsed.id = record.id;
      state.parsed.set(record.id, parsed);
    }
    if (!parsed.chapters.length) throw new Error('这本书没有可读取的章节');

    state.parsedBook = parsed;
    const chapterCount = parsed.chapters.length;
    if (Number(record.chapterCount) !== chapterCount) {
      record.chapterCount = chapterCount;
      window.ReaderStore.update(record.id, { chapterCount }).catch(() => {});
    }
    state.book = { ...record, chapterCount };
    state.chapters = parsed.chapters.map((chapter, index) => ({
      index,
      title: chapter.title,
      part: chapter.part || '',
      chars: chapter.chars,
    }));
    state.hasParts = state.chapters.some((chapter) => chapter.part);
    annotateChapterPositions(state.chapters);
    state.tocTotalChars = state.chapters.reduce((sum, chapter) => sum + (Number(chapter.chars) || 0), 0);
    setReaderBar(state.book);
    buildToc();
    updateBookmarkBadge();

    const total = state.chapters.length;
    const saved = getSavedProgress(state.book.id);
    let target = Number.isInteger(chapterIndex) ? chapterIndex : (saved?.chapter ?? 0);
    target = clamp(target, 0, total - 1);

    let ratio = 0;
    if (saved && saved.chapter === target) ratio = saved.ratio;
    if (options.scrollRatio != null) ratio = clamp(Number(options.scrollRatio) || 0, 0, 1);
    const resumed = Boolean(saved && !Number.isInteger(chapterIndex) && target === saved.chapter && target > 0);

    await loadChapter(target, { scrollRatio: ratio, initial: true });
    if (token !== state.openToken) return;
    if (resumed) toast(`已回到上次读到的${chapterDisplayLabel(state.chapter)}`);
  } catch (error) {
    if (token !== state.openToken) return;
    state.book = null;
    state.chapters = [];
    showReaderError(error.message || '无法打开这本书');
    el.readerBookTitle.textContent = '无法打开';
    el.readerBookMeta.textContent = '';
    document.title = '打开失败 · 阅读';
  }
}

function backToLibrary() {
  if (state.view !== 'reader') return;
  saveProgressNow();
  if (notePopoverAnchor) hideNotePopover({ immediate: true, blur: true });
  clearChapterImages();
  state.openToken += 1;
  state.chapterToken += 1;
  state.chapterLoading = false;
  state.book = null;
  state.parsedBook = null;
  state.chapters = [];
  state.chapter = null;
  state.prev = null;
  state.next = null;
  state.tocNodes = [];
  state.tocGroups = [];
  state.hasParts = false;
  closeAllDialogs();
  setView('library');
  removeRouteHash();
  document.title = '阅读';
  el.bookProgressBar.style.width = '0%';
  renderLibrary();

  const previousScroll = state.libraryScroll;
  requestAnimationFrame(() => {
    window.scrollTo(0, previousScroll);
    const card = el.bookGrid.querySelector('.book-card');
    const target = card?.querySelector('.book-open');
    if (target) target.focus({ preventScroll: true });
  });
}

/* ------------------------------------------------------------------ */
/* 章节                                                               */
/* ------------------------------------------------------------------ */

async function loadChapter(index, options = {}) {
  if (!state.book || !state.chapters.length) return;
  const total = state.chapters.length;
  const target = clamp(Number(index) || 0, 0, total - 1);
  if (!Number.isInteger(target)) return;

  const previousChapter = state.chapter;
  const sameChapter = Boolean(previousChapter && previousChapter.index === target);
  if (previousChapter && !sameChapter) saveProgressNow();

  state.chapterToken += 1;
  state.chapterLoading = true;

  if (!previousChapter) {
    el.readerLoading.hidden = false;
    el.readerError.hidden = true;
    el.chapterArticle.hidden = true;
  } else {
    el.readerMain.classList.add('is-loading');
  }

  try {
    const parsed = state.parsed.get(state.book.id);
    const full = parsed?.chapters[target];
    if (!full) throw new Error('章节内容为空');

    const summary = state.chapters[target];
    state.chapter = {
      index: target,
      title: full.title,
      part: summary?.part || full.part || '',
      inPart: summary?.inPart || 1,
      partCount: summary?.partCount || 1,
      paragraphs: full.paragraphs,
      chars: full.chars,
      notes: full.notes || [],
    };
    state.prev = target > 0 ? target - 1 : null;
    state.next = target < total - 1 ? target + 1 : null;
    state.chapterLoading = false;

    renderChapter();
    el.readerLoading.hidden = true;
    el.readerError.hidden = true;
    el.chapterArticle.hidden = false;
    el.readerMain.classList.remove('is-loading');
    updateTocCurrent();
    updateBookmarkBadge();
    if (el.bookmarksDialog.open) renderBookmarks();
    setRouteHash(target, options.initial);
    document.title = `${chapterDisplayLabel(state.chapter)} · ${state.book.title} · 阅读`;

    const restoreRatio = options.scrollRatio;
    requestAnimationFrame(() => {
      if (restoreRatio != null) {
        scrollToRatio(clamp(Number(restoreRatio) || 0, 0, 1));
      } else if (!sameChapter) {
        window.scrollTo(0, 0);
      }
      updateProgressVisual();
      window.setTimeout(saveProgressNow, 40);
    });
  } catch (error) {
    state.chapterLoading = false;
    el.readerMain.classList.remove('is-loading');
    if (!previousChapter) {
      showReaderError(error.message || '章节加载失败');
      document.title = '加载失败 · 阅读';
    } else {
      toast(`章节加载失败：${error.message}`);
    }
  }
}

function appendNoteRuns(parent, runs) {
  for (const run of runs || []) {
    if (run?.type === 'note') {
      if (run.label) parent.append(document.createTextNode(run.label));
    } else if (run?.text) {
      parent.append(document.createTextNode(run.text));
    }
  }
}

let notePopoverAnchor = null;
let notePopoverHideTimer = 0;
let notePopoverHover = false;
let notePopoverFocus = false;
let notePopoverToken = 0;

function positionNotePopover(link) {
  if (!el.notePopover || el.notePopover.hidden) return;
  const margin = 12;
  const gap = 10;
  const rect = link.getBoundingClientRect();
  const popover = el.notePopover.getBoundingClientRect();
  let left = rect.left + rect.width / 2 - popover.width / 2;
  left = clamp(left, margin, Math.max(margin, window.innerWidth - popover.width - margin));
  let top = rect.top - popover.height - gap;
  let placement = 'top';
  if (top < margin) {
    top = rect.bottom + gap;
    placement = 'bottom';
  }
  const maxTop = window.innerHeight - popover.height - margin;
  if (top > maxTop) top = Math.max(margin, maxTop);
  el.notePopover.style.left = `${Math.round(left)}px`;
  el.notePopover.style.top = `${Math.round(top)}px`;
  el.notePopover.dataset.placement = placement;
}

function finishHideNotePopover(token, anchor) {
  if (token !== notePopoverToken) return;
  el.notePopover.classList.remove('is-visible');
  if (anchor) anchor.removeAttribute('aria-describedby');
  if (notePopoverAnchor === anchor) notePopoverAnchor = null;
  window.setTimeout(() => {
    if (!el.notePopover.classList.contains('is-visible')) el.notePopover.hidden = true;
  }, 150);
}

function hideNotePopover({ immediate = false, blur = false } = {}) {
  window.clearTimeout(notePopoverHideTimer);
  const anchor = notePopoverAnchor;
  if (!anchor) return;
  const token = ++notePopoverToken;
  notePopoverHover = false;
  notePopoverFocus = false;
  if (blur && anchor === document.activeElement) anchor.blur();
  if (immediate) finishHideNotePopover(token, anchor);
  else notePopoverHideTimer = window.setTimeout(() => finishHideNotePopover(token, anchor), 140);
}

function scheduleHideNotePopover() {
  if (!notePopoverAnchor || notePopoverHover || notePopoverFocus) return;
  window.clearTimeout(notePopoverHideTimer);
  notePopoverHideTimer = window.setTimeout(() => hideNotePopover(), 160);
}

function showNotePopover(link) {
  if (!link || !el.notePopover) return;
  const index = Number(link.dataset.noteIndex);
  const note = Number.isInteger(index) ? state.chapter?.notes?.[index] : null;
  if (!note) return;
  window.clearTimeout(notePopoverHideTimer);
  notePopoverToken += 1;
  if (notePopoverAnchor && notePopoverAnchor !== link) notePopoverAnchor.removeAttribute('aria-describedby');
  notePopoverAnchor = link;

  const label = document.createElement('span');
  label.className = 'note-popover-label';
  label.textContent = note.label || `[${index + 1}]`;
  const text = document.createElement('span');
  text.className = 'note-popover-text';
  if (Array.isArray(note.runs) && note.runs.length) appendNoteRuns(text, note.runs);
  else text.textContent = note.text || '';

  el.notePopover.replaceChildren(label, text);
  el.notePopover.hidden = false;
  el.notePopover.classList.add('is-visible');
  link.setAttribute('aria-describedby', 'notePopover');
  positionNotePopover(link);
}

function createParagraph(paragraph, noteApi) {
  if (typeof paragraph === 'string') {
    const p = document.createElement('p');
    p.textContent = paragraph;
    return p;
  }

  const runs = Array.isArray(paragraph?.runs) ? paragraph.runs : [];
  if (!runs.length) return null;

  if (runs.length === 1 && runs[0].type === 'image') {
    const run = runs[0];
    const url = getImageUrl(run.path);
    if (!url) return null;
    const figure = document.createElement('figure');
    figure.className = 'chapter-figure';
    const img = document.createElement('img');
    img.className = 'chapter-image';
    img.src = url;
    img.alt = run.alt || '';
    img.loading = 'lazy';
    figure.append(img);
    if (run.alt) {
      const caption = document.createElement('figcaption');
      caption.className = 'chapter-caption';
      caption.textContent = run.alt;
      figure.append(caption);
    }
    return figure;
  }

  let container;
  const kind = paragraph.kind || 'p';
  if (kind === 'quote') {
    container = document.createElement('blockquote');
    container.className = 'chapter-quote';
  } else if (kind === 'code') {
    const pre = document.createElement('pre');
    pre.className = 'chapter-code';
    container = document.createElement('code');
    pre.append(container);
  } else if (kind === 'subheading') {
    container = document.createElement('h3');
    container.className = 'chapter-subheading';
  } else {
    container = document.createElement('p');
  }

  for (const run of runs) {
    if (run?.type === 'note') {
      const label = run.label || '[注]';
      const noteIndex = noteApi.indexById.get(run.noteId);
      if (noteIndex == null) {
        const sup = document.createElement('sup');
        sup.className = 'note-ref is-missing';
        const marker = document.createElement('span');
        marker.textContent = label;
        sup.append(marker);
        container.append(sup);
        continue;
      }

      const sup = document.createElement('sup');
      sup.className = 'note-ref';
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'note-link';
      button.textContent = label;
      button.dataset.noteIndex = String(noteIndex);
      button.setAttribute('aria-label', `查看注释 ${label.replace(/^[\[(（]|[\]）)]$/g, '')}`);
      sup.append(button);
      container.append(sup);
    } else if (run?.type === 'image') {
      const url = getImageUrl(run.path);
      if (url) {
        const img = document.createElement('img');
        img.className = 'chapter-inline-image';
        img.src = url;
        img.alt = run.alt || '';
        img.loading = 'lazy';
        container.append(img);
      }
    } else if (run?.text) {
      let node = document.createTextNode(run.text);
      if (run.code && kind !== 'code') {
        const c = document.createElement('code');
        c.append(node);
        node = c;
      }
      if (run.italic) {
        const em = document.createElement('em');
        em.append(node);
        node = em;
      }
      if (run.bold) {
        const strong = document.createElement('strong');
        strong.append(node);
        node = strong;
      }
      container.append(node);
    }
  }

  const result = kind === 'code' ? container.parentElement : container;
  return container.hasChildNodes() ? result : null;
}

function renderChapter() {
  const chapter = state.chapter;
  const book = state.book;
  if (!chapter || !book) return;
  const total = state.chapters.length;

  const unit = state.hasParts ? chapterUnit(chapter) : '章';
  el.chapterKicker.textContent = state.hasParts
    ? chapterPartName(chapter)
    : `CHAPTER ${String(chapter.index + 1).padStart(3, '0')}`;
  el.chapterKicker.classList.toggle('is-part', state.hasParts);
  el.chapterStats.textContent = state.hasParts
    ? `${formatNumber(chapter.chars)} 字 · 第 ${formatNumber(chapter.inPart)} / ${formatNumber(chapter.partCount)} ${unit}`
    : `${formatNumber(chapter.chars)} 字 · 第 ${formatNumber(chapter.index + 1)} / ${formatNumber(total)} 章`;
  el.chapterTitle.textContent = chapter.title;

  const notes = chapter.notes || [];
  const noteApi = {
    indexById: new Map(notes.map((note, index) => [note.id, index])),
  };
  if (notePopoverAnchor) hideNotePopover({ immediate: true, blur: true });
  const fragment = document.createDocumentFragment();
  for (const paragraph of chapter.paragraphs) {
    const p = createParagraph(paragraph, noteApi);
    if (p) fragment.append(p);
  }
  el.chapterBody.replaceChildren(fragment);

  const previousTitle = state.prev == null ? '已是开篇' : chapterLabelAt(state.prev);
  const nextTitle = state.next == null ? '已是终章' : chapterLabelAt(state.next);
  el.prevChapterTitle.textContent = previousTitle;
  el.nextChapterTitle.textContent = nextTitle;
  el.prevChapterTitle.title = previousTitle;
  el.nextChapterTitle.title = nextTitle;

  el.chapterPrevTop.disabled = state.prev == null;
  el.chapterNextTop.disabled = state.next == null;
  el.chapterPrevBottom.disabled = state.prev == null;
  el.chapterNextBottom.disabled = state.next == null;

  el.chapterProgressLabel.textContent = state.hasParts
    ? chapterPositionLabel(chapter)
    : `第 ${formatNumber(chapter.index + 1)} / ${formatNumber(total)} 章`;
  el.chapterArcLabel.textContent = book.title;
  el.chapterArcLabel.title = book.title;

  updateProgressVisual();
  el.readerLoading.hidden = true;
  el.readerError.hidden = true;
}

function goToPreviousChapter() {
  if (state.prev == null) return;
  loadChapter(state.prev);
}

function goToNextChapter() {
  if (state.next == null) return;
  loadChapter(state.next);
}

/* ------------------------------------------------------------------ */
/* 阅读进度                                                           */
/* ------------------------------------------------------------------ */

function focusOffset() {
  return Math.min(window.innerHeight * 0.3, 260);
}

function currentScrollRatio() {
  if (!state.chapter || !el.chapterBody || el.chapterArticle.hidden) return 0;
  if (window.scrollY <= 0) return 0;
  const bodyTop = el.chapterBody.getBoundingClientRect().top + window.scrollY;
  const bodyHeight = Math.max(1, el.chapterBody.offsetHeight);
  const point = window.scrollY + focusOffset() - bodyTop;
  return clamp(point / bodyHeight, 0, 1);
}

function scrollToRatio(ratio) {
  if (!state.chapter || !el.chapterBody) return;
  const normalized = clamp(Number(ratio) || 0, 0, 1);
  if (normalized < 0.004) {
    window.scrollTo(0, 0);
    return;
  }
  const bodyTop = el.chapterBody.getBoundingClientRect().top + window.scrollY;
  const bodyHeight = Math.max(1, el.chapterBody.offsetHeight);
  const y = bodyTop + normalized * bodyHeight - focusOffset();
  window.scrollTo(0, Math.max(0, y));
}

function updateProgressVisual() {
  if (!state.book || !state.chapter || !state.chapters.length) {
    el.bookProgressBar.style.width = '0%';
    return;
  }
  const total = state.chapters.length;
  const ratio = currentScrollRatio();
  const percent = ((state.chapter.index + ratio) / total) * 100;
  const normalized = clamp(percent, 0, 100);
  el.bookProgressBar.style.width = `${normalized}%`;
}

function saveProgressNow() {
  if (!state.book || !state.chapter) return;
  const ratio = currentScrollRatio();
  const progress = readProgressStore();
  progress[state.book.id] = {
    chapter: state.chapter.index,
    ratio: Number(ratio.toFixed(4)),
    updatedAt: Date.now(),
    chapterTitle: chapterDisplayLabel(state.chapter),
  };
  writeStore(PROGRESS_KEY, progress);
  updateProgressVisual();
}

function scheduleProgressSave() {
  if (!state.book || !state.chapter) return;
  window.clearTimeout(state.progressTimer);
  state.progressTimer = window.setTimeout(saveProgressNow, 450);
}

function setReaderBarHidden(hidden) {
  if (state.barHidden === hidden) return;
  state.barHidden = hidden;
  el.readerView.classList.toggle('is-bar-hidden', hidden);
  if (el.readerBar) el.readerBar.inert = hidden;
}

function isMobileViewport() {
  return window.matchMedia('(max-width: 720px)').matches;
}

function currentFullscreenElement() {
  return document.fullscreenElement || document.webkitFullscreenElement || null;
}

function requestReaderFullscreen() {
  if (currentFullscreenElement()) return;
  const target = document.documentElement;
  const request = target.requestFullscreen || target.webkitRequestFullscreen;
  if (!request) {
    toast('当前浏览器不支持网页全屏');
    return;
  }
  try {
    const result = request.call(target, { navigationUI: 'hide' });
    if (result && typeof result.catch === 'function') {
      result.catch(() => toast('无法进入全屏'));
    }
  } catch {
    toast('无法进入全屏');
  }
}

function exitReaderFullscreen() {
  if (!currentFullscreenElement()) return;
  const exit = document.exitFullscreen || document.webkitExitFullscreen;
  if (!exit) return;
  try {
    const result = exit.call(document);
    if (result && typeof result.catch === 'function') result.catch(() => {});
  } catch { /* 退出失败时保持当前状态 */ }
}

function readingEndY() {
  const end = document.querySelector('.chapter-end');
  return end ? end.getBoundingClientRect().bottom + window.scrollY : document.documentElement.scrollHeight;
}

function turnReadingPage(direction) {
  const barHeight = state.barHidden ? 0 : (el.readerBar?.offsetHeight || 0);
  const step = Math.max(120, window.innerHeight - barHeight - 28);

  if (direction > 0) {
    if (window.scrollY + window.innerHeight >= readingEndY() - 8) {
      if (state.next != null) loadChapter(state.next);
      else toast('已是终章');
      return;
    }
    window.scrollBy({ top: step, behavior: 'smooth' });
    return;
  }

  if (window.scrollY <= 8) {
    if (state.prev != null) loadChapter(state.prev, { scrollRatio: 1 });
    else toast('已是开篇');
    return;
  }
  window.scrollBy({ top: -step, behavior: 'smooth' });
}

function handleReadingTap(event) {
  if (settings.mode !== 'pager' || state.view !== 'reader' || !state.chapter) return;
  if (event.defaultPrevented || document.querySelector('dialog[open]')) return;
  if (event.target.closest?.('a, button, input, select, textarea, label, summary, [role="button"], [contenteditable="true"]')) return;

  const selection = window.getSelection();
  if (selection && !selection.isCollapsed && String(selection).trim()) return;

  const ratio = event.clientX / Math.max(1, window.innerWidth);
  if (ratio < 0.3) turnReadingPage(-1);
  else if (ratio > 0.7) turnReadingPage(1);
  else if (state.barHidden) setReaderBarHidden(false);
}

function updateReaderBarVisibility() {
  const mobile = window.matchMedia('(max-width: 720px)').matches;
  if (!mobile) {
    setReaderBarHidden(false);
    state.lastScrollY = window.scrollY;
    return;
  }
  const y = Math.max(0, window.scrollY);
  const delta = y - state.lastScrollY;
  if (y < 24) {
    setReaderBarHidden(false);
    state.lastScrollY = y;
  } else if (delta > 8) {
    setReaderBarHidden(true);
    state.lastScrollY = y;
  } else if (delta < -8) {
    setReaderBarHidden(false);
    state.lastScrollY = y;
  }
}

function handleScroll() {
  if (!state.book || !state.chapter) return;
  if (notePopoverAnchor) hideNotePopover({ immediate: true, blur: true });
  updateReaderBarVisibility();
  if (!state.scrollTicking) {
    state.scrollTicking = true;
    requestAnimationFrame(() => {
      state.scrollTicking = false;
      updateProgressVisual();
    });
  }
  scheduleProgressSave();
}

/* ------------------------------------------------------------------ */
/* 目录                                                               */
/* ------------------------------------------------------------------ */

function tocGroupsFor(chapters) {
  if (!state.hasParts) return [{ label: '', unit: '章', chapters }];
  const groups = [];
  let currentPart = null;
  for (const chapter of chapters) {
    const part = chapter.part || '';
    if (!groups.length || part !== currentPart) {
      groups.push({
        label: part || '卷首',
        unit: part ? '章' : '篇',
        chapters: [],
      });
      currentPart = part;
    }
    groups[groups.length - 1].chapters.push(chapter);
  }
  return groups;
}

function buildToc() {
  state.tocNodes = [];
  state.tocGroups = [];
  const fragment = document.createDocumentFragment();
  el.tocBookName.textContent = state.book?.title || '';
  el.tocSearch.value = '';
  const grouped = state.hasParts;

  for (const group of tocGroupsFor(state.chapters)) {
    const groupRecord = { label: group.label, unit: group.unit, details: null, nodes: [] };
    let container = fragment;
    if (grouped) {
      const details = document.createElement('details');
      details.className = 'toc-group';
      details.open = true;
      const summary = document.createElement('summary');
      summary.className = 'toc-group-summary';
      const chevron = document.createElement('span');
      chevron.className = 'toc-group-chevron';
      chevron.setAttribute('aria-hidden', 'true');
      const label = document.createElement('span');
      label.className = 'toc-group-name';
      label.textContent = group.label;
      const count = document.createElement('span');
      count.className = 'toc-group-count';
      count.textContent = `${formatNumber(group.chapters.length)} ${group.unit}`;
      summary.append(chevron, label, count);
      const items = document.createElement('div');
      items.className = 'toc-group-items';
      details.append(summary, items);
      groupRecord.details = details;
      groupRecord.summary = summary;
      container = items;
      fragment.append(details);
    }

    for (const chapter of group.chapters) {
      const index = chapter.index;
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'toc-item';
      button.dataset.chapter = String(index);
      button.setAttribute('aria-label', grouped ? `${group.label}，${chapter.title}` : chapter.title);

      const number = document.createElement('span');
      number.className = 'toc-number';
      number.textContent = grouped
        ? String(chapter.inPart).padStart(2, '0')
        : String(index + 1).padStart(3, '0');
      const name = document.createElement('span');
      name.className = 'toc-name';
      name.textContent = chapter.title;
      button.append(number, name);

      const node = { button, chapter };
      groupRecord.nodes.push(node);
      state.tocNodes.push(node);
      container.append(button);
    }
    state.tocGroups.push(groupRecord);
  }

  el.tocList.replaceChildren(fragment);
  filterToc();
  updateTocCurrent();
}

function filterToc() {
  const query = el.tocSearch.value.trim().toLocaleLowerCase('zh-CN');
  const compactQuery = query.replace(/\s+/g, '');
  let visible = 0;
  for (const group of state.tocGroups) {
    const partMatch = Boolean(query && group.label
      && group.label.toLocaleLowerCase('zh-CN').includes(query));
    let groupVisible = 0;
    for (const node of group.nodes) {
      const chapter = node.chapter;
      const title = chapter.title.toLocaleLowerCase('zh-CN');
      const match = !query
        || partMatch
        || title.includes(query)
        || (compactQuery && title.replace(/\s+/g, '').includes(compactQuery))
        || String(chapter.inPart) === query;
      node.button.hidden = !match;
      if (match) groupVisible += 1;
    }
    visible += groupVisible;
    if (group.details) {
      group.details.hidden = Boolean(query) && groupVisible === 0;
      if (query) group.details.open = groupVisible > 0;
    }
  }
  el.tocEmpty.hidden = visible !== 0;
  const volumeCount = new Set(state.chapters.map((chapter) => chapter.part).filter(Boolean)).size;
  el.tocCount.textContent = query
    ? `找到 ${formatNumber(visible)} 章`
    : `${volumeCount ? `${formatNumber(volumeCount)} 卷 · ` : ''}${formatNumber(state.chapters.length)} 章 · 约 ${formatWordCount(state.tocTotalChars)}`;
}

function updateTocCurrent() {
  const current = state.chapter?.index;
  for (const node of state.tocNodes) {
    const isCurrent = current != null && node.chapter.index === current;
    if (isCurrent) node.button.setAttribute('aria-current', 'true');
    else node.button.removeAttribute('aria-current');
  }
  for (const group of state.tocGroups) {
    if (!group.details) continue;
    group.details.classList.toggle('has-current', group.nodes.some((node) => node.chapter.index === current));
  }
}

function openToc() {
  if (!state.book || !state.chapters.length) return;
  el.tocSearch.value = '';
  filterToc();
  openModal(el.tocDialog);
  requestAnimationFrame(() => {
    const current = el.tocList.querySelector('[aria-current="true"]');
    if (current) {
      const group = current.closest('.toc-group');
      if (group && !group.open) group.open = true;
      const listRect = el.tocList.getBoundingClientRect();
      const buttonRect = current.getBoundingClientRect();
      el.tocList.scrollTop += buttonRect.top - listRect.top - el.tocList.clientHeight / 2 + buttonRect.height / 2;
      current.focus({ preventScroll: true });
    } else {
      el.tocSearch.focus({ preventScroll: true });
    }
  });
}

function goToTocChapter(index) {
  closeDialog(el.tocDialog);
  if (Number.isInteger(index)) loadChapter(index);
}

/* ------------------------------------------------------------------ */
/* 全书搜索                                                           */
/* ------------------------------------------------------------------ */

function openSearch() {
  if (!state.book || !state.chapter) return;
  openModal(el.searchDialog);
  setTimeout(() => el.searchBookInput?.focus(), 150);
}

function renderSearchResults(matches, query) {
  if (!matches.length) {
    el.searchList.replaceChildren();
    el.searchCount.textContent = '未找到匹配内容';
    el.searchEmpty.textContent = `在全书中未找到与 “${query}” 相关的内容`;
    el.searchEmpty.hidden = false;
    return;
  }

  el.searchEmpty.hidden = true;
  el.searchCount.textContent = `找到 ${matches.length} 处匹配`;

  const fragment = document.createDocumentFragment();
  for (const item of matches) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'toc-item search-result-item';
    btn.dataset.chapter = String(item.chapterIndex);
    btn.dataset.paragraph = String(item.paragraphIndex);

    const title = document.createElement('span');
    title.className = 'search-item-title';
    title.textContent = item.chapterTitle;

    const snippet = document.createElement('span');
    snippet.className = 'search-item-snippet';
    const raw = item.snippet;
    const lower = raw.toLocaleLowerCase('zh-CN');
    const qLower = query.toLocaleLowerCase('zh-CN');
    const idx = lower.indexOf(qLower);
    if (idx >= 0) {
      snippet.append(
        document.createTextNode(raw.slice(0, idx)),
        Object.assign(document.createElement('mark'), { textContent: raw.slice(idx, idx + query.length) }),
        document.createTextNode(raw.slice(idx + query.length))
      );
    } else {
      snippet.textContent = raw;
    }

    btn.append(title, snippet);
    fragment.append(btn);
  }

  el.searchList.replaceChildren(fragment);
}

function doSearch() {
  const query = el.searchBookInput.value.trim();
  if (!query) {
    el.searchList.replaceChildren();
    el.searchCount.textContent = '';
    el.searchEmpty.textContent = '输入关键词回车或停顿搜索全书正文';
    el.searchEmpty.hidden = false;
    return;
  }
  if (!state.parsedBook?.chapters) return;

  const qLower = query.toLocaleLowerCase('zh-CN');
  const matches = [];

  for (let cIdx = 0; cIdx < state.parsedBook.chapters.length; cIdx += 1) {
    const chapter = state.parsedBook.chapters[cIdx];
    for (let pIdx = 0; pIdx < chapter.paragraphs.length; pIdx += 1) {
      const p = chapter.paragraphs[pIdx];
      const text = typeof p === 'string'
        ? p
        : (Array.isArray(p?.runs) ? p.runs.map((r) => r.text || '').join('') : '');
      const textLower = text.toLocaleLowerCase('zh-CN');
      let pos = textLower.indexOf(qLower);
      while (pos >= 0) {
        const start = Math.max(0, pos - 16);
        const end = Math.min(text.length, pos + query.length + 28);
        const snippet = `${start > 0 ? '…' : ''}${text.slice(start, end)}${end < text.length ? '…' : ''}`;
        matches.push({
          chapterIndex: cIdx,
          chapterTitle: chapter.title || `第 ${cIdx + 1} 章`,
          paragraphIndex: pIdx,
          snippet,
        });
        if (matches.length >= 100) break;
        pos = textLower.indexOf(qLower, pos + query.length);
      }
      if (matches.length >= 100) break;
    }
    if (matches.length >= 100) break;
  }

  renderSearchResults(matches, query);
}

async function goToSearchResult(chapterIndex, paragraphIndex) {
  closeDialog(el.searchDialog);
  if (state.chapter?.index !== chapterIndex) {
    await loadChapter(chapterIndex);
  }
  requestAnimationFrame(() => {
    const paragraphs = el.chapterBody.querySelectorAll('p, blockquote, pre, h3, figure');
    const target = paragraphs[paragraphIndex];
    if (target) {
      target.scrollIntoView({ behavior: 'smooth', block: 'center' });
      target.classList.remove('chapter-search-target');
      void target.offsetWidth;
      target.classList.add('chapter-search-target');
      setTimeout(() => target.classList.remove('chapter-search-target'), 2600);
    }
  });
}

/* ------------------------------------------------------------------ */
/* 书签                                                               */
/* ------------------------------------------------------------------ */

function updateBookmarkBadge() {
  if (!state.book) {
    el.bookmarkCount.hidden = true;
    el.openBookmarksBtn.classList.remove('has-bookmark');
    return;
  }
  const bookmarks = getBookmarksFor(state.book.id);
  el.bookmarkCount.hidden = bookmarks.length === 0;
  el.bookmarkCount.textContent = String(bookmarks.length);
  const current = isCurrentChapterBookmarked();
  el.openBookmarksBtn.classList.toggle('has-bookmark', current);
  el.openBookmarksBtn.setAttribute('aria-label', `书签，共 ${bookmarks.length} 条`);
}

function formatBookmarkDate(timestamp) {
  if (!timestamp) return '刚刚';
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return '';
  const now = new Date();
  const sameYear = date.getFullYear() === now.getFullYear();
  return new Intl.DateTimeFormat('zh-CN', {
    ...(sameYear ? {} : { year: 'numeric' }),
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

function renderBookmarks() {
  if (!state.book || !state.chapter) return;
  const total = state.chapters.length;
  const bookmarks = getBookmarksFor(state.book.id);
  const current = bookmarks.find((item) => item.chapter === state.chapter.index);
  const ratio = currentScrollRatio();

  el.currentBookmarkTitle.textContent = chapterDisplayLabel(state.chapter);
  el.currentBookmarkMeta.textContent = `${chapterPositionLabel(state.chapter)} · 本章已读 ${formatPercent(ratio * 100)}`;
  el.toggleBookmarkBtn.classList.toggle('is-bookmarked', Boolean(current));
  el.toggleBookmarkBtn.setAttribute('aria-pressed', String(Boolean(current)));
  el.toggleBookmarkBtn.querySelector('span').textContent = current ? '移除本章书签' : '收藏本章';

  el.bookmarkListCount.textContent = `${bookmarks.length} 条`;
  el.bookmarkEmpty.hidden = bookmarks.length > 0;
  el.bookmarkList.hidden = bookmarks.length === 0;
  const fragment = document.createDocumentFragment();

  for (const bookmark of bookmarks) {
    if (bookmark.chapter >= total) continue;
    const chapter = state.chapters[bookmark.chapter];
    const title = chapter
      ? chapterDisplayLabel(chapter, bookmark.chapter)
      : (bookmark.title || `第 ${bookmark.chapter + 1} 章`);
    const item = document.createElement('li');

    const link = document.createElement('button');
    link.type = 'button';
    link.className = 'bookmark-link';
    link.dataset.bookmarkChapter = String(bookmark.chapter);
    link.dataset.bookmarkRatio = String(bookmark.ratio);
    const titleNode = document.createElement('span');
    titleNode.className = 'bookmark-title';
    titleNode.textContent = title;
    const meta = document.createElement('span');
    meta.className = 'bookmark-meta';
    meta.textContent = `${chapterPositionLabel(bookmark.chapter)} · 本章 ${formatPercent(bookmark.ratio * 100)} · ${formatBookmarkDate(bookmark.createdAt)}`;
    link.append(titleNode, meta);

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'bookmark-delete';
    remove.dataset.removeBookmark = String(bookmark.chapter);
    remove.setAttribute('aria-label', `删除《${title}》的书签`);
    remove.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M9 7V4.5h6V7m-8.5 0 .7 12.5h9.6L18.5 7M10 11v5M14 11v5"/></svg>';

    item.append(link, remove);
    fragment.append(item);
  }

  el.bookmarkList.replaceChildren(fragment);
}

function openBookmarks() {
  if (!state.book || !state.chapter) return;
  renderBookmarks();
  openModal(el.bookmarksDialog);
}

function toggleBookmark() {
  if (!state.book || !state.chapter) return;
  const items = getBookmarksFor(state.book.id);
  const existingIndex = items.findIndex((item) => item.chapter === state.chapter.index);
  if (existingIndex >= 0) {
    items.splice(existingIndex, 1);
    saveBookmarksFor(state.book.id, items);
    toast('已移除本章书签');
  } else {
    items.unshift({
      chapter: state.chapter.index,
      title: chapterDisplayLabel(state.chapter),
      ratio: currentScrollRatio(),
      createdAt: Date.now(),
    });
    saveBookmarksFor(state.book.id, items);
    toast('已收藏本章');
  }
  updateBookmarkBadge();
  renderBookmarks();
}

function openBookmark(bookmark) {
  closeDialog(el.bookmarksDialog);
  if (!bookmark || !Number.isInteger(bookmark.chapter)) return;
  if (state.chapter?.index === bookmark.chapter) {
    scrollToRatio(bookmark.ratio);
    saveProgressNow();
    toast(`已回到本章 ${formatPercent(bookmark.ratio * 100)} 处`);
  } else {
    loadChapter(bookmark.chapter, { scrollRatio: bookmark.ratio });
  }
}

/* ------------------------------------------------------------------ */
/* 弹层                                                               */
/* ------------------------------------------------------------------ */

function syncModalBodyState() {
  document.body.classList.toggle('modal-open', Boolean(document.querySelector('dialog[open]')));
}

function openModal(dialog) {
  if (!dialog) return;
  setReaderBarHidden(false);
  if (notePopoverAnchor) hideNotePopover({ immediate: true, blur: true });
  closeAllDialogs(dialog);
  if (!dialog.open) dialog.showModal();
  syncModalBodyState();
}

function closeDialog(dialog) {
  if (dialog?.open) dialog.close();
  syncModalBodyState();
}

function closeAllDialogs(except = null) {
  for (const dialog of $$('dialog[open]')) {
    if (dialog !== except) dialog.close();
  }
  syncModalBodyState();
}

let lastInputMode = 'pointer';
window.addEventListener('keydown', (event) => {
  if (event.key === 'Tab') lastInputMode = 'keyboard';
}, true);
window.addEventListener('pointerdown', () => {
  lastInputMode = 'pointer';
}, true);

function bindDialogs() {
  $$('[data-close-dialog]').forEach((button) => {
    button.addEventListener('click', () => closeDialog($(button.dataset.closeDialog)));
  });
  for (const dialog of $$('dialog')) {
    dialog.addEventListener('click', (event) => {
      if (event.target === dialog) dialog.close();
    });
    dialog.addEventListener('close', () => {
      syncModalBodyState();
      if (lastInputMode !== 'keyboard' && document.activeElement instanceof HTMLElement && document.activeElement !== document.body) {
        document.activeElement.blur();
      }
    });
  }
}

/* ------------------------------------------------------------------ */
/* 事件绑定                                                           */
/* ------------------------------------------------------------------ */

function bindLibrary() {
  el.bookGrid.addEventListener('click', (event) => {
    const exportBtn = event.target.closest('[data-export-book]');
    if (exportBtn) {
      event.preventDefault();
      event.stopPropagation();
      exportBookFile(exportBtn.dataset.exportBook);
      return;
    }
    const remove = event.target.closest('[data-remove-book]');
    if (remove) {
      event.preventDefault();
      const card = remove.closest('.book-card');
      const book = state.books.find((item) => item.id === remove.dataset.removeBook);
      removeBook(remove.dataset.removeBook, book?.title || card?.querySelector('.book-title')?.textContent || '这本书');
      return;
    }
    const card = event.target.closest('.book-card');
    if (card?.dataset.bookId) openBook(card.dataset.bookId);
  });

  el.bookSearch.addEventListener('input', () => {
    state.search = el.bookSearch.value;
    renderLibrary();
  });

  const pickFiles = () => el.importInput.click();
  el.importBtn.addEventListener('click', pickFiles);
  el.emptyImportBtn.addEventListener('click', pickFiles);
  el.importInput.addEventListener('change', () => {
    importFiles(el.importInput.files).finally(() => { el.importInput.value = ''; });
  });

  bindDropZone();

  const refresh = () => loadBooks({ manual: true });
  el.refreshBooksBtn.addEventListener('click', refresh);
  el.retryBooksBtn.addEventListener('click', () => {
    el.libraryError.hidden = true;
    loadBooks({ manual: true });
  });
}

function bindDropZone() {
  const zone = el.libraryView;
  let depth = 0;
  const hasFiles = (event) => [...(event.dataTransfer?.types || [])].includes('Files');

  zone.addEventListener('dragenter', (event) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    depth += 1;
    zone.classList.add('is-dragging');
  });
  zone.addEventListener('dragover', (event) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
  });
  zone.addEventListener('dragleave', (event) => {
    if (!hasFiles(event)) return;
    depth = Math.max(0, depth - 1);
    if (!depth) zone.classList.remove('is-dragging');
  });
  zone.addEventListener('drop', (event) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    depth = 0;
    zone.classList.remove('is-dragging');
    importFiles(event.dataTransfer.files);
  });

  window.addEventListener('dragover', (event) => {
    if (hasFiles(event)) event.preventDefault();
  });
  window.addEventListener('drop', (event) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    if (state.view === 'library') zone.classList.remove('is-dragging');
  });
}

function bindReader() {
  el.backToLibraryBtn.addEventListener('click', backToLibrary);
  el.errorBackBtn.addEventListener('click', backToLibrary);
  el.chapterPrevTop.addEventListener('click', goToPreviousChapter);
  el.chapterNextTop.addEventListener('click', goToNextChapter);
  el.chapterPrevBottom.addEventListener('click', goToPreviousChapter);
  el.chapterNextBottom.addEventListener('click', goToNextChapter);

  el.openTocBtn.addEventListener('click', openToc);
  if (el.openSearchBtn) el.openSearchBtn.addEventListener('click', openSearch);
  el.openBookmarksBtn.addEventListener('click', openBookmarks);
  el.openSettingsBtn.addEventListener('click', () => openModal(el.settingsDialog));
  el.retryChapterBtn.addEventListener('click', () => {
    if (state.book) loadChapter(state.chapter?.index ?? 0);
    else if (state.lastOpenRequest) openBook(state.lastOpenRequest.bookId, state.lastOpenRequest.chapterIndex);
    else backToLibrary();
  });

  if (el.searchBookInput) {
    el.searchBookInput.addEventListener('input', () => {
      window.clearTimeout(state.searchTimer);
      state.searchTimer = window.setTimeout(doSearch, 250);
    });
    el.searchBookInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        window.clearTimeout(state.searchTimer);
        doSearch();
      } else if (event.key === 'Escape' && el.searchBookInput.value) {
        event.preventDefault();
        event.stopPropagation();
        el.searchBookInput.value = '';
        doSearch();
      }
    });
  }

  if (el.searchList) {
    el.searchList.addEventListener('click', (event) => {
      const item = event.target.closest('.search-result-item');
      if (!item) return;
      goToSearchResult(Number(item.dataset.chapter), Number(item.dataset.paragraph));
    });
  }

  el.tocSearch.addEventListener('input', filterToc);
  el.tocSearch.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && el.tocSearch.value) {
      event.preventDefault();
      event.stopPropagation();
      el.tocSearch.value = '';
      filterToc();
    }
  });

  el.tocList.addEventListener('click', (event) => {
    const item = event.target.closest('.toc-item');
    if (!item) return;
    goToTocChapter(Number(item.dataset.chapter));
  });

  el.toggleBookmarkBtn.addEventListener('click', toggleBookmark);

  el.bookmarkList.addEventListener('click', (event) => {
    const remove = event.target.closest('[data-remove-bookmark]');
    if (remove && state.book) {
      const chapter = Number(remove.dataset.removeBookmark);
      const items = getBookmarksFor(state.book.id).filter((item) => item.chapter !== chapter);
      saveBookmarksFor(state.book.id, items);
      updateBookmarkBadge();
      renderBookmarks();
      toast('已删除书签');
      return;
    }
    const link = event.target.closest('[data-bookmark-chapter]');
    if (!link || !state.book) return;
    openBookmark({
      chapter: Number(link.dataset.bookmarkChapter),
      ratio: Number(link.dataset.bookmarkRatio) || 0,
    });
  });

  el.readerMain.addEventListener('click', handleReadingTap);

  window.addEventListener('scroll', handleScroll, { passive: true });
  window.addEventListener('resize', () => {
    state.lastScrollY = window.scrollY;
    if (!window.matchMedia('(max-width: 720px)').matches) setReaderBarHidden(false);
  });
  window.addEventListener('pagehide', saveProgressNow);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') saveProgressNow();
  });
}

function bindNotePopover() {
  el.chapterBody.addEventListener('pointerover', (event) => {
    const link = event.target.closest?.('.note-link');
    if (!link) return;
    notePopoverHover = true;
    showNotePopover(link);
  });

  el.chapterBody.addEventListener('pointerout', (event) => {
    const link = event.target.closest?.('.note-link');
    if (!link || link.contains(event.relatedTarget)) return;
    notePopoverHover = false;
    if (!notePopoverFocus) scheduleHideNotePopover();
  });

  el.chapterBody.addEventListener('focusin', (event) => {
    const link = event.target.closest?.('.note-link');
    if (!link) return;
    notePopoverFocus = true;
    showNotePopover(link);
  });

  el.chapterBody.addEventListener('focusout', (event) => {
    const link = event.target.closest?.('.note-link');
    if (!link) return;
    notePopoverFocus = false;
    if (!notePopoverHover) scheduleHideNotePopover();
  });

  el.chapterBody.addEventListener('click', (event) => {
    const link = event.target.closest?.('.note-link');
    if (!link) return;
    notePopoverFocus = true;
    showNotePopover(link);
  });

  el.notePopover.addEventListener('pointerenter', () => {
    if (!notePopoverAnchor) return;
    notePopoverHover = true;
    window.clearTimeout(notePopoverHideTimer);
  });

  el.notePopover.addEventListener('pointerleave', () => {
    notePopoverHover = false;
    if (!notePopoverFocus) scheduleHideNotePopover();
  });

  document.addEventListener('pointerdown', (event) => {
    if (!notePopoverAnchor) return;
    if (event.target.closest?.('.note-link') || event.target.closest?.('#notePopover')) return;
    notePopoverHover = false;
    notePopoverFocus = false;
    if (notePopoverAnchor === document.activeElement) notePopoverAnchor.blur();
    hideNotePopover();
  });

  window.addEventListener('resize', () => {
    if (notePopoverAnchor) positionNotePopover(notePopoverAnchor);
  });
}

function bindKeyboard() {
  document.addEventListener('keydown', (event) => {
    if (event.defaultPrevented || event.isComposing || event.metaKey || event.ctrlKey || event.altKey) return;
    const target = event.target;
    const isTyping = target instanceof HTMLElement
      && (target.matches('input, textarea, select, [contenteditable="true"]') || target.isContentEditable);
    const dialogOpen = Boolean(document.querySelector('dialog[open]'));

    if (state.view === 'library') {
      if (event.key === '/' && !isTyping) {
        event.preventDefault();
        el.bookSearch.focus();
      }
      return;
    }

    if (dialogOpen || isTyping) return;

    if (event.key === 'Escape' && notePopoverAnchor) {
      event.preventDefault();
      hideNotePopover({ immediate: true, blur: true });
      return;
    }

    const key = event.key.toLowerCase();
    if (event.key === 'ArrowLeft') {
      event.preventDefault();
      goToPreviousChapter();
    } else if (event.key === 'ArrowRight') {
      event.preventDefault();
      goToNextChapter();
    } else if (event.key === 'Escape') {
      backToLibrary();
    } else if (key === 't') {
      event.preventDefault();
      openToc();
    } else if (key === 'f') {
      event.preventDefault();
      openSearch();
    } else if (key === 'b') {
      event.preventDefault();
      openBookmarks();
    } else if (key === 's') {
      event.preventDefault();
      openModal(el.settingsDialog);
    }
  });
}

/* ------------------------------------------------------------------ */
/* 路由                                                               */
/* ------------------------------------------------------------------ */

function parseRoute() {
  const match = location.hash.match(/^#\/read\/([a-f0-9]{12})(?:\/(\d+))?$/);
  if (!match) return null;
  return {
    bookId: match[1],
    chapterIndex: match[2] === undefined ? null : Number(match[2]),
  };
}

function setRouteHash(chapterIndex, isInitial = false) {
  if (!state.book) return;
  const hash = `#/read/${state.book.id}/${chapterIndex}`;
  if (location.hash === hash) return;
  if (isInitial && !location.hash.startsWith('#/read/')) {
    try { history.pushState(null, '', hash); return; } catch {}
  }
  try { history.replaceState(null, '', hash); } catch { location.hash = hash; }
}

function removeRouteHash() {
  if (!location.hash) return;
  try { history.replaceState(null, '', location.pathname + location.search); } catch { location.hash = ''; }
}

/* ------------------------------------------------------------------ */
/* 提示与初始化                                                       */
/* ------------------------------------------------------------------ */

function toast(message) {
  window.clearTimeout(state.toastTimer);
  el.toastText.textContent = message;
  el.toast.classList.add('is-visible');
  state.toastTimer = window.setTimeout(() => {
    el.toast.classList.remove('is-visible');
  }, 2400);
}

function bindSkipLink() {
  const skip = document.querySelector('.skip-link');
  if (!skip) return;
  skip.addEventListener('click', (event) => {
    const target = state.view === 'reader' ? el.chapterBody : $('mainContent');
    if (!target) return;
    event.preventDefault();
    target.focus();
  });
}

function init() {
  const year = $('year');
  if (year) year.textContent = String(new Date().getFullYear());

  applySettings();
  bindSettings();
  bindLibrary();
  bindReader();
  bindNotePopover();
  bindDialogs();
  bindKeyboard();
  bindSkipLink();

  window.addEventListener('hashchange', () => {
    const route = parseRoute();
    if (!route) {
      if (location.hash && location.hash.startsWith('#/read/')) return;
      if (state.view === 'reader') backToLibrary();
      return;
    }
    if (state.book?.id === route.bookId) {
      if (route.chapterIndex != null && route.chapterIndex !== state.chapter?.index) {
        loadChapter(route.chapterIndex);
      }
    } else {
      openBook(route.bookId, route.chapterIndex, { fromRoute: true });
    }
  });

  const route = parseRoute();
  ensureLibrary().then(() => {
    if (route) openBook(route.bookId, route.chapterIndex, { fromRoute: true });
  });
}

// 页面脚本在 body 末尾以 defer 加载，DOM 已就绪。
init();
