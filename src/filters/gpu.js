ScreenFilters.register(function () {
  // ==ScreenFilter==
  // @id denoise
  // @name 降噪
  // @device gpu
  // @param {"key":"patch","label":"图块半径","type":"integer","min":2,"max":8,"step":1,"default":4}
  // @param {"key":"search","label":"搜索半径","type":"integer","min":4,"max":24,"step":1,"default":12}
  // @param {"key":"strength","label":"匹配容差","type":"number","min":5,"max":80,"step":1,"default":25}
  // @input image {data: Uint8ClampedArray RGBA 0..255, width: integer >=1, height: integer >=1}
  // @option roi {x,y,w,h: integer; x,y>=0; w,h>=1; within image}; default: full image
  // @option debug function(message: string, level?: string)
  // @output Promise<{data: Uint8ClampedArray RGBA, width: integer, height: integer}>
  // ==/ScreenFilter==
  'use strict';
  const shader = `
struct Config {
  width: u32,
  height: u32,
  roiX: u32,
  roiY: u32,
  roiWidth: u32,
  roiHeight: u32,
  start: u32,
  count: u32,
  h2: f32,
}
override PATCH: i32 = 4;
override SEARCH: i32 = 12;
@group(0) @binding(0) var<storage, read> source: array<u32>;
@group(0) @binding(1) var<storage, read_write> luma: array<f32>;
@group(0) @binding(2) var<storage, read_write> output: array<u32>;
@group(0) @binding(3) var<uniform> config: Config;

fn rgb(pixel: u32) -> vec3<f32> {
  return vec3<f32>(f32(pixel & 255u), f32((pixel >> 8u) & 255u),
    f32((pixel >> 16u) & 255u));
}

fn sampleIndex(x: i32, y: i32) -> u32 {
  return u32(clamp(y, 0, i32(config.height) - 1)) * config.width
    + u32(clamp(x, 0, i32(config.width) - 1));
}

// Match Uint8ClampedArray's nearest-even rounding.
fn quantizeByte(value: f32) -> u32 {
  let bounded = clamp(value, 0.0, 255.0);
  let low = u32(floor(bounded));
  let fraction = bounded - f32(low);
  return low + select(0u, 1u, fraction > 0.5 || (fraction == 0.5 && (low & 1u) == 1u));
}

@compute @workgroup_size(64)
fn prepare(@builtin(global_invocation_id) id: vec3<u32>) {
  let index = id.x + id.y * 16384u;
  if (index >= config.width * config.height) { return; }
  let color = rgb(source[index]);
  luma[index] = color.r * 0.2126 + color.g * 0.7152 + color.b * 0.0722;
}

@compute @workgroup_size(64)
fn repair(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= config.count) { return; }
  let destination = config.start + id.x;
  let x = i32(config.roiX + destination % config.roiWidth);
  let y = i32(config.roiY + destination / config.roiWidth);
  let center = sampleIndex(x, y);
  let pixel = source[center];
  output[destination] = pixel;
  if ((pixel >> 24u) != 255u) { return; }

  var reference: array<f32, 288>;
  var samples = 0u;
  for (var dy = -PATCH; dy <= PATCH; dy++) {
    for (var dx = -PATCH; dx <= PATCH; dx++) {
      if (dx == 0 && dy == 0) { continue; }
      let index = sampleIndex(x + dx, y + dy);
      if ((source[index] >> 24u) != 255u) { return; }
      reference[samples] = luma[index];
      samples++;
    }
  }

  var distances: array<f32, 12>;
  var indices: array<u32, 12>;
  var count = 0u;
  var cutoff = 6.0 * config.h2;
  for (var cy = max(0, y - SEARCH); cy <= min(i32(config.height) - 1, y + SEARCH); cy++) {
    for (var cx = max(0, x - SEARCH); cx <= min(i32(config.width) - 1, x + SEARCH); cx++) {
      if (cx == x && cy == y) { continue; }
      let candidate = sampleIndex(cx, cy);
      if ((source[candidate] >> 24u) != 255u) { continue; }
      var sum = 0.0;
      var valid = true;
      var k = 0u;
      for (var dy = -PATCH; dy <= PATCH; dy++) {
        for (var dx = -PATCH; dx <= PATCH; dx++) {
          if (dx == 0 && dy == 0) { continue; }
          let index = sampleIndex(cx + dx, cy + dy);
          if ((source[index] >> 24u) != 255u) { valid = false; break; }
          let difference = reference[k] - luma[index];
          sum += min(difference * difference, 10000.0);
          k++;
          if (sum > cutoff * f32(samples)) { valid = false; break; }
        }
        if (!valid) { break; }
      }
      if (!valid) { continue; }
      let distance = sum / f32(samples);
      var at = 0u;
      loop {
        if (at >= count) { break; }
        if (distances[at] > distance) { break; }
        at++;
      }
      // Equal distances keep the original row-major candidate order.
      if (at < 12u) {
        var slot = min(count, 11u);
        while (slot > at) {
          distances[slot] = distances[slot - 1u];
          indices[slot] = indices[slot - 1u];
          slot--;
        }
        distances[at] = distance;
        indices[at] = candidate;
      }
      count = min(count + 1u, 12u);
      if (count == 12u) { cutoff = min(6.0 * config.h2, distances[11]); }
    }
  }

  var color = rgb(pixel);
  if (count > 0u) {
    if (distances[0] < 3.0 * config.h2) {
      var total = 0.35;
      var colors = color * total;
      for (var k = 0u; k < count; k++) {
        let weight = exp(-distances[k] / (config.h2 * 0.25));
        total += weight;
        colors += rgb(source[indices[k]]) * weight;
      }
      color = colors / total;
    }
  }
  let r = quantizeByte(color.r);
  let g = quantizeByte(color.g);
  let b = quantizeByte(color.b);
  output[destination] = r | (g << 8u) | (b << 16u) | (pixel & 0xff000000u);
}
`;

  async function apply({ data, width, height }, { patch, search, strength }, {
    roi = { x: 0, y: 0, w: width, h: height }, debug = () => {},
  } = {}) {
    if (!navigator.gpu) throw new Error('WebGPU 不可用，请用支持 WebGPU 的 Chrome 或 Edge 打开。');
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!adapter) throw new Error('浏览器未提供可用的 WebGPU 设备，请检查硬件加速设置。');
    const info = adapter.info;
    debug(`实际 GPU：vendor=${info.vendor}, architecture=${info.architecture}, device=${info.device}, description=${info.description}`);
    // Size image buffers before requesting device limits.
    const margin = search + patch;
    const left = Math.max(0, roi.x - margin), top = Math.max(0, roi.y - margin);
    const cropWidth = Math.min(width, roi.x + roi.w + margin) - left;
    const cropHeight = Math.min(height, roi.y + roi.h + margin) - top;
    const totalPixels = roi.w * roi.h;
    // Start with a bounded workload; completion timing adjusts subsequent batches.
    const comparisons = ((2 * search + 1) ** 2 - 1) * ((2 * patch + 1) ** 2 - 1);
    const batchSize = Math.max(64, Math.min(16384, Math.floor(100000000 / comparisons / 64) * 64));
    const storageSize = Math.max(cropWidth * cropHeight * 4, totalPixels * 4);
    const bufferSize = storageSize;
    if (storageSize > adapter.limits.maxStorageBufferBindingSize || bufferSize > adapter.limits.maxBufferSize) {
      throw new Error(`整图处理所需缓冲区超过此 GPU 上限：存储绑定需要 ${storageSize} 字节，上限 ${adapter.limits.maxStorageBufferBindingSize}；缓冲区需要 ${bufferSize} 字节，上限 ${adapter.limits.maxBufferSize}。`);
    }
    const device = await adapter.requestDevice({ requiredLimits: {
      maxStorageBufferBindingSize: storageSize,
      maxBufferSize: bufferSize,
    } });
    // The worker's cancel message destroys the device before closing the worker.
    globalThis.filterDevice = device;
    const batchRunner = createGPUBatchRunner(device);
    device.addEventListener('uncapturederror', event => {
      debug(`GPU ${event.error.constructor.name}: ${event.error.message}`, 'error');
    });
    device.lost.then(info => {
      if (info.reason !== 'destroyed') debug(`GPU 设备丢失：${info.reason}，${info.message}`, 'error');
    });
    try {
      // Only upload the region that can influence this selection's matches.
      const pixels = new Uint8Array(cropWidth * cropHeight * 4);
      for (let y = 0; y < cropHeight; y++) {
        const start = ((top + y) * width + left) * 4;
        pixels.set(data.subarray(start, start + cropWidth * 4), y * cropWidth * 4);
      }
      debug(`裁切 ${cropWidth} × ${cropHeight}；选区 ${roi.w} × ${roi.h}；创建缓冲并上传 ${(pixels.byteLength / 1048576).toFixed(2)} MiB`);
      const input = device.createBuffer({ size: pixels.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
      const luma = device.createBuffer({ size: pixels.byteLength, usage: GPUBufferUsage.STORAGE });
      const output = device.createBuffer({ size: totalPixels * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
      const readback = device.createBuffer({ size: totalPixels * 4, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
      const uniform = device.createBuffer({ size: 36, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      device.queue.writeBuffer(input, 0, pixels);
      const parameters = new ArrayBuffer(36);
      const ints = new Uint32Array(parameters), floats = new Float32Array(parameters);
      ints.set([cropWidth, cropHeight, roi.x - left, roi.y - top, roi.w, roi.h]);
      floats[8] = strength * strength;
      device.queue.writeBuffer(uniform, 0, parameters);
      const module = device.createShaderModule({ code: shader });
      const compilation = await module.getCompilationInfo();
      for (const message of compilation.messages) {
        debug(`WGSL ${message.type} ${message.lineNum}:${message.linePos} ${message.message}`);
      }
      const errors = compilation.messages.filter(message => message.type === 'error');
      if (errors.length) throw new Error(errors.map(message => `WGSL ${message.lineNum}: ${message.message}`).join('\n'));
      const layout = device.createBindGroupLayout({ entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
        { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
        { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform', minBindingSize: 36 } },
      ] });
      const pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [layout] });
      const prepare = await device.createComputePipelineAsync({
        layout: pipelineLayout, compute: { module, entryPoint: 'prepare' },
      });
      const pipeline = await device.createComputePipelineAsync({
        layout: pipelineLayout, compute: { module, entryPoint: 'repair', constants: { PATCH: patch, SEARCH: search } },
      });
      const bindings = device.createBindGroup({ layout, entries: [input, luma, output, uniform]
        .map((buffer, binding) => ({ binding, resource: binding === 3 ? { buffer, size: 36 } : { buffer } })) });
      const encoder = device.createCommandEncoder();
      const prepass = encoder.beginComputePass();
      prepass.setPipeline(prepare); prepass.setBindGroup(0, bindings);
      prepass.dispatchWorkgroups(256, Math.ceil(cropWidth * cropHeight / 16384));
      prepass.end();
      device.queue.submit([encoder.finish()]);
      debug(`分批匹配：${totalPixels} 像素，初始每批 ${batchSize} 像素，最多两批在途，按约 16 ms 的完成节奏调整批量`);
      const matchingStart = performance.now();
      let submissions = 0;
      await batchRunner.run({
        count: totalPixels, batchSize, maxBatchSize: 16384,
        submit(start, count) {
          ints[6] = start; ints[7] = count;
          // Queue order keeps this parameter upload before its dispatch and after the preceding dispatch.
          device.queue.writeBuffer(uniform, 0, parameters);
          const matchingEncoder = device.createCommandEncoder();
          const pass = matchingEncoder.beginComputePass();
          pass.setPipeline(pipeline); pass.setBindGroup(0, bindings);
          pass.dispatchWorkgroups(Math.ceil(count / 64)); pass.end();
          device.queue.submit([matchingEncoder.finish()]);
          submissions++;
        },
        progress: completed => FilterAPI.progress(completed / totalPixels),
      });
      debug(`所有匹配已完成：${submissions} 次提交，分批匹配历时 ${(performance.now() - matchingStart).toFixed(1)} ms；回读结果`);
      const copy = device.createCommandEncoder();
      copy.copyBufferToBuffer(output, 0, readback, 0, totalPixels * 4);
      device.queue.submit([copy.finish()]);
      await readback.mapAsync(GPUMapMode.READ);
      FilterAPI.progress(1);
      debug(`匹配提交至回读完成历时 ${(performance.now() - matchingStart).toFixed(1)} ms（含提交、排队、计算与回读）`);
      const result = new Uint8ClampedArray(readback.getMappedRange().slice(0));
      readback.unmap();
      return { data: result, width: roi.w, height: roi.h };
    } finally {
      batchRunner.close();
      device.destroy();
      globalThis.filterDevice = null;
    }
  }

  return { apply };
}, { createGPUBatchRunner });
