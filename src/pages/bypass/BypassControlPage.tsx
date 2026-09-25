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
  Send,
  Copy,
  Network,
  Route,
  ScanLine,
  Globe,
  Wifi,
  Gauge,
} from "lucide-react";
import { Glass, Btn, Badge, SectionHead } from "@/components/ui";
import { api } from "@/api/client";
import type {
  TgwsStatus,
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

  // --- TG WS Proxy: локальный MTProto-прокси для Telegram Desktop ---
  // Блок самодостаточный: скачать движок → запустить → показать ссылку
  // tg://proxy для Telegram → остановить. Состояние целиком берём из /tgws.
  const [tgws, setTgws] = useState<TgwsStatus | null>(null);
  const [tgwsBusy, setTgwsBusy] = useState("");
  const [tgwsError, setTgwsError] = useState("");
  const [tgwsMsg, setTgwsMsg] = useState("");
  // Черновики полей: уходят на сервер при запуске или явном сохранении.
  const [tgwsPort, setTgwsPort] = useState(1443);
  const [tgwsAuto, setTgwsAuto] = useState(false);
  // Старт PyInstaller-бинаря занимает секунды — держим индикатор ожидания.
  const [tgwsStarting, setTgwsStarting] = useState(false);

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

  /* --------------------- TG WS Proxy: обработчики --------------------- */

  /**
   * Код ошибки блока → фраза локали.
   * Ошибки приходят кодами (tgws_port_busy и т.п.): перевод живёт в UI, а не в
   * серверных логах, иначе сервер пришлось бы учить шести языкам.
   */
  const tgwsErrorText = useCallback(
    (e: unknown): string => {
      const raw = String((e as Error)?.message || e);
      if (/tgws_not_installed/.test(raw)) return t("bypass.tgws.errNotInstalled");
      if (/tgws_port_busy/.test(raw)) return t("bypass.tgws.errPortBusy");
      if (/tgws_not_listening|tgws_exited|tgws_spawn_failed/.test(raw))
        return t("bypass.tgws.errNotListening");
      if (/tgws_bad_secret/.test(raw)) return t("bypass.tgws.errSecret");
      if (/tgws_bad_port/.test(raw)) return t("bypass.tgws.errPort");
      if (/tgws_download_busy/.test(raw)) return t("bypass.tgws.errBusy");
      if (/hash_mismatch|github_http|download_http/.test(raw))
        return t("bypass.tgws.errDownload");
      return raw;
    },
    [t],
  );

  const loadTgws = useCallback(async () => {
    try {
      const st = await api.tgwsStatus();
      setTgws(st);
      setTgwsPort(st.port);
      setTgwsAuto(st.autoStart);
    } catch (e) {
      setTgwsError(String((e as Error)?.message || e));
    }
  }, []);

  /** Обёртка операции блока: busy-метка, разбор ошибки, снятие «запускается». */
  const doTgws = useCallback(
    async (kind: string, fn: () => Promise<TgwsStatus>) => {
      setTgwsBusy(kind);
      setTgwsError("");
      setTgwsMsg("");
      try {
        setTgws(await fn());
      } catch (e) {
        setTgwsError(tgwsErrorText(e));
      } finally {
        setTgwsBusy("");
        setTgwsStarting(false);
      }
    },
    [tgwsErrorText],
  );

  // Запуск ждёт готовности порта (секунды на распаковку бинаря), поэтому
  // индикатор включаем ДО запроса, а не по его приходу.
  const startTgws = useCallback(() => {
    setTgwsStarting(true);
    void doTgws("start", () => api.tgwsStart({ port: tgwsPort, autoStart: tgwsAuto }));
  }, [doTgws, tgwsAuto, tgwsPort]);

  const copyTgwsLink = useCallback(async () => {
    if (!tgws?.link) return;
    try {
      await navigator.clipboard.writeText(tgws.link);
      setTgwsMsg(t("bypass.tgws.copied"));
      setTimeout(() => setTgwsMsg(""), 2500);
    } catch {
      // Буфер обмена может быть закрыт — показываем ссылку текстом.
      setTgwsError(tgws.link);
    }
  }, [t, tgws?.link]);

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

  // TG WS Proxy: начальная загрузка блока — состояние движка и черновики полей.
  useEffect(() => {
    void loadTgws();
  }, [loadTgws]);

  /* Пока прокси работает, обновляем аптайм и хвост лога: порт и секрет не
     меняются, поэтому опрос редкий (5 с) и дешёвый — чтение файлов на сервере. */
  useEffect(() => {
    if (!tgws?.running || !isActive) return;
    const timer = setInterval(() => void loadTgws(), 5000);
    return () => clearInterval(timer);
  }, [tgws?.running, isActive, loadTgws]);

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

      {/* TG WS Proxy — локальный MTProto-прокси для Telegram Desktop
          (Flowseal/tg-ws-proxy). Отдельная карточка: у неё свой движок, свой
          порт и свой секрет. Порядок для пользователя ровно такой: скачать →
          запустить → скопировать ссылку tg://proxy в Telegram → остановить. */}
      <section className="bp-card bp-tgws-card">
        <h3>
          <Send size={15} /> {t("bypass.tgws.title")}
        </h3>

        <div className="bp-engine-line">
          <span className={`bp-chip ${tgws?.running ? "on" : "off"}`}>
            {tgwsStarting || tgws?.starting
              ? t("bypass.tgws.stateStarting")
              : tgws?.running
                ? t("bypass.tgws.stateRunning", { port: tgws?.port ?? 0 })
                : t("bypass.tgws.stateStopped")}
          </span>
          <span className="bp-sep">·</span>
          <span className="bp-dim">
            {tgws?.installed
              ? t("bypass.tgws.installed", { version: tgws?.version || "—" })
              : t("bypass.tgws.notInstalled")}
          </span>
          {!!tgws?.running && (
            <span className="bp-dim">
              {t("bypass.tgws.uptime", { min: Math.floor((tgws.uptimeMs || 0) / 60000) })}
            </span>
          )}
        </div>

        <div className="bp-actions">
          {!tgws?.installed ? (
            <button
              className="bp-btn"
              disabled={!!tgwsBusy || tgws?.downloading}
              onClick={() => void doTgws("install", () => api.tgwsInstall(true))}
            >
              <CloudDownload size={16} />{" "}
              {tgws?.downloading
                ? t("bypass.tgws.downloading", { percent: tgws.progress })
                : t("bypass.tgws.download")}
            </button>
          ) : tgws?.running ? (
            <button
              className="bp-btn danger"
              disabled={!!tgwsBusy}
              onClick={() => void doTgws("stop", () => api.tgwsStop())}
            >
              <Square size={16} /> {t("bypass.tgws.stop")}
            </button>
          ) : (
            <button className="bp-btn primary" disabled={!!tgwsBusy} onClick={startTgws}>
              <Play size={16} /> {t("bypass.tgws.start")}
            </button>
          )}
          <button
            className="bp-btn ghost"
            onClick={() => void loadTgws()}
            title={t("bypass.tgws.refresh")}
          >
            <RefreshCw size={14} />
          </button>
        </div>

        <div className="bp-tgws-fields">
          <label className="bp-field">
            <span>{t("bypass.tgws.port")}</span>
            <input
              type="number"
              min={1024}
              max={65535}
              value={tgwsPort}
              // На ходу порт менять нельзя: Telegram подключается по нему, и
              // смена значения молча оборвала бы связь.
              disabled={!!tgws?.running || tgwsStarting}
              onChange={(e) => setTgwsPort(Number(e.target.value))}
              title={t("bypass.tgws.portHint")}
            />
          </label>
          <label className="bp-check" title={t("bypass.tgws.autoStartHint")}>
            <input
              type="checkbox"
              checked={tgwsAuto}
              disabled={!!tgws?.running || tgwsStarting}
              onChange={(e) => {
                setTgwsAuto(e.target.checked);
                void api
                  .tgwsSaveSettings({ autoStart: e.target.checked })
                  .then(setTgws)
                  .catch((err) => setTgwsError(tgwsErrorText(err)));
              }}
            />
            {t("bypass.tgws.autoStart")}
          </label>
        </div>

        {/* Секрет и ссылка. Секрет одинаковый на сервере и в Telegram, поэтому
            показываем и копируем его целиком: это локальный прокси, чужих
            секретов здесь нет, а без него подключение в Telegram не настроить. */}
        {!!tgws?.secret && (
          <div className="bp-tgws-link">
            <span className="bp-dim">{t("bypass.tgws.secret")}</span>
            <code>{tgws.secret}</code>
            <button
              className="bp-btn tiny"
              onClick={() => void copyTgwsLink()}
              title={t("bypass.tgws.copyLinkHint")}
            >
              <Copy size={12} /> {t("bypass.tgws.copyLink")}
            </button>
            <button
              className="bp-btn tiny ghost"
              disabled={!!tgws?.running}
              title={t("bypass.tgws.newSecretHint")}
              onClick={() => void doTgws("secret", () => api.tgwsRotateSecret())}
            >
              <RefreshCw size={12} /> {t("bypass.tgws.newSecret")}
            </button>
          </div>
        )}

        {!!tgws?.link && <div className="bp-tgws-uri">{tgws.link}</div>}

        {!!tgwsMsg && <div className="bp-ok">{tgwsMsg}</div>}
        {!!tgwsError && <div className="bp-error">{tgwsError}</div>}
        {!!tgws?.portBusy && !tgws?.running && (
          <div className="bp-warn">{t("bypass.tgws.errPortBusy")}</div>
        )}

        <div className="bp-note">
          <Terminal size={14} />{" "}
          <span>
            {tgws?.installed ? t("bypass.tgws.hintReady") : t("bypass.tgws.hintInstall")}
          </span>
        </div>
        <div className="bp-note bp-dim">{t("bypass.tgws.setupSteps")}</div>

        <details className="bp-notes">
          <summary>{t("bypass.tgws.log")}</summary>
          <pre className="bp-console-body">
            {(tgws?.log || []).slice(-60).join("\n") || t("bypass.tgws.logEmpty")}
          </pre>
        </details>
      </section>

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

      <NetworkToolsPanel />
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

/**
 * Сетевые утилиты: ping/traceroute/сканер портов/публичный IP/Wi-Fi-мониторинг
 * (server/ts/netTools.ts). Kill-switch сознательно не реализован — см. финальный
 * отчёт: правка системного firewall без возможности живого теста слишком рискованна.
 */
function NetworkToolsPanel() {
  const { t } = useI18n();
  const [tab, setTab] = useState<"ping" | "trace" | "scan" | "ip" | "wifi" | "speed">("ping");
  const [host, setHost] = useState("");
  const [busy, setBusy] = useState(false);
  const [output, setOutput] = useState("");
  const [portFrom, setPortFrom] = useState("1");
  const [portTo, setPortTo] = useState("1024");
  const [scanResults, setScanResults] = useState<{ port: number; open: boolean }[] | null>(null);
  const [publicIp, setPublicIp] = useState<string | null>(null);
  const [speedResult, setSpeedResult] = useState<{ mbps: number; bytes: number; ms: number } | null>(null);
  const [error, setError] = useState("");

  const run = async () => {
    setError("");
    setOutput("");
    setScanResults(null);
    setSpeedResult(null);
    setBusy(true);
    try {
      if (tab === "speed") {
        const r = await api.netSpeedTest();
        if (!r.ok || r.mbps === undefined) {
          setError(r.error || "speedtest_failed");
        } else {
          setSpeedResult({ mbps: r.mbps, bytes: r.bytes || 0, ms: r.ms || 0 });
        }
      } else if (tab === "ping") {
        const r = await api.netPing(host);
        setOutput(r.output);
      } else if (tab === "trace") {
        const r = await api.netTraceroute(host);
        setOutput(r.output);
      } else if (tab === "scan") {
        const r = await api.netPortScan(host, Number(portFrom), Number(portTo));
        setScanResults(r.results.filter((x) => x.open));
      } else if (tab === "ip") {
        const r = await api.netPublicIp();
        setPublicIp(r.ip);
      } else if (tab === "wifi") {
        const [nets, cur] = await Promise.all([api.netWifiNetworks(), api.netWifiCurrent()]);
        setOutput(`${cur.output}\n\n${"=".repeat(40)}\n\n${nets.output}`);
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const needsHost = tab === "ping" || tab === "trace" || tab === "scan";

  return (
    <div style={{ marginTop: 16 }}>
      <SectionHead eyebrow={t("bypass.netEyebrow")} title={t("bypass.netTitle")} />
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", margin: "8px 0" }}>
        {(
          [
            ["ping", Network],
            ["trace", Route],
            ["scan", ScanLine],
            ["ip", Globe],
            ["wifi", Wifi],
            ["speed", Gauge],
          ] as const
        ).map(([id, Icon]) => (
          <Badge key={id} tone={tab === id ? "amber" : "neutral"} onClick={() => setTab(id)}>
            <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
              <Icon size={12} />
              {t(`bypass.netTab_${id}`)}
            </span>
          </Badge>
        ))}
      </div>

      <Glass style={{ flexDirection: "column", alignItems: "stretch", gap: 8, padding: 12 }}>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {needsHost && (
            <input
              className="text-input"
              style={{ width: 220 }}
              placeholder={t("bypass.netHostPlaceholder")}
              value={host}
              onChange={(e) => setHost(e.target.value)}
            />
          )}
          {tab === "scan" && (
            <>
              <input
                className="text-input"
                style={{ width: 80 }}
                value={portFrom}
                onChange={(e) => setPortFrom(e.target.value)}
              />
              <span className="muted-sm" style={{ alignSelf: "center" }}>
                –
              </span>
              <input
                className="text-input"
                style={{ width: 80 }}
                value={portTo}
                onChange={(e) => setPortTo(e.target.value)}
              />
            </>
          )}
          <Btn
            variant="primary"
            icon={busy ? RefreshCw : Network}
            disabled={busy || (needsHost && !host.trim())}
            onClick={() => void run()}
          >
            {busy ? t("bypass.netRunning") : t("bypass.netRun")}
          </Btn>
        </div>

        {error && <div style={{ color: "var(--coral)" }}>{error}</div>}

        {publicIp && tab === "ip" && (
          <div style={{ fontFamily: "var(--font-mono)", fontSize: 16 }}>{publicIp}</div>
        )}

        {speedResult && tab === "speed" && (
          <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
            <span style={{ fontFamily: "var(--font-mono)", fontSize: 24, fontWeight: 700 }}>
              {speedResult.mbps}
            </span>
            <span className="muted-sm">
              Mbps · {(speedResult.bytes / 1_000_000).toFixed(1)} MB / {(speedResult.ms / 1000).toFixed(1)} s
            </span>
          </div>
        )}

        {scanResults && tab === "scan" && (
          <div>
            {scanResults.length === 0 ? (
              <div className="muted-sm">{t("bypass.netNoOpenPorts")}</div>
            ) : (
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                {scanResults.map((r) => (
                  <Badge key={r.port} tone="teal" mono>
                    {r.port}
                  </Badge>
                ))}
              </div>
            )}
          </div>
        )}

        {output && (
          <pre
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: 12,
              whiteSpace: "pre-wrap",
              maxHeight: 320,
              overflow: "auto",
              margin: 0,
            }}
          >
            {output}
          </pre>
        )}
      </Glass>
      <div className="muted-sm" style={{ marginTop: 6 }}>
        {t("bypass.netKillSwitchHint")}
      </div>
    </div>
  );
}
