import { AlertTriangle, Flame, RefreshCw, ShieldAlert } from "lucide-react";
import { Glass, Btn, Badge } from "@/components/ui";
import { useI18n } from "@/app/i18n";
import type { PrivacyCategory } from "@/api/client";
import { fmtDate } from "@/pages/tuning/parts/tuningShared";
import { fmtBytes } from "@/pages/tuning/parts/usePrivacy";
import type { UsePrivacy } from "@/pages/tuning/parts/usePrivacy";

const CATEGORIES: PrivacyCategory[] = [
  "history",
  "recent",
  "cache",
  "clipboard",
  "network",
  "browser",
  "usb",
  "logs",
];
const RISK_TONE = ["teal", "amber", "coral"] as const;

/**
 * Зачистка цифровых следов в уже работающей системе: история команд, недавние
 * файлы, кэши, буфер обмена, DNS, история USB-устройств и системные логи.
 * НЕ стирает документы и НЕ затрагивает содержимое диска — только служебные
 * следы использования. Идея — valleyofdoom/nyx, реализация своя.
 *
 * Выбор пунктов и кнопка зачистки живут в TuningPage (см. usePrivacy) —
 * закреплённая панель внизу, как у вкладок с твиками; здесь только список.
 */
export default function PrivacyTab({ p }: { p: UsePrivacy }) {
  const { t } = useI18n();
  const { ov, sel, busy, lastResults, toggle, panic } = p;

  if (!ov) return <div className="muted-sm">{t("tuning.loading")}</div>;
  if (ov.items.length === 0) return <div className="muted-sm">{t("privacy.unsupported")}</div>;

  return (
    <div>
      <Glass style={{ padding: 14 }}>
        <div className="tn-sub">
          <b className="tn-card-title">
            <Flame size={14} /> {t("privacy.panicTitle")}
          </b>
          <Btn icon={RefreshCw} onClick={() => void p.reload()}>
            {t("tuning.refresh")}
          </Btn>
        </div>
        <div className="muted-sm">{t("privacy.panicHint")}</div>
        <Btn
          variant="primary"
          icon={Flame}
          disabled={busy}
          onClick={() => void panic()}
          style={{ marginTop: 10 }}
        >
          {busy ? t("tuning.working") : t("privacy.panicButton")}
        </Btn>
        {!ov.admin && (
          <div className="tn-note" style={{ marginTop: 10 }}>
            <ShieldAlert size={14} /> {t("privacy.adminNote")}
          </div>
        )}
      </Glass>

      <Glass style={{ padding: 14, marginTop: 12 }}>
        <div className="tn-sub">
          <b className="tn-card-title">{t("privacy.selectTitle")}</b>
        </div>
        <div className="muted-sm">{t("privacy.selectHint")}</div>
        {CATEGORIES.map((cat) => {
          const items = ov.items.filter((i) => i.category === cat);
          if (!items.length) return null;
          return (
            <div key={cat} style={{ marginTop: 10 }}>
              <div className="muted-sm" style={{ marginBottom: 4 }}>
                {t(`privacy.cat.${cat}`)}
              </div>
              {items.map((it) => {
                const res = lastResults?.[it.id];
                // Чекбокс не блокируем даже без прав администратора: пользователь должен
                // суметь выбрать пункт и увидеть понятную причину отказа после попытки
                // зачистки («admin_required»), а не упираться в немую недоступность.
                const needsAdmin = it.admin && !ov.admin;
                const checked = sel.has(it.id);
                return (
                  <div key={it.id} className="tn-row">
                    <div className="tn-row-main">
                      <div className="tn-row-title">{t(`privacy.it.${it.id}.t`)}</div>
                      <div className="muted-sm">{t(`privacy.it.${it.id}.d`)}</div>
                      {res && (
                        <div className={`muted-sm ${res.ok ? "" : "tn-fail"}`}>
                          {res.ok
                            ? t("privacy.itemDone", { n: res.removed })
                            : `${t("tuning.error")}: ${res.error === "admin_required" ? t("privacy.adminNote") : res.error}`}
                        </div>
                      )}
                    </div>
                    <div className="tn-row-badges">
                      {needsAdmin && (
                        <span title={t("privacy.adminNote")}>
                          <AlertTriangle size={14} />
                        </span>
                      )}
                      <Badge tone={RISK_TONE[it.risk]}>{t(`tuning.risk${it.risk}`)}</Badge>
                    </div>
                    <button
                      type="button"
                      role="switch"
                      aria-checked={checked}
                      aria-label={t(`privacy.it.${it.id}.t`)}
                      className={`tn-switch ${checked ? "on" : ""}`}
                      onClick={() => toggle(it.id)}
                    />
                  </div>
                );
              })}
            </div>
          );
        })}
      </Glass>

      <Glass style={{ padding: 14, marginTop: 12 }}>
        <b className="tn-card-title">{t("privacy.historyTitle")}</b>
        {ov.history.length === 0 && <div className="muted-sm">{t("tuning.historyEmpty")}</div>}
        {ov.history.map((h, i) => (
          <div key={i} className="tn-row">
            <div className="tn-row-main">
              <div className="tn-row-title">
                {t("privacy.historyLine", {
                  n: h.ids.length,
                  removed: h.removed,
                  bytes: fmtBytes(h.bytes),
                })}
              </div>
              <div className="muted-sm">{fmtDate(h.at)}</div>
            </div>
            {h.failed.length > 0 && (
              <Badge tone="coral">{t("privacy.historyFailed", { n: h.failed.length })}</Badge>
            )}
          </div>
        ))}
      </Glass>
    </div>
  );
}
