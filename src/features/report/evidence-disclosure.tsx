"use client";

import { ArrowSquareOutIcon } from "@phosphor-icons/react/dist/ssr";
import { useTranslations } from "next-intl";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import type { Evidence, Locale } from "@/domain/analysis";

interface EvidenceDisclosureProps {
  contentLocale: Locale;
  evidence: Evidence[];
}

export function EvidenceDisclosure({ contentLocale, evidence }: EvidenceDisclosureProps) {
  const t = useTranslations("Report");
  const [summary] = evidence;
  if (!summary) return null;

  return (
    <Accordion className="mt-4 border-t border-steel/25">
      <AccordionItem value="evidence">
        <AccordionTrigger className="min-h-11 rounded-none py-3 text-pale-blue hover:no-underline">
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-left">
            <span>{t("evidence.view")}</span>
            <span className="text-xs font-normal text-steel">
              {t(`sourceClass.${summary.sourceClass}`)} / {t(`verification.${summary.verification}`)}
            </span>
          </span>
        </AccordionTrigger>
        <AccordionContent className="space-y-4 pb-4 text-steel">
          {evidence.map((item) => (
            <blockquote className="border-l border-steel/45 pl-3" key={item.id}>
              <p className="text-xs font-semibold text-steel">
                {t(`sourceClass.${item.sourceClass}`)} / {t(`verification.${item.verification}`)}
              </p>
              <p className="mt-2 max-w-2xl text-sm leading-6 text-foreground" lang={contentLocale}>
                {item.claim}
              </p>
              <p className="mt-2 text-xs leading-5" lang={contentLocale}>
                {item.applicability}
              </p>
              {item.sourceUrl ? (
                <a
                  className="mt-3 inline-flex min-h-11 items-center gap-1.5 text-xs font-semibold text-pale-blue"
                  href={item.sourceUrl}
                  rel="noreferrer"
                  target="_blank"
                >
                  {t("evidence.openSource")}
                  <ArrowSquareOutIcon aria-hidden="true" />
                </a>
              ) : null}
            </blockquote>
          ))}
        </AccordionContent>
      </AccordionItem>
    </Accordion>
  );
}
