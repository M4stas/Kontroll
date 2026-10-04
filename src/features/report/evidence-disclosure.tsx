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
import { EvidenceImage } from "@/features/report/evidence-image";

interface EvidenceDisclosureProps {
  contentLocale: Locale;
  evidence: Evidence[];
  issueDescription: string;
  photoNumberByEvidenceId: ReadonlyMap<string, number>;
}

export function EvidenceDisclosure({
  contentLocale,
  evidence,
  issueDescription,
  photoNumberByEvidenceId,
}: EvidenceDisclosureProps) {
  const t = useTranslations("Report");
  const [summary] = evidence;
  const fallbackPhotoNumberByEvidenceId = new Map(
    evidence.filter((item) => item.imageUrl).map((item, index) => [item.id, index + 1]),
  );
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
          <p className="max-w-2xl text-sm leading-6" lang={contentLocale}>
            <span className="font-semibold text-foreground">{t("evidence.issueDescription")}</span>: {issueDescription}
          </p>
          {evidence.map((item, index) => {
            const photoNumber =
              photoNumberByEvidenceId.get(item.id) ?? fallbackPhotoNumberByEvidenceId.get(item.id) ?? index + 1;

            return (
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
                {item.imageUrl ? (
                  <figure
                    aria-label={t("review.photoNumber", { number: photoNumber })}
                    className="mt-3"
                  >
                    <EvidenceImage
                      alt={t("review.photoNumber", { number: photoNumber })}
                      className="h-auto max-h-72 w-auto max-w-full rounded-sm border border-steel/25 bg-ink-navy/45 object-contain"
                      fallbackClassName="flex min-h-16 min-w-32 items-center justify-center rounded-sm border border-steel/25 px-3 py-5 text-center text-xs text-steel"
                      height={288}
                      src={item.imageUrl}
                      unavailableText={t("evidence.photoUnavailable")}
                      width={432}
                    />
                    <figcaption className="mt-1 text-xs text-steel">
                      {t("review.photoNumber", { number: photoNumber })}
                    </figcaption>
                  </figure>
                ) : item.sourceUrl ? (
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
            );
          })}
        </AccordionContent>
      </AccordionItem>
    </Accordion>
  );
}
