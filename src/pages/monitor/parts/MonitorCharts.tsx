/**
 * Выделено из MonitorPage.tsx при разбиении крупного файла (поведение не менялось).
 */
import { memo, useMemo, useRef, useState, useEffect } from "react";
import { Glass } from "@/components/ui";
import { ResponsiveContainer, AreaChart, XAxis, YAxis, Tooltip, Area } from "recharts";
import type { HistPoint } from "@/pages/monitor/MonitorPage";

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
export const LoadChart = memo(function LoadChart({ points }: { points: HistPoint[] }) {
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
            formatter={(value: number) => Math.round(value)}
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
export function CpuTiles({
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
