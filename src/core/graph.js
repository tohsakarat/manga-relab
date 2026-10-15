/* Graph edits, exposed inputs, and execution order; no DOM or file access. */
'use strict';
const Graph = (() => {
  const types = {
    input: { name: '输入', icon: 'LogIn', color: '#71b4f1' },
    output: { name: '输出', icon: 'Save', color: '#85d79b' },
    denoise: { name: '降噪', icon: 'Scan', color: '#e6b666' },
    spine: { name: '去阴影', icon: 'BookOpen', color: '#c19be5' },
    sharpen: { name: 'USM 锐化', icon: 'Focus', color: '#e58d97', device: 'gpu' },
    curve: { name: '曲线', icon: 'Spline', color: '#75d9d1' },
    'surface-blur': { name: '表面模糊', icon: 'Blend', color: '#8fc5d5', device: 'gpu' },
    maximum: { name: '最大值', icon: 'Expand', color: '#a6d27d', device: 'gpu' },
    minimum: { name: '最小值', icon: 'Shrink', color: '#d4a482', device: 'gpu' },
    'find-edges': { name: '查找边缘', icon: 'ScanLine', color: '#dca2c5', device: 'gpu' },
    resize: { name: '缩放', icon: 'Scaling', color: '#87c8ad' },
    offset: { name: '偏移', icon: 'Move', color: '#d5aa84' },
    composite: { name: '合成', icon: 'Layers', color: '#dca986' },
    custom: { name: '自定义脚本', icon: 'FileCode2', color: '#b0b5c1' },
  };
  const outputParams = [{ key: 'directory', label: '输出目录', type: 'directory', default: { key: '', name: '' } }];
  const outputDefaults = {
    colorMode: 'rgb', format: 'png', quality: 95, indexBits: 7, conflictMode: 'overwrite',
    dither: 'none', ditherAmount: 100, preserveExactColors: true,
  };
  function outputSettings(n) {
    // Older pipelines acquire the same defaults without rewriting their stored graph.
    const settings = { ...outputDefaults, ...n.outputSettings };
    if (settings.colorMode === 'indexed') settings.format = 'png';
    return settings;
  }
  const scripts = new Map();
  function filterId(node) {
    if (node.type === 'custom') {
      if (!scripts.has(node.scriptSource)) {
        const id = `custom-${Store.uuid()}`;
        ScreenFilters.importScript(node.scriptSource, id);
        scripts.set(node.scriptSource, id);
      }
      return scripts.get(node.scriptSource);
    }
    return node.type === 'denoise' && !navigator.gpu ? 'denoise-cpu' : node.type;
  }
  function specs(node) {
    if (node.type === 'output') return outputParams;
    if (node.type === 'input') return [];
    return ScreenFilters.filters[filterId(node)].params;
  }
  function scriptSource(node) {
    return node.type === 'custom' ? node.scriptSource : ScreenFilters.filters[filterId(node)].script;
  }
  function requiresGPU(node) {
    return node.type === 'custom' ? node.scriptMeta.device === 'gpu' : types[node.type].device === 'gpu';
  }
  function node(type, x, y, source) {
    const result = { id: Store.uuid(), type, name: types[type].name, x, y, params: {} };
    if (type === 'custom') {
      result.scriptSource = source;
      result.scriptMeta = ScreenFilters.metadata(source);
      result.name = result.scriptMeta.name;
    }
    result.params = Object.fromEntries(specs(result).map(p => [p.key, structuredClone(p.default)]));
    if (type === 'output') Object.assign(result, { outputMode: 'overwrite', directoryName: '', outputSettings: { ...outputDefaults } });
    return result;
  }
  function create() {
    const input = node('input', 70, 180), output = node('output', 720, 180);
    return { nodes: { [input.id]: input, [output.id]: output }, edges: [], exposedVars: [],
      view: { x: 0, y: 0, zoom: 1 } };
  }
  function inputs(n) {
    if (n.type === 'input') return [];
    if (multipleImages(n)) return ['images'];
    return ['image'];
  }
  function multipleImages(n) { return n.type === 'composite' || (n.type === 'custom' && n.scriptMeta.input === 'images'); }
  function imagePort(key) { return key === 'images' || key === 'images:new' || key.startsWith('images:'); }
  function geometry(n) { return n.type === 'custom' ? n.scriptMeta.geometry : n.type; }
  function imageEdges(graph, n) {
    return graph.edges.filter(e => e.to.nodeId === n.id &&
      (inputs(n).includes(e.to.port) || (multipleImages(n) && imagePort(e.to.port))));
  }
  function moveImageLayer(graph, n, edgeId, index) {
    const edges = imageEdges(graph, n), before = edges.findIndex(e => e.id === edgeId);
    edges.splice(index, 0, edges.splice(before, 1)[0]);
    // Edge-array order is the single persisted layer order, including copy and task snapshots.
    let next = 0;
    graph.edges = graph.edges.map(e => e.to.nodeId === n.id && imagePort(e.to.port) ? edges[next++] : e);
  }
  function port(graph, n, key, direction) {
    if (direction === 'out') {
      if (key === 'image' && n.type !== 'output') return { type: 'image' };
      return n.type === 'input' ? graph.exposedVars.find(v => v.variableId === key)?.spec : undefined;
    }
    if (imagePort(key) && inputs(n).includes('images')) return { type: 'image', multiple: true };
    if (inputs(n).includes(key)) return { type: 'image' };
    return specs(n).find(p => p.key === key);
  }
  function descendants(graph, id) {
    const found = new Set([id]);
    for (const current of found) for (const e of graph.edges) {
      if (e.from.nodeId === current) found.add(e.to.nodeId);
    }
    return found;
  }
  function order(graph, subset = new Set(Object.keys(graph.nodes))) {
    const degrees = new Map([...subset].map(id => [id, 0]));
    for (const e of graph.edges) if (subset.has(e.from.nodeId) && subset.has(e.to.nodeId)) degrees.set(e.to.nodeId, degrees.get(e.to.nodeId) + 1);
    const queue = [...subset].filter(id => degrees.get(id) === 0), result = [];
    for (let i = 0; i < queue.length; i++) {
      const id = queue[i]; result.push(id);
      for (const e of graph.edges) if (e.from.nodeId === id && subset.has(e.to.nodeId)) {
        degrees.set(e.to.nodeId, degrees.get(e.to.nodeId) - 1);
        if (degrees.get(e.to.nodeId) === 0) queue.push(e.to.nodeId);
      }
    }
    if (result.length !== subset.size) throw new Error('连线形成了循环');
    return result;
  }
  function ancestors(graph, targets) {
    const found = new Set(targets);
    for (const current of found) for (const e of graph.edges) {
      if (e.to.nodeId === current) found.add(e.from.nodeId);
    }
    return found;
  }
  function validate(graph, targets) {
    const nodes = Object.values(graph.nodes), errors = [];
    if (nodes.filter(n => n.type === 'input').length !== 1) errors.push('需要且只能有一个输入节点');
    const outputs = nodes.filter(n => n.type === 'output');
    if (!targets && !outputs.length) errors.push('缺少输出节点');
    const active = ancestors(graph, targets || outputs.map(n => n.id));
    try { order(graph); } catch (e) { errors.push(e.message); }
    for (const id of active) {
      const n = graph.nodes[id];
      if (!n) { errors.push('连线指向不存在的节点'); continue; }
      for (const key of inputs(n)) {
        const connected = key === 'images' ? imageEdges(graph, n).length > 0 : graph.edges.some(e => e.to.nodeId === id && e.to.port === key);
        if (!connected) errors.push(`${n.name} · 图像未连接`);
      }
      if (requiresGPU(n) && !navigator.gpu) errors.push(`${n.name}需要 WebGPU`);
    }
    return { valid: !errors.length, errors: [...new Set(errors)], active };
  }
  function compatible(graph, from, to) {
    const a = graph.nodes[from.nodeId], b = graph.nodes[to.nodeId];
    const output = port(graph, a, from.port, 'out'), input = port(graph, b, to.port, 'in');
    if (!output || !input || a.id === b.id || descendants(graph, b.id).has(a.id)) return false;
    if (output.type === 'image' || input.type === 'image') return output.type === input.type;
    if (output.type !== input.type && !(output.type === 'integer' && input.type === 'number')) return false;
    if (input.type === 'enum') return input.values.every(v => output.values.includes(v)) && output.values.every(v => input.values.includes(v));
    return true;
  }
  function connect(graph, from, to) {
    if (!compatible(graph, from, to)) throw new Error('端口不兼容，或连接会形成循环');
    const targetPort = imagePort(to.port) ? 'images' : to.port;
    const connected = imagePort(to.port)
      ? graph.edges.filter(e => e.to.nodeId === to.nodeId && imagePort(e.to.port))
      : graph.edges.filter(e => e.to.nodeId === to.nodeId && e.to.port === to.port);
    const duplicate = connected.find(e => e.from.nodeId === from.nodeId && e.from.port === from.port);
    if (duplicate) return duplicate;
    const old = port(graph, graph.nodes[to.nodeId], to.port, 'in').multiple ? null : connected[0];
    if (old) removeEdge(graph, old.id);
    const edge = { id: Store.uuid(), from: { ...from }, to: { ...to, port: imagePort(to.port) ? `images:${Store.uuid()}` : targetPort } };
    graph.edges.push(edge); return edge;
  }
  function removeEdge(graph, id) {
    const edge = graph.edges.find(e => e.id === id);
    if (edge && edge.from.port !== 'image') {
      // Detaching an exposed value keeps its last default as the node's local value.
      const variable = graph.exposedVars.find(v => v.variableId === edge.from.port);
      graph.nodes[edge.to.nodeId].params[edge.to.port] = structuredClone(variable.defaultValue);
    }
    graph.edges = graph.edges.filter(e => e.id !== id);
    if (edge && edge.from.port !== 'image' && !graph.edges.some(e => e.from.port === edge.from.port)) {
      graph.exposedVars = graph.exposedVars.filter(v => v.variableId !== edge.from.port || v.manual);
    }
  }
  function removeNodes(graph, ids) {
    for (const id of ids) {
      if (graph.nodes[id].type === 'input') continue;
      for (const edge of [...graph.edges]) if (edge.from.nodeId === id || edge.to.nodeId === id) removeEdge(graph, edge.id);
      delete graph.nodes[id];
    }
  }
  function expose(graph, n, key) {
    const existing = graph.edges.find(e => e.to.nodeId === n.id && e.to.port === key);
    if (existing) return graph.exposedVars.find(v => v.variableId === existing.from.port);
    const spec = specs(n).find(p => p.key === key);
    const v = { variableId: Store.uuid(), sourceNodeId: n.id, paramKey: key,
      displayName: `${n.name}.${spec.label}`, defaultValue: structuredClone(params(graph, n)[key]), spec: structuredClone(spec) };
    graph.exposedVars.push(v);
    connect(graph, { nodeId: Object.values(graph.nodes).find(a => a.type === 'input').id, port: v.variableId }, { nodeId: n.id, port: key });
    return v;
  }
  function setParam(graph, n, key, value) {
    n.params[key] = structuredClone(value);
    const edge = graph.edges.find(e => e.to.nodeId === n.id && e.to.port === key);
    if (edge) return setVariable(graph, edge.from.port, value);
    return [n.id];
  }
  function setVariable(graph, variableId, value) {
    graph.exposedVars.find(v => v.variableId === variableId).defaultValue = structuredClone(value);
    return graph.edges.filter(e => e.from.port === variableId).map(e => e.to.nodeId);
  }
  function moveVariable(graph, variableId, targetId, after) {
    const variables = graph.exposedVars;
    const [variable] = variables.splice(variables.findIndex(v => v.variableId === variableId), 1);
    // Array order is shared by cards, parameter panels, tasks, and exported definitions.
    const index = variables.findIndex(v => v.variableId === targetId);
    variables.splice(index + (after ? 1 : 0), 0, variable);
  }
  function params(graph, n, values = {}) {
    const result = structuredClone(n.params);
    if (n.type === 'output') result.directory ??= { key: '', name: n.directoryName || '' };
    for (const e of graph.edges.filter(e => e.to.nodeId === n.id && e.from.port !== 'image')) {
      const v = graph.exposedVars.find(v => v.variableId === e.from.port);
      result[e.to.port] = structuredClone(Object.hasOwn(values, v.variableId) ? values[v.variableId] : v.defaultValue);
    }
    // Mode-dependent whole-pixel radii also apply to shared and task-level values.
    for (const spec of specs(n)) {
      if (spec.integerWhen && result[spec.integerWhen.key] === spec.integerWhen.value) {
        result[spec.key] = Math.max(Math.ceil(spec.min), Math.round(result[spec.key]));
      }
    }
    return result;
  }
  function imageSizes(graph, source, active, values = {}) {
    const sizes = new Map();
    for (const nodeId of order(graph, active)) {
      const n = graph.nodes[nodeId];
      const incoming = imageEdges(graph, n).map(e => sizes.get(e.from.nodeId));
      let size = n.type === 'input' ? { width: source.width, height: source.height } : incoming[0];
      const kind = geometry(n), parameters = params(graph, n, values);
      if (kind === 'resize') size = ScreenResize.dimensions(size.width, size.height, parameters.size);
      if (kind === 'offset') size = ScreenOffset.dimensions(size.width, size.height, parameters);
      sizes.set(nodeId, size);
    }
    return sizes;
  }
  function imageSize(graph, id, source) {
    if (!source || !validate(graph, [id]).valid) return null;
    const sizes = imageSizes(graph, source, ancestors(graph, [id]));
    return sizes.get(id);
  }
  function updateScript(graph, n, source) {
    if (source === scriptSource(n)) return false;
    const meta = ScreenFilters.metadata(source), oldSpecs = new Map(specs(n).map(spec => [spec.key, spec]));
    const nextSpecs = new Map(meta.params.map(spec => [spec.key, spec])), affectedVariables = new Set(), affectedNodes = new Set([n.id]);
    // Removed or retyped inputs lose their old value connections before ports change.
    for (const edge of [...graph.edges]) {
      if (edge.to.nodeId !== n.id || inputs(n).includes(edge.to.port)) continue;
      const before = oldSpecs.get(edge.to.port), after = nextSpecs.get(edge.to.port);
      if (!after || before.type !== after.type) removeEdge(graph, edge.id);
    }
    // A shared input can outlive the script parameter that originally exposed it.
    for (const variable of graph.exposedVars.filter(v => v.sourceNodeId === n.id)) {
      const after = nextSpecs.get(variable.paramKey);
      if (!after || oldSpecs.get(variable.paramKey).type !== after.type) {
        delete variable.sourceNodeId; delete variable.paramKey; variable.manual = true;
      }
    }
    const nextParams = {};
    for (const spec of meta.params) {
      const before = oldSpecs.get(spec.key);
      const changed = !before || before.type !== spec.type || JSON.stringify(before.default) !== JSON.stringify(spec.default);
      nextParams[spec.key] = structuredClone(changed ? spec.default : n.params[spec.key]);
      // An exposed input's definition belongs to its source node; keep its variable ID.
      for (const variable of graph.exposedVars.filter(v => v.sourceNodeId === n.id && v.paramKey === spec.key)) {
        affectedVariables.add(variable.variableId);
        if (variable.displayName === `${n.name}.${variable.spec.label}`) variable.displayName = `${n.name}.${spec.label || spec.key}`;
        variable.spec = structuredClone(spec);
        if (changed) {
          variable.defaultValue = structuredClone(spec.default);
          for (const edge of graph.edges) if (edge.from.port === variable.variableId) affectedNodes.add(edge.to.nodeId);
        }
      }
    }
    // Conversion keeps the node identity and name; only its implementation changes.
    n.type = 'custom';
    n.scriptSource = source; n.scriptMeta = meta; n.params = nextParams;
    // Enum edits and shared exposed inputs can change compatibility at other nodes too.
    for (const edge of [...graph.edges]) {
      if (edge.from.port !== 'image' && (edge.to.nodeId === n.id || affectedVariables.has(edge.from.port)) && !compatible(graph, edge.from, edge.to)) {
        affectedNodes.add(edge.to.nodeId); removeEdge(graph, edge.id);
      }
    }
    return [...affectedNodes];
  }
  function importDefinition(data) {
    if (data.format !== 'screenlab-pipeline' || data.version !== 1 || !data.graph?.nodes || !Array.isArray(data.graph.edges) || !Array.isArray(data.graph.exposedVars)) throw new Error('不是支持的流水线 JSON');
    const graph = structuredClone(data.graph);
    delete graph.preview;
    Store.migrateSurfaceBlur(graph);
    Store.migrateDenoiseBlend(graph);
    for (const n of Object.values(graph.nodes)) {
      if (!types[n.type]) throw new Error(`未知节点类型：${n.type}`);
      if (n.type === 'custom') n.scriptMeta = ScreenFilters.metadata(n.scriptSource);
      if (n.type === 'resize' && n.name === '缩图') {
        n.name = types.resize.name;
        for (const v of graph.exposedVars) {
          if (v.sourceNodeId === n.id && v.displayName === '缩图.尺寸') v.displayName = '缩放.尺寸';
        }
      }
      n.name ||= n.scriptMeta?.name || types[n.type].name;
      n.params = { ...Object.fromEntries(specs(n).map(p => [p.key, structuredClone(p.default)])), ...n.params };
    }
    for (const e of graph.edges) if (!graph.nodes[e.from.nodeId] || !graph.nodes[e.to.nodeId]) throw new Error('连线引用缺失的节点');
    if (Object.values(graph.nodes).filter(n => n.type === 'input').length !== 1) throw new Error('只能有一个输入节点');
    for (const v of graph.exposedVars) {
      if (!v.spec) v.spec = structuredClone(specs(graph.nodes[v.sourceNodeId]).find(p => p.key === v.paramKey));
      if (!v.spec) throw new Error('输入变量缺少参数定义');
    }
    const usedInputs = new Set();
    for (const e of graph.edges) {
      const key = `${e.to.nodeId}:${e.to.port}`;
      if (usedInputs.has(key) && !port(graph, graph.nodes[e.to.nodeId], e.to.port, 'in')?.multiple) throw new Error('一个输入端口不能有两条连线');
      usedInputs.add(key);
      const outgoing = port(graph, graph.nodes[e.from.nodeId], e.from.port, 'out'), incoming = port(graph, graph.nodes[e.to.nodeId], e.to.port, 'in');
      if (!outgoing || !incoming || (outgoing.type !== incoming.type && !(outgoing.type === 'integer' && incoming.type === 'number'))) throw new Error('存在不兼容的端口连线');
    }
    order(graph);
    // Output destinations are machine-local; imported definitions always ask again.
    for (const n of Object.values(graph.nodes)) if (n.type === 'output') { n.directoryName = ''; n.params.directory.key = ''; }
    for (const v of graph.exposedVars) if (v.spec.type === 'directory') v.defaultValue.key = '';
    return graph;
  }
  function exportDefinition(pipeline) {
    UI.download(new Blob([JSON.stringify({ format: 'screenlab-pipeline', version: 1, name: pipeline.name, graph: pipeline.graph }, null, 2)], { type: 'application/json' }), `${pipeline.name}.json`);
  }
  return { types, create, node, specs, scriptSource, requiresGPU, inputs, multipleImages, geometry, imageEdges, moveImageLayer, imageSizes, port, compatible, connect, expose, setParam, setVariable, moveVariable, params, updateScript, outputSettings,
    removeEdge, removeNodes, descendants, ancestors, order, validate, filterId, imageSize, importDefinition, exportDefinition };
})();
