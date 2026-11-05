import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hashToken, Store } from "../src/db";

test("single-owner database moves to the first phone and keeps tokens and calls", () => {
  const path = join(mkdtempSync(join(tmpdir(), "herb-mig-")), "t.sqlite");
  const old = new Database(path);
  old.run(`CREATE TABLE bots (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, token_hash TEXT NOT NULL UNIQUE, chat_url TEXT, chat_key_env TEXT, chat_model TEXT)`);
  old.run(`CREATE TABLE devices (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, token_hash TEXT NOT NULL UNIQUE, voip_token TEXT, environment TEXT NOT NULL DEFAULT 'sandbox')`);
  old.run(`CREATE TABLE calls (id TEXT PRIMARY KEY, bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE, title TEXT, text TEXT, audio_mime TEXT, status TEXT NOT NULL, idempotency_key TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, UNIQUE (bot_id, idempotency_key))`);
  old.query("INSERT INTO devices (id, name, token_hash) VALUES ('d1', 'iPhone', ?)").run(hashToken("dev"));
  old.query("INSERT INTO bots (id, name, token_hash) VALUES ('b1', 'Grok', ?)").run(hashToken("bot"));
  old.run("INSERT INTO calls (id, bot_id, text, status, created_at, updated_at) VALUES ('c1', 'b1', 'hi', 'played', 1, 1)");
  old.close();

  for (let i = 0; i < 2; i++) {
    const store = new Store(path);
    expect(store.botByToken("bot")?.device_id).toBe("d1");
    expect(store.deviceByToken("dev")?.id).toBe("d1");
    expect(store.listCalls("d1", 10).map((c) => c.id)).toEqual(["c1"]);
    expect(store.call("c1")?.language).toBeNull();
    store.db.close();
  }
  const store = new Store(path);
  store.deleteDevice("d1");
  expect(store.bot("b1")).toBeNull();
  expect(store.call("c1")).toBeNull();
});
