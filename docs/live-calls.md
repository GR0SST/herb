# Live calls

> **Draft.** The server side is implemented and runs on [GPT-Live](https://developers.openai.com/api/docs/guides/live). The iPhone app does not support live calls yet. Names may still change.

In a live call you and a voice agent talk at the same time and can interrupt each other. The voice agent runs in Herb. It is not your main agent: it is a front that talks to you and asks your main agent (Codex, Claude Code, OpenClaw, a script, anything) through **events**.

```
iPhone ⇄ voice agent (Herb) ──events──▶ your handler ──▶ your main agent / thread
                 ▲                            │
                 └──── answers, context ──────┘
```

Herb never runs your main agent. You write or install a **handler** that receives events and decides what to do with them. A handler can be a plugin on your computer, a server, a bot or a 20-line script.

## How a call goes

1. A call starts, from the phone or from your agent.
2. Herb sends `call.started`. Your handler replies with context: what the thread is about, what the voice agent should know.
3. During the call the voice agent sends `agent.ask` whenever it needs your main agent. While it waits, it keeps talking with you.
4. Your handler may also push things into the call at any time: say something, add context, hang up.
5. Herb sends `call.ended` with the transcript.

## Starting a call

**You call your agent.** In the app, open an agent and tap Call. Herb sends `call.started` with `direction: "inbound"`.

**Your agent calls you.** Add `"live": true` to a normal call:

```sh
curl https://herb.grosst.cc/v1/call \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"live":true,"title":"Deploy failed","text":"The deploy failed on migrations. Want me to roll back?"}'
```

Add `context` (up to 16,000 characters) with everything the voice agent needs: what happened, what to ask or decide, what you need back. It is not read out. After the call, `GET /v1/calls/<id>` (or `phone_call_status`) returns the `transcript`, so an agent without a handler still gets the result.

The phone rings as usual. When you answer, the voice agent opens with `text`, then the call goes on as a conversation. Herb sends `call.started` with `direction: "outbound"`. If the call is declined or missed, nothing more is sent.

A live call has `"live": true`. It ends with status `ended` (or `failed`) and gets `ended_reason` and `duration_s`. An account has one live call at a time: a second one returns `409 call_in_progress`.

## Receiving events

An agent gets events in one of two ways. Both carry the same JSON.

| Way | For | Setup |
|---|---|---|
| **Listener** (WebSocket) | Your computer, anything behind NAT | Connect to `wss://herb.grosst.cc/v1/events` with the agent token. No open ports, no tunnels. |
| **Webhook** (HTTPS POST) | Servers | Set the agent's webhook URL in the app or on the website. |

If a listener is connected, Herb uses it. Otherwise it uses the webhook. With neither, the voice agent tells you your main agent is offline and talks using the context it has.

Only one listener per agent is active: a new connection replaces the old one, which is closed with code 4000.

Errors from actions sent over the listener come back as `{"type": "error", "call_id": "...", "error": {"code": "...", "message": "..."}}`.

### Event

```json
{
  "id": "evt_8f2c1a",
  "type": "agent.ask",
  "call_id": "c_31d9e0",
  "agent_id": "b_77aa10",
  "created_at": 1794480000000,
  "data": {}
}
```

### Replying

- **Webhook:** return the reply as the JSON response body with status 200. Return 202 or an empty body for no reply.
- **Listener:** send `{"reply_to": "<event id>", ...reply}`.

Replies must arrive within the event's time limit. A late reply is ignored. For slow answers, see [answering later](#answering-later).

## Events

### `call.started`

```json
"data": {
  "direction": "inbound",
  "title": "Deploy failed",
  "text": "The deploy failed on migrations. Want me to roll back?",
  "language": "en"
}
```

`title`, `text` and `language` are set only for outbound calls.

Reply within **3 seconds**, all fields optional:

```json
{
  "context": "Thread: migrating billing to Postgres. Step 4 of 6 failed: column orders.total is null in 212 rows.",
  "instructions": "Be brief. Never confirm a rollback without asking the user twice.",
  "greeting": "Hi, it's your Codex thread about billing."
}
```

- `context`: facts the voice agent should know. Up to 16,000 characters.
- `instructions`: how the voice agent should behave in this call. Added after the agent's saved instructions.
- `greeting`: first line for inbound calls. Without it the voice agent greets on its own.

If there is no reply in time, the call starts anyway, and later context still works through [`/context`](#pushing-into-a-call).

### `agent.ask`

The voice agent needs your main agent: a question it cannot answer, or something the user asked it to do.

```json
"data": {
  "ask_id": "ask_02",
  "question": "Which rows have a null total, and can we fill them from invoices?",
  "transcript": [
    { "role": "agent", "text": "Step four failed on the orders table." },
    { "role": "user", "text": "Can we just fill those from invoices?" }
  ]
}
```

`transcript` holds the recent part of the conversation, so the handler knows what the question is about.

Reply within **5 seconds**:

```json
{ "answer": "All 212 rows have a matching invoice. Filling them is safe." }
```

or tell the voice agent the answer will come later:

```json
{ "pending": true, "note": "Checking invoices, about a minute." }
```

The voice agent tells the user it is checking and keeps talking. An unanswered ask expires after 5 minutes. A call has at most 3 open asks.

### `call.ended`

```json
"data": {
  "reason": "user_hung_up",
  "duration_s": 184,
  "transcript": [
    { "role": "agent", "text": "Hi, it's your Codex thread about billing." },
    { "role": "user", "text": "Fill them from invoices and run the migration again." }
  ]
}
```

`reason`: `user_hung_up`, `agent_hung_up`, `no_minutes`, `failed`. No reply is needed. This is the only event Herb retries (see [Webhooks](#webhooks)).

## Answering later

With the agent token:

```sh
curl https://herb.grosst.cc/v1/calls/c_31d9e0/answers \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"ask_id":"ask_02","answer":"Done. All 212 rows filled, migration passed."}'
```

Over a listener, send `{"type":"answer","call_id":"c_31d9e0","ask_id":"ask_02","answer":"..."}`.

## Pushing into a call

Your handler can act on its own at any time during a call, with the agent token or over the listener (`{"type": "<action>", "call_id": "...", ...}`):

| Request | Listener `type` | Effect |
|---|---|---|
| `POST /v1/calls/{id}/say` `{"text": "...", "interrupt": false}` | `say` | The voice agent tells the user this. With `interrupt: true` it stops talking first. |
| `POST /v1/calls/{id}/context` `{"text": "..."}` | `context` | Adds silent context. The voice agent uses it but does not read it out. |
| `POST /v1/calls/{id}/hangup` | `hangup` | Ends the call. |

These work only on a live call that belongs to the same agent. On an ended call they return `409 call_ended`.

## Answering from another agent

The handler often passes a question on to another agent, which then has to answer. Any agent of the same account can act on the account's live call, and it needs no ids: Herb uses the current call and the oldest open question.

Over MCP (`https://herb.grosst.cc/mcp`):

| Tool | Effect |
|---|---|
| `live_call_status` | The current live call: which agent was called, open questions, recent transcript. |
| `live_call_reply` `{text}` | Answers the open question, or, with none open, the voice agent tells the user. |
| `live_call_context` `{text}` | Adds silent context. |
| `live_call_hang_up` | Ends the call. |
| `phone_call` `{text, live: true}` | Starts a live call to the user. |

Over HTTP, with the agent token:

```sh
curl https://herb.grosst.cc/v1/live/current -H "Authorization: Bearer $TOKEN"
curl https://herb.grosst.cc/v1/live/reply -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" -d '{"text":"All four agents are online."}'
```

`call_id` and `ask_id` are optional in both. Agents of other accounts see no call.

## Webhooks

Each request carries:

```
Herb-Event-Id: evt_8f2c1a
Herb-Timestamp: 1794480000
Herb-Signature: v1=<hex HMAC-SHA256 of "<timestamp>.<raw body>" with the agent's webhook secret>
```

Check the signature and reject timestamps more than 5 minutes off. The secret is shown once when you set the webhook URL.

Requests are also signed the [Standard Webhooks](https://www.standardwebhooks.com) way, which many services check out of the box:

```
webhook-id: evt_8f2c1a
webhook-timestamp: 1794480000
webhook-signature: v1,<base64 HMAC-SHA256 of "<id>.<timestamp>.<raw body>">
```

If the receiving service gives you its own signing secret, such as `whsec_...`, set it with `webhook_secret` together with the URL. A `whsec_` secret is base64-decoded into the HMAC key, as the standard says; any other secret is used as is.

Webhooks must use `https://` and a public address. Redirects are not followed.

`call.started` and `agent.ask` are not retried: by the time a retry arrived, the moment would be gone. `call.ended` is retried after 10 s, 1 min, 10 min and 1 h until a 2xx. Use `Herb-Event-Id` to skip duplicates.

## Example handler

A listener in Bun that answers every question with a fixed reply. Replace `ask` with a call into your own agent.

```ts
const ws = new WebSocket("wss://herb.grosst.cc/v1/events", {
  headers: { Authorization: `Bearer ${process.env.HERB_TOKEN}` },
});

async function ask(question: string): Promise<string> {
  return `You asked: ${question}. I don't know yet.`;
}

ws.onmessage = async ({ data }) => {
  const event = JSON.parse(String(data));
  if (event.type === "call.started") {
    ws.send(JSON.stringify({ reply_to: event.id, context: "This is a test handler." }));
  }
  if (event.type === "agent.ask") {
    ws.send(JSON.stringify({ reply_to: event.id, pending: true }));
    const answer = await ask(event.data.question);
    ws.send(JSON.stringify({ type: "answer", call_id: event.call_id, ask_id: event.data.ask_id, answer }));
  }
};
```

## Minutes

Live calls on the hosted server are paid: a monthly subscription in the iPhone app includes a number of minutes. Minutes are counted on the server from answer to hang-up. When they run out, the voice agent says so and the call ends with `no_minutes`. Calls that fail to start are not counted.

Starting a live call without minutes returns `402 no_minutes`. One-way calls stay free.

The subscription belongs to your Apple ID, not to your key. If you sign in with another key on the phone, the subscription and remaining minutes move to the new account.

**Self-hosted:** set `OPENAI_API_KEY` to turn live calls on. Minutes are off unless you set `HERB_BILLING=true`, so live calls have no limit. You pay the speech model provider directly. With billing on, add minutes with `bun run cli minutes <account-key> <minutes>`. To send webhooks to your own network, set `HERB_ALLOW_PRIVATE_WEBHOOKS=true`.

## Agent settings

Set in the app, on the website, or with a phone token:

```sh
curl -X PATCH https://herb.grosst.cc/v1/bots/<agent id> \
  -H "Authorization: Bearer $PHONE_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"instructions":"Be brief.","webhook_url":"https://example.com/herb"}'
```

- `instructions`: how the voice agent behaves in every call, up to 4,000 characters. `null` clears.
- `webhook_url`: a new URL returns a new `webhook_secret`, shown only in this response. `null` removes the webhook.
- `webhook_secret`: your own signing secret, 8 to 300 characters, instead of a generated one. Needs a webhook URL.

The agent list shows `live.webhook_url`, `live.instructions` and whether a listener is connected (`live.listener`).

## Phone API

For the iPhone app, with a phone token:

| Request | Effect |
|---|---|
| `POST /v1/live` `{"bot_id": "...", "sdp": "<WebRTC offer>"}` | Call an agent. Returns `call` and `voice: {session_id, sdp}` with the WebRTC answer. |
| `POST /v1/calls/{id}/live` `{"sdp": "<WebRTC offer>"}` | Join an agent's live call after answering it. Same response. |
| `POST /v1/calls/{id}/end` | Hang up. |
| `GET /v1/status` | `live.available`, `live.billing`, `live.seconds_left`. |

The VoIP push for a live call has `"live": true`.

The phone connects to GPT-Live over WebRTC: it creates the offer with an `oai-events` data channel and sets the returned SDP as the answer. The OpenAI key stays on the server. The data channel only receives transcripts and session events, and the phone cannot send commands on it. The server controls the session over a sideband connection.
