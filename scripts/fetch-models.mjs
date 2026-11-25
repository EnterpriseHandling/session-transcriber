// Downloads the speech models into ./models at build time (run by the GitHub workflow).
// The finished app never contacts Hugging Face: it only reads these copies.
import { mkdir, stat, writeFile } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { readFileSync } from 'node:fs';

const root = new URL('..', import.meta.url).pathname;
const config = JSON.parse(readFileSync(join(root, 'scripts/models.config.json'), 'utf8'));

for (const model of config.models.filter((m) => !m.testOnly)) {
  for (const file of config.files) {
    const dest = join(root, 'models', model.id, file);
    try { if ((await stat(dest)).size > 0) { console.log('have', model.id, file); continue; } } catch (_) {}
    const url = `https://huggingface.co/${model.id}/resolve/${model.revision}/${file}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${res.status} fetching ${url}`);
    await mkdir(dirname(dest), { recursive: true });
    await pipeline(Readable.fromWeb(res.body), createWriteStream(dest));
    console.log('got ', model.id, file, (await stat(dest)).size);
  }
  await writeFile(join(root, 'models', model.id, 'SOURCE.txt'), `https://huggingface.co/${model.id} @ ${model.revision}\n`);
}
