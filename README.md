# Session Transcriber

Turns an audio recording (WAV or MP3) into text **on the device it runs on**.
Built for transcribing recorded sessions on a Chromebook without a subscription
and without uploading anything.

It uses [OpenAI Whisper](https://github.com/openai/whisper) speech models, run in
the browser with [Transformers.js](https://github.com/huggingface/transformers.js).

## What it does

- Transcribes a WAV or MP3 file, or a recording made in the app (saved encrypted on the device as it records).
- Three quality settings: Quick draft, Standard and Most accurate (Whisper tiny.en, base.en, small.en).
- Speaker labels: works out who is speaking when and labels each line (Helper / Helpee by default, up to three people).
- Editable transcript: click a time to play from there, Enter splits a line, change who spoke on any line.
- Saves as a branded PDF (one soft colour per speaker, confidential footer) or as plain text.
- Audio settings for choosing headphones and microphone.

## How privacy is enforced

| Safeguard | How |
|---|---|
| Audio and text never leave the device | All processing is in the browser. There is no server component. |
| The app cannot contact other websites | A Content-Security-Policy and the service worker refuse every request that is not a plain download of the app's own files. |
| Very little is stored by the app | Files chosen from a recorder and all transcripts live in memory only. Recordings made in the app are kept on the device, encrypted with a key the browser will not export, until deleted. The only other things remembered are the PDF footer name and audio device choices. |
| No third parties at run time | The speech library, models, PDF library and fonts are bundled into the site at build time. No CDN, analytics or trackers. |
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

## Models and licences

| Part | Model | Source | Licence |
|---|---|---|---|
| Speech to text | OpenAI Whisper tiny.en / base.en / small.en, converted by Xenova | Hugging Face, pinned revisions | Apache-2.0 / MIT |
| Who speaks when | pyannote segmentation 3.0 | sherpa-onnx GitHub release, SHA-256 checked | MIT |
| Voice-prints | WeSpeaker CAM++ (VoxCeleb) | sherpa-onnx GitHub release, SHA-256 checked | CC BY 4.0 |

Libraries: Transformers.js (Apache-2.0), pdf-lib and fontkit (MIT). Fonts: Inter and Fraunces (SIL Open Font Licence).

## Layout

- `site/` — the app: `index.html`, `app.js` (page), `transcript.js` (editable transcript), `recorder.js` (recorder + encrypted storage), `worker.js` (speech engine), `diarize.js` (speaker labels), `pdf.js` (PDF export), `sw.js` (offline + network lock)
- `scripts/` — build, model download, tests
- `tests/` — public-domain sample audio
