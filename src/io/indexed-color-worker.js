/* CPU builds UPNG's palette; WebGPU matches pixels and applies independent dithering. */
'use strict';
importScripts('../../vendor/upng/UPNG.js', '../core/gpu-batches.js', 'output-format.js');

function progress(value) { postMessage({ progress: value }); }

function packTree(root) {
  const nodes = [];
  let depth = 1;
  function visit(node, level) {
    depth = Math.max(depth, level);
    const index = nodes.length;
    nodes.push(node);
    node.gpuLeft = node.left ? visit(node.left, level + 1) : 0;
    node.gpuRight = node.right ? visit(node.right, level + 1) : 0;
    return index;
  }
  visit(root, 1);
  const buffer = new ArrayBuffer(nodes.length * 48);
  const floats = new Float32Array(buffer), ints = new Uint32Array(buffer);
  nodes.forEach((node, i) => {
    const at = i * 12;
    floats.set(node.est.e, at);
    floats.set(node.est.q, at + 4);
    floats[at + 8] = node.est.eMq;
    ints[at + 9] = node.gpuLeft; ints[at + 10] = node.gpuRight; ints[at + 11] = node.ind ?? 0;
  });
  return { buffer, depth };
}

function shader(depth) {
  return `
struct Config {
  start: u32, count: u32, offset: u32, width: u32,
  mode: u32, colors: u32, unused0: u32, unused1: u32,
}
struct TreeNode {
  axis: vec4<f32>, mean: vec4<f32>,
  split: f32, left: u32, right: u32, color: u32,
}
@group(0) @binding(0) var<storage, read> source: array<u32>;
@group(0) @binding(1) var<storage, read> seeds: array<vec2<u32>>;
@group(0) @binding(2) var<storage, read> palette: array<u32>;
@group(0) @binding(3) var<storage, read> tree: array<TreeNode>;
@group(0) @binding(4) var<storage, read_write> result: array<vec2<u32>>;
@group(0) @binding(5) var<uniform> config: Config;

fn rgba(color: u32) -> vec4<i32> {
  return vec4<i32>(i32(color & 255u), i32((color >> 8u) & 255u),
    i32((color >> 16u) & 255u), i32(color >> 24u));
}
fn squared(delta: vec4<i32>) -> u32 {
  return u32(delta.x * delta.x + delta.y * delta.y + delta.z * delta.z + delta.w * delta.w);
}
fn nearestByte(pixel: vec4<i32>, seed: u32) -> u32 {
  // Start from the preceding assignment, preserving UPNG's tie rule during k-means.
  var best = seed;
  var distance = squared(pixel - rgba(palette[best]));
  for (var p = 0u; p < config.colors; p++) {
    let d = squared(pixel - rgba(palette[p]));
    if (d < distance) { distance = d; best = p; }
  }
  return best;
}
fn nearestTree(pixel: vec4<f32>) -> u32 {
  var node = 0u;
  var best = 0u;
  var distance = 1e30;
  var pending: array<u32, ${depth}>;
  var bounds: array<f32, ${depth}>;
  var count = 0u;
  loop {
    let entry = tree[node];
    if (entry.left != 0u) {
      let plane = dot(entry.axis, pixel) - entry.split;
      let near = select(entry.left, entry.right, plane > 0.0);
      if (config.mode == 1u) {
        pending[count] = select(entry.right, entry.left, plane > 0.0);
        bounds[count] = plane * plane;
        count++;
      }
      node = near;
      continue;
    }
    if (config.mode == 2u) { return entry.color; }
    let delta = pixel - entry.mean;
    let d = dot(delta, delta);
    if (d < distance) { distance = d; best = entry.color; }
    var found = false;
    loop {
      if (count == 0u) { break; }
      count--;
      if (distance > bounds[count]) { node = pending[count]; found = true; break; }
    }
    if (!found) { break; }
  }
  return best;
}
fn multiplyHigh(a: u32, b: u32) -> u32 {
  // Exact high word: compare noise/2^32 with projection/length without float rounding.
  let a0 = a & 65535u; let a1 = a >> 16u;
  let b0 = b & 65535u; let b1 = b >> 16u;
  let low = a0 * b0;
  let middle = a1 * b0 + (low >> 16u);
  let carry = (middle & 65535u) + a0 * b1;
  return a1 * b1 + (middle >> 16u) + (carry >> 16u);
}
fn dither(pixel: vec4<i32>, nearest: u32, at: u32) -> u32 {
  if (pixel.w == 0) { return nearest; }
  var alternate = nearest;
  var distance = 0xffffffffu;
  var projection = 0u;
  var length = 1u;
  let base = rgba(palette[nearest]);
  for (var p = 0u; p < config.colors; p++) {
    if (p == nearest) { continue; }
    let delta = rgba(palette[p]) - base;
    let missing = pixel - base;
    let projected = missing.x * delta.x + missing.y * delta.y + missing.z * delta.z + missing.w * delta.w;
    let d = squared(pixel - rgba(palette[p]));
    if (projected > 0 && d < distance) {
      distance = d; alternate = p;
      length = squared(delta); projection = min(u32(projected), length);
    }
  }
  if (config.mode == 3u) {
    let bayer = array<u32, 16>(0u, 8u, 2u, 10u, 12u, 4u, 14u, 6u, 3u, 11u, 1u, 9u, 15u, 7u, 13u, 5u);
    let index = config.offset + at;
    let threshold = bayer[((index / config.width) & 3u) * 4u + ((index % config.width) & 3u)];
    if ((threshold * 2u + 1u) * length < projection * 32u) { return alternate; }
  } else if (multiplyHigh(seeds[at].y, length) < projection) { return alternate; }
  return nearest;
}
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) invocation: vec3<u32>) {
  if (invocation.x >= config.count) { return; }
  let at = config.start + invocation.x;
  let pixel = rgba(source[at]);
  var nearest = seeds[at].x;
  if (config.mode == 0u) { nearest = nearestByte(pixel, nearest); }
  else if (config.mode <= 2u) { nearest = nearestTree(vec4<f32>(pixel) / 255.0); }
  else { nearest = dither(pixel, nearest, at); }
  result[at] = vec2<u32>(nearest, palette[nearest]);
}`;
}

async function createMapper(adapter, count, colors, packed) {
  const device = await adapter.requestDevice({
    requiredLimits: { maxStorageBuffersPerShaderStage: 5 },
  });
  const runner = createGPUBatchRunner(device);
  const capacity = Math.min(count, 262144);
  function buffer(size, usage) { return device.createBuffer({ size, usage }); }
  const input = buffer(capacity * 4, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST);
  const seeds = buffer(capacity * 8, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST);
  const palette = buffer(colors.length * 4, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST);
  const tree = buffer(packed.buffer.byteLength, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST);
  const output = buffer(capacity * 8, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC);
  const readback = buffer(capacity * 8, GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST);
  const uniform = buffer(32, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST);
  device.queue.writeBuffer(tree, 0, packed.buffer);
  const module = device.createShaderModule({ code: shader(packed.depth) });
  const compilation = await module.getCompilationInfo();
  const errors = compilation.messages.filter(message => message.type === 'error');
  if (errors.length) {
    runner.close(); device.destroy();
    throw new Error(errors.map(message => `索引预览 WGSL ${message.lineNum}: ${message.message}`).join('\n'));
  }
  const pipeline = await device.createComputePipelineAsync({ layout: 'auto', compute: { module, entryPoint: 'main' } });
  const bindings = device.createBindGroup({ layout: pipeline.getBindGroupLayout(0),
    entries: [input, seeds, palette, tree, output, uniform].map((buffer, binding) => ({ binding, resource: { buffer } })) });
  async function map(image, indices, mode, report) {
    const pixels = new Uint32Array(image.data.buffer, image.data.byteOffset, count);
    const rgba = new Uint32Array(count), assigned = new Uint8Array(count);
    const parameters = new Uint32Array(8), seedData = new Uint32Array(capacity * 2);
    let noise = 0x6d2b79f5;
    device.queue.writeBuffer(palette, 0, colors);
    for (let offset = 0; offset < count; offset += capacity) {
      const length = Math.min(capacity, count - offset);
      for (let i = 0; i < length; i++) {
        seedData[i * 2] = indices ? indices[offset + i] : 0;
        // Noise advances only for pixels with nonzero alpha, exactly as in the CPU loop.
        if (mode === 4 && (pixels[offset + i] >>> 24) !== 0) {
          noise ^= noise << 13; noise ^= noise >>> 17; noise ^= noise << 5;
        }
        seedData[i * 2 + 1] = noise;
      }
      device.queue.writeBuffer(input, 0, pixels.subarray(offset, offset + length));
      device.queue.writeBuffer(seeds, 0, seedData.subarray(0, length * 2));
      parameters.set([0, 0, offset, image.width, mode, colors.length, 0, 0]);
      await runner.run({ count: length, batchSize: 4096, maxBatchSize: 16384,
        submit(start, size) {
          parameters[0] = start; parameters[1] = size;
          device.queue.writeBuffer(uniform, 0, parameters);
          const encoder = device.createCommandEncoder(), pass = encoder.beginComputePass();
          pass.setPipeline(pipeline); pass.setBindGroup(0, bindings);
          pass.dispatchWorkgroups(Math.ceil(size / 64)); pass.end();
          device.queue.submit([encoder.finish()]);
        },
        progress: completed => report((offset + completed) / count),
      });
      const encoder = device.createCommandEncoder();
      encoder.copyBufferToBuffer(output, 0, readback, 0, length * 8);
      device.queue.submit([encoder.finish()]);
      await readback.mapAsync(GPUMapMode.READ);
      const result = new Uint32Array(readback.getMappedRange());
      for (let i = 0; i < length; i++) {
        assigned[offset + i] = result[i * 2]; rgba[offset + i] = result[i * 2 + 1];
      }
      readback.unmap();
    }
    return { inds: assigned, abuf: rgba.buffer };
  }
  return { map, close() { runner.close(); device.destroy(); } };
}

function refinePalette(data, indices, colors) {
  // UPNG accumulates unsigned integer sums and rounds each channel after every iteration.
  const sums = new Uint32Array(colors.length * 4), counts = new Uint32Array(colors.length);
  for (let i = 0; i < indices.length; i++) {
    const color = indices[i], at = i * 4;
    counts[color]++;
    for (let c = 0; c < 4; c++) sums[color * 4 + c] += data[at + c];
  }
  const channels = new Uint8Array(colors.buffer);
  for (let i = 0; i < channels.length; i++) channels[i] = Math.round(sums[i] / counts[i >>> 2]);
}

function mappingError(data, indices, colors) {
  const channels = new Uint8Array(colors.buffer);
  let error = 0;
  for (let i = 0; i < indices.length; i++) {
    const color = indices[i] * 4;
    for (let c = 0; c < 4; c++) error += (data[i * 4 + c] - channels[color + c]) ** 2;
  }
  return error / indices.length;
}

async function quantizeGPU(image, bits, adapter) {
  const data = image.data.slice();
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] === 0) data[i] = data[i + 1] = data[i + 2] = 0;
  }
  // Reuse UPNG's partitioning, population order and palette sizes.
  const [root, leaves] = UPNG.quantize.getKDtree(new Uint8Array(data), 2 ** bits);
  const colors = new Uint32Array(leaves.map(leaf => leaf.est.rgba));
  const mapper = await createMapper(adapter, data.length / 4, colors, packTree(root));
  const source = { ...image, data };
  try {
    const mode = colors.length <= 60 ? 0 : data.length < 32e6 ? 1 : 2;
    let result = await mapper.map(source, null, mode, value => progress(.1 + value * .3));
    // Preserve UPNG's small-image k-means condition, iteration cap and convergence threshold.
    if (data.length * colors.length < 40e6) {
      let previous = 1e9;
      for (let iteration = 0; iteration < 10; iteration++) {
        refinePalette(data, result.inds, colors);
        result = await mapper.map(source, result.inds, 0,
          value => progress(.4 + (iteration + value) * .055));
        const error = mappingError(data, result.inds, colors);
        if (error / previous > .997) break;
        previous = error;
      }
    }
    return { ...result, plte: Array.from(colors, rgba => ({ est: { rgba } })) };
  } finally { mapper.close(); }
}

async function convertGPU(image, settings, quantized, adapter) {
  const colors = new Uint32Array(quantized.plte.map(color => color.est.rgba));
  // Dithering uses only the palette; retain the mapper's binding layout with one unused leaf.
  const mapper = await createMapper(adapter, image.width * image.height, colors,
    { buffer: new ArrayBuffer(48), depth: 1 });
  try {
    const result = await mapper.map(image, quantized.inds, settings.dither === 'pattern' ? 3 : 4, progress);
    return new Uint8ClampedArray(result.abuf);
  } finally { mapper.close(); }
}

onmessage = async ({ data: { operation, image, settings, quantized } }) => {
  try {
    progress(0);
    const gpuOperation = operation === 'quantize' || ['pattern', 'noise'].includes(settings.dither);
    const adapter = gpuOperation && navigator.gpu ? await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' }) : null;
    let result;
    if (operation === 'quantize') {
      result = adapter ? await quantizeGPU(image, settings.indexBits, adapter) : OutputFormat.quantize(image, settings.indexBits);
      progress(1);
      postMessage({ result }, [result.abuf, result.inds.buffer]);
    } else {
      result = adapter ? await convertGPU(image, settings, quantized, adapter)
        : new Uint8ClampedArray(OutputFormat.indexedPixels(image, settings, quantized));
      progress(1);
      postMessage({ result }, [result.buffer]);
    }
  } catch (error) { postMessage({ error: error.message }); }
};
