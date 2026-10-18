'use strict';

const SETTINGS_KEY = 'dengxia.settings.v1';
const PROGRESS_KEY = 'dengxia.progress.v1';
const BOOKMARKS_KEY = 'dengxia.bookmarks.v1';

const IS_WINDOWS = /Windows/i.test(
  (navigator.userAgentData && navigator.userAgentData.platform)
    || navigator.platform
    || navigator.userAgent
    || ''
);
const DEFAULT_FONT = IS_WINDOWS ? 'sans' : 'serif';

const DEFAULT_SETTINGS = Object.freeze({
  theme: 'paper',
  font: DEFAULT_FONT,
  fontSize: 19,
  lineHeight: 1.95,
  width: 760,
  indent: true,
});

const THEME_NAMES = { paper: '纸色', sepia: '茶色', night: '夜色' };
const THEME_COLORS = { paper: '#f2ecdf', sepia: '#e9deca', night: '#151518' };
const THEME_ORDER = ['paper', 'sepia', 'night'];
const BOOK_ID_RE = /^[a-f0-9]{12}$/;

const $ = (id) => document.getElementById(id);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

const el = {
  libraryView: $('libraryView'),
  readerView: $('readerView'),
  libraryStatus: $('libraryStatus'),
  themeCycleBtn: $('themeCycleBtn'),
  bookSearch: $('bookSearch'),
  refreshBooksBtn: $('refreshBooksBtn'),
  libraryLoading: $('libraryLoading'),
  bookGrid: $('bookGrid'),
  shelfSummary: $('shelfSummary'),
  libraryEmpty: $('libraryEmpty'),
  libraryEmptyTitle: $('libraryEmptyTitle'),
  libraryEmptyText: $('libraryEmptyText'),
  emptyRefreshBtn: $('emptyRefreshBtn'),
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
  openBookmarksBtn: $('openBookmarksBtn'),
  bookmarkCount: $('bookmarkCount'),
  openSettingsBtn: $('openSettingsBtn'),
  readerMain: $('readerMain'),
  readerLoading: $('readerLoading'),
  readerError: $('readerError'),
  readerErrorText: $('readerErrorText'),
  retryChapterBtn: $('retryChapterBtn'),
  errorBackBtn: $('errorBackBtn'),
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
  chapterJumpForm: $('chapterJumpForm'),
  chapterJumpInput: $('chapterJumpInput'),
  jumpTotal: $('jumpTotal'),
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
  toast: $('toast'),
  toastText: $('toastText'),
};

const settings = loadSettings();
const state = {
  view: 'library',
  books: [],
  booksLoaded: false,
  booksLoading: false,
  search: '',
  book: null,
  chapters: [],
  chapter: null,
  prev: null,
  next: null,
  chapterLoading: false,
  openToken: 0,
  chapterToken: 0,
  openAbort: null,
  chapterAbort: null,
  tocNodes: [],
  tocTotalChars: 0,
  lastOpenRequest: null,
  libraryScroll: 0,
  scrollTicking: false,
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

function loadSettings() {
  const saved = readStore(SETTINGS_KEY, {});
  const savedFontValid = ['serif', 'sans', 'kai'].includes(saved.font);
  const fontExplicit = saved.fontExplicit === true;
  let font = savedFontValid ? saved.font : DEFAULT_FONT;
  // 旧版默认使用宋体；Windows 用户没有主动选过字体时，迁移到更适合屏幕的雅黑。
  if (IS_WINDOWS && !fontExplicit && saved.font === 'serif') font = 'sans';
  return {
    theme: THEME_ORDER.includes(saved.theme) ? saved.theme : DEFAULT_SETTINGS.theme,
    font,
    fontExplicit,
    fontSize: clamp(Number(saved.fontSize) || DEFAULT_SETTINGS.fontSize, 16, 30),
    lineHeight: clamp(Number(saved.lineHeight) || DEFAULT_SETTINGS.lineHeight, 1.4, 2.4),
    width: clamp(Number(saved.width) || DEFAULT_SETTINGS.width, 560, 1120),
    indent: saved.indent !== false,
  };
}

function persistSettings() {
  writeStore(SETTINGS_KEY, settings);
}

function applySettings() {
  const root = document.documentElement;
  root.dataset.theme = settings.theme;
  root.dataset.font = settings.font;
  root.dataset.os = IS_WINDOWS ? 'windows' : 'other';
  root.style.setProperty('--reader-font-size', `${settings.fontSize}px`);
  root.style.setProperty('--reader-line-height', String(settings.lineHeight));
  root.style.setProperty('--reader-width', `${settings.width}px`);
  root.style.setProperty('--reader-indent', settings.indent ? '2em' : '0em');

  const metaTheme = document.querySelector('meta[name="theme-color"]');
  if (metaTheme) metaTheme.content = THEME_COLORS[settings.theme];

  $$('[data-set-theme]').forEach((button) => {
    button.setAttribute('aria-pressed', String(button.dataset.setTheme === settings.theme));
  });
  $$('[data-set-font]').forEach((button) => {
    button.setAttribute('aria-pressed', String(button.dataset.setFont === settings.font));
  });

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
  updateThemeCycleLabel();
}

function updateRangeFill(input) {
  const min = Number(input.min);
  const max = Number(input.max);
  const value = Number(input.value);
  const fill = max === min ? 0 : ((value - min) / (max - min)) * 100;
  input.style.setProperty('--fill', `${fill}%`);
}

function updateThemeCycleLabel() {
  const next = THEME_ORDER[(THEME_ORDER.indexOf(settings.theme) + 1) % THEME_ORDER.length];
  el.themeCycleBtn.title = `当前：${THEME_NAMES[settings.theme]} · 切换为${THEME_NAMES[next]}`;
  el.themeCycleBtn.setAttribute('aria-label', el.themeCycleBtn.title);
}

function changeSetting(key, value) {
  settings[key] = value;
  applySettings();
  persistSettings();
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
    toast('已恢复默认格式');
  });

  el.themeCycleBtn.addEventListener('click', () => {
    const next = THEME_ORDER[(THEME_ORDER.indexOf(settings.theme) + 1) % THEME_ORDER.length];
    changeSetting('theme', next);
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

async function fetchJson(url, options = {}) {
  const response = await fetch(url, {
    cache: 'no-store',
    ...options,
    headers: { Accept: 'application/json', ...(options.headers || {}) },
  });
  let payload = null;
  try { payload = await response.json(); } catch { /* 非 JSON 错误由下面统一处理 */ }
  if (!response.ok) {
    throw new Error(payload?.error || `请求失败（${response.status}）`);
  }
  return payload;
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
    el.shelfSummary.textContent = '正在读取本地书库…';
  }

  try {
    const payload = await fetchJson(`/api/books?t=${Date.now()}`);
    if (!payload || !Array.isArray(payload.books)) throw new Error('书库返回了无法识别的数据');
    state.books = payload.books;
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
      el.libraryErrorText.textContent = `${error.message}。请确认本地服务仍在运行，然后重试。`;
      el.libraryStatus.textContent = '书库未连接';
      el.shelfSummary.textContent = '读取书库失败';
    }
  } finally {
    state.booksLoading = false;
    el.refreshBooksBtn.disabled = false;
    el.refreshBooksBtn.classList.remove('is-spinning');
    if (state.booksLoaded) renderLibrary();
  }
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

  if (!state.books.length) {
    el.bookGrid.hidden = true;
    el.bookGrid.replaceChildren();
    el.libraryEmpty.hidden = false;
    el.libraryEmptyTitle.textContent = '书架还是空的';
    el.libraryEmptyText.innerHTML = '把 <code>.epub</code> 或 <code>.txt</code> 文件放进 <code>book/</code> 目录，再刷新书架。';
    el.emptyRefreshBtn.hidden = false;
    return;
  }

  if (!filtered.length) {
    el.bookGrid.hidden = true;
    el.bookGrid.replaceChildren();
    el.libraryEmpty.hidden = false;
    el.libraryEmptyTitle.textContent = '没有找到这本书';
    el.libraryEmptyText.textContent = '换一个书名或作者试试，也可以刷新书库。';
    el.emptyRefreshBtn.hidden = true;
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
  coverTop.textContent = '灯下藏书';
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
    strong.textContent = `第 ${formatNumber(chapterIndex + 1)} 章`;
    progressLine.append(strong, document.createTextNode(` · ${formatPercent(percent)}`));
    progressFill.style.width = `${clamp(percent, 0.4, 100)}%`;
    progressBar.append(progressFill);
  } else {
    progressLine.textContent = '尚未开始 · 点击翻开';
    progressBar.hidden = true;
  }

  info.append(title, byline, progressLine, progressBar);
  openButton.append(cover, info);
  card.append(openButton);
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

/* ------------------------------------------------------------------ */
/* 视图切换与打开书籍                                                 */
/* ------------------------------------------------------------------ */

function setView(view) {
  state.view = view;
  const reader = view === 'reader';
  el.libraryView.hidden = reader;
  el.readerView.hidden = !reader;
  document.body.classList.toggle('reading-mode', reader);
  const skip = document.querySelector('.skip-link');
  if (skip) skip.href = reader ? '#chapterBody' : '#mainContent';
  if (!reader) closeAllDialogs();
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
  el.readerErrorText.textContent = `${message}。请确认本地服务仍在运行，或返回书架重试。`;
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

function setNavDisabled(disabled) {
  el.chapterPrevTop.disabled = disabled;
  el.chapterNextTop.disabled = disabled;
  el.chapterPrevBottom.disabled = disabled;
  el.chapterNextBottom.disabled = disabled;
}

async function openBook(bookId, chapterIndex = null, options = {}) {
  if (!BOOK_ID_RE.test(String(bookId))) {
    toast('书籍地址无效');
    return;
  }

  if (state.book) saveProgressNow();
  if (state.openAbort) state.openAbort.abort();
  if (state.chapterAbort) state.chapterAbort.abort();
  state.openToken += 1;
  state.chapterToken += 1;
  const token = state.openToken;
  const controller = new AbortController();
  state.openAbort = controller;

  state.lastOpenRequest = { bookId, chapterIndex };
  state.book = null;
  state.chapters = [];
  state.chapter = null;
  state.prev = null;
  state.next = null;
  state.tocNodes = [];
  state.libraryScroll = window.scrollY;
  state.chapterLoading = false;

  setView('reader');
  showReaderOpening();
  document.title = '正在打开 · 灯下';

  try {
    const data = await fetchJson(`/api/books/${bookId}`, { signal: controller.signal });
    if (token !== state.openToken) return;
    if (!data || !data.book || !Array.isArray(data.chapters) || !data.chapters.length) {
      throw new Error('这本书没有可读取的章节');
    }

    state.book = data.book;
    state.chapters = data.chapters;
    state.tocTotalChars = data.chapters.reduce((sum, chapter) => sum + (Number(chapter.chars) || 0), 0);
    setReaderBar(data.book);
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
    if (resumed) toast(`已回到上次读到的第 ${target + 1} 章`);
  } catch (error) {
    if (error.name === 'AbortError' || token !== state.openToken) return;
    state.book = null;
    state.chapters = [];
    showReaderError(error.message || '无法打开这本书');
    el.readerBookTitle.textContent = '无法打开';
    el.readerBookMeta.textContent = '';
    document.title = '打开失败 · 灯下';
  } finally {
    if (token === state.openToken) state.openAbort = null;
  }
}

function backToLibrary() {
  if (state.view !== 'reader') return;
  saveProgressNow();
  if (state.openAbort) state.openAbort.abort();
  if (state.chapterAbort) state.chapterAbort.abort();
  state.openToken += 1;
  state.chapterToken += 1;
  state.chapterLoading = false;
  state.book = null;
  state.chapters = [];
  state.chapter = null;
  state.prev = null;
  state.next = null;
  state.tocNodes = [];
  closeAllDialogs();
  setView('library');
  removeRouteHash();
  document.title = '灯下 · 本地阅读';
  el.bookProgressBar.style.width = '0%';
  renderLibrary();

  const previousScroll = state.libraryScroll;
  requestAnimationFrame(() => {
    window.scrollTo(0, previousScroll);
    const card = el.bookGrid.querySelector('.book-card');
    const target = card?.querySelector('.book-open');
    if (target) target.focus({ preventScroll: true });
  });

  // 顺便发现阅读期间新放进 book/ 的书；服务端有缓存，这一步通常很快。
  loadBooks({ quiet: true });
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

  if (state.chapterAbort) state.chapterAbort.abort();
  const controller = new AbortController();
  state.chapterAbort = controller;
  state.chapterToken += 1;
  const token = state.chapterToken;
  state.chapterLoading = true;

  if (!previousChapter) {
    el.readerLoading.hidden = false;
    el.readerError.hidden = true;
    el.chapterArticle.hidden = true;
  } else {
    el.readerMain.classList.add('is-loading');
  }

  try {
    const data = await fetchJson(`/api/books/${state.book.id}/chapters/${target}`, { signal: controller.signal });
    if (token !== state.chapterToken) return;
    if (!data || !data.chapter || !Array.isArray(data.chapter.paragraphs)) {
      throw new Error('章节内容为空');
    }

    state.chapter = data.chapter;
    state.prev = data.prev;
    state.next = data.next;
    state.chapterLoading = false;

    renderChapter();
    el.readerLoading.hidden = true;
    el.readerError.hidden = true;
    el.chapterArticle.hidden = false;
    el.readerMain.classList.remove('is-loading');
    updateTocCurrent();
    updateBookmarkBadge();
    if (el.bookmarksDialog.open) renderBookmarks();
    setRouteHash(target);
    document.title = `${data.chapter.title} · ${state.book.title} · 灯下`;

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
    if (error.name === 'AbortError' || token !== state.chapterToken) return;
    state.chapterLoading = false;
    el.readerMain.classList.remove('is-loading');
    if (!previousChapter) {
      showReaderError(error.message || '章节加载失败');
      document.title = '加载失败 · 灯下';
    } else {
      toast(`章节加载失败：${error.message}`);
    }
  } finally {
    if (token === state.chapterToken) state.chapterAbort = null;
  }
}

function renderChapter() {
  const chapter = state.chapter;
  const book = state.book;
  if (!chapter || !book) return;
  const total = state.chapters.length;

  el.chapterKicker.textContent = `CHAPTER ${String(chapter.index + 1).padStart(3, '0')}`;
  el.chapterStats.textContent = `${formatNumber(chapter.chars)} 字 · 第 ${formatNumber(chapter.index + 1)} / ${formatNumber(total)} 章`;
  el.chapterTitle.textContent = chapter.title;

  const fragment = document.createDocumentFragment();
  for (const paragraph of chapter.paragraphs) {
    const p = document.createElement('p');
    p.textContent = paragraph;
    fragment.append(p);
  }
  el.chapterBody.replaceChildren(fragment);

  const previousTitle = state.prev == null ? '已是开篇' : (state.chapters[state.prev]?.title || `第 ${state.prev + 1} 章`);
  const nextTitle = state.next == null ? '已是终章' : (state.chapters[state.next]?.title || `第 ${state.next + 1} 章`);
  el.prevChapterTitle.textContent = previousTitle;
  el.nextChapterTitle.textContent = nextTitle;
  el.prevChapterTitle.title = previousTitle;
  el.nextChapterTitle.title = nextTitle;

  el.chapterPrevTop.disabled = state.prev == null;
  el.chapterNextTop.disabled = state.next == null;
  el.chapterPrevBottom.disabled = state.prev == null;
  el.chapterNextBottom.disabled = state.next == null;

  el.chapterProgressLabel.textContent = `第 ${formatNumber(chapter.index + 1)} / ${formatNumber(total)} 章`;
  el.chapterArcLabel.textContent = book.title;
  el.chapterArcLabel.title = book.title;
  el.jumpTotal.textContent = `共 ${formatNumber(total)} 章`;
  el.chapterJumpInput.max = String(total);
  el.chapterJumpInput.placeholder = String(chapter.index + 1);

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
  el.bookProgressBar.style.width = `${clamp(percent, 0, 100)}%`;
}

function saveProgressNow() {
  if (!state.book || !state.chapter) return;
  const ratio = currentScrollRatio();
  const progress = readProgressStore();
  progress[state.book.id] = {
    chapter: state.chapter.index,
    ratio: Number(ratio.toFixed(4)),
    updatedAt: Date.now(),
    chapterTitle: state.chapter.title,
  };
  writeStore(PROGRESS_KEY, progress);
  updateProgressVisual();
}

function scheduleProgressSave() {
  if (!state.book || !state.chapter) return;
  window.clearTimeout(state.progressTimer);
  state.progressTimer = window.setTimeout(saveProgressNow, 450);
}

function handleScroll() {
  if (!state.book || !state.chapter) return;
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

function buildToc() {
  state.tocNodes = [];
  const fragment = document.createDocumentFragment();
  el.tocBookName.textContent = state.book?.title || '';
  el.tocSearch.value = '';

  state.chapters.forEach((chapter, index) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'toc-item';
    button.dataset.chapter = String(index);
    button.setAttribute('aria-label', `第 ${index + 1} 章：${chapter.title}`);

    const number = document.createElement('span');
    number.className = 'toc-number';
    number.textContent = String(index + 1).padStart(3, '0');
    const name = document.createElement('span');
    name.className = 'toc-name';
    name.textContent = chapter.title;
    button.append(number, name);

    state.tocNodes.push(button);
    fragment.append(button);
  });

  el.tocList.replaceChildren(fragment);
  filterToc();
  updateTocCurrent();
}

function filterToc() {
  const query = el.tocSearch.value.trim().toLocaleLowerCase('zh-CN');
  let visible = 0;
  for (let i = 0; i < state.tocNodes.length; i += 1) {
    const node = state.tocNodes[i];
    const chapter = state.chapters[i];
    if (!chapter) continue;
    const match = !query
      || chapter.title.toLocaleLowerCase('zh-CN').includes(query)
      || String(i + 1) === query
      || String(i + 1).includes(query);
    node.hidden = !match;
    if (match) visible += 1;
  }
  el.tocEmpty.hidden = visible !== 0;
  el.tocCount.textContent = query
    ? `找到 ${formatNumber(visible)} 章`
    : `${formatNumber(state.chapters.length)} 章 · 约 ${formatWordCount(state.tocTotalChars)}`;
}

function updateTocCurrent() {
  const current = state.chapter?.index;
  for (const node of state.tocNodes) {
    if (current == null) node.removeAttribute('aria-current');
    else node.setAttribute('aria-current', String(Number(node.dataset.chapter) === current));
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
      el.tocList.scrollTop = Math.max(0, current.offsetTop - el.tocList.clientHeight / 2);
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

  el.currentBookmarkTitle.textContent = state.chapter.title;
  el.currentBookmarkMeta.textContent = `第 ${formatNumber(state.chapter.index + 1)} / ${formatNumber(total)} 章 · 本章已读 ${formatPercent(ratio * 100)}`;
  el.toggleBookmarkBtn.classList.toggle('is-bookmarked', Boolean(current));
  el.toggleBookmarkBtn.setAttribute('aria-pressed', String(Boolean(current)));
  el.toggleBookmarkBtn.querySelector('span').textContent = current ? '移除本章书签' : '收藏本章';

  el.bookmarkListCount.textContent = `${bookmarks.length} 条`;
  el.bookmarkEmpty.hidden = bookmarks.length > 0;
  el.bookmarkList.hidden = bookmarks.length === 0;
  const fragment = document.createDocumentFragment();

  for (const bookmark of bookmarks) {
    if (bookmark.chapter >= total) continue;
    const title = bookmark.title || state.chapters[bookmark.chapter]?.title || `第 ${bookmark.chapter + 1} 章`;
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
    meta.textContent = `第 ${formatNumber(bookmark.chapter + 1)} 章 · 本章 ${formatPercent(bookmark.ratio * 100)} · ${formatBookmarkDate(bookmark.createdAt)}`;
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
      title: state.chapter.title,
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

function bindDialogs() {
  $$('[data-close-dialog]').forEach((button) => {
    button.addEventListener('click', () => closeDialog($(button.dataset.closeDialog)));
  });
  for (const dialog of $$('dialog')) {
    dialog.addEventListener('click', (event) => {
      if (event.target === dialog) dialog.close();
    });
    dialog.addEventListener('close', syncModalBodyState);
  }
}

/* ------------------------------------------------------------------ */
/* 事件绑定                                                           */
/* ------------------------------------------------------------------ */

function bindLibrary() {
  el.bookGrid.addEventListener('click', (event) => {
    const card = event.target.closest('.book-card');
    if (card?.dataset.bookId) openBook(card.dataset.bookId);
  });

  el.bookSearch.addEventListener('input', () => {
    state.search = el.bookSearch.value;
    renderLibrary();
  });

  const refresh = () => loadBooks({ manual: true });
  el.refreshBooksBtn.addEventListener('click', refresh);
  el.emptyRefreshBtn.addEventListener('click', refresh);
  el.retryBooksBtn.addEventListener('click', () => {
    el.libraryError.hidden = true;
    loadBooks({ manual: true });
  });
}

function bindReader() {
  el.backToLibraryBtn.addEventListener('click', backToLibrary);
  el.errorBackBtn.addEventListener('click', backToLibrary);
  el.chapterPrevTop.addEventListener('click', goToPreviousChapter);
  el.chapterNextTop.addEventListener('click', goToNextChapter);
  el.chapterPrevBottom.addEventListener('click', goToPreviousChapter);
  el.chapterNextBottom.addEventListener('click', goToNextChapter);

  el.chapterJumpForm.addEventListener('submit', (event) => {
    event.preventDefault();
    if (!state.book) return;
    const value = Number(el.chapterJumpInput.value);
    if (!Number.isInteger(value) || value < 1 || value > state.chapters.length) {
      toast(`请输入 1–${state.chapters.length} 的章节序号`);
      el.chapterJumpInput.focus();
      return;
    }
    el.chapterJumpInput.value = '';
    const target = value - 1;
    if (target === state.chapter?.index) {
      window.scrollTo(0, 0);
      return;
    }
    loadChapter(target);
  });

  el.openTocBtn.addEventListener('click', openToc);
  el.openBookmarksBtn.addEventListener('click', openBookmarks);
  el.openSettingsBtn.addEventListener('click', () => openModal(el.settingsDialog));
  el.retryChapterBtn.addEventListener('click', () => {
    if (state.book) loadChapter(state.chapter?.index ?? 0);
    else if (state.lastOpenRequest) openBook(state.lastOpenRequest.bookId, state.lastOpenRequest.chapterIndex);
    else backToLibrary();
  });

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

  window.addEventListener('scroll', handleScroll, { passive: true });
  window.addEventListener('pagehide', saveProgressNow);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') saveProgressNow();
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

function setRouteHash(chapterIndex) {
  if (!state.book) return;
  const hash = `#/read/${state.book.id}/${chapterIndex}`;
  if (location.hash === hash) return;
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

function init() {
  applySettings();
  bindSettings();
  bindLibrary();
  bindReader();
  bindDialogs();
  bindKeyboard();

  window.addEventListener('hashchange', () => {
    const route = parseRoute();
    if (route) {
      if (state.book?.id === route.bookId) {
        if (route.chapterIndex != null && route.chapterIndex !== state.chapter?.index) {
          loadChapter(route.chapterIndex);
        }
      } else {
        openBook(route.bookId, route.chapterIndex, { fromRoute: true });
      }
    } else if (state.view === 'reader' && !state.book) {
      backToLibrary();
    } else if (state.view === 'reader') {
      backToLibrary();
    }
  });

  const route = parseRoute();
  loadBooks();
  if (route) openBook(route.bookId, route.chapterIndex, { fromRoute: true });
}

// 页面脚本在 body 末尾以 defer 加载，DOM 已就绪。
init();
