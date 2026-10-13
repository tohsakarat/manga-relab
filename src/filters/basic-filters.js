/* GPU filters share execution code; registration embeds it in each editable script. */
(function () {
  'use strict';

  function gpuPrelude() {
    return `
struct Config {
  width: u32, height: u32, x: u32, y: u32,
  roiWidth: u32, roiHeight: u32, extent: u32, start: u32,
  count: u32, padding0: u32, radius: f32, threshold: f32,
}
@group(0) @binding(0) var<storage, read> input: array<u32>;
@group(0) @binding(1) var<storage, read_write> horizontal: array<vec4f>;
@group(0) @binding(2) var<storage, read_write> output: array<u32>;
@group(0) @binding(3) var<storage, read> kernel: array<f32>;
@group(0) @binding(4) var<uniform> config: Config;
fn rgb(pixel: u32) -> vec3f {
  return vec3f(f32(pixel & 255u), f32((pixel >> 8u) & 255u), f32((pixel >> 16u) & 255u));
}
fn samplePixel(x: i32, y: i32) -> u32 {
  let sx = u32(clamp(x, 0, i32(config.width) - 1));
  let sy = u32(clamp(y, 0, i32(config.height) - 1));
  return input[sy * config.width + sx];
}
fn pack(color: vec3f, alpha: u32) -> u32 {
  let bytes = vec3u(round(clamp(color, vec3f(0.0), vec3f(255.0))));
  return bytes.r | (bytes.g << 8u) | (bytes.b << 16u) | (alpha << 24u);
}
`;
  }

  async function runGPU({ data, width, height }, {
    roi, extent, radius = 0, threshold = 0, shader, stages, weights = new Float32Array([1]),
  }) {
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
      FilterAPI.progress(0);
      // Upload the ROI with its sampling margin so region processing retains context.
      const left = Math.max(0, roi.x - extent), top = Math.max(0, roi.y - extent);
      const cropWidth = Math.min(width, roi.x + roi.w + extent) - left;
      const cropHeight = Math.min(height, roi.y + roi.h + extent) - top;
      const pixels = new Uint8Array(cropWidth * cropHeight * 4);
      for (let y = 0; y < cropHeight; y++) {
        const start = ((top + y) * width + left) * 4;
        pixels.set(data.subarray(start, start + cropWidth * 4), y * cropWidth * 4);
      }
      const horizontalCount = roi.w * cropHeight, outputCount = roi.w * roi.h;
      const outputSize = outputCount * 4;
      const input = device.createBuffer({ size: pixels.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
      const horizontal = device.createBuffer({ size: stages.length > 1 ? horizontalCount * 16 : 16, usage: GPUBufferUsage.STORAGE });
      const output = device.createBuffer({ size: outputSize, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
      const readback = device.createBuffer({ size: outputSize, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
      const kernel = device.createBuffer({ size: weights.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
      const uniform = device.createBuffer({ size: 48, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      device.queue.writeBuffer(input, 0, pixels); device.queue.writeBuffer(kernel, 0, weights);
      const parameters = new ArrayBuffer(48), ints = new Uint32Array(parameters), floats = new Float32Array(parameters);
      ints.set([cropWidth, cropHeight, roi.x - left, roi.y - top, roi.w, roi.h, extent]);
      floats[10] = radius; floats[11] = threshold;
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
      const bindings = device.createBindGroup({ layout, entries: [input, horizontal, output, kernel, uniform]
        .map((buffer, binding) => ({ binding, resource: { buffer } })) });
      const work = [];
      for (const stage of stages) {
        const pipeline = await device.createComputePipelineAsync({ layout: pipelineLayout, compute: { module, entryPoint: stage.entryPoint } });
        work.push({ ...stage, pipeline, count: stage.horizontal ? horizontalCount : outputCount });
      }
      // Weight passes by sample count and reserve the final portion for readback.
      const totalWork = work.reduce((sum, stage) => sum + stage.count * stage.cost, outputCount);
      let completed = 0;
      for (const stage of work) {
        // Start from kernel cost, then adjust from actual completion throughput.
        const batchSize = Math.max(1, Math.min(65536, Math.floor(4000000 / stage.cost)));
        await batchRunner.run({
          count: stage.count, batchSize, minBatchSize: 1, maxBatchSize: 65536,
          submit(start, count) {
            ints[7] = start; ints[8] = count;
            // Uploads and dispatches share queue order, so later parameters cannot overtake this batch.
            device.queue.writeBuffer(uniform, 0, parameters);
            const encoder = device.createCommandEncoder(), pass = encoder.beginComputePass();
            pass.setPipeline(stage.pipeline); pass.setBindGroup(0, bindings);
            pass.dispatchWorkgroups(Math.ceil(count / 64)); pass.end();
            device.queue.submit([encoder.finish()]);
          },
          progress: stageCompleted => FilterAPI.progress((completed + stageCompleted * stage.cost) / totalWork),
        });
        // The next pass reads this pass's output, so finish the stage before starting it.
        completed += stage.count * stage.cost;
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

  ScreenFilters.register(function () {
    // ==ScreenFilter==
    // @id surface-blur
    // @name 表面模糊
    // @device gpu
    // @param {"key":"radius","label":"半径（像素）","type":"number","min":1,"max":100,"step":1,"default":5}
    // @param {"key":"threshold","label":"阈值（色阶）","type":"integer","min":2,"max":255,"step":1,"default":15}
    // ==/ScreenFilter==
    const shader = gpuPrelude() + `
@compute @workgroup_size(64)
fn surfaceBlur(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= config.count) { return; }
  let index = config.start + id.x;
  let x = i32(index % config.roiWidth + config.x);
  let y = i32(index / config.roiWidth + config.y);
  let original = samplePixel(x, y);
  let center = rgb(original);
  var sum = vec3f(0.0);
  var weight = vec3f(0.0);
  // Compare every sample with the original center, keeping sharp edges out of the average.
  for (var dy = -i32(config.extent); dy <= i32(config.extent); dy++) {
    let span = i32(floor(sqrt(f32(config.extent * config.extent) - f32(dy * dy))));
    for (var dx = -span; dx <= span; dx++) {
      let pixel = samplePixel(x + dx, y + dy);
      let color = rgb(pixel);
      let alpha = f32(pixel >> 24u) / 255.0;
      let accepted = abs(color - center) <= vec3f(config.threshold);
      let sampleWeight = select(vec3f(0.0), vec3f(alpha), accepted);
      sum += color * sampleWeight;
      weight += sampleWeight;
    }
  }
  // Ignore transparent RGB during averaging and keep the center's original opacity.
  let color = select(center, sum / max(weight, vec3f(0.000001)), weight > vec3f(0.0));
  output[index] = pack(color, original >> 24u);
}
`;
    function apply(image, { radius, threshold }, { roi = { x: 0, y: 0, w: image.width, h: image.height } } = {}) {
      const extent = Math.round(radius), diameter = extent * 2 + 1;
      return runGPU(image, { roi, extent, threshold, shader, stages: [
        { entryPoint: 'surfaceBlur', cost: diameter * diameter },
      ] });
    }
    return { apply };
  }, { gpuPrelude, runGPU, createGPUBatchRunner });

  function morphologyShader(maximum) {
    const combine = maximum ? 'max' : 'min', initial = maximum ? '0.0' : '255.0';
    return gpuPrelude() + `
@compute @workgroup_size(64)
fn squareHorizontal(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= config.count) { return; }
  let index = config.start + id.x;
  let x = i32(index % config.roiWidth + config.x);
  let y = i32(index / config.roiWidth);
  var color = vec3f(${initial});
  for (var offset = -i32(config.extent); offset <= i32(config.extent); offset++) {
    color = ${combine}(color, rgb(samplePixel(x + offset, y)));
  }
  horizontal[index] = vec4f(color, 0.0);
}
@compute @workgroup_size(64)
fn squareFinish(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= config.count) { return; }
  let index = config.start + id.x;
  let x = index % config.roiWidth;
  let y = i32(index / config.roiWidth + config.y);
  var color = vec3f(${initial});
  for (var offset = -i32(config.extent); offset <= i32(config.extent); offset++) {
    let sy = u32(clamp(y + offset, 0, i32(config.height) - 1));
    color = ${combine}(color, horizontal[sy * config.roiWidth + x].rgb);
  }
  let original = samplePixel(i32(x + config.x), y);
  output[index] = pack(color, original >> 24u);
}
@compute @workgroup_size(64)
fn roundFinish(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= config.count) { return; }
  let index = config.start + id.x;
  let x = i32(index % config.roiWidth + config.x);
  let y = i32(index / config.roiWidth + config.y);
  let lowerRadius = floor(config.radius);
  let upperRadius = ceil(config.radius);
  var lower = vec3f(${initial});
  var upper = vec3f(${initial});
  // Interpolate adjacent disk footprints so fractional radii change the result.
  for (var dy = -i32(config.extent); dy <= i32(config.extent); dy++) {
    let span = i32(floor(sqrt(max(0.0, upperRadius * upperRadius - f32(dy * dy)))));
    for (var dx = -span; dx <= span; dx++) {
      let color = rgb(samplePixel(x + dx, y + dy));
      upper = ${combine}(upper, color);
      if (f32(dx * dx + dy * dy) <= lowerRadius * lowerRadius) {
        lower = ${combine}(lower, color);
      }
    }
  }
  let color = mix(lower, upper, vec3f(fract(config.radius)));
  output[index] = pack(color, samplePixel(x, y) >> 24u);
}
`;
  }

  function applyMorphology(image, { radius, preserveShape }, options, maximum) {
    const roi = options.roi || { x: 0, y: 0, w: image.width, h: image.height };
    const roundness = preserveShape === '圆度';
    // Squareness uses whole pixels, including when its radius comes from an exposed input.
    const extent = roundness ? Math.ceil(radius) : Math.max(1, Math.round(radius));
    const diameter = extent * 2 + 1;
    return runGPU(image, { roi, extent, radius, shader: morphologyShader(maximum), stages: roundness ? [
      { entryPoint: 'roundFinish', cost: diameter * diameter },
    ] : [
      { entryPoint: 'squareHorizontal', horizontal: true, cost: diameter },
      { entryPoint: 'squareFinish', cost: diameter },
    ] });
  }

  ScreenFilters.register(function () {
    // ==ScreenFilter==
    // @id maximum
    // @name 最大值
    // @device gpu
    // @param {"key":"radius","label":"半径（像素）","type":"number","min":0.2,"max":500,"step":0.1,"default":1,"integerWhen":{"key":"preserveShape","value":"方形"}}
    // @param {"key":"preserveShape","label":"保留","type":"enum","values":["方形","圆度"],"default":"方形"}
    // ==/ScreenFilter==
    function apply(image, params, options = {}) { return applyMorphology(image, params, options, true); }
    return { apply };
  }, { gpuPrelude, runGPU, morphologyShader, applyMorphology, createGPUBatchRunner });

  ScreenFilters.register(function () {
    // ==ScreenFilter==
    // @id minimum
    // @name 最小值
    // @device gpu
    // @param {"key":"radius","label":"半径（像素）","type":"number","min":0.2,"max":500,"step":0.1,"default":1,"integerWhen":{"key":"preserveShape","value":"方形"}}
    // @param {"key":"preserveShape","label":"保留","type":"enum","values":["方形","圆度"],"default":"方形"}
    // ==/ScreenFilter==
    function apply(image, params, options = {}) { return applyMorphology(image, params, options, false); }
    return { apply };
  }, { gpuPrelude, runGPU, morphologyShader, applyMorphology, createGPUBatchRunner });

  ScreenFilters.register(function () {
    // ==ScreenFilter==
    // @id find-edges
    // @name 查找边缘
    // @device gpu
    // ==/ScreenFilter==
    const shader = gpuPrelude() + `
@compute @workgroup_size(64)
fn findEdges(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= config.count) { return; }
  let index = config.start + id.x;
  let x = i32(index % config.roiWidth + config.x);
  let y = i32(index / config.roiWidth + config.y);
  let tl = rgb(samplePixel(x - 1, y - 1));
  let tc = rgb(samplePixel(x, y - 1));
  let tr = rgb(samplePixel(x + 1, y - 1));
  let ml = rgb(samplePixel(x - 1, y));
  let mr = rgb(samplePixel(x + 1, y));
  let bl = rgb(samplePixel(x - 1, y + 1));
  let bc = rgb(samplePixel(x, y + 1));
  let br = rgb(samplePixel(x + 1, y + 1));
  let gx = tr + 2.0 * mr + br - tl - 2.0 * ml - bl;
  let gy = bl + 2.0 * bc + br - tl - 2.0 * tc - tr;
  let color = vec3f(255.0) - sqrt(gx * gx + gy * gy);
  output[index] = pack(color, samplePixel(x, y) >> 24u);
}
`;
    function apply(image, params, { roi = { x: 0, y: 0, w: image.width, h: image.height } } = {}) {
      return runGPU(image, { roi, extent: 1, shader, stages: [{ entryPoint: 'findEdges', cost: 9 }] });
    }
    return { apply };
  }, { gpuPrelude, runGPU, createGPUBatchRunner });
})();
