import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { transform } from 'esbuild';
import { parse } from 'parse5';
import { minify } from 'terser';
import { preinstalledPipelineSource } from './build-pipelines.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const dist = join(root, 'dist');
const html = await readFile(join(root, 'index.html'), 'utf8');
const document = parse(html, { sourceCodeLocationInfo: true });
const scripts = [], styles = [];

function collect(node) {
  const attributes = Object.fromEntries((node.attrs || []).map(({ name, value }) => [name, value]));
  if (node.tagName === 'script' && attributes.src) {
    scripts.push({ path: attributes.src, location: node.sourceCodeLocation });
  }
  if (node.tagName === 'link' && attributes.rel === 'stylesheet') {
    styles.push({ path: attributes.href, location: node.sourceCodeLocation });
  }
  for (const child of node.childNodes || []) collect(child);
}
collect(document);

let inputBytes = 0;
async function readSource(path) {
  // Release builds always include every current exported JSON, independent of the source snapshot.
  const source = path === 'src/core/preinstalled-pipelines.js'
    ? await preinstalledPipelineSource()
    : await readFile(join(root, path), 'utf8');
  inputBytes += Buffer.byteLength(source);
  return source;
}

async function compressScript({ path }) {
  const source = await readSource(path);
  // Function.toString() supplies editable filter scripts and their Worker helpers.
  // Keep those sources verbatim, including metadata comments and helper names.
  if (path.startsWith('src/filters/') || path === 'src/core/gpu-batches.js') return source;
  const result = await minify(source, {
    ecma: 2022,
    compress: { passes: 2 },
    mangle: false,
    format: { comments: /@license|@preserve|copyright|\blicense\b/i },
  });
  return result.code;
}

const vendorScripts = scripts.filter(script => script.path.startsWith('vendor/'));
const appScripts = scripts.filter(script => !script.path.startsWith('vendor/'));
const [vendorParts, appParts, cssParts] = await Promise.all([
  Promise.all(vendorScripts.map(compressScript)),
  Promise.all(appScripts.map(compressScript)),
  Promise.all(styles.map(style => readSource(style.path))),
]);
const css = await transform(cssParts.join('\n'), {
  loader: 'css',
  minifyWhitespace: true,
  minifySyntax: true,
  minifyIdentifiers: false,
  legalComments: 'inline',
});

function asset(name, extension, content) {
  const hash = createHash('sha256').update(content).digest('hex').slice(0, 12);
  return { path: `assets/${name}.${hash}.${extension}`, content };
}

// Keep third-party scripts outside the application's strict-mode scope.
// Semicolons separate classic scripts; their global names and order stay intact.
const vendor = asset('vendor', 'js', vendorParts.join('\n;\n') + '\n');
const app = asset('app', 'js', "'use strict';\n" + appParts.join('\n;\n') + '\n');
const style = asset('style', 'css', css.code);
const replacements = [];
function replaceTags(tags, markup) {
  tags.forEach(({ location }, index) => replacements.push({
    start: location.startOffset,
    end: location.endOffset,
    content: index === 0 ? markup : '',
  }));
}
replaceTags(vendorScripts, `<script defer src="${vendor.path}"></script>`);
replaceTags(appScripts, `<script defer src="${app.path}"></script>`);
replaceTags(styles, `<link rel="stylesheet" href="${style.path}">`);
let outputHtml = html;
for (const replacement of replacements.sort((a, b) => b.start - a.start)) {
  outputHtml = outputHtml.slice(0, replacement.start) + replacement.content + outputHtml.slice(replacement.end);
}

await rm(dist, { recursive: true, force: true });
await mkdir(join(dist, 'assets'), { recursive: true });
await Promise.all([
  writeFile(join(dist, 'index.html'), outputHtml),
  ...[vendor, app, style].map(({ path, content }) => writeFile(join(dist, path), content)),
]);

const notices = [
  'LICENSE',
  'vendor/LICENSE',
  'vendor/codemirror/LICENSE',
  'vendor/pako/LICENSE',
  'vendor/upng/LICENSE',
  'vendor/upng/README.md',
];
for (const path of notices) {
  await mkdir(dirname(join(dist, path)), { recursive: true });
  await cp(join(root, path), join(dist, path));
}

const outputBytes = [vendor, app, style].reduce((total, item) => total + Buffer.byteLength(item.content), 0);
const kb = bytes => (bytes / 1024).toFixed(1);
console.log(`Built dist/: JS + CSS ${kb(inputBytes)} -> ${kb(outputBytes)} KiB (${(100 * (1 - outputBytes / inputBytes)).toFixed(1)}% smaller)`);
console.log(`Script requests: ${scripts.length} -> 2; stylesheet requests: ${styles.length} -> 1`);
