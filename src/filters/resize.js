/* Resize dimensions are shared by the filter, its controls, and preview geometry. */
'use strict';
const ScreenResize = (() => {
  function dimensions(width, height, size) {
    let w = size.unit === 'percent' ? width * size.width / 100 : size.width;
    let h = size.unit === 'percent' ? height * size.height / 100 : size.height;
    if (size.linked) {
      if (size.axis === 'height') w = h * width / height;
      else h = w * height / width;
    }
    return { width: Math.max(1, Math.round(w)), height: Math.max(1, Math.round(h)) };
  }

  function control(value, onChange, image) {
    let size = structuredClone(value);
    const host = UI.el('div', 'resize-control'), fields = UI.el('div', 'resize-fields');
    const inputs = {}, units = {}, rows = {};
    const result = UI.el('div', 'resize-dimensions');
    const lock = UI.button('Link', '锁定宽高比例', () => {
      if (size.linked) {
        const values = displayed(); size.width = values.width; size.height = values.height;
      }
      size.linked = !size.linked; commit();
    });
    lock.classList.add('resize-lock');
    function displayed() {
      if (size.linked && size.unit === 'percent') return { width: size[size.axis], height: size[size.axis] };
      if (!image) return { width: size.width, height: size.height };
      const target = dimensions(image.width, image.height, size);
      if (size.unit === 'pixels') return target;
      return size;
    }
    function refresh(active) {
      const values = displayed();
      for (const axis of ['width', 'height']) {
        const input = inputs[axis];
        const fixed = size.linked && size.unit === 'pixels' && size.axis === axis;
        const computed = size.linked && size.unit === 'pixels' && size.axis !== axis;
        input.min = size.unit === 'percent' ? .01 : 1;
        input.step = size.unit === 'percent' ? .01 : 1;
        input.readOnly = computed;
        input.placeholder = computed ? '根据计算' : '';
        input.title = computed ? `编辑${axis === 'width' ? '宽度' : '高度'}` : '';
        rows[axis].classList.toggle('fixed', fixed);
        rows[axis].classList.toggle('computed', computed);
        if (computed) input.value = '';
        else if (axis !== active) input.value = values[axis];
        units[axis].value = size.unit;
      }
      lock.replaceChildren(UI.icon(size.linked ? 'Link' : 'Unlink'));
      lock.classList.toggle('active', size.linked);
      lock.setAttribute('aria-pressed', String(size.linked));
      lock.title = size.linked ? '解除宽高比例锁定' : '锁定宽高比例';
      lock.setAttribute('aria-label', lock.title);
      if (image) {
        const target = dimensions(image.width, image.height, size);
        result.textContent = `${image.width} × ${image.height} → ${target.width} × ${target.height} px`;
      }
    }
    function commit(active) {
      if (size.linked) {
        if (size.unit === 'percent') size.width = size.height = size[size.axis];
        else if (image) {
          const target = dimensions(image.width, image.height, size);
          size[size.axis === 'width' ? 'height' : 'width'] = target[size.axis === 'width' ? 'height' : 'width'];
        }
      }
      refresh(active); onChange(structuredClone(size));
    }
    function changeUnit(unit) {
      if (image) {
        const target = dimensions(image.width, image.height, size);
        size.width = unit === 'pixels' ? target.width : Math.round(target.width / image.width * 10000) / 100;
        size.height = unit === 'pixels' ? target.height : Math.round(target.height / image.height * 10000) / 100;
      }
      size.unit = unit; commit();
    }
    for (const [axis, label] of [['width', '宽度'], ['height', '高度']]) {
      const row = UI.el('label', 'resize-row'), input = UI.el('input');
      input.type = 'number'; input.required = true; input.setAttribute('aria-label', label);
      input.onfocus = () => {
        if (!size.linked || size.unit !== 'pixels' || size.axis === axis) return;
        // Focusing the calculated side makes it the fixed side. Merely focusing
        // the unit selector must leave the fixed axis unchanged.
        size[axis] = displayed()[axis]; size.axis = axis;
        commit(); input.select();
      };
      input.oninput = () => {
        if (!input.validity.valid) return;
        size[axis] = input.valueAsNumber; size.axis = axis;
        if (size.linked && size.unit === 'percent') size.width = size.height = size[axis];
        commit(axis);
      };
      input.onchange = () => refresh();
      const unit = UI.select([['percent', '百分比'], ['pixels', '像素']], size.unit, changeUnit);
      unit.setAttribute('aria-label', `${label}单位`);
      inputs[axis] = input; units[axis] = unit; rows[axis] = row;
      row.append(UI.el('span', '', label), input, unit); fields.append(row);
    }
    host.append(lock, fields, result); refresh(); return host;
  }

  ScreenFilters.register(function () {
    // ==ScreenFilter==
    // @id resize
    // @name 缩放
    // @geometry resize
    // @param {"key":"size","label":"尺寸","type":"json","editor":"resize","default":{"unit":"percent","width":100,"height":100,"linked":true,"axis":"width"}}
    // ==/ScreenFilter==
    function cubic(x, a) {
      x = Math.abs(x);
      if (x < 1) return (a + 2) * x * x * x - (a + 3) * x * x + 1;
      if (x < 2) return a * x * x * x - 5 * a * x * x + 8 * a * x - 4 * a;
      return 0;
    }
    function samples(count, origin, inputCount, inputOrigin, ratio) {
      // Widen the cubic footprint on reduction to suppress aliasing. The sharper
      // reduction kernel and smoother enlargement kernel are selected internally.
      const footprint = Math.max(1, 1 / ratio), a = ratio < 1 ? -.75 : -.5;
      return Array.from({ length: count }, (_, i) => {
        const center = (origin + i + .5) / ratio - .5 - inputOrigin;
        const indices = [], weights = [];
        let total = 0;
        for (let p = Math.ceil(center - 2 * footprint); p <= Math.floor(center + 2 * footprint); p++) {
          const weight = cubic((p - center) / footprint, a);
          if (weight === 0) continue;
          indices.push(Math.max(0, Math.min(inputCount - 1, p)));
          weights.push(weight); total += weight;
        }
        return { indices, weights: weights.map(weight => weight / total) };
      });
    }
    function apply(image, { size }) {
      const { data, width, height } = image;
      const fullWidth = image.fullWidth ?? width, fullHeight = image.fullHeight ?? height;
      const target = dimensions(fullWidth, fullHeight, size);
      const sx = target.width / fullWidth, sy = target.height / fullHeight;
      const left = image.originX ?? 0, top = image.originY ?? 0;
      const originX = Math.floor(left * sx), originY = Math.floor(top * sy);
      const outWidth = Math.max(1, Math.ceil((left + width) * sx) - originX);
      const outHeight = Math.max(1, Math.ceil((top + height) * sy) - originY);
      const columns = samples(outWidth, originX, width, left, sx);
      const rows = samples(outHeight, originY, height, top, sy);
      const horizontal = new Float32Array(outWidth * height * 4);
      const output = new Uint8ClampedArray(outWidth * outHeight * 4);
      FilterAPI.progress(0);
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < outWidth; x++) {
          const dst = (y * outWidth + x) * 4, tap = columns[x];
          for (let k = 0; k < tap.indices.length; k++) {
            const src = (y * width + tap.indices[k]) * 4, weight = tap.weights[k];
            const alpha = data[src + 3] / 255;
            for (let c = 0; c < 3; c++) horizontal[dst + c] += data[src + c] * alpha * weight;
            horizontal[dst + 3] += alpha * weight;
          }
        }
        FilterAPI.progress(.5 * (y + 1) / height);
      }
      for (let y = 0; y < outHeight; y++) {
        const tap = rows[y];
        for (let x = 0; x < outWidth; x++) {
          const color = [0, 0, 0, 0], dst = (y * outWidth + x) * 4;
          for (let k = 0; k < tap.indices.length; k++) {
            const src = (tap.indices[k] * outWidth + x) * 4;
            for (let c = 0; c < 4; c++) color[c] += horizontal[src + c] * tap.weights[k];
          }
          if (color[3] > 0) for (let c = 0; c < 3; c++) output[dst + c] = Math.round(color[c] / color[3]);
          output[dst + 3] = Math.round(color[3] * 255);
        }
        FilterAPI.progress(.5 + .5 * (y + 1) / outHeight);
      }
      return { data: output, width: outWidth, height: outHeight,
        fullWidth: target.width, fullHeight: target.height, originX, originY };
    }
    return { apply };
  }, { dimensions });
  return { dimensions, control };
})();
