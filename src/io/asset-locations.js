/* Persist picker locations separately from image data and processing definitions. */
'use strict';
const AssetLocations = (() => {
  const locations = new Map();
  const database = new Promise((resolve, reject) => {
    const request = indexedDB.open('screenlab-assets', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('locations', { keyPath: 'setId' });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  async function request(mode, action) {
    const db = await database;
    return new Promise((resolve, reject) => {
      const transaction = db.transaction('locations', mode);
      const operation = action(transaction.objectStore('locations'));
      transaction.oncomplete = () => resolve(operation.result);
      transaction.onabort = () => reject(transaction.error);
      transaction.onerror = () => reject(transaction.error);
    });
  }
  const restored = request('readonly', store => store.getAll()).then(records => {
    for (const record of records) locations.set(record.setId, new Map(record.handles));
  });
  async function remember(setId, handles) {
    await restored;
    const saved = locations.get(setId) || new Map();
    for (const [path, handle] of handles) saved.set(path, handle);
    locations.set(setId, saved);
    await request('readwrite', store => store.put({ setId, handles: [...saved] }));
  }
  async function startIn(set, isReady) {
    await restored;
    const groups = new Map();
    for (const file of set.files) {
      if (isReady(file.id)) continue;
      const path = file.path || file.name, parent = path.slice(0, Math.max(0, path.lastIndexOf('/')));
      if (!groups.has(parent)) groups.set(parent, []);
      groups.get(parent).push(path);
    }
    const largest = [...groups].sort((a, b) => b[1].length - a[1].length)[0];
    const saved = locations.get(set.id);
    if (!largest || !saved) return undefined;
    const [parent, files] = largest;
    // A file handle also starts the directory picker in that file's parent folder.
    return saved.get(parent) || saved.get(files[0]);
  }
  async function directoryPath(setId, directory) {
    await restored;
    for (const [path, handle] of locations.get(setId) || []) {
      // Keep the original prefix when selecting a previously imported subdirectory.
      if (handle.kind === 'directory' && await handle.isSameEntry(directory)) return path;
    }
    return directory.name;
  }
  async function remove(setId) {
    await restored; locations.delete(setId);
    await request('readwrite', store => store.delete(setId));
  }
  return { remember, startIn, directoryPath, remove };
})();
