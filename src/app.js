'use strict';
(() => {
  const app = document.getElementById('app'), navigation = document.getElementById('navigation');
  document.getElementById('github-link').prepend(UI.icon('Github'));
  function home() {
    Editor.destroy(); navigation.replaceChildren(); app.replaceChildren();
    Home.init(app, editor);
  }
  function editor(pipeline) {
    Home.destroy(); app.replaceChildren(); navigation.replaceChildren();
    const back = UI.button('ArrowLeft', '返回入口', home), name = UI.el('span', 'editor-name', pipeline.name);
    name.onclick = () => UI.rename(name, pipeline.name, value => { Store.pipelines.update(pipeline.id, { name: value }); name.textContent = value; });
    navigation.append(back, name, UI.button('Download', '导出流水线', () => Graph.exportDefinition(pipeline)));
    const layout = UI.el('div', 'editor-layout'), canvas = UI.el('section', 'canvas'), sidebar = UI.el('aside', 'editor-sidebar');
    layout.append(canvas, sidebar); app.append(layout);
    UI.splitColumns(layout, 'editor', ['调整画布与详细信息宽度']);
    Editor.init(canvas, sidebar, pipeline, record => {
      Store.pipelines.update(record.id, { graph: record.graph });
    });
  }
  window.addEventListener('storage', e => { if (e.key === 'screenlab-v2') UI.toast('数据在另一个页面中发生变化，请刷新后继续编辑'); });
  window.addEventListener('error', e => { UI.toast(e.message, 'error'); });
  if (Store.isFirstLaunch) PreinstalledPipelines.createCopies();
  Home.init(app, editor);
})();
