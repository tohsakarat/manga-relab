/* Pixel conversion is shared by output previews and encoding; images remain RGBA. */
'use strict';
const OutputFormat = (() => {
  const formats = {
    png: { type: 'image/png', extension: 'png' },
    jpeg: { type: 'image/jpeg', extension: 'jpg' },
    webp: { type: 'image/webp', extension: 'webp' },
  };
  function format(node) { return formats[Graph.outputSettings(node).format]; }
  function grayscale(image) {
    const data = new Uint8ClampedArray(image.data);
    for (let i = 0; i < data.length; i += 4) {
      const gray = Math.round(0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]);
      data[i] = data[i + 1] = data[i + 2] = gray;
    }
    return { data, width: image.width, height: image.height };
  }
  function grayscalePNG(image) {
    let hasAlpha = false;
    for (let i = 3; i < image.data.length; i += 4) if (image.data[i] !== 255) { hasAlpha = true; break; }
    const channels = hasAlpha ? 2 : 1, data = new Uint8Array(image.width * image.height * channels);
    for (let i = 0, j = 0; i < image.data.length; i += 4) {
      data[j++] = image.data[i];
      if (hasAlpha) data[j++] = image.data[i + 3];
    }
    // encodeLL stores real grayscale channels, rather than RGB pixels that look gray.
    return UPNG.encodeLL([data.buffer], image.width, image.height, 1, hasAlpha ? 1 : 0, 8);
  }
  function quantize(image, bits) {
    const data = image.data.slice();
    // Match UPNG.encode's palette input: hidden RGB in transparent pixels is discarded.
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3] === 0) data[i] = data[i + 1] = data[i + 2] = 0;
    }
    return UPNG.quantize(data.buffer, 2 ** bits);
  }
  function indexedPixels(image, settings, quantized = quantize(image, settings.indexBits)) {
    if (settings.dither === 'none') return quantized.abuf;
    const { width, height } = image, source = image.data.slice();
    const palette = new Uint32Array(quantized.plte.map(color => color.est.rgba));
    // Cached quantization must survive changing the dither method or amount.
    const colors = new Uint8Array(palette.buffer), result = new Uint32Array(quantized.abuf.slice(0));
    const original = new Uint32Array(source.buffer), exact = new Set(palette);
    const diffusion = settings.dither === 'diffusion', amount = settings.ditherAmount / 100;
    const rowLength = (width + 2) * 4;
    let current = diffusion ? new Float32Array(rowLength) : null;
    let next = diffusion ? new Float32Array(rowLength) : null;
    const pixel = new Float64Array(4);
    const bayer = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
    // A fixed noise sequence keeps size estimates and repeated exports reproducible.
    let noise = 0x6d2b79f5;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const index = y * width + x, offset = index * 4, errorOffset = (x + 1) * 4;
        if (source[offset + 3] === 0) continue;
        if (diffusion && settings.preserveExactColors && exact.has(original[index])) {
          result[index] = original[index];
          continue; // Exact palette colors absorb incoming error to protect lines and text.
        }
        for (let c = 0; c < 4; c++) {
          pixel[c] = Math.max(0, Math.min(255, source[offset + c] + (diffusion ? current[errorOffset + c] : 0)));
        }
        let nearest = quantized.inds[index];
        if (diffusion) {
          let distance = Infinity;
          for (let p = 0; p < palette.length; p++) {
            let squared = 0;
            for (let c = 0; c < 4; c++) squared += (pixel[c] - colors[p * 4 + c]) ** 2;
            if (squared < distance) { distance = squared; nearest = p; }
          }
          for (let c = 0; c < 4; c++) {
            const error = (pixel[c] - colors[nearest * 4 + c]) * amount;
            // Floyd–Steinberg needs only two rows; padding absorbs errors beyond the edges.
            current[errorOffset + 4 + c] += error * 7 / 16;
            next[errorOffset - 4 + c] += error * 3 / 16;
            next[errorOffset + c] += error * 5 / 16;
            next[errorOffset + 4 + c] += error / 16;
          }
        } else {
          // Mix with a nearby palette color in the direction of the missing color.
          // Thresholding the blend avoids adding fixed-strength noise to fine palettes.
          let alternate = nearest, distance = Infinity, blend = 0;
          for (let p = 0; p < palette.length; p++) {
            if (p === nearest) continue;
            let projection = 0, length = 0, squared = 0;
            for (let c = 0; c < 4; c++) {
              const delta = colors[p * 4 + c] - colors[nearest * 4 + c];
              projection += (pixel[c] - colors[nearest * 4 + c]) * delta;
              length += delta * delta;
              squared += (pixel[c] - colors[p * 4 + c]) ** 2;
            }
            if (projection > 0 && squared < distance) {
              distance = squared; alternate = p; blend = Math.min(1, projection / length);
            }
          }
          let threshold;
          if (settings.dither === 'pattern') threshold = (bayer[(y & 3) * 4 + (x & 3)] + 0.5) / 16;
          else {
            noise ^= noise << 13; noise ^= noise >>> 17; noise ^= noise << 5;
            threshold = (noise >>> 0) / 4294967296;
          }
          if (threshold < blend) nearest = alternate;
        }
        result[index] = palette[nearest];
      }
      if (diffusion) { [current, next] = [next, current]; next.fill(0); }
    }
    return result.buffer;
  }
  function convert(image, node, quantized) {
    const settings = Graph.outputSettings(node);
    if (settings.colorMode === 'indexed') {
      return { ...image, width: image.width, height: image.height,
        data: new Uint8ClampedArray(indexedPixels(image, settings, quantized)) };
    }
    if (settings.colorMode === 'grayscale') return { ...image, ...grayscale(image) };
    return image;
  }
  async function encode(image, node, type = format(node).type, { converted = false } = {}) {
    const settings = Graph.outputSettings(node);
    if (!Object.values(formats).some(f => f.type === type)) throw new Error('原地保存仅支持 PNG、JPEG 或 WebP 原图');
    if (settings.colorMode === 'indexed') {
      if (type !== 'image/png') throw new Error('索引颜色只能保存为 PNG；请使用 PNG 原图或指定目录保存');
      // The color limit is 2^bits; PNG packs indices into its legal 1/2/4/8-bit depths.
      // Dither against one fixed palette, then encode those exact colors without requantizing.
      // Keep the original path for "none" so existing pipelines retain their output.
      const rgba = converted || settings.dither === 'none' ? image.data.slice().buffer : indexedPixels(image, settings);
      const colors = !converted && settings.dither === 'none' ? 2 ** settings.indexBits : 0;
      return new Blob([UPNG.encode([rgba], image.width, image.height, colors)], { type });
    }
    if (settings.colorMode === 'grayscale') {
      if (!converted) image = grayscale(image);
      if (type === 'image/png') return new Blob([grayscalePNG(image)], { type });
    }
    const canvas = document.createElement('canvas'); UI.paint(canvas, image);
    // Overwriting retains the existing encoder quality and exposes no compression controls.
    const quality = node.outputMode === 'overwrite' ? 0.95 : settings.quality / 100;
    const result = await new Promise(resolve => canvas.toBlob(resolve, type, quality));
    if (!result || result.type !== type) throw new Error(`浏览器无法编码 ${type}`);
    return result;
  }
  async function estimateSize(image, node, type, options) {
    const blob = await encode(image, node, type, options);
    // The preview contains original pixels, so extrapolate encoded bytes by area.
    const fullArea = (image.fullWidth ?? image.width) * (image.fullHeight ?? image.height);
    return Math.round(blob.size * fullArea / (image.width * image.height));
  }
  return { format, quantize, indexedPixels, convert, encode, estimateSize };
})();
