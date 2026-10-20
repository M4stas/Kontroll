"use client";
import { useEffect, useId, useRef, type ReactNode } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";

export function DiagnosticsDrawer({
  title,
  open,
  onOpenChange,
  triggerClassName,
  children,
}: {
  title: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  triggerClassName?: string;
  children: ReactNode;
}) {
  const t = useTranslations("Diagnostics");
  const dialog = useRef<HTMLDialogElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  useEffect(() => {
    if (open) dialog.current?.showModal();
    else if (dialog.current?.open) dialog.current.close();
  }, [open]);
  const close = () => {
    onOpenChange(false);
    trigger.current?.focus();
  };
  return (
    <>
      {triggerClassName ? (
        <button ref={trigger} type="button" className={triggerClassName} onClick={() => onOpenChange(true)} aria-haspopup="dialog">
          {title}
        </button>
      ) : (
        <Button ref={trigger} className="my-4" variant="outline" onClick={() => onOpenChange(true)} aria-haspopup="dialog">
          {title}
        </Button>
      )}
      <dialog
        ref={dialog}
        className="diagnostics-drawer"
        aria-labelledby={titleId}
        onCancel={(event) => {
          event.preventDefault();
          close();
        }}
        onClose={close}
      >
        <header className="diagnostics-header">
          <h2 id={titleId}>{title}</h2>
          <Button variant="ghost" onClick={close} aria-label={t("close")}>
            ×
          </Button>
        </header>
        <div className="diagnostics-body">{children}</div>
      </dialog>
    </>
  );
}
