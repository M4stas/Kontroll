"use client";

import { ArrowSquareOutIcon } from "@phosphor-icons/react/dist/ssr";
import { useTranslations } from "next-intl";
import { Dialog } from "@base-ui/react/dialog";
import type { Evidence, Locale } from "@/domain/analysis";
import { EvidenceImage } from "@/features/report/evidence-image";

interface EvidenceDisclosureProps {
  triggerLabel?: string;
  triggerClassName?: string;
  contentLocale: Locale;
  evidence: Evidence[];
  issueDescription: string;
  photoNumberByEvidenceId: ReadonlyMap<string, number>;
}

function capturedListingFacts(
  claim: string,
  t: ReturnType<typeof useTranslations<"Report">>,
): [string, string][] | null {
  let value: unknown;
  try { value = JSON.parse(claim); } catch { return null; }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const listing = value as Record<string, unknown>;
  const fields: [string, unknown][] = [
    [t("evidence.capturedFacts.vehicle"), listing.title],
    [t("evidence.capturedFacts.year"), listing.registrationYear ?? listing.year],
    [t("evidence.capturedFacts.firstRegistration"), listing.firstRegistration],
    [t("evidence.capturedFacts.mileage"), listing.mileageKm],
  ];
  if (listing.price && typeof listing.price === "object") {
    const price = listing.price as Record<string, unknown>;
    if (typeof price.amount === "number" && typeof price.currency === "string") {
      fields.push([t("evidence.capturedFacts.price"), `${price.amount} ${price.currency}`]);
    }
  }
  if (listing.otherFields && typeof listing.otherFields === "object" && !Array.isArray(listing.otherFields)) {
    const other = listing.otherFields as Record<string, unknown>;
    fields.push(
      [t("evidence.capturedFacts.vin"), other["VIN-kood"]],
      [t("evidence.capturedFacts.registrationNumber"), other["Reg. number"]],
      [t("evidence.capturedFacts.registrationStatus"), other.status],
      [t("evidence.capturedFacts.importedFrom"), other["brought from"]],
      [t("evidence.capturedFacts.location"), other.location],
    );
  }
  return fields.flatMap(([label, item]) =>
    typeof item === "string" || typeof item === "number" ? [[label, String(item)] as [string, string]] : []
  );
}

export function EvidenceDisclosure({
  triggerLabel,
  triggerClassName,
  contentLocale,
  evidence,
  issueDescription,
  photoNumberByEvidenceId,
}: EvidenceDisclosureProps) {
  const t = useTranslations("Report");
  const fallbackPhotoNumberByEvidenceId = new Map(
    evidence.filter((item) => item.imageUrl).map((item, index) => [item.id, index + 1]),
  );
  if (evidence.length === 0) return null;

  return (
    <Dialog.Root>
        <Dialog.Trigger className={triggerClassName ?? "mt-2 min-h-11 border-0 bg-transparent p-0 text-sm text-primary underline underline-offset-4"}>
          {triggerLabel ?? t("evidence.view")}
        </Dialog.Trigger>
        <Dialog.Portal>
          <Dialog.Backdrop className="fixed inset-0 z-40 bg-black/70" />
          <Dialog.Popup className="fixed left-1/2 top-1/2 z-50 max-h-[85dvh] w-[calc(100%_-_2rem)] max-w-3xl -translate-x-1/2 -translate-y-1/2 overflow-y-auto border border-border/30 bg-background p-5 shadow-2xl sm:p-8">
          <div className="mb-5 flex items-center justify-between gap-4">
            <Dialog.Title className="text-xl font-semibold">{t("evidence.view")}</Dialog.Title>
            <Dialog.Close className="min-h-11 cursor-pointer border border-border/30 bg-transparent px-3 text-sm text-primary">{t("evidence.close")}</Dialog.Close>
          </div>
          <Dialog.Description className="sr-only">{t("evidence.supportingDescription")}</Dialog.Description>
          <div className="space-y-4 text-muted-foreground">
          <p className="max-w-2xl text-sm leading-6" lang={contentLocale}>
            <span className="font-semibold text-foreground">{t("evidence.issueDescription")}</span>: {issueDescription}
          </p>
          {evidence.map((item, index) => {
            const capturedFacts = capturedListingFacts(item.claim, t);
            const photoNumber =
              photoNumberByEvidenceId.get(item.id) ?? fallbackPhotoNumberByEvidenceId.get(item.id) ?? index + 1;

            return (
              <blockquote className="m-0 border-l border-border/45 pl-3" key={item.id}>
                <p className="text-xs font-semibold text-muted-foreground">
                  {t(`sourceClass.${item.sourceClass}`)} / {t(`verification.${item.verification}`)}
                </p>
                {capturedFacts !== null ? <>
                  {capturedFacts.length ? <dl className="mt-3 grid gap-2 text-sm sm:grid-cols-2">
                    {capturedFacts.map(([label, value]) => <div key={label}>
                      <dt className="text-xs text-muted-foreground">{label}</dt>
                      <dd className="mt-1 break-words text-foreground" lang={contentLocale}>{value}</dd>
                    </div>)}
                  </dl> : <p className="mt-2 text-sm">{t("evidence.capturedListingData")}</p>}
                  <details className="mt-3 text-sm">
                    <summary className="min-h-11 cursor-pointer py-3 text-primary">{t("evidence.originalCapturedListing")}</summary>
                    <pre className="whitespace-pre-wrap break-all text-xs leading-5" lang={contentLocale}>{item.claim}</pre>
                  </details>
                </> : <p className="mt-2 max-w-2xl text-sm leading-6 text-foreground" lang={contentLocale}>
                  {item.claim}
                </p>}
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
                      className="h-auto max-h-72 w-auto max-w-full rounded-[14px] border border-border/25 bg-background/45 object-contain"
                      fallbackClassName="flex min-h-16 min-w-32 items-center justify-center rounded-[14px] border border-border/25 px-3 py-5 text-center text-xs text-muted-foreground"
                      height={288}
                      src={item.imageUrl}
                      unavailableText={t("evidence.photoUnavailable")}
                      width={432}
                    />
                    <figcaption className="mt-1 text-xs text-muted-foreground">
                      {t("review.photoNumber", { number: photoNumber })}
                    </figcaption>
                  </figure>
                ) : item.sourceUrl ? (
                  <a
                    className="mt-3 inline-flex min-h-11 items-center gap-1.5 text-xs font-semibold text-primary"
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
        </div>
          </Dialog.Popup>
        </Dialog.Portal>
    </Dialog.Root>
  );
}
