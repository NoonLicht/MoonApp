import { useCallback, useEffect, useRef, useState } from "react";
import { Gauge, ListOrdered, Upload, Trash2 } from "lucide-react";
import { Glass, Btn, EmptyHint } from "@/components/ui";
import { useI18n } from "@/app/i18n";
import { api } from "@/api/client";
import type { GameBenchRun } from "@/api/types";

type Item = Awaited<ReturnType<typeof api.gamesInsights>>["items"][number];
type Status = Item["status"];
const STATUSES: Status[] = ["playing", "backlog", "done", "dropped"];

const hours = (sec: number): string => `${(sec / 3600).toFixed(1)}`;

/**
 * Бэклог с временем игры, подбор настроек под целевой FPS и сравнение замеров
 * «до/после» (CSV из PresentMon, CapFrameX или MSI Afterburner).
 */
export default function GameInsightsPanel() {
  const { t } = useI18n();
  const [items, setItems] = useState<Item[]>([]);
  const [runs, setRuns] = useState<GameBenchRun[]>([]);
  const [error, setError] = useState("");
  const [tab, setTab] = useState<"backlog" | "recommend" | "bench">("backlog");

  // рекомендации
  const [gpu, setGpu] = useState("");
  const [fps, setFps] = useState(60);
  const [height, setHeight] = useState(1080);
  const [rec, setRec] = useState<Awaited<ReturnType<typeof api.gamesRecommend>> | null>(null);

  // замеры
  const [benchGame, setBenchGame] = useState("");
  const [label, setLabel] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);
  const [pick, setPick] = useState<string[]>([]);
  const [cmp, setCmp] = useState<Awaited<ReturnType<typeof api.gamesBenchCompare>> | null>(null);

  const load = useCallback(async () => {
    try {
      const [i, b] = await Promise.all([api.gamesInsights(), api.gamesBenchList()]);
      setItems(i.items);
      setRuns(b.runs);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    // Название видеокарты подставляем из телеметрии монитора, если она доступна.
    api
      .getMonitor()
      .then((m) => setGpu((g) => g || m.gpu?.[0]?.name || ""))
      .catch(() => undefined);
  }, []);

  const setStatus = async (id: string, status: Status) => {
    await api.gamesUpdate(id, { status });
    await load();
  };

  const runRecommend = async () => {
    try {
      setRec(await api.gamesRecommend(gpu, fps, height));
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const onCsv = async (file: File) => {
    if (!benchGame) return;
    try {
      await api.gamesBenchAdd(benchGame, label || file.name, await file.text());
      setLabel("");
      await load();
    } catch (e) {
      setError(
        /no_frame_data/.test((e as Error).message)
          ? t("games.insights.noFrames")
          : (e as Error).message,
      );
    }
  };

  const togglePick = (id: string) =>
    setPick((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id].slice(-2)));

  useEffect(() => {
    if (pick.length !== 2) {
      setCmp(null);
      return;
    }
    // Старый замер считаем «до», новый — «после».
    const [a, b] = pick.map((id) => runs.find((r) => r.id === id)).filter(Boolean) as GameBenchRun[];
    if (!a || !b) return;
    const [before, after] = a.at <= b.at ? [a, b] : [b, a];
    api.gamesBenchCompare(before.id, after.id).then(setCmp).catch(() => setCmp(null));
  }, [pick, runs]);

  const nameOf = (id: string) => items.find((i) => i.id === id)?.name ?? "?";

  return (
    <Glass className="p-4 gins-card">
      <div className="gins-tabs" title={t("games.insights.title")}>
        <button type="button" className={`gins-tab${tab === "backlog" ? " active" : ""}`} onClick={() => setTab("backlog")}>
          <ListOrdered size={14} /> {t("games.insights.backlog")}
        </button>
        <button type="button" className={`gins-tab${tab === "recommend" ? " active" : ""}`} onClick={() => setTab("recommend")}>
          <Gauge size={14} /> {t("games.insights.recommend")}
        </button>
        <button type="button" className={`gins-tab${tab === "bench" ? " active" : ""}`} onClick={() => setTab("bench")}>
          <Upload size={14} /> {t("games.insights.bench")}
        </button>
      </div>
      {error && <div style={{ color: "var(--danger, #e66)", marginBottom: 8 }}>{error}</div>}

      {tab === "backlog" && (
      <div className="gins-body">
        {items.length === 0 && <EmptyHint icon={ListOrdered} text={t("games.insights.empty")} />}
        {items.map((g) => (
          <div key={g.id} style={{ display: "flex", gap: 10, alignItems: "center", marginTop: 6 }}>
            <span style={{ flex: 1 }}>{g.name}</span>
            <span className="muted-sm">{t("games.insights.hours", { h: hours(g.playSeconds) })}</span>
            <select
              className="input"
              value={g.status}
              onChange={(e) => void setStatus(g.id, e.target.value as Status)}
            >
              {STATUSES.map((s) => (
                <option key={s} value={s}>
                  {t(`games.insights.status.${s}`)}
                </option>
              ))}
            </select>
          </div>
        ))}
      </div>
      )}

      {tab === "recommend" && (
      <div className="gins-body">
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 6 }}>
          <input
            className="input"
            style={{ flex: 1, minWidth: 180 }}
            value={gpu}
            placeholder={t("games.insights.gpu")}
            onChange={(e) => setGpu(e.target.value)}
          />
          <select className="input" value={height} onChange={(e) => setHeight(Number(e.target.value))}>
            {[1080, 1440, 2160].map((h) => (
              <option key={h} value={h}>
                {h}p
              </option>
            ))}
          </select>
          <select className="input" value={fps} onChange={(e) => setFps(Number(e.target.value))}>
            {[30, 60, 90, 120, 144, 240].map((f) => (
              <option key={f} value={f}>
                {f} FPS
              </option>
            ))}
          </select>
          <Btn variant="primary" onClick={runRecommend} disabled={!gpu.trim()}>
            {t("games.insights.pick")}
          </Btn>
        </div>
        {rec && (
          <div style={{ marginTop: 10 }}>
            <div>
              {t("games.insights.preset")}: <strong>{t(`games.insights.preset_${rec.preset}`)}</strong>
              {rec.upscaler !== "none" &&
                ` · ${t("games.insights.upscaler")}: ${t(`games.insights.up_${rec.upscaler}`)} (${Math.round(rec.renderScale * 100)}%)`}
              {rec.frameGen && ` · ${t("games.insights.frameGen")}`}
            </div>
            {rec.notes.map((n) => (
              <div key={n} className="muted-sm">
                {t(`games.insights.note_${n.replace(/-/g, "_")}`)}
              </div>
            ))}
          </div>
        )}
      </div>
      )}

      {tab === "bench" && (
      <div className="gins-body">
        <div className="muted-sm">{t("games.insights.benchHint")}</div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 6 }}>
          <select className="input" value={benchGame} onChange={(e) => setBenchGame(e.target.value)}>
            <option value="">{t("games.insights.chooseGame")}</option>
            {items.map((g) => (
              <option key={g.id} value={g.id}>
                {g.name}
              </option>
            ))}
          </select>
          <input
            className="input"
            style={{ flex: 1, minWidth: 140 }}
            value={label}
            placeholder={t("games.insights.label")}
            onChange={(e) => setLabel(e.target.value)}
          />
          <input
            ref={fileRef}
            type="file"
            accept=".csv,text/csv"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = "";
              if (f) void onCsv(f);
            }}
          />
          <Btn onClick={() => fileRef.current?.click()} disabled={!benchGame}>
            {t("games.insights.addCsv")}
          </Btn>
        </div>
        {runs.map((r) => (
          <div key={r.id} style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 6 }}>
            <input type="checkbox" checked={pick.includes(r.id)} onChange={() => togglePick(r.id)} />
            <span style={{ flex: 1 }}>
              {nameOf(r.gameId)} · {r.label}
            </span>
            <span className="muted-sm">
              {r.stats.avgFps} FPS · 1% low {r.stats.p1LowFps}
            </span>
            <Btn
              variant="ghost"
              onClick={async () => {
                await api.gamesBenchDelete(r.id);
                setPick((p) => p.filter((x) => x !== r.id));
                await load();
              }}
            >
              <Trash2 size={13} />
            </Btn>
          </div>
        ))}
        {cmp && (
          <div style={{ marginTop: 10 }}>
            <strong>{t(`games.insights.verdict_${cmp.diff.verdict}`)}</strong>
            <div className="muted-sm">
              {t("games.insights.avgDelta", {
                d: cmp.diff.avgFpsDelta,
                p: cmp.diff.avgFpsPct,
              })}
              {" · "}
              {t("games.insights.lowDelta", { d: cmp.diff.p1LowDelta, p: cmp.diff.p1LowPct })}
            </div>
          </div>
        )}
      </div>
      )}
    </Glass>
  );
}
