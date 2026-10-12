import FolderInput from "@/components/FolderInput";
import { useEffect, useRef, useState } from "react";
import { Copy, FolderOpen, Trash2, Hourglass, Images, Search, StopCircle } from "lucide-react";
import { useI18n } from "@/app/i18n";
import { Glass, Btn, EmptyHint, Badge } from "@/components/ui";
import { SubHead } from "@/pages/monitor/parts/MonitorSensors";
import { api } from "@/api/client";

type Mode = "duplicates" | "forgotten" | "images";

const fmt = (n: number): string =>
  n < 1024 ** 2
    ? `${(n / 1024).toFixed(0)} KB`
    : n < 1024 ** 3
      ? `${(n / 1024 ** 2).toFixed(1)} MB`
      : `${(n / 1024 ** 3).toFixed(2)} GB`;

/** dHash 8×8: сравнивает яркость соседних пикселей уменьшенной копии → 16 hex-символов. */
function dHash(url: string): Promise<string | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      try {
        const c = document.createElement("canvas");
        c.width = 9;
        c.height = 8;
        const ctx = c.getContext("2d", { willReadFrequently: true });
        if (!ctx) return resolve(null);
        ctx.drawImage(img, 0, 0, 9, 8);
        const d = ctx.getImageData(0, 0, 9, 8).data;
        const g = (x: number, y: number): number => {
          const i = (y * 9 + x) * 4;
          return d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114;
        };
        let hex = "";
        for (let y = 0; y < 8; y++) {
          let byte = 0;
          for (let x = 0; x < 8; x++) byte = (byte << 1) | (g(x, y) > g(x + 1, y) ? 1 : 0);
          hex += byte.toString(16).padStart(2, "0");
        }
        resolve(hex);
      } catch {
        resolve(null);
      }
    };
    img.onerror = () => resolve(null);
    img.src = url;
  });
}

type Status = Awaited<ReturnType<typeof api.fileInsightsStatus>>;

/**
 * Дубликаты, забытые крупные файлы и похожие картинки. Сервер обходит папки и
 * считает хэши содержимого; для похожих изображений dHash считается здесь,
 * потому что декодер картинок есть в браузере.
 */
export function FileInsightsPanel() {
  const { t } = useI18n();
  const [mode, setMode] = useState<Mode>("duplicates");
  const [root, setRoot] = useState("");
  const [jobId, setJobId] = useState<string | null>(null);
  const [status, setStatus] = useState<Status | null>(null);
  const [groups, setGroups] = useState<{ files: string[]; note: string }[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const cancelled = useRef(false);

  async function finish(s: Status) {
    if (s.duplicates) {
      setGroups(s.duplicates.map((g) => ({ files: g.files, note: fmt(g.wasted) })));
    } else if (s.forgotten) {
      setGroups(
        s.forgotten.map((f) => ({
          files: [f.path],
          note: `${fmt(f.size)} · ${t("monitor.insightsIdle", { days: f.idleDays })}`,
        })),
      );
    } else if (s.images) {
      setBusy(true);
      const items: { path: string; hash: string }[] = [];
      for (const p of s.images.slice(0, 1500)) {
        if (cancelled.current) break;
        const h = await dHash(api.fileInsightsImageUrl(p));
        if (h) items.push({ path: p, hash: h });
      }
      try {
        const r = await api.fileInsightsSimilar(items, 6);
        setGroups(r.groups.map((g) => ({ files: g.files, note: `Δ ${g.maxDistance}` })));
      } catch (e) {
        setError((e as Error).message);
      }
      setBusy(false);
    }
  }

  useEffect(() => {
    if (!jobId) return;
    let stop = false;
    const tick = async () => {
      try {
        const s = await api.fileInsightsStatus(jobId);
        if (stop) return;
        setStatus(s);
        if (s.stage === "scanning" || s.stage === "hashing") setTimeout(tick, 700);
        else if (s.stage === "done") void finish(s);
      } catch (e) {
        if (!stop) setError((e as Error).message);
      }
    };
    void tick();
    return () => {
      stop = true;
    };
    // finish использует только setters и t, перезапуск по jobId достаточен
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId]);

  const run = async () => {
    setError("");
    setGroups(null);
    setStatus(null);
    cancelled.current = false;
    try {
      const { id } = await api.fileInsightsStart(mode, [root.trim()]);
      setJobId(id);
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const cancel = async () => {
    cancelled.current = true;
    if (jobId) await api.fileInsightsCancel(jobId).catch(() => undefined);
  };
  const remove = async (p: string) => {
    if (!window.confirm(t("monitor.diskScanDeleteConfirm", { name: p }))) return;
    try {
      await api.diskScanDelete(p, false);
      const keep = mode === "forgotten" ? 0 : 1;
      setGroups(
        (g) =>
          g
            ?.map((x) => ({ ...x, files: x.files.filter((f) => f !== p) }))
            .filter((x) => x.files.length > keep) ?? null,
      );
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const working = status?.stage === "scanning" || status?.stage === "hashing" || busy;
  const tabs: [Mode, string, typeof Copy][] = [
    ["duplicates", "monitor.insightsDup", Copy],
    ["forgotten", "monitor.insightsForgotten", Hourglass],
    ["images", "monitor.insightsSimilar", Images],
  ];

  return (
    <Glass className="p-4 mt-4">
      <SubHead>{t("monitor.insightsTitle")}</SubHead>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", margin: "8px 0" }}>
        {tabs.map(([m, key, Icon]) => (
          <Btn key={m} onClick={() => setMode(m)} variant={mode === m ? "primary" : "ghost"}>
            <Icon size={14} /> {t(key)}
          </Btn>
        ))}
      </div>
      <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
        <FolderInput
          placeholder={t("monitor.insightsRoot")}
          value={root}
          onChange={setRoot}
        />
        {working ? (
          <Btn onClick={cancel}>
            <StopCircle size={14} /> {t("monitor.diskScanCancel")}
          </Btn>
        ) : (
          <Btn variant="primary" onClick={run} disabled={!root.trim()}>
            {t("monitor.insightsRun")}
          </Btn>
        )}
      </div>
      {working && status && (
        <div style={{ fontSize: 12, opacity: 0.75 }}>
          {t("monitor.insightsScanned", { n: status.scanned })}
          {status.stage === "hashing" ? ` · ${status.progress}%` : ""}
        </div>
      )}
      {error && <div style={{ color: "var(--danger, #e66)", fontSize: 12 }}>{error}</div>}
      {groups && groups.length === 0 && (
        <EmptyHint icon={Search} text={t("monitor.insightsEmpty")} />
      )}
      {groups?.map((g, i) => (
        <div key={i} className="disk-list" style={{ marginTop: 10 }}>
          <Badge>{g.note}</Badge>
          {g.files.map((f) => (
            <div key={f} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12 }}>
              <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis" }} title={f}>
                {f}
              </span>
              <Btn variant="ghost" onClick={() => api.diskScanReveal(f)}>
                <FolderOpen size={13} />
              </Btn>
              <Btn variant="ghost" onClick={() => remove(f)}>
                <Trash2 size={13} />
              </Btn>
            </div>
          ))}
        </div>
      ))}
    </Glass>
  );
}
