import { useCallback, useEffect, useMemo, useState } from "react";
import { ChevronDown, ChevronRight, RefreshCw, Trash2, Undo2 } from "lucide-react";
import { Glass, Btn, Badge, Select } from "@/components/ui";
import { useI18n } from "@/app/i18n";
import { api } from "@/api/client";
import type { StartupEntry, StartupTrashItem } from "@/api/client";
import { describeResult, fmtDate } from "@/pages/tuning/parts/tuningShared";
import type { TuningCtx } from "@/pages/tuning/parts/tuningShared";

const KIND_ORDER = [
  "run",
  "folder",
  "runonce",
  "policy",
  "legacy",
  "task",
  "service",
  "winlogon",
  "ifeo",
  "appinit",
  "bootexec",
  "activesetup",
];

/** Подозрительные признаки — оранжево, остальные («нет подписи», «из temp») — тоже, но критичные — красным. */
const FLAG_TONE: Record<string, string> = {
  badsig: "coral",
  encoded: "coral",
  injection: "coral",
  modified: "coral",
  tempPath: "coral",
};

const SVC_MODES = ["svc-auto", "svc-delayed", "svc-manual", "svc-disabled"];

const shortName = (e: StartupEntry): string =>
  e.kind === "task" ? e.name.slice(e.name.lastIndexOf("\\") + 1) : e.title || e.name;

/** Менеджер автозапуска: обычный и скрытый (задачи, службы, Winlogon, IFEO, AppInit…). */
export default function StartupManager({ ctx }: { ctx: TuningCtx }) {
  const { t } = useI18n();
  const [items, setItems] = useState<StartupEntry[] | null>(null);
  const [trash, setTrash] = useState<StartupTrashItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState("");
  const [open, setOpen] = useState("");
  const [q, setQ] = useState("");
  const [kind, setKind] = useState("");
  const [onlyOn, setOnlyOn] = useState(false);
  const [hideMs, setHideMs] = useState(true);
  const [onlyHidden, setOnlyHidden] = useState(false);
  const [onlyFlagged, setOnlyFlagged] = useState(false);

  const loadTrash = useCallback(async () => {
    try {
      setTrash(await api.tuningStartupTrash());
    } catch {
      /* корзина не критична */
    }
  }, []);

  const scan = useCallback(async () => {
    setLoading(true);
    try {
      setItems(await api.tuningStartup());
    } catch (e) {
      ctx.notify((e as Error).message, false);
    } finally {
      setLoading(false);
    }
    void loadTrash();
  }, [ctx, loadTrash]);

  useEffect(() => {
    void scan();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const patch = (id: string, fn: (e: StartupEntry) => StartupEntry | null) =>
    setItems((cur) =>
      cur ? cur.flatMap((e) => (e.id === id ? (fn(e) ? [fn(e) as StartupEntry] : []) : [e])) : cur,
    );

  const act = async (e: StartupEntry, action: string) => {
    if (action === "delete" && !window.confirm(t("tuning.su.confirmDelete", { name: shortName(e) })))
      return;
    if (action === "reset" && !window.confirm(t("tuning.su.confirmReset", { name: e.name }))) return;
    setBusy(e.id);
    try {
      const r = await api.tuningStartupAction(e.id, action);
      const d = describeResult(r, t, t("tuning.su.done"));
      ctx.notify(d.text, d.ok);
      if (!d.ok) return;
      if (action === "enable" || action === "disable") {
        patch(e.id, (x) => ({ ...x, enabled: action === "enable" }));
      } else if (action.startsWith("svc-")) {
        patch(e.id, (x) => ({
          ...x,
          enabled: action !== "svc-disabled" && action !== "svc-manual",
          delayed: action === "svc-delayed",
        }));
      } else if (action === "delete") {
        patch(e.id, () => null);
        void loadTrash();
      } else if (action === "reset") void scan();
    } catch (err) {
      ctx.notify((err as Error).message, false);
    } finally {
      setBusy("");
    }
  };

  const restore = async (it: StartupTrashItem) => {
    setBusy(it.id);
    try {
      const r = await api.tuningStartupRestore(it.id);
      const d = describeResult(r, t, t("tuning.su.restored"));
      ctx.notify(d.text, d.ok);
      if (d.ok) void scan();
    } catch (err) {
      ctx.notify((err as Error).message, false);
    } finally {
      setBusy("");
    }
  };

  const drop = async (it: StartupTrashItem) => {
    await api.tuningStartupDrop(it.id);
    void loadTrash();
  };

  const kinds = useMemo(
    () => KIND_ORDER.filter((k) => items?.some((e) => e.kind === k)),
    [items],
  );

  const list = useMemo(() => {
    if (!items) return [];
    const s = q.trim().toLowerCase();
    return items
      .filter((e) => {
        if (kind && e.kind !== kind) return false;
        if (onlyOn && !e.enabled) return false;
        if (hideMs && e.ms && !e.flags.length) return false;
        if (onlyHidden && !e.hidden) return false;
        if (onlyFlagged && !e.flags.length) return false;
        if (!s) return true;
        return [e.name, e.title, e.cmd, e.path, e.company, e.signer, e.desc].some((v) =>
          v.toLowerCase().includes(s),
        );
      })
      .sort(
        (a, b) =>
          KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) ||
          shortName(a).localeCompare(shortName(b)),
      );
  }, [items, q, kind, onlyOn, hideMs, onlyHidden, onlyFlagged]);

  const stat = items
    ? {
        total: items.length,
        on: items.filter((e) => e.enabled).length,
        hidden: items.filter((e) => e.hidden).length,
        flagged: items.filter((e) => e.flags.length).length,
      }
    : null;

  return (
    <Glass style={{ padding: 14, marginTop: 12 }}>
      <div className="tn-sub">
        <b className="tn-card-title">{t("tuning.su.title")}</b>
        <Btn icon={RefreshCw} onClick={() => void scan()} disabled={loading}>
          {loading ? t("tuning.su.scanning") : t("tuning.su.scan")}
        </Btn>
      </div>
      <div className="muted-sm">{t("tuning.su.hint")}</div>
      {!ctx.ov.admin && <div className="muted-sm">{t("tuning.su.adminNote")}</div>}

      {stat && (
        <div className="tn-su-stats">
          {(["total", "on", "hidden", "flagged"] as const).map((k) => (
            <Badge key={k} tone={k === "flagged" && stat[k] ? "coral" : "neutral"}>
              {stat[k]} {t(`tuning.su.stat.${k}`)}
            </Badge>
          ))}
        </div>
      )}

      <div className="tn-su-filters">
        <input
          className="text-input"
          placeholder={t("tuning.su.search")}
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <Select
          value={kind}
          onChange={(e) => setKind(e.target.value)}
          options={[
            { value: "", label: t("tuning.su.allKinds") },
            ...kinds.map((k) => ({ value: k, label: t(`tuning.su.kind.${k}`) })),
          ]}
        />
      </div>
      <div className="tn-su-chips">
        <Badge active={onlyOn} onClick={() => setOnlyOn(!onlyOn)} tone="amber">
          {t("tuning.su.onlyOn")}
        </Badge>
        <Badge active={hideMs} onClick={() => setHideMs(!hideMs)} tone="amber">
          {t("tuning.su.hideMs")}
        </Badge>
        <Badge active={onlyHidden} onClick={() => setOnlyHidden(!onlyHidden)} tone="violet">
          {t("tuning.su.onlyHidden")}
        </Badge>
        <Badge active={onlyFlagged} onClick={() => setOnlyFlagged(!onlyFlagged)} tone="coral">
          {t("tuning.su.onlyFlagged")}
        </Badge>
      </div>

      {items && (
        <div className="muted-sm" style={{ margin: "6px 0" }}>
          {t("tuning.su.shown", { n: list.length, total: items.length })}
        </div>
      )}

      <div className="tn-list">
        {list.map((e) => {
          const isOpen = open === e.id;
          const toggle = e.can.includes("toggle");
          const dis = busy === e.id;
          return (
            <div key={e.id} className={`tn-su-item ${e.enabled ? "" : "is-off"}`}>
              <div className="tn-row">
                <button
                  type="button"
                  className="tn-su-exp"
                  aria-label={isOpen ? t("tuning.su.act.close") : t("tuning.su.act.details")}
                  onClick={() => setOpen(isOpen ? "" : e.id)}
                >
                  {isOpen ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
                </button>
                <div className="tn-row-main">
                  <div className="tn-row-title">
                    {shortName(e)}
                    {e.running && <span className="tn-su-run"> ● {t("tuning.su.running")}</span>}
                  </div>
                  <div className="muted-sm tn-su-line">
                    {e.company || e.signer || e.path || e.cmd || "—"}
                  </div>
                  <div className="tn-su-badges">
                    <Badge tone="neutral">{t(`tuning.su.kind.${e.kind}`)}</Badge>
                    {e.hidden && <Badge tone="violet">{t("tuning.su.hiddenBadge")}</Badge>}
                    {e.flags.map((f) => (
                      <Badge key={f} tone={FLAG_TONE[f] ?? "amber"}>
                        {t(`tuning.su.flag.${f}`)}
                      </Badge>
                    ))}
                  </div>
                </div>
                {toggle ? (
                  <button
                    type="button"
                    role="switch"
                    aria-checked={e.enabled}
                    aria-label={shortName(e)}
                    className={`tn-switch ${e.enabled ? "on" : ""}`}
                    disabled={dis}
                    onClick={() => void act(e, e.enabled ? "disable" : "enable")}
                  />
                ) : (
                  <Badge tone={e.enabled ? "teal" : "neutral"}>
                    {e.enabled ? t("tuning.su.act.enable") : t("tuning.su.act.disable")}
                  </Badge>
                )}
              </div>

              {isOpen && (
                <div className="tn-su-detail">
                  <div className="muted-sm">{t(`tuning.su.kindHint.${e.kind}`)}</div>
                  <dl className="tn-su-dl">
                    <dt>{t("tuning.su.field.command")}</dt>
                    <dd>{e.cmd || "—"}</dd>
                    {e.path && (
                      <>
                        <dt>{t("tuning.su.field.file")}</dt>
                        <dd>{e.path}</dd>
                      </>
                    )}
                    {e.company && (
                      <>
                        <dt>{t("tuning.su.field.company")}</dt>
                        <dd>{e.company}</dd>
                      </>
                    )}
                    {e.desc && (
                      <>
                        <dt>{t("tuning.su.field.desc")}</dt>
                        <dd>{e.desc}</dd>
                      </>
                    )}
                    {e.sig && (
                      <>
                        <dt>{t("tuning.su.field.sig")}</dt>
                        <dd>
                          {t(`tuning.su.sig.${e.sig}`)}
                          {e.signer && e.sig !== "System" ? ` · ${e.signer}` : ""}
                        </dd>
                      </>
                    )}
                    {e.trig && (
                      <>
                        <dt>{t("tuning.su.field.triggers")}</dt>
                        <dd>
                          {e.trig
                            .split(",")
                            .map((x) => t(`tuning.su.trig.${x}`))
                            .join(", ")}
                        </dd>
                      </>
                    )}
                    {e.acct && e.kind !== "folder" && (
                      <>
                        <dt>{t("tuning.su.field.account")}</dt>
                        <dd>{e.acct}</dd>
                      </>
                    )}
                    {e.kind === "folder" && e.acct && (
                      <>
                        <dt>{t("tuning.su.field.folderFile")}</dt>
                        <dd>{e.acct}</dd>
                      </>
                    )}
                    <dt>{t("tuning.su.field.scope")}</dt>
                    <dd>{t(`tuning.su.scope.${e.scope}`)}</dd>
                    <dt>{t("tuning.su.field.location")}</dt>
                    <dd>{e.id}</dd>
                  </dl>
                  <div className="tn-su-actions">
                    {e.can.includes("svc") && (
                      <Select
                        value={
                          !e.enabled ? "svc-disabled" : e.delayed ? "svc-delayed" : "svc-auto"
                        }
                        onChange={(ev) => void act(e, ev.target.value)}
                        options={SVC_MODES.map((m) => ({
                          value: m,
                          label: t(`tuning.su.act.${m}`),
                        }))}
                      />
                    )}
                    {e.can.includes("reset") && (
                      <Btn onClick={() => void act(e, "reset")} disabled={dis}>
                        {t("tuning.su.act.reset")}
                      </Btn>
                    )}
                    {e.can.includes("reveal") && (
                      <Btn onClick={() => void act(e, "reveal")} disabled={dis}>
                        {t("tuning.su.act.reveal")}
                      </Btn>
                    )}
                    {e.can.includes("regedit") && (
                      <Btn onClick={() => void act(e, "regedit")} disabled={dis}>
                        {t("tuning.su.act.regedit")}
                      </Btn>
                    )}
                    {e.can.includes("delete") && (
                      <Btn icon={Trash2} onClick={() => void act(e, "delete")} disabled={dis}>
                        {t("tuning.su.act.delete")}
                      </Btn>
                    )}
                  </div>
                </div>
              )}
            </div>
          );
        })}
        {items && !list.length && <div className="muted-sm">{t("tuning.su.empty")}</div>}
      </div>

      <div style={{ marginTop: 14 }}>
        <b className="tn-card-title">{t("tuning.su.trash")}</b>
        {!trash.length && <div className="muted-sm">{t("tuning.su.trashEmpty")}</div>}
        {trash.map((it) => (
          <div key={it.id} className="tn-row">
            <div className="tn-row-main">
              <div className="tn-row-title">{it.name}</div>
              <div className="muted-sm tn-su-line">
                {t(`tuning.su.kind.${it.kind}`)} · {t("tuning.su.trashAt", { when: fmtDate(it.at) })}
              </div>
            </div>
            <Btn icon={Undo2} onClick={() => void restore(it)} disabled={busy === it.id}>
              {t("tuning.su.trashRestore")}
            </Btn>
            <Btn icon={Trash2} onClick={() => void drop(it)} disabled={busy === it.id}>
              {t("tuning.su.trashDrop")}
            </Btn>
          </div>
        ))}
      </div>
    </Glass>
  );
}
