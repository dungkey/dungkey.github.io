import * as THREE from 'three';
import { clamp, computeBookThickness, FALLBACK_PALETTES } from './epub.js';

const DB_NAME = 'shelf-book-content-db';
const DB_VERSION = 2;
const CHAPTER_STORE = 'book-chapters';
const COVER_STORE = 'book-covers';

const STORAGE_KEY = 'shelf-3d-books-v3';
const LEGACY_V2_KEY = 'shelf-3d-books-v2';
const READER_PREFS_KEY = 'shelf-reader-prefs-v1';

export const SHELF_WIDTH = 6.8;
export const DEFAULT_BOOK_Z = 0.05;
export const DEFAULT_BOOK_T = 0.2;

let dbPromise = null;

function openDb() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve) => {
      if (typeof indexedDB === 'undefined') return resolve(null);
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains(CHAPTER_STORE)) {
          db.createObjectStore(CHAPTER_STORE, { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains(COVER_STORE)) {
          db.createObjectStore(COVER_STORE, { keyPath: 'id' });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    });
  }
  return dbPromise;
}

function runTx(storeName, mode, op) {
  return openDb().then((db) => {
    if (!db) return null;
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, mode);
      const store = tx.objectStore(storeName);
      const req = op(store);
      let result = null;
      if (req) {
        req.onsuccess = () => {
          result = req.result;
        };
      }
      tx.oncomplete = () => resolve(result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  });
}

export async function saveBookChapters(bookId, chapters) {
  if (!bookId || !chapters) return;
  try {
    await runTx(CHAPTER_STORE, 'readwrite', (s) => s.put({ id: bookId, chapters }));
  } catch (err) {
    console.warn('保存章节失败:', err);
  }
}

export async function loadBookChapters(bookId) {
  if (!bookId) return null;
  try {
    const res = await runTx(CHAPTER_STORE, 'readonly', (s) => s.get(bookId));
    return res?.chapters || null;
  } catch {
    return null;
  }
}

export async function saveBookCover(bookId, blob) {
  if (!bookId || !blob) return;
  try {
    await runTx(COVER_STORE, 'readwrite', (s) => s.put({ id: bookId, blob }));
  } catch (err) {
    console.warn('保存封面失败:', err);
  }
}

export async function loadBookCoverUrl(bookId) {
  if (!bookId) return null;
  try {
    const res = await runTx(COVER_STORE, 'readonly', (s) => s.get(bookId));
    if (res?.blob instanceof Blob) {
      return URL.createObjectURL(res.blob);
    }
    return null;
  } catch {
    return null;
  }
}

export async function deleteBookStorage(bookId) {
  if (!bookId) return;
  try {
    await Promise.all([
      runTx(CHAPTER_STORE, 'readwrite', (s) => s.delete(bookId)),
      runTx(COVER_STORE, 'readwrite', (s) => s.delete(bookId)),
    ]);
  } catch (err) {
    console.warn('删除书籍存储失败:', err);
  }
}

function dataUrlToBlob(dataUrl) {
  try {
    const [head, body] = dataUrl.split(',');
    if (!head || !body) return null;
    const mime = head.match(/:(.*?);/)?.[1] || 'image/jpeg';
    const bin = atob(body);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new Blob([bytes], { type: mime });
  } catch {
    return null;
  }
}

export function loadSavedState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY) ?? localStorage.getItem(LEGACY_V2_KEY);
    if (!raw) return { books: [], nextId: 1 };

    const saved = JSON.parse(raw);
    if (!saved || !Array.isArray(saved.books)) return { books: [], nextId: 1 };

    const usableHalf = SHELF_WIDTH / 2 - 0.55;
    const books = [];

    for (let index = 0; index < saved.books.length; index++) {
      const book = saved.books[index];
      if (!book || typeof book !== 'object') continue;
      if (book.id === 'book-1' && !book.title && !book.coverDataUrl) continue;

      const id = typeof book.id === 'string' && book.id ? book.id : `book-${index + 1}`;
      const theme = Number.isFinite(book.theme)
        ? ((Math.trunc(book.theme) % FALLBACK_PALETTES.length) + FALLBACK_PALETTES.length) %
          FALLBACK_PALETTES.length
        : index % FALLBACK_PALETTES.length;

      const x = Number.isFinite(book.x)
        ? book.x
        : Number.isFinite(book.xNorm)
          ? (clamp(book.xNorm, 0, 1) - 0.5) * 2 * usableHalf
          : 0;
      const y = Number.isFinite(book.y) ? book.y : 2.9;
      const z = Number.isFinite(book.z) ? clamp(book.z, -0.6, 1.5) : DEFAULT_BOOK_Z;
      const cleanQ =
        Array.isArray(book.q) && book.q.length === 4 && book.q.every(Number.isFinite)
          ? new THREE.Quaternion(...book.q).normalize()
          : new THREE.Quaternion();

      const thickness = Number.isFinite(book.thickness)
        ? clamp(book.thickness, 0.08, 0.45)
        : computeBookThickness(book.pages || 260);
      const aspect = Number.isFinite(book.aspect) ? clamp(book.aspect, 0.58, 0.88) : 0.75;

      let coverUrl = null;
      if (typeof book.coverDataUrl === 'string' && book.coverDataUrl.startsWith('data:')) {
        const blob = dataUrlToBlob(book.coverDataUrl);
        if (blob) {
          coverUrl = URL.createObjectURL(blob);
          saveBookCover(id, blob);
        } else {
          coverUrl = book.coverDataUrl;
        }
      }

      books.push({
        id,
        x,
        y,
        z,
        q: [cleanQ.x, cleanQ.y, cleanQ.z, cleanQ.w],
        theme,
        thickness,
        aspect,
        pages: Number.isFinite(book.pages) ? book.pages : 260,
        title: typeof book.title === 'string' ? book.title : '',
        author: typeof book.author === 'string' ? book.author : '',
        palette: book.palette && typeof book.palette === 'object' ? book.palette : FALLBACK_PALETTES[theme],
        progress: book.progress && typeof book.progress === 'object' ? book.progress : null,
        coverUrl,
      });
    }

    const maxId = books.reduce((max, b) => {
      const n = Number.parseInt(b.id.replace('book-', ''), 10);
      return Number.isFinite(n) ? Math.max(max, n) : max;
    }, 0);

    return {
      books,
      nextId: Math.max(Number(saved.nextId) || 0, maxId + 1, 1),
    };
  } catch (err) {
    console.warn('读取存档失败:', err);
    return { books: [], nextId: 1 };
  }
}

export function saveShelfState(books, nextId, onQuotaError) {
  try {
    const serialized = books.map((b) => ({
      id: b.id,
      x: Number(b.x.toFixed(4)),
      y: Number(b.y.toFixed(4)),
      z: Number(b.z.toFixed(4)),
      q: b.q.map((v) => Number(v.toFixed(5))),
      theme: b.theme,
      thickness: b.thickness,
      aspect: b.aspect,
      pages: b.pages,
      title: b.title,
      author: b.author,
      palette: b.palette,
      progress: b.progress || null,
    }));
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ books: serialized, nextId }));
    localStorage.removeItem(LEGACY_V2_KEY);
    return true;
  } catch (err) {
    console.warn('保存书架状态失败:', err);
    onQuotaError?.(err);
    return false;
  }
}

export function loadReaderPrefs() {
  const defaults = {
    fontScale: 1.0,
    theme: 'cream',
    lineHeight: 1.8,
  };
  try {
    const raw = localStorage.getItem(READER_PREFS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      return {
        fontScale: clamp(Number(parsed.fontScale) || 1.0, 0.75, 1.65),
        theme: ['cream', 'white', 'night'].includes(parsed.theme) ? parsed.theme : 'cream',
        lineHeight: clamp(Number(parsed.lineHeight) || 1.8, 1.45, 2.2),
      };
    }
  } catch {}
  return defaults;
}

export function saveReaderPrefs(prefs) {
  try {
    localStorage.setItem(READER_PREFS_KEY, JSON.stringify(prefs));
  } catch {}
}
