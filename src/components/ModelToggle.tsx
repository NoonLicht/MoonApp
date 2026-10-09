import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Bot, Loader2 } from "lucide-react";
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

export default function ModelToggle() {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [st, setSt] = useState<LlamaStatus | null>(null);
  const [prefs, setPrefs] = useState(loadPrefs);
  const [busy, setBusy] = useState<"start" | "stop" | null>(null);
  const [err, setErr] = useState("");
  const btnRef = useRef<HTMLButtonElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: 0, top: 0 });

  const refresh = useCallback(() => {
    api
      .llamaStatus()
      .then(setSt)
      .catch(() => {});
  }, []);

  // Пока окно закрыто — редкий опрос (для индикатора на кнопке), открыто — чаще.
  useEffect(() => {
    refresh();
    const id = window.setInterval(refresh, open || busy ? 1500 : 8000);
    return () => window.clearInterval(id);
  }, [refresh, open, busy]);

  useEffect(() => {
    try {
      localStorage.setItem(LS, JSON.stringify(prefs));
    } catch {
      /* без сохранения выбора */
    }
  }, [prefs]);

  useEffect(() => {
    if (!open) return;
    const r = btnRef.current?.getBoundingClientRect();
    if (r) setPos({ left: Math.max(8, r.left), top: r.bottom + 6 });
    const onDown = (e: MouseEvent) => {
      const n = e.target as Node;
      if (boxRef.current?.contains(n) || btnRef.current?.contains(n)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

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

  const row: React.CSSProperties = { display: "grid", gap: 4, marginBottom: 10 };
  const cap: React.CSSProperties = { fontSize: 11, color: "var(--text-tertiary)" };

  return (
    <>
      <button
        ref={btnRef}
        className="task-mgr-toggle no-drag"
        onClick={() => setOpen((v) => !v)}
        title={on ? `Модель включена: ${label(server.file)}` : "Локальная модель"}
        aria-label="Локальная модель"
        style={{ position: "relative", color: on ? "var(--amber)" : undefined }}
      >
        {busy ? <Loader2 size={15} className="spin" /> : <Bot size={15} />}
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
      {open &&
        createPortal(
          <div
            ref={boxRef}
            className="no-drag"
            style={{
              position: "fixed",
              left: pos.left,
              top: pos.top,
              zIndex: 2000,
              width: 320,
              maxWidth: "calc(100vw - 16px)",
              padding: 14,
              borderRadius: 14,
              border: "1px solid var(--glass-border)",
              background: "var(--bg-base)",
              boxShadow: "0 12px 40px rgba(0,0,0,.35)",
              fontSize: 13,
              color: "var(--text-primary)",
            }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                marginBottom: 12,
              }}
            >
              <b>Локальная модель</b>
              <button
                type="button"
                role="switch"
                aria-checked={on}
                aria-label={on ? "Выключить модель" : "Включить модель"}
                className={`switch ${on ? "is-on" : ""}`}
                disabled={!!busy || (!on && !file)}
                onClick={() => void (on ? stop() : start())}
              >
                <span className="switch-knob" />
              </button>
            </div>

            {models.length === 0 ? (
              <div style={cap}>
                Нет установленных моделей. Скачайте модель и сборку llama.cpp в «Настройки → Чат».
              </div>
            ) : (
              <>
                <label style={row}>
                  <span style={cap}>Модель</span>
                  <select
                    className="text-input"
                    value={file}
                    disabled={!!busy}
                    onChange={(e) => setPrefs((p) => ({ ...p, file: e.target.value }))}
                  >
                    {models.map((m) => (
                      <option key={m.file} value={m.file}>
                        {label(m.file)} · {(m.sizeMb / 1024).toFixed(1)} GB
                      </option>
                    ))}
                  </select>
                </label>
                <label style={row}>
                  <span style={cap}>Способ запуска</span>
                  <select
                    className="text-input"
                    value={devices.some((d) => d.id === prefs.device) ? prefs.device : "auto"}
                    disabled={!!busy}
                    onChange={(e) => setPrefs((p) => ({ ...p, device: e.target.value as Device }))}
                  >
                    {devices.map((d) => (
                      <option key={d.id} value={d.id}>
                        {d.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label style={row}>
                  <span style={cap}>Контекст</span>
                  <select
                    className="text-input"
                    value={prefs.ctx}
                    disabled={!!busy}
                    onChange={(e) => setPrefs((p) => ({ ...p, ctx: Number(e.target.value) }))}
                  >
                    {[4096, 8192, 16384, 32768].map((n) => (
                      <option key={n} value={n}>
                        {n / 1024}K токенов
                      </option>
                    ))}
                  </select>
                </label>
                {builds.length === 0 && (
                  <div style={cap}>Сначала установите сборку llama.cpp в «Настройки → Чат».</div>
                )}
              </>
            )}

            <div style={{ ...cap, marginTop: 4, lineHeight: 1.45 }}>
              {busy === "start"
                ? "Загрузка модели…"
                : busy === "stop"
                  ? "Выключение…"
                  : on
                    ? `Работает: ${label(server.file)} · ${server.gpu ? "видеокарта" : "процессор"} (${t(`llama.build.${server.build}`)})${st?.pinned ? "" : " · выгрузится при простое"}`
                    : "Выключена"}
            </div>
            {on && file !== server.file && !busy && (
              <div style={{ ...cap, marginTop: 4 }}>
                Чтобы запустить другую модель или способ, выключите и включите снова.
              </div>
            )}
            {err && <div style={{ marginTop: 6, fontSize: 12, color: "var(--coral)" }}>{err}</div>}
          </div>,
          document.body,
        )}
    </>
  );
}
