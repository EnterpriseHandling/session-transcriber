# Session Transcriber

Turns an audio recording (WAV or MP3) into text **on the device it runs on**.
Built for transcribing recorded sessions on a Chromebook without a subscription
and without uploading anything.

It uses [OpenAI Whisper](https://github.com/openai/whisper) speech models, run in
the browser with [Transformers.js](https://github.com/huggingface/transformers.js).

## How privacy is enforced

| Safeguard | How |
|---|---|
| Audio and text never leave the device | All processing is in the browser. There is no server component. |
| The app cannot contact other websites | A Content-Security-Policy and the service worker refuse every request that is not a plain download of the app's own files. |
| Nothing is stored by the app | The recording and transcript live in memory only. Closing the tab removes them. The app only writes a file when the user presses Save. |
| No third parties at run time | The speech library and models are bundled into the site at build time. No CDN, analytics, fonts or trackers. |
| Works offline | After the first visit the app and the chosen model are kept on the device. |

Every release is tested automatically in headless Chrome (`scripts/test.mjs`): it
transcribes a public-domain sample, confirms no request went to another site,
confirms attempts to send data out are blocked, and repeats the job offline.

This repository contains **code only**. Never commit recordings or transcripts.

## What the app cannot do for you

The app covers the technical side. The person using it is still responsible for
consent, safe storage of the recorder and saved transcripts, removing names, and
deleting material when it is no longer needed. Transcripts contain mistakes and
must be checked against the recording.

## Build

```
npm ci
npm run models   # downloads the pinned Whisper models from Hugging Face (build time only)
npm run build    # writes ./dist
npm test         # end-to-end test in headless Chrome
```

Pushing to `main` runs the same steps on GitHub and publishes `dist` to GitHub Pages.

## Layout

- `site/` — the app: `index.html`, `app.js` (page), `worker.js` (speech engine), `sw.js` (offline + network lock)
- `scripts/` — build, model download, tests
- `tests/` — public-domain sample audio
