ScreenFilters.register(function () {
  // ==ScreenFilter==
  // @id denoise-cpu
  // @name 降噪（CPU 对照）
  // @param {"key":"patch","label":"图块半径","type":"integer","min":2,"max":8,"step":1,"default":4}
  // @param {"key":"search","label":"搜索半径","type":"integer","min":4,"max":24,"step":1,"default":12}
  // @param {"key":"strength","label":"匹配容差","type":"number","min":5,"max":80,"step":1,"default":25}
  // @input image {data: Uint8ClampedArray RGBA 0..255, width: integer >=1, height: integer >=1}
  // @option roi {x,y,w,h: integer; x,y>=0; w,h>=1; within image}; default: full image
  // @output {data: Uint8ClampedArray RGBA, width: integer, height: integer}
  // ==/ScreenFilter==
  'use strict';
  function apply({ data, width, height }, { patch, search, strength }, {
    roi = { x: 0, y: 0, w: width, h: height },
  } = {}) {
    const output = new Uint8ClampedArray(roi.w * roi.h * 4);
    const paddedWidth = width + patch * 2;
    const luma = new Float32Array(paddedWidth * (height + patch * 2));
    const opaque = new Uint8Array(luma.length);
    let allOpaque = true;
    for (let py = 0; py < height + patch * 2; py++) {
      const y = Math.max(0, Math.min(height - 1, py - patch));
      for (let px = 0; px < paddedWidth; px++) {
        const x = Math.max(0, Math.min(width - 1, px - patch));
        const p = (y * width + x) * 4, i = py * paddedWidth + px;
        luma[i] = data[p] * .2126 + data[p + 1] * .7152 + data[p + 2] * .0722;
        opaque[i] = data[p + 3] === 255 ? 1 : 0;
        if (!opaque[i]) allOpaque = false;
      }
    }
    const offsets = [];
    for (let dy = -patch; dy <= patch; dy++) for (let dx = -patch; dx <= patch; dx++) {
      if (dx !== 0 || dy !== 0) offsets.push(dy * paddedWidth + dx);
    }
    const h2 = strength * strength;
    const reference = new Float32Array(offsets.length);
    for (let y = roi.y; y < roi.y + roi.h; y++) {
      for (let x = roi.x; x < roi.x + roi.w; x++) {
        const sourceIndex = (y * width + x) * 4;
        const destIndex = ((y - roi.y) * roi.w + x - roi.x) * 4;
        output.set(data.subarray(sourceIndex, sourceIndex + 4), destIndex);
        if (data[sourceIndex + 3] !== 255) continue;
        const center = (y + patch) * paddedWidth + x + patch;
        for (let k = 0; k < offsets.length; k++) reference[k] = luma[center + offsets[k]];
        // Require opaque context rather than interpreting transparent RGB as ink.
        if (!allOpaque && offsets.some(offset => !opaque[center + offset])) continue;
        const best = [];
        let cutoff = 6 * h2;
        for (let cy = Math.max(0, y - search); cy <= Math.min(height - 1, y + search); cy++) {
          for (let cx = Math.max(0, x - search); cx <= Math.min(width - 1, x + search); cx++) {
            if (cx === x && cy === y) continue;
            const candidateIndex = (cy * width + cx) * 4;
            if (data[candidateIndex + 3] !== 255) continue;
            const candidateCenter = (cy + patch) * paddedWidth + cx + patch;
            let sum = 0;
            let valid = true;
            for (let k = 0; k < offsets.length; k++) {
              const i = candidateCenter + offsets[k];
              if (!allOpaque && !opaque[i]) { valid = false; break; }
              const d = reference[k] - luma[i];
              // Bounded loss lets a minority of damaged context samples survive.
              sum += Math.min(d * d, 10000);
              if (sum > cutoff * offsets.length) { valid = false; break; }
            }
            if (!valid) continue;
            const distance = sum / offsets.length;
            let at = 0;
            while (at < best.length && best[at].distance <= distance) at++;
            best.splice(at, 0, { index: candidateIndex, distance });
            if (best.length > 12) best.pop();
            if (best.length === 12) cutoff = Math.min(6 * h2, best[11].distance);
          }
        }
        // No trustworthy repetition: preserve the source.
        if (best.length && best[0].distance < 3 * h2) {
          let total = .35;
          const colors = [data[sourceIndex] * total, data[sourceIndex + 1] * total, data[sourceIndex + 2] * total];
          for (const candidate of best) {
            const weight = Math.exp(-candidate.distance / (h2 * .25));
            total += weight;
            for (let c = 0; c < 3; c++) colors[c] += data[candidate.index + c] * weight;
          }
          for (let c = 0; c < 3; c++) output[destIndex + c] = colors[c] / total;
        }
      }
      if ((y - roi.y) % 4 === 0 || y === roi.y + roi.h - 1) FilterAPI.progress((y - roi.y + 1) / roi.h);
    }
    return { data: output, width: roi.w, height: roi.h };
  }
  return { apply };
});
if (typeof module !== 'undefined' && module.exports) module.exports = ScreenFilters.filters['denoise-cpu'];
