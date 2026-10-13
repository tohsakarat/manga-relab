/* Curve editor; image processing lives in src/filters/tone.js. */
(function (root) {
  'use strict';
  function create(container, { onChange, initialPoints, width = 280 } = {}) {
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = width;
    canvas.className = 'curve-canvas'; canvas.tabIndex = 0;
    const values = document.createElement('div'); values.className = 'curve-values';
    const input = document.createElement('input'), output = document.createElement('input');
    for (const field of [input, output]) { field.type = 'number'; field.min = 0; field.max = 255; field.step = 1; field.required = true; }
    const remove = UI.button('Trash2', '删除曲线点', () => deletePoint());
    values.append(UI.label('输入', input), UI.label('输出', output), remove);
    container.append(canvas, values);
    const context = canvas.getContext('2d');
    const edge = 28, size = canvas.width - edge * 2;
    let points = structuredClone(initialPoints || [{ x: 0, y: 0 }, { x: 255, y: 255 }]);
    let selected = 0, dragging = false, enabled = true;

    function themeColors() {
      const style = getComputedStyle(document.documentElement);
      const get = (name, fallback) => style.getPropertyValue(name).trim() || fallback;
      return {
        bg: get('--curve-bg', '#10151b'),
        grid: get('--curve-grid', '#354155'),
        axis: get('--curve-axis', '#637084'),
        text: get('--muted', '#a4b1c4'),
        accent: get('--accent', '#58a6ff'),
        selected: get('--warning', '#f0b449'),
      };
    }

    function draw() {
      const colors = themeColors();
      context.clearRect(0, 0, canvas.width, canvas.height);
      context.fillStyle = colors.bg;
      context.fillRect(edge, edge, size, size);
      context.lineWidth = 1;
      context.strokeStyle = colors.grid;
      context.fillStyle = colors.text;
      context.font = '11px system-ui';
      for (const value of [0, 64, 128, 192, 255]) {
        const position = value / 255 * size;
        context.beginPath();
        context.moveTo(edge + position, edge); context.lineTo(edge + position, edge + size);
        context.moveTo(edge, edge + size - position); context.lineTo(edge + size, edge + size - position);
        context.stroke();
        context.textAlign = 'center';
        context.fillText(String(value), edge + position, edge + size + 17);
        context.textAlign = 'right';
        context.fillText(String(value), edge - 5, edge + size - position + 4);
      }
      context.strokeStyle = colors.axis;
      context.setLineDash([4, 4]);
      context.beginPath();
      context.moveTo(edge, edge + size); context.lineTo(edge + size, edge); context.stroke();
      context.setLineDash([]);
      context.strokeStyle = colors.accent; context.lineWidth = 2.25;
      context.beginPath();
      for (let i = 0; i < points.length; i++) {
        const x = edge + points[i].x / 255 * size;
        const y = edge + size - points[i].y / 255 * size;
        if (i === 0) context.moveTo(x, y); else context.lineTo(x, y);
      }
      context.stroke();
      for (let i = 0; i < points.length; i++) {
        const px = edge + points[i].x / 255 * size;
        const py = edge + size - points[i].y / 255 * size;
        context.fillStyle = colors.bg;
        context.beginPath();
        context.arc(px, py, 5.5, 0, Math.PI * 2);
        context.fill();
        context.fillStyle = i === selected ? colors.selected : colors.accent;
        context.beginPath();
        context.arc(px, py, 4, 0, Math.PI * 2);
        context.fill();
      }
      const endpoint = selected === 0 || selected === points.length - 1;
      input.value = points[selected].x; output.value = points[selected].y;
      input.min = endpoint ? points[selected].x : points[selected - 1].x + 1;
      input.max = endpoint ? points[selected].x : points[selected + 1].x - 1;
      input.disabled = !enabled || endpoint; output.disabled = !enabled;
      remove.disabled = !enabled || endpoint;
      canvas.setAttribute('aria-label', `曲线，选中点输入 ${points[selected].x}，输出 ${points[selected].y}`);
    }
    function change() { draw(); onChange(points.map(p => ({ ...p }))); }
    function move(x, y) {
      const point = points[selected];
      if (selected > 0 && selected < points.length - 1) {
        point.x = Math.max(points[selected - 1].x + 1, Math.min(points[selected + 1].x - 1, Math.round(x)));
      }
      point.y = Math.max(0, Math.min(255, Math.round(y)));
      change();
    }
    function position(event) {
      const rect = canvas.getBoundingClientRect();
      return {
        x: Math.max(0, Math.min(255, ((event.clientX - rect.left) * canvas.width / rect.width - edge) / size * 255)),
        y: Math.max(0, Math.min(255, (edge + size - (event.clientY - rect.top) * canvas.height / rect.height) / size * 255)),
      };
    }
    function deletePoint() {
      if (selected === 0 || selected === points.length - 1) return;
      points.splice(selected, 1); selected--;
      change();
    }
    canvas.onpointerdown = event => {
      if (!enabled || event.button !== 0) return;
      event.preventDefault(); canvas.focus();
      const positionInCurve = position(event);
      let nearest = 0;
      for (let i = 1; i < points.length; i++) {
        if (Math.hypot(points[i].x - positionInCurve.x, points[i].y - positionInCurve.y)
          < Math.hypot(points[nearest].x - positionInCurve.x, points[nearest].y - positionInCurve.y)) nearest = i;
      }
      const hitRadius = 10 * 255 / (canvas.getBoundingClientRect().width * size / canvas.width);
      if (Math.hypot(points[nearest].x - positionInCurve.x, points[nearest].y - positionInCurve.y) <= hitRadius) {
        selected = nearest; draw();
      } else {
        const x = Math.round(positionInCurve.x), y = Math.round(positionInCurve.y);
        const existing = points.findIndex(point => point.x === x);
        if (existing !== -1) { selected = existing; move(x, y); }
        else {
          selected = points.findIndex(point => point.x > x);
          points.splice(selected, 0, { x, y }); change();
        }
      }
      dragging = true; canvas.setPointerCapture(event.pointerId);
    };
    canvas.onpointermove = event => {
      if (!dragging) return;
      const point = position(event); move(point.x, point.y);
    };
    canvas.onpointerup = canvas.onpointercancel = () => { dragging = false; };
    canvas.onkeydown = event => {
      event.stopPropagation();
      if (!enabled) return;
      if (event.key === 'Delete' || event.key === 'Backspace') {
        event.preventDefault(); deletePoint();
      } else if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) {
        event.preventDefault();
        const step = event.shiftKey ? 10 : 1, point = points[selected];
        move(point.x + (event.key === 'ArrowRight' ? step : event.key === 'ArrowLeft' ? -step : 0),
          point.y + (event.key === 'ArrowUp' ? step : event.key === 'ArrowDown' ? -step : 0));
      }
    };
    input.onchange = () => { if (input.reportValidity()) move(input.valueAsNumber, points[selected].y); };
    output.onchange = () => { if (output.reportValidity()) move(points[selected].x, output.valueAsNumber); };
    remove.onclick = deletePoint;
    const stopTheme = typeof UI !== 'undefined' && UI.onThemeChange ? UI.onThemeChange(() => { if (canvas.isConnected) draw(); else stopTheme(); }) : () => {};
    draw();
    return {
      points() { return points.map(point => ({ ...point })); },
      setPoints(value) { points = structuredClone(value); selected = 0; draw(); },
      destroy() { stopTheme(); canvas.remove(); values.remove(); },
      reset() { points = [{ x: 0, y: 0 }, { x: 255, y: 255 }]; selected = 0; change(); },
      setEnabled(value) {
        enabled = value; canvas.style.pointerEvents = value ? 'auto' : 'none';
        canvas.tabIndex = value ? 0 : -1; draw();
      },
    };
  }
  root.ScreenCurve = { create };
})(globalThis);
