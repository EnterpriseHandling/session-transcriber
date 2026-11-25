// Assembles the finished site in ./dist: app files + speech library + models.
import { cp, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, relative } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const dist = join(root, 'dist');
const includeTestModels = process.argv.includes('--test-models');

await rm(dist, { recursive: true, force: true });
await cp(join(root, 'site'), dist, { recursive: true });

// Speech library, copied from the installed npm packages (no CDN at run time).
await mkdir(join(dist, 'vendor'), { recursive: true });
const tf = join(root, 'node_modules/@huggingface/transformers');
const ort = join(root, 'node_modules/onnxruntime-web/dist');
await cp(join(tf, 'dist/transformers.min.js'), join(dist, 'vendor/transformers.min.js'));
await cp(join(tf, 'LICENSE'), join(dist, 'vendor/LICENSE-transformers.txt')).catch(() => {});
await mkdir(join(dist, 'fonts'), { recursive: true });
await cp(join(root, 'node_modules/@fontsource-variable/fraunces/files/fraunces-latin-wght-normal.woff2'), join(dist, 'fonts/fraunces.woff2'));
await cp(join(root, 'node_modules/@fontsource-variable/inter/files/inter-latin-wght-normal.woff2'), join(dist, 'fonts/inter.woff2'));
await cp(join(root, 'node_modules/@fontsource-variable/fraunces/LICENSE'), join(dist, 'fonts/LICENSE-fraunces.txt')).catch(() => {});
await cp(join(root, 'node_modules/@fontsource-variable/inter/LICENSE'), join(dist, 'fonts/LICENSE-inter.txt')).catch(() => {});
for (const f of ['ort-wasm-simd-threaded.asyncify.mjs', 'ort-wasm-simd-threaded.asyncify.wasm']) {
  await cp(join(ort, f), join(dist, 'vendor', f));
}

async function walk(dir) {
  const out = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...await walk(p)); else out.push(p);
  }
  return out.sort();
}

// Models that are present on disk.
const config = JSON.parse(await readFile(join(root, 'scripts/models.config.json'), 'utf8'));
const models = [];
const modelHash = createHash('sha256');
for (const m of config.models) {
  if (m.testOnly && !includeTestModels) continue;
  const src = join(root, 'models', m.id);
  try { await stat(join(src, 'config.json')); } catch (_) { continue; }
  let bytes = 0;
  for (const file of config.files) {
    const s = await stat(join(src, file));
    bytes += s.size;
    modelHash.update(`${m.id}/${file}:${s.size};`);
    await mkdir(join(dist, 'models', m.id, file, '..'), { recursive: true });
    await cp(join(src, file), join(dist, 'models', m.id, file));
  }
  const mb = Math.round(bytes / 1048576);
  models.push({ id: m.id, label: m.label, note: `${m.note} · ${mb} MB one-off download`, english: m.english, default: !!m.default });
}
if (!models.length) throw new Error('No models found in ./models. Run scripts/fetch-models.mjs first.');

// Speaker-labelling models, if present.
let speakers = null;
const speakerFiles = ['segmentation/config.json', 'segmentation/onnx/model.onnx', 'embedding/config.json', 'embedding/onnx/model.onnx'];
try {
  let bytes = 0;
  for (const f of speakerFiles) {
    const src = join(root, 'models/speakers', f);
    const size = (await stat(src)).size;
    bytes += size;
    modelHash.update(`speakers/${f}:${size};`);
    await mkdir(join(dist, 'models/speakers', f, '..'), { recursive: true });
    await cp(src, join(dist, 'models/speakers', f));
  }
  speakers = { mb: Math.round(bytes / 1048576) };
} catch (_) { console.warn('Speaker-labelling models not found: building without speaker labels.'); }
if (!models.some((m) => m.default)) models[0].default = true;

// Version stamp from the app's own files, so an update is picked up automatically.
const shellPaths = (await walk(dist)).filter((p) => !relative(dist, p).startsWith('models/') && !p.endsWith('/sw.js'));
const shellHash = createHash('sha256');
for (const p of shellPaths) shellHash.update(relative(dist, p)).update(await readFile(p));
shellHash.update(await readFile(join(dist, 'sw.js')));
const modelsId = modelHash.digest('hex').slice(0, 10);
shellHash.update(modelsId);
const build = shellHash.digest('hex').slice(0, 10);

await mkdir(join(dist, 'models'), { recursive: true });
await writeFile(join(dist, 'models/manifest.json'), JSON.stringify({ build, models, speakers }, null, 1));

const shellFiles = ['./', ...shellPaths.map((p) => relative(dist, p)).filter((p) => p !== 'index.html'), 'models/manifest.json'];
let sw = await readFile(join(dist, 'sw.js'), 'utf8');
sw = sw.replace("'__BUILD__'", JSON.stringify(build)).replace('__MODELS__', modelsId).replace('__SHELL_FILES__', JSON.stringify(shellFiles));
await writeFile(join(dist, 'sw.js'), sw);
await writeFile(join(dist, '.nojekyll'), '');

console.log(`build ${build} · models ${models.map((m) => m.id).join(', ')} · speaker labels ${speakers ? 'yes' : 'no'}`);
