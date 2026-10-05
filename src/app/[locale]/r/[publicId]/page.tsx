import { cookies } from "next/headers";
import { notFound } from "next/navigation";
import Link from "next/link";
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
 setRequestLocale(locale);const t=await getTranslations("Report");
 const cookie=(await cookies()).get(analysisAccessCookieName(publicId))?.value;
 let report:AnalysisReport|null=null;let unavailable=false;
 try {if(cookie) report=await loadReport({publicId,cookie});}
 catch(error) {if(!(error instanceof ReportAccessError)) unavailable=true;}
 return <main className="page-shell report-shell">
  <header className="site-header"><Link className="brand" href={`/${locale}`}>Kontroll</Link>
   <nav className="report-language" aria-label={t("languageLabel")}>
    <span>Car review</span><span aria-hidden="true"> · </span>
    <span>{locale === "en" ? "English" : "Eesti"}</span>
   </nav>
  </header>
  {report?<><AccessBootstrap publicId={publicId} /><ReportView locale={locale} report={report} /></>:<AccessBootstrap publicId={publicId}
   pending={<section className="access-panel" role="status"><h1>{t("access.heading")}</h1><p>{t("access.explanation")}</p></section>}
   unavailable={<section className="access-panel" role="status"><h1>{t("access.unavailableHeading")}</h1><p>{t("access.unavailableExplanation")}</p></section>}
  ><section className="access-panel" role="status">
   <h1>{t(unavailable?"access.unavailableHeading":"access.deniedHeading")}</h1>
   <p>{t(unavailable?"access.unavailableExplanation":"access.deniedExplanation")}</p>
  </section></AccessBootstrap>}
 </main>;
}
