/* Shared image viewport, independent of the node-canvas zoom. Keeps previews local. */
'use strict';
const Preview = (() => {
  function create(onViewChange, settings) {
    let image = null, scale = 1, centerX = 0, centerY = 0, roi = null, viewVersion = 0;
    const surfaces = new Set(), original = document.createElement('canvas');
    // Read the live editor preferences so changing a limit can refresh the current crop.
    function limit() { return [...surfaces].some(s => !s.primary && !s.node) ? settings.panelPreviewLimit : settings.canvasPreviewLimit; }
    function viewport() {
      if (!image) return null;
      // The open panel owns the crop; the sidebar must not enlarge its visible region.
      const active = [...surfaces].filter(s => !s.primary && !s.node);
      const visible = active.length ? active : [...surfaces];
      const width = Math.max(1, ...visible.map(s => s.element.clientWidth)), height = Math.max(1, ...visible.map(s => s.element.clientHeight));
      const w = Math.min(image.width, Math.ceil(width / scale)), h = Math.min(image.height, Math.ceil(height / scale));
      if (w > limit() || h > limit()) return null;
      const x = Math.max(0, Math.min(image.width - w, Math.floor(centerX - w / 2)));
      const y = Math.max(0, Math.min(image.height - h, Math.floor(centerY - h / 2)));
      return { x, y, w, h };
    }
    function render(targets = surfaces) {
      for (const s of targets) {
        if (s.frozen) continue;
        const { element, canvas, processed } = s;
        canvas.width = Math.max(1, element.clientWidth); canvas.height = Math.max(1, element.clientHeight);
        s.drawnVersion = viewVersion;
        const ctx = canvas.getContext('2d'); ctx.imageSmoothingEnabled = scale < 1;
        if (!image) continue;
        const offsetX = element.clientWidth / 2 - centerX * scale, offsetY = element.clientHeight / 2 - centerY * scale;
        // A transparent result must reveal the viewport background, not the unprocessed image.
        if (!processed && !s.node) ctx.drawImage(original, offsetX, offsetY, image.width * scale, image.height * scale);
        if (processed && roi) {
          const overlay = s.overlay; overlay.width = processed.width; overlay.height = processed.height;
          overlay.getContext('2d').putImageData(new ImageData(processed.data, processed.width, processed.height), 0, 0);
          // Map every result back to source coordinates so resizing preserves the comparison view.
          const scaleX = scale * image.width / processed.fullWidth;
          const scaleY = scale * image.height / processed.fullHeight;
          ctx.drawImage(overlay, offsetX + processed.originX * scaleX, offsetY + processed.originY * scaleY,
            processed.width * scaleX, processed.height * scaleY);
        }
      }
    }
    function changed() { viewVersion++; roi = viewport(); for (const s of surfaces) if (!s.frozen) s.processed = null; render(); onViewChange(); }
    function refresh() {
      if (JSON.stringify(roi) !== JSON.stringify(viewport())) changed();
      else render([...surfaces].filter(s => s.drawnVersion !== viewVersion || s.canvas.width !== Math.max(1, s.element.clientWidth) ||
        s.canvas.height !== Math.max(1, s.element.clientHeight)));
    }
    function zoomTo(value, anchor, surface) {
      if (!image) return;
      const before = scale; scale = Math.max(.05, Math.min(32, value));
      if (anchor && surface) { centerX += anchor.x / before - anchor.x / scale; centerY += anchor.y / before - anchor.y / scale; }
      changed();
    }
    function attach(element, { primary = false, node = false } = {}) {
      const canvas = document.createElement('canvas'), overlay = document.createElement('canvas'); element.append(canvas);
      const status = UI.el('div', 'preview-message'); status.hidden = true; status.setAttribute('role', 'status'); element.append(status);
      const progress = UI.el('progress', 'preview-progress'); progress.max = 1; progress.value = 0; progress.hidden = true;
      progress.setAttribute('aria-label', '预览计算进度'); element.append(progress);
      const surface = { element, canvas, overlay, primary, node, frozen: false, processed: null, drawnVersion: -1 }; surfaces.add(surface);
      element.onwheel = event => {
        event.preventDefault(); event.stopPropagation();
        if (surface.frozen) return;
        const rect = element.getBoundingClientRect();
        // Node previews inherit the graph transform; image gestures use local pixels.
        zoomTo(scale * (event.deltaY < 0 ? 1.2 : 1 / 1.2), {
          x: (event.clientX - rect.left - rect.width / 2) * element.offsetWidth / rect.width,
          y: (event.clientY - rect.top - rect.height / 2) * element.offsetHeight / rect.height,
        }, surface);
      };
      element.onpointerdown = event => {
        event.stopPropagation();
        if (!image || surface.frozen || ![0, 1].includes(event.button)) return;
        event.preventDefault(); element.setPointerCapture(event.pointerId);
        const rect = element.getBoundingClientRect();
        const start = { x: event.clientX, y: event.clientY, cx: centerX, cy: centerY,
          sx: element.offsetWidth / rect.width / scale, sy: element.offsetHeight / rect.height / scale };
        element.classList.add('dragging-preview');
        element.onpointermove = e => {
          e.stopPropagation();
          centerX = Math.max(0, Math.min(image.width, start.cx - (e.clientX - start.x) * start.sx));
          centerY = Math.max(0, Math.min(image.height, start.cy - (e.clientY - start.y) * start.sy)); changed();
        };
        element.onpointerup = element.onpointercancel = element.onlostpointercapture = () => {
          element.onpointermove = null; element.classList.remove('dragging-preview');
        };
      };
      render([surface]);
      return {
        set(result, message = '', value = null) {
          // Progress updates must not redraw an unchanged image or status overlay.
          progress.hidden = value === null || value === 1;
          if (value !== null) progress.value = value;
          if (surface.processed === result && status.textContent === message && surface.drawnVersion === viewVersion) return;
          surface.processed = result; status.textContent = message; status.hidden = !message; render([surface]);
        },
        freeze(value) { surface.frozen = value; if (value) progress.hidden = true; },
        destroy() { surfaces.delete(surface); },
      };
    }
    function load(value, view = {}) {
      image = value; UI.paint(original, image); scale = view.zoom || 1;
      centerX = (view.centerX ?? .5) * image.width; centerY = (view.centerY ?? .5) * image.height; changed();
    }
    function crop() {
      roi = viewport(); if (!roi) return null;
      const crop = original.getContext('2d').getImageData(roi.x, roi.y, roi.w, roi.h);
      return { data: crop.data, width: crop.width, height: crop.height,
        fullWidth: image.width, fullHeight: image.height, originX: roi.x, originY: roi.y };
    }
    function fit() { const s = [...surfaces].find(s => s.primary); if (image && s) { centerX = image.width / 2; centerY = image.height / 2; zoomTo(Math.min(s.element.clientWidth / image.width, s.element.clientHeight / image.height)); } }
    function view() { return { zoom: scale, centerX: image ? centerX / image.width : .5, centerY: image ? centerY / image.height : .5 }; }
    function destroy() { surfaces.clear(); original.width = original.height = 1; image = null; }
    return { attach, load, crop, fit, zoomTo, render, refresh, view, destroy, get image() { return image; }, get roi() { return roi; }, get limit() { return limit(); } };
  }
  return { create };
})();
