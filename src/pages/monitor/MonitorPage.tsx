import React, { useState, useRef, useMemo, useEffect } from "react";
import { Glass, Field, Select, SectionHead } from "@/components/ui";
import { useI18n } from "@/app/i18n";
import type { MonitorSnapshot } from "@/api/types";
import { api } from "@/api/client";
import { usePageActive, usePageToolbar } from "@/components/Toolbar";
import {
  CircleDot,
  SlidersHorizontal,
  Info,
  Cpu,
  Thermometer,
  Monitor,
  MemoryStick,
  Fan,
  HardDrive,
  Wifi,
} from "lucide-react";
import ToolbarMenu from "@/components/ToolbarMenu";
import { DiskScanPanel } from "@/pages/monitor/parts/MonitorDisk";
import { AppTimeTrackerPanel } from "@/pages/monitor/parts/AppTimeTrackerPanel";
import { CpuTiles, LoadChart } from "@/pages/monitor/parts/MonitorCharts";
import { Donut, LhmCard, SensorSections } from "@/pages/monitor/parts/MonitorSensors";

const INTERVAL_OPTIONS = [100, 200, 300, 500, 750, 1000];
const HIST_MAX = 60;
type CpuView = "cores" | "threads";
export interface HistPoint {
  t: number;
  cpu: number;
  gpu: number;
  per: number[];
}

function fmtUptime(sec: number): string {
  const d = Math.floor(sec / 86400),
    h = Math.floor((sec % 86400) / 3600),
    m = Math.floor((sec % 3600) / 60);
  return d > 0 ? `${d}d ${h}h` : h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function MetricCard({
  icon: Icon,
  tone,
  value,
  sub,
}: {
  icon: React.ElementType;
  tone: string;
  value: string;
  sub: string;
}) {
  return (
    <Glass className="metric-card">
      <Icon size={16} className={`tone-${tone}-ic`} />
      <div className="metric-value">{value}</div>
      <div className="muted-sm">{sub}</div>
    </Glass>
  );
}

function SensorList({
  rows,
  unit,
}: {
  rows: { key: string; name: string; value: number | null }[];
  unit: string;
}) {
  if (!rows.length) return null;
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))",
        gap: 6,
      }}
    >
      {rows.map((r) => (
        <div key={r.key} className="task-row" style={{ padding: "8px 10px" }}>
          <span className="task-text" title={r.name}>
            {r.name}
          </span>
          <span className="mono-val">
            {r.value != null ? `${Math.round(r.value * 100) / 100}${unit}` : "—"}
          </span>
        </div>
      ))}
    </div>
  );
}

function Panel({ title, children }: { title: React.ReactNode; children: React.ReactNode }) {
  return (
    <Glass className="chart-panel">
      <div className="field-label" style={{ marginBottom: 8 }}>
        {title}
      </div>
      {children}
    </Glass>
  );
}

export default function MonitorPage() {
  const { t } = useI18n();
  const [live, setLive] = useState(true);
  const [interval_, setInterval_] = useState<number>(500);
  const [view, setView] = useState<CpuView>("threads");
  const [data, setData] = useState<MonitorSnapshot | null>(null);
  const [tick, setTick] = useState(0); // перерисовка при обновлении истории
  const [pollNonce, setPollNonce] = useState(0); // немедленный опрос после действий с LHM
  const histRef = useRef<HistPoint[]>([]);
  const pendingRef = useRef(false); // не пускаем параллельные опросы: старый ответ может перезаписать новый

  // Иммутабельный снимок истории для дочерних компонентов. Сам histRef мутируется
  // напрямую (push/shift), поэтому передавать его в memo-дети нельзя — они бы
  // сравнивали ссылку и никогда не перерисовывались. Копия обновляется на новый tick.
  const points = useMemo(() => histRef.current.slice(), [tick]);

  // Стартовый интервал опроса — из настроек приложения (миллисекунды).
  useEffect(() => {
    api
      .getSettings()
      .then((s) => {
        const mon = (s as { monitor?: { refreshMs?: number; refreshInterval?: string } })?.monitor;
        if (typeof mon?.refreshMs === "number" && mon.refreshMs >= 100 && mon.refreshMs <= 1000) {
          setInterval_(mon.refreshMs);
        } else if (mon?.refreshInterval === "1s") setInterval_(1000);
        else if (mon?.refreshInterval === "5s") setInterval_(1000);
      })
      .catch(() => {});
  }, []);

  /* ── keep-alive ──
   * Страница больше не размонтируется при уходе, поэтому опрос нужно ставить на
   * паузу вручную: невидимый график не должен гонять запросы к железу.
   * При возвращении делаем один немедленный опрос (ниже, по isActive). */
  const isActive = usePageActive();

  useEffect(() => {
    let stopped = false;
    const poll = async (): Promise<void> => {
      if (pendingRef.current) return;
      pendingRef.current = true;
      try {
        const s = await api.getMonitor();
        if (stopped) return;
        setData(s);
        const gpuLoad = s.gpu[0]?.utilizationPercent ?? 0;
        const hist = histRef.current;
        // Точка добавляется на КАЖДЫЙ успешный опрос: пер-ядерные значения могут
        // меняться при неизменном тотале, а CpuTiles читает именно их.
        hist.push({
          t: hist.length,
          cpu: s.cpu.loadTotalPercent,
          gpu: gpuLoad,
          per: s.cpu.loadPerCorePercent,
        });
        if (hist.length > HIST_MAX) hist.shift();
        setTick((x) => x + 1);
      } catch {
        /* сервер недоступен — повторим по таймеру */
      } finally {
        pendingRef.current = false;
      }
    };
    if (isActive) void poll();
    if (!live || !isActive) return undefined;
    const timer = setInterval(() => void poll(), interval_);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [live, interval_, pollNonce, isActive]);

  usePageToolbar(
    <>
      {/* Live — иконка с цветовым индикатором: в панели не должно быть надписей. */}
      <button
        className={`live-pill ${live ? "is-live" : ""}`}
        onClick={() => setLive((v) => !v)}
        title={live ? t("monitor.live") : t("monitor.paused")}
      >
        <CircleDot size={12} />
      </button>
      {/* Вид CPU и частота опроса — в поповере (раньше это были два селекта
          с подписями, на узком окне они наезжали друг на друга).
          В заголовке поповера — ТЕКУЩИЕ значения, чтобы не дублировать
          подпись поля «Вид ЦП». */}
      <ToolbarMenu
        icon={SlidersHorizontal}
        title={t("monitor.view")}
        align="right"
        label={`${view === "threads" ? t("monitor.viewThreads") : t("monitor.viewCores")} · ${interval_} ms`}
      >
        <Field label={t("monitor.view")}>
          <Select
            value={view}
            onChange={(e) => setView(e.target.value as CpuView)}
            options={[
              { value: "cores", label: t("monitor.viewCores") },
              { value: "threads", label: t("monitor.viewThreads") },
            ]}
          />
        </Field>
        <Field label="ms">
          <Select
            value={String(interval_)}
            onChange={(e) => setInterval_(Number(e.target.value))}
            options={INTERVAL_OPTIONS.map((ms) => ({ value: String(ms), label: String(ms) }))}
          />
        </Field>
      </ToolbarMenu>
    </>,
    [live, interval_, view, t],
  );

  return (
    <div className="page">
      <div className="monitor-scroll">
        <MonitorBody
          data={data}
          t={t}
          points={points}
          tick={tick}
          view={view}
          onLhmChanged={() => setPollNonce((x) => x + 1)}
        />
        <DiskScanPanel />
        <AppTimeTrackerPanel />
      </div>
    </div>
  );
}

function MonitorBody({
  data,
  t,
  points,
  tick,
  view,
  onLhmChanged,
}: {
  data: MonitorSnapshot | null;
  points: HistPoint[];
  tick: number;
  view: CpuView;
  onLhmChanged: () => void;
  t: (key: string, params?: Record<string, unknown>) => string;
}): JSX.Element {
  if (!data) {
    return (
      <>
        <SectionHead eyebrow={t("monitor.eyebrow")} title={t("monitor.title")} />
        <Glass className="source-placeholder">
          <Info size={16} />
          <span>…</span>
        </Glass>
      </>
    );
  }

  const hasLhm = data.sources.lhm;

  return (
    <>
      <SectionHead
        eyebrow={t("monitor.eyebrow")}
        title={t("monitor.title")}
        action={
          <span
            className="badge tone-teal mono"
            title={`WMI: ${data.sources.wmi} · LHM: ${hasLhm} · nvidia-smi: ${data.sources.nvidiaSmi}`}
          >
            {data.system.hostname}
          </span>
        }
      />

      <div className="metric-row">
        <MetricCard
          icon={Cpu}
          tone="amber"
          value={`${data.cpu.loadTotalPercent}%`}
          sub={`CPU · ${data.cpu.coresLogical} ${t("monitor.cores").toLowerCase()}`}
        />
        <MetricCard
          icon={Thermometer}
          tone="amber"
          value={data.cpuTemp != null ? `${Math.round(data.cpuTemp)}°C` : "—"}
          sub={t("monitor.cpuTemp")}
        />
        <MetricCard
          icon={Monitor}
          tone="violet"
          value={
            data.gpu[0]?.utilizationPercent != null ? `${data.gpu[0].utilizationPercent}%` : "—"
          }
          sub={(data.gpu[0]?.name || "GPU").slice(0, 28)}
        />
        <MetricCard
          icon={Thermometer}
          tone="violet"
          value={data.gpuTemp != null ? `${Math.round(data.gpuTemp)}°C` : "—"}
          sub={t("monitor.gpuTemp")}
        />
        <MetricCard
          icon={MemoryStick}
          tone="teal"
          value={`${data.memory.usedPercent}%`}
          sub={`${t("monitor.ram")} · ${(data.memory.usedMb / 1024).toFixed(1)}/${(data.memory.totalMb / 1024).toFixed(0)} GB`}
        />
        <MetricCard
          icon={Fan}
          tone="teal"
          value={data.fans[0]?.rpm != null ? `${Math.round(data.fans[0].rpm)}` : "—"}
          sub={t("monitor.fanRpm", { n: 1 })}
        />
      </div>

      <LoadChart points={points} />

      {/* Ядра/потоки — плитками, как в диспетчере задач */}
      <CpuTiles
        key={view}
        points={points}
        tick={tick}
        mode={view}
        coresPhysical={data.cpu.coresPhysical}
        t={t}
      />

      {/* RAM / VRAM */}
      <div className="donut-row">
        <Glass className="chart-panel donut-panel">
          <Donut
            label={`${t("monitor.ram")} · ${(data.memory.usedMb / 1024).toFixed(1)} GB`}
            value={data.memory.usedPercent}
            color="var(--amber)"
          />
        </Glass>
        {data.vram != null && (
          <Glass className="chart-panel donut-panel">
            <Donut label={t("monitor.vram")} value={data.vram} color="var(--violet)" />
          </Glass>
        )}
      </div>

      {/* Дерево датчиков по железу (HWiNFO-стиль) */}
      <SensorSections data={data} />

      {!hasLhm && <LhmCard onChanged={onLhmChanged} />}

      {/* Диски */}
      {data.disks.length > 0 && (
        <Panel
          title={
            <>
              <HardDrive size={13} style={{ verticalAlign: "-2px" }} /> {t("monitor.disks")}
            </>
          }
        >
          <div style={{ display: "grid", gap: 8 }}>
            {data.disks.map((d) => {
              const usedGb =
                d.totalGb != null && d.freeGb != null ? +(d.totalGb - d.freeGb).toFixed(1) : null;
              const usedPct =
                usedGb != null && d.totalGb ? Math.round((100 * usedGb) / d.totalGb) : 0;
              const speeds =
                d.readMBs != null
                  ? `${t("monitor.readSpeed")} ${d.readMBs} · ${t("monitor.writeSpeed")} ${d.writeMBs ?? 0} MB/s`
                  : "";
              return (
                <div
                  key={d.drive}
                  className="task-row"
                  style={{ padding: "10px 12px", display: "block" }}
                >
                  <div
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      gap: 8,
                      marginBottom: 4,
                    }}
                  >
                    <span className="task-text">
                      {d.label} ({d.drive}){speeds ? ` — ${speeds}` : ""}
                    </span>
                    <span className="muted-sm mono-val" style={{ whiteSpace: "nowrap" }}>
                      {t("monitor.diskUsage", { used: usedGb ?? "?", total: d.totalGb ?? "?" })}
                    </span>
                  </div>
                  <div className="progress-track">
                    <div
                      className="progress-fill"
                      style={{
                        width: `${usedPct}%`,
                        background: usedPct > 90 ? "var(--coral)" : "var(--teal)",
                      }}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        </Panel>
      )}

      {/* Сеть */}
      {data.network.length > 0 && (
        <Panel
          title={
            <>
              <Wifi size={13} style={{ verticalAlign: "-2px" }} /> {t("monitor.network")}
            </>
          }
        >
          <SensorList
            unit=" KB/s"
            rows={data.network.slice(0, 6).map((n, i) => ({
              key: `n${i}`,
              name: n.name,
              value: (n.rxKBs ?? 0) + (n.txKBs ?? 0),
            }))}
          />
          <div className="muted-sm" style={{ marginTop: 6, display: "grid", gap: 2 }}>
            {data.network.slice(0, 6).map((n, i) => (
              <div key={i}>
                ↓{n.rxKBs ?? 0} / ↑{n.txKBs ?? 0} KB/s — {n.name}
                {n.ipv4.length ? ` (${n.ipv4.join(", ")})` : ""}
              </div>
            ))}
          </div>
        </Panel>
      )}

      {/* Система */}
      <Panel
        title={
          <>
            <Info size={13} style={{ verticalAlign: "-2px" }} /> {t("monitor.system")}
          </>
        }
      >
        <div
          className="muted-sm"
          style={{
            display: "grid",
            gap: 4,
            gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))",
          }}
        >
          <div>
            {t("monitor.os")}: {data.system.osName} {data.system.osVersion} (build{" "}
            {data.system.osBuild})
          </div>
          <div>
            CPU: {data.cpu.model}
            {data.cpu.powerWatt != null ? ` · ${Math.round(data.cpu.powerWatt)} W` : ""}
            {data.cpu.clockMhz != null ? ` · ${(data.cpu.clockMhz / 1000).toFixed(2)} GHz` : ""}
          </div>
          <div>
            {t("monitor.cores")}: {data.cpu.coresPhysical ?? "?"} / {data.cpu.coresLogical}
          </div>
          <div>
            {t("monitor.uptime")}: {fmtUptime(data.system.uptimeSec)}
          </div>
          {data.system.batteryPercent != null && <div>Battery: {data.system.batteryPercent}%</div>}
          <div>
            {t("monitor.host")}: {data.system.hostname} · {data.system.arch}
          </div>
        </div>
      </Panel>
    </>
  );
}
