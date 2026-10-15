/* The same DAG scheduler serves full-image tasks and viewport previews. */
'use strict';
const Engine = (() => {
  async function runNode(graph, n, images, { values = {}, onProgress = () => {}, signal, roi, prepareOutput } = {}) {
    if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
    const parameters = Graph.params(graph, n, values);
    if (n.type === 'output') return prepareOutput ? prepareOutput(n, images[0]) : images[0];
    const input = Graph.multipleImages(n) ? images : images[0];
    const job = ScreenFilters.start(Graph.filterId(n), input, parameters, { roi, progress: v => onProgress(n, v) });
    const cancel = () => job.cancel(); signal?.addEventListener('abort', cancel, { once: true });
    let output;
    try { output = await job.promise; } finally { signal?.removeEventListener('abort', cancel); }
    // Ordinary pixel filters keep patch coordinates; spatial filters supply their own geometry.
    const reference = images[0];
    if (reference.fullWidth !== undefined) output = { fullWidth: reference.fullWidth, fullHeight: reference.fullHeight,
      originX: reference.originX, originY: reference.originY, ...output };
    return output;
  }
  async function execute(graph, source, { values = {}, target, targets, cache = new Map(), onNode = () => {}, onProgress = () => {}, signal, prepareOutput } = {}) {
    const validation = Graph.validate(graph, targets || (target ? [target] : undefined));
    if (!validation.valid) throw new Error(validation.errors.join('；'));
    for (const id of Graph.order(graph, validation.active)) {
      if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
      const n = graph.nodes[id];
      if (cache.has(id)) continue;
      onProgress(n, 0);
      const edges = Graph.imageEdges(graph, n);
      const images = edges.map(e => cache.get(e.from.nodeId));
      const output = n.type === 'input' ? source : await runNode(graph, n, images, { values, onProgress, signal, prepareOutput });
      if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
      cache.set(id, output); onProgress(n, 1); await onNode(n, output);
    }
    return cache;
  }
  return { execute, runNode };
})();

const Tasks = (() => {
  const active = new Map(), pending = new Set(), listeners = new Set();
  let sequence = null;
  const emit = () => { for (const f of listeners) f(); };
  function subscribe(f) { listeners.add(f); return () => listeners.delete(f); }
  function directoryKey(task, node) { return `task:${task.id}:${node.id}`; }
  function pipelineDirectoryKey(pipelineId, nodeId) { return `pipeline:${pipelineId}:${nodeId}`; }
  function outputDirectoryKey(task, graph, node, values = task.params) {
    const exposed = graph.edges.some(e => e.to.nodeId === node.id && e.to.port === 'directory');
    // A connected directory uses the same default/task override rules as other inputs.
    if (exposed) return Graph.params(graph, node, values).directory.key;
    if (Assets.directory(directoryKey(task, node))) return directoryKey(task, node);
    return Graph.params(graph, node, values).directory.key || pipelineDirectoryKey(task.pipelineId, node.id);
  }
  function outputs(task) {
    const pipeline = Store.pipelines.get(task.pipelineId);
    return pipeline ? Object.values(pipeline.graph.nodes).filter(n => n.type === 'output') : [];
  }
  function reason(task) {
    const set = Store.imageSets.get(task.imageSetId), pipeline = Store.pipelines.get(task.pipelineId);
    if (!set) return '请选择图片集';
    if (!set.files.length) return '图片集为空';
    if (!pipeline) return '请选择流水线';
    const validation = Graph.validate(pipeline.graph);
    if (!validation.valid) return validation.errors.join('；');
    return '';
  }
  function runKey(graph, files, params) {
    return JSON.stringify({ nodes: Object.values(graph.nodes).map(n => ({ id: n.id, type: n.type, params: n.params, scriptSource: n.scriptSource, outputMode: n.outputMode,
      outputSettings: n.type === 'output' ? Graph.outputSettings(n) : undefined })), edges: graph.edges,
      vars: graph.exposedVars.map(v => ({ id: v.variableId, defaultValue: v.defaultValue })), files: files.map(f => f.id), params });
  }
  async function start(task) {
    if (isRunning(task.id)) return;
    pending.add(task.id); emit();
    try { await run(task); } finally { pending.delete(task.id); emit(); }
  }
  function isSequencing() { return sequence !== null; }
  function canStartSequence() {
    return !sequence && !active.size && !pending.size && Object.values(Store.tasks.all()).some(task => task.status !== 'completed');
  }
  async function startSequence() {
    if (!canStartSequence()) return;
    // Freeze the list order for this click; tasks added later belong to the next run.
    const ids = Object.values(Store.tasks.all()).filter(task => task.status !== 'completed').map(task => task.id);
    sequence = { paused: false }; emit();
    try {
      for (const id of ids) {
        if (sequence.paused) break;
        const task = Store.tasks.get(id);
        if (!task || task.status === 'completed') continue;
        try { await start(task); }
        catch (error) { if (error.name !== 'AbortError') UI.toast(`${task.name}：${error.message}`, 'error'); }
      }
    } finally { sequence = null; emit(); }
  }
  async function run(task) {
    const problem = reason(task); if (problem) throw new Error(problem);
    const set = Store.imageSets.get(task.imageSetId), pipeline = Store.pipelines.get(task.pipelineId);
    if (task.status === 'completed') throw new Error('任务已完成，请清空进度后重新开始');
    if (Assets.ready(set) < set.files.length) {
      const { changed } = await Assets.reconnect(set); emit();
      if (Assets.ready(set) < set.files.length) throw new Error('仍有图片未授权，请在图片集中选择其所在目录');
      if (changed && task.progress.current) throw new Error('图片集已改变，请清空进度后开始');
    }
    const graph = structuredClone(pipeline.graph), files = structuredClone(set.files), values = structuredClone(task.params);
    const key = runKey(graph, files, values);
    if (task.progress.current && task.runKey !== key) throw new Error('流水线或图片集已改变，请清空进度后开始');
    const out = Object.values(graph.nodes).filter(n => n.type === 'output');
    const order = Graph.order(graph, Graph.validate(graph).active);
    if (out.filter(n => n.outputMode === 'overwrite').length > 1) throw new Error('同一任务只能有一个原地保存输出，其他分支请选择目录');
    for (const n of out.filter(n => n.outputMode === 'directory')) {
      if (!Assets.directory(outputDirectoryKey(task, graph, n, values))) throw new Error(`请先为“${n.name}”选择输出目录`);
    }
    if (out.some(n => n.outputMode === 'overwrite')) await Assets.authorizeOverwrite(files.slice(task.progress.current));
    const control = { pause: false }; active.set(task.id, control);
    const began = performance.now(), elapsed = task.elapsedMs || 0;
    Store.tasks.update(task.id, { status: 'running', runKey: key, progress: { ...task.progress, total: files.length } }); emit();
    try {
      for (let index = task.progress.current; index < files.length; index++) {
        const descriptor = files[index];
        task.progress.currentFileName = descriptor.path || descriptor.name;
        task.progress.imageProgress = 0;
        try {
          const file = await Assets.read(descriptor.id), image = await Assets.decode(file);
          const results = await Engine.execute(graph, image, { values, onProgress: (node, value) => {
            task.progress.nodeName = node.name; task.progress.nodeProgress = value;
            task.progress.imageProgress = (order.indexOf(node.id) + value) / (order.length + 1);
            task.elapsedMs = elapsed + performance.now() - began;
            emit();
          } });
          // Preview evaluation never writes files; only this task boundary invokes save.
          for (const node of out) {
            task.progress.nodeName = `保存 · ${node.name}`; task.progress.nodeProgress = 0; emit();
            const dirKey = outputDirectoryKey(task, graph, node, values);
            await Assets.save(results.get(node.id), descriptor, node, dirKey);
          }
        } catch (error) { task.errors.push({ name: descriptor.path || descriptor.name, message: error.message }); }
        task.progress.current = index + 1; task.progress.imageProgress = 0; task.elapsedMs = elapsed + performance.now() - began; Store.persist(); emit();
        if (control.pause) break;
      }
      task.status = task.progress.current === files.length ? 'completed' : 'paused';
    } catch (error) { task.status = 'error'; UI.toast(error.message, 'error'); }
    finally {
      task.elapsedMs = elapsed + performance.now() - began; task.progress.nodeName = ''; task.progress.nodeProgress = 0; task.progress.imageProgress = 0;
      active.delete(task.id); Store.persist(); emit();
    }
  }
  function pause(task) {
    if (sequence) sequence.paused = true;
    active.get(task.id).pause = true; task.status = 'pausing'; Store.persist(); emit();
  }
  function isRunning(id) { return active.has(id) || pending.has(id); }
  function isPreparing(id) { return pending.has(id) && !active.has(id); }
  return { start, startSequence, isSequencing, canStartSequence, pause, subscribe, emit, reason, outputs, isRunning, isPreparing, directoryKey, pipelineDirectoryKey, outputDirectoryKey };
})();
