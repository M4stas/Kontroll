"use client";
import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
export function RetryReview({ publicId }: { publicId: string }) {
  const t = useTranslations("Report.review");
  const router = useRouter();
  const busy = useRef(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState(false);
  const [queued, setQueued] = useState(false);
  async function retry() {
    if (busy.current) return;
    busy.current = true;
    setPending(true);
    setError(false);
    try {
      const response = await fetch(`/api/analyses/${publicId}/retry`, { method: "POST" });
      if (!response.ok) throw new Error("Retry unavailable");
      setQueued(true);
      router.refresh();
    } catch {
      setError(true);
    } finally {
      busy.current = false;
      setPending(false);
    }
  }
  return (
    <div className="mt-4">
      <Button className="min-h-11 px-4" type="button" disabled={pending || queued} onClick={() => void retry()}>
        {t(queued ? "retryQueued" : pending ? "retrying" : "retry")}
      </Button>
      {error ? (
        <p role="alert" className="mt-2 text-sm text-destructive">
          {t("retryFailed")}
        </p>
      ) : null}
    </div>
  );
}
