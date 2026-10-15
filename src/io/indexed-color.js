/* Indexed preview jobs keep palette building and GPU readback off the UI thread. */
'use strict';
const IndexedColor = (() => {
  function run(operation, image, settings, { quantized, signal, onProgress }) {
    if (signal.aborted) return Promise.reject(new DOMException('Cancelled', 'AbortError'));
    return new Promise((resolve, reject) => {
      const worker = new Worker(new URL('src/io/indexed-color-worker.js', document.baseURI));
      function dispose() {
        worker.terminate();
        signal.removeEventListener('abort', cancel);
      }
      function cancel() {
        dispose();
        reject(new DOMException('Cancelled', 'AbortError'));
      }
      signal.addEventListener('abort', cancel, { once: true });
      worker.onmessage = ({ data }) => {
        if ('progress' in data) { onProgress(data.progress); return; }
        dispose();
        if (data.error) reject(new Error(data.error));
        else resolve(data.result);
      };
      worker.onerror = event => { dispose(); reject(new Error(event.message)); };
      // Cached source pixels and quantization must stay usable after cancellation.
      worker.postMessage({ operation, image, settings, quantized });
    });
  }
  return { run };
})();
