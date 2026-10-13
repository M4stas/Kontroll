"use client";

import { type FormEvent, useId, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import type { AnalysisStatus } from "@/domain/analysis";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

const MAX_PDF_SIZE = 12 * 1024 * 1024;

interface TaustakontrollFormProps {
  compact?: boolean;
  publicId: string;
  reportStatus: AnalysisStatus;
  reportUpdatedAt: string;
  finalReviewComplete?: boolean;
}

export function TaustakontrollForm({ publicId, reportStatus, reportUpdatedAt, finalReviewComplete = false, compact = false }: TaustakontrollFormProps) {
  const t = useTranslations("Report.taustakontroll");
  const router = useRouter();
  const introId = useId();
  const busy = useRef(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const lastSubmission = useRef<{ key: string; file: File } | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const [submittedFrom, setSubmittedFrom] = useState<string>();

  const reportChanged = submittedFrom !== undefined && reportUpdatedAt !== submittedFrom;
  const processed = reportChanged && reportStatus === "complete" && finalReviewComplete;
  const processingFailed = reportChanged && reportStatus === "failed";

  function selectFile(candidate: File | undefined) {
    setError(undefined);
    setSubmittedFrom(undefined);
    lastSubmission.current = null;

    if (!candidate) {
      setFile(null);
      return;
    }
    if (candidate.type !== "application/pdf") {
      setFile(null);
      if (fileInput.current) fileInput.current.value = "";
      setError(t("invalidPdf"));
      return;
    }
    if (candidate.size > MAX_PDF_SIZE) {
      setFile(null);
      if (fileInput.current) fileInput.current.value = "";
      setError(t("tooLarge"));
      return;
    }
    setFile(candidate);
  }

  function removeFile() {
    setFile(null);
    setError(undefined);
    setSubmittedFrom(undefined);
    lastSubmission.current = null;
    if (fileInput.current) fileInput.current.value = "";
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy.current || !file) return;

    setError(undefined);
    const previous = lastSubmission.current;
    const key = previous?.file === file ? previous.key : crypto.randomUUID();
    lastSubmission.current = { key, file };

    const body = new FormData();
    body.set("idempotencyKey", key);
    body.append("files", file);

    busy.current = true;
    setPending(true);
    try {
      const response = await fetch(`/api/analyses/${publicId}/submissions`, {
        method: "POST",
        body,
      });
      const payload = await response.json().catch(() => null) as { code?: string } | null;
      if (!response.ok) {
        setError(payload?.code === "invalid_pdf" ? t("invalidPdf") : t("uploadFailed"));
        return;
      }

      setSubmittedFrom(reportUpdatedAt);
      setFile(null);
      lastSubmission.current = null;
      if (fileInput.current) fileInput.current.value = "";
      router.refresh();
    } catch {
      setError(t("uploadFailed"));
    } finally {
      busy.current = false;
      setPending(false);
    }
  }

  return (
    <section className={compact ? "evidence-pdf" : "border-t border-border/30 py-5"} aria-label={compact ? t("heading") : undefined} aria-labelledby={compact ? undefined : "taustakontroll-title"}>
      {!compact ? <>
      <h2 className="text-lg font-semibold tracking-[-0.02em]" id="taustakontroll-title">
        {t("heading")}
      </h2>
      </> : null}
      <p id={introId} className={compact ? "sr-only" : "mt-1 max-w-2xl text-sm leading-6 text-muted-foreground"}>{t("intro")}</p>

      <form className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-end" onSubmit={handleSubmit}>
        <fieldset className="min-w-0 flex-1 space-y-2" disabled={pending}>
          <label className="text-sm font-semibold" htmlFor="taustakontroll-pdf-file">{t("fileLabel")}</label>
          <Input
            aria-describedby={compact ? introId : undefined}
            accept="application/pdf,.pdf"
            className="h-auto min-h-11 border-border/45 bg-secondary py-2 shadow-none file:mr-3 file:font-semibold"
            id="taustakontroll-pdf-file"
            onChange={(event) => selectFile(event.currentTarget.files?.[0])}
            ref={fileInput}
            type="file"
          />
          {file ? (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm" role="status">
              <span className="break-all">{file.name}</span>
              <span className="text-muted-foreground">{t("ready")}</span>
            </div>
          ) : submittedFrom ? (
            <p className="text-sm text-primary" role="status">{t(processed
              ? "processed" : processingFailed ? "updateFailed" : "accepted")}</p>
          ) : null}
          {error ? <p className="text-sm text-destructive" role="alert">{error}</p> : null}
        </fieldset>

        <div className="flex shrink-0 gap-2">
          {file ? (
            <Button
              className="min-h-11 px-4 font-semibold"
              disabled={pending}
              onClick={removeFile}
              type="button"
            >
              {t("remove")}
            </Button>
          ) : null}
          <Button className="min-h-11 px-5 font-bold" disabled={pending || !file} type="submit">
            {pending ? t("uploading") : t("upload")}
          </Button>
        </div>
      </form>
    </section>
  );
}
