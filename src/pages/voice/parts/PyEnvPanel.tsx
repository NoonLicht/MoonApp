import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  Check,
  ChevronDown,
  ChevronUp,
  Cpu,
  Download,
  Eraser,
  RefreshCw,
  Search,
  Terminal,
  Trash2,
  X,
  Zap,
} from "lucide-react";
import { Badge, Btn, Glass, ProgressBar, Select } from "@/components/ui";
import { useI18n } from "@/app/i18n";
import type { TranslateFn } from "@/app/i18n";
import { api } from "@/api/client";
import type { PyInstallSnapshot, PyInstallState, PyInterpreter, TtsPythonEnv } from "@/api/client";

/**
 * Панель Python-окружения студии озвучки.
 *
 * Что решает: F5-TTS и Coqui XTTS v2 — это python-пакеты (torch, torchaudio,
 * f5_tts/TTS), которые живут в отдельном интерпретаторе. Раньше приложение лишь
 * показывало, чего не хватает, и предлагало выполнить `pip install ...` руками в
 * консоли. Теперь всё ставится отсюда — как сборки whisper на странице лекций:
 * пользователь выбирает сборку torch (CUDA 12.8 — cu128, либо CPU) и нажимает
 * «Установить», прогресс и вывод pip видны на месте.
 *
 * Интерпретатор тоже не нужно вводить вручную: кнопка «Найти» перебирает `py -0p`,
 * PATH и стандартные каталоги, показывает версию и наличие модулей в каждом, а
 * выбранный сохраняется в настройках (voice.pythonCmd) — см. server/ts/pyEnv.ts.
 *
 * Ещё три вещи, без которых панель была бы «одноразовой»:
 *   • «Скачать Python 3.11» — классический Coqui TTS (пакет `TTS`) не ставится на
 *     Python 3.12+ вообще, а на 3.11 работают оба движка; ставится портативный
 *     Python внутрь storage (ни установщика, ни реестра, ни UAC);
 *   • «Удалить сборку torch» — `pip uninstall`, то есть те же ~2.5 ГБ, что качает
 *     установка (без этого «переставить начисто» можно было только через консоль);
 *   • «Очистить лог» — вывод pip после ошибки остаётся на экране намеренно (там
 *     причина), значит должен быть способ его убрать.
 */

/** Сборка torch, которую ставим (см. server/ts/pyEnv.ts → PyDevice). */
type PyDeviceId = "cuda" | "cpu";

/**
 * Варианты сборки в порядке показа. Иконка и суффикс ключа i18n
 * (ab.py.deviceCuda / deviceCpu и такие же …Hint).
 */
const DEVICES: Array<{ id: PyDeviceId; icon: React.ElementType; key: string }> = [
  { id: "cuda", icon: Zap, key: "Cuda" },
  { id: "cpu", icon: Cpu, key: "Cpu" },
];

/** МБ → «1.5 ГБ» / «200 МБ»: объём загрузки torch легко перепутать. */
function humanMb(mb: number): string {
  if (!mb) return "—";
  return mb >= 1024 ? `${(mb / 1024).toFixed(mb >= 10240 ? 0 : 1)} GB` : `${mb} MB`;
}

/** Устройство из ответа сервера → известный вариант (см. deviceOf в pyEnv.ts). */
function devOf(value: unknown): PyDeviceId {
  return value === "cpu" ? "cpu" : "cuda";
}

/** Ошибки установки/поиска → понятный текст (неизвестный код показываем как есть). */
function errText(t: TranslateFn, raw: string): string {
  if (!raw) return "";
  if (raw === "busy") return t("ab.py.errBusy");
  if (raw === "cancelled") return t("ab.py.errCancelled");
  if (raw === "empty_python") return t("ab.py.errEmptyPython");
  if (raw === "getpip_failed") return t("ab.py.errGetPip");
  if (raw.startsWith("unzip_failed")) return t("ab.py.errUnzip");
  if (raw.startsWith("python_remove_failed")) return t("ab.py.errPythonRemove");
  if (raw.startsWith("pip_failed"))
    return t("ab.py.errPip", { step: raw.split(":")[1]?.trim() || "" });
  if (raw.startsWith("pip_spawn_failed")) return t("ab.py.errSpawn");
  // downloadToFile отдаёт код вида download_http_403: чаще всего это прокси или
  // отлуп CDN python.org, о чём честнее сказать словами.
  if (raw.startsWith("download_http_"))
    return t("ab.py.errPyDownload", { status: raw.replace("download_http_", "") });
  if (/ENOTFOUND|ETIMEDOUT|fetch failed|timeout|getaddrinfo/i.test(raw))
    return t("ab.py.errNetwork");
  return raw;
}

/**
 * Текст «что готово» зависит от того, что делала задача: установка пакетов,
 * удаление сборки torch или загрузка Python 3.11 (см. PyWork в pyEnv.ts).
 */
function doneText(t: TranslateFn, mode?: string): string {
  if (mode === "uninstall") return t("ab.py.doneRemoveTorch");
  if (mode === "python") return t("ab.py.donePython");
  return t("ab.py.done");
}

/** Модули движка: что на месте, чего нет (бейджи со статусом). */
function moduleBadges(env: TtsPythonEnv | null, engine: "f5" | "xtts") {
  if (!env?.ok) return null;
  const missing = engine === "xtts" ? env.missingXtts || [] : env.missingF5 || [];
  const required =
    engine === "xtts" ? ["torch", "torchaudio", "TTS"] : ["torch", "torchaudio", "f5_tts"];
  return (
    <div className="ab-py-modules">
      {required.map((m) => {
        const ok = !missing.includes(m);
        return (
          <Badge key={m} tone={ok ? "teal" : "coral"} mono>
            {ok ? <Check size={11} /> : <X size={11} />} {m}
          </Badge>
        );
      })}
    </div>
  );
}

export function PyEnvPanel({
  engine,
  env,
  onChanged,
}: {
  engine: "f5" | "xtts";
  env: TtsPythonEnv | null;
  onChanged: () => void;
}) {
  const { t } = useI18n();
  const [info, setInfo] = useState<PyInstallState | null>(null);
  const [device, setDevice] = useState<PyDeviceId>("cuda");
  const [snap, setSnap] = useState<PyInstallSnapshot | null>(null);
  const [busy, setBusy] = useState<"" | "find" | "install" | "python">("");
  const [interpreters, setInterpreters] = useState<PyInterpreter[] | null>(null);
  const [notice, setNotice] = useState<{ tone: string; text: string } | null>(null);
  // Готовое окружение показываем свёрнутым: настроек там уже нет, а место на
  // странице панель занимает. Если чего-то не хватает — раскрыто всегда.
  const [expanded, setExpanded] = useState(false);
  // Устройство пользователь выбирает сам; до этого берём рекомендацию сервера.
  const picked = useRef(false);

  const loadInfo = useCallback(
    async (dev?: PyDeviceId) => {
      try {
        const r = await api.ttsEnvInstallInfo(engine, dev || device);
        setInfo(r);
        setSnap(r.install);
        // Рекомендация сервера — из двух вариантов (см. DEVICES): есть карта
        // NVIDIA → cuda, карты нет → cpu.
        if (!picked.current) setDevice(devOf(r.recommended));
      } catch (e) {
        setNotice({ tone: "coral", text: errText(t, String((e as Error).message || e)) });
      }
    },
    // device в зависимостях не нужен: он передаётся аргументом, иначе загрузка
    // плана зацикливалась бы на каждом переключении устройства.
    [engine, t],
  );

  useEffect(() => {
    void loadInfo();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engine]);

  /**
   * Поллинг прогресса во время установки. Опрашивается /tts/env (дешёвый: без
   * nvidia-smi) — в нём сервер держит снимок задачи установки.
   */
  useEffect(() => {
    if (snap?.state.state !== "working") return;
    const id = window.setInterval(() => {
      api
        .ttsEnv()
        .then((e) => {
          if (e.install) setSnap(e.install);
        })
        .catch(() => {
          /* опрос прогресса не должен ломать интерфейс */
        });
    }, 1200);
    return () => window.clearInterval(id);
  }, [snap?.state.state]);

  // Установка закончилась: обновляем окружение страницы (модули появились) —
  // иначе пользователь продолжал бы видеть «не хватает torch».
  const lastState = useRef<string>("idle");
  useEffect(() => {
    const st = snap?.state.state || "idle";
    const prev = lastState.current;
    lastState.current = st;
    if (prev === "working" && (st === "done" || st === "error")) {
      if (st === "done") setNotice({ tone: "teal", text: doneText(t, snap?.mode) });
      else setNotice({ tone: "coral", text: errText(t, snap?.state.error || "") });
      onChanged();
      void loadInfo();
      setBusy("");
    }
  }, [snap?.state.state, snap?.state.error, snap?.mode, t, onChanged, loadInfo]);

  const startInstall = useCallback(async () => {
    setNotice(null);
    setBusy("install");
    try {
      const s = await api.ttsEnvInstall(engine, device);
      setSnap(s);
    } catch (e) {
      setBusy("");
      setNotice({ tone: "coral", text: errText(t, String((e as Error).message || e)) });
    }
  }, [engine, device, t]);

  /** Удаление сборки torch: освобождает ~2.5 ГБ CUDA-сборки (pip uninstall). */
  const uninstallTorch = useCallback(async () => {
    setNotice(null);
    setBusy("install");
    try {
      const s = await api.ttsEnvUninstall(device);
      setSnap(s);
    } catch (e) {
      setBusy("");
      setNotice({ tone: "coral", text: errText(t, String((e as Error).message || e)) });
    }
  }, [device, t]);

  /** Скачать и распаковать портативный Python 3.11 внутрь storage приложения. */
  const installPortable = useCallback(async () => {
    setNotice(null);
    setBusy("install");
    try {
      const s = await api.ttsEnvInstallPython();
      setSnap(s);
    } catch (e) {
      setBusy("");
      setNotice({ tone: "coral", text: errText(t, String((e as Error).message || e)) });
    }
  }, [t]);

  /** Удалить портативный Python 3.11 (вместе с поставленными в него пакетами). */
  const removePortable = useCallback(async () => {
    setNotice(null);
    setBusy("install");
    try {
      const out = await api.ttsEnvRemovePython();
      setNotice({
        tone: "teal",
        text: t("ab.py.doneRemovePython", { size: humanMb(out.freedMb) }),
      });
      onChanged();
      void loadInfo();
    } catch (e) {
      setNotice({ tone: "coral", text: errText(t, String((e as Error).message || e)) });
    } finally {
      setBusy("");
    }
  }, [t, onChanged, loadInfo]);

  /** Убрать хвост вывода pip (после ошибки он остаётся на экране намеренно). */
  const clearLog = useCallback(async () => {
    try {
      setSnap(await api.ttsEnvClearLog());
      setNotice({ tone: "neutral", text: t("ab.py.logCleared") });
    } catch (e) {
      setNotice({ tone: "coral", text: errText(t, String((e as Error).message || e)) });
    }
  }, [t]);

  const cancelInstall = useCallback(async () => {
    try {
      const s = await api.ttsEnvCancel();
      setSnap(s);
      setNotice({ tone: "neutral", text: t("ab.py.cancelled") });
    } catch (e) {
      setNotice({ tone: "coral", text: errText(t, String((e as Error).message || e)) });
    } finally {
      setBusy("");
    }
  }, [t]);

  const findInterpreters = useCallback(async () => {
    setBusy("find");
    setNotice(null);
    try {
      const r = await api.ttsEnvInterpreters();
      setInterpreters(r.list);
      if (!r.list.length) setNotice({ tone: "amber", text: t("ab.py.pythonEmpty") });
    } catch (e) {
      setNotice({ tone: "coral", text: errText(t, String((e as Error).message || e)) });
    } finally {
      setBusy("");
    }
  }, [t]);

  // Имя намеренно без префикса "use": обработчик выбора интерпретатора иначе
  // выглядит для правил хуков как вызов React-хука внутри колбэка.
  const applyPython = useCallback(
    async (cmd: string) => {
      if (!cmd) return;
      setBusy("python");
      try {
        await api.ttsEnvSetPython(cmd);
        setNotice({ tone: "teal", text: t("ab.py.pythonSaved", { cmd }) });
        onChanged();
        void loadInfo();
      } catch (e) {
        setNotice({ tone: "coral", text: errText(t, String((e as Error).message || e)) });
      } finally {
        setBusy("");
      }
    },
    [t, onChanged, loadInfo],
  );

  const working = snap?.state.state === "working";
  const failed = snap?.state.state === "error";
  const missing = env?.ok ? (engine === "xtts" ? env.missingXtts : env.missingF5) || [] : [];
  const ready = !!env?.ok && missing.length === 0;
  // Портативный Python 3.11 и наличие torch: по ним видно, каким кнопкам быть
  // активными (удалять нечего — кнопка выключена, а не «молча ничего не делает»).
  const portable = info?.portable;
  const torchInstalled = !!env?.modules?.torch;
  // Что делает текущая задача: по этому меняются подписи кнопок и «Готово» (см. doneText).
  const mode = snap?.mode || "install";
  const installLabel = working
    ? mode === "uninstall"
      ? t("ab.py.uninstalling")
      : t("ab.py.installing")
    : t("ab.py.install");
  // Панель раскрыта, когда окружение не готово. Ошибку установки показываем
  // всегда — иначе при свёрнутой панели причина снова «исчезнет».
  const open = expanded || !ready || failed;
  // Хвост вывода pip: при ошибке строк показываем больше — причина («Could not
  // find a version that satisfies the requirement…», «ERROR: …») всегда
  // последняя, но перед ней ещё бывают полезные строки о конфликте версий.
  const logTail = (snap?.log || []).slice(failed ? -24 : -12);
  const pyOptions = (interpreters || [])
    .filter((p) => p.ok)
    .map((p) => {
      const lack = (engine === "xtts" ? p.missingXtts : p.missingF5) || [];
      return {
        value: p.executable || p.cmd,
        label: `${p.label} · Python ${p.python}${lack.length ? ` · −${lack.join(",")}` : ""}`,
      };
    });

  return (
    <Glass className="ab-py">
      <div className="ab-py-head">
        <div className="ab-py-head-text">
          <div className="field-label">
            <Terminal size={13} /> {t("ab.py.title")}
          </div>
        </div>
        {moduleBadges(env, engine)}
        {ready && (
          <Btn
            variant="ghost"
            icon={expanded ? ChevronUp : ChevronDown}
            onClick={() => setExpanded((v) => !v)}
          >
            {expanded ? t("ab.py.hide") : t("ab.py.show")}
          </Btn>
        )}
      </div>

      {/* Состояние окружения: одной строкой и БЕЗ перечисления модулей — какие
          именно модули не стоят, видно по бейджам в шапке панели. Раньше здесь
          был список вида «Не хватает: torch, torchaudio, f5_tts», который
          повторял те же три красных бейджа слово в слово. */}
      <div className={`ab-py-state ${ready ? "is-ok" : "is-warn"}`}>
        {ready ? <Check size={14} /> : <AlertTriangle size={14} />}
        <span>
          {!env?.ok
            ? env?.error === "python_not_found"
              ? t("ab.envNotFound", { cmd: env?.cmd || "python" })
              : t("ab.envProbeFailed", { detail: env?.detail || "" })
            : missing.length
              ? t("ab.py.needModules")
              : t("ab.py.allModules")}
        </span>
      </div>

      {open && (
        <>
          {/* Выбор сборки PyTorch: CUDA 12.8 (cu128) или CPU — как сборки
              whisper в лекциях. */}
          <div className="ab-py-block">
            <div className="ab-py-block-label">{t("ab.py.device")}</div>
            <div className="ab-py-devices">
              {DEVICES.map(({ id, icon: Icon, key }) => (
                <button
                  key={id}
                  type="button"
                  className={`ab-py-dev ${device === id ? "is-active" : ""}`}
                  onClick={() => {
                    picked.current = true;
                    setDevice(id);
                  }}
                >
                  {/* Две строки вместо четырёх: иконка, название сборки и объём
                      загрузки — в первой, подсказка и бейдж «Рекомендуется» — во
                      второй. См. .ab-py-dev-head/.ab-py-dev-sub в pages.css. */}
                  <span className="ab-py-dev-head">
                    <Icon size={15} />
                    <b>{t(`ab.py.device${key}`)}</b>
                    <span className="ab-py-dev-size">
                      {humanMb(info?.plans?.[id]?.approxMb || 0)}
                    </span>
                  </span>
                  <span className="ab-py-dev-sub">
                    <span className="muted-sm">{t(`ab.py.device${key}Hint`)}</span>
                    {info?.recommended === id && (
                      <Badge tone="teal">{t("ab.py.recommended")}</Badge>
                    )}
                  </span>
                </button>
              ))}
            </div>
            <div className="muted-sm">
              {info?.gpuName ? t("ab.py.gpu", { name: info.gpuName }) : t("ab.py.gpuNone")}
            </div>
            {/* Частый вопрос: «это же то же самое, что CUDA-пак в Апскейле/Лектории,
                зачем качать снова?» — нет, это физически разные файлы (см. текст). */}
            {device === "cuda" && (
              <div className="muted-sm" style={{ marginTop: 4 }}>
                {t("ab.py.deviceCudaSeparate")}
              </div>
            )}
          </div>

          {/* Интерпретатор: искать путь к python вручную больше не нужно — модули
          попадают именно в выбранный интерпретатор (voice.pythonCmd). */}
          <div className="ab-py-block">
            <div className="ab-py-block-label">{t("ab.py.python")}</div>
            <div className="ab-py-row">
              <Select
                value=""
                onChange={(e) => void applyPython(e.target.value)}
                options={[
                  { value: "", label: env?.executable || env?.cmd || t("ab.py.pythonPick") },
                  ...pyOptions,
                ]}
                style={{ flex: 1, minWidth: 0 }}
              />
              <Btn
                variant="secondary"
                icon={Search}
                onClick={() => void findInterpreters()}
                disabled={!!busy || working}
              >
                {busy === "find" ? t("ab.py.finding") : t("ab.py.find")}
              </Btn>
            </div>
            <div className="muted-sm">{t("ab.py.pythonHint")}</div>
          </div>

          {/* Прогресс установки: полоска + текущий шаг + хвост вывода pip. */}
          {working && (
            <div className="ab-py-progress">
              <ProgressBar value={snap?.state.progress || 0} />
              <div className="ab-py-progress-foot">
                <span className="muted-sm">
                  {t(`ab.py.phase.${snap?.step || "torch"}`)} · {snap?.state.progress || 0}%
                </span>
                <div className="ab-py-row">
                  <Btn
                    variant="ghost"
                    icon={Eraser}
                    onClick={() => void clearLog()}
                    disabled={!logTail.length}
                  >
                    {t("ab.py.clearLog")}
                  </Btn>
                  <Btn variant="ghost" icon={X} onClick={() => void cancelInstall()}>
                    {t("ab.py.cancel")}
                  </Btn>
                </div>
              </div>
              {!!logTail.length && <pre className="ab-py-log">{logTail.join("\n")}</pre>}
            </div>
          )}

          {/* Ошибка установки: хвост вывода pip остаётся на экране. Раньше лог
              рисовался только пока задача шла, поэтому «подробности в выводе
              ниже» смотреть было негде — блок исчезал вместе с полоской.
              Кнопка «Очистить лог» убирает его, когда причина уже прочитана. */}
          {!working && failed && !!logTail.length && (
            <div className="ab-py-progress is-error">
              <div className="ab-py-progress-foot">
                <span className="muted-sm">
                  {t(`ab.py.phase.${snap?.step || "torch"}`)} · {snap?.step || "torch"}
                </span>
                <Btn variant="ghost" icon={Eraser} onClick={() => void clearLog()}>
                  {t("ab.py.clearLog")}
                </Btn>
              </div>
              <pre className="ab-py-log">{logTail.join("\n")}</pre>
            </div>
          )}

          <div className="ab-py-actions">
            <Btn
              variant="primary"
              icon={Download}
              onClick={() => void startInstall()}
              disabled={!!busy || working || ready}
            >
              {installLabel}
            </Btn>
            <Btn
              variant="ghost"
              icon={RefreshCw}
              onClick={() => void loadInfo()}
              disabled={!!busy || working}
            >
              {t("ab.py.refresh")}
            </Btn>
            {/* Удаление сборки torch: те самые гигабайты, что качает установка.
                Раньше «переставить начисто» можно было только руками в консоли. */}
            <Btn
              variant="ghost"
              icon={Trash2}
              onClick={() => void uninstallTorch()}
              disabled={!!busy || working || !torchInstalled}
            >
              {working && mode === "uninstall" ? t("ab.py.uninstalling") : t("ab.py.removeTorch")}
            </Btn>
            {!!notice && <span className={`ab-py-notice tone-${notice.tone}`}>{notice.text}</span>}
          </div>

          {/* Python 3.11 — отдельный ряд: это про версию интерпретатора, а не про
              сборку torch. Классический Coqui TTS (пакет `TTS`) не ставится на
              Python 3.12+, поэтому у него своя кнопка и своя подсказка. */}
          <div className="ab-py-actions">
            {portable?.installed ? (
              <>
                <Btn
                  variant="ghost"
                  icon={Trash2}
                  onClick={() => void removePortable()}
                  disabled={!!busy || working}
                >
                  {t("ab.py.removePython", { size: humanMb(portable.sizeMb) })}
                </Btn>
                <span className="muted-sm">
                  {t("ab.py.pythonReady", { version: portable.version || "3.11" })}
                </span>
              </>
            ) : (
              <>
                <Btn
                  variant="secondary"
                  icon={Download}
                  onClick={() => void installPortable()}
                  disabled={!!busy || working}
                >
                  {working && mode === "python"
                    ? t("ab.py.downloadingPython")
                    : t("ab.py.getPython", { size: humanMb(portable?.zipMb || 0) })}
                </Btn>
                <span className="muted-sm">{t("ab.py.getPythonHint")}</span>
              </>
            )}
          </div>

          {/* Ручной путь остаётся для тех, кто предпочитает консоль, и как справка
          «что именно делает кнопка». */}
          {!!info?.plans?.[device]?.command && (
            <details className="ab-py-manual">
              <summary className="muted-sm">{t("ab.py.manual")}</summary>
              <pre>{info.plans[device].command}</pre>
            </details>
          )}
        </>
      )}
    </Glass>
  );
}
