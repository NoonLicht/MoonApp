import { useCallback, useEffect, useState } from "react";
import { ArrowUpRight } from "lucide-react";
import { useI18n } from "@/app/i18n";
import { api } from "@/api/client";
import type { TtsPythonEnv } from "@/api/client";
import type { ProviderInfo } from "@/api/types";
import { Btn, Select } from "@/components/ui";
import { openTarget } from "@/lib/deepLink";
import { loadCfg, saveCfg } from "@/pages/ai-chat/lib/chatUtils";
import type { PageId } from "@/app/navigation";
import LectureEnginePanel from "@/pages/lecture/parts/LectureEnginePanel";
import LlamaPanel from "@/components/LlamaPanel";
import { ModelPanel as SemanticPanel } from "@/components/ModelToggle";
import TranslateModelPanel from "@/pages/translate/parts/ModelPanel";
import { useTrSettings, useTrStatus } from "@/pages/translate/parts/useTranslate";
import { PyEnvPanel } from "@/pages/voice/parts/PyEnvPanel";

type HubId = "chat" | "stt" | "tts" | "translate" | "upscale" | "semantic" | "llama";

interface HubItem {
  id: HubId;
  page: PageId;
  title: string;
  status: string;
  ready: boolean;
}

function TranslateManager() {
  const { lang } = useI18n();
  const { status, refresh } = useTrStatus();
  const [settings, set] = useTrSettings(lang);
  if (!status) return <div className="muted-sm">…</div>;
  return (
    <TranslateModelPanel
      status={status}
      settings={settings}
      set={set}
      refresh={refresh}
      notify={() => {}}
    />
  );
}

/** Провайдеры чата: ключи API и провайдер/модель по умолчанию. */
function ChatProviders({ onChanged }: { onChanged: () => void }) {
  const { t } = useI18n();
  const [list, setList] = useState<ProviderInfo[] | null>(null);
  const [keys, setKeys] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState<string | null>(null);
  const [cfg, setCfg] = useState(loadCfg());
  const load = useCallback(() => {
    api
      .getProviders()
      .then((r) => setList(r.filter((p) => !p.stub)))
      .catch(() => setList([]));
  }, []);
  useEffect(() => load(), [load]);
  if (!list) return <div className="muted-sm">…</div>;
  const cur = list.find((p) => p.id === cfg.provider) ?? list[0];
  const setDefault = (patch: Partial<typeof cfg>) => {
    const next = { ...cfg, ...patch };
    setCfg(next);
    saveCfg(next);
    onChanged();
  };
  const save = async (id: string) => {
    const key = (keys[id] || "").trim();
    if (!key) return;
    setSaving(id);
    try {
      await api.saveKey(id, key);
      setKeys((k) => ({ ...k, [id]: "" }));
      load();
      onChanged();
    } finally {
      setSaving(null);
    }
  };
  return (
    <div className="aihub-stack">
      <div className="aihub-row2">
        <Select
          value={cur?.id ?? ""}
          onChange={(e) => setDefault({ provider: e.target.value, model: "" })}
          options={list.map((p) => ({ value: p.id, label: p.label }))}
        />
        <Select
          value={cfg.model || cur?.models?.[0] || ""}
          onChange={(e) => setDefault({ model: e.target.value })}
          options={(cur?.models ?? []).map((m) => ({ value: m, label: m }))}
        />
      </div>
      <div className="aihub-prov-list">
        {list.map((p) => (
          <div key={p.id} className="aihub-prov">
            <span className={`aihub-dot${p.configured ? " ok" : ""}`} />
            <span className="aihub-prov-name">{p.label}</span>
            <input
              className="text-input aihub-prov-key"
              type="password"
              autoComplete="off"
              placeholder={p.configured ? t("aiHub.keySaved") : t("aiHub.keyPlaceholder")}
              value={keys[p.id] || ""}
              onChange={(e) => setKeys((k) => ({ ...k, [p.id]: e.target.value }))}
              onKeyDown={(e) => e.key === "Enter" && void save(p.id)}
            />
            <Btn
              variant="primary"
              disabled={!(keys[p.id] || "").trim() || saving === p.id}
              onClick={() => void save(p.id)}
            >
              {t("aiHub.saveKey")}
            </Btn>
          </div>
        ))}
      </div>
    </div>
  );
}

function TtsManager() {
  const [engine, setEngine] = useState<"f5" | "xtts">("f5");
  const [env, setEnv] = useState<TtsPythonEnv | null>(null);
  const load = useCallback((force = false) => {
    api
      .ttsEnv(force)
      .then(setEnv)
      .catch(() => setEnv(null));
  }, []);
  useEffect(() => load(), [load]);
  return (
    <div className="aihub-stack">
      <Select
        value={engine}
        onChange={(e) => setEngine(e.target.value as "f5" | "xtts")}
        options={[
          { value: "f5", label: "F5-TTS" },
          { value: "xtts", label: "XTTS v2" },
        ]}
      />
      <PyEnvPanel engine={engine} env={env} onChanged={() => load(true)} />
    </div>
  );
}

/**
 * «ИИ и модели»: единое место управления всеми моделями приложения. Слева —
 * список с текущим состоянием, справа — рабочая панель выбранного пункта
 * (те же панели, что раньше были спрятаны по страницам: Лекторий, Озвучка,
 * Переводчик, llama.cpp, Умный поиск).
 */
export function AiHub({ chatProvider, chatModel }: { chatProvider?: string; chatModel?: string }) {
  const { t } = useI18n();
  const [items, setItems] = useState<HubItem[] | null>(null);
  const [sel, setSel] = useState<HubId>("stt");
  const [nonce, setNonce] = useState(0);
  const [semOpen, setSemOpen] = useState(false);

  useEffect(() => {
    let live = true;
    void (async () => {
      const [lec, sem, tr, llama, up] = await Promise.allSettled([
        api.lectureEngine(),
        api.semStatus(),
        api.trStatus(),
        api.llamaStatus(),
        api.upscaleModels(),
      ]);
      const out: HubItem[] = [];
      out.push({
        id: "chat",
        page: "aichat",
        title: t("aiHub.chat"),
        status: chatProvider ? `${chatProvider} · ${chatModel || "—"}` : t("aiHub.notSet"),
        ready: !!chatProvider,
      });
      if (lec.status === "fulfilled") {
        const r = lec.value;
        out.push({
          id: "stt",
          page: "lecture",
          title: t("aiHub.stt"),
          status: r.ready
            ? r.asr === "gigaam"
              ? "GigaAM v3 · cpu"
              : `${r.model ?? r.modelId} · ${r.backend ?? "cpu"}`
            : t("aiHub.notInstalled"),
          ready: r.ready,
        });
      }
      out.push({
        id: "tts",
        page: "voice",
        title: t("aiHub.tts"),
        status: "F5-TTS · XTTS v2",
        ready: true,
      });
      if (tr.status === "fulfilled") {
        const r = tr.value;
        const n = r.installed.length;
        out.push({
          id: "translate",
          page: "translate",
          title: t("aiHub.translate"),
          status: n > 0 || r.llamaReady ? t("aiHub.models", { n: n || 1 }) : t("aiHub.notInstalled"),
          ready: n > 0 || r.llamaReady,
        });
      }
      if (up.status === "fulfilled") {
        const n = up.value.models.filter((m) => m.available).length;
        out.push({
          id: "upscale",
          page: "upscale",
          title: t("aiHub.upscale"),
          status: n > 0 ? t("aiHub.models", { n }) : t("aiHub.notInstalled"),
          ready: n > 0,
        });
      }
      if (sem.status === "fulfilled") {
        const r = sem.value;
        out.push({
          id: "semantic",
          page: "settings",
          title: t("aiHub.semantic"),
          status: r.enabled && r.model ? r.model : t("aiHub.off"),
          ready: r.enabled && !!r.model,
        });
      }
      if (llama.status === "fulfilled") {
        const r = llama.value;
        out.push({
          id: "llama",
          page: "translate",
          title: t("aiHub.llama"),
          status: r.server ? r.server.file : t("aiHub.models", { n: r.models.length }),
          ready: r.models.length > 0,
        });
      }
      if (live) setItems(out);
    })();
    return () => {
      live = false;
    };
  }, [chatProvider, chatModel, t, nonce]);

  if (!items) return <div className="muted-sm">{t("common.loading")}</div>;
  const cur = items.find((i) => i.id === sel) ?? items[0];
  const bump = () => setNonce((n) => n + 1);

  return (
    <div className="aihub">
      <div className="aihub-list" role="tablist">
        {items.map((it) => (
          <button
            key={it.id}
            type="button"
            role="tab"
            aria-selected={it.id === cur.id}
            className={`aihub-item${it.id === cur.id ? " active" : ""}`}
            onClick={() => setSel(it.id)}
          >
            <span className={`aihub-dot${it.ready ? " ok" : ""}`} />
            <span className="aihub-item-text">
              <span className="aihub-item-title">{it.title}</span>
              <span className="aihub-item-status">{it.status}</span>
            </span>
          </button>
        ))}
      </div>
      <div className="aihub-detail">
        {cur.id === "stt" && <LectureEnginePanel inline onChanged={bump} />}
        {cur.id === "tts" && <TtsManager />}
        {cur.id === "translate" && <TranslateManager />}
        {cur.id === "llama" && <LlamaPanel onChange={() => {}} />}
        {cur.id === "semantic" && (
          <div className="aihub-stack">
            <div className="muted-sm">{cur.status}</div>
            <div>
              <Btn onClick={() => setSemOpen(true)}>{t("aiHub.manage")}</Btn>
            </div>
          </div>
        )}
        {semOpen && (
          <SemanticPanel
            onClose={() => {
              setSemOpen(false);
              bump();
            }}
          />
        )}
        {cur.id === "chat" && <ChatProviders onChanged={bump} />}
        {cur.id === "upscale" && (
          <div className="aihub-stack">
            <div className="muted-sm">{cur.status}</div>
            <div>
              <Btn icon={ArrowUpRight} onClick={() => openTarget({ page: cur.page })}>
                {t("aiHub.open")}
              </Btn>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
