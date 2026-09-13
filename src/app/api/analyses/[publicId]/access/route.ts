import { NextResponse } from "next/server";
import { z } from "zod";
import { getServerEnv } from "@/config/env";
import {
  analysisAccessCookieName,
  createAnalysisAccessCookie,
  verifyRawAnalysisToken,
} from "@/server/access/analysis-access";
import { getServerSupabaseClient } from "@/server/db/client";
import { AnalysesRepository } from "@/server/repositories/analyses";

const AccessRequestSchema = z.object({ token: z.string().min(1).max(1024) }).strict();
const PublicIdSchema = z.uuid();

interface AccessRouteContext {
  params: Promise<{ publicId: string }>;
}

export async function POST(request: Request, context: AccessRouteContext) {
  const { publicId } = await context.params;
  const parsedPublicId = PublicIdSchema.safeParse(publicId);
  if (!parsedPublicId.success) {
    return NextResponse.json({ error: "Access denied" }, { status: 404 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Access denied" }, { status: 401 });
  }

  const parsedBody = AccessRequestSchema.safeParse(body);
  if (!parsedBody.success) {
    return NextResponse.json({ error: "Access denied" }, { status: 401 });
  }

  const analyses = new AnalysesRepository(getServerSupabaseClient());
  const persistedTokenHash = await analyses.loadAccessTokenHash(parsedPublicId.data);
  if (!persistedTokenHash || !verifyRawAnalysisToken(parsedBody.data.token, persistedTokenHash)) {
    return NextResponse.json({ error: "Access denied" }, { status: 401 });
  }

  const secret = getServerEnv().ANALYSIS_COOKIE_SECRET;
  const response = NextResponse.json({ ok: true });
  response.cookies.set({
    name: analysisAccessCookieName(parsedPublicId.data),
    value: createAnalysisAccessCookie(parsedPublicId.data, parsedBody.data.token, secret),
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/",
  });
  return response;
}
