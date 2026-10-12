"use client";

import { Dialog } from "@base-ui/react/dialog";
import { useTranslations } from "next-intl";
import type { AnalysisStatus } from "@/domain/analysis";
import { SupplementForm } from "@/features/supplements/supplement-form";

export function SupplementDialog({ open, onOpenChange, publicId, reportStatus, reportUpdatedAt }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  publicId: string;
  reportStatus: AnalysisStatus;
  reportUpdatedAt: string;
}) {
  const t = useTranslations("Report");
  return <Dialog.Root open={open} onOpenChange={onOpenChange}>
    <Dialog.Portal>
      <Dialog.Backdrop className="supplement-dialog-backdrop" />
      <Dialog.Popup className="supplement-dialog">
        <div className="supplement-dialog-header">
          <Dialog.Title>{t("supplement.heading")}</Dialog.Title>
          <Dialog.Close>{t("evidence.close")}</Dialog.Close>
        </div>
        <Dialog.Description className="sr-only">{t("supplement.intro")}</Dialog.Description>
        <SupplementForm variant="dialog" publicId={publicId} reportStatus={reportStatus} reportUpdatedAt={reportUpdatedAt} onSubmitted={() => onOpenChange(false)} />
      </Dialog.Popup>
    </Dialog.Portal>
  </Dialog.Root>;
}
