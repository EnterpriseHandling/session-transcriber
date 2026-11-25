// Downloads the speech models into ./models at build time (run by the GitHub workflow).
// The finished app never contacts these sites: it only reads the copies bundled with it.
import { mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { createWriteStream, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const root = new URL('..', import.meta.url).pathname;
const config = JSON.parse(readFileSync(join(root, 'scripts/models.config.json'), 'utf8'));

async function download(url, dest) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} fetching ${url}`);
  await mkdir(dirname(dest), { recursive: true });
  await pipeline(Readable.fromWeb(res.body), createWriteStream(dest));
  return res;
}
const exists = async (p) => { try { return (await stat(p)).size > 0; } catch (_) { return false; } };
const sha256 = async (p) => createHash('sha256').update(await readFile(p)).digest('hex');

// Speaker-labelling models (GitHub releases, checked against a fixed fingerprint).
for (const [name, spec] of Object.entries(config.speakers || {})) {
  const dir = join(root, 'models/speakers', name);
  const dest = join(dir, 'onnx/model.onnx');
  if (!(await exists(dest)) || (await sha256(dest)) !== spec.sha256) {
    const tmp = await mkdtemp(join(tmpdir(), 'st-model-'));
    const file = join(tmp, 'download');
    await download(spec.url, file);
    let source = file;
    if (spec.member) {
      execFileSync('tar', ['-xjf', file, '-C', tmp, spec.member]);
      source = join(tmp, spec.member);
    }
    const got = await sha256(source);
    if (got !== spec.sha256) throw new Error(`Fingerprint mismatch for ${name}: expected ${spec.sha256}, got ${got}`);
    await mkdir(dirname(dest), { recursive: true });
    await rename(source, dest).catch(async () => { await writeFile(dest, await readFile(source)); });
    await rm(tmp, { recursive: true, force: true });
    console.log('got  speakers', name, (await stat(dest)).size);
  } else console.log('have speakers', name);
  await writeFile(join(dir, 'config.json'), JSON.stringify({ model_type: spec.type }));
  await writeFile(join(dir, 'SOURCE.txt'), `${spec.url}${spec.member ? ` (${spec.member})` : ''}\nsha256 ${spec.sha256}\n`);
}

// Whisper speech-to-text models (Hugging Face, pinned revisions).
for (const model of config.models.filter((m) => !m.testOnly)) {
  let commit = '';
  for (const file of config.files) {
    const dest = join(root, 'models', model.id, file);
    if (await exists(dest)) { console.log('have', model.id, file); continue; }
    const res = await download(`https://huggingface.co/${model.id}/resolve/${model.revision}/${file}`, dest);
    commit = res.headers.get('x-repo-commit') || commit;
    console.log('got ', model.id, file, (await stat(dest)).size);
  }
  if (commit) console.log(`REVISION ${model.id} asked=${model.revision} resolved=${commit}`);
  await writeFile(join(root, 'models', model.id, 'SOURCE.txt'), `https://huggingface.co/${model.id} @ ${model.revision}\n`);
}
