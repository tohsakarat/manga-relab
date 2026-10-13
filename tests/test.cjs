'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
for (const file of ['../src/app.js', '../src/filters/algorithm.js']) {
  new vm.Script(fs.readFileSync(path.join(__dirname, file), 'utf8'), { filename: file });
}
require('../src/core/filters.js');
const { apply } = require('../src/filters/algorithm.js');
const width = 48, height = 48;
const clean = new Uint8ClampedArray(width * height * 4);
for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
  const p = (y * width + x) * 4;
  const dx = x % 8 - 4, dy = y % 8 - 4;
  const value = dx * dx + dy * dy <= 4 ? 0 : 255;
  clean[p] = clean[p + 1] = clean[p + 2] = value; clean[p + 3] = 255;
}
const damaged = clean.slice();
for (const [x, y] of [[20, 20], [28, 28]]) {
  const p = (y * width + x) * 4;
  damaged[p] = damaged[p + 1] = damaged[p + 2] = 255;
}
const roi = { x: 12, y: 12, w: 24, h: 24 };
const image = { data: damaged, width, height };
const params = { patch: 4, search: 10, strength: 25 };
let progress = 0;
const unsubscribe = FilterAPI.onProgress(value => { assert.ok(value >= progress); progress = value; });
const { data: output } = apply(image, params, { roi });
unsubscribe();
assert.equal(progress, 1);
assert.equal(output.length, roi.w * roi.h * 4);
let before = 0, after = 0;
for (let y = 0; y < roi.h; y++) for (let x = 0; x < roi.w; x++) {
  const a = ((y + roi.y) * width + x + roi.x) * 4, b = (y * roi.w + x) * 4;
  before += (damaged[a] - clean[a]) ** 2;
  after += (output[b] - clean[a]) ** 2;
  assert.equal(output[b + 3], 255);
}
assert.ok(after < before * .25, `Restoration must reduce error: ${before} -> ${after}`);
const transparent = damaged.slice();
transparent[(20 * width + 20) * 4 + 3] = 0;
const { data: preserved } = apply({ ...image, data: transparent }, params, { roi });
const tp = ((20 - roi.y) * roi.w + 20 - roi.x) * 4;
assert.deepEqual(preserved.slice(tp, tp + 4), transparent.slice((20 * width + 20) * 4, (20 * width + 20) * 4 + 4));
const { data: tiny } = apply({ data: new Uint8ClampedArray([80, 80, 80, 255]), width: 1, height: 1 }, params);
assert.deepEqual([...tiny], [80, 80, 80, 255]);
console.log(`PASS: defect error ${before} -> ${after}; transparency, tiny image, ROI and progress.`);
