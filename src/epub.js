export const clamp = (v, min, max) => Math.min(Math.max(v, min), max);

export const SERIF_FONT =
  '"KingHwa_OldSong", "京華老宋体", "KingHwaOldSong", "Songti SC", "Noto Serif SC", "STSong", "Baskerville", Georgia, serif';

export const FALLBACK_PALETTES = [
  { cloth: '#4f5b49', dark: '#35412f', sheen: '#c9d5b4' },
  { cloth: '#7a3f35', dark: '#57271f', sheen: '#e3b9a5' },
  { cloth: '#33465d', dark: '#202d40', sheen: '#b8c9de' },
  { cloth: '#a37742', dark: '#775026', sheen: '#f0d8b0' },
  { cloth: '#3a3834', dark: '#201e1b', sheen: '#c9bca8' },
  { cloth: '#6c5260', dark: '#4a3542', sheen: '#dcc3d1' },
];

export function computeBookThickness(pages) {
  const safePages = clamp(Number(pages) || 260, 40, 1600);
  return Number(clamp(0.075 + Math.pow(safePages / 280, 0.78) * 0.125, 0.09, 0.42).toFixed(3));
}

function normalizeZipPath(path) {
  const parts = String(path || '').replace(/\\/g, '/').split('/');
  const out = [];
  for (const part of parts) {
    if (!part || part === '.') continue;
    if (part === '..') out.pop();
    else out.push(part);
  }
  return out.join('/');
}

function resolveRelativePath(baseFilePath, relativeHref) {
  if (!relativeHref) return '';
  let cleanHref = relativeHref.split('#')[0].split('?')[0];
  try {
    cleanHref = decodeURIComponent(cleanHref);
  } catch {}
  const baseParts = normalizeZipPath(baseFilePath).split('/');
  baseParts.pop();
  return normalizeZipPath([...baseParts, cleanHref].join('/'));
}

export function parseZipDirectory(arrayBuffer) {
  const view = new DataView(arrayBuffer);
  const bytes = new Uint8Array(arrayBuffer);
  const decoder = new TextDecoder('utf-8');

  // ZIP EOCD 签名 0x06054b50，最小长度 22 字节，注释最长 65535 字节
  const minEocdOffset = Math.max(0, bytes.length - 65557);
  let eocdOffset = -1;
  for (let i = bytes.length - 22; i >= minEocdOffset; i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocdOffset = i;
      break;
    }
  }
  if (eocdOffset === -1) {
    throw new Error('无效的 EPUB 文件（未找到 ZIP 目录尾记录）');
  }

  const totalEntries = view.getUint16(eocdOffset + 10, true);
  const centralDirOffset = view.getUint32(eocdOffset + 16, true);

  const entries = new Map();
  const entriesLower = new Map();
  let ptr = centralDirOffset;

  // 中央目录项签名 0x02014b50，固定头长 46 字节
  for (let i = 0; i < totalEntries && ptr + 46 <= bytes.length; i++) {
    if (view.getUint32(ptr, true) !== 0x02014b50) break;

    const compressionMethod = view.getUint16(ptr + 10, true);
    const compressedSize = view.getUint32(ptr + 20, true);
    const uncompressedSize = view.getUint32(ptr + 24, true);
    const nameLen = view.getUint16(ptr + 28, true);
    const extraLen = view.getUint16(ptr + 30, true);
    const commentLen = view.getUint16(ptr + 32, true);
    const localHeaderOffset = view.getUint32(ptr + 42, true);

    const rawName = decoder.decode(bytes.subarray(ptr + 46, ptr + 46 + nameLen));
    const name = normalizeZipPath(rawName);
    const entry = {
      name,
      compressionMethod,
      compressedSize,
      uncompressedSize,
      localHeaderOffset,
    };

    entries.set(name, entry);
    entriesLower.set(name.toLowerCase(), entry);
    ptr += 46 + nameLen + extraLen + commentLen;
  }

  async function extractBytes(entryOrPath) {
    const entry =
      typeof entryOrPath === 'string'
        ? entries.get(normalizeZipPath(entryOrPath)) ||
          entriesLower.get(normalizeZipPath(entryOrPath).toLowerCase())
        : entryOrPath;
    if (!entry) return null;

    // 本地文件头签名 0x04034b50，固定头长 30 字节
    const localOffset = entry.localHeaderOffset;
    if (localOffset + 30 > bytes.length) return null;
    if (view.getUint32(localOffset, true) !== 0x04034b50) return null;

    const localNameLen = view.getUint16(localOffset + 26, true);
    const localExtraLen = view.getUint16(localOffset + 28, true);
    const dataStart = localOffset + 30 + localNameLen + localExtraLen;
    if (dataStart + entry.compressedSize > bytes.length) return null;
    const compressed = bytes.subarray(dataStart, dataStart + entry.compressedSize);

    if (entry.compressionMethod === 0) return compressed;

    if (entry.compressionMethod === 8) {
      const ds = new DecompressionStream('deflate-raw');
      const writer = ds.writable.getWriter();
      writer.write(compressed).catch(() => {});
      writer.close().catch(() => {});

      const reader = ds.readable.getReader();
      const chunks = [];
      let totalLen = 0;
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          if (value) {
            chunks.push(value);
            totalLen += value.byteLength;
          }
        }
      } catch {
        return null;
      }

      const out = new Uint8Array(totalLen);
      let offset = 0;
      for (const chunk of chunks) {
        out.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return out;
    }

    return null;
  }

  const textCache = new Map();
  async function extractText(entryOrPath) {
    const rawName =
      typeof entryOrPath === 'string' ? normalizeZipPath(entryOrPath) : entryOrPath?.name || '';
    const key = rawName.toLowerCase();
    if (textCache.has(key)) return textCache.get(key);
    const data = await extractBytes(entryOrPath);
    const text = data ? decoder.decode(data) : null;
    textCache.set(key, text);
    return text;
  }

  return { entries, entriesLower, extractBytes, extractText };
}

function parseXml(xmlText) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(xmlText, 'application/xml');
  if (doc.querySelector('parsererror')) {
    return parser.parseFromString(xmlText, 'text/html');
  }
  return doc;
}

function findFirstText(doc, selectors) {
  for (const sel of selectors) {
    const el = doc.querySelector(sel);
    if (el?.textContent?.trim()) return el.textContent.trim();
  }
  for (const el of doc.getElementsByTagName('*')) {
    const local = (el.localName || el.tagName || '').toLowerCase();
    if (selectors.includes(local) && el.textContent?.trim()) {
      return el.textContent.trim();
    }
  }
  return '';
}

function hashString(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h);
}

function rgbToHex(r, g, b) {
  const toHex = (n) => clamp(Math.round(n), 0, 255).toString(16).padStart(2, '0');
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

function extractPaletteFromCanvas(canvas, fallbackIndex = 0) {
  try {
    const ctx = canvas.getContext('2d');
    const { width, height } = canvas;
    const data = ctx.getImageData(0, 0, width, height).data;

    let rSum = 0;
    let gSum = 0;
    let bSum = 0;
    let weightSum = 0;
    const step = 6 * 4;

    for (let i = 0; i < data.length; i += step) {
      const pixelIndex = i >> 2;
      const x = pixelIndex % width;
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      const a = data[i + 3];
      if (a < 128) continue;

      const max = Math.max(r, g, b);
      const min = Math.min(r, g, b);
      const luma = 0.299 * r + 0.587 * g + 0.114 * b;
      if (luma > 240 || luma < 14) continue;

      const sat = max > 0 ? (max - min) / max : 0;
      const edgeWeight = x < width * 0.18 ? 2.4 : 1.0;
      const w = (0.4 + sat * 1.4) * edgeWeight;

      rSum += r * w;
      gSum += g * w;
      bSum += b * w;
      weightSum += w;
    }

    if (weightSum < 10) {
      return FALLBACK_PALETTES[fallbackIndex % FALLBACK_PALETTES.length];
    }

    const r = (rSum / weightSum) * 0.72 + 22;
    const g = (gSum / weightSum) * 0.72 + 20;
    const b = (bSum / weightSum) * 0.72 + 18;

    return {
      cloth: rgbToHex(r, g, b),
      dark: rgbToHex(r * 0.68, g * 0.68, b * 0.68),
      sheen: rgbToHex(
        Math.min(255, r * 1.45 + 55),
        Math.min(255, g * 1.42 + 50),
        Math.min(255, b * 1.38 + 45)
      ),
    };
  } catch {
    return FALLBACK_PALETTES[fallbackIndex % FALLBACK_PALETTES.length];
  }
}

function wrapLines(ctx, text, maxWidth, maxLines = 3) {
  const chars = Array.from(text || '');
  const lines = [];
  let current = '';

  for (const ch of chars) {
    const test = current + ch;
    if (ctx.measureText(test).width > maxWidth && current.length > 0) {
      lines.push(current);
      current = ch;
      if (lines.length >= maxLines) break;
    } else {
      current = test;
    }
  }
  if (current && lines.length < maxLines) lines.push(current);
  if (lines.length === maxLines && chars.length > lines.join('').length) {
    lines[maxLines - 1] = lines[maxLines - 1].slice(0, -1) + '…';
  }
  return lines;
}

function addBookbindingOverlay(ctx, w, h) {
  const groove = ctx.createLinearGradient(0, 0, 28, 0);
  groove.addColorStop(0, 'rgba(15, 10, 6, 0.36)');
  groove.addColorStop(0.45, 'rgba(15, 10, 6, 0.06)');
  groove.addColorStop(0.65, 'rgba(255, 248, 235, 0.08)');
  groove.addColorStop(0.85, 'rgba(15, 10, 6, 0.14)');
  groove.addColorStop(1, 'rgba(15, 10, 6, 0)');
  ctx.fillStyle = groove;
  ctx.fillRect(0, 0, 28, h);

  ctx.strokeStyle = 'rgba(255, 245, 228, 0.12)';
  ctx.lineWidth = 2;
  ctx.strokeRect(1, 1, w - 2, h - 2);
}

function renderGeneratedCoverCanvas(title, author, palette) {
  const canvas = document.createElement('canvas');
  canvas.width = 384;
  canvas.height = 512;
  const ctx = canvas.getContext('2d');
  const { width: w, height: h } = canvas;

  ctx.fillStyle = palette.cloth;
  ctx.fillRect(0, 0, w, h);

  for (let y = 0; y < h; y += 3) {
    ctx.fillStyle = y % 6 === 0 ? 'rgba(255,255,255,0.025)' : 'rgba(0,0,0,0.03)';
    ctx.fillRect(0, y, w, 1);
  }

  ctx.strokeStyle = '#d6b678';
  ctx.lineWidth = 3;
  ctx.strokeRect(26, 26, w - 52, h - 52);
  ctx.lineWidth = 1;
  ctx.strokeRect(33, 33, w - 66, h - 66);

  const labelW = w - 116;
  const labelH = 220;
  const labelX = (w - labelW) / 2;
  const labelY = 92;

  ctx.fillStyle = '#d6b678';
  ctx.fillRect(labelX - 5, labelY - 5, labelW + 10, labelH + 10);
  ctx.fillStyle = '#efe4cf';
  ctx.fillRect(labelX, labelY, labelW, labelH);

  ctx.fillStyle = '#2a221b';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = `600 26px ${SERIF_FONT}`;

  const lines = wrapLines(ctx, title || '', labelW - 36, 3);
  const lineHeight = 36;
  const startY = labelY + labelH * 0.42 - ((lines.length - 1) * lineHeight) / 2;
  lines.forEach((line, i) => ctx.fillText(line, w / 2, startY + i * lineHeight));

  ctx.fillStyle = '#b99352';
  ctx.fillRect(w / 2 - 42, labelY + labelH - 64, 84, 2);

  if (author) {
    ctx.fillStyle = '#5a4b3c';
    ctx.font = `400 15px ${SERIF_FONT}`;
    const authorLines = wrapLines(ctx, author, labelW - 40, 1);
    ctx.fillText(authorLines[0], w / 2, labelY + labelH - 34);
  }

  addBookbindingOverlay(ctx, w, h);
  return canvas;
}

async function decodeImageFromBytes(bytes, mimeType = 'image/jpeg') {
  const blob = new Blob([bytes], { type: mimeType });
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.decoding = 'async';
    await new Promise((resolve, reject) => {
      img.onload = resolve;
      img.onerror = reject;
      img.src = url;
    });
    return img;
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function readTocMap(zip, tocPath, isNav) {
  const byPath = new Map();
  if (!tocPath) return byPath;
  const xml = await zip.extractText(tocPath);
  if (!xml) return byPath;

  const localName = (el) => (el?.localName || el?.tagName || '').toLowerCase();
  const childEls = (el, name) => Array.from(el?.children || []).filter((c) => localName(c) === name);

  const add = (href, label, level) => {
    if (!href) return;
    const [rawPart, rawFrag] = href.split('#');
    const path = resolveRelativePath(tocPath, rawPart || '');
    const clean = String(label || '').replace(/\s+/g, ' ').trim();
    if (!path || !clean) return;
    const key = path.toLowerCase();
    let frag = rawFrag || '';
    try {
      frag = decodeURIComponent(frag);
    } catch {}
    const list = byPath.get(key) || [];
    list.push({ label: clean, level: clamp(Number(level) || 0, 0, 2), fragment: frag });
    byPath.set(key, list);
  };

  if (isNav || /<nav[\s>]/i.test(xml)) {
    const doc = new DOMParser().parseFromString(xml, 'text/html');
    const navs = Array.from(doc.querySelectorAll('nav'));
    const nav =
      navs.find((n) =>
        /toc/i.test(
          `${n.getAttribute('epub:type') || ''} ${n.getAttribute('type') || ''} ${n.getAttribute('class') || ''}`
        )
      ) || navs[0];
    const root = nav || doc.body || doc;

    const walk = (ol, level) => {
      for (const li of childEls(ol, 'li')) {
        const link = li.querySelector('a[href], span');
        if (link) add(link.getAttribute('href'), link.textContent, level);
        for (const nested of childEls(li, 'ol')) walk(nested, level + 1);
      }
    };

    const topOl = root.querySelector('ol');
    if (topOl) walk(topOl, 0);
    else for (const a of root.querySelectorAll('a[href]')) add(a.getAttribute('href'), a.textContent, 0);
  } else {
    const doc = parseXml(xml);
    for (const el of Array.from(doc.getElementsByTagName('*'))) {
      if (localName(el) !== 'navpoint') continue;
      let label = '';
      let src = '';
      for (const child of Array.from(el.children || [])) {
        const cname = localName(child);
        if (cname === 'navlabel') {
          label = child.textContent || '';
        } else if (cname === 'content') {
          src = child.getAttribute('src') || '';
        }
      }
      if (!label || !src) {
        for (const child of Array.from(el.getElementsByTagName('*'))) {
          const name = localName(child);
          if (!label && name === 'text') label = child.textContent;
          if (!src && name === 'content') src = child.getAttribute('src') || '';
        }
      }
      let level = 0;
      let parent = el.parentElement;
      while (parent) {
        if (localName(parent) === 'navpoint') level += 1;
        parent = parent.parentElement;
      }
      add(src, label, level);
    }
  }

  return byPath;
}

const BLOCK_TAGS = new Set([
  'p', 'div', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'blockquote', 'li', 'section', 'article', 'dt', 'dd',
  'pre', 'header', 'footer', 'aside', 'main', 'figure', 'figcaption', 'tr',
]);

const INLINE_FORMAT_TAGS = new Set(['em', 'i', 'strong', 'b']);

function escapeHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export function stripHtml(str) {
  return String(str || '')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function normalizeHeadingCompare(str) {
  return stripHtml(str)
    .replace(/[\s\p{P}\p{S}]+/gu, '')
    .toLowerCase();
}

function extractSectionsFromBody(body, tocItems) {
  const fragmentMap = new Map();
  if (tocItems && tocItems.length > 0) {
    for (const item of tocItems) {
      if (item.fragment && !fragmentMap.has(item.fragment)) {
        fragmentMap.set(item.fragment, item);
      }
    }
  }

  const firstToc = tocItems?.[0] || null;
  const sections = [
    {
      title: firstToc?.label || '',
      level: firstToc?.level || 0,
      inToc: Boolean(firstToc),
      paragraphs: [],
    },
  ];
  let currentSection = sections[0];
  let inlineBuf = '';

  const flush = () => {
    const raw = inlineBuf.trim();
    inlineBuf = '';
    if (!raw) return;
    const lines = raw.split('\n');
    for (const line of lines) {
      const clean = stripHtml(line).trim();
      if (clean.length > 0) {
        currentSection.paragraphs.push(line.trim());
      }
    }
  };

  const walk = (node) => {
    if (!node) return;
    if (node.nodeType === 3) {
      const text = node.nodeValue.replace(/[\t\r\n ]+/g, ' ');
      inlineBuf += escapeHtml(text);
      return;
    }
    if (node.nodeType !== 1) return;

    const id = node.getAttribute('id') || node.getAttribute('name') || '';
    if (id && fragmentMap.has(id)) {
      const matchedToc = fragmentMap.get(id);
      fragmentMap.delete(id);
      flush();
      if (currentSection.paragraphs.length > 0 || (currentSection.title && currentSection.title !== matchedToc.label)) {
        currentSection = {
          title: matchedToc.label,
          level: matchedToc.level,
          inToc: true,
          paragraphs: [],
        };
        sections.push(currentSection);
      } else {
        currentSection.title = matchedToc.label;
        currentSection.level = matchedToc.level;
        currentSection.inToc = true;
      }
    }

    const tag = (node.localName || node.tagName || '').toLowerCase();
    if (tag === 'br' || tag === 'hr') {
      inlineBuf += '\n';
      return;
    }

    const isBlock = BLOCK_TAGS.has(tag);
    if (isBlock) flush();

    if (INLINE_FORMAT_TAGS.has(tag)) {
      const outTag = tag === 'i' ? 'em' : tag === 'b' ? 'strong' : tag;
      inlineBuf += `<${outTag}>`;
      for (const child of node.childNodes) walk(child);
      inlineBuf += `</${outTag}>`;
    } else {
      for (const child of node.childNodes) walk(child);
    }

    if (isBlock) flush();
  };

  walk(body);
  flush();
  return sections;
}

export async function parseEpubFile(file) {
  const arrayBuffer = await file.arrayBuffer();
  const zip = parseZipDirectory(arrayBuffer);

  let opfPath = '';
  const containerXml = await zip.extractText('META-INF/container.xml');
  if (containerXml) {
    const containerDoc = parseXml(containerXml);
    const rootfile = containerDoc.querySelector('rootfile[full-path]');
    if (rootfile) opfPath = normalizeZipPath(rootfile.getAttribute('full-path'));
  }

  if (!opfPath) {
    for (const [name] of zip.entries) {
      if (name.toLowerCase().endsWith('.opf')) {
        opfPath = name;
        break;
      }
    }
  }

  let title = file.name.replace(/\.epub$/i, '').trim() || '未命名书籍';
  let author = '';
  let coverEntryPath = '';
  let coverMime = 'image/jpeg';
  let declaredPages = 0;
  let tocPath = '';
  let tocIsNav = false;
  const spineHrefs = [];
  const manifestById = new Map();
  const manifestItems = [];

  if (opfPath) {
    const opfXml = await zip.extractText(opfPath);
    if (opfXml) {
      const opfDoc = parseXml(opfXml);

      const extractedTitle = findFirstText(opfDoc, ['dc\\:title', 'title']);
      if (extractedTitle) title = extractedTitle;

      const extractedAuthor = findFirstText(opfDoc, ['dc\\:creator', 'creator']);
      if (extractedAuthor) author = extractedAuthor;

      for (const meta of opfDoc.querySelectorAll('meta')) {
        const prop = (meta.getAttribute('property') || meta.getAttribute('name') || '').toLowerCase();
        if (prop.includes('numberofpages') || prop.includes('pages')) {
          const val = Number.parseInt(meta.textContent || meta.getAttribute('content') || '', 10);
          if (Number.isFinite(val) && val > 10) declaredPages = val;
        }
      }

      for (const item of opfDoc.querySelectorAll('manifest > item, item')) {
        const id = item.getAttribute('id') || '';
        const href = item.getAttribute('href') || '';
        const mediaType = (item.getAttribute('media-type') || '').toLowerCase();
        const properties = (item.getAttribute('properties') || '').toLowerCase();
        if (!href) continue;

        const resolvedPath = resolveRelativePath(opfPath, href);
        const entry = { id, href, path: resolvedPath, mediaType, properties };
        if (id) manifestById.set(id, entry);
        manifestItems.push(entry);
      }

      for (const itemref of opfDoc.querySelectorAll('spine > itemref, itemref')) {
        const idref = itemref.getAttribute('idref');
        if (idref && manifestById.has(idref)) spineHrefs.push(manifestById.get(idref));
      }

      const spineEl = Array.from(opfDoc.getElementsByTagName('*')).find(
        (el) => (el.localName || el.tagName || '').toLowerCase() === 'spine'
      );
      const tocId = spineEl?.getAttribute('toc') || '';
      const navItem = manifestItems.find((it) => it.properties.split(/\s+/).includes('nav'));
      const ncxItem =
        (tocId && manifestById.get(tocId)) ||
        manifestItems.find((it) => it.mediaType.includes('dtbncx') || /\.ncx$/i.test(it.href));
      if (navItem) {
        tocPath = navItem.path;
        tocIsNav = true;
      } else if (ncxItem) {
        tocPath = ncxItem.path;
      }

      const epub3Cover = manifestItems.find(
        (it) => it.properties.split(/\s+/).includes('cover-image') && it.mediaType.startsWith('image/')
      );
      if (epub3Cover) {
        coverEntryPath = epub3Cover.path;
        coverMime = epub3Cover.mediaType;
      }

      if (!coverEntryPath) {
        for (const meta of opfDoc.querySelectorAll('meta')) {
          const nameAttr = (meta.getAttribute('name') || '').toLowerCase();
          const contentAttr = meta.getAttribute('content') || '';
          if (nameAttr === 'cover' && contentAttr) {
            const byId = manifestById.get(contentAttr);
            if (byId?.mediaType.startsWith('image/')) {
              coverEntryPath = byId.path;
              coverMime = byId.mediaType;
              break;
            }
            const byPath = manifestItems.find(
              (it) =>
                it.mediaType.startsWith('image/') &&
                (it.href === contentAttr || it.path.endsWith(contentAttr))
            );
            if (byPath) {
              coverEntryPath = byPath.path;
              coverMime = byPath.mediaType;
              break;
            }
          }
        }
      }

      if (!coverEntryPath) {
        const candidateXhtmlPaths = [];
        for (const ref of opfDoc.querySelectorAll('guide > reference, reference')) {
          if ((ref.getAttribute('type') || '').toLowerCase().includes('cover')) {
            const refPath = resolveRelativePath(opfPath, ref.getAttribute('href') || '');
            if (/\.(jpe?g|png|webp|gif)$/i.test(refPath)) {
              coverEntryPath = refPath;
              break;
            } else if (refPath) {
              candidateXhtmlPaths.push(refPath);
            }
          }
        }
        if (spineHrefs.length > 0) candidateXhtmlPaths.push(spineHrefs[0].path);

        for (const xhtmlPath of candidateXhtmlPaths) {
          if (coverEntryPath) break;
          const xhtml = await zip.extractText(xhtmlPath);
          if (!xhtml) continue;
          const imgMatch =
            xhtml.match(/<img[^>]+src=["']([^"']+)["']/i) ||
            xhtml.match(/<image[^>]+(?:xlink:)?href=["']([^"']+)["']/i);
          if (imgMatch?.[1]) {
            const imgPath = resolveRelativePath(xhtmlPath, imgMatch[1]);
            if (zip.entries.has(imgPath) || zip.entriesLower.has(imgPath.toLowerCase())) {
              coverEntryPath = imgPath;
              break;
            }
          }
        }
      }

      if (!coverEntryPath) {
        const coverLike = manifestItems.find(
          (it) => it.mediaType.startsWith('image/') && (/cover/i.test(it.id) || /cover/i.test(it.href))
        );
        if (coverLike) {
          coverEntryPath = coverLike.path;
          coverMime = coverLike.mediaType;
        }
      }
    }
  }

  if (!coverEntryPath) {
    let bestImgEntry = null;
    for (const [, entry] of zip.entries) {
      if (/\.(jpe?g|png|webp)$/i.test(entry.name)) {
        if (/cover/i.test(entry.name)) {
          bestImgEntry = entry;
          break;
        }
        if (!bestImgEntry || entry.uncompressedSize > bestImgEntry.uncompressedSize) {
          bestImgEntry = entry;
        }
      }
    }
    if (bestImgEntry && bestImgEntry.uncompressedSize > 2048) {
      coverEntryPath = bestImgEntry.name;
    }
  }

  if (!tocPath) {
    for (const [name] of zip.entries) {
      if (/\.ncx$/i.test(name)) {
        tocPath = name;
        break;
      }
    }
  }

  const fallbackIndex = hashString(title) % FALLBACK_PALETTES.length;
  let coverCanvas = null;
  let palette = FALLBACK_PALETTES[fallbackIndex];
  let aspect = 0.75;

  if (coverEntryPath) {
    const imgBytes = await zip.extractBytes(coverEntryPath);
    if (imgBytes && imgBytes.byteLength > 128) {
      try {
        if (/\.png$/i.test(coverEntryPath)) coverMime = 'image/png';
        else if (/\.webp$/i.test(coverEntryPath)) coverMime = 'image/webp';
        else if (/\.gif$/i.test(coverEntryPath)) coverMime = 'image/gif';

        const img = await decodeImageFromBytes(imgBytes, coverMime);
        const imgW = img.naturalWidth || img.width || 384;
        const imgH = Math.max(1, img.naturalHeight || img.height || 512);
        aspect = Number(clamp(imgW / imgH, 0.58, 0.88).toFixed(3));

        coverCanvas = document.createElement('canvas');
        coverCanvas.height = 512;
        coverCanvas.width = Math.round(512 * aspect);
        const ctx = coverCanvas.getContext('2d');

        ctx.drawImage(img, 0, 0, coverCanvas.width, coverCanvas.height);
        palette = extractPaletteFromCanvas(coverCanvas, fallbackIndex);
        addBookbindingOverlay(ctx, coverCanvas.width, coverCanvas.height);
      } catch {
        coverCanvas = null;
        aspect = 0.75;
      }
    }
  }

  if (!coverCanvas) {
    coverCanvas = renderGeneratedCoverCanvas(title, author, palette);
    aspect = 0.75;
  }

  const coverBlob = await new Promise((resolve) => coverCanvas.toBlob(resolve, 'image/jpeg', 0.84));
  const coverUrl = coverBlob ? URL.createObjectURL(coverBlob) : coverCanvas.toDataURL('image/jpeg', 0.84);

  const chapters = [];
  let cjkChars = 0;
  let otherChars = 0;
  const tocByPath = await readTocMap(zip, tocPath, tocIsNav);

  const contentEntries =
    spineHrefs.length > 0
      ? spineHrefs
          .map((s) => ({
            entry: zip.entries.get(s.path) || zip.entriesLower.get(s.path.toLowerCase()),
            item: s,
          }))
          .filter((it) => Boolean(it.entry))
      : Array.from(zip.entries.values())
          .filter((e) => /\.(x?html?|htm|xml)$/i.test(e.name))
          .map((e) => ({ entry: e, item: { path: e.name } }));

  const yieldToUI = () => new Promise((resolve) => setTimeout(resolve, 0));
  const htmlTexts = new Array(contentEntries.length);
  const DECODE_BATCH = 8;
  for (let i = 0; i < contentEntries.length; i += DECODE_BATCH) {
    const batch = contentEntries.slice(i, i + DECODE_BATCH);
    const texts = await Promise.all(batch.map(({ entry }) => zip.extractText(entry)));
    for (let j = 0; j < texts.length; j++) htmlTexts[i + j] = texts[j];
    if (i > 0 && i % 64 === 0) await yieldToUI();
  }

  const parser = new DOMParser();

  for (let idx = 0; idx < contentEntries.length; idx++) {
    const rawHtml = htmlTexts[idx];
    if (!rawHtml) continue;
    const entry = contentEntries[idx].entry;

    let doc = parser.parseFromString(rawHtml, 'text/html');
    if (!doc?.body) doc = parser.parseFromString(rawHtml, 'application/xhtml+xml');
    if (!doc?.body) continue;

    doc.querySelectorAll('script, style, head, svg, nav, [hidden]').forEach((el) => el.remove());

    const tocItems = tocByPath.get(normalizeZipPath(entry.name).toLowerCase()) || null;
    const domHeading = findFirstText(doc, ['h1', 'h2', 'h3']);
    const sections = extractSectionsFromBody(doc.body, tocItems);

    for (let sIdx = 0; sIdx < sections.length; sIdx++) {
      const sec = sections[sIdx];
      const paras = sec.paragraphs;
      if (paras.length === 0) continue;

      let chTitle = sec.title || (sIdx === 0 ? domHeading : '');
      const hasExplicitHeading = Boolean(chTitle);

      if (chTitle && paras.length > 0) {
        const firstNorm = normalizeHeadingCompare(paras[0]);
        const titleNorm = normalizeHeadingCompare(chTitle);
        if (firstNorm && titleNorm && firstNorm === titleNorm) {
          paras.shift();
        }
      }

      for (const p of paras) {
        const plain = stripHtml(p);
        for (let i = 0; i < plain.length; i++) {
          const code = plain.charCodeAt(i);
          if (code >= 0x2e80 && code <= 0x9fff) cjkChars++;
          else if (code > 32) otherChars++;
        }
      }

      if (paras.length === 0 && !chTitle) continue;

      if (!sec.inToc && !hasExplicitHeading && chapters.length > 0) {
        chapters[chapters.length - 1].paragraphs.push(...paras);
      } else {
        if (!chTitle && paras[0] && stripHtml(paras[0]).length < 35 && paras.length > 1) {
          chTitle = stripHtml(paras.shift());
        }
        chapters.push({
          title: chTitle || '',
          level: sec.level || 0,
          inToc: Boolean(sec.inToc || hasExplicitHeading),
          paragraphs: paras,
        });
      }
    }

    if ((idx & 15) === 15) await yieldToUI();
  }

  const effectiveChars = cjkChars + otherChars * 0.45;
  const pages = declaredPages || clamp(Math.round(effectiveChars / 580) || 180, 45, 1600);
  const thickness = computeBookThickness(pages);

  return {
    title,
    author,
    pages,
    thickness,
    aspect,
    palette,
    coverBlob,
    coverUrl,
    chapters,
  };
}

const VERTICAL_ROTATE_CHARS = new Set([
  '—', '–', '-', '…', '～', '~',
  '（', '）', '(', ')',
  '《', '》', '〈', '〉',
  '【', '】', '[', ']',
  '「', '」', '『', '』',
]);

function drawVerticalCjkColumn(ctx, text, centerX, topY, bottomY, maxFontSize, weight = 600) {
  const chars = Array.from(text.trim());
  if (!chars.length) return;

  const availH = Math.max(80, bottomY - topY);
  const idealStep = availH / chars.length;
  const fontSize = clamp(Math.floor(Math.min(maxFontSize, idealStep * 0.86)), 16, maxFontSize);
  const stepY = Math.min(fontSize * 1.18, availH / chars.length);
  const totalH = stepY * chars.length;
  const startY = topY + (availH - totalH) * 0.38 + stepY * 0.5;

  ctx.font = `${weight} ${fontSize}px ${SERIF_FONT}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    const y = startY + i * stepY;
    if (VERTICAL_ROTATE_CHARS.has(ch)) {
      ctx.save();
      ctx.translate(centerX, y);
      ctx.rotate(Math.PI / 2);
      ctx.fillText(ch, 0, 0);
      ctx.restore();
    } else {
      ctx.fillText(ch, centerX, y);
    }
  }
}

function drawGoldOrnament(ctx, cx, cy, size = 18) {
  ctx.save();
  ctx.fillStyle = 'rgba(218, 186, 122, 0.72)';
  ctx.strokeStyle = 'rgba(218, 186, 122, 0.85)';
  ctx.lineWidth = 1.6;

  ctx.beginPath();
  ctx.moveTo(cx, cy - size);
  ctx.quadraticCurveTo(cx + size * 0.3, cy - size * 0.3, cx + size, cy);
  ctx.quadraticCurveTo(cx + size * 0.3, cy + size * 0.3, cx, cy + size);
  ctx.quadraticCurveTo(cx - size * 0.3, cy + size * 0.3, cx - size, cy);
  ctx.quadraticCurveTo(cx - size * 0.3, cy - size * 0.3, cx, cy - size);
  ctx.closePath();
  ctx.stroke();

  ctx.beginPath();
  ctx.arc(cx, cy, size * 0.22, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function splitTitleParts(rawTitle) {
  const clean = (rawTitle || '').trim().replace(/\s+/g, ' ');
  if (!clean) return { main: '', sub: '' };

  const match = clean.match(/^(.{2,14}?)(?:\s*[：:—]\s*|\s+-\s+|\s*[（(])(.+?)[）)]?$/);
  if (match && match[1].trim().length >= 2 && match[2].trim().length >= 2) {
    return {
      main: match[1].trim(),
      sub: match[2].replace(/[）)]$/, '').trim(),
    };
  }
  return { main: clean, sub: '' };
}

function fitTextFont(ctx, text, maxW, maxFont, minFont, weight, family) {
  let size = maxFont;
  ctx.font = `${weight} ${size}px ${family}`;
  while (ctx.measureText(text).width > maxW && size > minFont) {
    size -= 1;
    ctx.font = `${weight} ${size}px ${family}`;
  }
  return size;
}

export function renderSpineCanvas({ title, author, palette, thickness = 0.2 }) {
  const t = clamp(Number(thickness) || 0.2, 0.08, 0.45);
  const h = 1024;
  const w = Math.max(76, Math.round(h * clamp(t / 1.02, 0.075, 0.45)));

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');

  const isThin = t < 0.135;
  const isThick = t >= 0.255;

  const darkColor = palette?.dark || '#35412f';
  const clothColor = palette?.cloth || darkColor;

  const bgGrad = ctx.createLinearGradient(0, 0, 0, h);
  bgGrad.addColorStop(0, darkColor);
  bgGrad.addColorStop(0.5, clothColor);
  bgGrad.addColorStop(1, darkColor);
  ctx.fillStyle = bgGrad;
  ctx.fillRect(0, 0, w, h);

  ctx.fillStyle = 'rgba(12, 9, 6, 0.22)';
  ctx.fillRect(0, 0, w, h);

  const shade = ctx.createLinearGradient(0, 0, w, 0);
  const stops = isThin
    ? [[0, 'rgba(0,0,0,0.28)'], [0.15, 'rgba(0,0,0,0.05)'], [0.5, 'rgba(255,252,244,0.09)'], [0.85, 'rgba(0,0,0,0.06)'], [1, 'rgba(0,0,0,0.32)']]
    : [[0, 'rgba(0,0,0,0.48)'], [0.12, 'rgba(0,0,0,0.12)'], [0.32, 'rgba(255,250,240,0.09)'], [0.5, 'rgba(255,252,244,0.16)'], [0.68, 'rgba(255,250,240,0.07)'], [0.88, 'rgba(0,0,0,0.14)'], [1, 'rgba(0,0,0,0.52)']];
  for (const [pos, col] of stops) shade.addColorStop(pos, col);
  ctx.fillStyle = shade;
  ctx.fillRect(0, 0, w, h);

  ctx.fillStyle = 'rgba(255, 248, 232, 0.025)';
  for (let y = 0; y < h; y += 4) ctx.fillRect(0, y, w, 1);
  for (let x = 0; x < w; x += 4) ctx.fillRect(x, 0, 1, h);

  const grooveInset = clamp(Math.round(w * 0.072), isThin ? 4 : 7, 22);
  const grooveW = Math.max(1, Math.round(w * 0.012));
  ctx.fillStyle = 'rgba(0, 0, 0, 0.32)';
  ctx.fillRect(grooveInset, 0, grooveW, h);
  ctx.fillRect(w - grooveInset - 1, 0, grooveW, h);
  ctx.fillStyle = 'rgba(255, 245, 222, 0.07)';
  ctx.fillRect(grooveInset + 2, 0, 1, h);
  ctx.fillRect(w - grooveInset - 3, 0, 1, h);

  const capTop = ctx.createLinearGradient(0, 0, 0, 36);
  capTop.addColorStop(0, 'rgba(0, 0, 0, 0.38)');
  capTop.addColorStop(1, 'rgba(0, 0, 0, 0)');
  ctx.fillStyle = capTop;
  ctx.fillRect(0, 0, w, 36);

  const capBot = ctx.createLinearGradient(0, h - 36, 0, h);
  capBot.addColorStop(0, 'rgba(0, 0, 0, 0)');
  capBot.addColorStop(1, 'rgba(0, 0, 0, 0.42)');
  ctx.fillStyle = capBot;
  ctx.fillRect(0, h - 36, w, 36);

  const bandMargin = grooveInset + 3;
  const bandWidth = Math.max(16, w - bandMargin * 2);

  const drawGoldRule = (y, thicknessPx = 2.5, alpha = 0.85) => {
    ctx.fillStyle = `rgba(218, 186, 122, ${alpha})`;
    ctx.fillRect(bandMargin, y, bandWidth, thicknessPx);
  };

  const drawRaisedHub = (y) => {
    const hubH = clamp(Math.round(w * 0.046), 11, 18);
    const hubGrad = ctx.createLinearGradient(0, y - hubH / 2, 0, y + hubH / 2);
    hubGrad.addColorStop(0, 'rgba(255, 248, 228, 0.26)');
    hubGrad.addColorStop(0.42, 'rgba(255, 248, 228, 0.08)');
    hubGrad.addColorStop(1, 'rgba(0, 0, 0, 0.52)');
    ctx.fillStyle = hubGrad;
    ctx.fillRect(bandMargin - 2, y - hubH / 2, bandWidth + 4, hubH);
    drawGoldRule(y - hubH / 2 - 2, 2, 0.76);
    drawGoldRule(y + hubH / 2 + 1, 2, 0.76);
  };

  let titleTopY = 108;
  let titleBottomY = h - 220;
  let authorTopY = h - 200;
  let authorBottomY = h - 68;

  if (isThin) {
    drawGoldRule(44, 1.8, 0.82);
    drawGoldRule(h - 46, 1.8, 0.82);
    titleTopY = 72;
    titleBottomY = author ? h - 210 : h - 72;
    authorTopY = h - 195;
    authorBottomY = h - 64;
  } else if (isThick) {
    drawGoldRule(42, 2.5, 0.85);
    const hubs = [0.162, 0.334, 0.506, 0.678, 0.85].map((r) => Math.round(h * r));
    hubs.forEach(drawRaisedHub);
    drawGoldRule(h - 44, 2.5, 0.85);

    const padX = Math.max(bandMargin + 8, Math.round(w * 0.11));
    const cartY = hubs[0] + 18;
    const cartH = hubs[2] - 18 - cartY;
    const cartW = w - padX * 2;

    ctx.fillStyle = 'rgba(12, 8, 6, 0.34)';
    ctx.fillRect(padX, cartY, cartW, cartH);
    ctx.strokeStyle = 'rgba(218, 186, 122, 0.85)';
    ctx.lineWidth = 2.5;
    ctx.strokeRect(padX, cartY, cartW, cartH);
    ctx.strokeStyle = 'rgba(218, 186, 122, 0.40)';
    ctx.lineWidth = 1.2;
    ctx.strokeRect(padX + 5, cartY + 5, cartW - 10, cartH - 10);

    titleTopY = cartY + 18;
    titleBottomY = cartY + cartH - 18;
    drawGoldOrnament(ctx, w / 2, Math.round((hubs[2] + hubs[3]) * 0.5), clamp(Math.round(w * 0.085), 14, 26));
    authorTopY = hubs[3] + 20;
    authorBottomY = hubs[4] - 20;
  } else {
    drawGoldRule(52, 3, 0.88);
    drawGoldRule(64, 2, 0.68);
    drawGoldRule(h - 224, 1.8, 0.45);
    drawGoldRule(h - 66, 2, 0.68);
    drawGoldRule(h - 54, 3, 0.88);
    titleTopY = 98;
    titleBottomY = author ? h - 244 : h - 98;
    authorTopY = h - 208;
    authorBottomY = h - 82;
  }

  const cleanTitle = (title || '').trim();
  if (!cleanTitle) return canvas;

  const { main: mainTitle, sub: subTitle } = splitTitleParts(cleanTitle);
  const isMostlyCjk = /[\u2e80-\u9fff]/.test(cleanTitle);
  const latinFont = 'Georgia, "Times New Roman", serif';

  ctx.shadowColor = 'rgba(0, 0, 0, 0.48)';
  ctx.shadowBlur = 2.5;
  ctx.shadowOffsetY = 1;

  if (isMostlyCjk) {
    const useTwoColumns = w >= 195 && ((subTitle && subTitle.length >= 2) || mainTitle.length > 11);
    if (useTwoColumns) {
      let colRight = mainTitle;
      let colLeft = subTitle;
      if (!colLeft && mainTitle.length > 11) {
        const splitIdx = Math.ceil(mainTitle.length * 0.55);
        colRight = mainTitle.slice(0, splitIdx);
        colLeft = mainTitle.slice(splitIdx);
      }
      ctx.fillStyle = '#f4e7cb';
      drawVerticalCjkColumn(ctx, colRight.slice(0, 12), Math.round(w * 0.58), titleTopY, titleBottomY, clamp(Math.round(w * 0.22), 34, 58), 600);
      ctx.fillStyle = 'rgba(242, 228, 198, 0.86)';
      drawVerticalCjkColumn(ctx, colLeft.slice(0, 14), Math.round(w * 0.36), titleTopY + 24, titleBottomY - 10, clamp(Math.round(w * 0.15), 22, 38), 500);
    } else {
      let singleColText = mainTitle;
      if (subTitle && subTitle.length >= 2) {
        if (mainTitle.length + subTitle.length <= 8) singleColText = `${mainTitle}·${subTitle}`;
        else if (isThin && mainTitle.length <= 4) singleColText = `${mainTitle}·${subTitle.slice(0, 4)}`;
      }
      const maxFont = isThin ? clamp(Math.round(w * 0.42), 20, 36) : isThick ? clamp(Math.round(w * 0.22), 44, 64) : clamp(Math.round(w * 0.31), 34, 50);
      ctx.fillStyle = '#f4e7cb';
      drawVerticalCjkColumn(ctx, singleColText.slice(0, 14), w / 2, titleTopY, titleBottomY, maxFont, 600);
    }
  } else if (isThick && w >= 270) {
    const availW = w - (grooveInset + 18) * 2;
    const centerY = (titleTopY + titleBottomY) * 0.5;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    const words = cleanTitle.split(/\s+/);
    const lines =
      words.length <= 2
        ? [cleanTitle]
        : words.length <= 4
          ? [words.slice(0, Math.ceil(words.length / 2)).join(' '), words.slice(Math.ceil(words.length / 2)).join(' ')]
          : [
              words.slice(0, Math.ceil(words.length / 3)).join(' '),
              words.slice(Math.ceil(words.length / 3), Math.ceil((words.length * 2) / 3)).join(' '),
              words.slice(Math.ceil((words.length * 2) / 3)).join(' '),
            ];

    let fontSize = clamp(Math.round(w * 0.12), 24, 38);
    ctx.font = `600 ${fontSize}px ${latinFont}`;
    while (Math.max(...lines.map((l) => ctx.measureText(l).width)) > availW && fontSize > 16) {
      fontSize -= 1;
      ctx.font = `600 ${fontSize}px ${latinFont}`;
    }

    ctx.fillStyle = '#f4e7cb';
    const lineHeight = fontSize * 1.25;
    const startLineY = centerY - (lineHeight * (lines.length - 1)) / 2;
    lines.forEach((line, i) => ctx.fillText(line, w / 2, startLineY + i * lineHeight));
  } else {
    const availSpan = Math.max(160, titleBottomY - titleTopY - 20);
    ctx.save();
    ctx.translate(w / 2, (titleTopY + titleBottomY) * 0.5);
    ctx.rotate(Math.PI / 2);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    if (w >= 220 && (subTitle || cleanTitle.length > 20)) {
      let line1 = mainTitle;
      let line2 = subTitle;
      if (!line2) {
        const words = mainTitle.split(' ');
        const mid = Math.ceil(words.length / 2);
        line1 = words.slice(0, mid).join(' ');
        line2 = words.slice(mid).join(' ');
      }
      const font1 = fitTextFont(ctx, line1, availSpan, clamp(Math.round(w * 0.17), 26, 42), 18, 600, latinFont);
      ctx.fillStyle = '#f4e7cb';
      ctx.fillText(line1, 0, -Math.round(font1 * 0.58));

      fitTextFont(ctx, line2, availSpan, clamp(Math.round(font1 * 0.72), 16, 30), 14, 400, latinFont);
      ctx.fillStyle = 'rgba(242, 228, 198, 0.82)';
      ctx.fillText(line2, 0, Math.round(font1 * 0.62));
    } else {
      const maxF = isThin ? clamp(Math.round(w * 0.4), 20, 34) : clamp(Math.round(w * 0.25), 28, 46);
      fitTextFont(ctx, cleanTitle, availSpan, maxF, 15, 600, latinFont);
      ctx.fillStyle = '#f4e7cb';
      let display = cleanTitle;
      if (ctx.measureText(display).width > availSpan) {
        while (ctx.measureText(display + '…').width > availSpan && display.length > 4) {
          display = display.slice(0, -1);
        }
        display += '…';
      }
      ctx.fillText(display, 0, 0);
    }
    ctx.restore();
  }

  if (author) {
    let cleanAuthor = author.trim();
    if (w < 190) {
      cleanAuthor = cleanAuthor.replace(/^\s*[\[【（(][^\]】）)]+[\]】）)]\s*/, '').trim() || author.trim();
    }
    const authorIsCjk = /[\u2e80-\u9fff]/.test(cleanAuthor);
    ctx.fillStyle = 'rgba(242, 228, 198, 0.82)';

    if (w < 150 || (authorIsCjk && cleanAuthor.length > 5 && w < 220)) {
      if (authorIsCjk) {
        const shortAuthor = cleanAuthor.split(/[·•/]/)[0].slice(0, 6);
        drawVerticalCjkColumn(ctx, shortAuthor, w / 2, authorTopY, authorBottomY, clamp(Math.round(w * 0.26), 15, 24), 400);
      } else {
        ctx.save();
        ctx.translate(w / 2, (authorTopY + authorBottomY) * 0.5);
        ctx.rotate(Math.PI / 2);
        fitTextFont(ctx, cleanAuthor, Math.max(80, authorBottomY - authorTopY), clamp(Math.round(w * 0.24), 14, 20), 12, 400, latinFont);
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(cleanAuthor, 0, 0);
        ctx.restore();
      }
    } else {
      const maxHorizW = w - (bandMargin + 8) * 2;
      fitTextFont(ctx, cleanAuthor, maxHorizW, clamp(Math.round(w * 0.095), 16, 26), 12, 500, SERIF_FONT);
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(cleanAuthor, w / 2, (authorTopY + authorBottomY) * 0.5);
    }
  }

  return canvas;
}
