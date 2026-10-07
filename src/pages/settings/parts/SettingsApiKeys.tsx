/**
 * Выделено из SettingsPage.tsx при разбиении крупного файла (поведение не менялось).
 */
import { useI18n } from "@/app/i18n";
import { useState, useEffect } from "react";
import { api } from "@/api/client";
import { KeyRound, ChevronDown, Check, Save } from "lucide-react";
import { Badge, Btn } from "@/components/ui";
import { Row } from "@/pages/settings/parts/SettingsControls";

/**
 * Сворачиваемое подменю «API-ключи» внутри раздела AI Chat.
 *
 * Как это работает:
 *  - список провайдеров берётся с GET /settings/providers (в ответе только
 *    флаг «настроен», сами ключи никогда не отдаются клиенту);
 *  - введённый ключ уходит один раз POST-ом на /settings/providers/:id/key;
 *  - на сервере ключ шифруется (safeStorage/DPAPI внутри Electron, иначе
 *    AES-256-GCM с мастер-ключом) и хранится в storage/secrets.json.
 */
export function ApiKeysPanel() {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [providers, setProviders] = useState<
    { id: string; label: string; configured: boolean; stub: boolean }[]
  >([]);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [savedId, setSavedId] = useState<string | null>(null);

  const refresh = () => {
    api
      .getProviders()
      .then((list: any) => setProviders(list || []))
      .catch(() => setProviders([]));
  };
  useEffect(() => {
    if (open) refresh();
  }, [open]);

  const save = async (id: string) => {
    const key = (drafts[id] || "").trim();
    if (!key) return;
    try {
      await api.saveKey(id, key);
      setDrafts((d) => ({ ...d, [id]: "" }));
      setSavedId(id);
      refresh();
      setTimeout(() => setSavedId(null), 1500);
    } catch {
      /* ошибка сети — бейдж «configured» просто не обновится */
    }
  };

  return (
    <div className="keys-panel">
      <button
        type="button"
        className="keys-toggle"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
      >
        <KeyRound size={14} />
        <span>{t("chat.keysSection")}</span>
        <ChevronDown size={14} className={`chev ${open ? "is-open" : ""}`} />
      </button>
      {open && (
        <div className="keys-body">
          <div className="muted-sm">{t("chat.keysHint")}</div>
          {providers.length === 0 && <div className="muted-sm">{t("chat.keysEmpty")}</div>}
          {providers.map((p) => (
            <div className="keys-row" key={p.id}>
              <div className="keys-name">
                <span>{p.label}</span>
                <Badge tone={p.configured ? "teal" : "neutral"} mono>
                  {p.configured ? t("chat.keyConfigured") : t("chat.keyMissing")}
                </Badge>
              </div>
              <div className="keys-actions">
                <input
                  type="password"
                  className="text-input"
                  value={drafts[p.id] || ""}
                  placeholder={t("chat.keyPlaceholder")}
                  onChange={(e) => setDrafts((d) => ({ ...d, [p.id]: e.target.value }))}
                />
                <Btn
                  icon={savedId === p.id ? Check : Save}
                  onClick={() => save(p.id)}
                  disabled={!(drafts[p.id] || "").trim()}
                  title={t("chat.keySave")}
                >
                  {savedId === p.id ? t("chat.keySaved") : t("chat.keySave")}
                </Btn>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Строка API-ключа TMDB в разделе «Фильмы и Сериалы». Ключ уходит один раз
 * POST-ом, на сервере шифруется (storage/secrets.json); статус «задан/не задан»
 * берётся из GET /api/movies/status (hasKey/keySource).
 */
export function TmdbKeyRow() {
  const { t } = useI18n();
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api
      .moviesStatus()
      .then((st) => setConfigured(!!st.hasKey))
      .catch(() => setConfigured(null));
  }, []);

  const save = async () => {
    const key = draft.trim();
    if (!key) return;
    setSaving(true);
    try {
      await api.moviesSaveKey(key);
      setDraft("");
      setConfigured(true);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Row label={`${t("moviesSettings.keyLabel")} (TMDB)`} hint={t("moviesSettings.keyHint")}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <Badge tone={configured ? "teal" : "neutral"} mono>
          {configured ? t("moviesSettings.keyConfigured") : t("moviesSettings.keyMissing")}
        </Badge>
        <input
          type="password"
          className="text-input"
          value={draft}
          placeholder="••••••"
          onChange={(e) => setDraft(e.target.value)}
          style={{ width: 200 }}
        />
        <Btn icon={Save} disabled={saving || !draft.trim()} onClick={() => void save()}>
          {t("moviesSettings.keySave")}
        </Btn>
      </div>
    </Row>
  );
}

/**
 * Менеджер паролей: отдельное шифрованное хранилище (storage/password-vault.json,
 * server/ts/passwordVault.ts) — НЕ путать с ключами провайдеров выше на этой же
 * странице. Пароли по умолчанию скрыты: расшифровка конкретной записи запрашивается
 * с сервера только по клику "показать"/"копировать" (GET /api/passwords/:id/reveal).
 */
/** Настройки генератора пароля — не секрет, обычная настройка интерфейса,
 *  поэтому localStorage (см. src/lib/uiSettings.ts), а не БД/сервер: чтобы
 *  выбор регистров/длины запоминался между сессиями без похода на бэкенд. */
export interface GenOpts {
  length: number;
  lower: boolean;
  upper: boolean;
  digits: boolean;
  symbols: boolean;
}
export const GEN_OPTS_KEY = "passwordVault.genOpts";
const DEFAULT_GEN_OPTS: GenOpts = {
  length: 20,
  lower: true,
  upper: true,
  digits: true,
  symbols: true,
};

export function loadGenOpts(): GenOpts {
  try {
    const raw = localStorage.getItem(GEN_OPTS_KEY);
    if (!raw) return DEFAULT_GEN_OPTS;
    const parsed = JSON.parse(raw);
    return { ...DEFAULT_GEN_OPTS, ...parsed };
  } catch {
    return DEFAULT_GEN_OPTS;
  }
}
