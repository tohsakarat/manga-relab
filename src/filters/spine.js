ScreenFilters.register(function () {
  // ==ScreenFilter==
  // @id spine
  // @name 去阴影
  // @param {"key":"scalePercent","label":"阴影尺度（页面宽度 %）","type":"number","min":0,"max":30,"step":0.1,"default":5}
  // @param {"key":"strength","label":"校正强度（%）","type":"number","min":0,"max":100,"step":1,"default":100}
  // @param {"key":"position","label":"阴影位置","type":"enum","values":["center","left","right","top","bottom","unspecified"],"default":"unspecified"}
  // @input image {data: Uint8ClampedArray RGBA 0..255, width: integer >=1, height: integer >=1}
  // @option roi {x,y,w,h: integer; x,y>=0; w,h>=1; within image}; default: full image
  // @option debug function(message: string, level?: string)
  // @output {data: Uint8ClampedArray RGBA, width: integer, height: integer, detection: object|null}
  // ==/ScreenFilter==
  'use strict';
  function apply({ data, width, height }, { scalePercent, strength, position = 'unspecified' }, {
    roi = { x: 0, y: 0, w: width, h: height }, debug = () => {},
  } = {}) {
    const output = new Uint8ClampedArray(roi.w * roi.h * 4);
    for (let y = 0; y < roi.h; y++) {
      const start = ((roi.y + y) * width + roi.x) * 4;
      output.set(data.subarray(start, start + roi.w * 4), y * roi.w * 4);
    }
    const result = { data: output, width: roi.w, height: roi.h, detection: null };
    if (scalePercent === 0 || strength === 0) { FilterAPI.progress(1); return result; }

    const scale = Math.max(1, Math.round(width * scalePercent / 100));
    const step = Math.max(4, Math.round(scale / 4));
    const axes = position === 'unspecified' ? ['x', 'y']
      : [position === 'top' || position === 'bottom' ? 'y' : 'x'];
    let shadow = null;

    function sample(axis, axisIndex) {
      const length = axis === 'x' ? width : height;
      const crossLength = axis === 'x' ? height : width;
      const columns = Math.ceil(length / step), rows = Math.ceil(crossLength / scale);
      const paper = new Float32Array(columns * rows);
      const histogram = new Uint32Array(256);
      for (let row = 0; row < rows; row++) {
        for (let column = 0; column < columns; column++) {
          histogram.fill(0);
          let samples = 0;
          for (let across = row * scale; across < Math.min(crossLength, (row + 1) * scale); across++) {
            for (let along = column * step; along < Math.min(length, (column + 1) * step); along++) {
              const i = (axis === 'x' ? across * width + along : along * width + across) * 4;
              if (data[i + 3] !== 255) continue;
              const value = Math.round(data[i] * .2126 + data[i + 1] * .7152 + data[i + 2] * .0722);
              histogram[value]++; samples++;
            }
          }
          const target = Math.ceil(samples * .95);
          let accumulated = 0;
          for (let value = 0; value < 256; value++) {
            accumulated += histogram[value];
            if (accumulated >= target) { paper[row * columns + column] = value; break; }
          }
        }
        FilterAPI.progress(.5 * (axisIndex + (row + 1) / rows) / axes.length);
      }
      const upper = new Float32Array(columns);
      for (let column = 0; column < columns; column++) {
        const values = [];
        for (let row = 0; row < rows; row++) values.push(paper[row * columns + column]);
        values.sort((a, b) => a - b);
        // White margins and panel gaps reduce the influence of dark artwork.
        upper[column] = values[Math.floor((values.length - 1) * .85)];
      }
      const profile = new Float32Array(columns);
      for (let column = 0; column < columns; column++) {
        profile[column] = (upper[Math.max(0, column - 1)] + 2 * upper[column]
          + upper[Math.min(columns - 1, column + 1)]) / 4;
      }
      const sorted = Array.from(profile).sort((a, b) => a - b);
      return { axis, length, columns, rows, paper, profile,
        reference: sorted[Math.floor((sorted.length - 1) * .9)] };
    }

    function locate(samples, side) {
      const { columns, rows, paper, profile, reference } = samples;
      const radius = Math.max(2, Math.ceil(columns * .2));
      for (let center = 0; center < columns; center++) {
        if (side === 'start' && center >= columns / 3) continue;
        if (side === 'end' && center < columns * 2 / 3) continue;
        if (side === 'middle' && (center === 0 || center === columns - 1)) continue;
        if (position === 'center' && (center < columns / 3 || center >= columns * 2 / 3)) continue;
        if ((center > 0 && profile[center] > profile[center - 1])
          || (center < columns - 1 && profile[center] > profile[center + 1])) continue;

        let leftPeak = center, rightPeak = center;
        if (side !== 'start') {
          for (let x = Math.max(0, center - radius); x < center; x++) {
            if (profile[x] > profile[leftPeak]) leftPeak = x;
          }
        }
        if (side !== 'end') {
          for (let x = center + 1; x <= Math.min(columns - 1, center + radius); x++) {
            if (profile[x] > profile[rightPeak]) rightPeak = x;
          }
        }
        // Edge shadows have paper support only on the inward side.
        const white = side === 'start' ? profile[rightPeak] : side === 'end' ? profile[leftPeak]
          : Math.min(profile[leftPeak], profile[rightPeak]);
        const depth = white - profile[center];
        if (depth < Math.max(6, reference * .025) || white < reference * .8) continue;
        let supportingRows = 0;
        for (let row = 0; row < rows; row++) {
          const rowWhite = side === 'start' ? paper[row * columns + rightPeak]
            : side === 'end' ? paper[row * columns + leftPeak]
              : Math.min(paper[row * columns + leftPeak], paper[row * columns + rightPeak]);
          if (rowWhite >= reference * .8 && rowWhite - paper[row * columns + center] >= depth * .3) supportingRows++;
        }
        const support = supportingRows / rows, score = depth * support;
        if (support < .5 || (shadow && score <= shadow.score)) continue;
        const recovery = white - depth * .08;
        let left = center, right = center;
        if (side === 'start') left = 0;
        else while (left > leftPeak && profile[left] < recovery) left--;
        if (side === 'end') right = columns - 1;
        else while (right < rightPeak && profile[right] < recovery) right++;
        shadow = { ...samples, side, center, leftPeak, rightPeak, left, right, white, support, score };
      }
    }

    axes.forEach((axis, index) => {
      const samples = sample(axis, index);
      const sides = position === 'unspecified' ? ['middle', 'start', 'end']
        : [position === 'left' || position === 'top' ? 'start'
          : position === 'right' || position === 'bottom' ? 'end' : 'middle'];
      for (const side of sides) locate(samples, side);
    });
    if (!shadow) { FilterAPI.progress(1); return result; }

    const { axis, length, columns, profile, side, center, leftPeak, rightPeak, left, right, white, support } = shadow;
    const start = side === 'start' ? 0 : Math.max(0, Math.ceil((left + .5) * step));
    const end = side === 'end' ? length : Math.min(length, Math.ceil((right + .5) * step));
    const gains = new Float32Array(length);
    gains.fill(1);
    for (let coordinate = start; coordinate < end; coordinate++) {
      const samplePosition = Math.max(0, Math.min(columns - 1, (coordinate + .5) / step - .5));
      const index = Math.min(columns - 2, Math.floor(samplePosition)), fraction = samplePosition - index;
      const illumination = Math.exp(Math.log(profile[index] + .5) * (1 - fraction)
        + Math.log(profile[index + 1] + .5) * fraction);
      const t = (samplePosition - leftPeak) / (rightPeak - leftPeak);
      const baseline = side === 'middle' ? profile[leftPeak] * (1 - t) + profile[rightPeak] * t : white;
      let fade = 1;
      if (side !== 'start') fade = Math.min(fade, (samplePosition - left) / ((center - left) * .2));
      if (side !== 'end') fade = Math.min(fade, (right - samplePosition) / ((right - center) * .2));
      fade = Math.max(0, fade);
      const mask = fade * fade * (3 - 2 * fade);
      gains[coordinate] = 1 + (Math.max(1, (baseline + .5) / illumination) - 1) * strength / 100 * mask;
    }
    result.detection = { axis, center: Math.round((center + .5) * step), start, end, support };
    debug(`阴影 ${axis}=${result.detection.center}，范围 ${start}–${end}，支持 ${(support * 100).toFixed(1)}%`);
    for (let y = 0; y < roi.h; y++) {
      for (let x = 0; x < roi.w; x++) {
        const sourceIndex = ((roi.y + y) * width + roi.x + x) * 4;
        const destIndex = (y * roi.w + x) * 4;
        const gain = gains[axis === 'x' ? roi.x + x : roi.y + y];
        if (data[sourceIndex + 3] !== 255 || gain === 1) continue;
        for (let channel = 0; channel < 3; channel++) output[destIndex + channel] = data[sourceIndex + channel] * gain;
      }
      if (y % 8 === 0 || y === roi.h - 1) FilterAPI.progress(.5 + .5 * (y + 1) / roi.h);
    }
    return result;
  }
  return { apply };
});
