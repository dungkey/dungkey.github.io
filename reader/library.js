'use strict';

/*
 * 纯静态书库：在浏览器里解 ZIP、读 EPUB、切 TXT，不经过任何服务端。
 *
 *   ReaderLibrary.parse(filename, buffer) -> {
 *     id, filename, format, title, author, language,
 *     chapterCount, chapters: [{ title, part, paragraphs, chars, notes }],
 *     cover
 *   }
 *
 * EPUB 的 paragraphs 是 [{ runs: [{ type: 'text', text } | { type: 'note', label, noteId }] }]，
 * 用来保留正文里的上标注释；TXT 仍然是字符串数组。
 */

(function () {
  const utf8 = new TextDecoder('utf-8');
  const utf8Fatal = new TextDecoder('utf-8', { fatal: true });
  const gb18030 = new TextDecoder('gb18030');
  const utf16le = new TextDecoder('utf-16le');
  const utf16be = new TextDecoder('utf-16be');

  const MIME = {
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.webp': 'image/webp',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml',
  };

  /* ---------------------------------------------------------------- */
  /* 通用工具                                                          */
  /* ---------------------------------------------------------------- */

  function normalizeText(value = '') {
    return String(value)
      .replace(/\u00a0/g, ' ')
      .replace(/[\t\f\v]+/g, ' ')
      .replace(/ {2,}/g, ' ')
      .trim();
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

  function stripTags(value = '') {
    return normalizeText(decodeEntities(String(value).replace(/<[^>]*>/g, ' ')));
  }

  function firstMatch(source, regex) {
    const match = String(source).match(regex);
    return match?.[1] ?? match?.[2] ?? '';
  }

  function firstTag(source, regex) {
    return String(source).match(regex)?.[0] ?? '';
  }

  function parseAttributes(tag) {
    const attrs = {};
    for (const match of String(tag).matchAll(/([:\w.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
      attrs[match[1].toLowerCase()] = decodeEntities(match[2] ?? match[3] ?? '');
    }
    return attrs;
  }

  /* posix 路径：EPUB 内部的 href 一律用 / 分隔 */
  function dirname(target) {
    const index = target.lastIndexOf('/');
    return index < 0 ? '' : target.slice(0, index);
  }

  function normalizePath(target) {
    const parts = String(target).split('/');
    const stack = [];
    for (const part of parts) {
      if (!part || part === '.') continue;
      if (part === '..') { stack.pop(); continue; }
      stack.push(part);
    }
    return stack.join('/');
  }

  function joinPath(...parts) {
    return normalizePath(parts.filter((part) => part !== '' && part != null).join('/'));
  }

  function extensionOf(name) {
    const clean = String(name).split('/').pop() || '';
    const index = clean.lastIndexOf('.');
    return index < 0 ? '' : clean.slice(index).toLowerCase();
  }

  function decodeBytes(bytes) {
    if (!bytes || !bytes.byteLength) return '';
    if (bytes.byteLength >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
      return utf8.decode(bytes.subarray(3));
    }
    if (bytes.byteLength >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
      return utf16le.decode(bytes.subarray(2));
    }
    if (bytes.byteLength >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
      return utf16be.decode(bytes.subarray(2));
    }
    try {
      return utf8Fatal.decode(bytes);
    } catch {
      try {
        return gb18030.decode(bytes);
      } catch {
        return utf8.decode(bytes);
      }
    }
  }

  /* ---------------------------------------------------------------- */
  /* ZIP：只实现 EPUB 需要的读取能力                                    */
  /* ---------------------------------------------------------------- */

  class ZipArchive {
    constructor(buffer) {
      this.buffer = buffer;
      this.view = new DataView(buffer);
      this.entries = new Map();
      this.#readCentralDirectory();
    }

    #readCentralDirectory() {
      const buffer = this.buffer;
      const view = this.view;
      if (buffer.byteLength < 22) throw new Error('不是有效的 EPUB 文件');

      let eocd = -1;
      const min = Math.max(0, buffer.byteLength - 22 - 0xffff);
      for (let i = buffer.byteLength - 22; i >= min; i -= 1) {
        if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
      }
      if (eocd < 0) throw new Error('找不到 EPUB 的 ZIP 目录');

      const count = view.getUint16(eocd + 10, true);
      const centralOffset = view.getUint32(eocd + 16, true);
      if (count === 0xffff || centralOffset === 0xffffffff) {
        throw new Error('暂不支持 ZIP64 格式的 EPUB');
      }

      let pointer = centralOffset;
      for (let i = 0; i < count; i += 1) {
        if (pointer + 46 > buffer.byteLength || view.getUint32(pointer, true) !== 0x02014b50) break;
        const flags = view.getUint16(pointer + 8, true);
        const method = view.getUint16(pointer + 10, true);
        const compressedSize = view.getUint32(pointer + 20, true);
        const size = view.getUint32(pointer + 24, true);
        const nameLength = view.getUint16(pointer + 28, true);
        const extraLength = view.getUint16(pointer + 30, true);
        const commentLength = view.getUint16(pointer + 32, true);
        const localOffset = view.getUint32(pointer + 42, true);
        const name = utf8.decode(new Uint8Array(buffer, pointer + 46, nameLength))
          .replace(/\\/g, '/');
        this.entries.set(name, {
          name, method, compressedSize, size, localOffset, encrypted: Boolean(flags & 1),
        });
        pointer += 46 + nameLength + extraLength + commentLength;
      }
      if (!this.entries.size) throw new Error('EPUB 中没有可读取的文件');
    }

    has(name) {
      return this.entries.has(name);
    }

    async read(name) {
      const entry = this.entries.get(name);
      if (!entry) return null;
      if (entry.encrypted) throw new Error(`EPUB 文件已加密：${name}`);
      const view = this.view;
      const local = entry.localOffset;
      if (local + 30 > this.buffer.byteLength || view.getUint32(local, true) !== 0x04034b50) {
        throw new Error(`EPUB 文件条目损坏：${name}`);
      }
      const nameLength = view.getUint16(local + 26, true);
      const extraLength = view.getUint16(local + 28, true);
      const start = local + 30 + nameLength + extraLength;
      const data = new Uint8Array(this.buffer, start, entry.compressedSize);
      if (entry.method === 0) return data.slice();
      if (entry.method === 8) return inflateRaw(data);
      throw new Error(`不支持的 EPUB 压缩方式：${entry.method}`);
    }

    async text(name) {
      const data = await this.read(name);
      return data ? decodeBytes(data) : '';
    }
  }

  async function inflateRaw(bytes) {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    const buffer = await new Response(stream).arrayBuffer();
    return new Uint8Array(buffer);
  }

  /* ---------------------------------------------------------------- */
  /* EPUB：用 DOM 解析 XHTML，按目录锚点切章，并提取脚注                 */
  /* ---------------------------------------------------------------- */

  const BLOCK_TAGS = new Set([
    'address', 'article', 'aside', 'blockquote', 'caption', 'center', 'dd',
    'div', 'dl', 'dt', 'figcaption', 'figure', 'footer', 'form', 'h1', 'h2',
    'h3', 'h4', 'h5', 'h6', 'header', 'hr', 'li', 'main', 'nav', 'ol', 'p',
    'pre', 'section', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'tr', 'ul',
  ]);
  const SKIP_TAGS = new Set(['script', 'style', 'svg', 'math', 'rt', 'rp', 'noscript', 'template']);
  const VOID_TAGS = new Set([
    'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link',
    'meta', 'param', 'source', 'track', 'wbr',
  ]);

  const NOTE_LABEL = /^[\[\(（]?\s*(?:\d{1,3}|[*†‡§¶])\s*[\]\)）]?$/;
  const NOTE_HEADING = /^(?:注\s*释|注|notes?)$/i;
  const PART_TITLE = /^(?:第\s*[0-9零〇一二三四五六七八九十百千万两]+\s*[卷部篇]|(?:part|volume|book)\b)/i;
  const BOILERPLATE_TOC = /^(?:目录|目次|contents|table of contents|版权页|copyright(?: page)?|cover|封面|书名页|扉页|title ?page|nav(?:igation)?)$/i;

  function safeDecode(value) {
    try { return decodeURIComponent(value); } catch { return value; }
  }

  function parseHref(baseFile, href) {
    const raw = decodeEntities(String(href || '').trim());
    if (!raw || /^[a-z][a-z0-9+.-]*:/i.test(raw) || raw.startsWith('//')) return null;
    const hashIndex = raw.indexOf('#');
    const pathPart = (hashIndex < 0 ? raw : raw.slice(0, hashIndex)).split('?')[0];
    const fragment = hashIndex < 0 ? '' : safeDecode(raw.slice(hashIndex + 1));
    let path = baseFile;
    if (pathPart) path = normalizePath(joinPath(dirname(baseFile), safeDecode(pathPart)));
    return { path, fragment };
  }

  function parseXmlDocument(text) {
    if (typeof DOMParser === 'undefined') return null;
    try {
      const doc = new DOMParser().parseFromString(String(text), 'application/xml');
      if (!doc || doc.getElementsByTagName('parsererror').length) return null;
      return doc;
    } catch {
      return null;
    }
  }

  function parseHtmlDocument(text) {
    const xml = parseXmlDocument(text);
    if (xml) return xml;
    /* XHTML 的 <span/>、<a/> 在 HTML 解析器里不会自闭合，先补全再退回 HTML 解析。 */
    const source = String(text).replace(
      /<([a-zA-Z][\w:.-]*)((?:[^>"']|"[^"]*"|'[^']*')*)\/>/g,
      (whole, tag, attrs) => (VOID_TAGS.has(tag.toLowerCase()) ? whole : `<${tag}${attrs}></${tag}>`),
    );
    return new DOMParser().parseFromString(source, 'text/html');
  }

  function documentBody(doc) {
    return doc.body || doc.getElementsByTagName('body')[0] || doc.documentElement;
  }

  function localTag(element) {
    return String(element.localName || element.tagName || '').toLowerCase();
  }

  function anchorName(element) {
    const id = element.getAttribute('id');
    if (id) return id;
    return localTag(element) === 'a' ? (element.getAttribute('name') || '') : '';
  }

  function containsBlock(element) {
    for (const child of element.children) {
      if (BLOCK_TAGS.has(localTag(child))) return true;
      if (containsBlock(child)) return true;
    }
    return false;
  }

  function isFootnoteContainer(element) {
    const type = String(element.getAttribute('epub:type') || '').toLowerCase();
    const role = String(element.getAttribute('role') || '').toLowerCase();
    const className = String(element.getAttribute('class') || '').toLowerCase();
    return type.split(/\s+/).includes('footnote')
      || role === 'doc-footnote'
      || /(?:^|\s)(?:footnote|foot-note)(?:\s|$)/.test(className);
  }

  function cleanInlineText(value) {
    return String(value)
      .replace(/\u00a0/g, ' ')
      .replace(/[\t\f\v\r\n]+/g, ' ')
      .replace(/ {2,}/g, ' ');
  }

  function pushTextRun(runs, value) {
    const text = cleanInlineText(value);
    if (!text) return;
    const last = runs[runs.length - 1];
    if (last && last.type === 'text') last.text += text;
    else runs.push({ type: 'text', text });
  }

  function noteLabel(value, fallbackIndex) {
    const text = normalizeText(value || '');
    if (!text) return `[${fallbackIndex || 1}]`;
    const match = text.match(/^[\[\(（]?\s*([0-9a-zA-Z*†‡§¶]{1,8})\s*[\]\)）]?$/);
    if (match) return `[${match[1]}]`;
    return text.slice(0, 24);
  }

  function runsToText(runs) {
    return normalizeText((runs || []).map((run) => (
      run.type === 'note' ? (run.label || '') : (run.text || '')
    )).join(''));
  }

  function findFirstMeaningful(node) {
    if (node.nodeType === 3) {
      return normalizeText(node.nodeValue || '') ? { type: 'text' } : null;
    }
    if (node.nodeType !== 1) return null;
    const element = node;
    const tag = localTag(element);
    if (SKIP_TAGS.has(tag) || tag === 'img' || tag === 'br') return null;
    if (tag === 'sup') {
      const anchor = element.querySelector('a[href]');
      if (anchor && NOTE_LABEL.test(normalizeText(anchor.textContent || ''))) return { type: 'ref' };
    }
    if (tag === 'a') {
      const href = element.getAttribute('href');
      const label = normalizeText(element.textContent || '');
      if (href && NOTE_LABEL.test(label)) {
        return {
          type: 'link',
          node: element,
          inSup: Boolean(element.closest && element.closest('sup')),
        };
      }
      return label ? { type: 'text' } : null;
    }
    for (const child of element.childNodes) {
      const found = findFirstMeaningful(child);
      if (found) return found;
    }
    return null;
  }

  function detectNoteReference(element, path) {
    const tag = localTag(element);
    if (tag !== 'a' && tag !== 'sup') return null;
    const anchor = tag === 'a' ? element : element.querySelector('a[href]');
    if (!anchor) return null;
    const href = anchor.getAttribute('href');
    if (!href) return null;
    const label = normalizeText(anchor.textContent || '');
    if (!label || label.length > 12 || !NOTE_LABEL.test(label)) return null;
    if (tag === 'a') {
      const parent = element.parentElement;
      if (!parent || localTag(parent) !== 'sup') return null;
    }
    const target = parseHref(path, href);
    if (!target || !target.fragment) return null;
    return {
      type: 'note',
      label: noteLabel(label, 1),
      noteId: `${target.path}#${target.fragment}`,
    };
  }

  function inlineRuns(root, path, skipNode) {
    const runs = [];
    const walk = (node) => {
      if (node === skipNode) return;
      if (node.nodeType === 3) {
        pushTextRun(runs, node.nodeValue || '');
        return;
      }
      if (node.nodeType !== 1) return;
      const element = node;
      const tag = localTag(element);
      if (SKIP_TAGS.has(tag)) return;
      if (tag === 'br') { pushTextRun(runs, ' '); return; }
      if (tag === 'img') return;
      if (tag === 'a' || tag === 'sup') {
        const note = detectNoteReference(element, path);
        if (note) { runs.push(note); return; }
      }
      for (const child of element.childNodes) walk(child);
    };
    walk(root);

    const cleaned = [];
    for (const run of runs) {
      if (run.type === 'text') {
        run.text = run.text.replace(/ {2,}/g, ' ');
        if (!run.text) continue;
      }
      const last = cleaned[cleaned.length - 1];
      if (run.type === 'text' && last && last.type === 'text') last.text += run.text;
      else cleaned.push(run);
    }
    if (cleaned.length && cleaned[0].type === 'text') cleaned[0].text = cleaned[0].text.replace(/^\s+/, '');
    if (cleaned.length) {
      const last = cleaned[cleaned.length - 1];
      if (last.type === 'text') last.text = last.text.replace(/\s+$/, '');
    }
    return cleaned.filter((run) => run.type === 'note' || run.text);
  }

  function detectNoteDefinition(element, path) {
    const first = findFirstMeaningful(element);
    if (!first || first.type !== 'link' || first.inSup) return null;
    const href = first.node.getAttribute('href');
    const target = parseHref(path, href);
    if (!target || !target.fragment) return null;
    const label = normalizeText(first.node.textContent || '');
    if (!NOTE_LABEL.test(label)) return null;
    const runs = inlineRuns(element, path, first.node);
    const text = runsToText(runs);
    if (!text) return null;
    return {
      label: noteLabel(label, 1),
      runs,
      text,
      backlink: `${target.path}#${target.fragment}`,
    };
  }

  function detectFootnoteContainer(element, path) {
    if (!isFootnoteContainer(element)) return null;
    let backlinkAnchor = null;
    for (const anchor of element.querySelectorAll('a[href]')) {
      const label = normalizeText(anchor.textContent || '');
      const target = parseHref(path, anchor.getAttribute('href'));
      if (NOTE_LABEL.test(label) && target && target.fragment) { backlinkAnchor = anchor; break; }
    }
    const runs = inlineRuns(element, path, backlinkAnchor);
    const text = runsToText(runs);
    if (!text) return null;
    let backlink = '';
    if (backlinkAnchor) {
      const target = parseHref(path, backlinkAnchor.getAttribute('href'));
      if (target && target.fragment) backlink = `${target.path}#${target.fragment}`;
    }
    return {
      label: backlinkAnchor ? noteLabel(backlinkAnchor.textContent, 1) : '',
      runs,
      text,
      backlink,
    };
  }

  function isHeadingBlock(element, text) {
    const tag = localTag(element);
    if (/^h[1-6]$/.test(tag)) return true;
    if ((element.getAttribute('role') || '').toLowerCase() === 'heading') return true;
    const className = String(element.getAttribute('class') || '').toLowerCase();
    if (/(?:^|\s)(?:chapter-title|chaptertitle|title|heading|headline)(?:\s|$)/.test(className)) return true;
    if (element.querySelector('font[size="7"],font[size="6"],font[size="5"]')) return text.length < 160;
    const align = String(element.getAttribute('align') || '').toLowerCase();
    if (align === 'center' && text.length > 0 && text.length < 60 && !/[。！？；：,，]/.test(text)) return true;
    return false;
  }

  function analyzeDocument(source, path) {
    const doc = parseHtmlDocument(source);
    const body = documentBody(doc);
    const idMap = new Map();
    for (const element of doc.querySelectorAll('[id], a[name]')) {
      const id = anchorName(element);
      if (id && !idMap.has(id)) idMap.set(id, element);
    }
    const blocks = [];
    if (!body) return { path, doc, idMap, blocks };

    let pendingIds = [];

    const pushPending = (element) => {
      const ownId = anchorName(element);
      if (ownId) pendingIds.push(ownId);
      for (const nested of element.querySelectorAll('[id], a[name]')) {
        const id = anchorName(nested);
        if (id && id !== ownId) pendingIds.push(id);
      }
    };

    const addBlock = (element, pending) => {
      const ownId = anchorName(element);
      const insideIds = [];
      if (ownId) insideIds.push(ownId);
      for (const nested of element.querySelectorAll('[id], a[name]')) {
        const id = anchorName(nested);
        if (id && id !== ownId) insideIds.push(id);
      }
      const ids = [...new Set([...pending, ...insideIds])];

      const footnote = detectFootnoteContainer(element, path);
      const noteDef = footnote || detectNoteDefinition(element, path);
      const runs = noteDef ? noteDef.runs : inlineRuns(element, path);
      const text = runsToText(runs);
      if (!text && !noteDef) {
        pendingIds.push(...ids);
        return;
      }
      blocks.push({
        element,
        ids,
        runs,
        text,
        noteDef: noteDef || null,
        headingLike: noteDef ? false : isHeadingBlock(element, text),
      });
    };

    const visit = (parent) => {
      for (const node of parent.childNodes) {
        if (node.nodeType !== 1) continue;
        const element = node;
        const tag = localTag(element);
        if (SKIP_TAGS.has(tag)) continue;
        if (!BLOCK_TAGS.has(tag)) {
          pushPending(element);
          continue;
        }
        if (isFootnoteContainer(element)) {
          const pending = pendingIds;
          pendingIds = [];
          addBlock(element, pending);
          continue;
        }
        if (containsBlock(element)) {
          visit(element);
        } else {
          const pending = pendingIds;
          pendingIds = [];
          addBlock(element, pending);
        }
      }
    };

    visit(body);
    return { path, doc, idMap, blocks };
  }

  function parseNcxToc(xml, tocFile) {
    const entries = [];
    const doc = parseXmlDocument(xml);
    if (doc) {
      const navMaps = doc.getElementsByTagName('navMap');
      if (navMaps.length) {
        const walk = (parent, depth) => {
          for (const node of parent.children) {
            if (localTag(node) !== 'navpoint') continue;
            let title = '';
            let src = '';
            for (const child of node.children) {
              const name = localTag(child);
              if (name === 'navlabel') title = normalizeText(child.textContent || '');
              else if (name === 'content') src = child.getAttribute('src') || '';
            }
            const target = parseHref(tocFile, src);
            if (title && target) {
              entries.push({
                title: title.slice(0, 160),
                path: target.path,
                fragment: target.fragment,
                depth,
              });
            }
            walk(node, depth + 1);
          }
        };
        walk(navMaps[0], 0);
        if (entries.length) return entries;
      }
    }

    const navMap = firstMatch(xml, /<navMap\b[^>]*>([\s\S]*?)<\/navMap\s*>/i);
    if (!navMap) return [];
    const tokenPattern = /<navPoint\b[^>]*>|<\/navPoint\s*>|<navLabel\b[^>]*>([\s\S]*?)<\/navLabel\s*>|<content\b[^>]*\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)')[^>]*\/?>/gi;
    const stack = [];
    const collected = [];
    for (const match of navMap.matchAll(tokenPattern)) {
      const raw = match[0];
      if (/^<navPoint\b/i.test(raw)) {
        const item = { title: '', src: '', depth: stack.length };
        stack.push(item);
        collected.push(item);
      } else if (/^<\/navPoint/i.test(raw)) {
        stack.pop();
      } else if (/^<navLabel/i.test(raw)) {
        if (stack.length) stack[stack.length - 1].title = stripTags(match[1] || '');
      } else if (/^<content/i.test(raw)) {
        if (stack.length) stack[stack.length - 1].src = match[2] ?? match[3] ?? '';
      }
    }
    for (const item of collected) {
      const target = parseHref(tocFile, item.src);
      if (item.title && target) {
        entries.push({
          title: item.title.slice(0, 160),
          path: target.path,
          fragment: target.fragment,
          depth: item.depth,
        });
      }
    }
    return entries;
  }

  function parseNavToc(html, navFile) {
    const doc = parseHtmlDocument(html);
    const navs = [...doc.querySelectorAll('nav')];
    if (!navs.length) return [];
    const toc = navs.find((nav) => {
      const type = String(nav.getAttribute('epub:type') || '').toLowerCase();
      const role = String(nav.getAttribute('role') || '').toLowerCase();
      const id = String(nav.getAttribute('id') || '').toLowerCase();
      return /\btoc\b/.test(type) || role === 'doc-toc' || id === 'toc';
    }) || navs[0];
    const entries = [];
    for (const anchor of toc.querySelectorAll('a[href]')) {
      const title = normalizeText(anchor.textContent || '');
      const target = parseHref(navFile, anchor.getAttribute('href'));
      if (!title || !target) continue;
      let depth = 0;
      for (let parent = anchor.parentElement; parent && parent !== toc; parent = parent.parentElement) {
        if (localTag(parent) === 'ol') depth += 1;
      }
      entries.push({
        title: title.slice(0, 160),
        path: target.path,
        fragment: target.fragment,
        depth,
      });
    }
    return entries;
  }

  function cleanTocEntries(entries) {
    const result = [];
    const seen = new Set();
    for (const entry of entries) {
      if (!entry || !entry.title || !entry.path) continue;
      if (BOILERPLATE_TOC.test(entry.title)) continue;
      if (/(?:^|\/)(?:nav|toc)\.(?:x?html?|ncx)$/i.test(entry.path)) continue;
      const fragment = entry.fragment || '';
      const key = `${entry.path}#${fragment}`;
      if (seen.has(key)) continue;
      seen.add(key);
      result.push({
        title: normalizeText(entry.title).slice(0, 160),
        path: entry.path,
        fragment,
        depth: Number(entry.depth) || 0,
      });
    }
    return result;
  }

  function blockIndexForAnchor(info, fragment) {
    if (!fragment) return 0;
    const anchor = info.idMap.get(fragment);
    if (!anchor) return -1;
    for (let index = 0; index < info.blocks.length; index += 1) {
      const block = info.blocks[index].element;
      if (block.contains(anchor)) return index;
      if (anchor.compareDocumentPosition(block) & 4) return index;
    }
    return info.blocks.length;
  }

  function looseText(value) {
    return normalizeText(value).replace(/[\s\u3000·:：,，.。;；\-—–]/g, '');
  }

  function formatChapterTitle(rawTitle) {
    let title = normalizeText(rawTitle);
    if (/^\d{1,4}$/.test(title)) title = `第 ${title} 章`;
    return title.slice(0, 160);
  }

  function noteHeadingAt(info, index, end) {
    const block = info.blocks[index];
    if (!block || !NOTE_HEADING.test(block.text)) return false;
    for (let next = index + 1; next < end; next += 1) {
      if (info.blocks[next].noteDef) return true;
      if (info.blocks[next].text) return false;
    }
    return false;
  }

  function paragraphsForSection(info, start, end, rawTitle, displayTitle) {
    const paragraphs = [];
    const orphanNotes = [];
    let leading = true;
    for (let index = start; index < end; index += 1) {
      const block = info.blocks[index];
      if (!block) continue;
      if (block.noteDef) { orphanNotes.push(block); continue; }
      if (!block.runs.length || !block.text) continue;
      if (leading) {
        if (block.headingLike) continue;
        if (looseText(block.text) === looseText(rawTitle)
          || (displayTitle && looseText(block.text) === looseText(displayTitle))) {
          leading = false;
          continue;
        }
        leading = false;
      }
      if (noteHeadingAt(info, index, end)) continue;
      if (/^[\s\-—–·•*]+$/.test(block.text)) continue;
      paragraphs.push({ runs: block.runs });
    }
    return { paragraphs, orphanNotes };
  }

  function paragraphChars(paragraph) {
    return (paragraph.runs || []).reduce((sum, run) => (
      sum + (run.type === 'note' ? 0 : String(run.text || '').replace(/\s/g, '').length)
    ), 0);
  }

  function makeChapter(title, section, path, start, end, part = '') {
    return {
      title: String(title).slice(0, 160),
      part: String(part || '').slice(0, 160),
      paragraphs: section.paragraphs,
      chars: section.paragraphs.reduce((sum, paragraph) => sum + paragraphChars(paragraph), 0),
      notes: [],
      _sourcePath: path,
      _sourceStart: start,
      _sourceEnd: end,
      _orphanNotes: section.orphanNotes.map((block) => block.noteDef?.primaryKey).filter(Boolean),
    };
  }

  function chaptersFromToc(docInfos, spinePaths, tocEntries) {
    const byPath = new Map();
    for (const entry of tocEntries) {
      if (!docInfos.has(entry.path)) continue;
      if (!byPath.has(entry.path)) byPath.set(entry.path, []);
      byPath.get(entry.path).push(entry);
    }

    const chapters = [];
    let part = '';
    for (const path of spinePaths) {
      const entries = byPath.get(path);
      if (!entries || !entries.length) continue;
      const info = docInfos.get(path);
      const points = entries.map((entry) => ({
        entry,
        start: blockIndexForAnchor(info, entry.fragment),
      }));
      if (points.length && points[0].start < 0) points[0].start = 0;

      for (let index = 0; index < points.length; index += 1) {
        const point = points[index];
        const isPart = PART_TITLE.test(point.entry.title);
        if (point.start < 0) {
          if (isPart) part = point.entry.title;
          continue;
        }

        const duplicateLater = points.slice(index + 1).some((next) => next.start === point.start);
        if (duplicateLater) {
          if (isPart) part = point.entry.title;
          continue;
        }

        let end = info.blocks.length;
        for (let next = index + 1; next < points.length; next += 1) {
          if (points[next].start > point.start) {
            end = points[next].start;
            break;
          }
        }
        if (end <= point.start) {
          if (isPart) part = point.entry.title;
          continue;
        }

        const displayTitle = isPart ? point.entry.title : formatChapterTitle(point.entry.title);
        const chapterPart = isPart ? '' : part;
        const section = paragraphsForSection(info, point.start, end, point.entry.title, displayTitle);
        if (isPart) part = point.entry.title;
        if (!section.paragraphs.length) continue;
        chapters.push(makeChapter(displayTitle, section, path, point.start, end, chapterPart));
      }
    }
    return chapters;
  }

  function chaptersFromSpine(docInfos, spinePaths) {
    const chapters = [];
    for (const path of spinePaths) {
      const info = docInfos.get(path);
      if (!info) continue;
      const section = paragraphsForSection(info, 0, info.blocks.length, '', '');
      if (!section.paragraphs.length) continue;
      let title = '';
      for (let index = 0; index < info.blocks.length; index += 1) {
        const block = info.blocks[index];
        if (block.noteDef) continue;
        if (block.headingLike && block.text) { title = block.text; break; }
        if (block.text && block.text.length <= 80 && !/[。！？；]/.test(block.text)) {
          title = block.text;
          break;
        }
      }
      if (!title) {
        const text = runsToText(section.paragraphs[0].runs);
        if (text.length <= 80) title = text;
      }
      if (!title) title = `第 ${chapters.length + 1} 章`;
      chapters.push(makeChapter(title, section, path, 0, info.blocks.length));
    }
    return chapters;
  }

  function indexNoteDefinitions(docInfos) {
    const notes = new Map();
    for (const info of docInfos.values()) {
      info.blocks.forEach((block, blockIndex) => {
        if (!block.noteDef) return;
        const ids = block.ids.length ? block.ids : [`__note_${blockIndex}`];
        const keys = [];
        for (const id of ids) {
          const key = `${info.path}#${id}`;
          keys.push(key);
          if (!notes.has(key)) {
            notes.set(key, {
              key,
              label: block.noteDef.label,
              runs: block.noteDef.runs,
              path: info.path,
              blockIndex,
            });
          }
        }
        block.noteDef.primaryKey = keys[0] || '';
        block.noteDef.keys = keys;
      });
    }
    return notes;
  }

  function attachChapterNotes(chapters, notes) {
    const used = new Set();
    for (const chapter of chapters) {
      const seen = new Set();
      for (const paragraph of chapter.paragraphs) {
        for (const run of paragraph.runs) {
          if (run.type !== 'note' || !run.noteId) continue;
          used.add(run.noteId);
          if (seen.has(run.noteId)) continue;
          seen.add(run.noteId);
          const note = notes.get(run.noteId);
          if (!note) continue;
          chapter.notes.push({
            id: run.noteId,
            label: noteLabel(run.label || note.label, chapter.notes.length + 1),
            runs: note.runs,
          });
        }
      }
    }

    for (const chapter of chapters) {
      for (const key of chapter._orphanNotes || []) {
        if (!key || used.has(key)) continue;
        const note = notes.get(key);
        if (!note) continue;
        if (chapter.notes.some((item) => item.id === key)) continue;
        used.add(key);
        chapter.notes.push({
          id: key,
          label: noteLabel(note.label, chapter.notes.length + 1),
          runs: note.runs,
        });
      }
    }
  }

  async function parseEpub(buffer, filename) {
    const zip = new ZipArchive(buffer);
    const containerXml = await zip.text('META-INF/container.xml');
    if (!containerXml) throw new Error('EPUB 缺少 META-INF/container.xml');

    const rootfileTag = firstTag(containerXml, /<rootfile\b[^>]*>/i);
    let containerOpf = parseAttributes(rootfileTag)['full-path'];
    if (!containerOpf) throw new Error('EPUB 缺少 OPF 描述文件');
    try { containerOpf = decodeURIComponent(containerOpf); } catch { /* 保留原始路径 */ }
    containerOpf = containerOpf.replace(/\\/g, '/').replace(/^\/+/, '');

    const opf = await zip.text(containerOpf);
    if (!opf) throw new Error('无法读取 EPUB 的 OPF 描述文件');

    const opfDir = dirname(containerOpf);
    const manifestXml = firstMatch(opf, /<manifest\b[^>]*>([\s\S]*?)<\/manifest\s*>/i);
    const spineXml = firstMatch(opf, /<spine\b[^>]*>([\s\S]*?)<\/spine\s*>/i);
    const metadataXml = firstMatch(opf, /<metadata\b[^>]*>([\s\S]*?)<\/metadata\s*>/i);

    const manifest = new Map();
    for (const match of manifestXml.matchAll(/<item\b[^>]*\/?>/gi)) {
      const attrs = parseAttributes(match[0]);
      if (!attrs.id || !attrs.href) continue;
      const hrefPath = safeDecode(attrs.href.split('#')[0].split('?')[0]);
      manifest.set(attrs.id, { ...attrs, path: normalizePath(joinPath(opfDir, hrefPath)) });
    }

    const fallbackName = String(filename).replace(/\.epub$/i, '');
    const title = stripTags(firstMatch(metadataXml, /<dc:title\b[^>]*>([\s\S]*?)<\/dc:title>/i)) || fallbackName;
    const author = stripTags(firstMatch(metadataXml, /<dc:creator\b[^>]*>([\s\S]*?)<\/dc:creator>/i));
    const language = stripTags(firstMatch(metadataXml, /<dc:language\b[^>]*>([\s\S]*?)<\/dc:language>/i));

    let coverItem = null;
    const coverId = parseAttributes(firstTag(metadataXml, /<meta\b[^>]*\bname\s*=\s*(?:"cover"|'cover')[^>]*>/i)).content;
    if (coverId && manifest.has(coverId)) coverItem = manifest.get(coverId);
    if (!coverItem) {
      coverItem = [...manifest.values()].find((item) => /cover-image|cover/i.test(item.properties || ''))
        || [...manifest.values()].find((item) => /^cover\.(jpe?g|png|webp|gif)$/i.test(item.path.split('/').pop()));
    }

    let cover = null;
    if (coverItem) {
      try {
        const data = await zip.read(coverItem.path);
        if (data && data.byteLength) {
          const mime = coverItem['media-type'] || MIME[extensionOf(coverItem.path)] || 'image/jpeg';
          cover = new Blob([data], { type: mime });
        }
      } catch { /* 封面损坏不影响阅读 */ }
    }

    let tocEntries = [];
    const ncxItem = [...manifest.values()].find((item) => item['media-type'] === 'application/x-dtbncx+xml' || /\.ncx$/i.test(item.path));
    if (ncxItem && zip.has(ncxItem.path)) tocEntries = parseNcxToc(await zip.text(ncxItem.path), ncxItem.path);
    if (!tocEntries.length) {
      const navItem = [...manifest.values()].find((item) => /(?:^|\s)nav(?:\s|$)/i.test(item.properties || ''));
      if (navItem && zip.has(navItem.path)) tocEntries = parseNavToc(await zip.text(navItem.path), navItem.path);
    }
    tocEntries = cleanTocEntries(tocEntries);

    const spine = [...spineXml.matchAll(/<itemref\b[^>]*\/?>/gi)]
      .map((match) => parseAttributes(match[0]))
      .filter((item) => item.idref);

    const spinePaths = [];
    const seenPaths = new Set();
    for (const spineItem of spine) {
      const item = manifest.get(spineItem.idref);
      if (!item || !zip.has(item.path) || seenPaths.has(item.path)) continue;
      seenPaths.add(item.path);
      spinePaths.push(item.path);
    }
    if (!spinePaths.length) throw new Error('EPUB 中没有找到可阅读的章节');

    const docInfos = new Map();
    for (const path of spinePaths) {
      try {
        docInfos.set(path, analyzeDocument(await zip.text(path), path));
      } catch (error) {
        console.warn(`[epub] ${path}: ${error.message}`);
      }
    }

    const notes = indexNoteDefinitions(docInfos);
    let chapters = tocEntries.length >= 2
      ? chaptersFromToc(docInfos, spinePaths, tocEntries)
      : [];
    if (!chapters.length) chapters = chaptersFromSpine(docInfos, spinePaths);
    if (!chapters.length) throw new Error('EPUB 中没有找到可阅读的章节');

    attachChapterNotes(chapters, notes);

    return {
      filename,
      format: 'epub',
      title: title || fallbackName,
      author,
      language,
      chapters: chapters.map((chapter) => ({
        title: chapter.title,
        part: chapter.part,
        paragraphs: chapter.paragraphs,
        chars: chapter.chars,
        notes: chapter.notes,
      })),
      cover,
    };
  }

  /* ---------------------------------------------------------------- */
  /* TXT                                                               */
  /* ---------------------------------------------------------------- */

  const TXT_HEADING = /^(?:(\d{1,4})\s*[_\-—.、]\s*)?(第\s*[0-9零〇一二三四五六七八九十百千万两]+\s*[章节回卷])(?:\s*[：:、.\-—]?\s*(.*?))?\s*$/u;

  function textToParagraphs(text) {
    return String(text)
      .replace(/\u00a0/g, ' ')
      .split(/\n+/)
      .map((line) => normalizeText(line))
      .filter((line) => line && !/^[\s\-—–·•*]+$/.test(line) && line.length < 50000);
  }

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

  function parseTxt(buffer, filename) {
    const chapters = parseTxtText(decodeBytes(new Uint8Array(buffer)));
    if (!chapters.length) throw new Error('TXT 中没有找到可阅读的正文');
    return {
      filename,
      format: 'txt',
      title: String(filename).replace(/\.txt$/i, ''),
      author: '',
      language: 'zh',
      chapters,
      cover: null,
    };
  }

  /* ---------------------------------------------------------------- */
  /* 书籍标识与加载                                                     */
  /* ---------------------------------------------------------------- */

  function fallbackId(text) {
    let h1 = 0x811c9dc5;
    let h2 = 0x01000193;
    for (let i = 0; i < text.length; i += 1) {
      const code = text.charCodeAt(i);
      h1 = Math.imul(h1 ^ code, 16777619) >>> 0;
      h2 = Math.imul(h2 + code, 2654435761) >>> 0;
    }
    return `${h1.toString(16).padStart(8, '0')}${h2.toString(16).padStart(8, '0')}`.slice(0, 12);
  }

  async function bookId(filename) {
    try {
      const digest = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(filename));
      return [...new Uint8Array(digest).slice(0, 6)]
        .map((byte) => byte.toString(16).padStart(2, '0'))
        .join('');
    } catch {
      return fallbackId(filename);
    }
  }

  async function parse(filename, buffer) {
    const extension = extensionOf(filename);
    const book = extension === '.epub'
      ? await parseEpub(buffer, filename)
      : parseTxt(buffer, filename);
    book.chapterCount = book.chapters.length;
    return book;
  }

  window.ReaderLibrary = { parse, bookId, extensionOf };
})();
