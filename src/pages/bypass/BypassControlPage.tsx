import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Shield,
  ShieldOff,
  Play,
  Square,
  RefreshCw,
  CloudDownload,
  Terminal,
  FolderEdit,
  Star,
} from "lucide-react";
import { api } from "@/api/client";
import type {
  ZapretCheckLight,
  ZapretCheckState,
  ZapretEngine,
  ZapretInstallState,
  ZapretStatus,
  ZapretStrategy,
  ZapretUpdate,
} from "@/api/client";
import { useI18n } from "@/app/i18n";
import { usePageActive, usePageBusy } from "@/components/Toolbar";

/**
 * Bypass Control — простая страница обхода блокировок (Flowseal/zapret-discord-youtube).
 *
 * Никаких глубоких настроек, только четыре вещи:
 *   1) Движок — скачать/обновить релиз с GitHub и проверить обновления (с прогрессом);
 *   2) Конфиги — плитки general*.bat с огоньками результата проверки;
 *   3) Проверка — vendor-скрипт utils/test zapret.ps1 (пункт 12 service.bat «Run Tests»)
 *      в быстром режиме; его вывод построчно идёт в консоль справа;
 *   4) Запуск/остановка выбранного конфига одной кнопкой.
 *
 * Огоньки (результат последней проверки, живут до следующей):
 *   зелёный — конфиг работает: ни один HTTP/TLS-тест не упал, либо это конфиг, который
 *             vendor-скрипт назвал лучшим («Best config: …»);
 *   красный — не работает (не стартовал / есть ERR / ни одного успешного теста);
 *   серый   — ещё не проверялся.
 */

export default function BypassControlPage() {
  const { t } = useI18n();

  const [engine, setEngine] = useState<ZapretEngine | null>(null);
  const [status, setStatus] = useState<ZapretStatus | null>(null);
  const [strategies, setStrategies] = useState<ZapretStrategy[]>([]);
  const [selected, setSelected] = useState("general");
  const [update, setUpdate] = useState<ZapretUpdate | null>(null);
  const [installState, setInstallState] = useState<ZapretInstallState | null>(null);
  const [check, setCheck] = useState<ZapretCheckState | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  // Режим запуска: "service" (служба Windows — без окна консоли, аналог
  // service.bat → 1. Install Service) либо "process" (elevated winws — с окном).
  const [mode, setMode] = useState<"process" | "service">("service");
  const consoleRef = useRef<HTMLPreElement | null>(null);

  /** Понятный текст ошибки по коду бэкенда. */
  const errorText = useCallback(
    (e: unknown): string => {
      const raw = String((e as Error)?.message || e);
      if (raw.includes("service_installed")) return t("bypass.checkServiceBlocked");
      if (raw.includes("engine_not_found"))
        return t("bypass.engineNotFound", { dir: "storage/zapret" });
      if (raw.includes("uac_cancelled")) return t("bypass.uacCancelled");
      if (raw.includes("no_results")) return t("bypass.checkNoResults");
      if (raw.includes("stopped_by_user")) return t("bypass.consoleStopped");
      if (raw.includes("busy")) return t("bypass.checkRunningChip");
      return raw;
    },
    [t],
  );

  const refresh = useCallback(async () => {
    try {
      const [eng, st, strats] = await Promise.all([
        api.zapretEngine(),
        api.zapretStatus(),
        api.zapretStrategies(),
      ]);
      setEngine(eng);
      setStatus(st);
      setStrategies(strats);
      if (st.profile?.strategyId) setSelected(st.profile.strategyId);
    } catch (e) {
      setError(String((e as Error).message));
    }
  }, []);

  const checkUpdates = useCallback(async () => {
    setBusy("update");
    try {
      setUpdate(await api.zapretUpdate());
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy("");
    }
  }, [errorText]);

  useEffect(() => {
    void refresh();
    void checkUpdates();
    api
      .zapretCheckStatus()
      .then(setCheck)
      .catch(() => {
        /* ещё не проверяли */
      });
    // Сохранённый режим запуска (по умолчанию — служба, без окна консоли).
    api
      .getSettings()
      .then((s: unknown) => {
        const z = (s as { zapret?: { mode?: string } })?.zapret;
        setMode(z?.mode === "process" ? "process" : "service");
      })
      .catch(() => {
        /* дефолт — служба */
      });
  }, [refresh, checkUpdates]);

  const checkRunning = !!check?.running;

  /* ── keep-alive ──
   * Страница не размонтируется при уходе, поэтому «фоновый» опрос статуса
   * ставим на паузу по видимости. Прогон проверки и установка движка — задачи,
   * они продолжаются и помечают страницу занятой (нельзя выгружать из памяти). */
  const isActive = usePageActive();
  usePageBusy(checkRunning || installState?.state === "working");

  // Живой статус движка (во время проверки vendor-скрипт сам глушит и поднимает winws).
  useEffect(() => {
    if (checkRunning || !isActive) return;
    const timer = setInterval(() => {
      api
        .zapretStatus()
        .then(setStatus)
        .catch(() => {
          /* ignore */
        });
    }, 2500);
    return () => clearInterval(timer);
  }, [checkRunning, isActive]);

  // Возврат на страницу: сразу обновляем статус, чтобы кнопки не врали.
  useEffect(() => {
    if (!isActive) return;
    api
      .zapretStatus()
      .then(setStatus)
      .catch(() => {
        /* ignore */
      });
  }, [isActive]);

  // Прогресс установки/обновления движка.
  useEffect(() => {
    if (installState?.state !== "working") return;
    const timer = setInterval(async () => {
      try {
        const st = await api.zapretInstallStatus();
        setInstallState(st);
        if (st.state === "done") {
          await refresh();
          await checkUpdates();
        }
      } catch {
        /* ignore */
      }
    }, 900);
    return () => clearInterval(timer);
  }, [installState?.state, refresh, checkUpdates]);

  // Консоль проверки: поллинг во время прогона.
  useEffect(() => {
    if (!checkRunning) return;
    const timer = setInterval(() => {
      api
        .zapretCheckStatus()
        .then(setCheck)
        .catch(() => {
          /* ignore */
        });
    }, 1000);
    return () => clearInterval(timer);
  }, [checkRunning]);

  // Финал прогона: дочитываем последние строки (аналитика, «Best config») и статус движка.
  const checkFinished =
    !!check && !check.running && (check.state === "done" || check.state === "error");
  useEffect(() => {
    if (!checkFinished) return;
    api
      .zapretCheckStatus()
      .then(setCheck)
      .catch(() => {
        /* ignore */
      });
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [checkFinished]);

  // Автопрокрутка консоли к последней строке.
  useEffect(() => {
    const el = consoleRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [check?.log.length]);

  /* ---- Действия ---- */
  async function guard(action: string, fn: () => Promise<unknown>) {
    setBusy(action);
    setError("");
    try {
      await fn();
      await refresh();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy("");
      // Трей должен знать об изменении активного конфига.
      try {
        (
          window as unknown as { appBridge?: { refreshTray?: () => void } }
        ).appBridge?.refreshTray?.();
      } catch {
        /* dev/web */
      }
    }
  }

  const doStart = (strategyId: string) =>
    guard("start", async () => {
      setSelected(strategyId);
      setStatus(await api.zapretStart({ strategyId, mode }));
    });
  const doStop = () => guard("stop", () => api.zapretStop());
  // Смена режима: сохраняем в настройках, чтобы трей и следующий запуск его учли.
  const doSetMode = (m: string) =>
    guard("mode", async () => {
      const next: "process" | "service" = m === "process" ? "process" : "service";
      await api.zapretSaveSettings({ mode: next });
      setMode(next);
    });
  const doInstall = (tag?: string) =>
    guard("install", async () => {
      setInstallState(await api.zapretInstall(tag ? { tag } : undefined));
    });
  const doRemoveService = () => guard("service", () => api.zapretService("remove"));
  const doInstallService = (strategyId: string) =>
    guard("service", () => api.zapretService("install", strategyId));
  // Проверка ТОЛЬКО выбранного конфига (vendor-скрипт: standard tests, выбранные конфиги).
  const doCheckOne = (strategyId: string) => {
    setSelected(strategyId);
    setError("");
    api
      .zapretCheckStart(true, strategyId)
      .then(setCheck)
      .catch((e) => setError(errorText(e)));
  };

  async function doRunCheck() {
    setError("");
    try {
      setCheck(await api.zapretCheckStart(true));
    } catch (e) {
      setError(errorText(e));
    }
  }
  async function doStopCheck() {
    try {
      setCheck(await api.zapretCheckStop());
    } catch (e) {
      setError(errorText(e));
    }
  }
  async function doFixLists() {
    try {
      setCheck(await api.zapretFixUserLists());
    } catch (e) {
      setError(errorText(e));
    }
  }

  /* ---- Производные значения ---- */
  const active = !!status?.active;
  const current = useMemo(() => strategies.find((s) => s.id === selected), [strategies, selected]);
  const strategyName = current?.name || status?.strategy || selected;
  const lights = check?.lights || {};
  const bestId = check?.bestId || null;
  const greenCount = strategies.filter((s) => lightState(lights[s.id]) === "ok").length;
  const progressTotal = check?.progress.total || strategies.length;
  const progressDone = check?.progress.done || 0;
  const installWorking = installState?.state === "working";
  return (
    <div className="page bp-page">
      {/* Статус + запуск/остановка одной кнопкой */}
      <div className={`bp-banner ${active ? "on" : "off"}`}>
        <div className="bp-banner-main">
          {active ? <Shield size={22} /> : <ShieldOff size={22} />}
          <div>
            <div className="bp-badge">
              {active ? t("bypass.active", { strategy: strategyName }) : t("bypass.stopped")}
            </div>
            <div className="bp-dim">
              {active && status?.process.pid
                ? t("bypass.pidMem", {
                    pid: status.process.pid,
                    mem: status.process.memKb ? Math.round(status.process.memKb / 1024) : 0,
                  })
                : t("bypass.selectHint")}
            </div>
          </div>
        </div>
        <div className="bp-banner-actions">
          {checkRunning && <span className="bp-chip run">{t("bypass.checkRunningChip")}</span>}
          <label
            className="bp-mode"
            title={mode === "service" ? t("bypass.modeServiceHint") : t("bypass.modeProcessHint")}
          >
            <span className="bp-dim">{t("bypass.mode")}</span>
            <select
              value={mode}
              disabled={active || busy === "mode"}
              onChange={(e) => void doSetMode(e.target.value)}
            >
              <option value="service">{t("bypass.modeService")}</option>
              <option value="process">{t("bypass.modeProcess")}</option>
            </select>
          </label>
          {!active ? (
            <button
              className="bp-btn success"
              disabled={busy === "start" || !engine?.found}
              onClick={() => void doStart(selected)}
            >
              <Play size={16} /> {busy === "start" ? t("bypass.starting") : t("bypass.start")}
            </button>
          ) : (
            <button
              className="bp-btn danger"
              disabled={busy === "stop"}
              onClick={() => void doStop()}
            >
              <Square size={16} /> {t("bypass.stop")}
            </button>
          )}
          <button className="bp-btn ghost" onClick={() => void refresh()}>
            <RefreshCw size={14} />
          </button>
        </div>
      </div>

      {!engine?.found && (
        <div className="bp-warn">
          {t("bypass.engineNotFound", { dir: engine?.installDir || "storage/zapret" })}
        </div>
      )}
      {!!status?.service?.installed && (
        <div className="bp-warn bp-warn-row">
          <span>{t("bypass.serviceWarn")}</span>
          <button
            className="bp-btn tiny"
            disabled={busy === "service"}
            onClick={() => void doRemoveService()}
          >
            {t("bypass.serviceRemove")}
          </button>
        </div>
      )}
      {error && <div className="bp-error">{error}</div>}
      {!!engine?.found && (
        <div className="bp-note">
          <Terminal size={14} />{" "}
          <span>
            {mode === "service" ? t("bypass.modeServiceHint") : t("bypass.modeProcessHint")}
          </span>
        </div>
      )}

      {/* Движок: проверка обновлений + скачать/обновить релиз с GitHub */}
      <section className="bp-card bp-engine-card">
        <h3>
          <CloudDownload size={15} /> {t("bypass.engineTitle")}
        </h3>
        <div className="bp-engine-row">
          <div className="bp-engine-info">
            <div className="bp-engine-line">
              <strong>
                {engine?.version ? `zapret ${engine.version}` : t("bypass.engineNotInstalled")}
              </strong>
              <span className="bp-sep">·</span>
              <span className="bp-dim">
                {t("bypass.engineLatest")}: <b>{update?.latest || "—"}</b>
              </span>
              {update?.hasUpdate ? (
                <span className="bp-chip off">{t("bypass.updateAvailable")}</span>
              ) : update?.latest ? (
                <span className="bp-chip on">{t("bypass.upToDate")}</span>
              ) : null}
            </div>
            <div className="bp-dim">{engine?.dir || engine?.installDir || ""}</div>
            {!!update?.notes && (
              <details className="bp-notes">
                <summary>{t("bypass.releaseNotes")}</summary>
                <pre className="bp-cmd">{update.notes}</pre>
              </details>
            )}
          </div>
          <div className="bp-engine-actions">
            <button
              className="bp-btn ghost"
              disabled={busy === "update"}
              onClick={() => void checkUpdates()}
            >
              <RefreshCw size={14} />{" "}
              {busy === "update" ? t("bypass.checking") : t("bypass.checkUpdates")}
            </button>
            <button
              className="bp-btn accent"
              disabled={installWorking}
              onClick={() =>
                void doInstall(update?.hasUpdate ? update.latest || undefined : undefined)
              }
            >
              <CloudDownload size={14} />
              {installWorking
                ? t("bypass.installing")
                : !engine?.found
                  ? t("bypass.download")
                  : update?.hasUpdate
                    ? t("bypass.updateTo", { tag: update.latest || "" })
                    : t("bypass.reinstall")}
            </button>
          </div>
        </div>
        {installWorking && (
          <div className="bp-progress">
            <div className="bp-progress-head">
              <span>{installState?.phase ? t("bypass.phase." + installState.phase) : ""}</span>
              <span>{Math.round(installState?.progress || 0)}%</span>
            </div>
            <div className="bp-progress-track">
              <div
                className="bp-progress-fill"
                style={{ width: `${installState?.progress || 0}%` }}
              />
            </div>
          </div>
        )}
        {installState?.state === "done" && (
          <div className="bp-row">
            <span className="bp-chip on">
              {t("bypass.installDone", { tag: installState.installed || installState.tag || "" })}
            </span>
            <span className="bp-dim">{t("bypass.keptLists")}</span>
          </div>
        )}
        {installState?.state === "error" && (
          <div className="bp-error">
            {t("bypass.installError")}: {installState.error}
          </div>
        )}
      </section>

      <div className="bp-grid">
        {/* Конфиги: плитки general*.bat + огоньки последней проверки */}
        <section className="bp-card">
          <h3>
            <Shield size={15} /> {t("bypass.strategies")}
            <span className="bp-count bp-dim">
              {greenCount}/{strategies.length}
            </span>
          </h3>
          <div className="bp-legend">
            <span className="bp-light ok" /> {t("bypass.legendOk")}
            <span className="bp-light err" /> {t("bypass.legendErr")}
            <span className="bp-light idle" /> {t("bypass.legendIdle")}
          </div>
          {check?.best && (
            <div className="bp-best">
              <Star size={13} />
              <span>{t("bypass.bestConfig", { best: check.best })}</span>
              {bestId && (
                <button
                  className="bp-btn tiny success"
                  disabled={busy === "start" || !engine?.found}
                  onClick={() => void doStart(bestId)}
                >
                  <Play size={12} /> {t("bypass.startBest")}
                </button>
              )}
            </div>
          )}
          {strategies.length === 0 && <div className="bp-dim">{t("bypass.noStrategies")}</div>}
          <div className="bp-tiles">
            {strategies.map((s) => {
              const light = lights[s.id];
              const state = lightState(light);
              return (
                <button
                  key={s.id}
                  className={`bp-tile ${selected === s.id ? "sel" : ""} light-${state} ${status?.strategy === s.id ? "running" : ""}`}
                  onClick={() => setSelected(s.id)}
                  title={tileTitle(s, light, state, t)}
                >
                  <span className={`bp-light ${state}`} />
                  <span className="bp-tile-num">{s.index}</span>
                  <span className="bp-tile-label">
                    {s.label === "default" ? t("bypass.group.base") : s.label}
                  </span>
                  <span className="bp-tile-name bp-dim">{s.id}</span>
                  {s.id === bestId ? (
                    <span className="bp-chip on">{t("bypass.bestChip")}</span>
                  ) : (
                    status?.strategy === s.id && (
                      <span className="bp-chip on">{t("bypass.currentChip")}</span>
                    )
                  )}
                </button>
              );
            })}
          </div>
          <div className="bp-row spread">
            <span className="bp-dim">{current ? current.file : t("bypass.selectHint")}</span>
            <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
              <button
                className="bp-btn tiny ghost"
                disabled={checkRunning || !engine?.found || !!status?.service?.installed}
                title={t("bypass.checkOneHint")}
                onClick={() => void doCheckOne(selected)}
              >
                <Terminal size={12} /> {t("bypass.checkOne")}
              </button>
              {!status?.service?.installed ? (
                <button
                  className="bp-btn tiny ghost"
                  disabled={busy === "service" || !engine?.found}
                  title={t("bypass.serviceInstallHint")}
                  onClick={() => void doInstallService(selected)}
                >
                  <Shield size={12} /> {t("bypass.serviceInstall")}
                </button>
              ) : (
                <button
                  className="bp-btn tiny ghost"
                  disabled={busy === "service"}
                  onClick={() => void doRemoveService()}
                >
                  {t("bypass.serviceRemove")}
                </button>
              )}
              <button
                className="bp-btn tiny success"
                disabled={busy === "start" || !engine?.found}
                onClick={() => void doStart(selected)}
              >
                <Play size={12} /> {t("bypass.start")}
              </button>
            </div>
          </div>
        </section>

        {/* Проверка конфигов: vendor-скрипт в быстром режиме + консоль */}
        <section className="bp-card">
          <h3>
            <Terminal size={15} /> {t("bypass.checkTitle")}
            {check && (
              <span className="bp-count bp-dim">
                {progressDone}/{progressTotal}
              </span>
            )}
          </h3>
          <div className="bp-row">
            <button
              className="bp-btn success"
              disabled={checkRunning || !engine?.found || !!status?.service?.installed}
              title={status?.service?.installed ? t("bypass.checkServiceBlocked") : undefined}
              onClick={() => void doRunCheck()}
            >
              <Terminal size={14} />{" "}
              {checkRunning ? t("bypass.checking") : t("bypass.runConfigCheck")}
            </button>
            {checkRunning && (
              <button className="bp-btn danger" onClick={() => void doStopCheck()}>
                <Square size={13} /> {t("bypass.stopCheck")}
              </button>
            )}
            <button
              className="bp-btn tiny ghost"
              disabled={checkRunning || !engine?.found}
              title={t("bypass.fixUserLists")}
              onClick={() => void doFixLists()}
            >
              <FolderEdit size={12} /> {t("bypass.fixUserLists")}
            </button>
          </div>
          <div className="bp-dim">{t("bypass.checkHint")}</div>
          <div className="bp-console">
            <div className="bp-console-head">
              <Terminal size={13} />
              <span>{t("bypass.console")}</span>
              <span className="bp-dim bp-console-state">
                {!check || check.state === "idle"
                  ? t("bypass.consoleIdle")
                  : checkRunning
                    ? t("bypass.checkRunningChip")
                    : check.error === "stopped_by_user"
                      ? t("bypass.consoleStopped")
                      : check.state === "error"
                        ? t("bypass.consoleError")
                        : t("bypass.consoleDone")}
                {check?.finishedAt ? ` · ${new Date(check.finishedAt).toLocaleTimeString()}` : ""}
                {checkRunning && check?.progress.current ? ` · ${check.progress.current}` : ""}
              </span>
            </div>
            <pre className="bp-console-body" ref={consoleRef}>
              {(check?.log || []).map((line, i) => (
                <span key={i} className={`bp-console-line ${consoleLineClass(line)}`}>
                  {line}
                </span>
              ))}
            </pre>
            <div className="bp-dim">{t("bypass.consoleHint")}</div>
          </div>
        </section>
      </div>
    </div>
  );
}

/** Огонёк плитки: зелёный — конфиг работает (в т.ч. лучший по итогам проверки), красный — нет. */
function lightState(light: ZapretCheckLight | undefined): "ok" | "err" | "idle" {
  if (!light) return "idle";
  return Number(light.ok) === 1 ? "ok" : "err";
}

/** Подсказка на плитке: разбор результатов последней проверки. */
function tileTitle(
  s: ZapretStrategy,
  light: ZapretCheckLight | undefined,
  state: "ok" | "err" | "idle",
  t: (key: string, params?: Record<string, unknown>) => string,
): string {
  const head = `${s.name}\n${s.file}`;
  if (!light) return `${head}\n${t("bypass.light.idle")}`;
  const when = (light.checked_at || "").slice(0, 16).replace("T", " ");
  return `${head}\n${t("bypass.light." + state)} · OK ${light.ok_count} / ERR ${light.error} / UNSUP ${light.unsup} · ${when}`;
}

/** Подсветка строки консоли по маркерам vendor-скрипта. */
function consoleLineClass(line: string): string {
  if (/^\[PA\]/.test(line)) return "meta";
  if (/\[\d+\/\d+\]/.test(line)) return "cfg";
  if (/^=+/.test(line)) return "head";
  if (/Best (config|strategy)/i.test(line)) return "ok";
  if (/failed to start|\[missing\]|SSL:ERROR|HTTP:ERROR|curl:|ERROR:/i.test(line)) return "err";
  if (/UNSUP|Timeout|\[WARN\]|\[MISSING\]/i.test(line)) return "warn";
  if (/HTTP:OK|:OK\b|\[OK\]|exit 0|Results saved/i.test(line)) return "ok";
  return "";
}
