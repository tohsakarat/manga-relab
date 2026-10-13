/* Offset adds transparent space on the positive axes; the image origin stays fixed. */
'use strict';
const ScreenOffset = (() => {
  function displacement(width, height, { unit, x, y }) {
    return { x: Math.round(unit === 'percent' ? width * x / 100 : x),
      y: Math.round(unit === 'percent' ? height * y / 100 : y) };
  }
  function dimensions(width, height, params) {
    const offset = displacement(width, height, params);
    return { width: width + Math.max(0, offset.x), height: height + Math.max(0, offset.y) };
  }
  ScreenFilters.register(function () {
    // ==ScreenFilter==
    // @id offset
    // @name 偏移
    // @geometry offset
    // @param {"key":"unit","label":"偏移单位","type":"enum","values":["pixels","percent"],"labels":{"pixels":"像素","percent":"百分比"},"default":"pixels"}
    // @param {"key":"x","label":"水平偏移","type":"number","step":0.1,"default":0}
    // @param {"key":"y","label":"垂直偏移","type":"number","step":0.1,"default":0}
    // ==/ScreenFilter==
    function apply(image, params, { roi } = {}) {
      const fw = image.fullWidth ?? image.width, fh = image.fullHeight ?? image.height;
      const offset = displacement(fw, fh, params), size = dimensions(fw, fh, params);
      roi ??= { x: 0, y: 0, w: size.width, h: size.height };
      const data = new Uint8ClampedArray(roi.w * roi.h * 4);
      const ix = image.originX ?? 0, iy = image.originY ?? 0;
      const left = Math.max(roi.x, ix + offset.x), right = Math.min(roi.x + roi.w, ix + offset.x + image.width);
      const top = Math.max(roi.y, iy + offset.y), bottom = Math.min(roi.y + roi.h, iy + offset.y + image.height);
      FilterAPI.progress(0);
      for (let y = top; y < bottom; y++) {
        if (right > left) {
          const src = ((y - offset.y - iy) * image.width + left - offset.x - ix) * 4;
          data.set(image.data.subarray(src, src + (right - left) * 4), ((y - roi.y) * roi.w + left - roi.x) * 4);
        }
        FilterAPI.progress((y - top + 1) / (bottom - top));
      }
      FilterAPI.progress(1);
      return { data, width: roi.w, height: roi.h, fullWidth: size.width, fullHeight: size.height, originX: roi.x, originY: roi.y };
    }
    return { apply };
  }, { displacement, dimensions });
  return { displacement, dimensions };
})();
