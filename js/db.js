/*
 * db.js — IndexedDB data layer for Kids Moments.
 *
 * Two object stores:
 *   - "entries": one row per journal moment (text, dates, migrated flag).
 *     Small — safe to load all of them into memory at once.
 *   - "photos":  one row per photo, holding the actual image Blob, indexed
 *     by entryId. Kept separate from "entries" so listing/searching entries
 *     never has to touch (and decode) image data.
 *
 * Everything here returns Promises wrapping IDBRequest's callback API.
 */
const DB_NAME = 'kidsMomentsDB';
const DB_VERSION = 1;

let dbPromise = null;

function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('entries')) {
        const entries = db.createObjectStore('entries', { keyPath: 'id' });
        entries.createIndex('createdAt', 'createdAt');
        entries.createIndex('migrated', 'migrated');
      }
      if (!db.objectStoreNames.contains('photos')) {
        const photos = db.createObjectStore('photos', { keyPath: 'id' });
        photos.createIndex('entryId', 'entryId');
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx(storeNames, mode) {
  return openDB().then((db) => db.transaction(storeNames, mode));
}

function reqToPromise(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function uuid() {
  if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
  // Fallback for older WebViews without crypto.randomUUID.
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

const DB = {
  uuid,

  /** Creates a new entry. `photoBlobs` is an array of File/Blob objects. */
  async createEntry({ text, photoBlobs }) {
    const id = uuid();
    const entry = {
      id,
      createdAt: new Date().toISOString(),
      text: text || '',
      migrated: false,
      migratedAt: null,
    };
    const t = await tx(['entries', 'photos'], 'readwrite');
    t.objectStore('entries').add(entry);
    for (const blob of photoBlobs || []) {
      t.objectStore('photos').add({ id: uuid(), entryId: id, blob, createdAt: Date.now() });
    }
    await new Promise((resolve, reject) => {
      t.oncomplete = resolve;
      t.onerror = () => reject(t.error);
    });
    return id;
  },

  /** Updates an existing entry's fields (text/migrated) and optionally adds new photos. */
  async updateEntry(id, fields, newPhotoBlobs) {
    const t = await tx(['entries', 'photos'], 'readwrite');
    const store = t.objectStore('entries');
    const existing = await reqToPromise(store.get(id));
    if (!existing) throw new Error('Entry not found: ' + id);
    Object.assign(existing, fields);
    store.put(existing);
    for (const blob of newPhotoBlobs || []) {
      t.objectStore('photos').add({ id: uuid(), entryId: id, blob, createdAt: Date.now() });
    }
    await new Promise((resolve, reject) => {
      t.oncomplete = resolve;
      t.onerror = () => reject(t.error);
    });
  },

  async deletePhoto(photoId) {
    const t = await tx(['photos'], 'readwrite');
    t.objectStore('photos').delete(photoId);
    await new Promise((resolve, reject) => {
      t.oncomplete = resolve;
      t.onerror = () => reject(t.error);
    });
  },

  async deleteEntry(id) {
    const t = await tx(['entries', 'photos'], 'readwrite');
    t.objectStore('entries').delete(id);
    const photoIndex = t.objectStore('photos').index('entryId');
    const cursorReq = photoIndex.openCursor(IDBKeyRange.only(id));
    cursorReq.onsuccess = () => {
      const cursor = cursorReq.result;
      if (cursor) {
        cursor.delete();
        cursor.continue();
      }
    };
    await new Promise((resolve, reject) => {
      t.oncomplete = resolve;
      t.onerror = () => reject(t.error);
    });
  },

  /** Returns all entries, newest first. */
  async getAllEntries() {
    const t = await tx(['entries'], 'readonly');
    const all = await reqToPromise(t.objectStore('entries').getAll());
    return all.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  },

  async getEntry(id) {
    const t = await tx(['entries'], 'readonly');
    return reqToPromise(t.objectStore('entries').get(id));
  },

  /** Returns all photo rows (with blobs) for a given entry. */
  async getPhotosForEntry(entryId) {
    const t = await tx(['photos'], 'readonly');
    const idx = t.objectStore('photos').index('entryId');
    return reqToPromise(idx.getAll(IDBKeyRange.only(entryId)));
  },

  /** Returns a Map of entryId -> photo rows for every entry, in one pass (used by the timeline). */
  async getAllPhotosGrouped() {
    const t = await tx(['photos'], 'readonly');
    const all = await reqToPromise(t.objectStore('photos').getAll());
    const map = new Map();
    for (const p of all) {
      if (!map.has(p.entryId)) map.set(p.entryId, []);
      map.get(p.entryId).push(p);
    }
    return map;
  },

  async markMigrated(ids) {
    const t = await tx(['entries'], 'readwrite');
    const store = t.objectStore('entries');
    const now = new Date().toISOString();
    for (const id of ids) {
      const existing = await reqToPromise(store.get(id));
      if (existing) {
        existing.migrated = true;
        existing.migratedAt = now;
        store.put(existing);
      }
    }
    await new Promise((resolve, reject) => {
      t.oncomplete = resolve;
      t.onerror = () => reject(t.error);
    });
  },

  /** Wipes both stores completely. Used by Settings > Clear All Data. */
  async clearAll() {
    const t = await tx(['entries', 'photos'], 'readwrite');
    t.objectStore('entries').clear();
    t.objectStore('photos').clear();
    await new Promise((resolve, reject) => {
      t.oncomplete = resolve;
      t.onerror = () => reject(t.error);
    });
  },
};
