// One-off: renders icon.svg to the PNG sizes an installable app needs.
import puppeteer from 'puppeteer-core';
import { readFile, writeFile } from 'node:fs/promises';
const root = new URL('..', import.meta.url).pathname;
const svg = await readFile(root + 'site/icon.svg', 'utf8');
const browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', args: ['--no-sandbox'] });
for (const size of [192, 512]) {
  const page = await browser.newPage();
  await page.setViewport({ width: size, height: size });
  await page.setContent(`<body style="margin:0;background:transparent">${svg.replace('<svg ', `<svg width="${size}" height="${size}" `)}</body>`);
  await writeFile(`${root}site/icon-${size}.png`, await page.screenshot({ omitBackground: true }));
}
await browser.close();
