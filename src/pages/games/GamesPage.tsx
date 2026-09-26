import { useEffect, useRef, useState } from "react";
import {
  Gamepad2,
  Plus,
  Play,
  Trash2,
  RefreshCw,
  Save,
  History,
  X,
  ImagePlus,
  AlertTriangle,
  FolderOpen,
  Search,
  Images,
  ImageOff,
} from "lucide-react";
import { Glass, Btn, Badge, EmptyHint, SectionHead } from "@/components/ui";
import { useContextMenu } from "@/components/ContextMenu";
import { useI18n } from "@/app/i18n";
import { api } from "@/api/client";
import type { GameEntry, SaveVersion } from "@/api/types";

/** Файл в data URL — иконки/фон храним прямо в JSON карточки, без файлового стораджа. */
function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

/** Стабильный псевдослучайный градиент по имени — красивая заглушка фона без вложенных ассетов. */
function fallbackGradient(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  const h1 = h % 360;
  const h2 = (h1 + 55) % 360;
  return `linear-gradient(135deg, hsl(${h1} 55% 22%), hsl(${h2} 45% 14%))`;
}

function fmtSize(n: number): string {
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

interface FormState {
  name: string;
  exePath: string;
  description: string;
  savePath: string;
  iconDataUrl: string | null;
  backgroundDataUrl: string | null;
}

const EMPTY_FORM: FormState = {
  name: "",
  exePath: "",
  description: "",
  savePath: "",
  iconDataUrl: null,
  backgroundDataUrl: null,
};

export default function GamesPage() {
  const { t } = useI18n();
  const menu = useContextMenu();
  const [items, setItems] = useState<GameEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [scanMsg, setScanMsg] = useState("");
  const [launchError, setLaunchError] = useState("");

  const [savesFor, setSavesFor] = useState<GameEntry | null>(null);
  const [versions, setVersions] = useState<SaveVersion[]>([]);
  const [savesBusy, setSavesBusy] = useState(false);

  const load = () => {
    setLoading(true);
    api
      .gamesList()
      .then(setItems)
      .catch(() => setItems([]))
      .finally(() => setLoading(false));
  };
  useEffect(() => {
    load();
  }, []);

  const save = async () => {
    if (!form.name.trim() || !form.exePath.trim()) return;
    setSaving(true);
    try {
      await api.gamesCreate({
        name: form.name.trim(),
        exePath: form.exePath.trim(),
        description: form.description.trim(),
        savePath: form.savePath.trim() || null,
        iconDataUrl: form.iconDataUrl,
        backgroundDataUrl: form.backgroundDataUrl,
      });
      setForm(EMPTY_FORM);
      setShowForm(false);
      load();
    } finally {
      setSaving(false);
    }
  };

  const remove = async (id: string) => {
    await api.gamesDelete(id);
    load();
  };

  const doLaunch = async (g: GameEntry) => {
    setLaunchError("");
    const r = await api.gamesLaunch(g.id);
    if (!r.ok) setLaunchError(`${g.name}: ${r.error}`);
  };

  const doScan = async () => {
    setScanning(true);
    setScanMsg("");
    try {
      const r = await api.gamesAutoScan();
      setScanMsg(t("games.scanResult", { added: r.added, steam: r.scanned.steam, epic: r.scanned.epic }));
      load();
    } catch (e) {
      setScanMsg((e as Error).message);
    } finally {
      setScanning(false);
    }
  };

  const openSaves = async (g: GameEntry) => {
    setSavesFor(g);
    setVersions(await api.gamesSaveVersions(g.id));
  };

  const doBackup = async () => {
    if (!savesFor) return;
    setSavesBusy(true);
    try {
      await api.gamesSaveBackup(savesFor.id);
      setVersions(await api.gamesSaveVersions(savesFor.id));
    } finally {
      setSavesBusy(false);
    }
  };

  const doRestore = async (file: string) => {
    if (!savesFor) return;
    setSavesBusy(true);
    try {
      await api.gamesSaveRestore(savesFor.id, file);
    } finally {
      setSavesBusy(false);
    }
  };

  const setSavePathFor = async () => {
    if (!savesFor) return;
    const r = await window.appBridge?.pickFolder?.();
    if (!r?.ok || !r.path) return;
    const updated = await api.gamesUpdate(savesFor.id, { savePath: r.path });
    setSavesFor(updated);
    setItems((prev) => prev.map((g) => (g.id === updated.id ? updated : g)));
  };

  // Импорт фона по правому клику: карточка не хранит собственный <input type=file>
  // (их было бы N штук) — один скрытый инпут переиспользуется для той карточки,
  // чей id лежит в pendingBgId.
  const bgFileInputRef = useRef<HTMLInputElement | null>(null);
  const [pendingBgId, setPendingBgId] = useState<string | null>(null);
  const importBackground = (g: GameEntry) => {
    setPendingBgId(g.id);
    bgFileInputRef.current?.click();
  };
  const onBgFileChosen = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    e.target.value = "";
    const id = pendingBgId;
    setPendingBgId(null);
    if (!f || !id) return;
    const dataUrl = await fileToDataUrl(f);
    // Обложка со Steam/Epic (backgroundUrl) не трогается — храним оба фона и
    // переключаемся между ними флагом useCustomBg (см. контекстное меню).
    const updated = await api.gamesUpdate(id, { backgroundDataUrl: dataUrl, useCustomBg: true });
    setItems((prev) => prev.map((g) => (g.id === updated.id ? updated : g)));
  };

  const toggleBgSource = async (g: GameEntry) => {
    const updated = await api.gamesUpdate(g.id, { useCustomBg: !g.useCustomBg });
    setItems((prev) => prev.map((x) => (x.id === updated.id ? updated : x)));
  };

  const deleteCustomBg = async (g: GameEntry) => {
    const updated = await api.gamesUpdate(g.id, { backgroundDataUrl: null, useCustomBg: false });
    setItems((prev) => prev.map((x) => (x.id === updated.id ? updated : x)));
  };

  const [findingSave, setFindingSave] = useState(false);
  const findSaveFor = async () => {
    if (!savesFor) return;
    setFindingSave(true);
    try {
      const r = await api.gamesSaveFindPath(savesFor.id);
      if (r.found && r.entry) {
        setSavesFor(r.entry);
        setItems((prev) => prev.map((g) => (g.id === r.entry!.id ? r.entry! : g)));
      }
    } finally {
      setFindingSave(false);
    }
  };

  return (
    <div className="page">
      <SectionHead
        eyebrow={t("games.eyebrow")}
        title={t("games.title")}
        action={
          <div style={{ display: "flex", gap: 8 }}>
            <Btn icon={scanning ? RefreshCw : Gamepad2} onClick={() => void doScan()} disabled={scanning}>
              {scanning ? t("games.scanning") : t("games.autoScan")}
            </Btn>
            <Btn variant="primary" icon={Plus} onClick={() => setShowForm(true)}>
              {t("games.add")}
            </Btn>
          </div>
        }
      />

      <div className="page-scroll-body">
      {scanMsg && <div className="muted-sm">{scanMsg}</div>}
      {launchError && (
        <Glass className="source-placeholder" style={{ borderColor: "var(--coral)" }}>
          <AlertTriangle size={16} style={{ color: "var(--coral)" }} />
          <span>{launchError}</span>
        </Glass>
      )}

      {showForm && (
        <Glass className="media-preview" style={{ flexDirection: "column", alignItems: "stretch", gap: 8 }}>
          <input
            className="text-input"
            placeholder={t("games.fName")}
            value={form.name}
            onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
          />
          <div style={{ display: "flex", gap: 8 }}>
            <input
              className="text-input"
              style={{ flex: 1 }}
              placeholder={t("games.fExePath")}
              value={form.exePath}
              onChange={(e) => setForm((f) => ({ ...f, exePath: e.target.value }))}
            />
            <Btn
              icon={FolderOpen}
              onClick={async () => {
                const r = await window.appBridge?.pickFile?.({
                  filters: [{ name: t("automation.filterExe"), extensions: ["exe"] }],
                });
                if (r?.ok && r.path) setForm((f) => ({ ...f, exePath: r.path! }));
              }}
            >
              {t("automation.browse")}
            </Btn>
          </div>
          <textarea
            className="text-input"
            rows={2}
            placeholder={t("games.fDescription")}
            value={form.description}
            onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
          />
          <div style={{ display: "flex", gap: 8 }}>
            <input
              className="text-input"
              style={{ flex: 1 }}
              placeholder={t("games.fSavePath")}
              value={form.savePath}
              onChange={(e) => setForm((f) => ({ ...f, savePath: e.target.value }))}
            />
            <Btn
              icon={FolderOpen}
              onClick={async () => {
                const r = await window.appBridge?.pickFolder?.();
                if (r?.ok && r.path) setForm((f) => ({ ...f, savePath: r.path! }));
              }}
            >
              {t("automation.browse")}
            </Btn>
          </div>
          <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
            <label className="muted-sm" style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer" }}>
              <ImagePlus size={14} />
              {t("games.fBackground")}
              <input
                type="file"
                accept="image/*"
                hidden
                onChange={async (e) => {
                  const f = e.target.files?.[0];
                  if (!f) return;
                  const dataUrl = await fileToDataUrl(f);
                  setForm((s) => ({ ...s, backgroundDataUrl: dataUrl }));
                }}
              />
            </label>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <Btn
              variant="primary"
              icon={Save}
              disabled={saving || !form.name.trim() || !form.exePath.trim()}
              onClick={() => void save()}
            >
              {t("games.save")}
            </Btn>
            <Btn icon={X} onClick={() => setShowForm(false)}>
              {t("ctx.clear")}
            </Btn>
          </div>
        </Glass>
      )}

      {loading && <div className="muted-sm">{t("passwordVault.loading")}</div>}
      {!loading && items.length === 0 && !showForm && (
        <EmptyHint icon={Gamepad2} text={t("games.empty")} />
      )}

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))",
          gap: 14,
          marginTop: 10,
        }}
      >
        {items.map((g) => (
          <div
            key={g.id}
            onClick={() => void doLaunch(g)}
            onContextMenu={(e) =>
              menu.open(e, [
                { label: t("games.launch"), icon: Play, onClick: () => void doLaunch(g) },
                {
                  label: t("games.saveManager"),
                  icon: History,
                  onClick: () => void openSaves(g),
                },
                {
                  label: t("games.importBackground"),
                  icon: ImagePlus,
                  onClick: () => importBackground(g),
                },
                ...(g.backgroundDataUrl && g.backgroundUrl
                  ? [
                      {
                        label: g.useCustomBg
                          ? t("games.useStoreBg")
                          : t("games.useCustomBg"),
                        icon: Images,
                        onClick: () => void toggleBgSource(g),
                      },
                    ]
                  : []),
                ...(g.backgroundDataUrl
                  ? [
                      {
                        label: t("games.deleteCustomBg"),
                        icon: ImageOff,
                        onClick: () => void deleteCustomBg(g),
                      },
                    ]
                  : []),
                { separator: true },
                { label: t("ctx.remove"), icon: Trash2, danger: true, onClick: () => void remove(g.id) },
              ])
            }
            style={{
              borderRadius: 14,
              overflow: "hidden",
              cursor: "pointer",
              position: "relative",
              height: 140,
              border: "1px solid var(--glass-border)",
              // useCustomBg переключает между своим фоном и обложкой Steam/Epic,
              // когда есть оба (см. контекстное меню); иначе — что есть.
              backgroundImage: (g.useCustomBg && g.backgroundDataUrl) || (!g.backgroundUrl && g.backgroundDataUrl)
                ? `url(${g.backgroundDataUrl})`
                : g.backgroundUrl
                  ? `url(${g.backgroundUrl})`
                  : fallbackGradient(g.name),
              backgroundSize: "cover",
              backgroundPosition: "center",
              display: "flex",
              flexDirection: "column",
              justifyContent: "flex-end",
            }}
          >
            <div
              style={{
                position: "absolute",
                inset: 0,
                background: "linear-gradient(to top, rgba(0,0,0,0.75), rgba(0,0,0,0.05))",
              }}
            />
            <div style={{ position: "relative", padding: 10, display: "flex", alignItems: "center", gap: 8 }}>
              {g.iconDataUrl ? (
                <img
                  src={g.iconDataUrl}
                  alt=""
                  style={{ width: 28, height: 28, borderRadius: 6, objectFit: "cover" }}
                />
              ) : (
                <Gamepad2 size={20} color="#fff" />
              )}
              <div style={{ minWidth: 0 }}>
                <div style={{ color: "#fff", fontWeight: 600, fontSize: 13 }} title={g.name}>
                  {g.name}
                </div>
                {g.source !== "manual" && (
                  <Badge tone="neutral" mono>
                    {g.source}
                  </Badge>
                )}
              </div>
            </div>
          </div>
        ))}
      </div>
      </div>

      <input
        type="file"
        accept="image/*"
        hidden
        ref={bgFileInputRef}
        onChange={(e) => void onBgFileChosen(e)}
      />

      {/* Менеджер сохранений — модалка поверх страницы, простая, без порталов (страница не скроллит под ней). */}
      {savesFor && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.5)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 50,
          }}
          onClick={() => setSavesFor(null)}
        >
          <Glass
            className="glass-solid"
            style={{
              display: "flex",
              width: 420,
              maxHeight: "70vh",
              padding: 16,
              flexDirection: "column",
              gap: 14,
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                marginBottom: 4,
              }}
            >
              <div className="media-title">{t("games.saveManagerFor", { name: savesFor.name })}</div>
              <button type="button" className="icon-btn" onClick={() => setSavesFor(null)}>
                <X size={16} />
              </button>
            </div>
            {savesFor.savePath ? (
              <>
                <div className="muted-sm" style={{ wordBreak: "break-all" }}>
                  {savesFor.savePath}
                </div>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  <Btn icon={Save} disabled={savesBusy} onClick={() => void doBackup()}>
                    {t("games.backupNow")}
                  </Btn>
                  <Btn icon={FolderOpen} disabled={savesBusy} onClick={() => void setSavePathFor()}>
                    {t("games.changePath")}
                  </Btn>
                  <Btn icon={findingSave ? RefreshCw : Search} disabled={findingSave} onClick={() => void findSaveFor()}>
                    {t("games.findSavePath")}
                  </Btn>
                </div>
              </>
            ) : (
              <Glass className="source-placeholder" style={{ flexDirection: "column", gap: 8 }}>
                <span className="muted-sm">{t("games.noSavePathHint")}</span>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  <Btn icon={findingSave ? RefreshCw : Search} disabled={findingSave} onClick={() => void findSaveFor()}>
                    {findingSave ? t("games.findingSavePath") : t("games.findSavePath")}
                  </Btn>
                  <Btn icon={FolderOpen} onClick={() => void setSavePathFor()}>
                    {t("automation.browse")}
                  </Btn>
                </div>
              </Glass>
            )}
            <div style={{ overflow: "auto", flex: 1 }}>
              {savesFor.savePath && versions.length === 0 && (
                <div className="muted-sm">{t("games.noVersions")}</div>
              )}
              {versions.map((v) => (
                <div
                  key={v.file}
                  style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "6px 0" }}
                >
                  <span className="muted-sm">
                    {new Date(v.createdAt).toLocaleString()} · {fmtSize(v.size)}
                  </span>
                  <Btn disabled={savesBusy} onClick={() => void doRestore(v.file)}>
                    {t("games.restore")}
                  </Btn>
                </div>
              ))}
            </div>
          </Glass>
        </div>
      )}
    </div>
  );
}
