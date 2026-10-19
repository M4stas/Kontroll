import { OfflineWorkerBoot } from "@/features/offline/offline-worker-boot";
import { OfflineReport } from "@/features/offline/offline-report";
import { SHELL_HEADER } from "@/service-worker/routing";
import { isLiveDiagnosticsEnabled } from "@/config/application";
import { cookies, headers } from "next/headers";
import { notFound } from "next/navigation";
import { SiteHeader } from "@/components/site-header";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { z } from "zod";
import type { AnalysisReport } from "@/domain/analysis";
import { AccessBootstrap } from "@/features/report/access-bootstrap";
import { loadReport, ReportAccessError } from "@/features/report/load-report";
import { ReportView } from "@/features/report/report-view";
import { analysisAccessCookieName } from "@/server/access/analysis-access";
export default async function ReportPage({params}:{params:Promise<{locale:string;publicId:string}>}) {
 const {locale,publicId}=await params;
 if((locale!=="en" && locale!=="et") || !z.uuid().safeParse(publicId).success) notFound();
 setRequestLocale(locale);
 if ((await headers()).get(SHELL_HEADER) === "1") {
  return <main className="page-shell report-shell">
   <OfflineWorkerBoot />
   <SiteHeader locale={locale} languageHrefs={{ et: `/et/r/${publicId}`, en: `/en/r/${publicId}` }} showNewListing />
   <OfflineReport locale={locale} publicId={publicId} />
  </main>;
 }
 const t=await getTranslations("Report");
 const cookie=(await cookies()).get(analysisAccessCookieName(publicId))?.value;
 let report:AnalysisReport|null=null;let unavailable=false;
 try {if(cookie) report=await loadReport({publicId,cookie});}
 catch(error) {if(!(error instanceof ReportAccessError)) unavailable=true;}
 return <main className="page-shell report-shell">
  <OfflineWorkerBoot />
  <SiteHeader locale={locale} languageHrefs={{ et: `/et/r/${publicId}`, en: `/en/r/${publicId}` }} showNewListing />
  {report?<><AccessBootstrap publicId={publicId} /><ReportView locale={locale} report={report} diagnosticsEnabled={isLiveDiagnosticsEnabled()} /></>:<AccessBootstrap publicId={publicId}
   pending={<section className="access-panel" role="status"><h1>{t("access.heading")}</h1><p>{t("access.explanation")}</p></section>}
   unavailable={<section className="access-panel" role="status"><h1>{t("access.unavailableHeading")}</h1><p>{t("access.unavailableExplanation")}</p></section>}
  ><section className="access-panel" role="status">
   <h1>{t(unavailable?"access.unavailableHeading":"access.deniedHeading")}</h1>
   <p>{t(unavailable?"access.unavailableExplanation":"access.deniedExplanation")}</p>
  </section></AccessBootstrap>}
 </main>;
}
