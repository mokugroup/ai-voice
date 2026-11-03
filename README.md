# MOKU Digital AI Voice

MOKU Digital AI Voice is a real-time voice and text interface for an OpenClaw agent. It uses LiveKit for the room and audio transport, Deepgram for speech recognition and synthesis, and an OpenAI-compatible OpenClaw gateway for reasoning and delegation.

## Included components

- Responsive animated voice interface with live transcripts
- LiveKit room and microphone integration
- Node.js LiveKit voice worker
- Deepgram speech-to-text and text-to-speech
- OpenClaw gateway integration
- Background delegation to specialist agents with visible working and completion states
- Session handoffs so the next voice session can restore recent context
- Text chat fallback
- Docker and Docker Compose configuration
- LiveKit signal and end-to-end test scripts

## Security

This repository contains no credentials. Keep all API keys and tokens in `.env`; environment files, certificates, private keys, runtime data, and local virtual environments are ignored by Git.

Never commit a populated `livekit.yaml`. Copy the placeholder file and replace its values only on the deployment host.

## Setup

```bash
cp .env.example .env
cp livekit.example.yaml livekit.yaml
npm ci
```

Fill in `.env` and `livekit.yaml` with matching LiveKit credentials, then start the stack:

```bash
docker compose up --build -d
```

The web application defaults to `http://127.0.0.1:8080`.

## Local development

Run LiveKit separately, then start the worker and web server in separate terminals:

```bash
node agent.mjs dev
npm run start:web
```

## Tests

Set `VOICE_TEST_ENDPOINT` to the deployed token endpoint and run:

```bash
VOICE_TEST_ENDPOINT=https://voice.example.com/api/livekit-token node test-livekit-e2e.mjs
VOICE_TEST_ENDPOINT=https://voice.example.com/api/livekit-token node test-livekit-signal-handshake.mjs
```

## Architecture

The browser joins a unique LiveKit room for each voice session. The worker joins that room, handles speech and model turns, and can dispatch longer work to OpenClaw agents without blocking the live conversation. Delegation status is sent back over LiveKit data messages, and completed results are spoken into the active room.
