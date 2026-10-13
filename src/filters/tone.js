ScreenFilters.register(function () {
  // ==ScreenFilter==
  // @id curve
  // @name 曲线
  // @param {"key":"points","label":"曲线点","type":"json","range":"array of {x,y}: integer 0..255; x strictly ascending; first x=0, last x=255","default":[{"x":0,"y":0},{"x":255,"y":255}]}
  // @input image {data: Uint8ClampedArray RGBA 0..255, width: integer >=1, height: integer >=1}
  // @option roi {x,y,w,h: integer; x,y>=0; w,h>=1; within image}; default: full image
  // @output {data: Uint8ClampedArray RGBA, width: integer, height: integer}
  // ==/ScreenFilter==
  'use strict';
  function apply({ data, width, height }, { points }, {
    roi = { x: 0, y: 0, w: width, h: height },
  } = {}) {
    const table = new Uint8Array(256);
    let segment = 0;
    for (let x = 0; x < 256; x++) {
      while (segment < points.length - 2 && x > points[segment + 1].x) segment++;
      const a = points[segment], b = points[segment + 1];
      table[x] = Math.round(a.y + (b.y - a.y) * (x - a.x) / (b.x - a.x));
    }
    const output = new Uint8ClampedArray(roi.w * roi.h * 4);
    for (let y = 0; y < roi.h; y++) {
      for (let x = 0; x < roi.w; x++) {
        const sourceIndex = ((roi.y + y) * width + roi.x + x) * 4;
        const destIndex = (y * roi.w + x) * 4;
        for (let channel = 0; channel < 3; channel++) output[destIndex + channel] = table[data[sourceIndex + channel]];
        output[destIndex + 3] = data[sourceIndex + 3];
      }
    }
    FilterAPI.progress(1);
    return { data: output, width: roi.w, height: roi.h };
  }
  return { apply };
});
