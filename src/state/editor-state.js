/* Editor preferences and preview files live outside pipeline definitions. */
'use strict';
const EditorState = (() => {
  const KEY = 'screenlab-editor';
  const states = JSON.parse(localStorage.getItem(KEY)) || {};
  const persist = () => localStorage.setItem(KEY, JSON.stringify(states));
  let database;
  function get(id, previous = {}) {
    if (!states[id] || states[id].canvasPreviewLimit === undefined || states[id].panelPreviewLimit === undefined) {
      // Fill older editor preferences without moving preview settings into the graph.
      states[id] = { enabled: false, zoom: 1, centerX: .5, centerY: .5, name: '', imageSetId: '', fileId: '',
        canvasPreviewLimit: 800, panelPreviewLimit: 1600, ...previous, ...states[id] };
      persist();
    }
    return states[id];
  }
  function update(id, patch) { Object.assign(get(id), patch); persist(); }
  function open() {
    database ||= new Promise((resolve, reject) => {
      const request = indexedDB.open('screenlab-editor', 1);
      request.onupgradeneeded = () => request.result.createObjectStore('previewFiles');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    return database;
  }
  async function fileRequest(mode, action) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction('previewFiles', mode);
      const request = action(transaction.objectStore('previewFiles'));
      transaction.oncomplete = () => resolve(request.result);
      transaction.onabort = () => reject(transaction.error);
      transaction.onerror = () => reject(transaction.error);
    });
  }
  function file(id) { return fileRequest('readonly', store => store.get(id)); }
  function setFile(id, value) { return fileRequest('readwrite', store => store.put(value, id)); }
  async function remove(id) {
    delete states[id]; persist();
    await fileRequest('readwrite', store => store.delete(id));
  }
  return { get, update, file, setFile, remove };
})();
