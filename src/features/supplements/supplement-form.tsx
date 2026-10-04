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
  const busy = useRef(false);
  const lastSubmission = useRef<{
    key: string;
    text: string;
    files: File[];
    screenshots: File[];
  } | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const screenshotInput = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [answer, setAnswer] = useState("");
  const [listingText, setListingText] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [screenshots, setScreenshots] = useState<File[]>([]);
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
    if (selected.length + screenshots.length > 8) {
      setFiles([]);
      if (fileInput.current) fileInput.current.value = "";
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
    if (busy.current) return;
    setError(undefined);
    setSuccess(false);
    if (!answer.trim() && !listingText.trim() && files.length + screenshots.length === 0 && (!identityCorrection || !identityValue.trim())) {
      setError(t("invalid"));
      return;
    }

    const text = JSON.stringify([answer.trim(), listingText.trim(), identityCorrection, identityValue.trim()]);
    const previous = lastSubmission.current;
    const unchanged = previous && previous.text === text
      && previous.files.length === files.length
      && previous.screenshots.length === screenshots.length
      && previous.files.every((file, index) => file === files[index])
      && previous.screenshots.every((file, index) => file === screenshots[index]);
    const key = unchanged ? previous.key : crypto.randomUUID();
    lastSubmission.current = { key, text, files: [...files], screenshots: [...screenshots] };
    const body = new FormData();
    body.set("idempotencyKey", key);
    if (answer.trim()) body.set("sellerAnswer", answer.trim());
    if (listingText.trim()) body.set("listingText", listingText.trim());
    if (identityCorrection && identityValue.trim()) {
      body.set("identityCorrection", identityCorrection);
      body.set("identityValue", identityValue.trim());
    }
    for (const file of files) body.append("files", file);
    for (const file of screenshots) body.append("listingScreenshots", file);

    busy.current = true;
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
      setListingText("");
      setFiles([]);
      setScreenshots([]);
      setIdentityCorrection("");
      setIdentityValue("");
      if (fileInput.current) fileInput.current.value = "";
      if (screenshotInput.current) screenshotInput.current.value = "";
      lastSubmission.current = null;
      router.refresh();
    } catch {
      setError(t("failed"));
    } finally {
      busy.current = false;
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

          <form className="mt-6" onSubmit={handleSubmit}>
            <fieldset className="min-w-0 space-y-5" disabled={pending}>
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
                <label className="text-sm font-semibold" htmlFor="listing-text">{t("listingTextLabel")}</label>
                <Textarea className="mt-2 min-h-28 rounded-sm border-steel/45 bg-ink-navy/45 p-3 shadow-none"
                  id="listing-text" maxLength={10_000} value={listingText}
                  onChange={(event) => setListingText(event.target.value)} />
              </div>
              <div>
                <label className="text-sm font-semibold" htmlFor="listing-screenshots">{t("listingScreenshotsLabel")}</label>
                <Input accept="image/jpeg,image/png,image/webp" className="mt-2 h-auto min-h-11 border-steel/45 bg-blue-gray py-2"
                  id="listing-screenshots" multiple ref={screenshotInput} type="file"
                  onChange={(event) => {
                    const selected = Array.from(event.target.files ?? []);
                    if (selected.length + files.length > 8) {
                      setScreenshots([]);
                      event.target.value = "";
                      setError(t("tooManyFiles"));
                      return;
                    }
                    setError(undefined);
                    setScreenshots(selected);
                  }} />
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
            </fieldset>
          </form>
        </div>
      ) : null}
    </section>
  );
}
