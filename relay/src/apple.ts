import { createPublicKey, verify, X509Certificate } from "node:crypto";

/**
 * Checks App Store signed data (JWS): transactions, renewal info and server notifications.
 * The certificate chain in the header must end at Apple Root CA - G3, and the signature must match.
 * https://developer.apple.com/documentation/appstoreserverapi/jwstransaction
 */

/** Apple Root CA - G3, SHA-256 fingerprint 63:34:3A:BF:...:3E:91:79, from https://www.apple.com/certificateauthority/ */
export const APPLE_ROOT_G3 = "MIICQzCCAcmgAwIBAgIILcX8iNLFS5UwCgYIKoZIzj0EAwMwZzEbMBkGA1UEAwwSQXBwbGUgUm9vdCBDQSAtIEczMSYwJAYDVQQLDB1BcHBsZSBDZXJ0aWZpY2F0aW9uIEF1dGhvcml0eTETMBEGA1UECgwKQXBwbGUgSW5jLjELMAkGA1UEBhMCVVMwHhcNMTQwNDMwMTgxOTA2WhcNMzkwNDMwMTgxOTA2WjBnMRswGQYDVQQDDBJBcHBsZSBSb290IENBIC0gRzMxJjAkBgNVBAsMHUFwcGxlIENlcnRpZmljYXRpb24gQXV0aG9yaXR5MRMwEQYDVQQKDApBcHBsZSBJbmMuMQswCQYDVQQGEwJVUzB2MBAGByqGSM49AgEGBSuBBAAiA2IABJjpLz1AcqTtkyJygRMc3RCV8cWjTnHcFBbZDuWmBSp3ZHtfTjjTuxxEtX/1H7YyYl3J6YRbTzBPEVoA/VhYDKX1DyxNB0cTddqXl5dvMVztK517IDvYuVTZXpmkOlEKMaNCMEAwHQYDVR0OBBYEFLuw3qFYM4iapIqZ3r6966/ayySrMA8GA1UdEwEB/wQFMAMBAf8wDgYDVR0PAQH/BAQDAgEGMAoGCCqGSM49BAMDA2gAMGUCMQCD6cHEFl4aXTQY2e3v9GwOAEZLuN+yRhHFD/3meoyhpmvOwgPUnPWTxnS4at+qIxUCMG1mihDK1A3UT82NQz60imOlM27jbdoXt2QfyFMm+YhidDkLF1vLUagM6BgD56KyKA==";

// Marker extensions Apple puts on the App Store signing certificates.
const LEAF_OID = "1.2.840.113635.100.6.11.1";
const INTERMEDIATE_OID = "1.2.840.113635.100.6.2.1";

/** DER encoding of an OID, to find an extension in a certificate without a full ASN.1 parser. */
function oidBytes(oid: string) {
  const parts = oid.split(".").map(Number);
  const out = [parts[0]! * 40 + parts[1]!];
  for (const part of parts.slice(2)) {
    const chunk = [part & 0x7f];
    for (let rest = part >> 7; rest > 0; rest >>= 7) chunk.unshift((rest & 0x7f) | 0x80);
    out.push(...chunk);
  }
  return Buffer.from([0x06, out.length, ...out]);
}

const hasExtension = (cert: X509Certificate, oid: string) => cert.raw.includes(oidBytes(oid));

export class AppleSignatureError extends Error {}

/**
 * Returns the payload of a JWS signed by the App Store, or throws.
 * roots: trusted root certificates as base64 DER. Tests pass their own.
 */
export function verifyAppleJws<T>(jws: string, options: { roots?: string[]; now?: Date; checkMarkers?: boolean } = {}): T {
  const parts = jws.split(".");
  if (parts.length !== 3) throw new AppleSignatureError("Not a JWS");
  const [headerPart, payloadPart, signaturePart] = parts as [string, string, string];
  let header: { alg?: string; x5c?: string[] };
  try {
    header = JSON.parse(Buffer.from(headerPart, "base64url").toString("utf8"));
  } catch {
    throw new AppleSignatureError("Bad header");
  }
  if (header.alg !== "ES256" || !Array.isArray(header.x5c) || header.x5c.length < 3) throw new AppleSignatureError("Unexpected header");

  const [leaf, intermediate, root] = header.x5c.slice(0, 3).map((der) => new X509Certificate(Buffer.from(der, "base64")));
  const trusted = (options.roots ?? [APPLE_ROOT_G3]).map((der) => new X509Certificate(Buffer.from(der, "base64")));
  if (!trusted.some((t) => t.raw.equals(root!.raw))) throw new AppleSignatureError("Unknown root certificate");
  if (!intermediate!.checkIssued(root!) || !intermediate!.verify(root!.publicKey)) throw new AppleSignatureError("Bad intermediate certificate");
  if (!leaf!.checkIssued(intermediate!) || !leaf!.verify(intermediate!.publicKey)) throw new AppleSignatureError("Bad leaf certificate");
  if (options.checkMarkers ?? true) {
    if (!hasExtension(leaf!, LEAF_OID) || !hasExtension(intermediate!, INTERMEDIATE_OID)) throw new AppleSignatureError("Not an App Store certificate");
  }
  const now = options.now ?? new Date();
  for (const cert of [leaf!, intermediate!]) {
    if (new Date(cert.validFrom) > now || new Date(cert.validTo) < now) throw new AppleSignatureError("Certificate expired");
  }

  const signed = Buffer.from(`${headerPart}.${payloadPart}`);
  const signature = Buffer.from(signaturePart, "base64url");
  const key = createPublicKey(leaf!.publicKey.export({ type: "spki", format: "pem" }));
  if (!verify("sha256", signed, { key, dsaEncoding: "ieee-p1363" }, signature)) throw new AppleSignatureError("Bad signature");
  return JSON.parse(Buffer.from(payloadPart, "base64url").toString("utf8")) as T;
}

/** The fields Herb uses from a signed transaction. */
export interface AppleTransaction {
  transactionId: string;
  originalTransactionId: string;
  bundleId: string;
  productId: string;
  purchaseDate: number;
  expiresDate?: number;
  revocationDate?: number;
  environment: "Sandbox" | "Production" | string;
  type?: string;
}

/** App Store Server Notifications V2, decoded. */
export interface AppleNotification {
  notificationType: string;
  subtype?: string;
  data?: { bundleId?: string; signedTransactionInfo?: string; signedRenewalInfo?: string; environment?: string };
}

export interface AppleRenewalInfo {
  originalTransactionId: string;
  autoRenewStatus?: number;
}
