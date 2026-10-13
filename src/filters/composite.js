/* Multi-layer source-over compositing with a shared blend mode. */
'use strict';
const ScreenComposite = (() => {
  const modes = ['normal', 'darken', 'multiply', 'color-burn', 'lighten', 'screen', 'color-dodge',
    'overlay', 'soft-light', 'hard-light', 'difference', 'exclusion', 'subtract', 'divide',
    'hue', 'saturation', 'color', 'luminosity'];
  function dimensions(images) {
    return { width: Math.max(...images.map(image => image.fullWidth ?? image.width)),
      height: Math.max(...images.map(image => image.fullHeight ?? image.height)) };
  }
  ScreenFilters.register(function () {
    // ==ScreenFilter==
    // @id composite
    // @name 合成
    // @input images
    // @geometry composite
    // @param {"key":"mode","label":"混合模式","type":"enum","values":["normal","darken","multiply","color-burn","lighten","screen","color-dodge","overlay","soft-light","hard-light","difference","exclusion","subtract","divide","hue","saturation","color","luminosity"],"labels":{"normal":"正常","darken":"变暗","multiply":"正片叠底","color-burn":"颜色加深","lighten":"变亮","screen":"滤色","color-dodge":"颜色减淡","overlay":"叠加","soft-light":"柔光","hard-light":"强光","difference":"差值","exclusion":"排除","subtract":"减去","divide":"划分","hue":"色相","saturation":"饱和度","color":"颜色","luminosity":"明度"},"default":"normal"}
    // ==/ScreenFilter==
    const clamp = value => Math.max(0, Math.min(1, value));
    const burn = (b, s) => s <= 0 ? 0 : s >= 1 ? 1 : 1 - Math.min(1, (1 - b) / s);
    const dodge = (b, s) => s >= 1 ? 1 : b <= 0 ? 0 : Math.min(1, b / (1 - s));
    const hard = (b, s) => s <= .5 ? 2 * b * s : 1 - 2 * (1 - b) * (1 - s);
    function channel(b, s, mode) {
      switch (mode) {
        case 'normal': return s;
        case 'darken': return Math.min(b, s);
        case 'multiply': return b * s;
        case 'color-burn': return burn(b, s);
        case 'lighten': return Math.max(b, s);
        case 'screen': return b + s - b * s;
        case 'color-dodge': return dodge(b, s);
        case 'overlay': return hard(s, b);
        case 'soft-light': return s <= .5 ? b - (1 - 2 * s) * b * (1 - b) : b + (2 * s - 1) * (Math.sqrt(b) - b);
        case 'hard-light': return hard(b, s);
        case 'difference': return Math.abs(b - s);
        case 'exclusion': return b + s - 2 * b * s;
        case 'subtract': return Math.max(0, b - s);
        case 'divide': return s === 0 ? 1 : Math.min(1, b / s);
        default: return s;
      }
    }
    const luminosity = c => .3 * c[0] + .59 * c[1] + .11 * c[2];
    const saturation = c => Math.max(...c) - Math.min(...c);
    function setLuminosity(c, target) {
      const delta = target - luminosity(c), result = c.map(v => v + delta);
      const l = luminosity(result), min = Math.min(...result), max = Math.max(...result);
      if (min < 0) return result.map(v => l + (v - l) * l / (l - min));
      if (max > 1) return result.map(v => l + (v - l) * (1 - l) / (max - l));
      return result;
    }
    function setSaturation(c, target) {
      const order = [0, 1, 2].sort((a, b) => c[a] - c[b]), min = order[0], mid = order[1], max = order[2];
      const result = [0, 0, 0];
      if (c[max] > c[min]) { result[mid] = (c[mid] - c[min]) * target / (c[max] - c[min]); result[max] = target; }
      return result;
    }
    function colorMode(base, source, mode) {
      if (mode === 'hue') return setLuminosity(setSaturation(source, saturation(base)), luminosity(base));
      if (mode === 'saturation') return setLuminosity(setSaturation(base, saturation(source)), luminosity(base));
      if (mode === 'color') return setLuminosity(source, luminosity(base));
      if (mode === 'luminosity') return setLuminosity(base, luminosity(source));
      return null;
    }
    function apply(images, { mode }, { roi } = {}) {
      const size = dimensions(images);
      roi ??= { x: 0, y: 0, w: size.width, h: size.height };
      const pixels = new Float32Array(roi.w * roi.h * 4);
      const nonseparable = ['hue', 'saturation', 'color', 'luminosity'].includes(mode);
      for (const [layer, image] of images.entries()) {
        const ix = image.originX ?? 0, iy = image.originY ?? 0;
        const left = Math.max(roi.x, ix), right = Math.min(roi.x + roi.w, ix + image.width);
        const top = Math.max(roi.y, iy), bottom = Math.min(roi.y + roi.h, iy + image.height);
        for (let y = top; y < bottom; y++) {
          for (let x = left; x < right; x++) {
            const src = ((y - iy) * image.width + x - ix) * 4, dst = ((y - roi.y) * roi.w + x - roi.x) * 4;
            const sourceAlpha = image.data[src + 3] / 255;
            if (!sourceAlpha) continue;
            const baseAlpha = pixels[dst + 3], source = [image.data[src] / 255, image.data[src + 1] / 255, image.data[src + 2] / 255];
            const base = baseAlpha ? [pixels[dst] / baseAlpha, pixels[dst + 1] / baseAlpha, pixels[dst + 2] / baseAlpha] : source;
            const special = nonseparable && baseAlpha ? colorMode(base, source, mode) : null;
            for (let c = 0; c < 3; c++) {
              const blended = baseAlpha ? (special ? special[c] : channel(base[c], source[c], mode)) : source[c];
              pixels[dst + c] = (1 - sourceAlpha) * pixels[dst + c] + sourceAlpha * ((1 - baseAlpha) * source[c] + baseAlpha * blended);
            }
            pixels[dst + 3] = sourceAlpha + baseAlpha * (1 - sourceAlpha);
          }
        }
        FilterAPI.progress((layer + 1) / images.length);
      }
      const data = new Uint8ClampedArray(pixels.length);
      for (let i = 0; i < data.length; i += 4) {
        const alpha = pixels[i + 3];
        if (alpha) for (let c = 0; c < 3; c++) data[i + c] = Math.round(clamp(pixels[i + c] / alpha) * 255);
        data[i + 3] = Math.round(alpha * 255);
      }
      return { data, width: roi.w, height: roi.h, fullWidth: size.width, fullHeight: size.height, originX: roi.x, originY: roi.y };
    }
    return { apply };
  }, { dimensions });
  return { dimensions, modes };
})();
