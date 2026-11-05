<img src="assets/icon.svg" width="64" height="64" alt="">

# Herb

An iPhone app that lets your AI agents call you. Agents ring your phone like a real call and can speak a message. Agents with an API also get a chat.

- `ios/`: SwiftUI app (iOS 17+) with CallKit, PushKit and on-device speech.
- `relay/`: Bun server for accounts, agents, calls, VoIP push, chat proxy and MCP.
- `plugins/herb/`: plugin for Codex, Claude Code and Grok Bot.

Every account gets its own agents and call history. An account is created on first launch and belongs to that phone: there is no sign-up.

## Connect an agent

See [the plugin guide](plugins/herb/README.md). Any MCP client works with `https://herb.grosst.cc/mcp`.

Over HTTP, with an API token from the app:

```sh
# Just ring
curl -X POST https://herb.grosst.cc/v1/call -H "Authorization: Bearer $TOKEN"

# Ring and speak
curl https://herb.grosst.cc/v1/call \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"text":"Пора́ встава́ть","language":"ru","title":"Wake up","idempotency_key":"wake-2026-11-05"}'
```

Instead of `text` you can send `audio_base64` and `audio_mime` (mp3, m4a, aac or wav, up to 10 MB). Status: `GET /v1/calls/<id>`.

Statuses: `ringing`, `answered`, `played`, `declined`, `missed`, `failed`. `played` means the message finished playing, not that it was heard.

Limits: 6 calls per minute per agent, 200 calls per day per account, 50 agents per account. Uploaded audio is kept for a day, call history for 30 days.

## Speech

Supertonic 3 runs on the phone: voice Lily (F2), 8 steps, speed 1.2. Text is split into phrases. The first is generated while the phone rings, the rest during playback. If the model fails or takes over 10 seconds, the iOS voice reads the text.

The server accepts any text. Agents add stress marks (U+0301) for Russian and Ukrainian, because the voice mispronounces words without them. Without `language` the phone detects the language.

## Build the app

The model weights (about 380 MB) are not in Git:

```sh
bun run ios/scripts/fetch-models.ts
```

Open `ios/Herb.xcodeproj`, set your team and bundle ID, then run on an iPhone.

## Run your own server

```sh
cd relay
bun install
cp .env.example .env
bun run start
```

Put it behind HTTPS and set `HERB_PUBLIC_URL`. In the app, open Settings, Server and enter your address. Without `APNS_*` calls ring only while the app is open. `relay/deploy/` has systemd and nginx templates.

Chat connects to your own services, so it is set up on the server only:

```sh
bun run cli device list
bun run cli bot chat <device> <agent> --chat-url http://127.0.0.1:8642/v1 --chat-model hermes-agent --chat-key-env HERMES_API_KEY
```

## Tests

```sh
cd relay && bun test && bun run check
```
