import type { Bot } from "./db";

export const MCP_TOOLS = [
  {
    name: "phone_call",
    title: "Call my phone",
    annotations: { title: "Call my phone", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    description:
      "Call the user's iPhone. Two modes. Message (default): the phone speaks text after they answer, or just rings without text; the user cannot reply. Conversation (live: true, where enabled): a voice agent talks with the user on your behalf, opens with text, works towards the goal in context, asks and clarifies, and passes questions back to you while the call runs; afterwards phone_call_status returns the transcript. Call only when the user asked or set up the rule in advance.",
    inputSchema: {
      type: "object",
      properties: {
        text: {
          type: "string",
          description: "Optional text to speak, up to 2000 characters. Omit it to just ring. For Russian and Ukrainian, put U+0301 after the stressed vowel in every multisyllabic word: Напомина́ю, пора́ сде́лать пере́рыв. Write numbers and abbreviations as words.",
        },
        language: { type: "string", description: "Language code of the text: ru, uk, en and others. Without it the phone guesses." },
        title: { type: "string", description: "Short call subject." },
        idempotency_key: { type: "string", description: "One key per event, so a retry does not ring twice." },
        live: {
          type: "boolean",
          description: "true for a conversation instead of a message. Only where live calls are enabled for the user.",
        },
        context: {
          type: "string",
          description: "Conversation only: everything the voice agent needs, up to 16000 characters. What happened, what to ask or decide with the user, what you need back. The user does not hear it read out.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "live_call_status",
    title: "See the live call",
    annotations: { title: "See the live call", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    description:
      "The user's current live phone call, if any: which agent they called, the questions the voice agent is waiting on, and the recent transcript. Use it to get context before replying.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "live_call_reply",
    title: "Reply in the live call",
    annotations: { title: "Reply in the live call", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    description:
      "Send your answer into the user's live phone call. A voice agent talks with the user and passes their questions on; this answers the question it is waiting on, or, if none is open, it tells the user. Works for any agent of the user, no ids needed. Write plain spoken text: short, no code, links or markdown.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "What the voice agent should tell the user, up to 8000 characters." },
        call_id: { type: "string", description: "Optional. Defaults to the current live call." },
        ask_id: { type: "string", description: "Optional. Defaults to the oldest open question." },
      },
      required: ["text"],
      additionalProperties: false,
    },
  },
  {
    name: "live_call_context",
    title: "Add context to the live call",
    annotations: { title: "Add context to the live call", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    description: "Give the voice agent facts to use in the user's live call without reading them out, such as progress on a task.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "Facts for the voice agent, up to 16000 characters." },
        call_id: { type: "string", description: "Optional. Defaults to the current live call." },
      },
      required: ["text"],
      additionalProperties: false,
    },
  },
  {
    name: "live_call_hang_up",
    title: "End the live call",
    annotations: { title: "End the live call", readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    description: "End the user's live phone call. The voice agent says goodbye first. Only when the user asked or the conversation is clearly over.",
    inputSchema: {
      type: "object",
      properties: { call_id: { type: "string", description: "Optional. Defaults to the current live call." } },
      additionalProperties: false,
    },
  },
  {
    name: "phone_call_status",
    title: "Check a call",
    annotations: { title: "Check a call", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    description: "Call status: ringing, answered, played, declined, missed or failed. played means the message finished playing, not that it was heard. A call without a message ends at answered.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
      additionalProperties: false,
    },
  },
] as const;

type Result = { status: number; body: unknown };

export interface McpActions {
  placeCall(bot: Bot, args: Record<string, unknown>): Promise<Result>;
  callStatus(bot: Bot, id: string): Result;
  liveStatus(bot: Bot): Result;
  liveReply(bot: Bot, args: Record<string, unknown>): Result;
  liveAct(bot: Bot, action: "context" | "hangup", args: Record<string, unknown>): Result;
}

const LIVE_TOOLS: Record<string, (bot: Bot, args: Record<string, unknown>, actions: McpActions) => Result> = {
  live_call_status: (bot, _args, actions) => actions.liveStatus(bot),
  live_call_reply: (bot, args, actions) => actions.liveReply(bot, args),
  live_call_context: (bot, args, actions) => actions.liveAct(bot, "context", args),
  live_call_hang_up: (bot, args, actions) => actions.liveAct(bot, "hangup", args),
};

type RpcId = string | number | null;
interface RpcRequest {
  jsonrpc?: string;
  id?: RpcId;
  method?: string;
  params?: Record<string, unknown>;
}

const SUPPORTED_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const ok = (id: RpcId, result: unknown) => ({ jsonrpc: "2.0", id, result });
const rpcError = (id: RpcId, code: number, message: string) => ({ jsonrpc: "2.0", id, error: { code, message } });
const toolResult = (status: number, body: unknown) => ({
  content: [{ type: "text", text: JSON.stringify(body) }],
  isError: status >= 400,
});

async function dispatch(bot: Bot, message: RpcRequest, actions: McpActions) {
  // Without an id this is a notification, so no reply.
  if (message.id === undefined) return undefined;
  const id = message.id;
  switch (message.method) {
    case "initialize": {
      const requested = message.params?.protocolVersion;
      const version = typeof requested === "string" && SUPPORTED_VERSIONS.includes(requested) ? requested : SUPPORTED_VERSIONS[0];
      return ok(id, {
        protocolVersion: version,
        capabilities: { tools: {} },
        serverInfo: { name: "herb-relay", version: "0.1.0" },
      });
    }
    case "ping":
      return ok(id, {});
    case "tools/list":
      return ok(id, { tools: MCP_TOOLS });
    case "tools/call": {
      const name = message.params?.name;
      const args = (message.params?.arguments ?? {}) as Record<string, unknown>;
      if (name === "phone_call") {
        const { status, body } = await actions.placeCall(bot, args);
        return ok(id, toolResult(status, body));
      }
      if (name === "phone_call_status") {
        const { status, body } = actions.callStatus(bot, String(args.id ?? ""));
        return ok(id, toolResult(status, body));
      }
      const liveTool = typeof name === "string" ? LIVE_TOOLS[name] : undefined;
      if (liveTool) {
        const { status, body } = liveTool(bot, args, actions);
        return ok(id, toolResult(status, body));
      }
      return rpcError(id, -32602, "Unknown tool");
    }
    default:
      return rpcError(id, -32601, "Method not found");
  }
}

export async function handleMcp(bot: Bot, request: Request, actions: McpActions) {
  if (request.method !== "POST") return new Response(null, { status: 405, headers: { Allow: "POST" } });
  let parsed: unknown;
  try {
    parsed = await request.json();
  } catch {
    return Response.json(rpcError(null, -32700, "Parse error"), { status: 400 });
  }
  if (Array.isArray(parsed)) {
    const replies = (await Promise.all(parsed.map((m) => dispatch(bot, m as RpcRequest, actions)))).filter(Boolean);
    return replies.length ? Response.json(replies) : new Response(null, { status: 202 });
  }
  const reply = await dispatch(bot, parsed as RpcRequest, actions);
  return reply ? Response.json(reply) : new Response(null, { status: 202 });
}
