/* Canvas interactions own graph edits; Preview and Engine own image evaluation. */
'use strict';
const Editor = (() => {
  let session = null, clipboard = null;
  function init(root, sidebar, pipeline, onChange) {
    destroy();
    const graph = pipeline.graph, selected = new Set();
    const events = new AbortController(), nodeElements = new Map(), nodePreviews = new Map();
    const outputEstimates = new Map();
    let previewFileType = '';
    let gesture = null, draft = null, popup = null, popupNode = null, popupViews = [], scriptEditor = null, space = false;
    let previewTimer = null, previewRun = null, trialRun = null, previewSourceVersion = 0;
    // The panel and canvas use different crops; switching views must keep both caches.
    const canvasPreview = { cache: new Map(), image: null, roi: null }, panelPreview = { cache: new Map(), image: null, roi: null };
    let previewError = '', previewNode = null, previewProgress = 0;
    let view = { x: 40, y: 40, zoom: 1, ...graph.view };
    const previewState = EditorState.get(pipeline.id);
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'), nodeHost = UI.el('div', 'node-host');
    svg.classList.add('edges'); root.append(svg, nodeHost);
    const preview = Preview.create(() => {
      EditorState.update(pipeline.id, preview.view()); syncPreviewRegion();
      previewZoom.value = Math.round(preview.view().zoom * 100); updatePreviewStatus();
    });
    const { canvasZoom, previewZoom, previewStatus, sourceName, sidebarSurface, validationLabel, stats, enabled, trialButton, trialProgress, trialStatus } = buildSidebar();
    preview.attach(sidebarSurface, { primary: true });

    function listen(element, type, fn, options = {}) { element.addEventListener(type, fn, { ...options, signal: events.signal }); }
    function save() { graph.view = { ...view }; onChange(pipeline); }
    function edited(ids = []) { save(); render(); invalidate(ids); }
    function local(event) { const r = root.getBoundingClientRect(); return { x: event.clientX - r.left, y: event.clientY - r.top }; }
    function world(point) { return { x: (point.x - view.x) / view.zoom, y: (point.y - view.y) / view.zoom }; }
    function applyView() {
      nodeHost.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.zoom})`;
      root.style.backgroundSize = `${24 * view.zoom}px ${24 * view.zoom}px`;
      root.style.backgroundPosition = `${view.x}px ${view.y}px`;
      canvasZoom.value = Math.round(view.zoom * 100); drawEdges();
    }
    function zoomTo(value, anchor = { x: root.clientWidth / 2, y: root.clientHeight / 2 }) {
      const point = world(anchor); view.zoom = Math.max(.25, Math.min(4, value));
      view.x = anchor.x - point.x * view.zoom; view.y = anchor.y - point.y * view.zoom;
      applyView(); save();
    }
    function fit() {
      const cards = [...nodeElements.values()];
      const minX = Math.min(...Object.values(graph.nodes).map(n => n.x)), minY = Math.min(...Object.values(graph.nodes).map(n => n.y));
      const maxX = Math.max(...cards.map(c => graph.nodes[c.dataset.node].x + c.offsetWidth)), maxY = Math.max(...cards.map(c => graph.nodes[c.dataset.node].y + c.offsetHeight));
      view.zoom = Math.max(.25, Math.min(1, (root.clientWidth - 80) / (maxX - minX), (root.clientHeight - 80) / (maxY - minY)));
      view.x = (root.clientWidth - (maxX - minX) * view.zoom) / 2 - minX * view.zoom;
      view.y = (root.clientHeight - (maxY - minY) * view.zoom) / 2 - minY * view.zoom;
      applyView(); save();
    }
    function buildSidebar() {
      function section(title) { const s = UI.el('section', 'sidebar-section'); s.append(UI.el('h3', 'sidebar-title', title)); sidebar.append(s); return s; }
      const navigation = section('画布'), canvasZoom = UI.el('input'); canvasZoom.type = 'number'; canvasZoom.min = 25; canvasZoom.max = 400; canvasZoom.step = 1; canvasZoom.value = view.zoom * 100; canvasZoom.setAttribute('aria-label', '画布缩放百分比');
      canvasZoom.onchange = () => { if (canvasZoom.reportValidity()) zoomTo(canvasZoom.valueAsNumber / 100); };
      const control = UI.el('div', 'zoom-control'); control.append(canvasZoom, UI.el('span', '', '%'), UI.button('Shrink', '适应画布', fit), UI.button('Focus', '画布 100%', () => zoomTo(1))); navigation.append(control);
      const info = section('流水线'), infoRow = UI.el('div', 'pipeline-status-row'), validationLabel = UI.el('div', 'editor-status'), stats = UI.el('div', 'editor-stat');
      infoRow.append(validationLabel, stats); info.append(infoRow);
      const image = section('预览图片'), sourceName = UI.el('div', 'preview-source', previewState.name ? `${previewState.name} · 恢复中` : '未选择');
      const imageChoices = UI.el('div', 'preview-source-picker'); imageChoices.hidden = !previewState.enabled;
      imageChoices.append(UI.button('ImagePlus', '选择预览图片', async () => {
        const [file] = await UI.pickFiles({ accept: 'image/*' }); if (!file) return;
        await loadPreview(file, { imageSetId: '', fileId: '' });
        chooseSet.value = ''; updateFileSelect('');
      }, '选择图片'));
      const chooseSet = UI.select([['', '从图片集选择'], ...Object.values(Store.imageSets.all()).map(s => [s.id, s.name])], previewState.imageSetId, id => {
        EditorState.update(pipeline.id, { imageSetId: id, fileId: '' });
        updateFileSelect(id);
      });
      const fileSelect = UI.select([], '',
        async id => { if (id) await loadPreview(await Assets.read(id), { imageSetId: chooseSet.value, fileId: id }); });
      let authorizing = false;
      const authorizeButton = UI.button('FolderOpen', '', async () => {
        const set = Store.imageSets.get(chooseSet.value);
        authorizing = true; updateFileSelect(set.id, fileSelect.value);
        try {
          const { authorized, changed } = await Assets.reconnect(set);
          if (changed) for (const task of Store.tasksUsing('imageSetId', set.id)) {
            if (!Tasks.isRunning(task.id)) Store.resetTask(task.id);
          }
          UI.toast(`已授权 ${authorized} / ${set.files.length} 张图片`);
        } finally {
          authorizing = false;
          if (!events.signal.aborted) updateFileSelect(chooseSet.value, fileSelect.value);
        }
      }, '选择图片');
      const fileChoice = UI.el('div', 'preview-file-choice'); fileChoice.append(fileSelect, authorizeButton);
      function updateFileSelect(setId, fileId = '') {
        const files = Store.imageSets.get(setId)?.files || [];
        fileSelect.replaceChildren(new Option('选择图片', ''));
        // Saved descriptors remain after refresh, but only authorized sources can be read.
        for (const file of files) {
          const option = new Option(file.path || file.name, file.id);
          option.disabled = !Assets.authorized(file.id);
          fileSelect.add(option);
        }
        fileSelect.value = fileId;
        const locked = !files.some(file => Assets.authorized(file.id));
        const busy = Store.tasksUsing('imageSetId', setId).some(task => Tasks.isRunning(task.id));
        fileSelect.hidden = locked; authorizeButton.hidden = !locked;
        authorizeButton.disabled = !setId || authorizing || busy;
        fileChoice.title = !setId ? '请先选择图片集' : authorizing ? '正在授权图片集' : locked
          ? busy ? '任务正在使用此图片集，完成后可重新授权' : '图片集尚无已授权图片，点击选择目录授权后即可选图'
          : '';
        authorizeButton.title = fileChoice.title;
        authorizeButton.setAttribute('aria-label', fileChoice.title || '选择图片');
      }
      updateFileSelect(previewState.imageSetId, previewState.fileId);
      const selectRow = UI.el('div', 'preview-select-row'); selectRow.append(chooseSet, fileChoice);
      const sourceRow = UI.el('div', 'preview-meta-row');
      const check = UI.el('label', 'check-row'), enabled = UI.el('input'); enabled.type = 'checkbox'; enabled.checked = previewState.enabled;
      check.append(enabled, document.createTextNode('编辑器预览'));
      imageChoices.append(selectRow); sourceRow.append(sourceName);
      image.append(check, imageChoices, sourceRow);
      const trialButton = UI.button('Play', '整图试跑并下载结果', trial, '试跑'); trialButton.classList.add('primary', 'trial-button');
      const trialProgress = UI.el('progress', 'trial-progress'); trialProgress.max = 100; trialProgress.value = 0; trialProgress.hidden = true; trialProgress.setAttribute('aria-label', '试跑总进度');
      const trialStatus = UI.el('div', 'trial-status'); trialStatus.setAttribute('role', 'status');
      image.append(trialButton, trialProgress, trialStatus);
      const viewportSection = section('图片视窗'), sidebarSurface = UI.el('div', 'preview-surface'), previewStatus = UI.el('div', 'preview-size');
      viewportSection.append(sidebarSurface);
      const previewZoom = UI.el('input'); previewZoom.type = 'number'; previewZoom.min = 5; previewZoom.max = 3200; previewZoom.step = 1; previewZoom.value = previewState.zoom * 100; previewZoom.setAttribute('aria-label', '图片缩放百分比');
      previewZoom.onchange = () => { if (previewZoom.reportValidity()) preview.zoomTo(previewZoom.valueAsNumber / 100); };
      const zoomControl = UI.el('div', 'zoom-control'); zoomControl.append(previewZoom, UI.el('span', '', '%'), UI.button('Shrink', '图片适应视窗', () => preview.fit()), UI.button('Focus', '图片 100%', () => preview.zoomTo(1)));
      viewportSection.append(zoomControl, previewStatus);
      enabled.onchange = () => {
        EditorState.update(pipeline.id, { enabled: enabled.checked }); imageChoices.hidden = !enabled.checked;
        render(); schedule();
      };
      return { canvasZoom, previewZoom, previewStatus, sourceName, sidebarSurface, validationLabel, stats, enabled, trialButton, trialProgress, trialStatus };
    }
    async function loadPreview(file, selection, persist = true) {
      const version = ++previewSourceVersion;
      const image = await Assets.decode(file); if (events.signal.aborted || version !== previewSourceVersion) return;
      if (persist) await EditorState.setFile(pipeline.id, file);
      if (events.signal.aborted || version !== previewSourceVersion) return;
      previewFileType = file.type;
      Assets.previews.set(pipeline.id, { image, name: file.name, type: file.type });
      EditorState.update(pipeline.id, { name: file.name, ...selection });
      sourceName.textContent = `${file.name} · ${image.width} × ${image.height}`;
      preview.load(image, previewState); updateTrialButton();
      if (popupNode) openPanel(graph.nodes[popupNode]);
    }
    // Visible pages paint each result; hidden pages must not wait for animation frames.
    function paintFrame(signal) {
      if (document.hidden || signal.aborted) return Promise.resolve();
      return new Promise(resolve => {
        const channel = new MessageChannel();
        // A message task resumes after painting without a background-throttled timer.
        const frame = requestAnimationFrame(() => channel.port2.postMessage(null));
        function finish() {
          cancelAnimationFrame(frame);
          channel.port1.close(); channel.port2.close();
          document.removeEventListener('visibilitychange', onVisibility);
          signal.removeEventListener('abort', finish);
          resolve();
        }
        function onVisibility() { if (document.hidden) finish(); }
        channel.port1.onmessage = finish;
        document.addEventListener('visibilitychange', onVisibility);
        signal.addEventListener('abort', finish, { once: true });
      });
    }
    function updateTrialButton() {
      const problem = Graph.validate(graph).errors.join('；');
      trialButton.disabled = !!trialRun || !preview.image || !!problem;
      trialButton.title = trialRun ? '试跑中' : !preview.image ? '请先选择预览图片' : problem || '整图试跑并下载结果';
    }
    async function trial() {
      const snapshot = structuredClone(graph), image = preview.image, name = previewState.name;
      const validation = Graph.validate(snapshot);
      if (!validation.valid) throw new Error(validation.errors.join('；'));
      const controller = new AbortController(); trialRun = controller;
      clearTimeout(previewTimer); previewRun?.abort(); previewNode = null; paintPreviews(); updateTrialButton();
      trialButton.querySelector('span').textContent = '试跑中';
      trialProgress.hidden = false; trialProgress.value = 0; trialStatus.textContent = '0%';
      const progress = new Map([...validation.active].map(id => [id, 0]));
      try {
        await paintFrame(controller.signal);
        const results = await Engine.execute(snapshot, image, { signal: controller.signal, onProgress: (node, value) => {
          progress.set(node.id, value);
          const percentage = [...progress.values()].reduce((sum, v) => sum + v, 0) / progress.size * 100;
          trialProgress.value = percentage;
          trialStatus.textContent = `${percentage.toFixed(1)}% · ${node.name} ${Math.round(value * 100)}%`;
        }, onNode: () => paintFrame(controller.signal) });
        const stem = name.replace(/\.[^.]+$/, '');
        const outputs = Object.values(snapshot.nodes).filter(n => n.type === 'output');
        for (const [index, node] of outputs.entries()) {
          if (controller.signal.aborted) throw new DOMException('Cancelled', 'AbortError');
          trialStatus.textContent = `100% · 下载 ${node.name}`;
          await Assets.download(results.get(node.id), `${stem}_试跑${outputs.length > 1 ? `_${index + 1}` : ''}`, node, controller.signal);
        }
        trialStatus.textContent = '100% · 已下载';
      } catch (error) {
        if (error.name !== 'AbortError') trialStatus.textContent = `试跑失败：${error.message}`;
        throw error;
      } finally {
        trialRun = null;
        if (!events.signal.aborted) {
          trialButton.querySelector('span').textContent = '试跑'; updateTrialButton(); schedule();
        }
      }
    }
    function updatePreviewStatus() {
      const crop = preview.roi;
      previewStatus.textContent = !preview.image ? '' : previewError || (crop ? `${crop.w} × ${crop.h} px · (${crop.x}, ${crop.y})` : previewSizeMessage());
    }
    function previewSizeMessage() { return `无法预览：可见区域超过 ${preview.limit} × ${preview.limit} px，请放大图片`; }
    function previewMessage(id, result, connectionError = '') {
      if (!preview.image) return '未选择图片';
      if (!preview.roi) return previewSizeMessage();
      if (connectionError) return connectionError;
      if (result) return '';
      if (previewError) return previewError;
      if (trialRun) return '试跑中，预览暂停';
      // A valid crop without a cached result is waiting for work, not oversized.
      return previewNode === id ? '计算中' : '等待计算';
    }
    function portElement(nodeId, direction, key) {
      return nodeElements.get(nodeId).querySelector(`[data-direction="${direction}"][data-port="${CSS.escape(key)}"]`);
    }
    function portPoint(nodeId, direction, key) {
      const element = portElement(nodeId, direction, key), rect = element.getBoundingClientRect(), base = root.getBoundingClientRect();
      return { x: rect.left + rect.width / 2 - base.left, y: rect.top + rect.height / 2 - base.top };
    }
    function bezier(a, b) { const bend = Math.max(45, Math.abs(b.x - a.x) * .4); return `M${a.x},${a.y} C${a.x + bend},${a.y} ${b.x - bend},${b.y} ${b.x},${b.y}`; }
    function path(d, className) { const p = document.createElementNS(svg.namespaceURI, 'path'); p.setAttribute('d', d); p.setAttribute('class', className); return p; }
    function drawEdges() {
      svg.replaceChildren(); svg.setAttribute('viewBox', `0 0 ${root.clientWidth} ${root.clientHeight}`);
      for (const e of graph.edges) {
        const from = portPoint(e.from.nodeId, 'out', e.from.port), to = portPoint(e.to.nodeId, 'in', e.to.port);
        const d = bezier(from, to), hit = path(d, 'edge-hit'), line = path(d, `edge${selected.has(e.id) ? ' selected' : ''}`);
        line.style.stroke = e.from.port === 'image' ? '#e7c94f' : '#71b4f1';
        hit.onpointerdown = event => { event.stopPropagation(); selected.clear(); selected.add(e.id); updateSelection(); };
        hit.oncontextmenu = event => { event.preventDefault(); event.stopPropagation(); UI.menu(event.clientX, event.clientY, [{ icon: 'Trash2', label: '删除连线', action: () => { Graph.removeEdge(graph, e.id); selected.delete(e.id); edited([e.to.nodeId]); } }]); };
        svg.append(hit, line);
      }
      if (draft) {
        const start = portPoint(draft.nodeId, draft.direction, draft.port), end = draft.point;
        svg.append(path(draft.direction === 'out' ? bezier(start, end) : bezier(end, start), 'edge draft'));
      }
    }
    function updateSelection() { for (const [id, card] of nodeElements) card.classList.toggle('selected', selected.has(id)); drawEdges(); }
    function makePort(node, direction, key, label, type) {
      const dot = UI.el('button', 'port'); dot.type = 'button'; dot.dataset.node = node.id; dot.dataset.direction = direction; dot.dataset.port = key;
      dot.style.setProperty('--port-color', type === 'image' ? '#e7c94f' : '#71b4f1'); dot.title = `${label} · ${type}`; dot.setAttribute('aria-label', dot.title);
      dot.onpointerdown = event => startWire(event, node.id, direction, key);
      return dot;
    }
    function portRow(node, direction, key, label, type, value) {
      const row = UI.el('div', `port-row ${direction}${type === 'image' ? '' : ' param'}`), text = UI.el('span', 'port-label', label);
      text.title = label;
      const dot = makePort(node, direction, key, label, type);
      row.append(text); if (value !== undefined) row.append(UI.el('span', 'param-value', type === 'directory' ? value.name || '未选择' : typeof value === 'object' ? '[曲线]' : String(value)));
      direction === 'in' ? row.prepend(dot) : row.append(dot);
      return row;
    }
    function outputControls(n, host) {
      const settings = Graph.outputSettings(n);
      const change = (key, value) => {
        n.outputSettings = { ...Graph.outputSettings(n), [key]: value };
        if (n.outputSettings.colorMode === 'indexed') n.outputSettings.format = 'png';
        edited([n.id]); if (popupNode === n.id) openPanel(n);
      };
      host.append(UI.label('颜色模式', UI.select([['rgb', 'RGB'], ['grayscale', '黑白（灰度）'], ['indexed', '索引颜色']], settings.colorMode, value => change('colorMode', value))));
      if (settings.colorMode === 'indexed') host.append(UI.label('索引位数', UI.select(
        [2, 3, 4, 5, 6, 7].map(bits => [String(bits), `${bits} 位 · 最多 ${2 ** bits} 色`]), String(settings.indexBits), value => change('indexBits', Number(value)))));
      if (n.outputMode !== 'directory') return;
      host.append(UI.label('重名文件', UI.select([['overwrite', '覆盖（默认）'], ['suffix', '给新文件增加后缀']], settings.conflictMode, value => change('conflictMode', value))));
      const compression = UI.select([['png', '无损（PNG）'], ['jpeg', 'JPG'], ['webp', 'WebP']], settings.format, value => change('format', value));
      compression.disabled = settings.colorMode === 'indexed';
      host.append(UI.label('压缩方式', compression));
      if (settings.format !== 'png') {
        const quality = UI.parameter({ key: 'quality', label: '质量（%）', type: 'integer', min: 1, max: 100, step: 1 }, settings.quality, value => {
          n.outputSettings = { ...Graph.outputSettings(n), quality: value }; save();
          // Keep the card and floating panel in sync without replacing a slider mid-drag.
          for (const control of document.querySelectorAll(`[data-output-quality="${CSS.escape(n.id)}"] input`)) control.value = value;
          paintOutputEstimate(n.id);
        }, { sliders: true });
        quality.dataset.outputQuality = n.id;
        host.append(UI.label('质量（%）', quality));
      }
    }
    function paintOutputEstimate(id) {
      const node = graph.nodes[id];
      if (node?.type !== 'output') return;
      const label = nodeElements.get(id)?.querySelector('.output-size');
      if (!label) return;
      const context = previewContext();
      const image = (context.image === preview.image ? context.cache.get(id) : null)
        || (canvasPreview.image === preview.image ? canvasPreview.cache.get(id) : null);
      if (!image) {
        outputEstimates.delete(id);
        label.textContent = `预估大小：${preview.image ? '等待预览' : '未选择图片'}`;
        label.title = '获得输出预览后估算文件大小';
        return;
      }
      const type = node.outputMode === 'overwrite' ? previewFileType : OutputFormat.format(node).type;
      const key = JSON.stringify([node.outputMode, Graph.outputSettings(node), type]);
      let estimate = outputEstimates.get(id);
      if (estimate?.image !== image || estimate.key !== key) {
        estimate = { image, key, text: '预估大小：估算中' };
        outputEstimates.set(id, estimate);
        const snapshot = structuredClone(node);
        OutputFormat.estimateSize(image, snapshot, type).then(bytes => {
          const unit = bytes >= 1048576 ? 'MB' : 'KB', divisor = unit === 'MB' ? 1048576 : 1024;
          estimate.text = `预估大小：约 ${(bytes / divisor).toFixed(1)} ${unit}`;
        }).catch(error => {
          estimate.text = '预估大小：无法估算';
          estimate.error = error.message;
        }).finally(() => {
          // Encoding is asynchronous; an older crop or setting must not replace the current estimate.
          if (!events.signal.aborted && outputEstimates.get(id) === estimate) paintOutputEstimate(id);
        });
      }
      label.textContent = estimate.text;
      label.title = estimate.error || '按当前输出预览的编码大小与整图像素面积估算，实际文件大小可能不同';
    }
    function exposeParameter(n, key) {
      if (n.type === 'output' && key === 'directory' && !n.params.directory?.key && !graph.edges.some(e => e.to.nodeId === n.id && e.to.port === key)) {
        // Carry a previously selected node directory into the exposed default.
        Graph.setParam(graph, n, key, directoryValue(n));
      }
      return Graph.expose(graph, n, key);
    }
    function directoryValue(n) {
      const value = Graph.params(graph, n).directory;
      if (value.key || graph.edges.some(e => e.to.nodeId === n.id && e.to.port === 'directory')) return value;
      const key = Tasks.pipelineDirectoryKey(pipeline.id, n.id);
      return { key, name: Assets.directory(key)?.name || value.name };
    }
    function directoryControls(n, host, panel = false) {
      const spec = Graph.specs(n).find(p => p.key === 'directory');
      if (panel) { parameterPanel(n, spec, host); return; }
      const value = directoryValue(n);
      host.append(portRow(n, 'in', spec.key, spec.label, spec.type, value));
      if (n.outputMode === 'directory') host.append(UI.parameter(spec, value, directory => {
        edited(Graph.setParam(graph, n, spec.key, directory));
        if (popupNode) openPanel(graph.nodes[popupNode]);
      }));
    }
    function imageInputControls(n, host) {
      const edges = Graph.imageEdges(graph, n);
      host.replaceChildren();
      const heading = UI.el('div', 'image-input-heading');
      heading.append(UI.el('span', '', '图层输入'), UI.el('small', '', '上方覆盖下方'));
      host.append(heading);
      const list = UI.el('div', 'image-input-list');
      [...edges].reverse().forEach((edge, index) => {
        const row = UI.el('div', 'image-input-row'); row.draggable = true;
        const port = makePort(n, 'in', edge.to.port, `第 ${index + 1} 层`, 'image');
        const label = UI.el('span', 'image-input-label', `第 ${index + 1} 层 · ${graph.nodes[edge.from.nodeId]?.name || '图像'}`);
        row.append(port, label, UI.button('Unplug', '断开这一层', () => { Graph.removeEdge(graph, edge.id); edited([n.id]); }));
        row.ondragstart = event => { event.dataTransfer.setData('application/x-screenlab-layer', edge.id); event.dataTransfer.effectAllowed = 'move'; };
        row.ondragover = event => { event.preventDefault(); row.classList.add('drop-target'); };
        row.ondragleave = () => row.classList.remove('drop-target');
        row.ondrop = event => {
          event.preventDefault(); row.classList.remove('drop-target');
          const id = event.dataTransfer.getData('application/x-screenlab-layer');
          if (id && id !== edge.id) { Graph.moveImageLayer(graph, n, id, edges.length - index - 1); edited([n.id]); }
        };
        list.append(row);
      });
      const empty = UI.el('div', 'image-input-row image-input-empty');
      empty.append(makePort(n, 'in', 'images:new', '添加图层', 'image'), UI.el('span', 'image-input-label', `第 ${edges.length + 1} 层 · 拖线到这里`));
      list.append(empty);
      host.append(list);
    }
    function variableSortHandle(n, variable, row, wholeRow = false) {
      const format = 'application/x-screenlab-variable';
      const handle = UI.el('span', 'variable-sort-handle'); handle.append(UI.icon('GripVertical'));
      handle.title = '拖动调整入参顺序'; handle.setAttribute('aria-label', handle.title);
      const source = wholeRow ? row : handle; source.draggable = true;
      // Canvas rows open their popup on click so pointerdown can begin a native drag.
      source.onpointerdown = event => event.stopPropagation();
      if (wholeRow) {
        row.classList.add('variable-sort-row'); row.title = handle.title;
        row.onclick = event => {
          if (event.target.closest('button,input,select,textarea')) return;
          event.stopPropagation(); selectNode(n.id, event.ctrlKey || event.metaKey); openPanel(n);
        };
      }
      source.ondragstart = event => {
        if (event.target.closest('button,input,select,textarea')) { event.preventDefault(); return; }
        event.stopPropagation(); event.dataTransfer.setData(format, variable.variableId); event.dataTransfer.effectAllowed = 'move';
      };
      const clear = () => row.classList.remove('variable-drop-before', 'variable-drop-after');
      const after = event => { const rect = row.getBoundingClientRect(); return event.clientY > rect.top + rect.height / 2; };
      row.ondragover = event => {
        if (!event.dataTransfer.types.includes(format)) return;
        event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = 'move';
        row.classList.toggle('variable-drop-before', !after(event)); row.classList.toggle('variable-drop-after', after(event));
      };
      row.ondragleave = event => { if (!row.contains(event.relatedTarget)) clear(); };
      source.ondragend = () => {
        for (const target of row.parentElement.querySelectorAll('.variable-drop-before,.variable-drop-after')) target.classList.remove('variable-drop-before', 'variable-drop-after');
      };
      row.ondrop = event => {
        const id = event.dataTransfer.getData(format); clear();
        if (!id) return;
        event.preventDefault(); event.stopPropagation();
        if (id === variable.variableId) return;
        Graph.moveVariable(graph, id, variable.variableId, after(event));
        // Presentation order does not invalidate image results.
        save(); render();
        if (popupNode === n.id) { const host = popup.querySelector('.popup-parameters'); host.replaceChildren(); inputPanel(n, host); }
      };
      return handle;
    }
    function nodeCard(n) {
      const card = UI.el('article', `node node-${n.type}${selected.has(n.id) ? ' selected' : ''}`); card.dataset.node = n.id; card.style.left = `${n.x}px`; card.style.top = `${n.y}px`; card.style.setProperty('--node-color', Graph.types[n.type].color);
      const title = UI.el('header', 'node-title'); title.append(UI.icon(Graph.types[n.type].icon), UI.el('span', '', n.name));
      if (n.type === 'output') title.append(UI.el('small', 'output-size', '预估大小：等待预览'));
      if (n.type === 'denoise' || Graph.requiresGPU(n)) title.append(UI.el('small', `device${Graph.requiresGPU(n) && !navigator.gpu ? ' danger' : ''}`, n.type === 'denoise' && !navigator.gpu ? 'CPU' : !navigator.gpu ? '需要 WebGPU' : 'GPU'));
      title.onpointerdown = event => startNodeMove(event, n);
      card.append(title); const ports = UI.el('div', 'ports');
      if (Graph.multipleImages(n)) {
        const inputs = UI.el('div', 'node-image-inputs'); imageInputControls(n, inputs); ports.append(inputs);
      } else for (const key of Graph.inputs(n)) ports.append(portRow(n, 'in', key, '图像', 'image'));
      if (n.type !== 'output') ports.append(portRow(n, 'out', 'image', '图像', 'image'));
      if (n.type === 'input') {
        for (const v of graph.exposedVars) {
          const row = portRow(n, 'out', v.variableId, v.displayName, v.spec.type, v.defaultValue);
          row.prepend(variableSortHandle(n, v, row, true));
          row.querySelector('.port-label').ondblclick = event => { event.stopPropagation(); UI.rename(row.querySelector('.port-label'), v.displayName, value => { v.displayName = value; edited(); }); };
          ports.append(row);
        }
      } else if (n.type === 'output') {
        ports.append(UI.label('保存方式', UI.select([['overwrite', '原地保存'], ['directory', '指定目录保存']], n.outputMode, value => { n.outputMode = value; edited([n.id]); if (popupNode === n.id) openPanel(n); })));
        outputControls(n, ports);
        directoryControls(n, ports);
      } else {
        const params = Graph.params(graph, n);
        for (const spec of Graph.specs(n)) {
          const value = params[spec.key];
          const label = spec.editor === 'resize' ? `${value[value.axis]}${value.unit === 'percent' ? '%' : ' px'} · ${value.axis === 'width' ? '宽' : '高'}` : spec.labels?.[value] || value;
          if (n.type === 'composite' && spec.key === 'mode') {
            const row = UI.el('div', 'composite-mode-row');
            row.append(UI.el('span', 'composite-mode-label', '混合模式'));
            row.append(UI.parameter(spec, value, next => edited(Graph.setParam(graph, n, spec.key, next))));
            ports.append(row);
          } else {
            ports.append(portRow(n, 'in', spec.key, spec.label || spec.key, spec.type, label));
          }
        }
      }
      card.append(ports);
      if (previewState.enabled) { const previewHost = UI.el('div', 'node-preview'); previewHost.dataset.preview = n.id; card.append(previewHost); }
      card.onpointerdown = event => {
        if (event.target.closest('button,input,select,textarea,.node-title,.node-preview')) return;
        event.stopPropagation(); selectNode(n.id, event.ctrlKey || event.metaKey); openPanel(n);
      };
      card.oncontextmenu = event => { event.preventDefault(); event.stopPropagation(); if (!selected.has(n.id)) { selected.clear(); selected.add(n.id); updateSelection(); } showContext(event); };
      nodeElements.set(n.id, card); return card;
    }
    function render() {
      if (popupNode && !graph.nodes[popupNode]) closePanel();
      // Keep attached viewports across card rebuilds, including captured drag events.
      nodeElements.clear(); nodeHost.replaceChildren(...Object.values(graph.nodes).map(nodeCard)); applyView();
      for (const [id, entry] of nodePreviews) {
        if (previewState.enabled && graph.nodes[id]) nodeElements.get(id).querySelector('.node-preview').replaceWith(entry.element);
        else { resize.unobserve(entry.element); entry.handle.destroy(); nodePreviews.delete(id); }
      }
      if (previewState.enabled) for (const [id, card] of nodeElements) {
        if (nodePreviews.has(id)) continue;
        const element = card.querySelector('.node-preview'), handle = preview.attach(element, { node: true });
        handle.freeze(!!popupNode); nodePreviews.set(id, { element, handle }); resize.observe(element);
      }
      preview.refresh();
      const validity = Graph.validate(graph); validationLabel.textContent = validity.valid ? '合法' : validity.errors.join('；'); validationLabel.className = `editor-status ${validity.valid ? 'valid' : 'invalid'}`;
      stats.replaceChildren(UI.el('span', '', `${Object.keys(graph.nodes).length} 个节点`), UI.el('span', '', `${graph.edges.length} 条连线`));
      updateTrialButton();
      paintPreviews();
    }
    function selectNode(id, append) { if (append) selected.has(id) ? selected.delete(id) : selected.add(id); else if (!selected.has(id)) { selected.clear(); selected.add(id); } updateSelection(); }
    function beginGesture(move, finish) {
      gesture?.abort(); gesture = new AbortController(); const signal = gesture.signal;
      window.addEventListener('pointermove', move, { signal });
      const end = event => { gesture.abort(); gesture = null; finish(event); };
      window.addEventListener('pointerup', end, { once: true, signal });
      window.addEventListener('pointercancel', end, { once: true, signal });
    }
    function startNodeMove(event, n) {
      if (event.button === 1 || (event.button === 0 && space)) { startPan(event); return; }
      if (event.button !== 0) return;
      event.preventDefault(); event.stopPropagation(); selectNode(n.id, event.ctrlKey || event.metaKey);
      if (event.ctrlKey || event.metaKey) return;
      const origin = world(local(event)), positions = [...selected].filter(id => graph.nodes[id]).map(id => ({ id, x: graph.nodes[id].x, y: graph.nodes[id].y })); let moved = false;
      beginGesture(e => {
        const point = world(local(e)), dx = point.x - origin.x, dy = point.y - origin.y;
        if (Math.hypot(dx, dy) * view.zoom > 3) moved = true;
        if (!moved) return;
        for (const p of positions) { graph.nodes[p.id].x = p.x + dx; graph.nodes[p.id].y = p.y + dy; const card = nodeElements.get(p.id); card.style.left = `${p.x + dx}px`; card.style.top = `${p.y + dy}px`; }
        drawEdges();
      }, () => { if (moved) save(); else openPanel(n); });
    }
    function startPan(event) {
      event.preventDefault(); event.stopPropagation(); const origin = local(event), before = { ...view }; root.classList.add('panning');
      beginGesture(e => { const point = local(e); view.x = before.x + point.x - origin.x; view.y = before.y + point.y - origin.y; applyView(); }, () => { root.classList.remove('panning'); save(); });
    }
    function startBox(event) {
      event.preventDefault(); const start = local(event), box = UI.el('div', 'selection-box'); root.append(box); let moved = false;
      if (!event.ctrlKey && !event.metaKey) selected.clear();
      const before = new Set(selected);
      beginGesture(e => {
        const point = local(e), left = Math.min(start.x, point.x), top = Math.min(start.y, point.y), width = Math.abs(point.x - start.x), height = Math.abs(point.y - start.y);
        if (width + height > 4) moved = true;
        Object.assign(box.style, { left: `${left}px`, top: `${top}px`, width: `${width}px`, height: `${height}px` });
        selected.clear(); for (const id of before) selected.add(id);
        for (const [id, card] of nodeElements) { const n = graph.nodes[id], x = view.x + (n.x + card.offsetWidth / 2) * view.zoom, y = view.y + (n.y + card.offsetHeight / 2) * view.zoom; if (x >= left && x <= left + width && y >= top && y <= top + height) selected.add(id); }
        updateSelection();
      }, () => { box.remove(); updateSelection(); if (!moved) closePanel(); });
    }
    function wirePair(start, target) {
      if (start.direction === target.direction) return null;
      return start.direction === 'out' ? { from: { nodeId: start.nodeId, port: start.port }, to: { nodeId: target.nodeId, port: target.port } } : { from: { nodeId: target.nodeId, port: target.port }, to: { nodeId: start.nodeId, port: start.port } };
    }
    function startWire(event, nodeId, direction, key) {
      if (event.button !== 0) return; event.preventDefault(); event.stopPropagation();
      draft = { nodeId, direction, port: key, point: local(event) };
      for (const dot of nodeHost.querySelectorAll('.port')) {
        const pair = wirePair(draft, { nodeId: dot.dataset.node, direction: dot.dataset.direction, port: dot.dataset.port });
        if (pair && Graph.compatible(graph, pair.from, pair.to)) dot.classList.add('compatible');
      }
      drawEdges();
      beginGesture(e => { draft.point = local(e); drawEdges(); }, event => {
        const start = draft; draft = null;
        for (const dot of nodeHost.querySelectorAll('.compatible')) dot.classList.remove('compatible');
        const under = document.elementFromPoint(event.clientX, event.clientY), dot = under?.closest('.port'), input = under?.closest('.node-input');
        UI.run(() => {
          let affected;
          if (input && start.direction === 'in' && !Graph.inputs(graph.nodes[start.nodeId]).includes(start.port)) {
            exposeParameter(graph.nodes[start.nodeId], start.port); affected = start.nodeId;
          }
          else if (dot) {
            const pair = wirePair(start, { nodeId: dot.dataset.node, direction: dot.dataset.direction, port: dot.dataset.port });
            if (!pair) throw new Error('请连接输入和输出端口'); Graph.connect(graph, pair.from, pair.to);
            affected = pair.to.nodeId;
          } else { drawEdges(); return; }
          edited([affected]); if (popupNode) openPanel(graph.nodes[popupNode]);
        }); drawEdges();
      });
    }
    function deleteSelected() {
      // Capture downstream nodes before removing the edges that identify them.
      const affected = new Set();
      for (const id of selected) {
        if (graph.nodes[id] && graph.nodes[id].type !== 'input') for (const next of Graph.descendants(graph, id)) affected.add(next);
        const edge = graph.edges.find(e => e.id === id);
        if (edge) affected.add(edge.to.nodeId);
      }
      for (const id of [...selected]) if (graph.edges.some(e => e.id === id)) Graph.removeEdge(graph, id);
      Graph.removeNodes(graph, [...selected].filter(id => graph.nodes[id])); selected.clear(); edited([...affected]);
    }
    function copySelected() {
      const nodes = [...selected].filter(id => graph.nodes[id] && graph.nodes[id].type !== 'input');
      clipboard = { nodes: nodes.map(id => structuredClone(graph.nodes[id])), edges: structuredClone(graph.edges.filter(e => nodes.includes(e.to.nodeId) && (nodes.includes(e.from.nodeId) || e.from.port !== 'image'))),
        vars: structuredClone(graph.exposedVars.filter(v => graph.edges.some(e => e.from.port === v.variableId && nodes.includes(e.to.nodeId)))) };
    }
    function paste() {
      if (!clipboard?.nodes.length) return;
      const ids = new Map(), vars = new Map(); selected.clear();
      for (const n of clipboard.nodes) { const clone = structuredClone(n); clone.id = Store.uuid(); clone.x += 30; clone.y += 30; ids.set(n.id, clone.id); graph.nodes[clone.id] = clone; selected.add(clone.id); n.x += 30; n.y += 30; }
      for (const v of clipboard.vars) { const clone = structuredClone(v); clone.variableId = Store.uuid(); if (ids.has(v.sourceNodeId)) clone.sourceNodeId = ids.get(v.sourceNodeId); vars.set(v.variableId, clone.variableId); graph.exposedVars.push(clone); }
      const inputId = Object.values(graph.nodes).find(n => n.type === 'input').id;
      for (const e of clipboard.edges) graph.edges.push({ id: Store.uuid(), from: { nodeId: ids.get(e.from.nodeId) || inputId, port: vars.get(e.from.port) || e.from.port }, to: { nodeId: ids.get(e.to.nodeId), port: e.to.port } });
      edited([...ids.values()]);
    }
    function addNode(type, point, source) {
      const n = Graph.node(type, point.x, point.y, source); graph.nodes[n.id] = n; selected.clear(); selected.add(n.id); edited([n.id]);
    }
    function addMenu(x, y, point) {
      const addItems = types => types.map(type => ({ icon: Graph.types[type].icon, label: Graph.types[type].name, action: () => addNode(type, point) }));
      const items = [
        ...addItems(['output']),
        { separator: true },
        ...addItems(['denoise', 'spine', 'surface-blur', 'maximum', 'minimum', 'find-edges', 'sharpen', 'curve']),
        { separator: true },
        ...addItems(['resize', 'offset']),
        { separator: true },
        ...addItems(['composite']),
        { separator: true },
        { icon: 'FileCode2', label: '自定义脚本滤镜…', action: () => {
        closePanel();
        scriptEditor = ScriptEditor.open({ onSave: source => { addNode('custom', point, source); closePanel(); }, onClose: closePanel });
        } },
      ];
      UI.menu(x, y, items);
    }
    function showContext(event) {
      const point = world(local(event));
      UI.menu(event.clientX, event.clientY, [
        { icon: 'Plus', label: '添加节点', action: () => addMenu(event.clientX, event.clientY, point) },
        { icon: 'Copy', label: '复制选中节点', disabled: ![...selected].some(id => graph.nodes[id]?.type !== 'input' && graph.nodes[id]), action: () => { copySelected(); paste(); } },
        { icon: 'Unplug', label: '断开选中节点连线', disabled: !selected.size, action: () => {
          const affected = new Set();
          for (const e of [...graph.edges]) if (selected.has(e.from.nodeId) || selected.has(e.to.nodeId)) {
            affected.add(e.to.nodeId); Graph.removeEdge(graph, e.id);
          }
          edited([...affected]);
        } },
        { icon: 'Trash2', label: '删除选中节点', disabled: ![...selected].some(id => graph.nodes[id]?.type !== 'input' && graph.nodes[id]), action: deleteSelected },
      ]);
    }
    function removePanel() {
      scriptEditor?.destroy(); scriptEditor = null;
      clearTimeout(previewTimer); previewRun?.abort(); previewNode = null;
      if (popup) for (const surface of popup.querySelectorAll('.popup-preview')) resize.unobserve(surface);
      for (const v of popupViews) v.destroy(); popupViews = []; popup?.remove(); popup = null; popupNode = null;
      for (const { handle } of nodePreviews.values()) handle.freeze(false);
      previewError = '';
    }
    function closePanel() {
      removePanel();
      preview.refresh(); syncPreviewRegion(); updatePreviewStatus(); paintPreviews(); schedule();
    }
    function openPanel(n) {
      removePanel(); popupNode = n.id; popup = UI.el('aside', 'node-popup');
      for (const { handle } of nodePreviews.values()) handle.freeze(true);
      const header = UI.el('div', 'popup-title'), name = UI.el('input'); name.value = n.name; name.setAttribute('aria-label', '节点名称');
      name.onchange = () => {
        if (!name.value.trim()) return;
        for (const v of graph.exposedVars) if (v.sourceNodeId === n.id && v.displayName === `${n.name}.${v.spec.label}`) v.displayName = `${name.value.trim()}.${v.spec.label}`;
        n.name = name.value.trim(); edited();
      }; header.append(name);
      if (!['input', 'output', 'composite', 'custom'].includes(n.type)) {
        header.append(UI.button('FileCode2', '编辑脚本', event => {
          event.currentTarget.remove(); openScriptPanel(n);
        }));
      }
      header.append(UI.button('X', '关闭参数窗口', closePanel)); popup.append(header);
      const body = UI.el('div', 'popup-body'), parameters = UI.el('div', 'popup-parameters'), views = UI.el('div', 'popup-previews');
      popup.append(body); body.append(parameters, views);
      if (preview.image) {
        for (const [mode, label] of [['input', '输入'], ['output', '结果']]) {
          const side = UI.el('div', 'popup-preview-pane'), surface = UI.el('div', 'popup-preview'); side.append(UI.el('div', 'preview-label', label), surface); views.append(side);
          const handle = preview.attach(surface); handle.mode = mode; popupViews.push(handle);
          resize.observe(surface);
        }
      } else views.append(UI.el('p', 'muted', '未选择预览图片'));
      if (n.type === 'input') inputPanel(n, parameters);
      else if (n.type === 'output') {
        parameters.append(UI.label('保存方式', UI.select([['overwrite', '原地保存'], ['directory', '指定目录保存']], n.outputMode, value => { n.outputMode = value; edited([n.id]); openPanel(n); })));
        outputControls(n, parameters);
        if (n.outputMode === 'directory') directoryControls(n, parameters, true);
      } else if (n.type === 'custom') {
        parameters.classList.add('custom-node-parameters');
        for (const spec of Graph.specs(n)) parameterPanel(n, spec, parameters);
      } else for (const spec of Graph.specs(n)) parameterPanel(n, spec, parameters);
      if (Graph.multipleImages(n)) imageInputControls(n, parameters);
      if (n.type === 'custom') openScriptPanel(n);
      else document.body.append(popup);
      preview.refresh(); syncPreviewRegion(); paintPreviews(); schedule(); updatePreviewStatus();
    }
    function openScriptPanel(n) {
      popup.className = 'script-node-panel';
      popup.querySelector('.popup-parameters').classList.add('custom-node-parameters');
      popup.querySelector('.popup-body').prepend(popup.querySelector('.popup-previews'));
      scriptEditor = ScriptEditor.open({ source: Graph.scriptSource(n), nodePanel: popup,
        onSave: source => { const affected = Graph.updateScript(graph, n, source); if (affected) edited(affected); closePanel(); }, onClose: closePanel });
      popup.parentElement.addEventListener('toggle', () => { preview.refresh(); paintPreviews(); });
      preview.refresh(); paintPreviews(); schedule();
    }
    function refreshParameters(n, host) {
      host.replaceChildren();
      for (const spec of Graph.specs(n)) parameterPanel(n, spec, host);
    }
    function parameterPanel(n, spec, host) {
      const row = UI.el('div', 'popup-param'), heading = UI.el('div', 'param-heading');
      const label = UI.el('span'); label.append(makePort(n, 'in', spec.key, spec.label || spec.key, spec.type), document.createTextNode(spec.label || spec.key));
      const edge = graph.edges.find(e => e.to.nodeId === n.id && e.to.port === spec.key);
      const expose = UI.button(edge ? 'Unlink' : 'Link', edge ? '取消暴露' : '暴露到输入节点', () => {
        if (edge) Graph.removeEdge(graph, edge.id); else exposeParameter(n, spec.key); edited([n.id]);
        if (scriptEditor) {
          refreshParameters(n, host);
        } else openPanel(n);
      });
      if (edge) expose.classList.add('active'); heading.append(label, expose); row.append(heading);
      const values = Graph.params(graph, n);
      if (spec.type === 'directory') values[spec.key] = directoryValue(n);
      const incoming = graph.edges.find(e => e.to.nodeId === n.id && e.to.port === 'image');
      const image = spec.editor === 'resize' && incoming ? Graph.imageSize(graph, incoming.from.nodeId, preview.image) : null;
      row.append(UI.parameter(spec, values[spec.key], value => {
        const affected = Graph.setParam(graph, n, spec.key, value); edited(affected);
        if (spec.type === 'directory') openPanel(n);
        if (Graph.specs(n).some(current => current.integerWhen?.key === spec.key)) {
          refreshParameters(n, host);
        }
      }, { sliders: true, params: values, image })); host.append(row);
    }
    function inputPanel(n, host) {
      host.append(UI.el('p', 'muted', '图片集资产输入'));
      for (const v of graph.exposedVars) {
        const block = UI.el('div', 'input-variable'), header = UI.el('div', 'variable-heading'), name = UI.el('input'); name.value = v.displayName; name.setAttribute('aria-label', '变量名称');
        header.append(variableSortHandle(n, v, block));
        name.onchange = () => { if (name.value.trim()) { v.displayName = name.value.trim(); edited(); } };
        header.append(name, UI.button('Trash2', '删除输入变量', () => {
          const affected = graph.edges.filter(e => e.from.port === v.variableId).map(e => e.to.nodeId);
          for (const e of [...graph.edges]) if (e.from.port === v.variableId) Graph.removeEdge(graph, e.id);
          graph.exposedVars = graph.exposedVars.filter(a => a.variableId !== v.variableId); edited(affected); openPanel(n);
        })); block.append(header, UI.parameter(v.spec, v.defaultValue, value => {
          edited(Graph.setVariable(graph, v.variableId, value));
          if (v.spec.type === 'directory') openPanel(n);
        }, { sliders: true, image: resizeInputSize(v) })); host.append(block);
      }
      host.append(UI.button('Plus', '添加输入参数', () => {
        const form = UI.el('div', 'input-variable'), name = UI.el('input'); name.value = '自定义参数'; name.setAttribute('aria-label', '输入参数名称');
        const type = UI.select([['number', '数字'], ['integer', '整数'], ['boolean', '布尔'], ['enum', '枚举'], ['string', '文本'], ['json', 'JSON']], 'number', () => {}), choices = UI.el('input'); choices.placeholder = '枚举选项，以逗号分隔'; choices.setAttribute('aria-label', '枚举选项');
        form.append(UI.label('参数名', name), UI.label('类型', type), UI.label('枚举选项', choices), UI.button('Check', '创建参数', () => {
          const spec = { key: Store.uuid(), label: name.value.trim(), type: type.value };
          if (!spec.label) throw new Error('请填写参数名');
          if (spec.type === 'enum') { spec.values = choices.value.split(',').map(s => s.trim()).filter(Boolean); if (!spec.values.length) throw new Error('请填写枚举选项'); }
          const defaultValue = ['number', 'integer'].includes(spec.type) ? 0 : spec.type === 'boolean' ? false : spec.type === 'json' ? {} : spec.type === 'enum' ? spec.values[0] : '';
          graph.exposedVars.push({ variableId: Store.uuid(), displayName: spec.label, defaultValue, spec, manual: true }); edited(); openPanel(n);
        }, '创建')); host.append(form);
      }, '添加自定义参数'));
    }
    function resizeInputSize(variable) {
      if (variable.spec.editor !== 'resize' || !variable.sourceNodeId) return null;
      const edge = graph.edges.find(e => e.to.nodeId === variable.sourceNodeId && e.to.port === 'image');
      return edge ? Graph.imageSize(graph, edge.from.nodeId, preview.image) : null;
    }
    function previewContext() { return popupNode ? panelPreview : canvasPreview; }
    function syncPreviewRegion() {
      const context = previewContext();
      if (context.image === preview.image && JSON.stringify(context.roi) === JSON.stringify(preview.roi)) {
        paintPreviews(); return;
      }
      context.image = preview.image; context.roi = preview.roi;
      context.cache.clear(); resetPreview();
    }
    function resetPreview(ids) {
      const interrupted = previewNode;
      previewRun?.abort(); previewNode = null;
      previewError = '';
      if (interrupted) paintNodePreview(interrupted);
      paintPreviews(ids); schedule();
    }
    function invalidate(ids) {
      if (!ids.length) return;
      const affected = new Set();
      for (const id of ids) for (const downstream of Graph.descendants(graph, id)) affected.add(downstream);
      for (const context of [canvasPreview, panelPreview]) for (const id of affected) context.cache.delete(id);
      resetPreview(affected);
    }
    function schedule() { clearTimeout(previewTimer); if (trialRun || !preview.image || (!previewState.enabled && !popupNode)) return; previewTimer = setTimeout(calculate, 200); }
    function popupTarget() {
      if (graph.nodes[popupNode].type !== 'input') return popupNode;
      // Editing pipeline inputs must show the processed output, not the unchanged source.
      return Object.values(graph.nodes).find(n => n.type === 'output' && Graph.validate(graph, [n.id]).valid)?.id || popupNode;
    }
    async function calculate() {
      previewRun?.abort(); const controller = new AbortController(); previewRun = controller;
      previewError = ''; previewNode = null;
      try {
        const { cache } = previewContext();
        const source = preview.crop(); updatePreviewStatus(); if (!source) { paintPreviews(); return; }
        // The panel takes priority; only its target and required upstream nodes run.
        const targets = popupNode ? [popupTarget()] : Object.keys(graph.nodes).filter(id => Graph.validate(graph, [id]).valid);
        if (!targets.length) return;
        const outputs = targets.filter(id => graph.nodes[id].type === 'output');
        const outputPath = Graph.ancestors(graph, outputs);
        // Finish output paths before draft branches can occupy the serial Worker queue.
        // Pick each group's executor separately so draft geometry does not affect output previews.
        const groups = popupNode || !outputs.length ? [targets] : [outputs, targets.filter(id => !outputPath.has(id))];
        const callbacks = { onNode: async n => {
          if (controller.signal.aborted) return;
          previewNode = null;
          paintNodePreview(n.id); paintPopupPreviews(); await paintFrame(controller.signal);
        }, onProgress: (n, value) => {
          if (controller.signal.aborted) return;
          previewNode = n.id; previewProgress = value;
          paintNodePreview(n.id); paintPopupPreviews();
        } };
        for (const group of groups) {
          if (!group.length) continue;
          const spatial = [...Graph.ancestors(graph, group)].some(id => ['offset', 'composite'].includes(Graph.geometry(graph.nodes[id])));
          const executor = spatial ? SpatialPreview : Engine;
          await executor.execute(graph, spatial ? preview.image : source, { roi: preview.roi, targets: group, cache,
            signal: controller.signal, ...callbacks });
        }
        // Cache hits skip onNode, so the panel still needs a final paint.
        if (!controller.signal.aborted) paintPreviews();
      } catch (error) {
        if (error.name !== 'AbortError' && !controller.signal.aborted) {
          previewError = `预览失败：${error.message}`; updatePreviewStatus(); paintPreviews(); UI.toast(previewError, 'error');
        }
      } finally {
        if (previewRun === controller) {
          previewNode = null; paintPreviews();
        }
      }
    }
    function paintNodePreview(id) {
      paintOutputEstimate(id);
      if (popupNode) return;
      const entry = nodePreviews.get(id); if (!entry) return;
      const { element: host, handle } = entry;
      const result = preview.roi ? canvasPreview.cache.get(id) : null, connected = Graph.validate(graph, [id]).valid;
      host.classList.toggle('loading', !result && previewNode === id && !!preview.image && !!preview.roi && connected && !previewError && !trialRun);
      handle.set(result, previewMessage(id, result, connected ? '' : '未连接'),
        previewNode === id && !previewError && !trialRun ? previewProgress : null);
    }
    function paintPopupPreviews() {
      if (popupNode) {
        const node = graph.nodes[popupNode], incoming = graph.edges.find(e => e.to.nodeId === popupNode && Graph.inputs(node).includes(e.to.port));
        const validation = Graph.validate(graph, [popupTarget()]);
        for (const handle of popupViews) {
          const id = handle.mode === 'output' ? popupTarget() : node.type === 'input' ? popupNode : incoming?.from.nodeId;
          const result = preview.roi ? panelPreview.cache.get(id) : null;
          const message = previewMessage(id, result, validation.valid ? '' : `无法预览：${validation.errors.join('；')}`);
          handle.set(result, message, previewNode === id && !previewError && !trialRun ? previewProgress : null);
        }
      }
    }
    function paintPreviews(ids = nodeElements.keys()) {
      for (const id of ids) paintNodePreview(id);
      paintPopupPreviews();
    }
    listen(root, 'pointerdown', event => {
      if (event.button === 1 || (event.button === 0 && space)) { startPan(event); return; }
      if (event.button !== 0 || event.target.closest('.node') || event.target.closest('.edge-hit')) return; startBox(event);
    });
    listen(root, 'wheel', e => { e.preventDefault(); zoomTo(view.zoom * (e.deltaY < 0 ? 1.1 : 1 / 1.1), local(e)); }, { passive: false });
    listen(root, 'contextmenu', e => { if (e.defaultPrevented) return; e.preventDefault(); showContext(e); });
    listen(document, 'keydown', e => {
      if (e.key === 'Escape') { gesture?.abort(); gesture = null; draft = null; closePanel(); UI.closeMenu(); root.querySelector('.selection-box')?.remove(); root.classList.remove('panning'); drawEdges(); return; }
      if (e.target.closest('input,textarea,select,[contenteditable=true],.curve-canvas')) return;
      if (e.code === 'Space') { e.preventDefault(); space = true; }
      const ctrl = e.ctrlKey || e.metaKey;
      if (ctrl && e.key.toLowerCase() === 'a') { e.preventDefault(); selected.clear(); for (const id of Object.keys(graph.nodes)) selected.add(id); updateSelection(); }
      if (ctrl && e.key.toLowerCase() === 'c') { e.preventDefault(); copySelected(); }
      if (ctrl && e.key.toLowerCase() === 'v') { e.preventDefault(); paste(); }
      if (ctrl && e.key.toLowerCase() === 'd') { e.preventDefault(); copySelected(); paste(); }
      if (ctrl && e.key.toLowerCase() === 'e') { e.preventDefault(); Graph.exportDefinition(pipeline); }
      if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); deleteSelected(); }
    });
    listen(document, 'keyup', e => { if (e.code === 'Space') space = false; });
    listen(window, 'blur', () => { space = false; });
    const resize = new ResizeObserver(() => { drawEdges(); preview.refresh(); }); resize.observe(root);
    session = { destroy() { events.abort(); gesture?.abort(); resize.disconnect(); closePanel(); clearTimeout(previewTimer); previewRun?.abort(); trialRun?.abort(); preview.destroy(); UI.closeMenu(); } };
    render();
    if (!graph.view) requestAnimationFrame(() => { if (!events.signal.aborted) fit(); });
    const source = Assets.previews.get(pipeline.id);
    if (source) {
      previewFileType = source.type;
      sourceName.textContent = `${source.name} · ${source.image.width} × ${source.image.height}`;
      preview.load(source.image, previewState); updateTrialButton();
    } else {
      const version = previewSourceVersion;
      UI.run(async () => {
        const file = await EditorState.file(pipeline.id);
        if (events.signal.aborted || version !== previewSourceVersion) return;
        if (file) await loadPreview(file, {}, false);
        else sourceName.textContent = previewState.name ? `${previewState.name} · 需重新选择` : '未选择';
      });
    }
  }
  function destroy() { session?.destroy(); session = null; }
  return { init, destroy };
})();
