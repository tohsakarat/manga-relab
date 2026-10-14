/* Small DOM helpers shared by the home, editor, and parameter controls. */
'use strict';
const UI = (() => {
  function el(tag, className = '', text) {
    const element = document.createElement(tag); element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  }
  function icon(name) {
    const [tag, attributes, children] = lucide.icons[name];
    return lucide.createElement([tag, { ...attributes, width: 17, height: 17, 'stroke-width': 1.6, 'aria-hidden': 'true' }, children]);
  }
  function button(name, title, action, text = '') {
    const b = el('button', text ? 'button' : 'icon-button'); b.type = 'button'; b.title = title; b.setAttribute('aria-label', title);
    b.append(icon(name)); if (text) b.append(el('span', '', text));
    b.onclick = event => { event.stopPropagation(); run(() => action(event)); }; return b;
  }
  async function run(action) {
    try { await action(); } catch (error) { if (error.name !== 'AbortError') toast(error.message, 'error'); }
  }
  let toastTimer;
  function toast(text, type = '') {
    const host = document.getElementById('toast');
    host.textContent = text; host.className = `toast ${type}`; host.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(() => { host.hidden = true; }, type === 'error' ? 10000 : 4000);
  }
  function download(blob, name) {
    const url = URL.createObjectURL(blob), a = el('a'); a.href = url; a.download = name; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  function pickFiles({ accept = '', multiple = false, directory = false } = {}) {
    return new Promise(resolve => {
      const input = el('input'); input.type = 'file'; input.accept = accept; input.multiple = multiple;
      if (directory) input.webkitdirectory = true;
      input.hidden = true; document.body.append(input);
      input.onchange = () => { const result = [...input.files]; input.remove(); resolve(result); };
      input.oncancel = () => { input.remove(); resolve([]); };
      input.click();
    });
  }
  function rename(element, value, commit) {
    const input = el('input', 'rename'); input.value = value;
    element.replaceWith(input); input.focus(); input.select(); let done = false;
    function finish(save) {
      if (done) return; done = true;
      if (save && input.value.trim()) run(() => commit(input.value.trim()));
      input.replaceWith(element);
    }
    input.onblur = () => finish(true);
    input.onkeydown = e => { if (e.key === 'Enter') finish(true); if (e.key === 'Escape') finish(false); e.stopPropagation(); };
  }
  function select(options, value, onChange) {
    const input = el('select');
    for (const [v, label] of options) input.add(new Option(label, v));
    input.value = value || ''; input.onchange = () => run(() => onChange(input.value)); return input;
  }
  function label(name, input) { const label = el('label', 'field'); label.append(el('span', 'field-label', name), input); return label; }
  const columnWidths = new Map();
  function splitColumns(layout, key, labels) {
    const panels = [...layout.children];
    function applyWidths(widths) {
      widths.forEach((width, index) => layout.style.setProperty(`--split-${index}`, `${width}fr`));
      columnWidths.set(key, widths);
    }
    if (columnWidths.has(key)) applyWidths(columnWidths.get(key));
    panels.slice(0, -1).forEach((panel, index) => {
      const handle = el('div', 'column-splitter');
      handle.tabIndex = 0; handle.title = labels[index];
      handle.setAttribute('role', 'separator');
      handle.setAttribute('aria-orientation', 'vertical');
      handle.setAttribute('aria-label', labels[index]);
      panel.after(handle);
      let drag;
      function resize(widths, delta) {
        const pairWidth = widths[index] + widths[index + 1];
        // Only redistribute adjacent panels, leaving a visible area on both sides.
        const minimum = Math.min(120, pairWidth / 2);
        const left = Math.max(minimum, Math.min(pairWidth - minimum, widths[index] + delta));
        const next = [...widths]; next[index] = left; next[index + 1] = pairWidth - left;
        applyWidths(next);
      }
      handle.onpointerdown = event => {
        if (event.button !== 0) return;
        event.preventDefault(); handle.focus();
        drag = { x: event.clientX, widths: panels.map(item => item.getBoundingClientRect().width) };
        handle.setPointerCapture(event.pointerId); layout.classList.add('resizing-columns');
      };
      handle.onpointermove = event => {
        if (drag) resize(drag.widths, event.clientX - drag.x);
      };
      handle.onpointerup = event => handle.releasePointerCapture(event.pointerId);
      handle.onlostpointercapture = () => { drag = null; layout.classList.remove('resizing-columns'); };
      handle.onkeydown = event => {
        if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
        event.preventDefault();
        resize(panels.map(item => item.getBoundingClientRect().width), event.key === 'ArrowLeft' ? -10 : 10);
      };
    });
  }
  function paint(canvas, image) {
    canvas.width = image.width; canvas.height = image.height;
    canvas.getContext('2d').putImageData(new ImageData(image.data, image.width, image.height), 0, 0);
  }
  const enums = { center: '中', left: '左', right: '右', top: '上', bottom: '下', unspecified: '不指定' };
  function parameter(spec, value, onChange, { sliders = false, params = {}, image } = {}) {
    if (spec.type === 'json' && spec.editor === 'resize') return ScreenResize.control(value, onChange, image);
    if (spec.integerWhen && params[spec.integerWhen.key] === spec.integerWhen.value) {
      spec = { ...spec, min: Math.ceil(spec.min), step: 1 };
    }
    const host = el('div', 'parameter-control');
    if (spec.type === 'directory') {
      host.classList.add('directory-control');
      const picker = button('FolderOpen', spec.label || '选择输出目录', async () => {
        // Each selection keeps its own handle so running task snapshots retain their destination.
        const key = `directory:${Store.uuid()}`, name = await Assets.chooseDirectory(key);
        value = { key, name }; update(); onChange(value);
      }, '选择目录');
      function update() {
        const handle = Assets.directory(value.key);
        picker.replaceChildren(icon('FolderOpen'), el('span', '', handle?.name || (value.name ? `${value.name} · 重新授权` : '选择目录')));
      }
      update(); host.append(picker); return host;
    }
    if (spec.key === 'points' && spec.type === 'json') {
      host.classList.add('curve-control');
      ScreenCurve.create(host, { initialPoints: value, onChange }); return host;
    }
    let input;
    if (spec.type === 'enum') {
      input = select(spec.values.map(v => [String(v), spec.labels?.[v] || enums[v] || String(v)]), String(value), onChange);
    } else if (spec.type === 'boolean') {
      input = el('input'); input.type = 'checkbox'; input.checked = value; input.onchange = () => onChange(input.checked);
    } else if (spec.type === 'number' || spec.type === 'integer') {
      input = el('input'); input.type = 'number'; input.required = true;
      if (spec.min !== undefined) input.min = spec.min;
      if (spec.max !== undefined) input.max = spec.max;
      input.step = spec.step ?? (spec.type === 'integer' ? 1 : 'any'); input.value = value;
      let slider;
      if (sliders && spec.min !== undefined && spec.max !== undefined) {
        slider = el('input'); slider.type = 'range'; slider.min = spec.min; slider.max = spec.max; slider.step = input.step; slider.value = value;
        slider.oninput = () => { input.value = slider.value; onChange(slider.valueAsNumber); };
        host.append(slider);
      }
      input.oninput = () => { if (input.validity.valid) { if (slider) slider.value = input.value; onChange(input.valueAsNumber); } };
    } else {
      input = el(spec.type === 'json' ? 'textarea' : 'input'); input.value = spec.type === 'json' ? JSON.stringify(value) : value;
      input.onchange = () => {
        if (spec.type === 'json') {
          try { const parsed = JSON.parse(input.value); input.setCustomValidity(''); onChange(parsed); }
          catch { input.setCustomValidity('请输入有效 JSON'); input.reportValidity(); }
        } else onChange(input.value);
      };
    }
    input.setAttribute('aria-label', spec.label || spec.key); host.append(input); return host;
  }
  function menu(x, y, items) {
    closeMenu(); const menu = el('div', 'context-menu'); menu.id = 'context-menu'; menu.setAttribute('role', 'menu');
    for (const item of items) {
      if (item.separator) { menu.append(el('hr')); continue; }
      const b = button(item.icon || 'Circle', item.label, () => { closeMenu(); return item.action(); }, item.label);
      b.setAttribute('role', 'menuitem'); b.disabled = !!item.disabled; menu.append(b);
    }
    menu.style.left = `${x}px`; menu.style.top = `${y}px`; document.body.append(menu);
    const rect = menu.getBoundingClientRect();
    menu.style.left = `${Math.max(8, Math.min(x, innerWidth - rect.width - 8))}px`;
    menu.style.top = `${Math.max(8, Math.min(y, innerHeight - rect.height - 8))}px`;
  }
  function closeMenu() { document.getElementById('context-menu')?.remove(); }
  document.addEventListener('pointerdown', e => { if (!e.target.closest('.context-menu')) closeMenu(); });

  const THEME_KEY = 'screenlab-theme-v1';
  const themeListeners = new Set();
  const styles = [
    ['manuscript', 'PenTool', '漫画原稿工坊风'],
    ['editorial', 'BookOpen', '现代画册目录风'],
    ['darkroom', 'Aperture', '光学暗房看片台风'],
    ['card', 'LayoutGrid', '经典圆角卡片风'],
  ];
  const accents = [
    ['blue', '科技蓝'],
    ['pink', '樱花粉'],
    ['green', '翡翠绿'],
  ];

  function loadAppearance() {
    try {
      const saved = JSON.parse(localStorage.getItem(THEME_KEY));
      return {
        theme: saved?.theme === 'light' ? 'light' : 'dark',
        accent: ['blue', 'pink', 'green'].includes(saved?.accent) ? saved.accent : 'blue',
        style: styles.some(([key]) => key === saved?.style) ? saved.style : 'manuscript',
      };
    } catch {
      return { theme: 'dark', accent: 'blue', style: 'manuscript' };
    }
  }

  let appearance = loadAppearance();

  function applyAppearance(next = {}) {
    appearance = { ...appearance, ...next };
    document.documentElement.dataset.theme = appearance.theme;
    document.documentElement.dataset.accent = appearance.accent;
    document.documentElement.dataset.style = appearance.style;
    try { localStorage.setItem(THEME_KEY, JSON.stringify(appearance)); } catch {}
    renderThemeControls();
    for (const listener of themeListeners) listener(appearance);
  }

  function onThemeChange(listener) {
    themeListeners.add(listener);
    return () => themeListeners.delete(listener);
  }

  function renderThemeControls() {
    const host = document.getElementById('theme-controls');
    if (!host) return;
    host.replaceChildren();
    const styleGroup = el('div', 'style-switcher');
    styleGroup.setAttribute('role', 'group');
    styleGroup.setAttribute('aria-label', '界面风格');
    for (const [key, iconName, fullTitle] of styles) {
      const btn = el('button', `style-option style-${key}${appearance.style === key ? ' active' : ''}`);
      btn.type = 'button';
      btn.title = `切换风格：${fullTitle}`;
      btn.setAttribute('aria-label', btn.title);
      btn.setAttribute('aria-pressed', String(appearance.style === key));
      btn.append(icon(iconName));
      btn.onclick = () => applyAppearance({ style: key });
      styleGroup.append(btn);
    }
    const swatches = el('div', 'accent-switcher');
    for (const [key, labelText] of accents) {
      const swatch = el('button', `accent-swatch accent-${key}${appearance.accent === key ? ' active' : ''}`);
      swatch.type = 'button';
      swatch.title = `切换配色：${labelText}`;
      swatch.setAttribute('aria-label', swatch.title);
      swatch.setAttribute('aria-pressed', String(appearance.accent === key));
      swatch.onclick = () => applyAppearance({ accent: key });
      swatches.append(swatch);
    }
    const isLight = appearance.theme === 'light';
    const modeBtn = button(
      isLight ? 'Sun' : 'Moon',
      isLight ? '切换至夜间模式' : '切换至日间模式',
      () => applyAppearance({ theme: isLight ? 'dark' : 'light' }),
      isLight ? '日间' : '夜间'
    );
    modeBtn.classList.add('theme-toggle');
    host.append(styleGroup, swatches, modeBtn);
  }

  applyAppearance();

  return { el, icon, button, run, toast, download, pickFiles, rename, select, label, splitColumns, paint, parameter, menu, closeMenu, applyAppearance, onThemeChange, get appearance() { return appearance; } };
})();
