/*
 * app.js — Kids Journal application logic.
 * No framework, no build step: plain DOM manipulation, event listeners,
 * and the DB helper from db.js. Views are just <section> elements toggled
 * via the `hidden` attribute (see showView()).
 */
(function () {
  'use strict';

  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));

  // ---------------------------------------------------------------
  // View routing — just show/hide <section class="view"> elements.
  // The persistent bottom bar only makes sense on the two "home" views
  // (Timeline and Tasks); the full-screen editor/settings/migrate views
  // have their own Back button instead.
  // ---------------------------------------------------------------
  let currentView = 'timeline';

  function showView(name) {
    currentView = name;
    $$('.view').forEach((v) => (v.hidden = v.id !== `view-${name}`));
    const isHomeView = name === 'timeline' || name === 'tasks';
    $('#bottom-bar').hidden = !isHomeView;
    if (isHomeView) updateToggleButton();
    window.scrollTo(0, 0);
  }

  function updateToggleButton() {
    const icon = $('#toggle-view-icon');
    const label = $('#toggle-view-label');
    if (currentView === 'tasks') {
      icon.textContent = '▤';
      label.textContent = 'Journal';
    } else {
      icon.textContent = '☑';
      label.textContent = 'Tasks';
    }
  }

  // ---------------------------------------------------------------
  // Object URL bookkeeping — created blob: URLs must be revoked or they
  // leak memory. Each render function revokes its own previous batch
  // before creating a new one.
  // ---------------------------------------------------------------
  function makeUrlTracker() {
    let urls = [];
    return {
      track(url) { urls.push(url); return url; },
      revokeAll() { urls.forEach((u) => URL.revokeObjectURL(u)); urls = []; },
    };
  }
  const timelineUrls = makeUrlTracker();
  const editorUrls = makeUrlTracker();

  function formatDateLabel(iso) {
    const d = new Date(iso);
    const now = new Date();
    const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    const sameDay = (a, b) => a.toDateString() === b.toDateString();
    if (sameDay(d, now)) return `Today, ${time}`;
    const yesterday = new Date(now);
    yesterday.setDate(now.getDate() - 1);
    if (sameDay(d, yesterday)) return `Yesterday, ${time}`;
    return d.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' }) + `, ${time}`;
  }

  function startOfDay(d) {
    const x = new Date(d);
    x.setHours(0, 0, 0, 0);
    return x;
  }

  // ---------------------------------------------------------------
  // Timeline — rendered as a day-grouped ledger: one bordered box per
  // calendar day (a big day-of-month number + weekday on the left), with
  // that day's individual moments stacked on the right. A quiet divider
  // marks a gap of skipped days between two groups.
  // ---------------------------------------------------------------
  let selectMode = false;
  const selectedIds = new Set();

  function buildEntryRow(entry, photos) {
    const row = document.createElement('div');
    row.className = 'entry-row' + (entry.migrated ? ' migrated' : '');
    row.dataset.id = entry.id;

    if (selectMode) {
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.className = 'entry-row-select';
      cb.checked = selectedIds.has(entry.id);
      cb.addEventListener('click', (e) => {
        e.stopPropagation();
        if (cb.checked) selectedIds.add(entry.id); else selectedIds.delete(entry.id);
        updateSelectBar();
      });
      row.appendChild(cb);
    }

    const head = document.createElement('div');
    head.className = 'entry-row-head';
    const time = document.createElement('span');
    time.className = 'entry-row-time';
    time.textContent = new Date(entry.createdAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    head.appendChild(time);
    if (entry.migrated) {
      const badge = document.createElement('span');
      badge.className = 'entry-row-badge';
      badge.textContent = 'Migrated';
      head.appendChild(badge);
    }
    row.appendChild(head);

    if (entry.text) {
      const text = document.createElement('p');
      text.className = 'entry-row-text';
      text.textContent = entry.text;
      row.appendChild(text);
    }

    if (photos.length) {
      const photoRow = document.createElement('div');
      photoRow.className = 'entry-row-photos';
      for (const p of photos) {
        const img = document.createElement('img');
        img.src = timelineUrls.track(URL.createObjectURL(p.blob));
        img.alt = '';
        photoRow.appendChild(img);
      }
      row.appendChild(photoRow);
    }

    row.addEventListener('click', () => {
      if (selectMode) {
        if (selectedIds.has(entry.id)) selectedIds.delete(entry.id); else selectedIds.add(entry.id);
        renderTimeline();
      } else {
        openEntryEditor(entry.id);
      }
    });
    return row;
  }

  function buildDayGroup(dateObj, dayEntries, photosMap) {
    const wrap = document.createElement('div');
    wrap.className = 'day-group';

    const dayCol = document.createElement('div');
    dayCol.className = 'day-col';
    const num = document.createElement('div');
    num.className = 'day-num';
    num.textContent = dateObj.getDate();
    const dow = document.createElement('div');
    dow.className = 'day-dow';
    dow.textContent = dateObj.toLocaleDateString([], { weekday: 'short' });
    dayCol.append(num, dow);
    wrap.appendChild(dayCol);

    const entriesCol = document.createElement('div');
    entriesCol.className = 'entries-col';
    for (const entry of dayEntries) {
      entriesCol.appendChild(buildEntryRow(entry, photosMap.get(entry.id) || []));
    }
    wrap.appendChild(entriesCol);
    return wrap;
  }

  async function renderTimeline() {
    const entries = await DB.getAllEntries(); // newest first
    const photosMap = await DB.getAllPhotosGrouped();
    timelineUrls.revokeAll();

    const list = $('#timeline-list');
    list.innerHTML = '';
    $('#timeline-empty').hidden = entries.length !== 0;
    if (entries.length === 0) return;

    // Group consecutive entries (already newest-first) by calendar day.
    const groups = [];
    const groupByKey = new Map();
    for (const entry of entries) {
      const d = new Date(entry.createdAt);
      const key = d.toDateString();
      if (!groupByKey.has(key)) {
        const g = { dateObj: d, entries: [] };
        groupByKey.set(key, g);
        groups.push(g);
      }
      groupByKey.get(key).entries.push(entry);
    }
    // Within a day, read top-to-bottom in the order things happened.
    for (const g of groups) g.entries.sort((a, b) => a.createdAt.localeCompare(b.createdAt));

    let prevDay = null;
    for (const g of groups) {
      if (prevDay) {
        const gapDays = Math.round((startOfDay(prevDay) - startOfDay(g.dateObj)) / 86400000);
        if (gapDays > 1) {
          const skipped = new Date(prevDay);
          skipped.setDate(skipped.getDate() - 1);
          const divider = document.createElement('p');
          divider.className = 'day-divider';
          divider.textContent = skipped.toLocaleDateString([], { weekday: 'long' });
          list.appendChild(divider);
        }
      }
      list.appendChild(buildDayGroup(g.dateObj, g.entries, photosMap));
      prevDay = g.dateObj;
    }
  }

  function updateSelectBar() {
    $('#select-count').textContent = `${selectedIds.size} selected`;
  }

  function setSelectMode(on) {
    selectMode = on;
    if (!on) selectedIds.clear();
    $('#select-bar').hidden = !on;
    updateSelectBar();
    renderTimeline();
  }

  // ---------------------------------------------------------------
  // Entry editor
  // ---------------------------------------------------------------
  let editingEntryId = null;
  let editorPhotos = []; // { id, blob, isNew }
  let removedPhotoIds = [];

  function renderEditorPhotoGrid() {
    editorUrls.revokeAll();
    const grid = $('#photo-grid');
    grid.innerHTML = '';
    for (const p of editorPhotos) {
      const thumb = document.createElement('div');
      thumb.className = 'photo-thumb';
      const img = document.createElement('img');
      img.src = editorUrls.track(URL.createObjectURL(p.blob));
      img.alt = '';
      thumb.appendChild(img);

      const removeBtn = document.createElement('button');
      removeBtn.type = 'button';
      removeBtn.className = 'photo-remove';
      removeBtn.textContent = '✕';
      removeBtn.setAttribute('aria-label', 'Remove photo');
      removeBtn.addEventListener('click', () => {
        if (!p.isNew) removedPhotoIds.push(p.id);
        editorPhotos = editorPhotos.filter((x) => x !== p);
        renderEditorPhotoGrid();
      });
      thumb.appendChild(removeBtn);
      grid.appendChild(thumb);
    }
  }

  async function openEntryEditor(entryId) {
    editingEntryId = entryId || null;
    editorPhotos = [];
    removedPhotoIds = [];

    $('#entry-text').value = '';
    $('#btn-entry-delete').hidden = !editingEntryId;

    if (editingEntryId) {
      const entry = await DB.getEntry(editingEntryId);
      const photos = await DB.getPhotosForEntry(editingEntryId);
      $('#entry-date').textContent = formatDateLabel(entry.createdAt);
      $('#entry-text').value = entry.text || '';
      editorPhotos = photos.map((p) => ({ id: p.id, blob: p.blob, isNew: false }));
    } else {
      $('#entry-date').textContent = formatDateLabel(new Date().toISOString());
    }

    renderEditorPhotoGrid();
    showView('entry');
    $('#entry-text').focus();
  }

  function addFilesToEditor(fileList) {
    for (const file of fileList) {
      editorPhotos.push({ id: DB.uuid(), blob: file, isNew: true });
    }
    renderEditorPhotoGrid();
  }

  async function saveEntry() {
    const text = $('#entry-text').value.trim();

    if (!text && editorPhotos.length === 0) {
      alert('Add a bit of text or at least one photo before saving.');
      return;
    }

    const newBlobs = editorPhotos.filter((p) => p.isNew).map((p) => p.blob);

    if (editingEntryId) {
      for (const id of removedPhotoIds) await DB.deletePhoto(id);
      await DB.updateEntry(editingEntryId, { text }, newBlobs);
    } else {
      await DB.createEntry({ text, photoBlobs: newBlobs });
    }

    showView('timeline');
    renderTimeline();
  }

  async function deleteCurrentEntry() {
    if (!editingEntryId) return;
    if (!confirm('Delete this moment? This cannot be undone.')) return;
    await DB.deleteEntry(editingEntryId);
    showView('timeline');
    renderTimeline();
  }

  // ---------------------------------------------------------------
  // Settings view — just data management, no personalisation fields.
  // ---------------------------------------------------------------
  function blobToDataURL(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  }

  async function exportAllData() {
    const entries = await DB.getAllEntries();
    const photosMap = await DB.getAllPhotosGrouped();
    const out = { exportedAt: new Date().toISOString(), entries: [], tasks };

    for (const entry of entries) {
      const photos = photosMap.get(entry.id) || [];
      const photoData = [];
      for (const p of photos) {
        photoData.push({ dataUrl: await blobToDataURL(p.blob), type: p.blob.type });
      }
      out.entries.push({ ...entry, photos: photoData });
    }

    const blob = new Blob([JSON.stringify(out, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `kids-journal-export-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }

  async function clearAllData() {
    if (!confirm('Delete ALL moments, photos, and tasks on this device? This cannot be undone.')) return;
    if (!confirm('Are you absolutely sure? There is no way to recover this data afterwards.')) return;
    await DB.clearAll();
    tasks = [];
    saveTasks();
    showView('timeline');
    renderTimeline();
  }

  // ---------------------------------------------------------------
  // Migrate view — select entries, produce a plain-text block the user
  // can paste into any AI chat themselves, then mark them as migrated.
  // ---------------------------------------------------------------
  const migrateSelectedIds = new Set();
  let migrateEntriesCache = [];

  async function openMigrate(preselectedIds) {
    migrateSelectedIds.clear();
    if (preselectedIds) preselectedIds.forEach((id) => migrateSelectedIds.add(id));
    $('#migrate-picker').hidden = false;
    $('#migrate-result').hidden = true;
    await renderMigrateList();
    showView('migrate');
  }

  function buildMigrateRow(entry) {
    const row = document.createElement('label');
    row.className = 'migrate-row';

    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = migrateSelectedIds.has(entry.id);
    cb.addEventListener('change', () => {
      if (cb.checked) migrateSelectedIds.add(entry.id); else migrateSelectedIds.delete(entry.id);
      updateMigrateCount();
    });
    row.appendChild(cb);

    const body = document.createElement('div');
    body.className = 'migrate-row-body';
    const date = document.createElement('div');
    date.className = 'migrate-row-date';
    date.textContent = formatDateLabel(entry.createdAt);
    body.appendChild(date);
    if (entry.text) {
      const text = document.createElement('p');
      text.className = 'migrate-row-text';
      text.textContent = entry.text;
      body.appendChild(text);
    }
    row.appendChild(body);
    return row;
  }

  async function renderMigrateList() {
    const all = await DB.getAllEntries();
    migrateEntriesCache = all.filter((e) => !e.migrated);

    const list = $('#migrate-list');
    list.innerHTML = '';
    $('#migrate-empty').hidden = migrateEntriesCache.length !== 0;

    for (const entry of migrateEntriesCache) list.appendChild(buildMigrateRow(entry));
    updateMigrateCount();
  }

  function updateMigrateCount() {
    $('#migrate-selected-count').textContent = migrateSelectedIds.size;
  }

  function buildMigrateText() {
    const selected = migrateEntriesCache
      .filter((e) => migrateSelectedIds.has(e.id))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt)); // oldest first reads as a narrative

    const lines = [];
    lines.push(
      'Here are some quick notes I jotted down about my kids. Please combine them into one warm, ' +
      'well-written journal entry in my voice, in chronological order:'
    );
    lines.push('');
    for (const entry of selected) {
      const d = new Date(entry.createdAt);
      const dateStr = d.toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
      lines.push(`— ${dateStr}`);
      lines.push(entry.text || '(no text, photo only)');
      lines.push('');
    }
    return lines.join('\n').trim();
  }

  function showMigrateResult() {
    if (migrateSelectedIds.size === 0) {
      alert('Select at least one moment first.');
      return;
    }
    $('#migrate-output').value = buildMigrateText();
    $('#migrate-picker').hidden = true;
    $('#migrate-result').hidden = false;
  }

  async function copyMigrateOutput() {
    const text = $('#migrate-output').value;
    try {
      await navigator.clipboard.writeText(text);
      flashButton('#btn-copy-output', 'Copied!');
    } catch {
      // Older Safari fallback: select the text so the user can copy manually.
      const ta = $('#migrate-output');
      ta.focus();
      ta.select();
      alert('Could not auto-copy — the text is selected, so use Copy from the menu that appears.');
    }
  }

  function flashButton(sel, msg) {
    const btn = $(sel);
    const original = btn.textContent;
    btn.textContent = msg;
    setTimeout(() => (btn.textContent = original), 1500);
  }

  async function shareMigrateOutput() {
    const text = $('#migrate-output').value;
    if (navigator.share) {
      try {
        await navigator.share({ text });
      } catch {
        /* user cancelled the share sheet — nothing to do */
      }
    } else {
      alert('Sharing is not supported in this browser — use Copy to Clipboard instead.');
    }
  }

  async function markSelectedMigrated() {
    await DB.markMigrated(Array.from(migrateSelectedIds));
    showView('timeline');
    renderTimeline();
  }

  // ---------------------------------------------------------------
  // Tasks — a simple always-editable checklist. Kept in localStorage
  // rather than IndexedDB: there are no photos here, so a plain JSON
  // array is plenty and avoids all the async ceremony. Supports
  // touch-based drag reordering, since native HTML5 drag-and-drop
  // doesn't work reliably on iOS Safari.
  // ---------------------------------------------------------------
  const TASKS_KEY = 'kidsJournalTasks';

  function loadTasks() {
    try {
      return JSON.parse(localStorage.getItem(TASKS_KEY)) || [];
    } catch {
      return [];
    }
  }
  function saveTasks() {
    localStorage.setItem(TASKS_KEY, JSON.stringify(tasks));
  }
  let tasks = loadTasks();
  let dragState = null;

  function buildTaskRow(task) {
    const row = document.createElement('div');
    row.className = 'task-row' + (task.done ? ' done' : '');
    row.dataset.id = task.id;

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = task.done;
    checkbox.addEventListener('change', () => {
      task.done = checkbox.checked;
      saveTasks();
      row.classList.toggle('done', task.done);
      updateClearCompletedVisibility();
    });
    row.appendChild(checkbox);

    const text = document.createElement('input');
    text.type = 'text';
    text.value = task.text;
    text.addEventListener('input', () => {
      task.text = text.value;
      saveTasks();
    });
    row.appendChild(text);

    const handle = document.createElement('div');
    handle.className = 'task-drag-handle';
    handle.textContent = '⠿';
    handle.addEventListener('pointerdown', (e) => startTaskDrag(e, row));
    row.appendChild(handle);

    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'task-delete';
    del.textContent = '✕';
    del.setAttribute('aria-label', 'Delete task');
    del.addEventListener('click', () => {
      tasks = tasks.filter((t) => t.id !== task.id);
      saveTasks();
      renderTasks();
    });
    row.appendChild(del);

    return row;
  }

  function renderTasks() {
    const list = $('#task-list');
    list.innerHTML = '';
    $('#task-empty').hidden = tasks.length !== 0;
    for (const task of tasks) list.appendChild(buildTaskRow(task));
    updateClearCompletedVisibility();
  }

  function updateClearCompletedVisibility() {
    $('#btn-clear-completed').hidden = !tasks.some((t) => t.done);
  }

  function addTask(text) {
    // New tasks go to the top, so the one you just dictated is right
    // there in front of you as you keep going.
    tasks.unshift({ id: DB.uuid(), text, done: false });
    saveTasks();
    renderTasks();
  }

  function clearCompletedTasks() {
    tasks = tasks.filter((t) => !t.done);
    saveTasks();
    renderTasks();
  }

  // Drag reordering: the dragged row's on-screen position is driven purely
  // by the pointer (translateY relative to its own natural, untransformed
  // offsetTop), while neighbours are swapped in the DOM live as the
  // dragged row's center crosses their center. Because the transform is
  // always recomputed as (desired position − current natural position),
  // it stays visually continuous across swaps with no manual jump
  // correction needed.
  function startTaskDrag(e, row) {
    e.preventDefault();
    const list = $('#task-list');
    const listRect = list.getBoundingClientRect();
    dragState = {
      row,
      grabOffset: e.clientY - (listRect.top + row.offsetTop),
      listTop: listRect.top,
      pointerId: e.pointerId,
    };
    row.classList.add('dragging');
    row.style.position = 'relative';
    row.setPointerCapture(e.pointerId);
    row.addEventListener('pointermove', onTaskDragMove);
    row.addEventListener('pointerup', endTaskDrag);
    row.addEventListener('pointercancel', endTaskDrag);
  }

  function onTaskDragMove(e) {
    if (!dragState) return;
    const { row, grabOffset, listTop } = dragState;
    const desiredTop = e.clientY - grabOffset - listTop;

    const list = $('#task-list');
    const rows = Array.from(list.children);
    const index = rows.indexOf(row);
    const draggedCenter = desiredTop + row.offsetHeight / 2;

    const prev = rows[index - 1];
    const next = rows[index + 1];
    if (prev && draggedCenter < prev.offsetTop + prev.offsetHeight / 2) {
      list.insertBefore(row, prev);
    } else if (next && draggedCenter > next.offsetTop + next.offsetHeight / 2) {
      list.insertBefore(next, row);
    }

    row.style.transform = `translateY(${desiredTop - row.offsetTop}px)`;
  }

  function endTaskDrag() {
    if (!dragState) return;
    const { row, pointerId } = dragState;
    row.releasePointerCapture(pointerId);
    row.removeEventListener('pointermove', onTaskDragMove);
    row.removeEventListener('pointerup', endTaskDrag);
    row.removeEventListener('pointercancel', endTaskDrag);
    row.classList.remove('dragging');
    row.style.transform = '';
    row.style.position = '';
    dragState = null;

    // Persist the on-screen order back into the tasks array.
    const ids = Array.from($('#task-list').children).map((r) => r.dataset.id);
    tasks.sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id));
    saveTasks();
  }

  // ---------------------------------------------------------------
  // Wire up all event listeners
  // ---------------------------------------------------------------
  function init() {
    // The mic button is context-sensitive: a new journal moment from the
    // Timeline, or just focusing the add-task field while on Tasks.
    $('#btn-new-dictate').addEventListener('click', () => {
      if (currentView === 'tasks') {
        $('#task-input').focus();
      } else {
        openEntryEditor(null);
      }
    });
    $('#btn-settings').addEventListener('click', () => showView('settings'));
    $('#btn-toggle-view').addEventListener('click', () => {
      if (currentView === 'tasks') {
        showView('timeline');
        renderTimeline();
      } else {
        showView('tasks');
        renderTasks();
      }
    });

    $('#btn-open-select').addEventListener('click', () => {
      showView('timeline');
      setSelectMode(true);
    });
    $('#btn-select-cancel').addEventListener('click', () => setSelectMode(false));
    $('#btn-select-migrate').addEventListener('click', () => {
      const ids = Array.from(selectedIds);
      setSelectMode(false);
      openMigrate(ids);
    });

    $('#btn-task-mic').addEventListener('click', () => $('#task-input').focus());
    $('#task-input').addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      const input = $('#task-input');
      const value = input.value.trim();
      if (value) addTask(value);
      input.value = '';
      input.focus();
    });
    $('#btn-clear-completed').addEventListener('click', clearCompletedTasks);

    $('#btn-entry-back').addEventListener('click', () => { showView('timeline'); renderTimeline(); });
    $('#btn-save-entry').addEventListener('click', saveEntry);
    $('#btn-entry-delete').addEventListener('click', deleteCurrentEntry);

    $('#btn-add-camera').addEventListener('click', () => $('#input-camera').click());
    $('#btn-add-library').addEventListener('click', () => $('#input-library').click());
    $('#input-camera').addEventListener('change', (e) => { addFilesToEditor(e.target.files); e.target.value = ''; });
    $('#input-library').addEventListener('change', (e) => { addFilesToEditor(e.target.files); e.target.value = ''; });

    $('#btn-settings-back').addEventListener('click', () => showView('timeline'));
    $('#btn-export').addEventListener('click', exportAllData);
    $('#btn-clear-data').addEventListener('click', clearAllData);

    $('#btn-migrate-back').addEventListener('click', () => { showView('timeline'); renderTimeline(); });
    $('#btn-quick-7days').addEventListener('click', () => {
      const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
      migrateSelectedIds.clear();
      migrateEntriesCache.forEach((e) => { if (new Date(e.createdAt).getTime() >= cutoff) migrateSelectedIds.add(e.id); });
      renderMigrateList();
    });
    $('#btn-quick-all').addEventListener('click', () => {
      migrateSelectedIds.clear();
      migrateEntriesCache.forEach((e) => migrateSelectedIds.add(e.id));
      renderMigrateList();
    });
    $('#btn-summarise').addEventListener('click', showMigrateResult);
    $('#btn-copy-output').addEventListener('click', copyMigrateOutput);
    $('#btn-share-output').addEventListener('click', shareMigrateOutput);
    $('#btn-mark-migrated').addEventListener('click', markSelectedMigrated);
    $('#btn-migrate-cancel-result').addEventListener('click', () => {
      $('#migrate-result').hidden = true;
      $('#migrate-picker').hidden = false;
    });

    renderTimeline();
    updateToggleButton();

    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('./sw.js').catch(() => { /* offline caching just won't be available */ });
    }
  }

  document.addEventListener('DOMContentLoaded', init);
})();
