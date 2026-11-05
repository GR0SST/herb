import { expect, test } from "bun:test";
import { createPublicKey, generateKeyPairSync, verify } from "node:crypto";
import http2 from "node:http2";
import { ApnsSender, signApnsJwt, voipPayload } from "../src/apns";
import type { Call, Device } from "../src/db";

const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
const keyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const device: Device = { id: "d", account_id: "a", name: "iPhone", voip_token: "abc123", environment: "sandbox", created_at: 1 };
const call: Call = {
  id: "call-1", bot_id: "b", bot_name: "Grok", title: null, text: "secret text", language: "ru", audio_mime: null,
  status: "ringing", created_at: 1, updated_at: 1,
};

test("JWT is a verifiable ES256 token", () => {
  const jwt = signApnsJwt(privateKey, "KEY", "TEAM", 5_000_000);
  const [head, body, sig] = jwt.split(".") as [string, string, string];
  expect(JSON.parse(Buffer.from(head, "base64url").toString())).toEqual({ alg: "ES256", kid: "KEY" });
  expect(JSON.parse(Buffer.from(body, "base64url").toString())).toEqual({ iss: "TEAM", iat: 5000 });
  const ok = verify("sha256", Buffer.from(`${head}.${body}`), { key: createPublicKey(privateKey), dsaEncoding: "ieee-p1363" }, Buffer.from(sig, "base64url"));
  expect(ok).toBe(true);
});

test("push payload never carries the message text", () => {
  expect(JSON.stringify(voipPayload(call))).not.toContain("secret");
});

function fakeApns(status: number, responseBody: string) {
  const seen: { headers: http2.IncomingHttpHeaders; body: string }[] = [];
  const server = http2.createServer((request, response) => {
    let body = "";
    request.on("data", (c) => (body += c));
    request.on("end", () => {
      seen.push({ headers: request.headers, body });
      response.writeHead(status);
      response.end(responseBody);
    });
  });
  return new Promise<{ origin: string; seen: typeof seen; close: () => void }>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      resolve({ origin: `http://127.0.0.1:${port}`, seen, close: () => server.close() });
    });
  });
}

test("sends a VoIP push over HTTP/2 with the right headers", async () => {
  const apns = await fakeApns(200, "");
  const sender = new ApnsSender({ keyPem, keyId: "KEY", teamId: "TEAM", bundleId: "cc.grosst.herb", hostOverride: apns.origin });
  const result = await sender.send(device, call);
  apns.close();
  expect(result).toMatchObject({ ok: true, status: 200, invalidToken: false });
  const { headers, body } = apns.seen[0]!;
  expect(headers[":path"]).toBe("/3/device/abc123");
  expect(headers["apns-topic"]).toBe("cc.grosst.herb.voip");
  expect(headers["apns-push-type"]).toBe("voip");
  expect(headers.authorization).toStartWith("bearer ");
  expect(JSON.parse(body)).toMatchObject({ call_id: "call-1", bot_name: "Grok" });
});

test("flags dead tokens", async () => {
  const apns = await fakeApns(410, JSON.stringify({ reason: "Unregistered" }));
  const sender = new ApnsSender({ keyPem, keyId: "KEY", teamId: "TEAM", bundleId: "cc.grosst.herb", hostOverride: apns.origin });
  const result = await sender.send(device, call);
  apns.close();
  expect(result).toMatchObject({ ok: false, status: 410, reason: "Unregistered", invalidToken: true });
});

test("network failure resolves instead of throwing", async () => {
  const sender = new ApnsSender({ keyPem, keyId: "KEY", teamId: "TEAM", bundleId: "x", hostOverride: "http://127.0.0.1:1" });
  const result = await sender.send(device, call);
  expect(result.ok).toBe(false);
  expect(result.status).toBe(0);
});
