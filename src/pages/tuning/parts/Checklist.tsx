import { useState } from "react";
import { Checkbox } from "@/components/ui";
import { useI18n } from "@/app/i18n";
import { api } from "@/api/client";
import type { TuningCtx } from "@/pages/tuning/parts/tuningShared";

/** Пункты чек-листов (раздел → id). Тот же перечень, что в server/ts/tuningCatalog.ts (CHECKLIST). */
export const CHECKLIST: Record<string, string[]> = {
  bios: [
    "bios-backup",
    "bios-update",
    "bios-defaults",
    "bios-xmp",
    "bios-rebar",
    "bios-smt",
    "bios-virt",
    "bios-igpu",
    "bios-devices",
    "bios-csm",
    "bios-cstates",
    "bios-pcie",
    "bios-usb",
    "bios-fans",
  ],
  physical: ["ph-ssd", "ph-ram", "ph-wired", "ph-irq", "ph-cables", "ph-usb-layout"],
  cooling: ["co-paste", "co-airflow", "co-vrm", "co-curve", "co-dust"],
  peripherals: ["pe-clean", "pe-profile", "pe-rgb", "pe-dpi", "pe-monitor", "pe-overdrive"],
  stability: ["st-memtest", "st-prime", "st-temps", "st-timings", "st-clock"],
  install: ["in-gpt", "in-nic", "in-minimal", "in-bloat", "in-restore"],
  maintenance: ["ma-events", "ma-wpr", "ma-cleanup", "ma-backup"],
};

interface Props {
  section: string;
  ctx: TuningCtx;
}

/** Секция чек-листа с прогрессом; отметки сохраняются на сервере. */
export default function Checklist({ section, ctx }: Props) {
  const { t } = useI18n();
  const ids = CHECKLIST[section] ?? [];
  // Отметки меняем локально сразу: полный reload обзора считает статусы всех твиков (секунды).
  const [local, setLocal] = useState<Record<string, boolean>>({});
  const isOn = (id: string): boolean => local[id] ?? !!ctx.ov.checklist[id];
  const done = ids.filter(isOn).length;

  const toggle = async (id: string) => {
    const next = !isOn(id);
    setLocal((l) => ({ ...l, [id]: next }));
    try {
      await api.tuningChecklist(id, next);
    } catch (e) {
      setLocal((l) => ({ ...l, [id]: !next }));
      ctx.notify((e as Error).message, false);
    }
  };

  return (
    <div className="tn-check">
      <div className="tn-check-head">
        <b className="tn-card-title">{t(`tuning.section.${section}`)}</b>
        <span className="muted-sm">
          {done} / {ids.length}
        </span>
      </div>
      {ids.map((id) => (
        <div key={id} className="tn-row">
          <Checkbox checked={isOn(id)} onClick={() => void toggle(id)} />
          <div className="tn-row-main">
            <div className="tn-row-title">{t(`tuning.cl.${id}.t`)}</div>
            <div className="muted-sm">{t(`tuning.cl.${id}.d`)}</div>
          </div>
        </div>
      ))}
    </div>
  );
}
