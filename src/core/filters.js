/* Script registration and Worker execution; no UI or processing sequence. */
(function (root) {
  'use strict';
  const filters = Object.create(null);
  const progressListeners = new Set();
  root.FilterAPI = {
    progress(value) { for (const listener of progressListeners) listener(value); },
    onProgress(listener) {
      progressListeners.add(listener);
      return () => progressListeners.delete(listener);
    },
  };

  function normalizeParameter(spec) {
    // Older curve declarations selected their UI by key; keep that legacy meaning at import.
    // An explicit editor (including "default") always wins over the old convention.
    return spec.type === 'json' && spec.key === 'points' && spec.editor === undefined
      ? { ...spec, editor: 'curve' } : spec;
  }
  function metadata(source) {
    const header = source.match(/\/\/ ==ScreenFilter==([\s\S]*?)\/\/ ==\/ScreenFilter==/);
    if (!header) throw new Error('缺少 ScreenFilter 顶部参数表。');
    const info = { params: [] };
    for (const match of header[1].matchAll(/^\s*\/\/ @(id|name|device|input|geometry|param)\s+(.+)$/gm)) {
      if (match[1] === 'param') info.params.push(normalizeParameter(JSON.parse(match[2])));
      else info[match[1]] = match[2].trim();
    }
    if (!info.id || !info.name) throw new Error('滤镜参数表需要 @id 和 @name。');
    return info;
  }
  function add(info, script, implementation = {}) {
    if (filters[info.id]) throw new Error(`滤镜 ID 已存在：${info.id}`);
    filters[info.id] = { ...info, ...implementation, script };
    return filters[info.id];
  }
  function register(factory, helpers = {}) {
    const factorySource = factory.toString();
    const info = metadata(factorySource);
    const headerPattern = /^[ \t]*\/\/ ==ScreenFilter==[\s\S]*?\/\/ ==\/ScreenFilter==/m;
    const header = factorySource.match(headerPattern)[0].replace(/^[ \t]*/gm, '  ');
    // Keep one header at the factory's start so normal registration and editing share it.
    const implementation = factorySource.replace(headerPattern, '');
    // Bundle shared helpers into the factory so copied scripts also run on their own.
    const declarations = Object.entries(helpers).map(([name, fn]) => `const ${name} = ${fn.toString()};`).join('\n');
    const source = declarations ? `function () {\n${header}\n\n${declarations}\nreturn (${implementation})();\n}` : factorySource;
    return add(info, `ScreenFilters.register(${source});`, factory());
  }
  function importScript(source, runtimeId) {
    // Imported code executes only in its processing Worker.
    const info = metadata(source);
    return add({ ...info, id: runtimeId || info.id }, source);
  }
  function defaults(id) {
    return Object.fromEntries(filters[id].params.map(param => [param.key, structuredClone(param.default)]));
  }
  function start(id, image, params, { roi, progress = () => {}, debug = () => {} } = {}) {
    const filter = filters[id];
    const script = `globalThis.FilterAPI = { progress: value => postMessage({ progress: value }) };
      globalThis.ScreenFilters = { register: factory => { globalThis.filter = factory(); } };
      ${filter.script}
      onmessage = async ({ data }) => {
        if (data.cancel) { globalThis.filterDevice?.destroy(); close(); return; }
        try {
          const result = await filter.apply(data.image, data.params, {
            roi: data.roi,
            debug: (message, level) => postMessage({ debug: message, level }),
          });
          postMessage({ result }, [result.data.buffer]);
        } catch (error) { postMessage({ error: error.message }); }
      };`;
    const url = URL.createObjectURL(new Blob([script], { type: 'text/javascript' }));
    const worker = new Worker(url);
    let rejectResult;
    function dispose() { worker.terminate(); URL.revokeObjectURL(url); }
    const promise = new Promise((resolve, reject) => {
      rejectResult = reject;
      worker.onmessage = ({ data }) => {
        if (data.debug) { debug(data.debug, data.level); return; }
        if (data.error) { dispose(); reject(new Error(data.error)); return; }
        if (data.result) { dispose(); resolve(data.result); return; }
        progress(data.progress);
      };
      worker.onerror = event => { dispose(); reject(new Error(event.message)); };
    });
    worker.postMessage({ image, params, roi });
    return {
      promise,
      cancel() {
        // GPU work yields between batches; CPU work must be terminated immediately.
        if (filter.device === 'gpu') { worker.postMessage({ cancel: true }); URL.revokeObjectURL(url); }
        else dispose();
        rejectResult(new DOMException('Cancelled', 'AbortError'));
      },
    };
  }
  root.ScreenFilters = { filters, register, importScript, defaults, start, metadata, normalizeParameter };
  if (typeof module !== 'undefined' && module.exports) module.exports = root.ScreenFilters;
})(globalThis);
