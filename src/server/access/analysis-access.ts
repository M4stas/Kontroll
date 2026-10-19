import { createHmac, timingSafeEqual } from "node:crypto";
import { hashAccessToken } from "@/server/access/tokens";
import type { AnalysesRepository } from "@/server/repositories/analyses";

const TOKEN_BYTES = 32;
const DIGEST_BYTES = 32;

export const ACCESS_COOKIE_MAX_AGE_SECONDS = 2_592_000;

interface VerifyCookieInput {
  cookie: string;
  persistedTokenHash: string;
  publicId: string;
  secret: string;
}

interface VerifyAccessInput {
  cookie: string | undefined;
  publicId: string;
}

interface VerifyAccessDependencies {
  analyses: Pick<AnalysesRepository, "loadAccessTokenHash">;
  secret: string;
}

async function defaultVerifyAccessDependencies(): Promise<VerifyAccessDependencies> {
  const [{ getServerEnv }, { getServerSupabaseClient }, { AnalysesRepository }] =
    await Promise.all([
      import("@/config/env"),
      import("@/server/db/client"),
      import("@/server/repositories/analyses"),
    ]);

  return {
    analyses: new AnalysesRepository(getServerSupabaseClient()),
    secret: getServerEnv().ANALYSIS_COOKIE_SECRET,
  };
}

function decodeCanonicalBase64Url(value: string): Buffer | null {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;

  const decoded = Buffer.from(value, "base64url");
  return decoded.toString("base64url") === value ? decoded : null;
}

function decodeSha256Hex(value: string): Buffer | null {
  if (!/^[a-f0-9]{64}$/.test(value)) return null;
  return Buffer.from(value, "hex");
}

function equalLengthSafe(left: Buffer, right: Buffer): boolean {
  return left.length === right.length && timingSafeEqual(left, right);
}

function signatureFor(publicId: string, rawToken: string, secret: string): Buffer {
  return createHmac("sha256", secret).update(publicId).update("\0").update(rawToken).digest();
}

export function analysisAccessCookieName(publicId: string): string {
  return `kontroll_access_${publicId}`;
}

export function verifyRawAnalysisToken(rawToken: string, persistedTokenHash: string): boolean {
  const rawBytes = decodeCanonicalBase64Url(rawToken);
  const persistedHash = decodeSha256Hex(persistedTokenHash);
  if (rawBytes?.length !== TOKEN_BYTES || persistedHash?.length !== DIGEST_BYTES) return false;

  const candidateHash = decodeSha256Hex(hashAccessToken(rawToken));
  return candidateHash !== null && equalLengthSafe(candidateHash, persistedHash);
}

export function createAnalysisAccessCookie(
  publicId: string,
  rawToken: string,
  secret: string,
): string {
  const rawBytes = decodeCanonicalBase64Url(rawToken);
  if (rawBytes?.length !== TOKEN_BYTES) throw new Error("Invalid analysis access token");

  const signature = signatureFor(publicId, rawToken, secret).toString("base64url");
  return `${rawToken}.${signature}`;
}

export function verifyAnalysisAccessCookie({
  cookie,
  persistedTokenHash,
  publicId,
  secret,
}: VerifyCookieInput): boolean {
  const parts = cookie.split(".");
  if (parts.length !== 2) return false;

  const [rawToken, encodedSignature] = parts;
  if (!rawToken || !encodedSignature) return false;

  const rawBytes = decodeCanonicalBase64Url(rawToken);
  const signature = decodeCanonicalBase64Url(encodedSignature);
  if (rawBytes?.length !== TOKEN_BYTES || signature?.length !== DIGEST_BYTES) return false;

  const expectedSignature = signatureFor(publicId, rawToken, secret);
  if (!equalLengthSafe(signature, expectedSignature)) return false;

  return verifyRawAnalysisToken(rawToken, persistedTokenHash);
}

export async function verifyAnalysisAccess(
  { cookie, publicId }: VerifyAccessInput,
  dependencies?: VerifyAccessDependencies,
): Promise<boolean> {
  if (!cookie) return false;

  const resolvedDependencies = dependencies ?? (await defaultVerifyAccessDependencies());
  const persistedTokenHash = await resolvedDependencies.analyses.loadAccessTokenHash(publicId);
  if (!persistedTokenHash) return false;

  return verifyAnalysisAccessCookie({
    cookie,
    persistedTokenHash,
    publicId,
    secret: resolvedDependencies.secret,
  });
}
