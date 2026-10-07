/**
 * Выделено из MonitorPage.tsx при разбиении крупного файла (поведение не менялось).
 */
import { useI18n } from "@/app/i18n";
import React, { useState, useEffect } from "react";
import type { LhmStatus, MonitorSnapshot } from "@/api/types";
import { api } from "@/api/client";
import { Glass, Btn } from "@/components/ui";
import { useContextMenu, copyToClipboard } from "@/components/ContextMenu";
import { Copy } from "lucide-react";

/** Карточка управления LibreHardwareMonitor, когда сенсоры недоступны. */
export function LhmCard({ onChanged }: { onChanged: () => void }) {
  const { t } = useI18n();
  const [status, setStatus] = useState<LhmStatus | null>(null);
  const [busy, setBusy] = useState<"start" | "install" | null>(null);
  const [msg, setMsg] = useState("");

  const refresh = (): void => {
    api
      .getLhmStatus()
      .then(setStatus)
      .catch(() => {});
  };
  useEffect(() => {
    refresh();
    const iv = setInterval(refresh, 5000);
    return () => clearInterval(iv);
  }, []);

  if (status?.wmi) return null; // сенсоры уже работают

  const start = async (): Promise<void> => {
    setBusy("start");
    setMsg(t("monitor.lhmStarting"));
    try {
      await api.startLhm();
      refresh();
      onChanged();
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const downloadEngine = async (): Promise<void> => {
    setBusy("install");
    setMsg(t("monitor.lhmDownloading"));
    try {
      await api.downloadLhmEngine();
      refresh();
      onChanged();
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const installViaWinget = async (): Promise<void> => {
    setBusy("install");
    setMsg(t("monitor.lhmInstalling"));
    try {
      await api.installApp("winget:LibreHardwareMonitor.LibreHardwareMonitor");
      await new Promise((r) => setTimeout(r, 1500)); // даём winget дописать файлы
      refresh();
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <Glass
      className="source-placeholder"
      style={{
        borderColor: "var(--coral)",
        flexDirection: "column",
        alignItems: "flex-start",
        gap: 10,
      }}
    >
      <span>{t("monitor.noData")}</span>
      {msg && <span className="muted-sm">{msg}</span>}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        {status?.bundled ? (
          <Btn variant="primary" onClick={start} disabled={busy !== null}>
            {busy === "start" ? t("monitor.lhmStarting") : t("monitor.lhmStart")}
          </Btn>
        ) : (
          <Btn variant="primary" onClick={downloadEngine} disabled={busy !== null}>
            {busy === "install" ? t("monitor.lhmDownloading") : t("monitor.lhmDownload")}
          </Btn>
        )}
        {!status?.exePath && !status?.bundled && (
          <Btn variant="secondary" onClick={installViaWinget} disabled={busy !== null}>
            {busy === "install" ? t("monitor.lhmInstalling") : t("monitor.lhmInstall")}
          </Btn>
        )}
        {status?.exePath && !status?.bundled && (
          <Btn variant="secondary" onClick={start} disabled={busy !== null}>
            {t("monitor.lhmStart")}
          </Btn>
        )}
        {status?.pid != null && (
          <Btn
            onClick={async () => {
              await api.stopLhm();
              refresh();
            }}
          >
            {t("monitor.lhmStop")}
          </Btn>
        )}
      </div>
    </Glass>
  );
}

/** Кольцевая диаграмма на чистом CSS (conic-gradient), без recharts. */
export function Donut({ label, value, color }: { label: string; value: number; color: string }) {
  const clamped = Math.max(0, Math.min(100, Math.round(value)));
  return (
    <div className="donut-cell">
      <div
        style={{
          width: 120,
          height: 120,
          borderRadius: "50%",
          margin: "0 auto",
          background: `conic-gradient(${color} ${clamped * 3.6}deg, var(--track) 0deg)`,
          display: "grid",
          placeItems: "center",
        }}
      >
        <div
          style={{
            width: 86,
            height: 86,
            borderRadius: "50%",
            background: "var(--surface-solid)",
            display: "grid",
            placeItems: "center",
          }}
        >
          <div className="donut-value">{clamped}%</div>
        </div>
      </div>
      <div className="muted-sm" style={{ textAlign: "center", marginTop: 6 }}>
        {label}
      </div>
    </div>
  );
}

/* ------------------- Дерево датчиков по железу (HWiNFO-стиль) -------------- */

type AllSensor = {
  id: string;
  name: string;
  type: string;
  parent: string;
  hw: string;
  value: number | null;
};

function fmtSensor(s: AllSensor): string {
  const v = s.value;
  if (v == null || Number.isNaN(v)) return "—";
  const t = s.type.toLowerCase();
  const n = s.name.toLowerCase();
  if (t === "temperature") return `${Math.round(v)}°C`;
  if (t === "voltage") return `${v.toFixed(3)} V`;
  if (t === "current") return `${v.toFixed(2)} A`;
  if (t === "power") return `${v < 10 ? v.toFixed(2) : Math.round(v)} W`;
  if (t === "clock") return `${Math.round(v)} MHz`;
  if (t === "fan") return `${Math.round(v)} RPM`;
  if (t === "load") return `${Math.round(v)}%`;
  // Write Rate/Read Rate (диск) и GPU PCIe Rx/Tx — в гигабитах в секунду
  // (принятая единица для скоростей передачи), а не мегабайтах: та же величина
  // от LHM (МБ/с), переведённая ×8/1000. Проверяем ДО ветвления по типу —
  // у разных версий LHM это то "data"/"smalldata", то "throughput".
  if (/^write rate$|^read rate$|pcie rx|pcie tx/.test(n))
    return `${((v * 8) / 1000).toFixed(2)} Gbit/s`;
  if (t === "data" || t === "smalldata") {
    if (/life|spare|activity|warning|failure|error/.test(n)) return `${Math.round(v)}%`;
    // LibreHardwareMonitor уже отдаёт скорости чтения/записи диска в МБ/с,
    // а не в сырых байтах/сек — пересчитывать (делить на 1048576) было
    // ошибкой, из-за которой значения вроде 5.2 МБ/с показывались как
    // "5.2 KB/s".
    if (/rate|throughput|speed|io\b/.test(n)) return `${v.toFixed(2)} MB/s`;
    // Аналогично — объём диска (Total/Free/Used Space) LHM отдаёт сразу в
    // ГБ, а не в байтах, поэтому "960.19" — это уже гигабайты, а не байты.
    if (/space|capacity/.test(n) || /\/ram|gpu/.test(s.parent)) return `${v.toFixed(2)} GB`;
    if (v >= 1073741824) return `${(v / 1073741824).toFixed(2)} GB`;
    if (v >= 1048576) return `${(v / 1048576).toFixed(1)} MB`;
    if (v >= 1024) return `${(v / 1024).toFixed(0)} KB`;
    return `${v} B`;
  }
  if (t === "throughput") return `${v.toFixed(2)} MB/s`;
  if (t === "level") return `${Math.round(v)}%`;
  if (t === "factor") return v >= 1000 ? `${(v / 1000).toFixed(1)} K` : `${Math.round(v)}`;
  if (t === "control") return `${Math.round(v)}%`;
  return String(Math.round(v * 100) / 100);
}

function ValueList({ rows }: { rows: { key: string; name: string; text: string }[] }) {
  const { t } = useI18n();
  const menu = useContextMenu();
  if (!rows.length) return null;
  return (
    <div className="mono-grid">
      {rows.map((r) => (
        <div
          key={r.key}
          className="mono-row"
          onContextMenu={(e) =>
            menu.open(e, [
              {
                label: t("ctx.copyValue"),
                icon: Copy,
                onClick: () => void copyToClipboard(r.text),
              },
              {
                label: t("ctx.copyName"),
                icon: Copy,
                onClick: () => void copyToClipboard(r.name),
              },
            ])
          }
        >
          <span className="mono-name" title={r.name}>
            {r.name}
          </span>
          <span className="mono-val">{r.text}</span>
        </div>
      ))}
    </div>
  );
}

export function SubHead({ children }: { children: React.ReactNode }) {
  return (
    <div className="field-label" style={{ margin: "12px 0 6px" }}>
      {children}
    </div>
  );
}

const GROUP_KEYS: { type: string; key: string }[] = [
  { type: "Temperature", key: "monitor.temps" },
  { type: "Fan", key: "monitor.fans" },
  { type: "Voltage", key: "monitor.voltages" },
  { type: "Current", key: "monitor.currents" },
  { type: "Power", key: "monitor.powers" },
  { type: "Clock", key: "monitor.clocks" },
  { type: "Load", key: "monitor.loads" },
  { type: "Throughput", key: "monitor.speeds" },
  { type: "Level", key: "monitor.levels" },
  { type: "Control", key: "monitor.controls" },
];

function GenericGroups({
  sensors,
  hideTypes = [],
}: {
  sensors: AllSensor[];
  hideTypes?: string[];
}) {
  const { t } = useI18n();
  const visible = sensors.filter((s) => !hideTypes.includes(s.type));
  return (
    <>
      {GROUP_KEYS.map(({ type, key }) => {
        const rows = visible.filter((s) => s.type === type);
        if (!rows.length) return null;
        return (
          <div key={type}>
            <SubHead>{t(key)}</SubHead>
            <ValueList rows={rows.map((s) => ({ key: s.id, name: s.name, text: fmtSensor(s) }))} />
          </div>
        );
      })}
      {(() => {
        const rows = visible.filter(
          (s) =>
            s.type === "Data" ||
            s.type === "SmallData" ||
            s.type === "Factor" ||
            s.type === "Level" ||
            s.type === "Control" ||
            s.type === "Throughput",
        );
        if (!rows.length) return null;
        return (
          <div>
            <SubHead>{t("monitor.data")}</SubHead>
            <ValueList rows={rows.map((s) => ({ key: s.id, name: s.name, text: fmtSensor(s) }))} />
          </div>
        );
      })()}
    </>
  );
}

/** Сортировка «Core #N» по номеру. */
function coreNum(name: string): number | null {
  const m = name.match(/core\s*#?\s*(\d+)/i);
  return m ? parseInt(m[1], 10) : null;
}
function byCoreNum(a: AllSensor, b: AllSensor): number {
  return (coreNum(a.name) ?? 999) - (coreNum(b.name) ?? 999);
}

function ColumnPanel({ title, rows }: { title: string; rows: AllSensor[] }) {
  if (!rows.length) return null;
  return (
    <div className="mono-panel">
      <SubHead>{title}</SubHead>
      <div className="mono-grid">
        {rows.map((s) => (
          <div key={s.id} className="mono-row">
            <span className="mono-name">{s.name}</span>
            <span className="mono-val">{fmtSensor(s)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/** Имена сенсоров, которые не нужно показывать (мусор/дубликаты). */
const HIDDEN_SENSOR_NAMES = [
  /^temperature\s*#\d+$/i, // Temperature #2 и т.п. у накопителей
  /^warning\s*temperature$/i,
  /^critical\s*temperature$/i,
];

function isHiddenSensor(s: AllSensor): boolean {
  return HIDDEN_SENSOR_NAMES.some((re) => re.test(s.name.trim()));
}

export function SensorSections({ data }: { data: MonitorSnapshot }) {
  const { t } = useI18n();
  // Дедуплицируем по id: LHM иногда отдаёт один сенсор дважды (напр.
  // /gpu-nvidia/0/load/3). Дубли давали одинаковые React-ключи в списках
  // датчиков и лавину предупреждений в консоли на каждом опросе.
  const seenIds = new Set<string>();
  const all: AllSensor[] = (data.sensorsAll || []).filter((s) => {
    if (isHiddenSensor(s)) return false;
    if (s.id) {
      if (seenIds.has(s.id)) return false;
      seenIds.add(s.id);
    }
    return true;
  });
  if (!all.length) return null;

  // Группируем по префиксу parent: /amdcpu/ /intelcpu/ /lpc/ /gpu/ /nvme/ /ssd/ /hdd/
  const cpuSensors = all.filter((s) => /\/(amdcpu|intelcpu)\//i.test(s.parent));
  const mbSensors = all.filter((s) => /\/lpc\//i.test(s.parent));
  const gpuSensors = all.filter((s) => /\/gpu/i.test(s.parent));
  const driveSensors = all.filter((s) => /\/(nvme|hdd|ssd)\//i.test(s.parent));

  // Имена железа
  const hw = data.hardware || [];
  const cpuName = hw.find((h) => /amdcpu|intelcpu/i.test(h.id))?.name || "CPU";
  const mbName = hw.find((h) => /motherboard/i.test(h.id))?.name || "Motherboard";
  const gpuNames = new Map(hw.filter((h) => /gpu/i.test(h.id)).map((h) => [h.id, h.name]));
  const driveNames = new Map(
    hw.filter((h) => /(nvme|hdd|ssd)/i.test(h.id)).map((h) => [h.id, h.name]),
  );

  // Для накопителей — группируем по parent-префиксу (например /nvme/2)
  const driveGroups = new Map<string, AllSensor[]>();
  for (const s of driveSensors) {
    const m = s.parent.match(/\/(nvme|hdd|ssd)\/\d+/i);
    const key = m ? m[0] : s.parent;
    if (!driveGroups.has(key)) driveGroups.set(key, []);
    driveGroups.get(key)!.push(s);
  }

  // Для GPU — то же
  const gpuGroups = new Map<string, AllSensor[]>();
  for (const s of gpuSensors) {
    const m = s.parent.match(/\/gpu[a-z]*\/\d+/i);
    const key = m ? m[0] : s.parent;
    if (!gpuGroups.has(key)) gpuGroups.set(key, []);
    gpuGroups.get(key)!.push(s);
  }

  function getDriveName(key: string): string {
    for (const [id, name] of driveNames) {
      if (id.includes(key.replace(/^\//, "")) || key.includes(id)) return name;
    }
    return key;
  }

  function getGpuName(key: string): string {
    for (const [id, name] of gpuNames) {
      if (key.includes(id.replace(/^\//, "")) || id.includes(key.replace(/^\//, ""))) return name;
    }
    return key;
  }

  return (
    <>
      {/* ---- Процессор ---- */}
      {cpuSensors.length > 0 &&
        (() => {
          const s = cpuSensors;
          const tempsCore = s
            .filter((x) => x.type === "Temperature" && coreNum(x.name) != null)
            .sort(byCoreNum);
          const clocksAll = s
            .filter((x) => x.type === "Clock" && !/effective|bus|average/i.test(x.name))
            .sort(byCoreNum);
          const powersCore = s
            .filter((x) => x.type === "Power" && coreNum(x.name) != null)
            .sort(byCoreNum);
          const tempsPkg = s.filter((x) => x.type === "Temperature" && coreNum(x.name) == null);
          const restSensors = s.filter(
            (x) =>
              !(x.type === "Temperature" && coreNum(x.name) != null) &&
              !(x.type === "Clock") &&
              !(x.type === "Power" && coreNum(x.name) != null),
          );
          return (
            <Glass className="chart-panel">
              <SubHead>{t("monitor.hwCpu", { name: cpuName })}</SubHead>
              {tempsPkg.length > 0 && (
                <>
                  <SubHead>{t("monitor.temps")}</SubHead>
                  <ValueList
                    rows={tempsPkg.map((x) => ({ key: x.id, name: x.name, text: fmtSensor(x) }))}
                  />
                </>
              )}
              {(tempsCore.length > 0 || powersCore.length > 0 || clocksAll.length > 0) && (
                <div className="split" style={{ flexWrap: "wrap", gap: 14, marginTop: 6 }}>
                  <ColumnPanel title={t("monitor.coreTemps")} rows={tempsCore} />
                  <ColumnPanel title={t("monitor.corePowers")} rows={powersCore} />
                  <ColumnPanel title={t("monitor.coreClocks")} rows={clocksAll} />
                </div>
              )}
              <GenericGroups
                sensors={restSensors}
                hideTypes={["Factor", "Level", "Control", "Clock"]}
              />
            </Glass>
          );
        })()}

      {/* ---- Материнская плата (сенсоры LPC: напряжения, температуры, вентиляторы) ---- */}
      {mbSensors.length > 0 && (
        <Glass className="chart-panel">
          <SubHead>{t("monitor.hwMotherboard", { name: mbName })}</SubHead>
          <GenericGroups sensors={mbSensors} />
        </Glass>
      )}

      {/* ---- Накопители (по каждому отдельно) ---- */}
      {[...driveGroups.entries()].map(([key, s]) => (
        <Glass className="chart-panel" key={key}>
          <SubHead>{t("monitor.hwDrive", { name: getDriveName(key) })}</SubHead>
          <GenericGroups sensors={s} />
        </Glass>
      ))}

      {/* ---- Видеокарта ---- */}
      {[...gpuGroups.entries()].map(([key, s]) => (
        <Glass className="chart-panel" key={key}>
          <SubHead>{t("monitor.hwGpu", { name: getGpuName(key) })}</SubHead>
          <GenericGroups sensors={s} />
        </Glass>
      ))}
    </>
  );
}
