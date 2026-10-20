import { cookies } from "next/headers";
import { notFound } from "next/navigation";
import { isLiveDiagnosticsEnabled } from "@/config/application";
import { ListingAccessFallback, ListingDashboard } from "@/features/listing/dashboard";
import type { Locale } from "@/features/listing/messages";
import { jobIdSchema } from "@/listings/contracts";
import { cookieName, readAccessSourceUrl, verifyAccess } from "../../../../server/access";

export default async function ListingPage({
  params,
}: {
  params: Promise<{ locale: string; jobId: string }>;
}) {
  const { locale: routeLocale, jobId } = await params;
  if (routeLocale !== "et" && routeLocale !== "en") notFound();
  const locale: Locale = routeLocale;

  if (!jobIdSchema.safeParse(jobId).success) {
    return <ListingAccessFallback locale={locale} jobId={jobId} code="job_not_found" />;
  }

  let hasAccess = false;
  let submittedSourceUrl: string | undefined;
  try {
    const token = (await cookies()).get(cookieName(jobId))?.value;
    hasAccess = verifyAccess(jobId, token);
    if (hasAccess) submittedSourceUrl = readAccessSourceUrl(jobId, token);
  } catch {
    return <ListingAccessFallback locale={locale} jobId={jobId} code="configuration_error" />;
  }

  if (!hasAccess) return <ListingAccessFallback locale={locale} jobId={jobId} />;
  return <ListingDashboard locale={locale} jobId={jobId} submittedSourceUrl={submittedSourceUrl} diagnosticsEnabled={isLiveDiagnosticsEnabled()} />;
}
