"use client";

import { FormEvent, useState } from "react";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import type { Locale } from "@/domain/analysis";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { isAuto24ListingUrl, parseHttpsListingUrl } from "@/features/submission/listing-url";

interface SubmissionFormProps {
  locale: Locale;
}

export function SubmissionForm({ locale }: SubmissionFormProps) {
  const t = useTranslations("Submission");
  const router = useRouter();
  const [listingUrl, setListingUrl] = useState("");
  const [pastedText, setPastedText] = useState("");
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState(false);
  const [requestNeedsFallback, setRequestNeedsFallback] = useState(false);
  const parsedUrl = parseHttpsListingUrl(listingUrl);
  const unsupportedSource = parsedUrl !== null && !isAuto24ListingUrl(parsedUrl);
  const needsFallback = unsupportedSource || requestNeedsFallback;
  const inspectionMessage =
    listingUrl.length === 0
      ? t("inspectionWaiting")
      : parsedUrl === null
        ? t("inspectionInvalid")
        : unsupportedSource
          ? t("inspectionFallback")
          : t("inspectionAuto24");

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(undefined);
    setRequestNeedsFallback(false);

    if (!parsedUrl) {
      setError(t("invalidUrl"));
      return;
    }

    setPending(true);
    try {
      const response = await fetch("/api/analyses", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ locale, listingUrl: parsedUrl.href, ...(pastedText.trim() ? { pastedText: pastedText.trim() } : {}) }),
      });
      const body = (await response.json()) as { error?: string; url?: string };
      if (!response.ok || !body.url) {
        setError(body.error ?? t("requestFailed"));
        setRequestNeedsFallback(true);
        return;
      }

      router.push(body.url);
    } catch {
      setError(t("requestFailed"));
      setRequestNeedsFallback(true);
    } finally {
      setPending(false);
    }
  }

  return (
    <form className="space-y-4" noValidate onSubmit={handleSubmit}>
      <div className="space-y-2">
        <label className="block text-sm font-semibold text-foreground" htmlFor="listing-url">
          {t("label")}
        </label>
        <div className="flex flex-col gap-2 sm:flex-row">
          <Input
            autoComplete="url"
            aria-describedby="listing-inspection"
            aria-invalid={Boolean(error)}
            className="h-11 flex-1 border-steel/60 bg-blue-gray px-3 text-base shadow-none placeholder:text-steel/65 focus-visible:ring-2"
            id="listing-url"
            name="listingUrl"
            onChange={(event) => setListingUrl(event.target.value)}
            placeholder={t("placeholder")}
            required
            type="url"
            value={listingUrl}
          />
          <Button
            className="h-11 rounded-sm px-5 text-sm font-bold"
            disabled={pending}
            type="submit"
          >
            {pending ? t("pendingAction") : t("action")}
          </Button>
        </div>
        <p className="font-mono text-xs leading-5 text-steel" id="listing-inspection">
          {inspectionMessage}
        </p>
        {error ? (
          <p className="text-sm text-amber" role="alert">
            {error}
          </p>
        ) : null}
      </div>

      <div className="space-y-2">
        <label className="block text-sm font-semibold text-foreground" htmlFor="listing-description">{t("pastedLabel")}</label>
        <Textarea id="listing-description" maxLength={10_000} value={pastedText}
          onChange={(event) => setPastedText(event.target.value)}
          className="min-h-28 border-steel/60 bg-blue-gray p-3" />
        <p className="text-xs leading-5 text-steel">{t("pastedHint")}</p>
      </div>

      {needsFallback ? (
        <aside className="border-l-2 border-amber pl-3 text-sm text-steel">
          <p className="font-semibold text-foreground">{t("fallbackTitle")}</p>
          <p className="mt-1 leading-6">{t("fallbackDescription")}</p>
        </aside>
      ) : null}

      <p className="max-w-xl text-sm leading-6 text-steel">{t("explanation")}</p>
    </form>
  );
}
