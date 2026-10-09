import { useCallback, useEffect, useState } from "react";
import { Bot, Loader2, Power, X } from "lucide-react";
import { Badge, Btn, Select } from "@/components/ui";
import { useI18n } from "@/app/i18n";
import { api } from "@/api/client";
import type { LlamaStatus } from "@/api/client";

/**
 * Кнопка в шапке: включить/выключить локальную модель llama.cpp вручную.
 * Окно: выбор установленной модели, способа запуска (устройство) и контекста.
 * Включённая так модель не выгружается по простою, пока её не выключат.
 */

type Device = "auto" | "cpu" | "gpu" | "vulkan" | "cuda";
const LS = "moon:modelToggle";

/** Файлы, которые нельзя запускать как самостоятельную модель. */
const SKIP = /mmproj|embeddinggemma/i;

function loadPrefs(): { file: string; device: Device; ctx: number } {
  try {
    const v = JSON.parse(localStorage.getItem(LS) || "{}");
    return { file: v.file || "", device: v.device || "auto", ctx: Number(v.ctx) || 8192 };
  } catch {
    return { file: "", device: "auto", ctx: 8192 };
  }
}

export function ModelPanel({ onClose }: { onClose: () => void }) {
  const { t } = useI18n();
  const [st, setSt] = useState<LlamaStatus | null>(null);
  const [prefs, setPrefs] = useState(loadPrefs);
  const [busy, setBusy] = useState<"start" | "stop" | null>(null);
  const [err, setErr] = useState("");
  const refresh = useCallback(() => {
    api
      .llamaStatus()
      .then(setSt)
      .catch(() => {});
  }, []);

  // Пока окно закрыто — редкий опрос (для индикатора на кнопке), открыто — чаще.
  useEffect(() => {
    refresh();
    const id = window.setInterval(refresh, busy ? 1000 : 2500);
    return () => window.clearInterval(id);
  }, [refresh, busy]);

  useEffect(() => {
    try {
      localStorage.setItem(LS, JSON.stringify(prefs));
    } catch {
      /* без сохранения выбора */
    }
  }, [prefs]);

  const models = (st?.models ?? []).filter((m) => {
    if (SKIP.test(m.file)) return false;
    const c = st?.catalog.find((x) => x.file === m.file);
    return !c || (c.kind !== "tts" && c.kind !== "embed");
  });
  const label = (file: string): string => {
    const c = st?.catalog.find((x) => x.file === file);
    return c ? t(`llama.model.${c.id}`) : file.replace(/\.gguf$/i, "");
  };
  const builds = (st?.builds ?? []).filter((b) => b.installed).map((b) => b.id);
  const devices: { id: Device; name: string }[] = [
    { id: "auto", name: "Авто (лучшее доступное)" },
    ...(builds.includes("cpu") ? [{ id: "cpu" as Device, name: "Процессор (CPU)" }] : []),
    ...(builds.some((b) => b !== "cpu")
      ? [{ id: "gpu" as Device, name: "Видеокарта (любая)" }]
      : []),
    ...(builds.includes("cuda") ? [{ id: "cuda" as Device, name: "NVIDIA CUDA" }] : []),
    ...(builds.includes("vulkan") ? [{ id: "vulkan" as Device, name: "Vulkan" }] : []),
  ];

  const file = models.some((m) => m.file === prefs.file) ? prefs.file : (models[0]?.file ?? "");
  const server = st?.server ?? null;
  const on = !!server;

  const start = async () => {
    if (!file) return;
    setErr("");
    setBusy("start");
    try {
      await api.llamaStart({ file, device: prefs.device, ctx: prefs.ctx });
    } catch (e) {
      const m = (e as Error).message;
      setErr(
        m.includes("build_missing")
          ? "Нет подходящей сборки llama.cpp для этого способа запуска"
          : m,
      );
    } finally {
      setBusy(null);
      refresh();
    }
  };
  const stop = async () => {
    setErr("");
    setBusy("stop");
    try {
      await api.llamaStop();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(null);
      refresh();
    }
  };

  const fieldCap: React.CSSProperties = { marginBottom: 4 };
  return (
    <div
      className="proxy-panel-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="proxy-panel">
        <div className="proxy-panel-header">
          <div className="proxy-panel-title">
            <span className="proxy-shield">
              <Bot size={18} strokeWidth={2} />
            </span>
            <div className="proxy-title-text">
              <div className="proxy-eyebrow">llama.cpp</div>
              <div className="proxy-h1">Локальная модель</div>
            </div>
          </div>
          <button className="proxy-panel-close" onClick={onClose} title={t("common.close")}>
            <X size={15} />
          </button>
        </div>

        {err && <div className="proxy-error">{err}</div>}

        <div className="task-mgr-row">
          <div
            className="task-mgr-row-top"
            style={{ display: "flex", alignItems: "center", gap: 8 }}
          >
            <span className="task-mgr-label" style={{ flex: 1 }}>
              {busy === "start"
                ? "Загрузка модели…"
                : busy === "stop"
                  ? "Выключение…"
                  : on
                    ? label(server.file)
                    : "Выключена"}
            </span>
            {on && !busy && (
              <Badge tone="teal">
                {server.gpu ? "Видеокарта" : "Процессор"} · {t(`llama.build.${server.build}`)}
              </Badge>
            )}
            {busy && <Loader2 size={14} className="spin" />}
          </div>
          {on && !st?.pinned && !busy && (
            <div className="muted-sm">Запущена другой функцией — выгрузится при простое</div>
          )}
          {on && file !== server.file && !busy && (
            <div className="muted-sm">
              Чтобы запустить другую модель или способ, выключите и включите снова.
            </div>
          )}
        </div>

        {models.length === 0 ? (
          <div className="muted-sm">
            Нет установленных моделей. Скачайте модель и сборку llama.cpp в «Настройки → Чат».
          </div>
        ) : (
          <div className="task-mgr-section">
            <div className="task-mgr-section-title" style={fieldCap}>
              Модель
            </div>
            <Select
              value={file}
              onChange={(e) => setPrefs((p) => ({ ...p, file: e.target.value }))}
              options={models.map((m) => ({
                value: m.file,
                label: `${label(m.file)} · ${(m.sizeMb / 1024).toFixed(1)} GB`,
              }))}
              style={{ width: "100%", marginBottom: 12 }}
            />
            <div className="task-mgr-section-title" style={fieldCap}>
              Способ запуска
            </div>
            <Select
              value={devices.some((d) => d.id === prefs.device) ? prefs.device : "auto"}
              onChange={(e) => setPrefs((p) => ({ ...p, device: e.target.value as Device }))}
              options={devices.map((d) => ({ value: d.id, label: d.name }))}
              style={{ width: "100%", marginBottom: 12 }}
            />
            <div className="task-mgr-section-title" style={fieldCap}>
              Контекст
            </div>
            <Select
              value={String(prefs.ctx)}
              onChange={(e) => setPrefs((p) => ({ ...p, ctx: Number(e.target.value) }))}
              options={[4096, 8192, 16384, 32768].map((n) => ({
                value: String(n),
                label: `${n / 1024}K токенов`,
              }))}
              style={{ width: "100%", marginBottom: 12 }}
            />
            {builds.length === 0 && (
              <div className="muted-sm">
                Сначала установите сборку llama.cpp в «Настройки → Чат».
              </div>
            )}
          </div>
        )}

        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <Btn
            variant={on ? "secondary" : "primary"}
            icon={Power}
            disabled={!!busy || (!on && (!file || builds.length === 0))}
            onClick={() => void (on ? stop() : start())}
          >
            {on ? "Выключить" : "Включить"}
          </Btn>
        </div>
      </div>
    </div>
  );
}

/** Кнопка в шапке: зелёная точка — модель в памяти. */
export default function ModelToggle({ onClick }: { onClick: () => void }) {
  const [on, setOn] = useState(false);
  const [name, setName] = useState("");
  useEffect(() => {
    const tick = () =>
      api
        .llamaStatus()
        .then((s) => {
          setOn(!!s.server);
          setName(s.server?.file ?? "");
        })
        .catch(() => {});
    tick();
    const id = window.setInterval(tick, 5000);
    return () => window.clearInterval(id);
  }, []);
  return (
    <button
      className="task-mgr-toggle no-drag"
      onClick={onClick}
      title={on ? `Локальная модель: ${name}` : "Локальная модель"}
      aria-label="Локальная модель"
      style={{ position: "relative", color: on ? "var(--amber)" : undefined }}
    >
      <Bot size={15} />
      {on && (
        <span
          style={{
            position: "absolute",
            right: 3,
            top: 3,
            width: 6,
            height: 6,
            borderRadius: "50%",
            background: "#22c55e",
          }}
        />
      )}
    </button>
  );
}
