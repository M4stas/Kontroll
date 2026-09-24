"use client";

import { FormEvent, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import type { AnalysisStatus } from "@/domain/analysis";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

interface SupplementFormProps {
  publicId: string;
  reportStatus: AnalysisStatus;
  reportUpdatedAt: string;
}

interface FileState {
  type: string;
  state: "ready" | "processing";
}

function fileTypeLabel(type: string): string {
  if (type === "application/pdf") return "PDF";
  return type.split("/")[1]?.toUpperCase() ?? type;
}

export function SupplementForm({ publicId, reportStatus, reportUpdatedAt }: SupplementFormProps) {
  const t = useTranslations("Report.supplement");
  const router = useRouter();
  const idempotencyKey = useRef(crypto.randomUUID());
  const fileInput = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [answer, setAnswer] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [fileStates, setFileStates] = useState<FileState[]>([]);
  const [identityCorrection, setIdentityCorrection] = useState("");
  const [identityValue, setIdentityValue] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const [success, setSuccess] = useState(false);
  const [submittedFrom, setSubmittedFrom] = useState<string>();
  const reportChanged = success && submittedFrom !== undefined && reportUpdatedAt !== submittedFrom;
  const processed = reportChanged && reportStatus === "complete";
  const processingFailed = reportChanged && reportStatus === "failed";

  function chooseFiles(selected: File[]) {
    setSuccess(false);
    setSubmittedFrom(undefined);
    if (selected.length > 8) {
      setFiles([]);
      setFileStates([]);
      setError(t("tooManyFiles"));
      return;
    }
    setError(undefined);
    setFiles(selected);
    setFileStates(selected.map((file) => ({ type: file.type, state: "ready" })));
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(undefined);
    setSuccess(false);
    if (!answer.trim() && files.length === 0 && (!identityCorrection || !identityValue.trim())) {
      setError(t("invalid"));
      return;
    }

    const body = new FormData();
    body.set("idempotencyKey", idempotencyKey.current);
    if (answer.trim()) body.set("sellerAnswer", answer.trim());
    if (identityCorrection && identityValue.trim()) {
      body.set("identityCorrection", identityCorrection);
      body.set("identityValue", identityValue.trim());
    }
    for (const file of files) body.append("files", file);

    setPending(true);
    try {
      const response = await fetch(`/api/analyses/${publicId}/submissions`, {
        method: "POST",
        body,
      });
      const payload = await response.json() as {
        files?: Array<{ type: string; state: "processing" }>;
      };
      if (!response.ok) {
        setError(t("failed"));
        return;
      }

      setFileStates((payload.files ?? []).map((file) => ({ ...file, state: "processing" })));
      setSubmittedFrom(reportUpdatedAt);
      setSuccess(true);
      setAnswer("");
      setFiles([]);
      setIdentityCorrection("");
      setIdentityValue("");
      if (fileInput.current) fileInput.current.value = "";
      idempotencyKey.current = crypto.randomUUID();
      router.refresh();
    } catch {
      setError(t("failed"));
    } finally {
      setPending(false);
    }
  }

  return (
    <section className="border-t border-steel/30 py-8" aria-labelledby="supplement-title">
      <h2 className={open ? "text-xl font-semibold tracking-[-0.02em]" : "sr-only"} id="supplement-title">
        {t("heading")}
      </h2>
      <Button
        aria-controls="supplement-form-panel"
        aria-expanded={open}
        className="min-h-11 rounded-sm px-5 font-bold"
        onClick={() => setOpen((value) => !value)}
        type="button"
      >
        {t("action")}
      </Button>
      {open ? (
        <div className="mt-4 max-w-3xl" id="supplement-form-panel">
          <p className="mt-2 max-w-2xl text-sm leading-6 text-steel">{t("intro")}</p>

          <form className="mt-6 space-y-5" onSubmit={handleSubmit}>
            <div>
              <label className="text-sm font-semibold" htmlFor="seller-answer">{t("answerLabel")}</label>
              <Textarea
                className="mt-2 min-h-28 rounded-sm border-steel/45 bg-ink-navy/45 p-3 shadow-none"
                id="seller-answer"
                maxLength={10_000}
                onChange={(event) => setAnswer(event.target.value)}
                placeholder={t("answerPlaceholder")}
                value={answer}
              />
            </div>

            <div>
              <label className="text-sm font-semibold" htmlFor="supplement-files">{t("filesLabel")}</label>
              <Input
                accept="image/jpeg,image/png,image/webp,application/pdf"
                className="mt-2 h-auto min-h-11 rounded-sm border-steel/45 bg-blue-gray py-2 shadow-none file:mr-3 file:font-semibold"
                id="supplement-files"
                multiple
                onChange={(event) => chooseFiles(Array.from(event.target.files ?? []))}
                ref={fileInput}
                type="file"
              />
              <p className="mt-1 text-xs leading-5 text-steel">{t("filesHint")}</p>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <label className="text-sm font-semibold" htmlFor="identity-correction">{t("identityLabel")}</label>
                <select
                  className="mt-2 min-h-11 w-full rounded-sm border border-steel/45 bg-blue-gray px-3 text-sm"
                  id="identity-correction"
                  onChange={(event) => setIdentityCorrection(event.target.value)}
                  value={identityCorrection}
                >
                  <option value="">{t("identityNone")}</option>
                  <option value="vin">{t("identityVin")}</option>
                  <option value="registrationPlate">{t("identityPlate")}</option>
                </select>
              </div>
              {identityCorrection ? (
                <div>
                  <label className="text-sm font-semibold" htmlFor="identity-value">{t("identityValueLabel")}</label>
                  <Input
                    className="mt-2 min-h-11 rounded-sm border-steel/45 bg-blue-gray shadow-none"
                    id="identity-value"
                    onChange={(event) => setIdentityValue(event.target.value)}
                    required
                    value={identityValue}
                  />
                </div>
              ) : null}
            </div>

            {fileStates.length > 0 ? (
              <ul className="divide-y divide-steel/20 border-y border-steel/20 text-sm">
                {fileStates.map((file, index) => (
                  <li className="flex min-h-10 items-center justify-between py-2" key={`${file.type}-${index}`}>
                    <span>{fileTypeLabel(file.type)}</span>
                    <span className="text-steel">{t(file.state === "processing"
                      ? processed ? "processed" : processingFailed ? "processingFailed" : "processing"
                      : "ready")}</span>
                  </li>
                ))}
              </ul>
            ) : null}

            {error ? <p className="text-sm text-amber" role="alert">{error}</p> : null}
            {success ? <p className="text-sm text-pale-blue" role="status">{t(processed
              ? "updated" : processingFailed ? "updateFailed" : "success")}</p> : null}

            <Button className="min-h-11 rounded-sm px-5 font-bold" disabled={pending} type="submit">
              {pending ? t("pending") : t("submit")}
            </Button>
          </form>
        </div>
      ) : null}
    </section>
  );
}
