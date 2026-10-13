ScreenFilters.register(function () {
  // ==ScreenFilter==
  // @id sharpen
  // @name USM 锐化
  // @device gpu
  // @param {"key":"amount","label":"数量（%）","type":"number","min":1,"max":500,"step":1,"default":100}
  // @param {"key":"radiusPercent","label":"半径（图像长边 %）","type":"number","min":0.01,"max":10,"step":0.01,"default":0.1}
  // @param {"key":"threshold","label":"阈值（色阶）","type":"integer","min":0,"max":255,"step":1,"default":0}
  // @input image {data: Uint8ClampedArray RGBA 0..255, width: integer >=1, height: integer >=1}
  // @option roi {x,y,w,h: integer; x,y>=0; w,h>=1; within image}; default: full image
  // @output Promise<{data: Uint8ClampedArray RGBA, width: integer, height: integer}>
  // ==/ScreenFilter==
  'use strict';
  const shader = `
struct Config {
  width: u32, height: u32, x: u32, y: u32,
  roiWidth: u32, roiHeight: u32, extent: u32, start: u32,
  count: u32, gain: f32, threshold: f32, padding: u32,
}
@group(0) @binding(0) var<storage, read> input: array<u32>;
@group(0) @binding(1) var<storage, read_write> horizontal: array<vec4f>;
@group(0) @binding(2) var<storage, read_write> output: array<u32>;
@group(0) @binding(3) var<storage, read> kernel: array<f32>;
@group(0) @binding(4) var<uniform> config: Config;
fn unpack(pixel: u32) -> vec4f {
  return vec4f(f32(pixel & 255u), f32((pixel >> 8u) & 255u),
    f32((pixel >> 16u) & 255u), f32(pixel >> 24u) / 255.0);
}
@compute @workgroup_size(64)
fn blurHorizontal(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= config.count) { return; }
  let index = config.start + id.x;
  let x = index % config.roiWidth + config.x;
  let y = index / config.roiWidth;
  var blurred = vec4f(0.0);
  for (var offset = -i32(config.extent); offset <= i32(config.extent); offset++) {
    let sx = u32(clamp(i32(x) + offset, 0, i32(config.width) - 1));
    let pixel = unpack(input[y * config.width + sx]);
    let weight = kernel[u32(offset + i32(config.extent))] * pixel.a;
    blurred += vec4f(pixel.rgb, 1.0) * weight;
  }
  horizontal[index] = blurred;
}
@compute @workgroup_size(64)
fn finish(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= config.count) { return; }
  let index = config.start + id.x;
  let x = index % config.roiWidth;
  let y = index / config.roiWidth + config.y;
  let packed = input[y * config.width + x + config.x];
  output[index] = packed;
  if ((packed >> 24u) != 255u) { return; }
  var blurred = vec4f(0.0);
  for (var offset = -i32(config.extent); offset <= i32(config.extent); offset++) {
    let sy = u32(clamp(i32(y) + offset, 0, i32(config.height) - 1));
    blurred += horizontal[sy * config.roiWidth + x] * kernel[u32(offset + i32(config.extent))];
  }
  let pixel = unpack(packed);
  let detail = pixel.rgb - blurred.rgb / blurred.a;
  let color = clamp(pixel.rgb + select(vec3f(0.0), detail * config.gain,
    abs(detail) >= vec3f(config.threshold)), vec3f(0.0), vec3f(255.0));
  let bytes = vec3u(round(color));
  output[index] = bytes.r | (bytes.g << 8u) | (bytes.b << 16u) | (packed & 0xff000000u);
}
`;
  async function apply({ data, width, height }, { amount, radiusPercent, threshold }, {
    roi = { x: 0, y: 0, w: width, h: height },
  } = {}) {
    if (!navigator.gpu) throw new Error('WebGPU 不可用，请用支持 WebGPU 的 Chrome 或 Edge 打开。');
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!adapter) throw new Error('浏览器未提供可用的 WebGPU 设备，请检查硬件加速设置。');
    const device = await adapter.requestDevice({ requiredLimits: {
      maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize,
      maxBufferSize: adapter.limits.maxBufferSize,
    } });
    globalThis.filterDevice = device;
    const batchRunner = createGPUBatchRunner(device);
    try {
      const radius = Math.max(width, height) * radiusPercent / 100;
      const extent = Math.ceil(radius * 3);
      const weights = new Float32Array(extent * 2 + 1);
      let total = 0;
      for (let offset = -extent; offset <= extent; offset++) {
        const weight = Math.exp(-offset * offset / (2 * radius * radius));
        weights[offset + extent] = weight; total += weight;
      }
      for (let i = 0; i < weights.length; i++) weights[i] /= total;
      // Region processing retains context; radius always uses the full image.
      const left = Math.max(0, roi.x - extent), top = Math.max(0, roi.y - extent);
      const cropWidth = Math.min(width, roi.x + roi.w + extent) - left;
      const cropHeight = Math.min(height, roi.y + roi.h + extent) - top;
      const pixels = new Uint8Array(cropWidth * cropHeight * 4);
      for (let y = 0; y < cropHeight; y++) {
        const start = ((top + y) * width + left) * 4;
        pixels.set(data.subarray(start, start + cropWidth * 4), y * cropWidth * 4);
      }
      const input = device.createBuffer({ size: pixels.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
      const horizontal = device.createBuffer({ size: roi.w * cropHeight * 16, usage: GPUBufferUsage.STORAGE });
      const outputSize = roi.w * roi.h * 4;
      const output = device.createBuffer({ size: outputSize, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
      const readback = device.createBuffer({ size: outputSize, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
      const kernel = device.createBuffer({ size: weights.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
      const uniform = device.createBuffer({ size: 48, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      device.queue.writeBuffer(input, 0, pixels); device.queue.writeBuffer(kernel, 0, weights);
      const parameters = new ArrayBuffer(48);
      const ints = new Uint32Array(parameters), floats = new Float32Array(parameters);
      ints.set([cropWidth, cropHeight, roi.x - left, roi.y - top, roi.w, roi.h, extent]);
      floats[9] = amount / 100; floats[10] = threshold;
      const module = device.createShaderModule({ code: shader });
      const compilation = await module.getCompilationInfo();
      const errors = compilation.messages.filter(message => message.type === 'error');
      if (errors.length) throw new Error(errors.map(message => `WGSL ${message.lineNum}: ${message.message}`).join('\n'));
      const layout = device.createBindGroupLayout({ entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
        { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
        { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
        { binding: 4, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
      ] });
      const pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [layout] });
      const blur = await device.createComputePipelineAsync({ layout: pipelineLayout, compute: { module, entryPoint: 'blurHorizontal' } });
      const finish = await device.createComputePipelineAsync({ layout: pipelineLayout, compute: { module, entryPoint: 'finish' } });
      const bindings = device.createBindGroup({ layout, entries: [input, horizontal, output, kernel, uniform]
        .map((buffer, binding) => ({ binding, resource: { buffer } })) });
      const horizontalCount = roi.w * cropHeight, outputCount = roi.w * roi.h;
      const workCount = horizontalCount + outputCount;
      // Start from kernel cost; each pass adjusts batch size from completion timing.
      const batchSize = Math.max(64, Math.min(65536, Math.floor(4000000 / weights.length / 64) * 64));
      let completed = 0;
      for (const [pipeline, count] of [[blur, horizontalCount], [finish, outputCount]]) {
        await batchRunner.run({
          count, batchSize, maxBatchSize: 65536,
          submit(start, batchCount) {
            ints[7] = start; ints[8] = batchCount;
            // Queue ordering preserves each batch's parameters with two submissions in flight.
            device.queue.writeBuffer(uniform, 0, parameters);
            const encoder = device.createCommandEncoder();
            const pass = encoder.beginComputePass();
            pass.setPipeline(pipeline); pass.setBindGroup(0, bindings);
            pass.dispatchWorkgroups(Math.ceil(batchCount / 64));
            pass.end(); device.queue.submit([encoder.finish()]);
          },
          progress: stageCompleted => FilterAPI.progress((completed + stageCompleted) / workCount),
        });
        // Finish horizontal results before the vertical pass starts reading them.
        completed += count;
      }
      const encoder = device.createCommandEncoder();
      encoder.copyBufferToBuffer(output, 0, readback, 0, outputSize);
      device.queue.submit([encoder.finish()]);
      await readback.mapAsync(GPUMapMode.READ);
      const result = new Uint8ClampedArray(readback.getMappedRange().slice(0));
      readback.unmap(); FilterAPI.progress(1);
      return { data: result, width: roi.w, height: roi.h };
    } finally {
      batchRunner.close();
      device.destroy(); globalThis.filterDevice = null;
    }
  }
  return { apply };
}, { createGPUBatchRunner });
