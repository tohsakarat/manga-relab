/* File access and image encoding. AssetLocations persists input picker locations. */
'use strict';
const Assets = (() => {
  const sources = new Map(), directories = new Map(), previews = new Map();
  const imageTypes = [{ description: '图片', accept: { 'image/*': ['.png', '.jpg', '.jpeg', '.webp', '.bmp', '.gif', '.avif'] } }];
  async function pick(set, folder = false) {
    if (folder && window.showDirectoryPicker) {
      const startIn = await AssetLocations.startIn(set, id => sources.has(id));
      const directory = await showDirectoryPicker({ mode: 'read', ...(startIn ? { startIn } : {}) });
      const entries = [], locations = [];
      async function walk(handle, path) {
        locations.push([path, handle]);
        for await (const [name, child] of handle.entries()) {
          if (child.kind === 'directory') await walk(child, `${path}/${name}`);
          else {
            const file = await child.getFile();
            if (file.type.startsWith('image/')) entries.push({ file, handle: child, path: `${path}/${name}` });
          }
        }
      }
      await walk(directory, await AssetLocations.directoryPath(set.id, directory));
      await AssetLocations.remember(set.id, locations);
      return entries.sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true }));
    }
    if (!folder && window.showOpenFilePicker) {
      const handles = await showOpenFilePicker({ multiple: true, types: imageTypes });
      await AssetLocations.remember(set.id, handles.map(handle => [handle.name, handle]));
      return Promise.all(handles.map(async handle => ({ handle, file: await handle.getFile(), path: handle.name })));
    }
    return (await UI.pickFiles({ accept: 'image/*', multiple: true, directory: folder }))
      .map(file => ({ file, handle: null, path: file.webkitRelativePath || file.name }));
  }
  function include(set, entries) {
    let added = 0, changed = false;
    for (const entry of entries) {
      // Older file selections have no directory prefix; reconnect them without duplicate cards.
      const existing = set.files.find(f => (f.path || f.name) === entry.path) ||
        set.files.find(f => !(f.path || f.name).includes('/') && f.name === entry.file.name && f.size === entry.file.size);
      const descriptor = existing || { id: Store.uuid() };
      if (!existing) { set.files.push(descriptor); added++; }
      if (!existing || existing.size !== entry.file.size || existing.lastModified !== entry.file.lastModified) changed = true;
      Object.assign(descriptor, { path: entry.path, name: entry.file.name, size: entry.file.size,
        lastModified: entry.file.lastModified, type: entry.file.type });
      remove(descriptor.id);
      sources.set(descriptor.id, entry);
    }
    Store.persist(); return { added, changed };
  }
  async function add(set, folder = false) {
    return include(set, await pick(set, folder));
  }
  async function reconnect(set) {
    const result = include(set, await pick(set, true));
    return { ...result, authorized: ready(set) };
  }
  async function read(id) {
    const entry = sources.get(id);
    if (!entry) throw new Error('图片尚未授权，请重新选择图片集文件');
    return entry.handle ? entry.handle.getFile() : entry.file;
  }
  async function decode(file) {
    const bitmap = await createImageBitmap(file);
    const canvas = document.createElement('canvas'); canvas.width = bitmap.width; canvas.height = bitmap.height;
    canvas.getContext('2d').drawImage(bitmap, 0, 0); bitmap.close();
    return canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);
  }
  async function chooseDirectory(key) {
    if (!window.showDirectoryPicker) throw new Error('目录写入需要 Chrome / Edge 的文件访问接口，请通过 localhost 打开');
    const handle = await showDirectoryPicker({ mode: 'readwrite' }); directories.set(key, handle); return handle.name;
  }
  async function authorizeOverwrite(files) {
    for (const f of files) {
      const handle = sources.get(f.id)?.handle;
      if (!handle) throw new Error('原地保存需要可写文件授权，请用 Chrome / Edge 重新导入图片');
      if (await handle.queryPermission({ mode: 'readwrite' }) !== 'granted' && await handle.requestPermission({ mode: 'readwrite' }) !== 'granted') throw new Error('没有获得原文件写入权限');
    }
  }
  async function save(image, descriptor, node, key) {
    const file = await read(descriptor.id);
    const type = node.outputMode === 'overwrite' ? file.type : OutputFormat.format(node).type;
    const result = await OutputFormat.encode(image, node, type);
    let handle;
    if (node.outputMode === 'overwrite') handle = sources.get(descriptor.id).handle;
    else {
      const directory = directories.get(key);
      if (!directory) throw new Error(`${node.name}尚未选择输出目录`);
      const dot = file.name.lastIndexOf('.'), stem = dot < 0 ? file.name : file.name.slice(0, dot), ext = `.${OutputFormat.format(node).extension}`;
      let name = `${stem}${ext}`;
      if (Graph.outputSettings(node).conflictMode === 'suffix') {
        const occupied = new Set(); for await (const [entryName] of directory.entries()) occupied.add(entryName);
        let suffix = 1;
        while (occupied.has(name)) name = `${stem}_${suffix++}${ext}`;
      }
      handle = await directory.getFileHandle(name, { create: true });
    }
    const stream = await handle.createWritable(); await stream.write(result); await stream.close();
  }
  async function download(image, stem, node, signal) {
    // A trial never overwrites; outputs without a chosen directory format download as PNG.
    const format = node.outputMode === 'overwrite' ? { type: 'image/png', extension: 'png' } : OutputFormat.format(node);
    const result = await OutputFormat.encode(image, node, format.type);
    if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
    UI.download(result, `${stem}.${format.extension}`);
  }
  function previewURL(id) {
    const entry = sources.get(id);
    if (!entry) return null;
    // Reuse URLs across home renders; replacing or removing the source releases them.
    entry.previewURL ||= URL.createObjectURL(entry.file);
    return entry.previewURL;
  }
  function remove(id) {
    const url = sources.get(id)?.previewURL;
    if (url) URL.revokeObjectURL(url);
    sources.delete(id);
  }
  function authorized(id) { return sources.has(id); }
  function ready(set) { return set.files.filter(f => authorized(f.id)).length; }
  function directory(key) { return directories.get(key); }
  return { add, reconnect, read, decode, save, download, authorizeOverwrite, chooseDirectory, directory, authorized, ready, remove, previewURL, previews };
})();
