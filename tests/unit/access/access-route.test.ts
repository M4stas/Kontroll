import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hashAccessToken } from "@/server/access/tokens";
import { createAnalysisAccessCookie } from "@/server/access/analysis-access";
import * as accessRoutes from "@/app/api/analyses/[publicId]/access/route";

const { loadAccessTokenHash, cookieSecret } = vi.hoisted(() => ({
  loadAccessTokenHash: vi.fn(),
  cookieSecret: "a-test-secret-long-enough-for-analysis-cookie-signing",
}));

vi.mock("@/server/db/client", () => ({
  getServerSupabaseClient: () => ({}),
}));
vi.mock("@/server/repositories/analyses", () => ({
  AnalysesRepository: class {
    loadAccessTokenHash = loadAccessTokenHash;
  },
}));
vi.mock("@/config/env", () => ({
  getServerEnv: () => ({ ANALYSIS_COOKIE_SECRET: cookieSecret }),
}));

const PUBLIC_ID = "12345678-1234-4234-8234-123456789abc";
const OTHER_PUBLIC_ID = "22345678-1234-4234-8234-123456789abc";
const TOKEN = "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY";
const ACCESS_COOKIE = `kontroll_access_${PUBLIC_ID}`;
const CONTEXT = { params: Promise.resolve({ publicId: PUBLIC_ID }) };
const routesWithPut = accessRoutes as unknown as {
  PUT?: (request: NextRequest, context: typeof CONTEXT) => Promise<Response>;
};

function request(method: "POST" | "PUT", options: { origin?: string; cookie?: string } = {}) {
  const headers = new Headers({
    host: "kontroll.test",
    origin: options.origin ?? "https://kontroll.test",
  });
  if (options.cookie) headers.set("cookie", options.cookie);

  return new NextRequest(`https://kontroll.test/api/analyses/${PUBLIC_ID}/access`, {
    method,
    headers,
    ...(method === "POST" ? { body: JSON.stringify({ token: TOKEN }) } : {}),
  });
}

function setCookie(response: Response | undefined) {
  return response?.headers.get("set-cookie") ?? "";
}

describe("/api/analyses/[publicId]/access", () => {
  beforeEach(() => {
    loadAccessTokenHash.mockResolvedValue(hashAccessToken(TOKEN));
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("POST sets the access cookie with Max-Age=2592000", async () => {
    const response = await accessRoutes.POST(request("POST"), CONTEXT);

    expect(response.status).toBe(200);
    expect(setCookie(response)).toContain(`${ACCESS_COOKIE}=`);
    expect(setCookie(response)).toContain("Max-Age=2592000");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });

  it("PUT with a valid cookie re-sets the same cookie value with Max-Age=2592000", async () => {
    const cookieValue = createAnalysisAccessCookie(PUBLIC_ID, TOKEN, cookieSecret);
    const response = await routesWithPut.PUT?.(
      request("PUT", { cookie: `${ACCESS_COOKIE}=${cookieValue}` }),
      CONTEXT,
    );

    expect(response?.status).toBe(200);
    expect(setCookie(response)).toContain(`${ACCESS_COOKIE}=${cookieValue}`);
    expect(setCookie(response)).toContain("Max-Age=2592000");
    expect(response?.headers.get("cache-control")).toBe("private, no-store");
  });

  it("PUT without a cookie returns 401 and sets no cookie", async () => {
    const response = await routesWithPut.PUT?.(request("PUT"), CONTEXT);

    expect(response?.status).toBe(401);
    expect(setCookie(response)).toBe("");
    expect(response?.headers.get("cache-control")).toBe("private, no-store");
  });

  it("PUT with a cookie for another publicId returns 401", async () => {
    const otherCookie = createAnalysisAccessCookie(OTHER_PUBLIC_ID, TOKEN, cookieSecret);
    const response = await routesWithPut.PUT?.(
      request("PUT", { cookie: `${ACCESS_COOKIE}=${otherCookie}` }),
      CONTEXT,
    );

    expect(response?.status).toBe(401);
    expect(setCookie(response)).toBe("");
    expect(response?.headers.get("cache-control")).toBe("private, no-store");
  });

  it("PUT from another origin returns 403", async () => {
    const response = await routesWithPut.PUT?.(
      request("PUT", { origin: "https://attacker.test" }),
      CONTEXT,
    );

    expect(response?.status).toBe(403);
    expect(setCookie(response)).toBe("");
    expect(response?.headers.get("cache-control")).toBe("private, no-store");
  });
});
