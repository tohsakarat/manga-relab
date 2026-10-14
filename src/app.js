'use strict';
(() => {
  const app = document.getElementById('app'), navigation = document.getElementById('navigation');
  document.getElementById('github-link').prepend(UI.icon('Github'));
  async function showGPUInfo() {
    const label = document.getElementById('gpu-info');
    label.title = '点击复制设置地址，粘贴到 Chrome 地址栏，将 Force High Performance GPU 设为 Enabled 并重启 Chrome';
    label.onclick = () => UI.run(async () => {
      await navigator.clipboard.writeText('chrome://flags/#force-high-performance-gpu');
      UI.toast('已复制设置地址，请粘贴到 Chrome 地址栏，将 Force High Performance GPU 设为 Enabled 并重启 Chrome');
    });
    if (!navigator.gpu) {
      label.textContent = 'WebGPU 不可用';
      return;
    }
    // Match the adapter preference used by the built-in GPU filters.
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!adapter) {
      label.textContent = 'GPU 不可用';
      return;
    }
    const { vendor, architecture, device, description } = adapter.info;
    const name = description || [vendor, architecture, device].filter(Boolean).join(' ') || '型号未公开';
    label.textContent = `GPU：${name}`;
    label.title += `\n\nvendor=${vendor}\narchitecture=${architecture}\ndevice=${device}\ndescription=${description}`;
  }
  showGPUInfo();
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
