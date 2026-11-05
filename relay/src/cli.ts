import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { Store } from "./db";

const USAGE = `Usage:
  bun run cli device add <name>
  bun run cli device list
  bun run cli device remove <name>
  bun run cli bot add <device> <name>
  bun run cli bot chat <device> <name> --chat-url URL [--chat-model MODEL] [--chat-key-env ENV_NAME]
  bun run cli bot list
  bun run cli bot remove <device> <name>

Accounts are normally created by the app. Chat is set up only here: it reaches your own services.`;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    "chat-url": { type: "string" },
    "chat-model": { type: "string" },
    "chat-key-env": { type: "string" },
  },
});
const [kind, action, first, second] = positionals;

const dataDir = resolve(process.env.HERB_DATA_DIR ?? "./data");
mkdirSync(dataDir, { recursive: true, mode: 0o700 });
const store = new Store(join(dataDir, "herb.sqlite"));

function fail(message = USAGE): never {
  console.error(message);
  process.exit(1);
}

function findBot() {
  const device = store.deviceByName(first ?? "") ?? fail(`Device not found: ${first}`);
  return { device, bot: store.botByName(device.id, second ?? "") };
}

if (kind === "device" && action === "add") {
  const { token } = store.addDevice(first ?? fail());
  console.log(`Device token (shown once):\n${token}`);
} else if (kind === "device" && action === "list") {
  for (const d of store.listDevices()) console.log(`${d.name}\tpush: ${d.voip_token ? d.environment : "none"}`);
} else if (kind === "device" && action === "remove") {
  console.log(store.removeDevice(first ?? fail()) ? "Removed" : "Not found");
} else if (kind === "bot" && action === "add") {
  const { device } = findBot();
  const { token } = store.addBot({ deviceId: device.id, name: second ?? fail() });
  console.log(`Agent token (shown once):\n${token}`);
} else if (kind === "bot" && action === "chat") {
  const { bot } = findBot();
  if (!bot) fail("Agent not found");
  const url = values["chat-url"];
  if (!url || !/^https?:\/\//.test(url)) fail("--chat-url must start with http:// or https://");
  store.setBotChat(bot.id, { url, model: values["chat-model"] ?? null, keyEnv: values["chat-key-env"] ?? null });
  console.log("Chat enabled");
} else if (kind === "bot" && action === "list") {
  const devices = new Map(store.listDevices().map((d) => [d.id, d.name]));
  for (const b of store.allBots()) console.log(`${devices.get(b.device_id)}\t${b.name}\tchat: ${b.chat_url ?? "none"}`);
} else if (kind === "bot" && action === "remove") {
  const { bot } = findBot();
  if (bot) store.deleteBot(bot.id);
  console.log(bot ? "Removed" : "Not found");
} else {
  fail();
}
