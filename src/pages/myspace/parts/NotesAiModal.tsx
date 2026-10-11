import { X, AlertTriangle } from "lucide-react";
import type React from "react";
import type { TranslateFn } from "@/app/i18n";
import type { NotesAiConfig } from "@/api/types";

export interface NotesAiModalProps {
  setAiCfgOpen: React.Dispatch<React.SetStateAction<boolean>>;
  t: TranslateFn;
  aiCfg: NotesAiConfig | null;
  aiBusyCfg: "" | "models" | "save";
  saveAiCfg: (patch: { providerId?: string; model?: string; }) => Promise<NotesAiConfig | null>;
  aiCfgModels: string[];
  loadAiModels: (providerId: string) => Promise<void>;
  aiModels: string[] | null;
  modelChoices: string[];
  pickModelChoice: (model: string) => Promise<void>;
  aiCfgError: string;
}

export default function NotesAiModal({ setAiCfgOpen, t, aiCfg, aiBusyCfg, saveAiCfg, aiCfgModels, loadAiModels, aiModels, modelChoices, pickModelChoice, aiCfgError }: NotesAiModalProps) {
  return (
    <div className="ms-ai-overlay" onClick={() => setAiCfgOpen(false)}>
                <div
                  className="ms-ai-modal"
                  role="dialog"
                  aria-label={t("myspace.ai.cfg")}
                  onClick={(e) => e.stopPropagation()}
                >
                  <div className="ms-ai-modal-head">
                    <div className="field-label">{t("myspace.ai.cfg")}</div>
                    <button
                      className="ms-ai-modal-close"
                      onClick={() => setAiCfgOpen(false)}
                      aria-label={t("common.close")}
                      title={t("common.close")}
                    >
                      <X size={16} />
                    </button>
                  </div>
                  <div className="ms-ai-modal-body">
                    <label className="ms-ai-field">
                      <span className="field-label">{t("myspace.ai.provider")}</span>
                      <select
                        value={aiCfg?.providerFromChat ? "" : aiCfg?.providerId || ""}
                        disabled={aiBusyCfg === "save"}
                        onChange={(e) => void saveAiCfg({ providerId: e.target.value })}
                      >
                        <option value="">
                          {t("myspace.ai.providerChat", { provider: aiCfg?.chatProvider || "—" })}
                        </option>
                        {(aiCfg?.providers || []).map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.label}
                            {p.hasKey ? "" : ` — ${t("myspace.ai.noKey")}`}
                          </option>
                        ))}
                      </select>
                    </label>
    
                    <label className="ms-ai-field">
                      <span className="field-label">{t("myspace.ai.model")}</span>
                      <select
                        value={aiCfg?.model || ""}
                        disabled={aiBusyCfg === "save"}
                        onChange={(e) => void saveAiCfg({ model: e.target.value })}
                      >
                        <option value="">{t("myspace.ai.modelAuto")}</option>
                        {aiCfgModels.map((m) => (
                          <option key={m} value={m}>
                            {m}
                          </option>
                        ))}
                      </select>
                    </label>
    
                    <div className="ms-ai-modal-actions">
                      <button
                        type="button"
                        className="btn btn-ghost"
                        onClick={() => void loadAiModels(aiCfg?.providerId || "")}
                        disabled={aiBusyCfg === "models" || !aiCfg?.providerId}
                      >
                        {aiBusyCfg === "models"
                          ? t("myspace.ai.modelLoading")
                          : t("myspace.ai.modelRefresh")}
                      </button>
                      <span className="muted-sm">
                        {aiModels?.length
                          ? t("myspace.ai.modelFound", { count: aiModels.length })
                          : t("myspace.ai.modelHint")}
                      </span>
                    </div>
    
                    {/* Чипсы: имена моделей из текста ошибки сервиса — выбор в один клик. */}
                    {!!modelChoices.length && (
                      <div className="ms-ai-chips">
                        <span className="muted-sm">{t("myspace.ai.modelPick")}</span>
                        <div className="ms-ai-chips-row">
                          {modelChoices.map((m) => (
                            <button
                              key={m}
                              className="ms-ai-chip"
                              title={t("myspace.ai.modelUse", { model: m })}
                              onClick={() => void pickModelChoice(m)}
                            >
                              {m}
                            </button>
                          ))}
                        </div>
                      </div>
                    )}
    
                    {!!aiCfgError && <div className="ms-ai-modal-error">{aiCfgError}</div>}
                    {aiCfg && !aiCfg.hasKey && (
                      <div className="ms-ai-modal-warn">
                        <AlertTriangle size={12} />
                        <span>{t("myspace.ai.noKeyHint", { provider: aiCfg.providerId })}</span>
                      </div>
                    )}
                  </div>
                  <div className="ms-ai-modal-foot">
                    <span className="muted-sm">{t("myspace.ai.savedAuto")}</span>
                    <button className="btn btn-primary" onClick={() => setAiCfgOpen(false)}>
                      {t("common.close")}
                    </button>
                  </div>
                </div>
              </div>
  );
}
