/* Persistent definitions only. File objects and writable handles live in src/io/assets.js. */
'use strict';

const Store = (() => {
  const KEY = 'screenlab-v2';
  // An empty saved pipeline list is still an existing installation.
  const isFirstLaunch = localStorage.getItem(KEY) === null;

  function load() {
    return JSON.parse(localStorage.getItem(KEY)) || blank();
  }
  function blank() { return { imageSets: {}, pipelines: {}, tasks: {} }; }
  function save(data) { localStorage.setItem(KEY, JSON.stringify(data)); }

  function surfaceRadius(value) { return Math.max(1, Math.min(100, Math.round(value))); }
  function migrateSurfaceBlur(graph) {
    const changed = Object.values(graph.nodes).filter(node => node.type === 'gaussian-blur');
    const filter = ScreenFilters.filters['surface-blur'];
    // Saved graphs and imported JSON use the same replacement while retaining node/variable IDs.
    for (const node of changed) {
      node.type = 'surface-blur';
      if (node.name === '高斯模糊') node.name = filter.name;
      node.params.radius = surfaceRadius(node.params.radius);
      node.params.threshold = ScreenFilters.defaults(filter.id).threshold;
      for (const variable of graph.exposedVars) {
        if (variable.sourceNodeId !== node.id || variable.paramKey !== 'radius') continue;
        if (variable.displayName === '高斯模糊.半径（像素）') variable.displayName = `${filter.name}.半径（像素）`;
        variable.spec = structuredClone(filter.params.find(spec => spec.key === 'radius'));
        variable.defaultValue = surfaceRadius(variable.defaultValue);
      }
    }
    return changed.length > 0;
  }

  function migrateDenoiseBlend(graph) {
    const nodes = Object.values(graph.nodes).filter(node => node.type === 'denoise');
    const nodeIds = new Set(nodes.map(node => node.id));
    let changed = false;
    for (const node of nodes) {
      if (Object.hasOwn(node.params, 'blend')) {
        delete node.params.blend;
        changed = true;
      }
    }
    const removedEdges = graph.edges.filter(edge => nodeIds.has(edge.to.nodeId) && edge.to.port === 'blend');
    const affectedVariables = new Set(removedEdges.map(edge => edge.from.port));
    graph.edges = graph.edges.filter(edge => !removedEdges.includes(edge));
    const removedVariableIds = new Set();
    for (const variable of graph.exposedVars) {
      const sourceRemoved = nodeIds.has(variable.sourceNodeId) && variable.paramKey === 'blend';
      if (!sourceRemoved && !affectedVariables.has(variable.variableId)) continue;
      const connected = graph.edges.some(edge => edge.from.port === variable.variableId);
      if (!connected && !variable.manual) {
        removedVariableIds.add(variable.variableId);
      } else if (sourceRemoved) {
        // Shared inputs still used by other nodes retain their values and connections.
        delete variable.sourceNodeId;
        delete variable.paramKey;
        variable.manual = true;
        changed = true;
      }
    }
    graph.exposedVars = graph.exposedVars.filter(variable => !removedVariableIds.has(variable.variableId));
    return { changed: changed || removedEdges.length > 0 || removedVariableIds.size > 0, removedVariableIds };
  }

  let _data = load();
  let migrated = false;
  // Move older preview preferences out of the saved processing graph once.
  for (const pipeline of Object.values(_data.pipelines)) {
    const denoiseMigration = migrateDenoiseBlend(pipeline.graph);
    if (denoiseMigration.changed) {
      migrated = true;
      for (const task of Object.values(_data.tasks).filter(task => task.pipelineId === pipeline.id)) {
        for (const variableId of denoiseMigration.removedVariableIds) delete task.params[variableId];
      }
    }
    if (migrateSurfaceBlur(pipeline.graph)) {
      migrated = true;
      const radii = pipeline.graph.edges.filter(edge => edge.to.port === 'radius' &&
        pipeline.graph.nodes[edge.to.nodeId].type === 'surface-blur').map(edge => edge.from.port);
      for (const task of Object.values(_data.tasks).filter(task => task.pipelineId === pipeline.id)) {
        for (const variableId of radii) {
          if (Object.hasOwn(task.params, variableId)) task.params[variableId] = surfaceRadius(task.params[variableId]);
        }
      }
    }
    // Remove the withdrawn two-input merge node from saved pipelines.
    const removedNodes = new Set(Object.values(pipeline.graph.nodes).filter(node => node.type === 'merge').map(node => node.id));
    if (removedNodes.size) {
      for (const id of removedNodes) delete pipeline.graph.nodes[id];
      pipeline.graph.edges = pipeline.graph.edges.filter(edge => !removedNodes.has(edge.from.nodeId) && !removedNodes.has(edge.to.nodeId));
      migrated = true;
    }
    if (pipeline.graph.preview) {
      EditorState.get(pipeline.id, pipeline.graph.preview);
      delete pipeline.graph.preview;
      migrated = true;
    }
    // Rename the built-in default while keeping user-assigned node and input names.
    for (const node of Object.values(pipeline.graph.nodes)) {
      if (node.type !== 'resize' || node.name !== '缩图') continue;
      node.name = '缩放'; migrated = true;
      for (const variable of pipeline.graph.exposedVars) {
        if (variable.sourceNodeId === node.id && variable.displayName === '缩图.尺寸') variable.displayName = '缩放.尺寸';
      }
    }
  }
  if (migrated) save(_data);
  // A refresh ends the workers, but keeps the last completed image checkpoint.
  for (const task of Object.values(_data.tasks)) {
    if (task.status === 'running' || task.status === 'pausing') task.status = 'paused';
  }
  const persist = () => save(_data);

  function uuid() { return crypto.randomUUID(); }

  /* -------- ImageSets -------- */
  const imageSets = {
    all()   { return _data.imageSets; },
    get(id) { return _data.imageSets[id]; },
    create(name) {
      const id = uuid();
      _data.imageSets[id] = { id, name, createdAt: Date.now(), files: [] };
      persist(); return _data.imageSets[id];
    },
    update(id, patch) { Object.assign(_data.imageSets[id], patch); persist(); },
    remove(id) { delete _data.imageSets[id]; persist(); },
  };

  /* -------- Pipelines -------- */
  const pipelines = {
    all()   { return _data.pipelines; },
    get(id) { return _data.pipelines[id]; },
    create(name, graph) {
      const id = uuid();
      const now = Date.now();
      _data.pipelines[id] = { id, name, createdAt: now, updatedAt: now, graph };
      persist(); return _data.pipelines[id];
    },
    update(id, patch) {
      Object.assign(_data.pipelines[id], patch);
      _data.pipelines[id].updatedAt = Date.now();
      persist();
    },
    async remove(id) { delete _data.pipelines[id]; persist(); await EditorState.remove(id); },
  };

  /* -------- Tasks -------- */
  const tasks = {
    all()   { return _data.tasks; },
    get(id) { return _data.tasks[id]; },
    create(name, imageSetId, pipelineId, params) {
      const id = uuid();
      _data.tasks[id] = {
        id, name, createdAt: Date.now(),
        imageSetId, pipelineId, params: params || {},
        status: 'idle',
        progress: { current: 0, total: 0, currentFileName: '' },
        errors: [],
        elapsedMs: 0,
        outputDirectories: {},
      };
      persist(); return _data.tasks[id];
    },
    update(id, patch) { Object.assign(_data.tasks[id], patch); persist(); },
    remove(id) { delete _data.tasks[id]; persist(); },
  };

  /* 用于任务引用检查 */
  function tasksUsing(field, refId) {
    return Object.values(_data.tasks).filter(t => t[field] === refId);
  }

  function resetTask(id) {
    tasks.update(id, {
      status: 'idle', errors: [], elapsedMs: 0, runKey: null,
      progress: { current: 0, total: 0, currentFileName: '', nodeName: '', nodeProgress: 0, imageProgress: 0 },
    });
  }

  return { uuid, imageSets, pipelines, tasks, tasksUsing, resetTask, persist, migrateSurfaceBlur, migrateDenoiseBlend, isFirstLaunch };
})();
