/* Request upstream pixels in their own coordinates instead of shifting an existing crop. */
'use strict';
const SpatialPreview = (() => {
  function intersection(rect, size) {
    const x = Math.max(0, rect.x), y = Math.max(0, rect.y);
    const right = Math.min(size.width, rect.x + rect.w), bottom = Math.min(size.height, rect.y + rect.h);
    return right > x && bottom > y ? { x, y, w: right - x, h: bottom - y } : null;
  }
  function empty(rect, size) {
    return { data: new Uint8ClampedArray(rect.w * rect.h * 4), width: rect.w, height: rect.h,
      originX: rect.x, originY: rect.y, fullWidth: size.width, fullHeight: size.height };
  }
  function crop(image, rect, size) {
    const output = empty(rect, size), ix = image.originX ?? 0, iy = image.originY ?? 0;
    const left = Math.max(rect.x, ix), top = Math.max(rect.y, iy);
    const right = Math.min(rect.x + rect.w, ix + image.width), bottom = Math.min(rect.y + rect.h, iy + image.height);
    if (right > left) for (let y = top; y < bottom; y++) {
      const src = ((y - iy) * image.width + left - ix) * 4;
      output.data.set(image.data.subarray(src, src + (right - left) * 4), ((y - rect.y) * rect.w + left - rect.x) * 4);
    }
    return output;
  }
  function matches(image, rect) {
    return image && image.originX === rect.x && image.originY === rect.y && image.width === rect.w && image.height === rect.h;
  }
  function viewRect(roi, source, size) {
    const x = Math.floor(roi.x * size.width / source.width), y = Math.floor(roi.y * size.height / source.height);
    return { x, y, w: Math.ceil((roi.x + roi.w) * size.width / source.width) - x,
      h: Math.ceil((roi.y + roi.h) * size.height / source.height) - y };
  }
  async function execute(graph, source, { roi, targets, cache, signal, onNode, onProgress, values = {} }) {
    const validation = Graph.validate(graph, targets);
    if (!validation.valid) throw new Error(validation.errors.join('；'));
    const sizes = Graph.imageSizes(graph, source, validation.active, values), regions = new Map();
    async function evaluate(id, request) {
      if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
      const size = sizes.get(id), rect = intersection(request, size);
      if (!rect) return empty(request, size);
      const existing = cache.get(id);
      if (matches(existing, rect)) return existing;
      const key = `${id}:${rect.x},${rect.y},${rect.w},${rect.h}`;
      if (regions.has(key)) return regions.get(key);
      const n = graph.nodes[id], kind = Graph.geometry(n);
      let output;
      if (n.type === 'input') output = crop(source, rect, size);
      else {
        const edges = n.type === 'merge' ? Graph.inputs(n).map(port => graph.edges.find(e => e.to.nodeId === id && e.to.port === port)) : Graph.imageEdges(graph, n);
        const images = [];
        for (const edge of edges) {
          const upstreamSize = sizes.get(edge.from.nodeId);
          let inputRect = rect;
          if (kind === 'offset') {
            const shift = ScreenOffset.displacement(upstreamSize.width, upstreamSize.height, Graph.params(graph, n, values));
            inputRect = { ...rect, x: rect.x - shift.x, y: rect.y - shift.y };
          } else if (kind === 'resize') {
            const sx = size.width / upstreamSize.width, sy = size.height / upstreamSize.height;
            // The resize kernel must see its original neighbors, including when reducing.
            const radiusX = 2 * Math.max(1, 1 / sx), radiusY = 2 * Math.max(1, 1 / sy);
            const x = Math.floor(rect.x / sx - radiusX), y = Math.floor(rect.y / sy - radiusY);
            inputRect = { x, y, w: Math.ceil((rect.x + rect.w) / sx + radiusX) - x,
              h: Math.ceil((rect.y + rect.h) / sy + radiusY) - y };
          }
          let image = await evaluate(edge.from.nodeId, inputRect);
          // Legacy merge still interpolates equal-sized arrays; align partial edge patches first.
          if (n.type === 'merge') image = crop(image, rect, upstreamSize);
          images.push(image);
        }
        onProgress(n, 0);
        output = await Engine.runNode(graph, n, images, { values, signal, onProgress,
          roi: kind === 'offset' ? rect : undefined });
      }
      if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
      output = matches(output, rect) ? output : crop(output, rect, size);
      regions.set(key, output); onProgress(n, 1);
      return output;
    }
    // Display the same observation area at every node, while offscreen upstream requests
    // stay in this run's region cache and never replace the visible node cache.
    for (const id of Graph.order(graph, validation.active)) {
      const rect = viewRect(roi, source, sizes.get(id));
      if (matches(cache.get(id), rect)) continue;
      const output = await evaluate(id, rect);
      cache.set(id, output); await onNode(graph.nodes[id], output);
    }
    return cache;
  }
  return { execute };
})();
