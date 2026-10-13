/* Script drafts and their metadata form stay local until the node is saved. */
'use strict';
const ScriptEditor = (() => {
  const headerPattern = /^[ \t]*\/\/ ==ScreenFilter==[\s\S]*?\/\/ ==\/ScreenFilter==/m;
  const types = [['number', '数字'], ['integer', '整数'], ['boolean', '布尔'], ['enum', '枚举'], ['string', '文本'], ['json', 'JSON']];

  function template() {
    return `ScreenFilters.register(function () {
  // ==ScreenFilter==
  // @id custom-${Store.uuid()}
  // @name 自定义脚本
  // ==/ScreenFilter==

  function apply({ data, width, height }, params, {
    roi = { x: 0, y: 0, w: width, h: height },
  } = {}) {
    const output = new Uint8ClampedArray(roi.w * roi.h * 4);
    for (let y = 0; y < roi.h; y++) {
      const start = ((roi.y + y) * width + roi.x) * 4;
      output.set(data.subarray(start, start + roi.w * 4), y * roi.w * 4);
      FilterAPI.progress((y + 1) / roi.h);
    }
    return { data: output, width: roi.w, height: roi.h };
  }
  return { apply };
});
`;
  }

  function open({ source = template(), nodePanel, onSave, onClose }) {
    const previousFocus = document.activeElement;
    let info = ScreenFilters.metadata(source), syncing = false, lastHeader = source.match(headerPattern)?.[0];
    const dialog = UI.el('dialog', 'script-editor'), title = UI.el('h2', '', '自定义脚本');
    title.id = 'script-editor-title'; dialog.setAttribute('aria-labelledby', title.id);
    const toolbar = UI.el('header', 'script-toolbar'), actions = UI.el('div', 'row-actions');
    actions.append(UI.button('FileUp', '导入 JS 文件', async () => {
      const [file] = await UI.pickFiles({ accept: '.js,text/javascript' });
      if (!file) return;
      const imported = await file.text();
      const meta = ScreenFilters.metadata(imported);
      info = meta; syncing = true; code.setValue(imported); syncing = false;
      lastHeader = imported.match(headerPattern)[0]; renderForm(); clearError(); code.focus();
    }, '导入 JS'), UI.button('X', '关闭脚本编辑器', onClose));
    toolbar.append(title, actions);
    const body = UI.el('div', 'script-body'), config = UI.el('aside', 'script-config');
    const form = UI.el('form', 'script-form'), parameterList = UI.el('div', 'script-parameter-list');
    const id = textInput('脚本 ID'), name = textInput('脚本名称');
    form.append(UI.label('脚本名称', name), UI.label('脚本 ID', id));
    const parameterHeading = UI.el('div', 'script-section-heading');
    parameterHeading.append(UI.el('h3', '', '入参定义'), UI.button('Plus', '添加入参', () => {
      let suffix = 1;
      while (info.params.some(p => p.key === `param${suffix}`)) suffix++;
      info.params.push({ key: `param${suffix}`, label: '新参数', type: 'number', default: 0 });
      renderParameters(); syncHeader(); parameterList.lastElementChild.querySelector('input').focus();
    }));
    form.append(parameterHeading, parameterList); config.append(form);
    if (nodePanel) {
      const settings = UI.el('details', 'script-node-settings');
      settings.append(UI.el('summary', '', '节点参数与预览'), nodePanel); config.append(settings);
    }
    const codeHost = UI.el('div', 'script-code'); body.append(config, codeHost);
    const footer = UI.el('footer', 'script-footer'), error = UI.el('div', 'script-error');
    error.setAttribute('role', 'status');
    const save = UI.button('Check', '保存脚本', () => {
      if (!form.reportValidity()) return;
      try {
        validateParams(info.params);
        if (!id.value.trim() || !name.value.trim()) throw new Error('请填写脚本 ID 和名称');
        const result = code.getValue(), meta = ScreenFilters.metadata(result);
        validateParams(meta.params);
        // Compile without executing user code on the page; execution stays in the Worker.
        new Function(result);
        onSave(result);
      } catch (e) { showError(e.message); }
    }, '保存');
    save.classList.add('primary');
    const footerActions = UI.el('div', 'row-actions');
    footerActions.append(UI.button('X', '取消编辑', onClose, '取消'), save);
    footer.append(error, footerActions); dialog.append(toolbar, body, footer); document.body.append(dialog);
    const code = CodeMirror(codeHost, {
      value: source, mode: 'javascript', theme: 'screenlab', lineNumbers: true,
      indentUnit: 2, tabSize: 2, lineWrapping: false, autofocus: false,
      extraKeys: { Tab: cm => cm.somethingSelected() ? cm.indentSelection('add') : cm.replaceSelection('  ') },
      screenReaderLabel: 'JavaScript 脚本源码',
    });
    code.on('change', () => {
      if (syncing) return;
      const header = code.getValue().match(headerPattern)?.[0];
      if (header === lastHeader) return;
      try {
        const meta = ScreenFilters.metadata(code.getValue()); validateParams(meta.params);
        info = meta; lastHeader = header; renderForm(); clearError();
      } catch (e) { showError(e.message); }
    });
    id.oninput = name.oninput = syncHeader;
    form.onsubmit = event => event.preventDefault();
    dialog.addEventListener('cancel', event => { event.preventDefault(); onClose(); });
    // Canvas shortcuts must not consume code editing or dialog Escape events.
    dialog.addEventListener('keydown', event => event.stopPropagation());
    renderForm(); dialog.showModal(); code.refresh(); code.focus();

    function textInput(label) {
      const input = UI.el('input'); input.required = true; input.setAttribute('aria-label', label); return input;
    }
    function showError(message) { error.textContent = message; }
    function clearError() { error.textContent = ''; }
    function validateParams(params) {
      const keys = new Set();
      for (const spec of params) {
        if (!spec.key || keys.has(spec.key)) throw new Error('入参键名不能为空或重复');
        if (['image', 'images', 'imageA', 'imageB'].includes(spec.key)) throw new Error('入参键名不能使用图像端口名称');
        if (spec.type === 'enum' && !spec.values.length) throw new Error('枚举入参至少需要一个选项');
        keys.add(spec.key);
      }
    }
    function renderForm() {
      id.value = info.id; name.value = info.name; renderParameters();
    }
    function syncHeader() {
      if (!form.checkValidity()) return;
      try {
        validateParams(info.params);
        info.id = id.value.trim(); info.name = name.value.trim();
        if (!info.id || !info.name) throw new Error('请填写脚本 ID 和名称');
        const current = code.getValue(), match = current.match(headerPattern);
        const indent = match ? match[0].match(/^[ \t]*/)[0] : '';
        const lines = ['// ==ScreenFilter==', `// @id ${info.id}`, `// @name ${info.name}`];
        // Preserve the imported cancellation declaration; it does not select hardware.
        if (info.device) lines.push(`// @device ${info.device}`);
        if (info.input) lines.push(`// @input ${info.input}`);
        if (info.geometry) lines.push(`// @geometry ${info.geometry}`);
        for (const spec of info.params) lines.push(`// @param ${JSON.stringify(spec)}`);
        lines.push('// ==/ScreenFilter==');
        const header = lines.map(line => indent + line).join('\n');
        syncing = true;
        if (match) code.replaceRange(header, code.posFromIndex(match.index), code.posFromIndex(match.index + match[0].length), '+metadata');
        else code.replaceRange(header + '\n', { line: 0, ch: 0 }, { line: 0, ch: 0 }, '+metadata');
        syncing = false; lastHeader = header; clearError();
      } catch (e) { showError(e.message); }
    }
    function renderParameters() {
      parameterList.replaceChildren();
      for (const spec of info.params) {
        const row = UI.el('section', 'script-parameter'), fields = UI.el('div', 'script-parameter-fields');
        const key = textInput('入参键名'), label = textInput('入参显示名称');
        key.value = spec.key; label.value = spec.label || spec.key;
        key.oninput = () => { spec.key = key.value.trim(); syncHeader(); };
        label.oninput = () => { spec.label = label.value.trim(); syncHeader(); };
        const heading = UI.el('div', 'script-parameter-heading');
        heading.append(UI.label('键名', key), UI.button('Trash2', '删除入参', () => {
          info.params.splice(info.params.indexOf(spec), 1); renderParameters(); syncHeader();
        }));
        const type = UI.select(types, spec.type, value => {
          spec.type = value;
          delete spec.min; delete spec.max; delete spec.step; delete spec.values; delete spec.range; delete spec.integerWhen;
          spec.default = ['number', 'integer'].includes(value) ? 0 : value === 'boolean' ? false : value === 'json' ? {} : '';
          if (value === 'enum') { spec.values = ['选项1']; spec.default = spec.values[0]; }
          renderParameters(); syncHeader();
        });
        fields.append(UI.label('名称', label), UI.label('类型', type)); row.append(heading, fields);
        if (['number', 'integer'].includes(spec.type)) {
          const range = UI.el('div', 'script-range');
          for (const [field, caption] of [['min', '最小值'], ['max', '最大值'], ['step', '步长']]) {
            const input = UI.el('input'); input.type = 'number'; input.step = spec.type === 'integer' ? '1' : 'any';
            if (field === 'step') input.min = spec.type === 'integer' ? '1' : '0';
            input.value = spec[field] ?? ''; input.setAttribute('aria-label', caption);
            input.oninput = () => {
              if (!input.validity.valid) return;
              if (input.value === '') delete spec[field]; else spec[field] = input.valueAsNumber;
              renderDefault(); syncHeader();
            };
            range.append(UI.label(caption, input));
          }
          row.append(range);
        }
        if (spec.type === 'enum') {
          const choices = UI.el('textarea'); choices.rows = 3; choices.required = true;
          choices.value = spec.values.join('\n'); choices.setAttribute('aria-label', '枚举选项，每行一项');
          choices.oninput = () => {
            // Preserve imported numeric/boolean options while editing their visible labels.
            const previous = spec.values;
            spec.values = choices.value.split('\n').map(s => s.trim()).filter(Boolean).map(s => {
              const index = previous.findIndex(v => String(v) === s); return index < 0 ? s : previous[index];
            });
            if (!spec.values.includes(spec.default)) spec.default = spec.values[0];
            renderDefault(); syncHeader();
          };
          row.append(UI.label('枚举选项（每行一项）', choices));
        }
        const defaultHost = UI.el('div'); row.append(defaultHost); renderDefault(); parameterList.append(row);
        function renderDefault() {
          let input;
          if (spec.type === 'boolean') {
            input = UI.el('input'); input.type = 'checkbox'; input.checked = spec.default;
            input.onchange = () => { spec.default = input.checked; syncHeader(); };
          } else if (spec.type === 'enum') {
            input = UI.select(spec.values.map((v, index) => [String(index), String(v)]), String(spec.values.indexOf(spec.default)), index => {
              spec.default = spec.values[Number(index)]; syncHeader();
            });
          } else {
            input = UI.el(spec.type === 'json' ? 'textarea' : 'input');
            input.value = spec.type === 'json' ? JSON.stringify(spec.default) : spec.default;
            if (['number', 'integer'].includes(spec.type)) {
              input.type = 'number'; input.required = true; input.step = spec.step ?? (spec.type === 'integer' ? 1 : 'any');
              if (spec.min !== undefined) input.min = spec.min;
              if (spec.max !== undefined) input.max = spec.max;
            }
            input.oninput = () => {
              input.setCustomValidity('');
              if (!input.validity.valid) return;
              try {
                spec.default = spec.type === 'json' ? JSON.parse(input.value) : ['number', 'integer'].includes(spec.type) ? input.valueAsNumber : input.value;
                syncHeader();
              } catch { input.setCustomValidity('请输入有效 JSON'); }
            };
          }
          input.setAttribute('aria-label', `${spec.label || spec.key} 默认值`);
          defaultHost.replaceChildren(UI.label('默认值', input));
        }
      }
    }
    return { destroy() { dialog.close(); dialog.remove(); previousFocus?.focus(); } };
  }
  return { open };
})();
