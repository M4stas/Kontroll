import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getServerEnv } from "@/config/env";
import {
  ACCESS_COOKIE_MAX_AGE_SECONDS,
  analysisAccessCookieName,
  createAnalysisAccessCookie,
  verifyAnalysisAccess,
  verifyRawAnalysisToken,
} from "@/server/access/analysis-access";
import { getServerSupabaseClient } from "@/server/db/client";
import { isSameOriginRequest } from "@/server/http/same-origin";
import { AnalysesRepository } from "@/server/repositories/analyses";

const AccessRequestSchema = z.object({ token: z.string().min(1).max(1024) }).strict();
const PublicIdSchema = z.uuid();
const privateNoStore = { "Cache-Control": "private, no-store" };
const accessCookieOptions = {
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  sameSite: "lax" as const,
  path: "/",
  maxAge: ACCESS_COOKIE_MAX_AGE_SECONDS,
};

interface AccessRouteContext {
  params: Promise<{ publicId: string }>;
}

export async function POST(request: Request, context: AccessRouteContext) {
  const { publicId } = await context.params;
  const parsedPublicId = PublicIdSchema.safeParse(publicId);
  if (!parsedPublicId.success) {
    return NextResponse.json({ error: "Access denied" }, { status: 404, headers: privateNoStore });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Access denied" }, { status: 401, headers: privateNoStore });
  }

  const parsedBody = AccessRequestSchema.safeParse(body);
  if (!parsedBody.success) {
    return NextResponse.json({ error: "Access denied" }, { status: 401, headers: privateNoStore });
  }

  const analyses = new AnalysesRepository(getServerSupabaseClient());
  const persistedTokenHash = await analyses.loadAccessTokenHash(parsedPublicId.data);
  if (!persistedTokenHash || !verifyRawAnalysisToken(parsedBody.data.token, persistedTokenHash)) {
    return NextResponse.json({ error: "Access denied" }, { status: 401, headers: privateNoStore });
  }

  const secret = getServerEnv().ANALYSIS_COOKIE_SECRET;
  const response = NextResponse.json({ ok: true }, { headers: privateNoStore });
  response.cookies.set({
    name: analysisAccessCookieName(parsedPublicId.data),
    value: createAnalysisAccessCookie(parsedPublicId.data, parsedBody.data.token, secret),
    ...accessCookieOptions,
  });
  return response;
}

export async function PUT(request: NextRequest, context: AccessRouteContext) {
  if (!isSameOriginRequest(request)) {
    return NextResponse.json({ error: "Access denied" }, { status: 403, headers: privateNoStore });
  }

  const { publicId } = await context.params;
  const parsedPublicId = PublicIdSchema.safeParse(publicId);
  if (!parsedPublicId.success) {
    return NextResponse.json({ error: "Access denied" }, { status: 401, headers: privateNoStore });
  }

  const cookieName = analysisAccessCookieName(parsedPublicId.data);
  const cookie = request.cookies.get(cookieName)?.value;
  if (!cookie || !(await verifyAnalysisAccess({ publicId: parsedPublicId.data, cookie }))) {
    return NextResponse.json({ error: "Access denied" }, { status: 401, headers: privateNoStore });
  }

  const response = NextResponse.json({ ok: true }, { headers: privateNoStore });
  response.cookies.set({ name: cookieName, value: cookie, ...accessCookieOptions });
  return response;
}
