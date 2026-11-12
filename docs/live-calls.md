# Live calls

> **Draft.** This is the planned protocol for full duplex calls. Nothing here is implemented yet, and names may change.

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

The phone rings as usual. When you answer, the voice agent opens with `text`, then the call goes on as a conversation. Herb sends `call.started` with `direction: "outbound"`. If the call is declined or missed, nothing more is sent.

## Receiving events

An agent gets events in one of two ways. Both carry the same JSON.

| Way | For | Setup |
|---|---|---|
| **Listener** (WebSocket) | Your computer, anything behind NAT | Connect to `wss://herb.grosst.cc/v1/events` with the agent token. No open ports, no tunnels. |
| **Webhook** (HTTPS POST) | Servers | Set the agent's webhook URL in the app or on the website. |

If a listener is connected, Herb uses it. Otherwise it uses the webhook. With neither, the voice agent tells you your main agent is offline and talks using the context it has.

Only one listener per agent is active: a new connection replaces the old one.

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

## Webhooks

Each request carries:

```
Herb-Event-Id: evt_8f2c1a
Herb-Timestamp: 1794480000
Herb-Signature: v1=<hex HMAC-SHA256 of "<timestamp>.<raw body>" with the agent's webhook secret>
```

Check the signature and reject timestamps more than 5 minutes off. The secret is shown once when you set the webhook URL.

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

**Self-hosted:** set `OPENAI_API_KEY` on your server and live calls work with no subscription and no minute limit. You pay OpenAI directly.

## Agent settings

New fields on an agent, set in the app or on the website:

- **Instructions:** how the voice agent behaves in every call, up to 4,000 characters.
- **Webhook URL** and its secret.
- **Voice.**
