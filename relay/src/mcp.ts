import type { Bot } from "./db";

export const MCP_TOOLS = [
  {
    name: "phone_call",
    title: "Call my phone",
    annotations: { title: "Call my phone", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    description:
      "Call the user's iPhone. With text, the phone speaks it after they answer. Without text, it just rings. One-way: the user cannot reply by voice. Call only when the user asked or set up the rule in advance.",
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
      },
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

export interface McpActions {
  placeCall(bot: Bot, args: Record<string, unknown>): Promise<{ status: number; body: unknown }>;
  callStatus(bot: Bot, id: string): { status: number; body: unknown };
}

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
