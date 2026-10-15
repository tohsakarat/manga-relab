/* Indexed output previews use full processed pixels, then crop without encoding. */
'use strict';
const OutputPreview = (() => {
  function create(graph) {
    const fullCache = new Map(), outputs = new Map();
    let source = null;
    function invalidate(ids) {
      for (const id of ids) {
        fullCache.delete(id);
        if (!graph.nodes[id]) outputs.delete(id);
      }
    }
    async function render(node, patch, image, { signal, onProgress, onYield }) {
      const settings = Graph.outputSettings(node);
      if (settings.colorMode !== 'indexed') return OutputFormat.convert(patch, node);
      if (source !== image) {
        source = image; fullCache.clear(); outputs.clear();
      }
      // This cache belongs to the full source, never to a viewport or panel.
      await Engine.execute(graph, image, { target: node.id, cache: fullCache, signal,
        onProgress: (_node, value) => onProgress(node, value), onNode: onYield });
      const full = fullCache.get(node.id);
      let entry = outputs.get(node.id);
      if (entry?.source !== full || entry.bits !== settings.indexBits) {
        onProgress(node, 0); await onYield();
        if (signal.aborted) throw new DOMException('Cancelled', 'AbortError');
        const quantized = await IndexedColor.run('quantize', full, settings, { signal,
          onProgress: value => onProgress(node, value) });
        if (signal.aborted) throw new DOMException('Cancelled', 'AbortError');
        entry = { source: full, bits: settings.indexBits, quantized };
        outputs.set(node.id, entry);
      }
      const key = JSON.stringify([settings.dither, settings.ditherAmount, settings.preserveExactColors]);
      if (entry.key !== key) {
        onProgress(node, 0); await onYield();
        if (signal.aborted) throw new DOMException('Cancelled', 'AbortError');
        // Diffusion begins at the full-image origin, so panning never resets its errors.
        const data = settings.dither === 'none' ? new Uint8ClampedArray(entry.quantized.abuf)
          : await IndexedColor.run('convert', full, settings, { quantized: entry.quantized, signal,
            onProgress: value => onProgress(node, value) });
        if (signal.aborted) throw new DOMException('Cancelled', 'AbortError');
        entry.image = { ...full, data };
        entry.key = key;
      }
      return SpatialPreview.crop(entry.image,
        { x: patch.originX, y: patch.originY, w: patch.width, h: patch.height },
        { width: full.width, height: full.height });
    }
    return { render, invalidate };
  }
  return { create };
})();
