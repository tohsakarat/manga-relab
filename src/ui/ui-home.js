'use strict';
const Home = (() => {
  let host, openEditor, expandedSet = null, unsubscribe;
  const expandedTasks = new Set();
  let draggedFile = null;
  function invalidateReference(field, id) {
    for (const task of Store.tasksUsing(field, id)) if (!Tasks.isRunning(task.id)) Store.resetTask(task.id);
  }
  function busyReference(field, id) { return Store.tasksUsing(field, id).some(task => Tasks.isRunning(task.id)); }
  function column(title, iconName, records, actions) {
    const column = UI.el('section', 'home-column'), heading = UI.el('header', 'column-heading'), h = UI.el('h2');
    h.append(UI.icon(iconName), document.createTextNode(title), UI.el('span', 'counter', Object.keys(records).length));
    const controls = UI.el('div', 'column-actions'); controls.append(...actions); heading.append(h, controls);
    const body = UI.el('div', 'column-body'); column.append(heading, body); return { column, body };
  }
  function empty(body, iconName, title) { const row = UI.el('div', 'empty'); row.append(UI.icon(iconName), UI.el('span', '', title)); body.append(row); }
  function title(record, collection, editEvent = 'dblclick') {
    const label = UI.el('div', 'item-name', record.name);
    label.onclick = e => e.stopPropagation();
    label.addEventListener(editEvent, e => { e.stopPropagation(); UI.rename(label, record.name, name => { collection.update(record.id, { name }); render(); }); });
    return label;
  }
  function newRecord(collection, initial, action) {
    const record = action(); render(); const element = host.querySelector(`[data-id="${record.id}"] .item-name`);
    UI.rename(element, initial, name => { collection.update(record.id, { name }); render(); });
  }
  async function reconnectSet(set) {
    const { authorized, changed } = await Assets.reconnect(set);
    if (changed) invalidateReference('imageSetId', set.id);
    render(); UI.toast(`已授权 ${authorized} / ${set.files.length} 张图片`);
  }
  function imageSet(set) {
    const busy = busyReference('imageSetId', set.id);
    const item = UI.el('article', `item${expandedSet === set.id ? ' active' : ''}`); item.dataset.id = set.id;
    const head = UI.el('div', 'item-head'), glyph = UI.el('span', 'item-icon'); glyph.append(UI.icon('Images'));
    const toggle = async () => {
      expandedSet = expandedSet === set.id ? null : set.id; render();
      // Request files from the expand click, not from renders triggered by task updates.
      if (expandedSet === set.id && !busy && Assets.ready(set) < set.files.length) await reconnectSet(set);
    };
    const expand = UI.button(expandedSet === set.id ? 'ChevronUp' : 'ChevronDown', '展开图片集', toggle);
    head.append(glyph, title(set, Store.imageSets), expand); head.onclick = () => UI.run(toggle); item.append(head);
    const info = UI.el('div', 'item-details'); info.append(UI.el('span', '', `${set.files.length} 张`), UI.el('span', '', `${Assets.ready(set)} 张已授权`)); item.append(info);
    if (expandedSet === set.id) {
      const body = UI.el('div', 'item-expanded'), list = UI.el('ul', 'file-list');
      for (const f of set.files) {
        const row = UI.el('li', 'file-card'); row.draggable = !busy; row.title = f.path || f.name;
        const thumbnail = UI.el('div', 'file-thumbnail'), url = Assets.previewURL(f.id);
        if (url) {
          const image = UI.el('img'); image.alt = f.name; image.loading = 'lazy'; image.decoding = 'async'; image.draggable = false; image.src = url;
          thumbnail.append(image);
        } else {
          thumbnail.append(UI.icon('Image'), UI.el('span', '', '待授权'));
        }
        const caption = UI.el('div', 'file-caption'), details = UI.el('div', 'file-meta');
        const state = UI.el('span', `file-state${url ? ' ready' : ''}`); state.title = url ? '已授权' : '待授权';
        details.append(state, UI.el('span', 'size', `${(f.size / 1048576).toFixed(1)} MB`));
        caption.append(UI.el('span', 'path', f.name), details); row.append(thumbnail, caption);
        const remove = UI.button('X', '移除图片', () => { invalidateReference('imageSetId', set.id); set.files = set.files.filter(a => a.id !== f.id); Assets.remove(f.id); Store.persist(); render(); }); remove.disabled = busy; remove.classList.add('file-remove'); row.append(remove);
        row.ondragstart = e => { draggedFile = f.id; e.dataTransfer.effectAllowed = 'move'; };
        row.ondragover = e => { e.preventDefault(); row.classList.add('drag-over'); };
        row.ondragleave = () => row.classList.remove('drag-over');
        row.ondrop = e => {
          e.preventDefault(); if (busy) return;
          const from = set.files.findIndex(a => a.id === draggedFile), to = set.files.indexOf(f); if (from < 0 || from === to) return;
          const [moved] = set.files.splice(from, 1); set.files.splice(to, 0, moved);
          invalidateReference('imageSetId', set.id); Store.persist(); render();
        };
        list.append(row);
      }
      body.append(list);
      const actions = UI.el('div', 'row-actions set-actions');
      for (const [name, label, folder] of [['ImagePlus', '添加图片', false], ['FolderPlus', '导入文件夹', true]]) {
        const b = UI.button(name, label, async () => { const { changed } = await Assets.add(set, folder); if (changed) invalidateReference('imageSetId', set.id); render(); }, label); b.disabled = busy; actions.append(b);
      }
      const auth = UI.button('FolderOpen', '选择目录授权图片', () => reconnectSet(set), '重新授权'); auth.disabled = busy;
      actions.append(auth); body.append(actions); item.append(body);
    }
    const tools = UI.el('div', 'item-tools');
    const rename = UI.button('Pencil', '重命名图片集', () => UI.rename(item.querySelector('.item-name'), set.name, name => { Store.imageSets.update(set.id, { name }); render(); }));
    const remove = UI.button('Trash2', '删除图片集', async () => {
      const count = Store.tasksUsing('imageSetId', set.id).length;
      if (!confirm(`删除“${set.name}”？${count ? `有 ${count} 个任务引用此图片集。` : ''}`)) return;
      for (const f of set.files) Assets.remove(f.id); Store.imageSets.remove(set.id); render();
      await AssetLocations.remove(set.id);
    }); remove.disabled = busy;
    const clear = UI.button('ListX', '清空图片集', () => { if (!confirm('清空该图片集的路径列表？')) return; for (const f of set.files) Assets.remove(f.id); set.files = []; invalidateReference('imageSetId', set.id); Store.persist(); render(); }); clear.disabled = busy;
    tools.append(rename, UI.el('span', 'row-actions')); tools.lastChild.append(clear, remove); item.append(tools); return item;
  }
  function pipelineItem(pipeline) {
    const item = UI.el('article', 'item'); item.dataset.id = pipeline.id;
    const head = UI.el('div', 'item-head'), glyph = UI.el('span', 'item-icon pipeline'); glyph.append(UI.icon('Workflow'));
    head.append(glyph, title(pipeline, Store.pipelines, 'click')); item.append(head);
    const validation = Graph.validate(pipeline.graph), info = UI.el('div', 'item-details');
    info.append(UI.el('span', '', `${Object.keys(pipeline.graph.nodes).length} 个节点`), UI.el('span', validation.valid ? '' : 'danger', validation.valid ? '已连接' : '待连接'), UI.el('span', '', new Date(pipeline.updatedAt).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })));
    item.append(info);
    const tools = UI.el('div', 'item-tools'), edit = UI.button('Pencil', '编辑流水线', () => openEditor(pipeline), '编辑'); edit.classList.add('primary');
    const actions = UI.el('div', 'row-actions'); actions.append(
      UI.button('Copy', '复制流水线', () => { Store.pipelines.create(`${pipeline.name}（副本）`, structuredClone(pipeline.graph)); render(); }),
      UI.button('Download', '导出流水线', () => Graph.exportDefinition(pipeline)),
      UI.button('Trash2', '删除流水线', async () => { const count = Store.tasksUsing('pipelineId', pipeline.id).length; if (confirm(`删除“${pipeline.name}”？${count ? `有 ${count} 个任务引用此流水线。` : ''}`)) { await Store.pipelines.remove(pipeline.id); Assets.previews.delete(pipeline.id); render(); } }),
    ); actions.lastChild.disabled = busyReference('pipelineId', pipeline.id); tools.append(edit, actions); item.append(tools); return item;
  }
  const statusNames = { idle: '未开始', running: '运行中', pausing: '正在暂停', paused: '已暂停', completed: '已完成', error: '出错' };
  function taskItem(task) {
    const item = UI.el('article', 'item'); item.dataset.id = task.id;
    const head = UI.el('div', 'item-head'), glyph = UI.el('span', 'item-icon'); glyph.append(UI.icon('ListVideo'));
    const status = UI.el('span', `status ${task.status}`, statusNames[task.status]); status.dataset.taskStatus = task.id;
    head.append(glyph, title(task, Store.tasks), status, UI.button(expandedTasks.has(task.id) ? 'ChevronUp' : 'ChevronDown', '展开任务参数', () => { expandedTasks.has(task.id) ? expandedTasks.delete(task.id) : expandedTasks.add(task.id); render(); }));
    item.append(head);
    const info = UI.el('div', 'item-details'); info.append(UI.el('span', '', Store.imageSets.get(task.imageSetId)?.name || '未选图片集'), UI.el('span', '', '→'), UI.el('span', '', Store.pipelines.get(task.pipelineId)?.name || '未选流水线')); item.append(info);
    const progress = UI.el('div', 'task-progress'); progress.dataset.taskProgress = task.id;
    const top = UI.el('div', 'progress-top'); top.append(UI.el('span', 'count'), UI.el('span', 'time'));
    const track = UI.el('div', 'progress-track'); track.append(UI.el('div', 'progress-fill'));
    progress.append(top, track, UI.el('div', 'task-line')); item.append(progress);
    const running = Tasks.isRunning(task.id);
    if (expandedTasks.has(task.id)) {
      const details = UI.el('div', 'item-expanded');
      const setChoice = UI.select([['', '选择图片集'], ...Object.values(Store.imageSets.all()).map(set => [set.id, set.name])], task.imageSetId, value => { Store.resetTask(task.id); Store.tasks.update(task.id, { imageSetId: value || null }); render(); }); setChoice.disabled = running;
      const pipeChoice = UI.select([['', '选择流水线'], ...Object.values(Store.pipelines.all()).map(p => [p.id, p.name])], task.pipelineId, value => { Store.resetTask(task.id); Store.tasks.update(task.id, { pipelineId: value || null, params: {} }); render(); }); pipeChoice.disabled = running;
      const sourceRow = UI.el('div', 'field-grid');
      sourceRow.append(UI.label('输入图片集', setChoice), UI.label('流水线', pipeChoice));
      details.append(sourceRow);
      const pipeline = Store.pipelines.get(task.pipelineId);
      if (pipeline) {
        const params = UI.el('div', 'task-parameters');
        for (const v of pipeline.graph.exposedVars) {
          const control = UI.parameter(v.spec, Object.hasOwn(task.params, v.variableId) ? task.params[v.variableId] : v.defaultValue, value => { Store.resetTask(task.id); task.params[v.variableId] = value; Store.persist(); updateProgress(); });
          for (const input of control.querySelectorAll('input,select,textarea,button')) input.disabled = running;
          if (running) control.style.pointerEvents = 'none';
          params.append(UI.label(v.displayName, control));
        }
        details.append(params);
        for (const n of Tasks.outputs(task).filter(n => n.outputMode === 'directory')) {
          if (pipeline.graph.edges.some(e => e.to.nodeId === n.id && e.to.port === 'directory')) continue;
          const dirKey = Tasks.directoryKey(task, n), handle = Assets.directory(Tasks.outputDirectoryKey(task, pipeline.graph, n));
          const directoryName = task.outputDirectories?.[n.id] || Graph.params(pipeline.graph, n).directory.name;
          const b = UI.button('FolderOpen', `${n.name}的输出目录`, async () => {
            const name = await Assets.chooseDirectory(dirKey); task.outputDirectories ||= {}; task.outputDirectories[n.id] = name;
            Store.persist(); render();
          }, `${n.name}：${handle?.name || (directoryName ? `${directoryName} · 重新授权` : '选择目录')}`); b.disabled = running; details.append(b);
        }
      }
      const problem = Tasks.reason(task); if (problem) details.append(UI.el('p', 'danger', problem));
      const errors = UI.el('div', 'error-list'); errors.dataset.taskErrors = task.id; details.append(errors);
      item.append(details);
    }
    const tools = UI.el('div', 'item-tools'), actions = UI.el('div', 'row-actions');
    const start = UI.button(running ? 'Pause' : 'Play', running ? '暂停任务' : '开始任务', async () => { if (running) Tasks.pause(task); else { await Tasks.start(task); if (host) render(); } }, running ? '暂停' : task.status === 'paused' ? '继续' : '开始');
    start.disabled = Tasks.isPreparing(task.id) || task.status === 'pausing' || task.status === 'completed' || (!running && (Tasks.isSequencing() || !!Tasks.reason(task))); start.classList.add('primary'); start.dataset.taskStart = task.id;
    start.dataset.running = String(running);
    start.dataset.preparing = String(Tasks.isPreparing(task.id));
    if (Tasks.isPreparing(task.id)) start.querySelector('span').textContent = '准备中';
    actions.append(UI.button('RotateCcw', '清空进度', () => { if (task.progress.current && !confirm('清空此任务的进度？已保存的图片不会被删除。')) return; Store.resetTask(task.id); render(); })); actions.lastChild.disabled = running;
    actions.append(UI.button('Pencil', '重命名任务', () => UI.rename(item.querySelector('.item-name'), task.name, name => { Store.tasks.update(task.id, { name }); render(); })));
    actions.append(UI.button('Trash2', '删除任务', () => { if (confirm(`删除任务“${task.name}”？`)) { Store.tasks.remove(task.id); render(); } })); actions.lastChild.disabled = running;
    tools.append(start, actions); item.append(tools); return item;
  }
  function updateProgress() {
    if (!host?.isConnected) return;
    const sequence = host.querySelector('[data-task-sequence]');
    if (sequence.dataset.sequencing !== String(Tasks.isSequencing())) { render(); return; }
    sequence.disabled = !Tasks.canStartSequence();
    for (const task of Object.values(Store.tasks.all())) {
      const progress = host.querySelector(`[data-task-progress="${task.id}"]`); if (!progress) continue;
      const total = task.progress.total || Store.imageSets.get(task.imageSetId)?.files.length || 0;
      progress.querySelector('.count').textContent = `${task.progress.current} / ${total}${task.errors.length ? ` · ${task.errors.length} 张失败` : ''}`;
      progress.querySelector('.time').textContent = task.elapsedMs ? `${(task.elapsedMs / 1000).toFixed(1)} s` : '';
      progress.querySelector('.progress-fill').style.width = `${total ? Math.min(100, ((task.progress.current + (task.progress.imageProgress || 0)) / total) * 100) : 0}%`;
      progress.querySelector('.task-line').textContent = task.progress.nodeName ? `${task.progress.currentFileName} · ${task.progress.nodeName} ${Math.round(task.progress.nodeProgress * 100)}%` : task.status === 'completed' ? '处理完成' : task.progress.currentFileName || '';
      const status = host.querySelector(`[data-task-status="${task.id}"]`); status.textContent = statusNames[task.status]; status.className = `status ${task.status}`;
      const errors = host.querySelector(`[data-task-errors="${task.id}"]`); if (errors) errors.replaceChildren(...task.errors.map(e => UI.el('p', '', `${e.name}：${e.message}`)));
      const start = host.querySelector(`[data-task-start="${task.id}"]`);
      if (start && (start.dataset.running !== String(Tasks.isRunning(task.id)) || start.dataset.preparing !== String(Tasks.isPreparing(task.id)) || start.dataset.status !== task.status)) { render(); return; }
    }
  }
  async function importPipeline() {
    const [file] = await UI.pickFiles({ accept: '.json,application/json' }); if (!file) return;
    const data = JSON.parse(await file.text()), graph = Graph.importDefinition(data);
    Store.pipelines.create(data.name || '导入的流水线', graph); render(); UI.toast('已导入流水线');
  }
  function render() {
    if (!host) return;
    const home = UI.el('div', 'home');
    const sets = column('图片集', 'Images', Store.imageSets.all(), [UI.button('Plus', '新建图片集', () => newRecord(Store.imageSets, '未命名图片集', () => { const set = Store.imageSets.create('未命名图片集'); expandedSet = set.id; return set; }))]);
    const pipes = column('流水线', 'Workflow', Store.pipelines.all(), [UI.button('Upload', '导入流水线', importPipeline), UI.button('Plus', '新建流水线', () => newRecord(Store.pipelines, '未命名流水线', () => Store.pipelines.create('未命名流水线', Graph.create())))]);
    const sequence = UI.button('ListVideo', '按列表顺序执行未完成任务', () => Tasks.startSequence(), Tasks.isSequencing() ? '执行中' : '顺序执行');
    sequence.dataset.taskSequence = ''; sequence.dataset.sequencing = String(Tasks.isSequencing());
    sequence.disabled = !Tasks.canStartSequence(); sequence.classList.add('primary');
    const tasks = column('任务', 'ListVideo', Store.tasks.all(), [sequence, UI.button('Plus', '新建任务', () => newRecord(Store.tasks, '未命名任务', () => { const task = Store.tasks.create('未命名任务', null, null); expandedTasks.add(task.id); return task; }))]);
    for (const set of Object.values(Store.imageSets.all())) sets.body.append(imageSet(set));
    for (const p of Object.values(Store.pipelines.all())) pipes.body.append(pipelineItem(p));
    for (const task of Object.values(Store.tasks.all())) tasks.body.append(taskItem(task));
    if (!Object.keys(Store.imageSets.all()).length) empty(sets.body, 'Images', '暂无图片集');
    if (!Object.keys(Store.pipelines.all()).length) empty(pipes.body, 'Workflow', '暂无流水线');
    const preset = UI.button('Workflow', '引入预装的流水线', () => { PreinstalledPipelines.createCopies(); render(); }, '引入预装的流水线'); preset.classList.add('preset-button'); pipes.body.append(preset);
    if (!Object.keys(Store.tasks.all()).length) empty(tasks.body, 'ListVideo', '暂无任务');
    home.append(sets.column, pipes.column, tasks.column); host.replaceChildren(home);
    UI.splitColumns(home, 'home', ['调整图片集与流水线宽度', '调整流水线与任务宽度']);
    for (const task of Object.values(Store.tasks.all())) host.querySelector(`[data-task-start="${task.id}"]`).dataset.status = task.status;
    updateProgress();
  }
  function init(container, edit) { host = container; openEditor = edit; unsubscribe = Tasks.subscribe(updateProgress); render(); }
  function destroy() { unsubscribe?.(); host = null; }
  return { init, destroy, render };
})();
