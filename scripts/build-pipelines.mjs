import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));

export async function preinstalledPipelineSource() {
  const directory = join(root, 'src/pipelines');
  const entries = await readdir(directory, { withFileTypes: true });
  const files = entries.filter(entry => entry.isFile() && entry.name.endsWith('.json'))
    .map(entry => entry.name).sort();
  const definitions = await Promise.all(files.map(async file =>
    JSON.parse(await readFile(join(directory, file), 'utf8'))));

  // Embed exported JSON unchanged; runtime imports normalize an independent copy.
  return `/* Generated from all JSON files in src/pipelines; run npm run build:pipelines to update. */
'use strict';
const PreinstalledPipelines = (() => {
  const definitions = ${JSON.stringify(definitions, null, 2)};

  function createCopies() {
    return definitions.map(definition =>
      Store.pipelines.create(definition.name, Graph.importDefinition(definition)));
  }

  return { createCopies };
})();
`;
}

if (resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await writeFile(join(root, 'src/core/preinstalled-pipelines.js'), await preinstalledPipelineSource());
}
