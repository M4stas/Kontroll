"use client";
import { useId, useState } from "react";
import { useTranslations } from "next-intl";
import { CheckIcon, CopyIcon, PaperclipIcon } from "@phosphor-icons/react/dist/ssr";
import type { Locale } from "@/domain/analysis";

export function MessageCard({ message, count, locale, onSellerReplied }: { message: string; count: number; locale: Locale; onSellerReplied?: () => void }) {
  const t = useTranslations("Report");
  const id = useId();
  const [result, setResult] = useState<{ message: string; status: "copied" | "failed" } | null>(null);
  const status = result?.message === message ? result.status : null;
  async function copy() {
    try {
      if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(message);
      else if (!copyWithSelection(message)) throw new Error("Clipboard unavailable");
      setResult({message, status: "copied"});
    } catch { setResult({message, status: "failed"}); }
  }
  return <div className="report-split report-message">
    <div className="report-card-copy">
      <h2 id={id}>{t("deck.messageTitle")}</h2><p>{t("deck.messageIntro", {count})}</p>
    </div>
    <div className="report-message-field">
      <textarea aria-labelledby={id} readOnly value={message} lang={locale} />
      <button type="button" className="primary-button" onClick={copy}>{status === "copied" ? <CheckIcon aria-hidden="true" /> : <CopyIcon aria-hidden="true" />}{t(status === "copied" ? "seller.copied" : "seller.copy")}</button>
      {onSellerReplied ? <button type="button" className="report-seller-replied" onClick={onSellerReplied}><PaperclipIcon aria-hidden="true" />{t("deck.sellerReplied")}</button> : null}
      {status === "failed" ? <div><p role="status">{t("seller.copyFailed")}</p><textarea aria-label={t("seller.fallbackLabel")} readOnly value={message} lang="" /></div> : null}
    </div>
  </div>;
}

// The clipboard API needs HTTPS or localhost. Over plain HTTP, copy from a selected text area.
function copyWithSelection(text: string): boolean {
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.style.position = "fixed";
  area.style.opacity = "0";
  document.body.append(area);
  area.select();
  try { return document.execCommand("copy"); } catch { return false; } finally { area.remove(); }
}
