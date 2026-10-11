"use client";

import { useId, useState } from "react";
import { CheckIcon, CopyIcon } from "@phosphor-icons/react/dist/ssr";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import type { Action, Locale } from "@/domain/analysis";

interface SellerMessageProps {
  actions: Action[];
  contentLocale: Locale;
}

interface CopyResult {
  message: string;
  status: "copied" | "failed";
}

export function SellerMessage({ actions, contentLocale }: SellerMessageProps) {
  const t = useTranslations("Report");
  const [copyResult, setCopyResult] = useState<CopyResult | null>(null);
  const questionsTitleId = useId();
  const requestsTitleId = useId();
  const questions = actions.filter((action) => action.kind === "seller_question");
  const requests = actions.filter(
    (action) => action.kind === "photo_request" || action.kind === "document_request",
  );
  const questionInstructions = [...new Set(questions.map((action) => action.instructions))].map((instructions) => `- ${instructions}`).join("\n");
  const requestInstructions = [...new Set(requests.map((action) => action.instructions))].map((instructions) => `- ${instructions}`).join("\n");
  const message = [
    questionInstructions ? `${t("seller.questions")}\n${questionInstructions}` : "",
    requestInstructions ? `${t("seller.requests")}\n${requestInstructions}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
  const copyStatus = copyResult?.message === message ? copyResult.status : null;

  if (!message) return null;

  async function copyMessage() {
    if (!navigator.clipboard?.writeText) {
      setCopyResult({ message, status: "failed" });
      return;
    }
    try {
      await navigator.clipboard.writeText(message);
      setCopyResult({ message, status: "copied" });
    } catch {
      setCopyResult({ message, status: "failed" });
    }
  }

  return (
    <section aria-labelledby="seller-message-title" className="bg-blue-gray/70 p-4 sm:p-5">
      <h2 className="text-lg font-semibold tracking-tight" id="seller-message-title">
        {t("seller.heading")}
      </h2>
      <p className="mt-1 text-sm leading-6 text-steel">{t("seller.intro")}</p>
      {questionInstructions ? (
        <div className="mt-4">
          <h3 className="text-sm font-semibold text-pale-blue" id={questionsTitleId}>
            {t("seller.questions")}
          </h3>
          <Textarea
            aria-labelledby={questionsTitleId}
            className="mt-2 min-h-24 resize-none border-steel/35 bg-ink-navy/45 p-3 leading-6 shadow-none"
            lang={contentLocale}
            readOnly
            value={questionInstructions}
          />
        </div>
      ) : null}
      {requestInstructions ? (
        <div className="mt-4">
          <h3 className="text-sm font-semibold text-pale-blue" id={requestsTitleId}>
            {t("seller.requests")}
          </h3>
          <Textarea
            aria-labelledby={requestsTitleId}
            className="mt-2 min-h-24 resize-none border-steel/35 bg-ink-navy/45 p-3 leading-6 shadow-none"
            lang={contentLocale}
            readOnly
            value={requestInstructions}
          />
        </div>
      ) : null}
      <Button className="mt-3 min-h-11 px-4 font-bold" onClick={copyMessage} type="button">
        {copyStatus === "copied" ? (
          <CheckIcon aria-hidden="true" />
        ) : (
          <CopyIcon aria-hidden="true" />
        )}
        {copyStatus === "copied" ? t("seller.copied") : t("seller.copy")}
      </Button>
      {copyStatus === "failed" ? (
        <div className="mt-2">
          <p className="text-sm leading-6 text-amber">{t("seller.copyFailed")}</p>
          <Textarea
            aria-label={t("seller.fallbackLabel")}
            className="mt-2 min-h-44 resize-none border-steel/35 bg-ink-navy/45 p-3 leading-6 shadow-none"
            lang=""
            readOnly
            value={message}
          />
        </div>
      ) : null}
    </section>
  );
}
