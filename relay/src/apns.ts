import { createPrivateKey, createSign, type KeyObject } from "node:crypto";
import http2 from "node:http2";
import type { Call, Device } from "./db";

export interface PushResult {
  ok: boolean;
  status: number;
  reason?: string;
  /** The token is no longer valid and must be removed. */
  invalidToken: boolean;
}

export interface PushSender {
  send(device: Device, call: Call): Promise<PushResult>;
}

export interface ApnsConfig {
  keyPem: string;
  keyId: string;
  teamId: string;
  bundleId: string;
  /** For tests. */
  hostOverride?: string;
}

const HOSTS = {
  sandbox: "https://api.sandbox.push.apple.com",
  production: "https://api.push.apple.com",
} as const;

const JWT_LIFETIME_MS = 50 * 60 * 1000;
const b64 = (data: string | Buffer) => Buffer.from(data).toString("base64url");

export function signApnsJwt(key: KeyObject, keyId: string, teamId: string, nowMs: number) {
  const head = b64(JSON.stringify({ alg: "ES256", kid: keyId }));
  const body = b64(JSON.stringify({ iss: teamId, iat: Math.floor(nowMs / 1000) }));
  const signature = createSign("sha256")
    .update(`${head}.${body}`)
    .sign({ key, dsaEncoding: "ieee-p1363" });
  return `${head}.${body}.${b64(signature)}`;
}

export function voipPayload(call: Pick<Call, "id" | "bot_id" | "bot_name" | "title">) {
  return { aps: {}, call_id: call.id, bot_id: call.bot_id, bot_name: call.bot_name, title: call.title };
}

export class ApnsSender implements PushSender {
  private readonly key: KeyObject;
  private jwt?: { value: string; at: number };

  constructor(private readonly config: ApnsConfig) {
    this.key = createPrivateKey(config.keyPem);
  }

  private token() {
    const now = Date.now();
    if (!this.jwt || now - this.jwt.at > JWT_LIFETIME_MS) {
      this.jwt = { value: signApnsJwt(this.key, this.config.keyId, this.config.teamId, now), at: now };
    }
    return this.jwt.value;
  }

  send(device: Device, call: Call): Promise<PushResult> {
    const origin = this.config.hostOverride ?? HOSTS[device.environment];
    const body = JSON.stringify(voipPayload(call));
    return new Promise((resolve) => {
      let settled = false;
      const client = http2.connect(origin);
      const finish = (result: PushResult) => {
        if (settled) return;
        settled = true;
        client.close();
        resolve(result);
      };
      const fail = (reason: string) => finish({ ok: false, status: 0, reason, invalidToken: false });
      client.on("error", (error) => fail(error.message));

      const request = client.request({
        ":method": "POST",
        ":path": `/3/device/${device.voip_token}`,
        authorization: `bearer ${this.token()}`,
        "apns-topic": `${this.config.bundleId}.voip`,
        "apns-push-type": "voip",
        "apns-priority": "10",
        "apns-expiration": "0",
        "content-type": "application/json",
      });
      let status = 0;
      let data = "";
      request.setTimeout(10_000, () => {
        request.close();
        fail("timeout");
      });
      request.on("response", (headers) => {
        status = Number(headers[":status"]);
      });
      request.setEncoding("utf8");
      request.on("data", (chunk: string) => {
        data += chunk;
      });
      request.on("error", (error) => fail(error.message));
      request.on("end", () => {
        let reason: string | undefined;
        try {
          reason = data ? (JSON.parse(data) as { reason?: string }).reason : undefined;
        } catch {
          reason = data.slice(0, 200);
        }
        const invalidToken = status === 410 || reason === "BadDeviceToken" || reason === "Unregistered";
        finish({ ok: status === 200, status, reason, invalidToken });
      });
      request.end(body);
    });
  }
}
