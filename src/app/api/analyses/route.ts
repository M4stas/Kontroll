import { NextResponse } from "next/server";
import { z } from "zod";
import en from "../../../../messages/en.json";
import et from "../../../../messages/et.json";
import type { Locale } from "@/domain/analysis";
import { createAnalysis } from "@/features/submission/create-analysis";

const CreateAnalysisRequestSchema = z
  .object({
    locale: z.enum(["et", "en"]),
    listingUrl: z.string(),
  })
  .strict();

function requestedLocale(value: unknown): Locale {
  if (typeof value === "object" && value !== null && "locale" in value) {
    return (value as { locale?: unknown }).locale === "en" ? "en" : "et";
  }
  return "et";
}

function messagesFor(locale: Locale) {
  return locale === "en" ? en.Submission : et.Submission;
}

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: et.Submission.invalidUrl }, { status: 400 });
  }

  const locale = requestedLocale(body);
  const parsed = CreateAnalysisRequestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: messagesFor(locale).invalidUrl }, { status: 400 });
  }

  try {
    const result = await createAnalysis(parsed.data);
    return NextResponse.json(result, { status: 201 });
  } catch (error) {
    if (error instanceof Error && error.message.includes("valid http URL")) {
      return NextResponse.json({ error: messagesFor(locale).invalidUrl }, { status: 400 });
    }
    return NextResponse.json({ error: messagesFor(locale).requestFailed }, { status: 500 });
  }
}
