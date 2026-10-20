'use strict';

/*
 * 本地书库：IndexedDB 存书籍元数据与原始文件。
 *
 *   ReaderStore.all()            -> 全部元数据（不含文件）
 *   ReaderStore.file(id)         -> 原始文件 Blob
 *   ReaderStore.save(meta, blob) -> 写入 / 覆盖
 *   ReaderStore.update(id, patch) -> 只修改元数据
 *   ReaderStore.remove(id)       -> 删除
 */

(function () {
  const DB_NAME = 'reader';
  const DB_VERSION = 1;
  const META = 'books';
  const FILES = 'files';

  let dbPromise = null;

  function open() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      if (!window.indexedDB) {
        reject(new Error('当前浏览器不支持 IndexedDB'));
        return;
      }
      const request = window.indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(META)) {
          db.createObjectStore(META, { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains(FILES)) {
          db.createObjectStore(FILES, { keyPath: 'id' });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('无法打开本地书库'));
      request.onblocked = () => reject(new Error('本地书库被其他标签页占用，请关闭后重试'));
    });
    return dbPromise;
  }

  function run(mode, stores, action) {
    return open().then((db) => new Promise((resolve, reject) => {
      let transaction;
      try {
        transaction = db.transaction(stores, mode);
      } catch (error) {
        reject(error);
        return;
      }
      let request;
      try {
        request = action(transaction);
      } catch (error) {
        reject(error);
        return;
      }
      transaction.oncomplete = () => resolve(request ? request.result : undefined);
      transaction.onerror = () => reject(transaction.error || new Error('本地书库操作失败'));
      transaction.onabort = () => reject(transaction.error || new Error('本地书库操作被中断'));
    }));
  }

  function all() {
    return run('readonly', [META], (transaction) => transaction.objectStore(META).getAll())
      .then((records) => (Array.isArray(records) ? records : []));
  }

  function get(id) {
    return run('readonly', [META], (transaction) => transaction.objectStore(META).get(id))
      .then((record) => record || null);
  }

  function file(id) {
    return run('readonly', [FILES], (transaction) => transaction.objectStore(FILES).get(id))
      .then((record) => (record ? record.blob : null));
  }

  function save(meta, blob) {
    return run('readwrite', [META, FILES], (transaction) => {
      transaction.objectStore(META).put(meta);
      transaction.objectStore(FILES).put({ id: meta.id, blob });
      return null;
    });
  }

  function update(id, changes) {
    return get(id).then((record) => {
      if (!record) return null;
      const next = { ...record, ...changes };
      return run('readwrite', [META], (transaction) => {
        transaction.objectStore(META).put(next);
        return null;
      }).then(() => next);
    });
  }

  function remove(id) {
    return run('readwrite', [META, FILES], (transaction) => {
      transaction.objectStore(META).delete(id);
      transaction.objectStore(FILES).delete(id);
      return null;
    });
  }

  window.ReaderStore = { all, get, file, save, update, remove };
})();
