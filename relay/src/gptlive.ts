import { createHash } from "node:crypto";
import type { AskResult, CallControls, CallSetup, EndReason, TranscriptLine, VoiceEngine, VoiceSession } from "./live";

/**
 * GPT-Live as the voice of live calls.
 *
 * The phone connects over WebRTC with an SDP offer that the server exchanges with OpenAI, so the API key
 * never leaves the server. The server then attaches a sideband WebSocket to the same session: it reads
 * transcripts, receives delegations (the voice agent needing the main agent) and pushes context in.
 * Docs: https://developers.openai.com/api/docs/guides/live
 */

const API = "https://api.openai.com/v1/live";
export const GPT_LIVE_MODEL = "gpt-live-1";
/** OpenAI accepts up to 500 tokens per append. Characters are a safe stand-in. */
const MAX_APPEND_CHARS = 1_500;
const CLOSE_WAIT_MS = 5_000;
const FAREWELL_MS = 6_000;
/** The sideband may attach after session.started went by. Then commands go out after this wait. */
const START_FALLBACK_MS = 3_000;
/** The phone only plays audio and shows transcripts. It must not steer the session. */
const PHONE_SERVER_EVENTS = ["session.started", "session.closed", "session.input_transcript.delta", "session.output_transcript.delta", "error"];

const BASE_INSTRUCTIONS = `You are the voice of the user's AI agent in a live phone call.
You are not the agent itself: the main agent works in another place and knows the project, the code and the task.
Keep replies short and spoken, one or two sentences. Never read out code, links or long lists.
When the user asks something you cannot answer from the context below, or asks for any action, delegate it to the main agent and keep talking while it works.
Never claim an action succeeded until the main agent says so.`;

/** The parts of a WebSocket the engine needs, so tests can fake it. */
export interface Socket {
  send(data: string): void;
  close(): void;
  addEventListener(type: "open" | "close" | "error", listener: () => void): void;
  addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
}

export interface GptLiveOptions {
  apiKey: string;
  voice?: string;
  fetchImpl?: typeof fetch;
  connect?: (url: string, headers: Record<string, string>) => Socket;
  /** Log sideband event types, without audio or text. */
  debug?: boolean;
}

const chunks = (text: string) => {
  const parts: string[] = [];
  for (let i = 0; i < text.length; i += MAX_APPEND_CHARS) parts.push(text.slice(i, i + MAX_APPEND_CHARS));
  return parts;
};

export function buildInstructions(setup: CallSetup) {
  const parts = [BASE_INSTRUCTIONS];
  if (setup.instructions) parts.push(`Instructions from the user for this agent:\n${setup.instructions}`);
  if (setup.context) parts.push(`What the main agent told you before the call:\n${setup.context}`);
  parts.push(setup.direction === "outbound"
    ? "The main agent called the user. Open the call with its message."
    : "The user called the main agent.");
  return parts.join("\n\n");
}

export function createGptLive(options: GptLiveOptions): VoiceEngine {
  const fetchImpl = options.fetchImpl ?? fetch;
  const connect = options.connect ?? ((url, headers) => new WebSocket(url, { headers } as unknown as string[]) as unknown as Socket);
  const auth = { authorization: `Bearer ${options.apiKey}` };

  return {
    async open({ bot, setup, controls, body }) {
      const sdp = typeof body.sdp === "string" ? body.sdp : "";
      if (!sdp) throw new Error("SDP offer is missing");
      const response = await fetchImpl(`${API}/sessions`, {
        method: "POST",
        headers: {
          ...auth,
          "content-type": "application/json",
          // Lets OpenAI spot abuse per user without learning who it is. The body field is not accepted everywhere.
          "openai-safety-identifier": createHash("sha256").update(bot.account_id).digest("hex").slice(0, 64),
        },
        body: JSON.stringify({
          session: {
            model: GPT_LIVE_MODEL,
            instructions: buildInstructions(setup),
            audio: { output: { voice: options.voice ?? "marin" } },
            delegation: { type: "client" },
            client: {
              data_channel: {
                allowed_client_events: [],
                allowed_server_events: PHONE_SERVER_EVENTS.map((type) => ({ type })),
              },
            },
          },
          transport: { type: "webrtc", sdp },
        }),
      });
      if (response.status !== 201) throw new Error(`GPT-Live returned ${response.status}: ${(await response.text()).slice(0, 300)}`);
      const created = (await response.json()) as { session: { id: string }; transport: { sdp: string } };
      const sessionId = created.session.id;
      const socket = connect(`${API}/sessions/${encodeURIComponent(sessionId)}/attach`, auth);
      const session = attach(socket, setup, controls, options.debug);
      return { client: { session_id: sessionId, sdp: created.transport.sdp }, session };
    },
  };
}

/** Runs one call over the sideband connection. */
export function attach(socket: Socket, setup: CallSetup, controls: CallControls, debug = false): VoiceSession {
  let open = false;
  let started = false;
  let closing = false;
  let ended = false;
  let counter = 0;
  const outbox: string[] = [];
  /** On attach the sideband replays the last 3 seconds of events. */
  const seen = new Set<string>();
  /** Herb ask id → GPT-Live delegation id. */
  const delegations = new Map<string, string>();
  let speaker: TranscriptLine["role"] | null = null;
  let line = "";
  /** User words since the last delegation: that is what the user asked for. */
  let request = "";

  const send = (event: Record<string, unknown>) => {
    if (debug) console.log(`gpt-live > ${String(event.type)}`);
    const data = JSON.stringify({ event_id: `herb_${++counter}`, ...event });
    if (open && started) socket.send(data);
    else outbox.push(data);
  };
  const append = (type: "commentary" | "thinking" | "instructions", content: string, delegationId: string | null = null) => {
    for (const part of chunks(content)) send({ type: `session.${type}.append`, delegation_id: delegationId, content: part });
  };

  const flushLine = () => {
    if (speaker && line.trim()) controls.transcript({ role: speaker, text: line });
    line = "";
  };
  const hear = (role: TranscriptLine["role"], delta: string) => {
    if (speaker !== role) {
      flushLine();
      speaker = role;
    }
    line += delta;
    if (role === "user") request += delta;
  };

  const finish = (reason: EndReason) => {
    if (ended) return;
    ended = true;
    flushLine();
    controls.end(reason);
  };

  const close = () => {
    if (closing) return;
    closing = true;
    if (debug) console.log("gpt-live > session.close");
    if (open) socket.send(JSON.stringify({ type: "session.close", event_id: `herb_${++counter}` }));
    setTimeout(() => socket.close(), CLOSE_WAIT_MS);
  };

  const respond = (delegationId: string, result: AskResult) => {
    if ("answer" in result) append("commentary", `The main agent answered: ${result.answer}`, delegationId);
    else if ("pending" in result) {
      delegations.set(result.ask_id, delegationId);
      append("commentary", `The main agent is working on it${result.note ? `: ${result.note}` : ""}. Tell the user you will come back with the answer, and keep talking.`, delegationId);
    } else if ("offline" in result) append("commentary", "The main agent is offline right now. Tell the user you cannot reach it.", delegationId);
    else append("commentary", "You cannot ask the main agent more questions until it answers the open ones.", delegationId);
  };

  const delegate = async (delegationId: string) => {
    flushLine();
    const question = request.trim() || "The user wants your help with the last thing they said.";
    request = "";
    respond(delegationId, await controls.ask(question));
  };

  const ready = () => {
    if (started) return;
    started = true;
    for (const queued of outbox.splice(0)) socket.send(queued);
    if (setup.greeting) append("instructions", `Start the call now by saying this, in your own words if needed: ${setup.greeting}`);
  };

  socket.addEventListener("open", () => {
    open = true;
    setTimeout(ready, START_FALLBACK_MS);
  });
  socket.addEventListener("message", ({ data }) => {
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(String(data)) as Record<string, unknown>;
    } catch {
      return;
    }
    if (typeof event.event_id === "string") {
      if (seen.has(event.event_id)) return;
      seen.add(event.event_id);
    }
    if (debug && !String(event.type).endsWith("audio.delta") && !String(event.type).endsWith("audio.append")) {
      const extra = event.type === "session.delegation.created" || event.type === "session.closed" || event.type === "error"
        ? ` ${JSON.stringify(event).slice(0, 400)}`
        : "";
      console.log(`gpt-live < ${String(event.type)}${extra}`);
    }
    switch (event.type) {
      case "session.started":
        ready();
        break;
      case "session.input_transcript.delta":
        hear("user", String(event.delta ?? ""));
        break;
      case "session.output_transcript.delta":
        hear("agent", String(event.delta ?? ""));
        break;
      case "session.delegation.created": {
        const delegation = event.delegation as { id?: string } | undefined;
        if (delegation?.id) void delegate(delegation.id);
        break;
      }
      case "session.closed":
        finish(closing ? "agent_hung_up" : event.reason === "connection_lost" ? "failed" : "user_hung_up");
        socket.close();
        break;
      case "error":
        console.error(`gpt-live error: ${JSON.stringify(event.error ?? event).slice(0, 300)}`);
        break;
    }
  });
  socket.addEventListener("close", () => {
    if (debug) console.log("gpt-live sideband closed");
    finish(closing ? "agent_hung_up" : "failed");
  });
  socket.addEventListener("error", () => console.error("gpt-live sideband error"));

  return {
    say(text, interrupt) {
      if (interrupt) append("instructions", `Stop what you are saying and tell the user now: ${text}`);
      else append("commentary", text);
    },
    addContext(text) {
      append("thinking", text);
    },
    answer(askId, answer) {
      const delegationId = delegations.get(askId) ?? null;
      delegations.delete(askId);
      append("commentary", `The main agent answered: ${answer}`, delegationId);
    },
    askExpired(askId) {
      const delegationId = delegations.get(askId) ?? null;
      delegations.delete(askId);
      append("commentary", "The main agent did not answer in time. Tell the user, and offer to ask again.", delegationId);
    },
    hangup(reason) {
      // The hub ends the call itself right after this: give it the last line, and avoid reporting the end twice.
      flushLine();
      ended = true;
      if (reason === "no_minutes") {
        append("instructions", "The user has run out of call minutes. Say a short goodbye now and mention it.");
        setTimeout(close, FAREWELL_MS);
      } else if (reason === "agent_hung_up") {
        append("instructions", "The main agent is ending the call. Say a short goodbye now.");
        setTimeout(close, FAREWELL_MS);
      } else {
        close();
      }
    },
  };
}
