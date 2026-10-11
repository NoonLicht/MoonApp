import { Icon } from "@/pages/myspace/m3e/components/M3Node";
import { t } from "@/pages/myspace/m3e/lib/i18n";
import type { Palette } from "@/pages/myspace/m3e/lib/tokens";
import type { Lang } from "@/pages/myspace/m3e/lib/i18n";

export interface EditAccessDialogProps {
  p: Palette;
  lang: Lang;
}

export default function EditAccessDialog({ p, lang }: EditAccessDialogProps) {
  return (
    <div
                  role="dialog"
                  aria-modal="true"
                  aria-labelledby="edit-access-title"
                  style={{
                    position: "fixed",
                    inset: 0,
                    zIndex: 100,
                    display: "grid",
                    placeItems: "center",
                    padding: 24,
                    background: "rgba(0,0,0,0.32)",
                  }}
                >
                  <div
                    style={{
                      width: "min(420px, 100%)",
                      padding: 24,
                      borderRadius: 28,
                      background: p.surfaceContainerHigh,
                      color: p.onSurface,
                      boxShadow: "0 12px 40px rgba(0,0,0,0.22)",
                    }}
                  >
                    <Icon name="lock" size={28} />
                    <h1
                      id="edit-access-title"
                      style={{ margin: "16px 0 8px", fontSize: 22, lineHeight: 1.25 }}
                    >
                      {t("readOnlyTitle", lang)}
                    </h1>
                    <p style={{ margin: 0, color: p.onSurfaceVariant, fontSize: 14, lineHeight: 1.5 }}>
                      {t("readOnlyBody", lang)}
                    </p>
                    <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 24 }}>
                      <button
                        autoFocus
                        className="m3-press"
                        onClick={() => window.location.reload()}
                        style={{
                          minHeight: 40,
                          padding: "0 20px",
                          border: "none",
                          borderRadius: 20,
                          background: p.primary,
                          color: p.onPrimary,
                          fontSize: 14,
                          fontWeight: 700,
                          cursor: "pointer",
                        }}
                      >
                        {t("reload", lang)}
                      </button>
                    </div>
                  </div>
                </div>
  );
}
