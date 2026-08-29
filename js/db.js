/*
 * db.js — IndexedDB data layer for Kids Moments.
 *
 * Object stores:
 *   - "entries":    one row per journal moment (text, dates, migrated flag).
 *     Small — safe to load all of them into memory at once.
 *   - "photos":     one row per journal photo, holding the actual image
 *     Blob, indexed by entryId. Kept separate from "entries" so listing
 *     entries never has to touch (and decode) image data.
 *   - "notes":      one row per quick note (title, text, color, date).
 *     Deliberately its own store, separate from "entries" — notes aren't
 *     part of the day-grouped journal timeline or the migrate flow.
 *   - "notePhotos": same idea as "photos", but indexed by noteId.
 *
 * Everything here returns Promises wrapping IDBRequest's callback API.
 */
const DB_NAME = 'kidsMomentsDB';
const DB_VERSION = 2;

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
      if (!db.objectStoreNames.contains('notes')) {
        const notes = db.createObjectStore('notes', { keyPath: 'id' });
        notes.createIndex('createdAt', 'createdAt');
      }
      if (!db.objectStoreNames.contains('notePhotos')) {
        const notePhotos = db.createObjectStore('notePhotos', { keyPath: 'id' });
        notePhotos.createIndex('noteId', 'noteId');
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

  // ---------------------------------------------------------------
  // Notes — quick, colour-tagged jottings with optional photos. Kept
  // entirely separate from journal entries: no migrate flow, no
  // day-grouping, just a flat list you can create/edit/delete freely.
  // ---------------------------------------------------------------

  /** Creates a new note. `photoBlobs` is an array of File/Blob objects. */
  async createNote({ title, text, color, photoBlobs }) {
    const id = uuid();
    const note = {
      id,
      createdAt: new Date().toISOString(),
      title: title || '',
      text: text || '',
      color: color || null,
    };
    const t = await tx(['notes', 'notePhotos'], 'readwrite');
    t.objectStore('notes').add(note);
    for (const blob of photoBlobs || []) {
      t.objectStore('notePhotos').add({ id: uuid(), noteId: id, blob, createdAt: Date.now() });
    }
    await new Promise((resolve, reject) => {
      t.oncomplete = resolve;
      t.onerror = () => reject(t.error);
    });
    return id;
  },

  /** Updates an existing note's fields (title/text/color) and optionally adds new photos. */
  async updateNote(id, fields, newPhotoBlobs) {
    const t = await tx(['notes', 'notePhotos'], 'readwrite');
    const store = t.objectStore('notes');
    const existing = await reqToPromise(store.get(id));
    if (!existing) throw new Error('Note not found: ' + id);
    Object.assign(existing, fields);
    store.put(existing);
    for (const blob of newPhotoBlobs || []) {
      t.objectStore('notePhotos').add({ id: uuid(), noteId: id, blob, createdAt: Date.now() });
    }
    await new Promise((resolve, reject) => {
      t.oncomplete = resolve;
      t.onerror = () => reject(t.error);
    });
  },

  async deleteNotePhoto(photoId) {
    const t = await tx(['notePhotos'], 'readwrite');
    t.objectStore('notePhotos').delete(photoId);
    await new Promise((resolve, reject) => {
      t.oncomplete = resolve;
      t.onerror = () => reject(t.error);
    });
  },

  async deleteNote(id) {
    const t = await tx(['notes', 'notePhotos'], 'readwrite');
    t.objectStore('notes').delete(id);
    const photoIndex = t.objectStore('notePhotos').index('noteId');
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

  /** Returns all notes, newest first. */
  async getAllNotes() {
    const t = await tx(['notes'], 'readonly');
    const all = await reqToPromise(t.objectStore('notes').getAll());
    return all.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  },

  async getNote(id) {
    const t = await tx(['notes'], 'readonly');
    return reqToPromise(t.objectStore('notes').get(id));
  },

  /** Returns all photo rows (with blobs) for a given note. */
  async getPhotosForNote(noteId) {
    const t = await tx(['notePhotos'], 'readonly');
    const idx = t.objectStore('notePhotos').index('noteId');
    return reqToPromise(idx.getAll(IDBKeyRange.only(noteId)));
  },

  /** Returns a Map of noteId -> photo rows for every note, in one pass (used by the notes list). */
  async getAllNotePhotosGrouped() {
    const t = await tx(['notePhotos'], 'readonly');
    const all = await reqToPromise(t.objectStore('notePhotos').getAll());
    const map = new Map();
    for (const p of all) {
      if (!map.has(p.noteId)) map.set(p.noteId, []);
      map.get(p.noteId).push(p);
    }
    return map;
  },

  /** Wipes every store completely. Used by Settings > Clear All Data. */
  async clearAll() {
    const storeNames = ['entries', 'photos', 'notes', 'notePhotos'];
    const t = await tx(storeNames, 'readwrite');
    for (const name of storeNames) t.objectStore(name).clear();
    await new Promise((resolve, reject) => {
      t.oncomplete = resolve;
      t.onerror = () => reject(t.error);
    });
  },
};
