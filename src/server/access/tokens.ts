import { createHash, randomBytes } from "node:crypto";

export interface AccessToken {
  raw: string;
  hash: string;
}

export function hashAccessToken(raw: string): string {
  return createHash("sha256").update(raw, "utf8").digest("hex");
}

export function createAccessToken(): AccessToken {
  const raw = randomBytes(32).toString("base64url");

  return { raw, hash: hashAccessToken(raw) };
}
