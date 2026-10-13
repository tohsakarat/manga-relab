/* Output-only color conversion and encoding; processing images remain RGBA. */
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
  async function encode(image, node, type = format(node).type) {
    const settings = Graph.outputSettings(node);
    if (!Object.values(formats).some(f => f.type === type)) throw new Error('原地保存仅支持 PNG、JPEG 或 WebP 原图');
    if (settings.colorMode === 'indexed') {
      if (type !== 'image/png') throw new Error('索引颜色只能保存为 PNG；请使用 PNG 原图或指定目录保存');
      // The color limit is 2^bits; PNG packs indices into its legal 1/2/4/8-bit depths.
      const rgba = image.data.slice().buffer;
      return new Blob([UPNG.encode([rgba], image.width, image.height, 2 ** settings.indexBits)], { type });
    }
    if (settings.colorMode === 'grayscale') {
      image = grayscale(image);
      if (type === 'image/png') return new Blob([grayscalePNG(image)], { type });
    }
    const canvas = document.createElement('canvas'); UI.paint(canvas, image);
    // Overwriting retains the existing encoder quality and exposes no compression controls.
    const quality = node.outputMode === 'overwrite' ? 0.95 : settings.quality / 100;
    const result = await new Promise(resolve => canvas.toBlob(resolve, type, quality));
    if (!result || result.type !== type) throw new Error(`浏览器无法编码 ${type}`);
    return result;
  }
  return { format, encode };
})();
