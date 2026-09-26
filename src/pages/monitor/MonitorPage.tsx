import React, { useState, useEffect, useRef, useMemo, memo } from "react";
import {
  Thermometer,
  Fan,
  HardDrive,
  Wifi,
  Info,
  CircleDot,
  Cpu,
  MemoryStick,
  Monitor,
  SlidersHorizontal,
  Copy,
  FolderSearch,
  StopCircle,
  RefreshCw,
  ChevronLeft,
  Timer,
  Play,
  FolderOpen,
  TerminalSquare,
  Archive,
  Trash2,
  Folder,
  File as FileIcon,
  Files,
} from "lucide-react";
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer } from "recharts";
import { Glass, Select, SectionHead, Btn, Field, Badge, EmptyHint } from "@/components/ui";
import { useContextMenu, copyToClipboard } from "@/components/ContextMenu";
import ToolbarMenu from "@/components/ToolbarMenu";
import { usePageToolbar, usePageActive } from "@/components/Toolbar";
import { useI18n } from "@/app/i18n";
import { api } from "@/api/client";
import type {
  LhmStatus,
  MonitorSnapshot,
  DiskNode,
  DiskExtStat,
  DiskScanStatus,
  AppTimeToday,
} from "@/api/types";

const INTERVAL_OPTIONS = [100, 200, 300, 500, 750, 1000];
const HIST_MAX = 60;
type CpuView = "cores" | "threads";
interface HistPoint {
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

/* ------------------------- Вспомогательные компоненты ---------------------- */

/** Усреднение логических потоков в физические ядра (гиперпоточность). */
function groupCores(per: number[], coresPhysical: number | null): number[] {
  const logical = per.length;
  if (!coresPhysical || coresPhysical <= 0 || logical === 0) return per.slice();
  if (logical % coresPhysical !== 0 || logical <= coresPhysical) return per.slice();
  const k = logical / coresPhysical;
  return Array.from({ length: coresPhysical }, (_, i) => {
    let sum = 0;
    for (let j = 0; j < k; j++) sum += per[i * k + j];
    return Math.round(sum / k);
  });
}

const CORE_COLORS = Array.from({ length: 32 }, (_, i) => `hsl(${(i * 47 + 20) % 360}, 70%, 62%)`);

/** График суммарной загрузки CPU/GPU (для вида «Всего»). */
const LoadChart = memo(function LoadChart({ points }: { points: HistPoint[] }) {
  // Сырые замеры (опрос каждые 500мс) дают рваную, дёрганую линию — сглаживаем
  // экспоненциальным скользящим средним только для отрисовки графика (сами
  // точные мгновенные значения по-прежнему хранятся в points/histRef и
  // используются как есть в плитках ядер и т.п.).
  const rows = useMemo(() => {
    const alpha = 0.35;
    let ecpu: number | null = null;
    let egpu: number | null = null;
    return points.map((p, idx) => {
      ecpu = ecpu == null ? p.cpu : ecpu + alpha * (p.cpu - ecpu);
      egpu = egpu == null ? p.gpu : egpu + alpha * (p.gpu - egpu);
      return { t: idx, cpu: ecpu, gpu: egpu };
    });
  }, [points]);
  return (
    <Glass className="chart-panel">
      <div className="field-label" style={{ marginBottom: 8 }}>
        CPU / GPU %
      </div>
      <ResponsiveContainer width="100%" height={180}>
        <AreaChart data={rows} margin={{ top: 4, right: 8, left: -24, bottom: 0 }}>
          <defs>
            <linearGradient id="cpuGrad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--amber)" stopOpacity={0.45} />
              <stop offset="100%" stopColor="var(--amber)" stopOpacity={0} />
            </linearGradient>
            <linearGradient id="gpuGrad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--violet)" stopOpacity={0.4} />
              <stop offset="100%" stopColor="var(--violet)" stopOpacity={0} />
            </linearGradient>
          </defs>
          <XAxis dataKey="t" hide />
          <YAxis
            domain={[0, 100]}
            tick={{ fontSize: 11, fill: "var(--text-tertiary)" }}
            width={30}
          />
          <Tooltip
            contentStyle={{
              background: "var(--surface-solid)",
              border: "1px solid var(--glass-border)",
              borderRadius: 10,
              fontSize: 12,
            }}
            labelFormatter={() => ""}
          />
          <Area
            type="natural"
            dataKey="cpu"
            stroke="var(--amber)"
            strokeWidth={2.5}
            strokeLinecap="round"
            strokeLinejoin="round"
            fill="url(#cpuGrad)"
            name="CPU %"
            isAnimationActive={false}
            dot={false}
            activeDot={{ r: 3 }}
          />
          <Area
            type="natural"
            dataKey="gpu"
            stroke="var(--violet)"
            strokeWidth={2.5}
            strokeLinecap="round"
            strokeLinejoin="round"
            fill="url(#gpuGrad)"
            name="GPU %"
            isAnimationActive={false}
            dot={false}
            activeDot={{ r: 3 }}
          />
        </AreaChart>
      </ResponsiveContainer>
    </Glass>
  );
});

/* -------------------- Плитки ядер/потоков (диспетчер задач) ----------------- */

/** Мини-график на чистом SVG — в десятки раз дешевле recharts для 12+ плиток. */
const Sparkline = memo(function Sparkline({ values, color }: { values: number[]; color: string }) {
  const w = 120;
  const h = 34;
  if (values.length < 2) {
    return (
      <svg
        viewBox={`0 0 ${w} ${h}`}
        preserveAspectRatio="none"
        style={{ width: "100%", height: h, display: "block" }}
      />
    );
  }
  const pt = (v: number, i: number): string => {
    const x = (i / (values.length - 1)) * w;
    const clamped = Math.max(0, Math.min(100, v));
    const y = h - 2 - (clamped / 100) * (h - 6);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  };
  const line = values.map(pt).join(" ");
  const area = `0,${h} ${line} ${w},${h}`;
  return (
    <svg
      viewBox={`0 0 ${w} ${h}`}
      preserveAspectRatio="none"
      style={{ width: "100%", height: h, display: "block" }}
    >
      <polygon points={area} fill={color} opacity={0.14} />
      <polyline
        points={line}
        fill="none"
        stroke={color}
        strokeWidth={1.8}
        vectorEffect="non-scaling-stroke"
        strokeLinejoin="round"
      />
    </svg>
  );
});

const SMOOTH_TAU_MS = 160; // постоянная времени экспоненциального сглаживания
const SMOOTH_EPS = 0.15; // % — порог «значение догнало цель»

/**
 * Плитки по каждому ядру/потоку.
 * Плавность: один rAF-цикл экспоненциально доводит отображаемые значения до
 * целевых (tau ≈ 160 мс), поэтому проценты «плывут», а не прыгают, даже если
 * сэмплы приходят рывками (окно замера CPU ≥250 мс).
 * ВАЖНО: цикл крутится только пока значения не «догнали» цель; как только
 * остановились — он засыпает и будится лишь на новый tick. Раньше rAF
 * планировался безусловно каждый кадр (60 fps вхолостую) — это и давало
 * постоянный аллокационный шторм и рост памяти на странице монитора.
 */
function CpuTiles({
  points,
  mode,
  coresPhysical,
  t,
  tick,
}: {
  points: HistPoint[];
  mode: "cores" | "threads";
  coresPhysical: number | null;
  t: (key: string, params?: Record<string, unknown>) => string;
  /** Номер успешного опроса: маркер «пришли новые данные» (points — мутируемый массив). */
  tick: number;
}) {
  const last = points[points.length - 1];
  const seriesCount = !last
    ? 0
    : mode === "threads"
      ? last.per.length
      : groupCores(last.per, coresPhysical).length;

  // История по каждой серии (для спарклайнов). points — один и тот же мутируемый
  // массив, поэтому зависим от tick: пересчёт ровно один раз на опрос, а не на
  // каждый кадр анимации (иначе аллоцировали бы N×HIST_MAX массивов 60 раз/с).
  const series = useMemo<number[][]>(() => {
    if (!seriesCount) return [];
    return Array.from({ length: seriesCount }, (_, i) =>
      points.map((p) => {
        const vals = mode === "threads" ? p.per : groupCores(p.per, coresPhysical);
        return vals[i] ?? 0;
      }),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tick, seriesCount, mode, coresPhysical]);

  // Целевые (последние) значения серий.
  const targetRef = useRef<number[]>([]);
  targetRef.current = series.map((s) => s[s.length - 1] ?? 0);

  const [disp, setDisp] = useState<number[]>(() => targetRef.current.slice());
  const dispRef = useRef<number[]>(disp);
  dispRef.current = disp;

  // Единственный rAF-цикл. Функция кадра хранится в ref, чтобы перезапуск
  // (и планирование следующего кадра изнутри себя) не ловил stale closure.
  const rafRef = useRef(0);
  const lastFrameRef = useRef(0);
  const stepRef = useRef<(now: number) => void>(() => {});

  stepRef.current = (now: number): void => {
    const dt = lastFrameRef.current ? Math.min(64, now - lastFrameRef.current) : 16;
    lastFrameRef.current = now;
    const tg = targetRef.current;
    const prev = dispRef.current;
    // Число серий изменилось (первый кадр или пришёл/ушёл coresPhysical) —
    // сразу принимаем цели: иначе cur[i] был бы undefined, dt-выражение дало бы
    // NaN и плитки «залипли» бы на нулях.
    if (prev.length !== tg.length) {
      const snapped = tg.slice();
      dispRef.current = snapped;
      setDisp(snapped);
      rafRef.current = 0;
      return;
    }
    const cur = prev.slice();
    let moved = false;
    for (let i = 0; i < tg.length; i++) {
      const d = tg[i] - cur[i];
      if (Math.abs(d) > SMOOTH_EPS) {
        cur[i] += d * (1 - Math.exp(-dt / SMOOTH_TAU_MS));
        moved = true;
      } else {
        cur[i] = tg[i];
      }
    }
    if (moved) {
      dispRef.current = cur;
      setDisp(cur);
      rafRef.current = requestAnimationFrame(stepRef.current);
    } else {
      rafRef.current = 0; // цель достигнута — цикл спит и не грузит CPU
    }
  };

  // Пришли новые данные — будим цикл (если он спал).
  useEffect(() => {
    lastFrameRef.current = 0;
    if (!rafRef.current) rafRef.current = requestAnimationFrame(stepRef.current);
  }, [tick]);

  // Размонтирование (в т.ч. смена вида через key) — гасим кадр.
  useEffect(
    () => () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      rafRef.current = 0;
    },
    [],
  );

  if (!seriesCount) return null;

  return (
    <div className="core-tiles">
      {Array.from({ length: seriesCount }, (_, i) => {
        const v = Math.max(0, Math.min(100, Math.round(disp[i] ?? 0)));
        const hot = v >= 85;
        return (
          <div key={i} className={`core-tile glass ${hot ? "is-hot" : ""}`}>
            <div className="core-tile-head">
              <span className="core-tile-name">
                {t(mode === "cores" ? "monitor.coreN" : "monitor.threadN", { n: i })}
              </span>
              <span className="core-tile-val" style={{ color: hot ? "var(--coral)" : undefined }}>
                {v}%
              </span>
            </div>
            <Sparkline
              values={series[i] ?? []}
              color={hot ? "var(--coral)" : CORE_COLORS[i % CORE_COLORS.length]}
            />
          </div>
        );
      })}
    </div>
  );
}

/** Карточка управления LibreHardwareMonitor, когда сенсоры недоступны. */
function LhmCard({ onChanged }: { onChanged: () => void }) {
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
function Donut({ label, value, color }: { label: string; value: number; color: string }) {
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

function SubHead({ children }: { children: React.ReactNode }) {
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

function SensorSections({ data }: { data: MonitorSnapshot }) {
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

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

/**
 * Список папок/файлов текущего уровня — иконка, имя, полоска относительного
 * веса (% от самого тяжёлого элемента уровня) и размер справа, как в
 * обычном проводнике/WinDirStat-списке. Пришли к этому виду вместо
 * treemap-квадратиков (recharts на реальных данных диска либо не
 * рендерился, либо ломался необъяснимо, а свой squarify-treemap на
 * практике читался хуже обычного списка).
 */
function DiskList({
  nodes,
  onOpenDir,
  onOpenBucket,
  onMenu,
}: {
  nodes: DiskNode[];
  onOpenDir: (n: DiskNode) => void;
  onOpenBucket: (n: DiskNode) => void;
  onMenu: (n: DiskNode, e: React.MouseEvent) => void;
}) {
  const maxSize = Math.max(1, ...nodes.map((n) => n.size));
  return (
    <div className="disk-list">
      {nodes.map((n, i) => {
        const clickable = (n.isDir && (n.hasChildren || n.fileCount > 0)) || n.isFilesBucket;
        const pct = Math.max(1.5, (n.size / maxSize) * 100);
        const Icon = n.isFilesBucket ? Files : n.isDir ? Folder : FileIcon;
        return (
          <div
            key={`${n.path}|${n.name}|${i}`}
            className="disk-list-row"
            title={n.path || n.name}
            onClick={() => {
              if (n.isFilesBucket) onOpenBucket(n);
              else if (n.isDir) onOpenDir(n);
            }}
            onContextMenu={(e) => {
              if (n.path) onMenu(n, e);
            }}
            style={{ cursor: clickable ? "pointer" : "default" }}
          >
            <div className="disk-list-bar" style={{ width: `${pct}%` }} />
            <Icon size={14} className="disk-list-icon" />
            <span className="disk-list-name">{n.name}</span>
            <span className="disk-list-meta muted-sm mono-val">
              {n.fileCount > 1 ? `${n.fileCount} · ` : ""}
              {fmtBytes(n.size)}
            </span>
          </div>
        );
      })}
    </div>
  );
}

/** Правая панель — разбивка ВСЕГО скана по расширениям файлов: .mp4, .zip
 *  и т.д. с суммарным весом и числом файлов. Клик — самые тяжёлые файлы
 *  этого расширения (см. api.diskScanExtFiles). */
function DiskExtPanel({
  exts,
  selected,
  onSelect,
}: {
  exts: DiskExtStat[];
  selected: string | null;
  onSelect: (ext: string) => void;
}) {
  const { t } = useI18n();
  const maxSize = Math.max(1, ...exts.map((e) => e.size));
  if (exts.length === 0) return <EmptyHint icon={HardDrive} text={t("monitor.diskScanEmptyDir")} />;
  return (
    <div className="disk-list">
      {exts.map((e) => (
        <div
          key={e.ext}
          className={`disk-list-row${selected === e.ext ? " is-active" : ""}`}
          onClick={() => onSelect(e.ext)}
          style={{ cursor: "pointer" }}
        >
          <div className="disk-list-bar" style={{ width: `${Math.max(1.5, (e.size / maxSize) * 100)}%` }} />
          <span className="disk-list-name">.{e.ext || t("monitor.diskScanNoExt")}</span>
          <span className="disk-list-meta muted-sm mono-val">
            {e.count} · {fmtBytes(e.size)}
          </span>
        </div>
      ))}
    </div>
  );
}

/**
 * Анализатор занятого места на диске (аналог WinDirStat): выбор корня →
 * фоновое сканирование (server/ts/diskScan.ts, попадает в общий Task Manager
 * как engine "diskscan") → список папок/файлов (DiskList выше) с drill-down
 * по клику плюс панель расширений (DiskExtPanel) справа. Каждый уровень
 * дерева подгружается лениво с сервера (api.diskScanResult(jobId, path)) —
 * полное дерево на клиент целиком не скачивается, только уже развёрнутые по
 * пути уровни, поэтому даже на полном диске в памяти рендерера не оседают
 * десятки МБ JSON.
 */
function DiskScanPanel() {
  const { t } = useI18n();
  const [roots, setRoots] = useState<string[]>([]);
  const [customPath, setCustomPath] = useState("");
  const [jobId, setJobId] = useState<string | null>(null);
  const [status, setStatus] = useState<DiskScanStatus | null>(null);
  const [pathStack, setPathStack] = useState<DiskNode[]>([]);
  const [error, setError] = useState("");
  const [info, setInfo] = useState("");
  const [levelLoading, setLevelLoading] = useState(false);
  const [exts, setExts] = useState<DiskExtStat[]>([]);
  const [extSelected, setExtSelected] = useState<string | null>(null);
  const [extFiles, setExtFiles] = useState<DiskNode[]>([]);
  const menu = useContextMenu();

  // Клик по папке — подгружаем ОДИН уровень (сама папка + её прямые дети, без
  // внуков) лениво с сервера вместо того, чтобы держать всё дерево на клиенте
  // сразу (см. api.diskScanResult / server/ts/diskScan.ts:getNode).
  const openDir = async (node: DiskNode) => {
    if (!jobId) return;
    setLevelLoading(true);
    try {
      const level = await api.diskScanResult(jobId, node.path);
      setPathStack((s) => [...s, level]);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLevelLoading(false);
    }
  };

  // Клик по бакету "Файлы (N)" — реальный список файлов этой ОДНОЙ папки
  // считается лениво на сервере (см. server/ts/diskScan.ts:listFiles), а не
  // хранится заранее в дереве, поэтому запрашиваем его только сейчас.
  const openFilesBucket = async (bucket: DiskNode) => {
    setLevelLoading(true);
    try {
      const { files } = await api.diskScanFiles(bucket.path);
      setPathStack((s) => [...s, { ...bucket, children: files }]);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLevelLoading(false);
    }
  };

  // Убрать плитку из текущего уровня (или из списка файлов расширения) после
  // успешного действия (удаление) — без повторного похода на сервер.
  const removeFromCurrentLevel = (nodePath: string) => {
    setPathStack((s) => {
      const stack = [...s];
      const top = stack[stack.length - 1];
      if (top?.children) {
        stack[stack.length - 1] = { ...top, children: top.children.filter((c) => c.path !== nodePath) };
      }
      return stack;
    });
    setExtFiles((files) => files.filter((f) => f.path !== nodePath));
  };

  // Панель расширений (справа) — клик выбирает/снимает выбор и лениво тянет
  // самые тяжёлые файлы этого расширения (см. server/ts/diskScan.ts:getExtFiles).
  const selectExt = async (ext: string) => {
    if (!jobId) return;
    if (extSelected === ext) {
      setExtSelected(null);
      setExtFiles([]);
      return;
    }
    setExtSelected(ext);
    setLevelLoading(true);
    try {
      const { files } = await api.diskScanExtFiles(jobId, ext);
      setExtFiles(files);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLevelLoading(false);
    }
  };

  const handleDelete = async (node: DiskNode) => {
    if (!window.confirm(t("monitor.diskScanDeleteConfirm", { name: node.name }))) return;
    try {
      await api.diskScanDelete(node.path, node.isDir);
      removeFromCurrentLevel(node.path);
      setInfo(t("monitor.diskScanDeleteDone", { name: node.name }));
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const handleCompress = async (node: DiskNode) => {
    try {
      const { dest } = await api.diskScanCompress(node.path);
      setInfo(t("monitor.diskScanCompressStarted", { name: dest }));
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const openMenuFor = (node: DiskNode, e: React.MouseEvent) => {
    // Псевдо-узлы ("…ещё N элементов", бакет "Файлы (N)") не соответствуют
    // одному реальному пути на диске — действия над ними не имеют смысла.
    if (node.isFilesBucket) return;
    menu.open(e, [
      {
        label: t("monitor.diskScanCopyPath"),
        icon: Copy,
        onClick: () => void copyToClipboard(node.path),
      },
      {
        label: t("monitor.diskScanReveal"),
        icon: FolderOpen,
        onClick: () => void api.diskScanReveal(node.path).catch((e) => setError((e as Error).message)),
      },
      {
        label: t("monitor.diskScanOpenConsole"),
        icon: TerminalSquare,
        onClick: () =>
          void api.diskScanConsole(node.path, node.isDir).catch((e) => setError((e as Error).message)),
      },
      {
        label: t("monitor.diskScanCompress"),
        icon: Archive,
        onClick: () => void handleCompress(node),
      },
      { separator: true },
      {
        label: node.isDir ? t("monitor.diskScanDeleteDir") : t("monitor.diskScanDeleteFile"),
        icon: Trash2,
        danger: true,
        onClick: () => void handleDelete(node),
      },
    ]);
  };

  useEffect(() => {
    api
      .diskScanRoots()
      .then((r) => setRoots(r.roots))
      .catch(() => setRoots([]));
  }, []);

  useEffect(() => {
    if (!jobId) return undefined;
    let stopped = false;
    // poll сам останавливает интервал по достижении финальной стадии —
    // раньше условие в setInterval сверялось с `status` из замыкания
    // эффекта (навсегда равным null, потому что эффект перезапускается
    // только по jobId), из-за чего опрос и повторное скачивание всего
    // результата продолжались раз в секунду бесконечно даже после
    // завершения скана — отсюда неконтролируемый рост памяти и зависание
    // после готового результата. `poll` ссылается на `timer` из
    // замыкания — это безопасно, т.к. само тело функции выполняется
    // асинхронно (после await), к этому моменту `timer` уже проинициализирован
    // ниже по коду.
    const poll = async () => {
      try {
        const st = await api.diskScanStatus(jobId);
        if (stopped) return;
        setStatus(st);
        if (st.stage === "done") {
          clearInterval(timer);
          const [result, extRes] = await Promise.all([api.diskScanResult(jobId), api.diskScanExts(jobId)]);
          if (!stopped) {
            setPathStack([result]);
            setExts(extRes.exts);
          }
        } else if (st.stage === "error" || st.stage === "cancelled") {
          clearInterval(timer);
          if (st.stage === "error") setError(st.error || "Ошибка сканирования");
        }
      } catch (e) {
        clearInterval(timer);
        if (!stopped) setError((e as Error).message);
      }
    };
    void poll();
    const timer = setInterval(() => void poll(), 1000);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [jobId]);

  const start = async (root: string) => {
    setError("");
    setInfo("");
    setPathStack([]);
    setStatus(null);
    setExts([]);
    setExtSelected(null);
    setExtFiles([]);
    try {
      const { id } = await api.diskScanStart(root);
      setJobId(id);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const cancel = async () => {
    if (jobId) await api.diskScanCancel(jobId);
    // Сбрасываем jobId и status вместе: иначе последний опрошенный статус
    // (ещё "scanning") остаётся висеть в state после остановки поллинга,
    // и кнопки запуска нового скана остаются задизейблены навсегда.
    setJobId(null);
    setStatus(null);
  };

  const current = pathStack[pathStack.length - 1] || null;
  const listData = current?.children?.filter((c) => c.size > 0) || [];

  return (
    <Glass className="chart-panel">
      <SubHead>{t("monitor.diskScan")}</SubHead>
      <div className="muted-sm" style={{ marginBottom: 8 }}>
        {t("monitor.diskScanHint")}
      </div>

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 10 }}>
        {roots.map((r) => (
          <Btn
            key={r}
            icon={HardDrive}
            onClick={() => void start(r)}
            disabled={status?.stage === "scanning"}
          >
            {r}
          </Btn>
        ))}
        <input
          className="text-input"
          style={{ width: 220 }}
          placeholder={t("monitor.diskScanCustomPath")}
          value={customPath}
          onChange={(e) => setCustomPath(e.target.value)}
        />
        <Btn
          icon={FolderSearch}
          disabled={!customPath.trim() || status?.stage === "scanning"}
          onClick={() => void start(customPath.trim())}
        >
          {t("monitor.diskScanStart")}
        </Btn>
        {status?.stage === "scanning" && (
          <Btn icon={StopCircle} onClick={() => void cancel()}>
            {t("monitor.diskScanCancel")}
          </Btn>
        )}
      </div>

      {status?.stage === "scanning" && (
        <div className="muted-sm" style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <RefreshCw size={14} className="spin" />
          {t("monitor.diskScanProgress", { n: status.scannedEntries })}
        </div>
      )}

      {error && (
        <div className="muted-sm" style={{ color: "var(--coral)" }}>
          {error}
        </div>
      )}

      {info && (
        <div className="muted-sm" style={{ color: "var(--teal, #3fc7ab)" }}>
          {info}
        </div>
      )}

      {levelLoading && (
        <div className="muted-sm" style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <RefreshCw size={14} className="spin" />
          {t("monitor.diskScanFilesLoading")}
        </div>
      )}

      {current && (
        <div style={{ display: "flex", gap: 14, alignItems: "flex-start" }}>
          <div style={{ flex: "2 1 0", minWidth: 0 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, margin: "8px 0" }}>
              {extSelected ? (
                <button
                  type="button"
                  className="icon-btn"
                  onClick={() => {
                    setExtSelected(null);
                    setExtFiles([]);
                  }}
                  title={t("monitor.diskScanUp")}
                >
                  <ChevronLeft size={15} />
                </button>
              ) : (
                pathStack.length > 1 && (
                  <button
                    type="button"
                    className="icon-btn"
                    onClick={() => setPathStack((s) => s.slice(0, -1))}
                    title={t("monitor.diskScanUp")}
                  >
                    <ChevronLeft size={15} />
                  </button>
                )
              )}
              {extSelected ? (
                <>
                  <Badge tone="amber" mono>
                    .{extSelected || t("monitor.diskScanNoExt")}
                  </Badge>
                  <span className="muted-sm">{t("monitor.diskScanExtFilesTitle")}</span>
                </>
              ) : (
                <>
                  <Badge tone="teal" mono>
                    {fmtBytes(current.size)}
                  </Badge>
                  <span className="muted-sm">{current.path || current.name}</span>
                </>
              )}
            </div>

            {extSelected ? (
              extFiles.length === 0 ? (
                <EmptyHint icon={HardDrive} text={t("monitor.diskScanEmptyDir")} />
              ) : (
                <div className="disk-list-scroll">
                  <DiskList
                    nodes={extFiles}
                    onOpenDir={() => {
                      /* файлы расширения — папок среди них не бывает */
                    }}
                    onOpenBucket={() => {
                      /* бакетов среди файлов расширения не бывает */
                    }}
                    onMenu={openMenuFor}
                  />
                </div>
              )
            ) : listData.length === 0 ? (
              <EmptyHint icon={HardDrive} text={t("monitor.diskScanEmptyDir")} />
            ) : (
              <div className="disk-list-scroll">
                <DiskList
                  nodes={listData}
                  onOpenDir={(n) => void openDir(n)}
                  onOpenBucket={(n) => void openFilesBucket(n)}
                  onMenu={openMenuFor}
                />
              </div>
            )}
          </div>

          <div style={{ flex: "1 1 0", minWidth: 220, maxWidth: 320 }}>
            <div className="muted-sm" style={{ margin: "8px 0" }}>
              {t("monitor.diskScanExtTitle")}
            </div>
            <div className="disk-list-scroll">
              <DiskExtPanel exts={exts} selected={extSelected} onSelect={(ext) => void selectExt(ext)} />
            </div>
          </div>
        </div>
      )}
    </Glass>
  );
}

function fmtDuration(totalSeconds: number): string {
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  if (h > 0) return `${h} ч ${m} мин`;
  if (m > 0) return `${m} мин`;
  return `${totalSeconds} с`;
}

/**
 * Трекер времени за приложениями: опрос активного окна раз в 5с через
 * долгоживущий PowerShell-процесс (server/ts/appTimeTracker.ts). Данные
 * копятся по дням, ничего никуда не отправляется — только storage/*.json.
 */
function AppTimeTrackerPanel() {
  const { t } = useI18n();
  const [tracking, setTracking] = useState(false);
  const [today, setToday] = useState<AppTimeToday | null>(null);
  const [error, setError] = useState("");

  const load = async () => {
    try {
      const [st, td] = await Promise.all([api.appTrackerStatus(), api.appTrackerToday()]);
      setTracking(st.tracking);
      setToday(td);
    } catch {
      /* сервер недоступен — пропускаем опрос */
    }
  };

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 10000);
    return () => clearInterval(timer);
  }, []);

  const toggle = async () => {
    setError("");
    try {
      if (tracking) await api.appTrackerStop();
      else {
        const r = await api.appTrackerStart();
        if (!r.ok) {
          setError(r.error === "windows_only" ? t("monitor.appTrackerWindowsOnly") : r.error || "");
          return;
        }
      }
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const maxSeconds = today?.apps[0]?.seconds || 1;

  return (
    <Glass className="chart-panel">
      <SubHead>{t("monitor.appTracker")}</SubHead>
      <div className="muted-sm" style={{ marginBottom: 8 }}>
        {t("monitor.appTrackerHint")}
      </div>
      <Btn
        variant="primary"
        icon={tracking ? StopCircle : Play}
        onClick={() => void toggle()}
        style={{ width: 200, marginBottom: 10 }}
      >
        {tracking ? t("monitor.appTrackerStop") : t("monitor.appTrackerStart")}
      </Btn>
      {error && <div style={{ color: "var(--coral)", marginBottom: 8 }}>{error}</div>}

      {today && today.apps.length === 0 && (
        <div className="muted-sm">{t("monitor.appTrackerEmpty")}</div>
      )}

      {today && today.apps.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {today.apps.slice(0, 12).map((a) => (
            <div key={a.name} style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <Timer size={13} className="muted-sm" />
              <span style={{ width: 160, fontSize: 12.5 }} title={a.name}>
                {a.name}
              </span>
              <div
                style={{
                  flex: 1,
                  height: 8,
                  borderRadius: 4,
                  background: "var(--track, rgba(255,255,255,0.06))",
                  overflow: "hidden",
                }}
              >
                <div
                  style={{
                    width: `${Math.max(2, (a.seconds / maxSeconds) * 100)}%`,
                    height: "100%",
                    background: "var(--amber)",
                  }}
                />
              </div>
              <span className="muted-sm" style={{ width: 90, textAlign: "right" }}>
                {fmtDuration(a.seconds)}
              </span>
            </div>
          ))}
        </div>
      )}
    </Glass>
  );
}
