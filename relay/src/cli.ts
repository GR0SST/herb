import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { Store } from "./db";

const USAGE = `Usage:
  bun run cli account add                  Create an account and print its key
  bun run cli agents <account-key>         List agents with their ids
  bun run cli chat <agent-id> --chat-url URL [--chat-model MODEL] [--chat-key-env ENV_NAME]
  bun run cli minutes <account> [<minutes>]        Show or add bonus live call minutes; take away with: minutes <account> -- -30
  bun run cli unlimited <account> on|off           Live calls without counting minutes, for you and friends
  bun run cli live <account>                       Show the account's live call plan

<account> is an account key, an account id, or the start of an id.

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

/** An account by key, full id or the start of an id. */
function findAccount(value: string) {
  const byKey = store.accountIdByKey(value);
  if (byKey) return byKey;
  const matches = store.db.query<{ id: string }, [string]>("SELECT id FROM accounts WHERE id LIKE ? LIMIT 2").all(`${value.replace(/[%_]/g, "")}%`);
  if (value.length >= 6 && matches.length === 1) return matches[0]!.id;
  return fail(matches.length > 1 ? "Several accounts match, give more of the id" : "Account not found");
}

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
} else if (command === "unlimited") {
  const accountId = findAccount(argument ?? fail());
  const value = positionals[2];
  if (value !== "on" && value !== "off") fail("Say on or off");
  store.setUnlimited(accountId, value === "on");
  console.log(`Unlimited live calls: ${value}`);
} else if (command === "live") {
  const accountId = findAccount(argument ?? fail());
  const sub = store.latestSubscription(accountId);
  console.log(`Unlimited: ${store.isUnlimited(accountId) ? "yes" : "no"}`);
  console.log(`Bonus minutes: ${(store.liveSeconds(accountId) / 60).toFixed(1)}`);
  if (sub) {
    const left = (sub.seconds_total - sub.seconds_used) / 60;
    const expires = sub.expires_at ? new Date(sub.expires_at).toISOString() : "never";
    console.log(`Subscription: ${sub.product_id} (${sub.environment}), ${left.toFixed(1)} of ${sub.seconds_total / 60} minutes left, expires ${expires}${sub.revoked ? ", revoked" : ""}`);
  } else {
    console.log("Subscription: none");
  }
} else if (command === "minutes") {
  const accountId = findAccount(argument ?? fail());
  const minutes = positionals[2];
  if (minutes !== undefined) {
    if (!/^-?\d+$/.test(minutes)) fail("Minutes must be a whole number");
    store.addLiveSeconds(accountId, Number(minutes) * 60);
  }
  console.log(`Bonus minutes: ${(store.liveSeconds(accountId) / 60).toFixed(1)}`);
} else {
  fail();
}
