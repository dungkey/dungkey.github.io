#!/usr/bin/env node
/**
 * 灯下 · 本地小说阅读器
 *
 * 零依赖本地服务：
 *   - 浏览 book/ 目录下的 .epub / .txt
 *   - EPUB：解析 container/OPF/NCX、章节正文与封面
 *   - TXT：自动识别 UTF-8 / GB18030、按章节标题分章
 *   - 静态页面：reader/
 *
 * 启动：node server.mjs [--port 8787]
 */

import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const READER_DIR = path.join(ROOT, 'reader');
const BOOK_DIR = path.join(ROOT, 'book');
const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number(argValue('--port') || process.env.PORT || 8787);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

const bookCache = new Map();
const bookLoads = new Map();
let scanQueue = Promise.resolve();

/* ------------------------------------------------------------------ */
/* 通用工具                                                           */
/* ------------------------------------------------------------------ */

function argValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

function bookId(filename) {
  return crypto.createHash('sha1').update(filename).digest('hex').slice(0, 12);
}

function normalizeText(value = '') {
  return String(value)
    .replace(/\u00a0/g, ' ')
    .replace(/[\t\f\v]+/g, ' ')
    .replace(/ {2,}/g, ' ')
    .trim();
}

function stripTags(value = '') {
  return normalizeText(decodeEntities(String(value).replace(/<[^>]*>/g, ' ')));
}

function decodeEntities(value = '') {
  const named = {
    amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
    hellip: '…', mdash: '—', ndash: '–', middot: '·', copy: '©',
    laquo: '«', raquo: '»', ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’',
  };
  return String(value).replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]+);/gi, (whole, body) => {
    if (body[0] === '#') {
      const code = body[1].toLowerCase() === 'x'
        ? Number.parseInt(body.slice(2), 16)
        : Number.parseInt(body.slice(1), 10);
      if (Number.isFinite(code) && code > 0 && code <= 0x10ffff) {
        try { return String.fromCodePoint(code); } catch { return whole; }
      }
      return whole;
    }
    return named[body.toLowerCase()] ?? whole;
  });
}

function escapeHtml(value = '') {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(body);
}

function publicError(res, status, message) {
  json(res, status, { error: message });
}

function decodeBuffer(buffer) {
  if (!Buffer.isBuffer(buffer)) return '';
  if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    return buffer.toString('utf8', 3);
  }
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    return new TextDecoder('utf-16le').decode(buffer.subarray(2));
  }
  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
    return new TextDecoder('utf-16be').decode(buffer.subarray(2));
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    try {
      return new TextDecoder('gb18030').decode(buffer);
    } catch {
      return buffer.toString('utf8');
    }
  }
}

function chaptersToSummary(book) {
  return book.chapters.map((chapter, index) => ({
    index,
    title: chapter.title,
    chars: chapter.chars,
  }));
}

/* ------------------------------------------------------------------ */
/* ZIP：只实现 EPUB 所需的读取能力                                     */
/* ------------------------------------------------------------------ */

class ZipArchive {
  constructor(buffer) {
    this.buffer = buffer;
    this.entries = new Map();
    this.#readCentralDirectory();
  }

  #readCentralDirectory() {
    const buffer = this.buffer;
    if (buffer.length < 22) throw new Error('不是有效的 ZIP/EPUB 文件');

    let eocd = -1;
    const min = Math.max(0, buffer.length - 22 - 0xffff);
    for (let i = buffer.length - 22; i >= min; i -= 1) {
      if (buffer.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('找不到 EPUB 的 ZIP 目录');

    const count = buffer.readUInt16LE(eocd + 10);
    const centralOffset = buffer.readUInt32LE(eocd + 16);
    if (count === 0xffff || centralOffset === 0xffffffff) {
      throw new Error('暂不支持 ZIP64 格式的 EPUB');
    }

    let pointer = centralOffset;
    for (let i = 0; i < count; i += 1) {
      if (pointer + 46 > buffer.length || buffer.readUInt32LE(pointer) !== 0x02014b50) break;
      const flags = buffer.readUInt16LE(pointer + 8);
      const method = buffer.readUInt16LE(pointer + 10);
      const compressedSize = buffer.readUInt32LE(pointer + 20);
      const size = buffer.readUInt32LE(pointer + 24);
      const nameLength = buffer.readUInt16LE(pointer + 28);
      const extraLength = buffer.readUInt16LE(pointer + 30);
      const commentLength = buffer.readUInt16LE(pointer + 32);
      const localOffset = buffer.readUInt32LE(pointer + 42);
      const name = buffer.toString(flags & 0x800 ? 'utf8' : 'utf8', pointer + 46, pointer + 46 + nameLength);
      this.entries.set(name.replace(/\\/g, '/'), {
        name: name.replace(/\\/g, '/'), method, compressedSize, size, localOffset, encrypted: Boolean(flags & 1),
      });
      pointer += 46 + nameLength + extraLength + commentLength;
    }
    if (!this.entries.size) throw new Error('EPUB 中没有可读取的文件');
  }

  has(name) {
    return this.entries.has(name);
  }

  read(name) {
    const entry = this.entries.get(name);
    if (!entry) return null;
    if (entry.encrypted) throw new Error(`EPUB 文件已加密：${name}`);
    const buffer = this.buffer;
    const local = entry.localOffset;
    if (local + 30 > buffer.length || buffer.readUInt32LE(local) !== 0x04034b50) {
      throw new Error(`EPUB 文件条目损坏：${name}`);
    }
    const nameLength = buffer.readUInt16LE(local + 26);
    const extraLength = buffer.readUInt16LE(local + 28);
    const start = local + 30 + nameLength + extraLength;
    const data = buffer.subarray(start, start + entry.compressedSize);
    if (entry.method === 0) return Buffer.from(data);
    if (entry.method === 8) return zlib.inflateRawSync(data);
    throw new Error(`不支持的 EPUB 压缩方式：${entry.method}`);
  }

  text(name) {
    const data = this.read(name);
    return data ? decodeBuffer(data) : '';
  }
}

/* ------------------------------------------------------------------ */
/* EPUB                                                               */
/* ------------------------------------------------------------------ */

function resolveArchivePath(baseFile, href) {
  const clean = decodeEntities(String(href || '')).split('#')[0].split('?')[0];
  if (!clean) return '';
  let decoded;
  try { decoded = decodeURIComponent(clean); } catch { decoded = clean; }
  return path.posix.normalize(path.posix.join(path.posix.dirname(baseFile), decoded)).replace(/^\/+/, '');
}

function parseAttributes(tag) {
  const attrs = {};
  for (const match of String(tag).matchAll(/([:\w.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
    attrs[match[1].toLowerCase()] = decodeEntities(match[2] ?? match[3] ?? '');
  }
  return attrs;
}

function firstMatch(source, regex) {
  const match = String(source).match(regex);
  return match?.[1] ?? match?.[2] ?? '';
}

function firstTag(source, regex) {
  return String(source).match(regex)?.[0] ?? '';
}

function htmlToTextParts(html) {
  let source = String(html)
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|svg|math)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<\/?br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|h[1-6]|li|blockquote|section|article|tr|dd|dt|figcaption)\s*>/gi, '\n')
    .replace(/<(p|div|h[1-6]|li|blockquote|section|article|tr|dd|dt|figcaption)\b[^>]*>/gi, '\n')
    .replace(/<[^>]*>/g, '');
  source = source
    .replace(/\n[ \t]+/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ');
  return source
    .split(/\n+/)
    .map((line) => normalizeText(decodeEntities(line)))
    .filter(Boolean);
}

function parseEpubChapter(html, fallbackTitle = '') {
  const body = firstMatch(html, /<body\b[^>]*>([\s\S]*?)<\/body\s*>/i) || html;
  const headingMatches = [...body.matchAll(/<h([1-3])\b[^>]*>([\s\S]*?)<\/h\1\s*>/gi)];
  let heading = '';
  for (const match of headingMatches) {
    const text = normalizeText(decodeEntities(String(match[2]).replace(/<[^>]*>/g, ' ')));
    if (text) { heading = text; break; }
  }
  const withoutHeadings = body.replace(/<h[1-3]\b[^>]*>[\s\S]*?<\/h[1-3]\s*>/gi, '\n');
  let paragraphs = htmlToTextParts(withoutHeadings);
  const title = normalizeText(heading || fallbackTitle);
  if (paragraphs.length && title && normalizeText(paragraphs[0]) === title) paragraphs.shift();
  paragraphs = paragraphs.filter((line) => line && !/^[\s\-—–·•*]+$/.test(line));
  return { title, paragraphs };
}

function parseTocMap(xml, tocFile) {
  const map = new Map();
  const textPattern = /<text\b[^>]*>([\s\S]*?)<\/text\s*>[\s\S]*?<content\b[^>]*\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;
  for (const match of String(xml).matchAll(textPattern)) {
    const title = stripTags(match[1]);
    const href = resolveArchivePath(tocFile, match[2] ?? match[3] ?? '');
    if (title && href && !map.has(href)) map.set(href, title);
  }
  return map;
}

function parseNavMap(html, navFile) {
  const map = new Map();
  for (const match of String(html).matchAll(/<a\b[^>]*\bhref\s*=\s*(?:"([^"]*)"|'([^']*)')[^>]*>([\s\S]*?)<\/a\s*>/gi)) {
    const href = resolveArchivePath(navFile, match[1] ?? match[2] ?? '');
    const title = stripTags(match[3]);
    if (title && href && !map.has(href)) map.set(href, title);
  }
  return map;
}

async function loadEpub(filePath, stat, filename) {
  const buffer = await fs.readFile(filePath);
  const zip = new ZipArchive(buffer);
  const containerXml = zip.text('META-INF/container.xml');
  if (!containerXml) throw new Error('EPUB 缺少 META-INF/container.xml');
  const rootfileTag = firstTag(containerXml, /<rootfile\b[^>]*>/i);
  let containerOpf = parseAttributes(rootfileTag)['full-path'];
  if (!containerOpf) throw new Error('EPUB 缺少 OPF 描述文件');
  try { containerOpf = decodeURIComponent(containerOpf); } catch { /* 保留原始路径 */ }
  containerOpf = containerOpf.replace(/\\/g, '/').replace(/^\/+/, '');
  const opf = zip.text(containerOpf);
  if (!opf) throw new Error('无法读取 EPUB 的 OPF 描述文件');

  const opfDir = path.posix.dirname(containerOpf);
  const manifestXml = firstMatch(opf, /<manifest\b[^>]*>([\s\S]*?)<\/manifest\s*>/i);
  const spineXml = firstMatch(opf, /<spine\b[^>]*>([\s\S]*?)<\/spine\s*>/i);
  const metadataXml = firstMatch(opf, /<metadata\b[^>]*>([\s\S]*?)<\/metadata\s*>/i);
  const manifest = new Map();
  for (const match of manifestXml.matchAll(/<item\b[^>]*\/?>/gi)) {
    const attrs = parseAttributes(match[0]);
    if (!attrs.id || !attrs.href) continue;
    const fullPath = path.posix.normalize(path.posix.join(opfDir, attrs.href.split('#')[0])).replace(/^\/+/, '');
    manifest.set(attrs.id, { ...attrs, path: fullPath });
  }

  const title = stripTags(firstMatch(metadataXml, /<dc:title\b[^>]*>([\s\S]*?)<\/dc:title>/i)) || path.parse(filename).name;
  const author = stripTags(firstMatch(metadataXml, /<dc:creator\b[^>]*>([\s\S]*?)<\/dc:creator>/i));
  const language = stripTags(firstMatch(metadataXml, /<dc:language\b[^>]*>([\s\S]*?)<\/dc:language>/i));

  let coverItem = null;
  const coverId = parseAttributes(firstTag(metadataXml, /<meta\b[^>]*\bname\s*=\s*(?:"cover"|'cover')[^>]*>/i)).content;
  if (coverId && manifest.has(coverId)) coverItem = manifest.get(coverId);
  if (!coverItem) {
    coverItem = [...manifest.values()].find((item) => /cover-image|cover/i.test(item.properties || ''))
      || [...manifest.values()].find((item) => /^cover\.(jpe?g|png|webp|gif)$/i.test(path.posix.basename(item.path)));
  }
  let cover = null;
  if (coverItem) {
    try {
      const data = zip.read(coverItem.path);
      if (data) cover = { data, mime: coverItem['media-type'] || MIME[path.extname(coverItem.path).toLowerCase()] || 'image/jpeg' };
    } catch { /* 封面损坏不影响阅读 */ }
  }

  let tocMap = new Map();
  const ncxItem = [...manifest.values()].find((item) => item['media-type'] === 'application/x-dtbncx+xml' || /\.ncx$/i.test(item.path));
  if (ncxItem && zip.has(ncxItem.path)) tocMap = parseTocMap(zip.text(ncxItem.path), ncxItem.path);
  if (!tocMap.size) {
    const navItem = [...manifest.values()].find((item) => /(?:^|\s)nav(?:\s|$)/i.test(item.properties || ''));
    if (navItem && zip.has(navItem.path)) tocMap = parseNavMap(zip.text(navItem.path), navItem.path);
  }

  const spine = [...spineXml.matchAll(/<itemref\b[^>]*\/?>/gi)]
    .map((match) => parseAttributes(match[0]))
    .filter((item) => item.idref);
  const chapters = [];
  const seenPaths = new Set();

  for (const spineItem of spine) {
    const item = manifest.get(spineItem.idref);
    if (!item || !zip.has(item.path)) continue;
    if (seenPaths.has(item.path)) continue;
    if (carefulNavItem(item, tocMap, title)) continue;
    seenPaths.add(item.path);

    let parsed;
    try {
      parsed = parseEpubChapter(zip.text(item.path), tocMap.get(item.path) || '');
    } catch {
      continue;
    }
    if (!parsed.paragraphs.length) continue;

    const chapterTitle = normalizeText(tocMap.get(item.path) || parsed.title || `第 ${chapters.length + 1} 章`);
    chapters.push({
      title: chapterTitle.slice(0, 160),
      paragraphs: parsed.paragraphs.map((line) => line.slice(0, 12000)),
      chars: parsed.paragraphs.reduce((sum, line) => sum + line.replace(/\s/g, '').length, 0),
    });
  }

  if (!chapters.length) throw new Error('EPUB 中没有找到可阅读的章节');

  return {
    id: bookId(filename),
    filename,
    format: 'epub',
    title: title || path.parse(filename).name,
    author,
    language,
    size: stat.size,
    modified: stat.mtimeMs,
    chapterCount: chapters.length,
    chapters,
    cover,
    getChapter(index) {
      const chapter = chapters[index];
      if (!chapter) return null;
      return { ...chapter, index, total: chapters.length };
    },
  };
}

function carefulNavItem(item, tocMap, bookTitle) {
  const href = item.path.toLowerCase();
  if (/\/(?:book-)?toc\.(?:x?html?|ncx)$/.test(href) || href.endsWith('nav.xhtml') || href.endsWith('nav.html')) return true;
  const tocTitle = (tocMap.get(item.path) || '').trim();
  if (/^(目录|目次|table of contents|contents)$/i.test(tocTitle)) return true;
  if (/^(cover|titlepage|title-page)\.(x?html?)$/i.test(path.posix.basename(href))) return true;
  if (tocTitle && tocTitle === bookTitle && item.path.toLowerCase().includes('cover')) return true;
  return false;
}

/* ------------------------------------------------------------------ */
/* TXT                                                                */
/* ------------------------------------------------------------------ */

const TXT_HEADING = /^(?:(\d{1,4})\s*[_\-—.、]\s*)?(第\s*[0-9零〇一二三四五六七八九十百千万两]+\s*[章节回卷])(?:\s*[：:、.\-—]?\s*(.*?))?\s*$/u;

function parseTxtText(text) {
  const normalized = text.replace(/\r\n?/g, '\n').replace(/\u0000/g, '');
  const lines = normalized.split('\n');
  const candidates = [];
  let offset = 0;

  for (let i = 0; i < lines.length; i += 1) {
    const original = lines[i];
    const lineOffset = offset;
    offset += original.length + 1;
    const trimmed = original.trim();
    if (!trimmed || trimmed.length > 140) continue;
    const withoutExtension = trimmed.replace(/\.txt\s*$/i, '').trim();
    const match = withoutExtension.match(TXT_HEADING);
    if (!match) continue;
    const rest = normalizeText((match[3] || '').replace(/^[，,]\s*/, ''));
    const token = normalizeText(match[2]).replace(/\s+/g, '');
    const title = normalizeText(`${token}${rest ? ` ${rest}` : ''}`).slice(0, 160);
    if (!title) continue;
    candidates.push({ title, line: i, headingStart: lineOffset, bodyStart: lineOffset + original.length + 1 });
  }

  const chapters = [];
  if (candidates.length) {
    const preface = normalized.slice(0, candidates[0].headingStart).trim();
    if (preface.length > 80) {
      const paragraphs = textToParagraphs(preface);
      if (paragraphs.length) {
        chapters.push({
          title: '前言',
          paragraphs,
          chars: paragraphs.reduce((sum, line) => sum + line.replace(/\s/g, '').length, 0),
        });
      }
    }
    for (let i = 0; i < candidates.length; i += 1) {
      const current = candidates[i];
      const next = candidates[i + 1];
      const body = normalized.slice(current.bodyStart, next ? next.headingStart : normalized.length);
      const paragraphs = textToParagraphs(body);
      if (!paragraphs.length) continue;
      chapters.push({
        title: current.title,
        paragraphs,
        chars: paragraphs.reduce((sum, line) => sum + line.replace(/\s/g, '').length, 0),
      });
    }
  }

  if (!chapters.length) {
    const paragraphs = textToParagraphs(normalized);
    if (paragraphs.length) {
      const targetChars = 9000;
      let bucket = [];
      let size = 0;
      for (const paragraph of paragraphs) {
        bucket.push(paragraph);
        size += paragraph.length;
        if (size >= targetChars) {
          chapters.push({
            title: `第 ${chapters.length + 1} 章`,
            paragraphs: bucket,
            chars: bucket.reduce((sum, line) => sum + line.replace(/\s/g, '').length, 0),
          });
          bucket = [];
          size = 0;
        }
      }
      if (bucket.length) {
        chapters.push({
          title: `第 ${chapters.length + 1} 章`,
          paragraphs: bucket,
          chars: bucket.reduce((sum, line) => sum + line.replace(/\s/g, '').length, 0),
        });
      }
    }
  }

  return chapters;
}

function textToParagraphs(text) {
  return String(text)
    .replace(/\u00a0/g, ' ')
    .split(/\n+/)
    .map((line) => normalizeText(line))
    .filter((line) => line && !/^[\s\-—–·•*]+$/.test(line) && line.length < 50000);
}

async function loadTxt(filePath, stat, filename) {
  const buffer = await fs.readFile(filePath);
  const text = decodeBuffer(buffer);
  const chapters = parseTxtText(text);
  if (!chapters.length) throw new Error('TXT 中没有找到可阅读的正文');

  return {
    id: bookId(filename),
    filename,
    format: 'txt',
    title: path.parse(filename).name.replace(/\.txt$/i, ''),
    author: '',
    language: 'zh',
    size: stat.size,
    modified: stat.mtimeMs,
    chapterCount: chapters.length,
    chapters,
    cover: null,
    getChapter(index) {
      const chapter = chapters[index];
      if (!chapter) return null;
      return { ...chapter, index, total: chapters.length };
    },
  };
}

/* ------------------------------------------------------------------ */
/* 扫描与缓存                                                          */
/* ------------------------------------------------------------------ */

async function loadBook(filePath, stat) {
  const filename = path.basename(filePath);
  const extension = path.extname(filename).toLowerCase();
  if (extension === '.epub') return loadEpub(filePath, stat, filename);
  if (extension === '.txt') return loadTxt(filePath, stat, filename);
  throw new Error('不支持的图书格式');
}

async function scanBooks() {
  const run = scanQueue.then(async () => {
    await fs.mkdir(BOOK_DIR, { recursive: true });
    const entries = await fs.readdir(BOOK_DIR, { withFileTypes: true });
    const files = entries
      .filter((entry) => entry.isFile() && /\.(epub|txt)$/i.test(entry.name))
      .map((entry) => entry.name)
      .sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'));

    const books = [];
    for (const filename of files) {
      const filePath = path.join(BOOK_DIR, filename);
      let stat;
      try { stat = await fs.stat(filePath); } catch { continue; }
      const id = bookId(filename);
      const cacheKey = `${filePath}|${stat.mtimeMs}|${stat.size}`;
      const cached = bookCache.get(id);
      if (cached && cached.cacheKey === cacheKey) {
        books.push(cached.book);
        continue;
      }
      let loading = bookLoads.get(cacheKey);
      if (!loading) {
        loading = loadBook(filePath, stat)
          .then((book) => {
            bookCache.set(id, { cacheKey, book });
            return book;
          })
          .finally(() => bookLoads.delete(cacheKey));
        bookLoads.set(cacheKey, loading);
      }
      try {
        books.push(await loading);
      } catch (error) {
        console.warn(`[book] ${filename}: ${error.message}`);
      }
    }
    return books;
  });
  scanQueue = run.catch(() => {});
  return run;
}

function bookSummary(book) {
  return {
    id: book.id,
    title: book.title,
    author: book.author,
    format: book.format,
    size: book.size,
    modified: book.modified,
    chapterCount: book.chapterCount,
    hasCover: Boolean(book.cover),
    coverUrl: book.cover ? `/api/books/${encodeURIComponent(book.id)}/cover?${Math.round(book.modified)}` : null,
  };
}

async function findBook(id) {
  const books = await scanBooks();
  return books.find((book) => book.id === id) || null;
}

/* ------------------------------------------------------------------ */
/* HTTP 路由                                                          */
/* ------------------------------------------------------------------ */

async function serveStatic(res, pathname) {
  let relative = pathname.replace(/^\/reader\/?/, '');
  if (!relative || relative.endsWith('/')) relative += 'index.html';
  let decoded;
  try { decoded = decodeURIComponent(relative); } catch { return false; }
  const absolute = path.resolve(READER_DIR, decoded);
  if (!absolute.startsWith(READER_DIR + path.sep)) return false;
  try {
    const stat = await fs.stat(absolute);
    if (!stat.isFile()) return false;
    const body = await fs.readFile(absolute);
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(absolute).toLowerCase()] || 'application/octet-stream',
      'Content-Length': body.length,
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(body);
    return true;
  } catch {
    return false;
  }
}

async function handleApi(req, res, url) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    publicError(res, 405, '仅支持 GET 请求');
    return true;
  }

  if (url.pathname === '/api/books') {
    const books = await scanBooks();
    json(res, 200, { books: books.map(bookSummary) });
    return true;
  }

  const match = url.pathname.match(/^\/api\/books\/([a-f0-9]{12})(?:\/(cover|chapters(?:\/(\d+))?))?$/);
  if (!match) return false;
  const [, id, resource, indexText] = match;
  const book = await findBook(id);
  if (!book) {
    publicError(res, 404, '没有找到这本书，可能已被移动或删除');
    return true;
  }

  if (!resource) {
    json(res, 200, {
      book: bookSummary(book),
      chapters: chaptersToSummary(book),
    });
    return true;
  }

  if (resource === 'cover') {
    if (!book.cover) {
      publicError(res, 404, '这本书没有封面');
      return true;
    }
    res.writeHead(200, {
      'Content-Type': book.cover.mime,
      'Content-Length': book.cover.data.length,
      'Cache-Control': 'public, max-age=3600',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(book.cover.data);
    return true;
  }

  if (resource && resource.startsWith('chapters')) {
    if (indexText === undefined) {
      json(res, 200, { chapters: chaptersToSummary(book) });
      return true;
    }
    const index = Number(indexText);
    if (!Number.isInteger(index) || index < 0 || index >= book.chapterCount) {
      publicError(res, 404, '章节不存在');
      return true;
    }
    const chapter = book.getChapter(index);
    json(res, 200, {
      book: bookSummary(book),
      chapter: {
        index,
        title: chapter.title,
        paragraphs: chapter.paragraphs,
        chars: chapter.chars,
      },
      prev: index > 0 ? index - 1 : null,
      next: index < book.chapterCount - 1 ? index + 1 : null,
      total: book.chapterCount,
    });
    return true;
  }

  return false;
}

async function handler(req, res) {
  try {
    const url = new URL(req.url || '/', `http://${req.headers.host || `${HOST}:${PORT}`}`);
    if (url.pathname === '/healthz') {
      json(res, 200, { ok: true });
      return;
    }
    if (url.pathname === '/' || url.pathname === '') {
      res.writeHead(302, { Location: '/reader/' });
      res.end();
      return;
    }
    if (url.pathname.startsWith('/api/')) {
      const handled = await handleApi(req, res, url);
      if (!handled) publicError(res, 404, '接口不存在');
      return;
    }
    if (url.pathname === '/reader') {
      res.writeHead(301, { Location: '/reader/' });
      res.end();
      return;
    }
    if (url.pathname.startsWith('/reader/')) {
      const served = await serveStatic(res, url.pathname);
      if (served) return;
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('页面不存在');
      return;
    }
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('页面不存在');
  } catch (error) {
    console.error(error);
    if (!res.headersSent) publicError(res, 500, error.message || '服务内部错误');
    else res.end();
  }
}

const server = http.createServer(handler);
server.listen(PORT, HOST, () => {
  console.log(`灯下阅读器已启动：http://${HOST}:${PORT}/reader/`);
  console.log(`书库目录：${BOOK_DIR}`);
});
server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    console.error(`端口 ${PORT} 已被占用，请使用 --port 指定其他端口。`);
  } else {
    console.error(error);
  }
  process.exitCode = 1;
});
