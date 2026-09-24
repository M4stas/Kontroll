"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { Checkbox } from "@/components/ui/checkbox";
import type { Action, Locale } from "@/domain/analysis";
import { loadChecklist, saveChecklist } from "@/features/offline/report-cache";

interface ViewingChecklistProps {
  actions: Action[];
  contentLocale: Locale;
  publicId: string;
}

export function ViewingChecklist({ actions, contentLocale, publicId }: ViewingChecklistProps) {
  const t = useTranslations("Report");
  const [checked, setChecked] = useState<Set<string>>(() => new Set());
  useEffect(() => {
    let active = true;
    void loadChecklist(publicId).then((saved) => {
      if (active) setChecked(new Set(saved));
    }).catch(() => undefined);
    return () => { active = false; };
  }, [publicId]);
  const tasks = actions.filter(
    (action) => action.kind === "inspection_task" || action.kind === "workshop_recommendation",
  );
  if (tasks.length === 0) return null;

  return (
    <section aria-labelledby="checklist-title" className="border-t border-steel/30 pt-5">
      <h2 className="text-lg font-semibold tracking-tight" id="checklist-title">
        {t("checklist.heading")}
      </h2>
      <p className="mt-1 text-sm leading-6 text-steel">{t("checklist.intro")}</p>
      <div className="mt-3 divide-y divide-steel/20">
        {tasks.map((task) => (
          <label className="flex min-h-11 cursor-pointer items-start gap-3 py-3" key={task.id}>
            <Checkbox
              checked={checked.has(task.id)}
              className="mt-1 size-5 rounded-sm"
              onCheckedChange={(value) => {
                setChecked((current) => {
                  const next = new Set(current);
                  if (value) next.add(task.id);
                  else next.delete(task.id);
                  void saveChecklist(publicId, [...next]).catch(() => undefined);
                  return next;
                });
              }}
            />
            <span lang={contentLocale}>
              <span className="block text-sm font-semibold">{task.title}</span>
              <span className="mt-1 block text-sm leading-6 text-steel">{task.instructions}</span>
            </span>
          </label>
        ))}
      </div>
    </section>
  );
}
