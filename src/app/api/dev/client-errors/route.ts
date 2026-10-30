import { NextResponse } from "next/server";
import { z } from "zod";
import { isSameOriginRequest } from "@/server/http/same-origin";

// Dev only: prints browser errors to the dev server's output, so errors on a
// phone (where the overlay text cannot be copied) reach the terminal and logs.
const schema = z
  .object({
    kind: z.enum(["error", "unhandledrejection", "console.error"]),
    message: z.string().max(4000),
    stack: z.string().max(8000).optional(),
    page: z.string().max(2048).transform((page) => page.split("#", 1)[0]),
  })
  .strict();

export async function POST(request: Request) {
  if (process.env.NODE_ENV !== "development") return new NextResponse(null, { status: 404 });
  if (!isSameOriginRequest(request)) return new NextResponse(null, { status: 403 });
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return new NextResponse(null, { status: 400 });
  const { kind, message, stack, page } = parsed.data;
  const agent = request.headers.get("user-agent") ?? "unknown browser";
  console.error(`[client ${kind}] ${page} (${agent})\n${message}${stack ? `\n${stack}` : ""}`);
  return new NextResponse(null, { status: 204 });
}
