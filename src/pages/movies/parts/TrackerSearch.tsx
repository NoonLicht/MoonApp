import { useCallback, useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  ClipboardPaste,
  Cookie,
  Copy,
  Download,
  Globe,
  KeyRound,
  Link2,
  LogOut,
  RefreshCw,
  Search,
  ShieldCheck,
  Users,
} from "lucide-react";
import { Btn, Field, EmptyHint, Select } from "@/components/ui";
import { useContextMenu, copyToClipboard } from "@/components/ContextMenu";
import { useI18n } from "@/app/i18n";
import { api } from "@/api/client";
import type {
  BrowserProbe,
  TrackerErrorDetails,
  TrackerRelease,
  TrackerSearchResult,
  TrackerStatus,
  TorrentAddResult,
} from "@/api/types";
import { releaseMetaLine } from "@/pages/movies/lib/streamUrl";

/**
 * Поиск раздач на форуме-трекере (rutracker.org и phpBB-совместимые).
 *
 * Что здесь важно:
 *  - логин и пароль НЕ хранятся в компоненте: если их нет, показываем форму,
 *    которая отправляет их один раз на бэкенд (там они уходят в зашифрованные
 *    секреты, см. server/ts/trackerScraper.ts);
 *  - сессию форума (куки bb_data/sid) держит бэкенд — браузер их не видит;
 *  - выбранная раздача открывается в ЭТОМ же плеере (onOpenRelease): бэкенд
 *    скачивает .torrent своими куками и возвращает список файлов.
 */
/**
 * Ошибка API → состояние для UI: код + диагностика, которую прислал бэкенд
 * (статус ответа форума, размер, начало текста — по ней видно причину).
 */
function toError(e: unknown): {
  code: string;
  message: string;
  details: TrackerErrorDetails | null;
} {
  const err = e as { code?: string; message?: string; details?: TrackerErrorDetails | null };
  return { code: err?.code || "", message: err?.message || "", details: err?.details || null };
}

interface TrackerSearchProps {
  /** Раздача открыта: плеер получает готовый разбор торрента. */
  onOpenRelease: (res: TorrentAddResult & { noMedia: boolean }) => void;
  /**
   * Название открытого фильма/сериала: вкладка сразу ищет по нему, чтобы список
   * раздач был на месте без ручного ввода (как только есть авторизация).
   */
  initialQuery?: string | null;
  /**
   * Название фильма для реестра загрузок: уходит вместе с раздачей, чтобы плеер
   * восстановил окно при повторном открытии этого фильма (и при клике по нему).
   */
  movieTitle?: string;
}

export default function TrackerSearch({
  onOpenRelease,
  initialQuery,
  movieTitle,
}: TrackerSearchProps) {
  const { t } = useI18n();
  const menu = useContextMenu();
  const [status, setStatus] = useState<(TrackerStatus & { ffmpeg?: boolean }) | null>(null);
  const [query, setQuery] = useState(String(initialQuery || "").trim());
  const [busy, setBusy] = useState(false);
  const [opening, setOpening] = useState<string | null>(null);
  const [error, setError] = useState<{
    code: string;
    message: string;
    details?: TrackerErrorDetails | null;
  } | null>(null);
  const [result, setResult] = useState<TrackerSearchResult | null>(null);
  const [login, setLogin] = useState("");
  const [password, setPassword] = useState("");
  const [saving, setSaving] = useState(false);
  /**
   * Показывать ли блок ручной вставки куки.
   *  - null — «как получится»: если окно входа недоступно (интерфейс открыт в
   *    браузере), блок показываем сразу, потому что это единственный рабочий путь;
   *  - true/false — выбор пользователя (кнопка «Вставить вручную»).
   */
  const [showCookies, setShowCookies] = useState<boolean | null>(null);
  const [cookieInput, setCookieInput] = useState("");
  const [cookieSaved, setCookieSaved] = useState<string[] | null>(null);
  /** Сообщение после входа в окне/проверки сессии («вход выполнен», «Cloudflare»). */
  const [probeNotice, setProbeNotice] = useState("");
  /** Что нашли в браузерах при автоподхвате куки (для объяснения в UI). */
  const [probes, setProbes] = useState<BrowserProbe[]>([]);
  // Автопоиск выполняется один раз за открытие вкладки (и не повторяется при
  // перерисовках/строгом режиме).
  const autoRan = useRef(false);

  /** Понятный текст по коду ошибки бэкенда (коды — из server/routes/movies.js). */
  const errText = useCallback(
    (code: string, message: string): string => {
      const map: Record<string, string> = {
        tracker_disabled: t("movies.trackerDisabled"),
        no_credentials: t("movies.trackerNoCreds"),
        login_failed: t("movies.trackerLoginFailed"),
        captcha_required: t("movies.trackerCaptcha"),
        session_expired: t("movies.trackerSession"),
        parse_failed: t("movies.trackerParse"),
        network_error: t("movies.trackerNetwork"),
        bad_query: t("movies.trackerBadQuery"),
        bad_release: t("movies.trackerBadRelease"),
        torrent_download_failed: t("movies.trackerNoTorrentFile"),
        cf_challenge: t("movies.trackerCf"),
      };
      return map[code] || message || t("movies.errGeneric");
    },
    [t],
  );

  /** Обновить статус (после сохранения ключей или входа). */
  const refreshStatus = useCallback(async () => {
    try {
      setStatus(await api.moviesTrackerStatus());
    } catch {
      /* статус не критичен: поиск всё равно покажет свою ошибку */
    }
  }, []);

  // Первичная загрузка статуса. setState делаем только после await и под флагом
  // «жив»: синхронный setState в теле эффекта вызывает каскадный ререндер
  // (правило react-hooks/set-state-in-effect).
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const st = await api.moviesTrackerStatus();
        if (alive) setStatus(st);
      } catch {
        /* статус не критичен */
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  /** Поиск (Enter или кнопка). refresh=true — обход кэша на бэкенде. */
  const search = useCallback(
    async (refresh = false) => {
      const q = query.trim();
      if (!q) return;
      setBusy(true);
      setError(null);
      try {
        setResult(await api.moviesTrackerSearch(q, { refresh }));
      } catch (e) {
        setError(toError(e));
        setResult(null);
      } finally {
        setBusy(false);
      }
    },
    [query],
  );

  // Автопоиск по названию открытого фильма: только когда вход РЕАЛЬНО выполнен
  // (кука bb_data) или трекеру вход не нужен вовсе (rutor). Одного сохранённого
  // пароля мало: поиск ушёл бы гостем и получил проверку Cloudflare — лучше
  // сначала показать кнопку «Войти на форум».
  useEffect(() => {
    if (autoRan.current) return;
    if (status?.requiresLogin !== false && !status?.chromium?.loggedIn && !status?.session?.ok) {
      return;
    }
    if (!String(initialQuery || "").trim()) return;
    autoRan.current = true;
    void search(false);
  }, [status, initialQuery, search]);

  /**
   * Вход логином и паролем из секретов — тем же сетевым стеком, что и поиск.
   *
   * Зачем после окна входа: окно могло пройти проверку Cloudflare, но пользователь
   * не вводил логин (или вводил его не в этом профиле). Тогда логин делает бэкенд:
   * POST login.php уходит через сессию Chromium с тем же IP и UA, которым выдана
   * cf_clearance, — поэтому проверка не приходит снова.
   */
  const loginSaved = useCallback(async (): Promise<boolean> => {
    try {
      await api.moviesTrackerLogin();
      setProbeNotice(t("movies.trackerLoginAuto"));
      return true;
    } catch (e) {
      setError(toError(e));
      return false;
    }
  }, [t]);

  /**
   * Вход в окне приложения (Chromium).
   *
   * Это основной путь: Chrome/Edge 127+ шифруют куки app-bound ключом, поэтому
   * «взять куки из браузера пользователя» нельзя, а окно приложения проходит
   * Cloudflare-проверку само и остаётся авторизованным в своей сессии — оттуда
   * скрапер и берёт куки (см. server/ts/trackerScraper.ts, chromiumSession).
   */
  const loginViaWindow = useCallback(async () => {
    const bridge = window.appBridge;
    if (!bridge?.openTrackerLogin) {
      setError({ code: "", message: t("movies.trackerWindowNoBridge"), details: null });
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await bridge.openTrackerLogin({
        url: status?.loginUrl || status?.baseUrl || "",
        proxyRules: status?.proxyUrl || null,
        // UA окна и UA скрапера должны совпадать: cf_clearance привязан к паре
        // «IP + User-Agent». Пусто — приложение подставит обычный Chrome своей версии.
        userAgent: status?.userAgent || undefined,
      });
      if (!res?.ok) {
        // Куки не появились вовсе (Cloudflare не пропустил или вход не завершён) —
        // это самая частая неудача, и пользователю нужно знать, что делать.
        const message =
          res?.error === "no_cookies"
            ? t("movies.trackerWinNoCookies")
            : t("movies.trackerWindowFailed");
        setError({ code: res?.error || "", message, details: null });
        return;
      }
      // Куки сессии кладём и в нашу сессию: так работают статус, логи и «Обновить».
      if (res.cookieHeader) {
        await api.moviesTrackerCookies(res.cookieHeader, res.userAgent);
        setCookieSaved(res.names || []);
      }
      if (res.loggedIn) {
        setProbeNotice(t("movies.trackerWinLoggedIn"));
        await refreshStatus();
        if (query.trim()) void search(false);
        return;
      }
      // Входа нет, но проверку Cloudflare окно прошло: если логин/пароль сохранены,
      // входим сами (POST идёт тем же стеком Chromium — cf_clearance подходит).
      if (res.hasCf && status?.hasCredentials) {
        const ok = await loginSaved();
        await refreshStatus();
        if (ok && query.trim()) void search(false);
        return;
      }
      // Куки есть, но признака входа нет: говорим, что именно осталось сделать.
      setProbeNotice(res.hasCf ? t("movies.trackerWinCfOnly") : t("movies.trackerWinNoLogin"));
      await refreshStatus();
    } catch (e) {
      setError(toError(e));
    } finally {
      setBusy(false);
    }
  }, [
    status?.loginUrl,
    status?.baseUrl,
    status?.proxyUrl,
    status?.userAgent,
    status?.hasCredentials,
    refreshStatus,
    query,
    search,
    loginSaved,
    t,
  ]);

  /** Проверка сессии: пустил форум / Cloudflare / форма входа. */
  const checkSession = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const { probe } = await api.moviesTrackerSession();
      setProbeNotice(
        probe.cloudflare
          ? t("movies.trackerProbeCf")
          : probe.authorized || !probe.loginForm
            ? t("movies.trackerProbeOk")
            : t("movies.trackerProbeGuest"),
      );
    } catch (e) {
      setError(toError(e));
    } finally {
      setBusy(false);
    }
  }, [t]);

  /**
   * Сброс авторизации: бэкенд удаляет файл сессии форума и гасит сессию окна входа
   * (куки Chromium), UI забывает результаты и подсказки, автопоиск снова разрешён.
   * Логин/пароль в зашифрованных секретах остаются — их можно ввести заново.
   */
  const resetAuth = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      await api.moviesTrackerLogout();
      // Интерфейс возвращаем в «до входа»: чужой результат поиска и подсказки
      // прошлой сессии только путали бы.
      setResult(null);
      setCookieSaved(null);
      setProbes([]);
      setCookieInput("");
      setShowCookies(null);
      setProbeNotice(t("movies.trackerLogoutDone"));
      autoRan.current = false;
      await refreshStatus();
    } catch (e) {
      setError(toError(e));
    } finally {
      setBusy(false);
    }
  }, [refreshStatus, t]);

  /** Сохранить логин/пароль (уходят в секреты на бэкенде, затем — вход). */
  const saveCredentials = useCallback(async () => {
    if (!login.trim() || !password) return;
    setSaving(true);
    setError(null);
    try {
      await api.moviesTrackerConfig({ login: login.trim(), password });
      setLogin("");
      setPassword("");
      // Сразу пробуем войти: если Cloudflare ещё не пропускает, пользователь увидит
      // это здесь же (с диагностикой), а не после непонятного пустого поиска.
      const ok = await loginSaved();
      await refreshStatus();
      if (ok && query.trim()) void search(false);
    } catch (e) {
      setError(toError(e));
    } finally {
      setSaving(false);
    }
  }, [login, password, refreshStatus, loginSaved, query, search]);

  /** Импорт куки из браузеров машины: пользователь уже вошёл там — ничего не копирует. */
  const pickupFromBrowser = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await api.moviesTrackerCookiesFromBrowser();
      setProbes(res.probes || []);
      if (!res.ok) {
        setProbeNotice(t("movies.trackerCookiesNotFound"));
        return;
      }
      setCookieSaved(res.cookies);
      const from = res.source
        ? `${res.source.browser}${res.source.profile ? ` (${res.source.profile})` : ""}`
        : "";
      setProbeNotice(`${t("movies.trackerCookiesSource")}: ${from}`);
      await refreshStatus();
      if (query.trim() && (res.probe?.authorized || !res.probe?.loginForm)) void search(false);
    } catch (e) {
      setError(toError(e));
    } finally {
      setBusy(false);
    }
  }, [query, refreshStatus, search, t]);

  /**
   * Вставить строку куки из буфера обмена.
   *
   * Зачем: строку куки копируют из DevTools (Network → Cookie), а вставка через
   * буфер избавляет от ручного выделения длинной строки. `document.cookie` тут не
   * подходит: bb_data и cf_clearance помечены HttpOnly и в JS страницы не видны.
   */
  const pasteFromClipboard = useCallback(async () => {
    try {
      const text = await navigator.clipboard.readText();
      const raw = String(text || "").trim();
      if (!raw) {
        setError({ code: "", message: t("movies.trackerCookiesPasteEmpty"), details: null });
        return;
      }
      setCookieInput(raw);
      setError(null);
    } catch {
      // Браузер не дал доступ к буферу (нет разрешения/не secure context) —
      // это не поломка: подсказываем вставить вручную.
      setError({ code: "", message: t("movies.trackerCookiesPasteDenied"), details: null });
    }
  }, [t]);

  /** Импорт куки из браузера: единственный способ пройти Cloudflare на tracker.php. */
  const applyCookies = useCallback(async () => {
    if (!cookieInput.trim()) return;
    setSaving(true);
    setError(null);
    try {
      const res = await api.moviesTrackerCookies(cookieInput.trim());
      setCookieInput("");
      setCookieSaved(res.cookies);
      await refreshStatus();
    } catch (e) {
      setError(toError(e));
    } finally {
      setSaving(false);
    }
  }, [cookieInput, refreshStatus]);

  /**
   * Название трекера для UI: перевод по id (movies.trackerPreset_<id>), а если
   * перевода нет — название с бэкенда (t возвращает сам ключ, если его не нашёл).
   */
  const presetLabel = useCallback(
    (p: { id: string; label: string }): string => {
      const key = `movies.trackerPreset_${p.id}`;
      const text = t(key);
      return text === key ? p.label : text;
    },
    [t],
  );

  /**
   * Переключить трекер (rutracker ↔ rutor).
   *
   * Бэкенд применяет пресет площадки целиком (пути, кодировка, движок разбора
   * выдачи), UI забывает прежний результат и разрешает автопоиск заново: выдача
   * другого трекера к текущему запросу отношения не имеет. Если новому трекеру
   * вход не нужен, поиск выполняется сразу же.
   */
  const switchPreset = useCallback(
    async (id: string) => {
      if (!id || id === status?.engine) return;
      setBusy(true);
      setError(null);
      try {
        const res = await api.moviesTrackerPreset(id);
        setResult(null);
        autoRan.current = false;
        setProbeNotice(`${t("movies.trackerPresetSwitched")}: ${presetLabel(res)}`);
        await refreshStatus();
        if (query.trim()) void search(false);
      } catch (e) {
        setError(toError(e));
      } finally {
        setBusy(false);
      }
    },
    [status?.engine, query, refreshStatus, search, presetLabel, t],
  );

  /** Открыть раздачу в плеере: .torrent скачивает бэкенд, мы получаем файлы. */
  const openRelease = useCallback(
    async (rel: TrackerRelease) => {
      setOpening(rel.id);
      setError(null);
      try {
        // Название фильма и magnet уходят на бэкенд: по названию окно плеера
        // восстановится при повторном открытии фильма, по magnet — возобновится
        // загрузка после паузы (см. server/ts/torrent.ts).
        onOpenRelease(
          await api.moviesTrackerAdd(rel.id, {
            title: String(movieTitle || initialQuery || rel.title || "").trim(),
            magnet: rel.magnet || undefined,
          }),
        );
      } catch (e) {
        setError(toError(e));
      } finally {
        setOpening(null);
      }
    },
    [onOpenRelease, movieTitle, initialQuery],
  );

  /**
   * Трекеру вход не нужен (rutor: поиск и .torrent доступны анонимно): блоки
   * входа и импорта куки не показываем — в них нет смысла, и они только путали бы.
   */
  const anonymous = status?.requiresLogin === false;
  const needsCreds = !!status && !anonymous && !status.hasCredentials;
  /** Фильтр по разрешению: выдача площадки смешана (4K/1080p/720p и т.д.). */
  const [resFilter, setResFilter] = useState("");
  /**
   * Фильтр по сидам: сиды (seeders) — те, кто раздаёт файл, и именно их число
   * определяет скорость скачивания (личеры качают вместе с вами и скорости не
   * добавляют). Значения — порог «не меньше».
   */
  const [minSeeds, setMinSeeds] = useState("0");
  const allItems = result?.items || [];
  const resOptions = Array.from(
    new Set(allItems.map((r) => r.meta?.resolution).filter((v): v is string => !!v)),
  ).sort();
  const seedThreshold = Math.max(0, Number(minSeeds) || 0);
  const items = allItems.filter(
    (r) =>
      (!resFilter || r.meta?.resolution === resFilter) &&
      (r.seeders || 0) >= seedThreshold,
  );
  // Переключатель трекера: список приходит со статусом (порядок задаёт бэкенд).
  const presets = status?.presets || [];
  /**
   * Доступно ли «Войти на форум» (окно входа Chromium).
   *
   * Смотрим на МОСТ приложения, а не только на флаг бэкенда: окно открывает
   * рендерер через `openTrackerLogin`, и если мост есть — кнопка должна быть
   * (флаг `status.chromium.available` приходит с бэкенда и может отставать).
   * Когда моста нет, интерфейс открыт в браузере: окно входа невозможно, поэтому
   * вместо кнопки показываем объяснение и сразу раскрываем ручную вставку куки.
   */
  const windowLogin =
    (typeof window !== "undefined" && !!window.appBridge?.openTrackerLogin) ||
    !!status?.chromium?.available;
  /** Интерфейс открыт внутри приложения (есть мост Electron). */
  const inApp = typeof window !== "undefined" && !!window.appBridge;
  // Ручную вставку раскрываем сами только в браузере (там это единственный путь):
  // в приложении её открывает пользователь, иначе панель мешала бы окну входа.
  const manualOpen = showCookies ?? (!windowLogin && !inApp && !!status);
  // Ключевые куки: cf_clearance нужен для Cloudflare, bb_data — признак входа.
  const cookieNames = status?.cookieNames || [];
  const haveCf = cookieNames.includes("cf_clearance");
  const haveBb = cookieNames.includes("bb_data");

  return (
    <div className="mv-tracker">
      {/* Статус: включён ли поиск, жива ли сессия форума, есть ли ffmpeg. */}
      <div className="mv-tracker-status">
        <span className={status?.enabled ? "is-ok" : "is-off"}>
          <ShieldCheck size={13} /> {status?.label || t("movies.tracker")}
        </span>
        <span className={status?.session?.ok ? "is-ok" : ""}>
          {status?.session?.ok ? t("movies.trackerSessionOn") : t("movies.trackerSessionOff")}
        </span>
        {status?.ffmpeg === false && (
          <span className="is-warn">
            <AlertTriangle size={13} /> {t("movies.tracksUnavailable")}
          </span>
        )}
      </div>

      {/* Переключатель трекера. Бэкенд применяет пресет площадки целиком: адреса,
          кодировку, способ поиска и движок разбора выдачи. */}
      {presets.length > 1 && (
        <Field label={t("movies.trackerPreset")} w={220}>
          <select
            className="text-input"
            value={status?.engine || ""}
            disabled={busy}
            onChange={(e) => void switchPreset(e.target.value)}
          >
            {presets.map((p) => (
              <option key={p.id} value={p.id}>
                {presetLabel(p)}
              </option>
            ))}
          </select>
        </Field>
      )}

      {/* Движок без входа: объясняем, почему логин/пароль и куки не спрашиваем. */}
      {anonymous && (
        <span className="muted-sm mv-tracker-anon">
          <Globe size={13} /> {t("movies.trackerNoLoginNeeded")}
          {status?.baseUrl ? ` · ${status.baseUrl}` : ""}
        </span>
      )}

      {/* Логин/пароль запрашиваем только если их ещё нет: они уходят в секреты
          на бэкенде, а не хранятся в браузере. */}
      {needsCreds && (
        <div className="mv-tracker-creds">
          <Field label={t("movies.trackerLogin")} w={220}>
            <input
              className="text-input"
              value={login}
              autoComplete="off"
              onChange={(e) => setLogin(e.target.value)}
            />
          </Field>
          <Field label={t("movies.trackerPassword")} w={220}>
            <input
              className="text-input"
              type="password"
              value={password}
              autoComplete="new-password"
              onChange={(e) => setPassword(e.target.value)}
            />
          </Field>
          <Btn
            variant="primary"
            icon={KeyRound}
            disabled={saving || !login.trim() || !password}
            onClick={() => void saveCredentials()}
          >
            {t("movies.trackerSaveCreds")}
          </Btn>
          <div className="muted-sm mv-tracker-hint">{t("movies.trackerCredsHint")}</div>
        </div>
      )}

      {/* Вход на форум.
          Основной путь — ОКНО ВХОДА приложения: Chrome/Edge 127+ шифруют куки
          app-bound ключом (прочитать их снаружи нельзя), а окно приложения проходит
          Cloudflare-проверку само и остаётся авторизованным в своей сессии.
          Запасные пути: автоподхват куки из браузеров и ручная вставка. */}
      <div className="mv-tracker-actions">
        {/* Окно входа — только там, где вход нужен: у rutor поиск анонимный. */}
        {!anonymous &&
          (windowLogin ? (
            <Btn
              variant="primary"
              icon={KeyRound}
              disabled={busy}
              onClick={() => void loginViaWindow()}
            >
              {t("movies.trackerLoginWindow")}
            </Btn>
          ) : inApp ? (
            // Мост есть, но окна входа в нём нет (старый preload) — честно говорим.
            <span className="muted-sm">{t("movies.trackerWindowNoBridge")}</span>
          ) : (
            <div className="mv-tracker-note">
              <span className="mv-tracker-note-title">
                <AlertTriangle size={13} /> {t("movies.trackerWindowNeedsApp")}
              </span>
              <span className="muted-sm">{t("movies.trackerWindowNeedsAppHow")}</span>
            </div>
          ))}
        <Btn icon={ShieldCheck} disabled={busy} onClick={() => void checkSession()}>
          {t("movies.trackerCheck")}
        </Btn>
        {/* Проверка Cloudflare, сброс входа и подписи о сессии — только у трекеров
            с входом: у rutor сессии нет, и «Вход выполнен» было бы неправдой. */}
        {!anonymous && (
          <>
            {/* Проверка Cloudflare после смены UA/прокси или сброса: cf_clearance
                привязан к паре «IP + User-Agent», поэтому старую куку форум может
                больше не принимать. Кнопка открывает то же окно — пройти заново. */}
            {windowLogin && (status?.session?.ok || status?.chromium?.loggedIn) && (
              <Btn icon={ShieldCheck} disabled={busy} onClick={() => void loginViaWindow()}>
                {t("movies.trackerCfWindow")}
              </Btn>
            )}
            {/* Сброс авторизации: нужен, когда сессия «залипла» (протухла, вошли
                другим аккаунтом, Cloudflare выдал куки для другого IP) — одним
                нажатием выходим из форума и входим заново. */}
            {(status?.hasCredentials || status?.chromium?.loggedIn || status?.session?.ok) && (
              <Btn icon={LogOut} disabled={busy} onClick={() => void resetAuth()}>
                {t("movies.trackerLogout")}
              </Btn>
            )}
            {status?.chromium?.loggedIn && (
              <span className="muted-sm">
                {t("movies.trackerWinLoggedIn")}
                {status.proxyUrl ? "" : ` · ${t("movies.trackerDirect")}`}
              </span>
            )}
            {status?.session?.ok && !status.chromium?.loggedIn && (
              <span className="muted-sm">{t("movies.trackerSessionOn")}</span>
            )}
          </>
        )}
        {probeNotice && <span className="muted-sm">{probeNotice}</span>}
      </div>

      {!anonymous && initialQuery && status && !status.hasCredentials && !status.chromium?.loggedIn && (
        <span className="muted-sm">{t("movies.trackerNeedLogin", { q: String(initialQuery) })}</span>
      )}

      {/* Cloudflare и куки сессии: нужно ТОЛЬКО там, где вход обязателен (rutracker):
          tracker.php закрыт проверкой, а работают ли куки из браузера
          (cf_clearance + bb_data) — зависит от того, через какой прокси ходил браузер.
          У движков без входа (rutor) блок скрыт: ни логина, ни Cloudflare там нет. */}
      {!anonymous && (
      <div className="mv-tracker-cookies">
        <Btn icon={Cookie} disabled={busy} onClick={() => void pickupFromBrowser()}>
          {t("movies.trackerCookiesFromBrowser")}
        </Btn>
        <Btn onClick={() => setShowCookies(!manualOpen)}>{t("movies.trackerCookiesManual")}</Btn>
        <span className="muted-sm">
          {status?.cookieNames?.length
            ? `${t("movies.trackerCookiesHave")}: ${status.cookieNames.slice(0, 8).join(", ")}${
                status.cookieNames.length > 8 ? "…" : ""
              }`
            : t("movies.trackerSessionOff")}
        </span>
        {/* Какие из КЛЮЧЕВЫХ куки уже есть: без cf_clearance форум отдаст проверку
            Cloudflare, без bb_data он не узнает, что мы вошли. */}
        <span className="muted-sm mv-tracker-keycookies">
          {t("movies.trackerCookiesKeys", { cf: haveCf ? "✓" : "✕", bb: haveBb ? "✓" : "✕" })}
        </span>
        <span className="muted-sm">{t("movies.trackerCookiesFromBrowserHint")}</span>
        {probes.length > 0 && (
          <details className="mv-tracker-probes">
            <summary>{t("movies.trackerProbesTitle")}</summary>
            <ul>
              {probes.map((p) => (
                <li key={`${p.id}-${p.profile}`}>
                  {p.browser}
                  {p.profile ? ` (${p.profile})` : ""}:{" "}
                  {p.cookies ? `${p.cookies} ✓` : p.reason}
                  {/* app-bound (v20): значения расшифровывает только сам браузер —
                      подсказываем, что делать (окно входа приложения). */}
                  {p.appBound && (
                    <span className="mv-tracker-badge">{t("movies.trackerBadgeAppBound")}</span>
                  )}
                  {p.locked && !p.appBound && (
                    <span className="mv-tracker-badge">{t("movies.trackerBadgeLocked")}</span>
                  )}
                </li>
              ))}
            </ul>
          </details>
        )}
        {manualOpen && (
          <div className="mv-tracker-cookies-form">
            <textarea
              className="text-input mv-tracker-cookies-input"
              value={cookieInput}
              placeholder="cf_clearance=…; bb_data=…"
              onChange={(e) => setCookieInput(e.target.value)}
            />
            <div className="mv-tracker-cookies-row">
              <Btn
                variant="primary"
                icon={Cookie}
                disabled={saving || !cookieInput.trim()}
                onClick={() => void applyCookies()}
              >
                {t("movies.trackerCookiesApply")}
              </Btn>
              <Btn icon={ClipboardPaste} disabled={saving} onClick={() => void pasteFromClipboard()}>
                {t("movies.trackerCookiesPaste")}
              </Btn>
              <span className="muted-sm">{t("movies.trackerCookiesHint")}</span>
            </div>
            {cookieSaved && (
              <span className="muted-sm">
                {t("movies.trackerCookiesSaved", { count: cookieSaved.length })}
              </span>
            )}
          </div>
        )}
      </div>
      )}

      <Field label={t("movies.trackerQuery")}>
        <div className="mv-magnet-row">
          <input
            className="text-input"
            value={query}
            placeholder={t("movies.searchPlaceholder")}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void search(false);
            }}
          />
          <Btn
            variant="primary"
            icon={Search}
            disabled={busy || !query.trim()}
            onClick={() => void search(false)}
          >
            {t("movies.trackerFind")}
          </Btn>
          <Btn icon={RefreshCw} disabled={busy || !query.trim()} onClick={() => void search(true)}>
            {t("movies.refresh")}
          </Btn>
        </div>
      </Field>

      {busy && <div className="mv-torrent-busy">{t("movies.trackerSearching")}</div>}

      {error && (
        <div className="mv-error-inline">
          <AlertTriangle size={15} style={{ color: "var(--coral)" }} />
          <div className="mv-tracker-error">
            <span>{errText(error.code, error.message)}</span>
            {error.code === "cf_challenge" && (
              <span className="muted-sm">{t("movies.trackerCfHint")}</span>
            )}
            {/* Диагностика: что именно вернул форум (статус, размер, начало текста). */}
            {error.details && (
              <span className="muted-sm mv-tracker-details">
                {t("movies.trackerDetails")}: HTTP {error.details.status ?? "—"}
                {error.details.bytes != null ? `, ${error.details.bytes} B` : ""}
                {error.details.cloudflare ? " · Cloudflare" : ""}
                {error.details.loginForm ? ` · ${t("movies.trackerLoginForm")}` : ""}
                {error.details.snippet ? ` · ${error.details.snippet.slice(0, 200)}` : ""}
              </span>
            )}
          </div>
        </div>
      )}

      {/* Фильтры выдачи: разрешение (если вариантов больше одного) и сиды.
          Сиды важнее: от них зависит скорость скачивания. */}
      {result && !error && allItems.length > 0 && (
        <div className="mv-res-filter">
          {resOptions.length > 1 && (
            <Field label={t("movies.trackerResolution")} w={150}>
              <Select
                value={resFilter}
                onChange={(e) => setResFilter(e.target.value)}
                options={[
                  { value: "", label: t("movies.trackerResolutionAll") },
                  ...resOptions.map((r) => ({ value: r, label: r })),
                ]}
              />
            </Field>
          )}
          <Field label={t("movies.trackerSeeds")} w={130}>
            <Select
              value={minSeeds}
              onChange={(e) => setMinSeeds(e.target.value)}
              options={[
                { value: "0", label: t("movies.trackerSeedsAny") },
                ...[5, 10, 20, 50, 100].map((n) => ({
                  value: String(n),
                  label: t("movies.trackerSeedsMin", { n }),
                })),
              ]}
            />
          </Field>
          <span className="muted-sm">
            {t("movies.trackerShown", { shown: items.length, total: allItems.length })}
          </span>
        </div>
      )}

      {result && !error && (
        <div className="muted-sm mv-tracker-count">
          {t("movies.trackerFound", { count: result.total })}
          {result.cached ? ` · ${t("movies.trackerCached")}` : ""}
        </div>
      )}

      {result && !error && items.length === 0 && (
        <EmptyHint icon={Search} text={t("movies.trackerEmpty")} />
      )}

      {items.length > 0 && (
        <div className="mv-tracker-list">
          {items.map((r) => (
            <div
              key={r.id}
              className="mv-tracker-item"
              onContextMenu={(e) =>
                menu.open(e, [
                  {
                    label: t("movies.trackerOpen"),
                    icon: Download,
                    onClick: () => void openRelease(r),
                  },
                  { separator: true },
                  {
                    label: t("ctx.copyName"),
                    icon: Copy,
                    onClick: () => void copyToClipboard(r.title || ""),
                  },
                  r.magnet
                    ? {
                        label: t("ctx.copyMagnet"),
                        icon: Link2,
                        onClick: () => void copyToClipboard(String(r.magnet)),
                      }
                    : null,
                ])
              }
            >
              <div className="mv-tracker-title" title={r.title}>
                {r.title}
              </div>
              <div className="mv-tracker-meta">
                <span className="mv-tracker-size">{r.size || "—"}</span>
                <span className="mv-tracker-seed">
                  <Users size={12} /> {r.seeders}
                  <span className="muted-sm"> / {r.leechers}</span>
                </span>
                <span className="muted-sm mv-tracker-meta-line">{releaseMetaLine(r.meta)}</span>
              </div>
              <Btn
                variant="primary"
                icon={Download}
                disabled={opening !== null}
                onClick={() => void openRelease(r)}
              >
                {opening === r.id ? t("movies.torrentConnecting") : t("movies.trackerOpen")}
              </Btn>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
