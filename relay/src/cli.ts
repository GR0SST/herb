import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { Store } from "./db";

const USAGE = `Usage:
  bun run cli account add                  Create an account and print its key
  bun run cli agents <account-key>         List agents with their ids
  bun run cli chat <agent-id> --chat-url URL [--chat-model MODEL] [--chat-key-env ENV_NAME]

Chat reaches your own services, so it is set up only here.`;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    "chat-url": { type: "string" },
    "chat-model": { type: "string" },
    "chat-key-env": { type: "string" },
  },
});
const [command, argument] = positionals;

const dataDir = resolve(process.env.HERB_DATA_DIR ?? "./data");
mkdirSync(dataDir, { recursive: true, mode: 0o700 });
const store = new Store(join(dataDir, "herb.sqlite"));

function fail(message = USAGE): never {
  console.error(message);
  process.exit(1);
}

if (command === "account" && argument === "add") {
  console.log(`Account key (shown once):\n${store.createAccount(Date.now()).key}`);
} else if (command === "agents") {
  const accountId = store.accountIdByKey(argument ?? fail()) ?? fail("Account not found");
  for (const bot of store.listBots(accountId)) console.log(`${bot.id}\t${bot.name}\tchat: ${bot.chat_url ?? "none"}`);
} else if (command === "chat") {
  const bot = store.bot(argument ?? fail()) ?? fail("Agent not found");
  const url = values["chat-url"];
  if (!url || !/^https?:\/\//.test(url)) fail("--chat-url must start with http:// or https://");
  store.setBotChat(bot.id, { url, model: values["chat-model"] ?? null, keyEnv: values["chat-key-env"] ?? null });
  console.log("Chat enabled");
} else {
  fail();
}
