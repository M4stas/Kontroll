"use client";

import { useMemo, useState } from "react";
import { CheckIcon, CopyIcon } from "@phosphor-icons/react/dist/ssr";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import type { Action } from "@/domain/analysis";

interface SellerMessageProps {
  actions: Action[];
}

export function SellerMessage({ actions }: SellerMessageProps) {
  const t = useTranslations("Report");
  const [copied, setCopied] = useState(false);
  const questions = actions.filter((action) => action.kind === "seller_question");
  const requests = actions.filter(
    (action) => action.kind === "photo_request" || action.kind === "document_request",
  );
  const message = useMemo(() => {
    const sections = [
      questions.length > 0
        ? `${t("seller.questions")}\n${questions.map((action) => `- ${action.instructions}`).join("\n")}`
        : "",
      requests.length > 0
        ? `${t("seller.requests")}\n${requests.map((action) => `- ${action.instructions}`).join("\n")}`
        : "",
    ].filter(Boolean);
    return sections.join("\n\n");
  }, [questions, requests, t]);

  if (!message) return null;

  async function copyMessage() {
    await navigator.clipboard.writeText(message);
    setCopied(true);
  }

  return (
    <section aria-labelledby="seller-message-title" className="bg-blue-gray/70 p-4 sm:p-5">
      <h2 className="text-lg font-semibold tracking-tight" id="seller-message-title">
        {t("seller.heading")}
      </h2>
      <p className="mt-1 text-sm leading-6 text-steel">{t("seller.intro")}</p>
      <Textarea
        aria-label={t("seller.previewLabel")}
        className="mt-4 min-h-44 resize-none rounded-sm border-steel/35 bg-ink-navy/45 p-3 leading-6 shadow-none"
        readOnly
        value={message}
      />
      <Button className="mt-3 min-h-11 rounded-sm px-4 font-bold" onClick={copyMessage} type="button">
        {copied ? <CheckIcon aria-hidden="true" /> : <CopyIcon aria-hidden="true" />}
        {copied ? t("seller.copied") : t("seller.copy")}
      </Button>
    </section>
  );
}
