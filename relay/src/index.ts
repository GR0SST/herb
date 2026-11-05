import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { ApnsSender } from "./apns";
import { createApp, MAX_BODY_BYTES } from "./app";
import { Store } from "./db";
import { createOAuth } from "./oauth";

const dataDir = resolve(process.env.HERB_DATA_DIR ?? "./data");
mkdirSync(dataDir, { recursive: true, mode: 0o700 });
const store = new Store(join(dataDir, "herb.sqlite"));

const { APNS_KEY_PATH, APNS_KEY_ID, APNS_TEAM_ID, APNS_BUNDLE_ID } = process.env;
let push: ApnsSender | null = null;
if (APNS_KEY_PATH && APNS_KEY_ID && APNS_TEAM_ID && APNS_BUNDLE_ID) {
  push = new ApnsSender({
    keyPem: await Bun.file(APNS_KEY_PATH).text(),
    keyId: APNS_KEY_ID,
    teamId: APNS_TEAM_ID,
    bundleId: APNS_BUNDLE_ID,
  });
} else {
  console.warn("APNs is not configured: calls ring only while the app is open.");
}

const { HERB_PUBLIC_URL, HERB_OPEN_REGISTRATION } = process.env;
const oauth = HERB_PUBLIC_URL ? createOAuth({ store, publicUrl: HERB_PUBLIC_URL }) : null;
if (!oauth) console.warn("HERB_PUBLIC_URL is not set: browser sign-in is off, agents need a token.");

const app = createApp({
  store,
  dataDir,
  push,
  oauth,
  publicUrl: HERB_PUBLIC_URL,
  openRegistration: HERB_OPEN_REGISTRATION !== "false",
});
setInterval(() => app.purge(), 6 * 60 * 60 * 1000);

const server = Bun.serve({
  hostname: process.env.HOST ?? "127.0.0.1",
  port: Number(process.env.PORT ?? 8790),
  maxRequestBodySize: MAX_BODY_BYTES,
  // A chat reply can take longer than the default 10 seconds.
  idleTimeout: 255,
  fetch: (request) => app.handle(request),
});
console.log(`Herb relay: ${server.url}`);
