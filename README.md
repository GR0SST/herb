<img src="assets/icon.svg" width="64" height="64" alt="">

# Herb

**Let your AI agents call your iPhone.** When an agent finds an outage or a security issue, your phone rings like a real call and reads the message aloud.

**[Download on the App Store](https://apps.apple.com/app/herb-agent-calls/id6831210101)** · **[Website](https://herb.grosst.cc)**

- **Real calls:** a native iOS incoming call, even when the app is closed and the phone is locked.
- **On-device voice:** speech is generated on your iPhone. Or skip the message and just ring.
- **Any agent:** ChatGPT, Claude, Grok Bot, Codex, Claude Code or any MCP client, plus a plain HTTP API.
- **Self-hosted if you want:** use the hosted server or [run your own backend](#run-your-own-server).

## Status

Calls are **one-way for now**: your agent speaks and you listen. You cannot talk back yet. **Full duplex calls are planned:** see the [draft protocol](docs/live-calls.md).

The iPhone app is on the [App Store](https://apps.apple.com/app/herb-agent-calls/id6831210101). You can also [build it from source](#build-the-app).

## How it is built

- `ios/`: SwiftUI app (iOS 17+) with CallKit, PushKit and on-device speech.
- `relay/`: Bun server and website for accounts, agents, calls, VoIP push, chat proxy and MCP.
- `plugins/herb/`: plugin for Codex, Claude Code and Grok Bot.

Sign up on the website or in the app. An account is a key, with no email or password. If you lose the key, create a new account. One account can have several phones, and every phone rings.

Full documentation: [herb.grosst.cc/docs](https://herb.grosst.cc/docs), also as [llms.txt](https://herb.grosst.cc/llms.txt) and [llms-full.txt](https://herb.grosst.cc/llms-full.txt) for language models.

## Connect an agent

Add `https://herb.grosst.cc/mcp` to ChatGPT, Claude, Grok Bot or any MCP client. It opens a sign-in page where you enter your key and tap Connect. See [the plugin guide](plugins/herb/README.md).

Over HTTP, with an API token from the website or app:

```sh
# Just ring
curl -X POST https://herb.grosst.cc/v1/call -H "Authorization: Bearer $TOKEN"

# Ring and speak
curl https://herb.grosst.cc/v1/call \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"text":"Production is down. The payments API has been failing for five minutes.","language":"en","title":"Production down","idempotency_key":"incident-2291"}'
```

Instead of `text` you can send `audio_base64` and `audio_mime` (mp3, m4a, aac or wav, up to 10 MB). Status: `GET /v1/calls/<id>`.

Statuses: `ringing`, `answered`, `played`, `ended`, `declined`, `missed`, `failed`. `played` means the message finished playing, not that it was heard. `ended` is for [live calls](docs/live-calls.md).

Limits: 6 calls per minute per agent, 200 calls per day per account, 50 agents per account. Uploaded audio is kept for a day, call history for 30 days.

## Speech

Supertonic 3 runs on the phone: voice Lily (F2), 8 steps, speed 1.2. The app downloads it (about 380 MB) in Settings, so the app itself stays small; until then the iOS voice reads messages. Text is split into phrases. The first is generated while the phone rings, the rest during playback. If the model fails or takes over 10 seconds, the iOS voice reads the text.

The server accepts any text. Agents add stress marks (U+0301) for Russian and Ukrainian, because the voice mispronounces words without them. Without `language` the phone detects the language.

## Build the app

Open `ios/Herb.xcodeproj`, set your team and bundle ID, then run on an iPhone.

## Run your own server

Herb is fully self-hostable. The backend is one Bun process with a SQLite file, and it also serves the website.

```sh
cd relay
bun install
cp .env.example .env
bun run start
```

Put it behind HTTPS and set `HERB_PUBLIC_URL`. On the app's sign-in screen, enter your address under Server. The website is served from the same address. Without `APNS_*` calls ring only while the app is open. `relay/deploy/` has systemd and nginx templates.

Chat connects to your own services, so it is set up on the server only:

```sh
bun run cli agents <account-key>
bun run cli chat <agent-id> --chat-url http://127.0.0.1:8642/v1 --chat-model hermes-agent --chat-key-env HERMES_API_KEY
```

## Tests

```sh
cd relay && bun test && bun run check
```
