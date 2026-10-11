import { FileText, PanelLeftClose, X, PanelLeftOpen, Sparkles, Sun, Moon, Settings2, RefreshCw, SlidersHorizontal, PanelRightOpen, PanelRightClose, Link2 } from "lucide-react";
import CodeMirrorLiveEditor from "@/pages/myspace/parts/CodeMirrorLiveEditor";
import type { VaultFile } from "@/api/types";
import { api } from "@/api/client";
import { useEffect, useState } from "react";
import type React from "react";
import {
  NOTE_FONTS,
  getNoteView,
  setNoteFont,
  subscribeNoteView,
  zoomNote,
} from "@/pages/myspace/parts/noteView";
import type { OFile, Side } from "@/pages/myspace/parts/MyspaceHelpers";
import type { TranslateFn } from "@/app/i18n";
import type { OcrImageRequest, PdfDropRequest } from "@/pages/myspace/parts/CodeMirrorLiveEditor";

export interface EditorAreaProps {
  setLeftOpen: React.Dispatch<React.SetStateAction<boolean>>;
  leftOpen: boolean;
  openFiles: OFile[];
  setActiveTab: React.Dispatch<React.SetStateAction<string | null>>;
  activeTab: string | null;
  closeTab: (p: string) => void;
  saving: boolean;
  aiBusy: "" | "format" | "regenerate";
  t: TranslateFn;
  activeFile: OFile | undefined;
  pickPos: React.MutableRefObject<number | null>;
  setPickerOpen: React.Dispatch<React.SetStateAction<boolean>>;
  runNotesAi: (mode: "format" | "regenerate") => Promise<void>;
  openAiCfg: () => Promise<void>;
  aiCfgOpen: boolean;
  cycleDocTheme: (p: string) => void;
  docThemes: Record<string, "light" | "dark">;
  setOcrDlg: React.Dispatch<React.SetStateAction<boolean>>;
  setRightOpen: React.Dispatch<React.SetStateAction<boolean>>;
  rightOpen: boolean;
  error: string;
  aiNotice: string;
  imageFileInputRef: React.RefObject<HTMLInputElement>;
  uploadAndInsertImage: (blob: Blob, filename: string) => Promise<void>;
  pdfJob: { name: string; done: number; total: number; ac: AbortController; } | null;
  attachError: string;
  edContent: string;
  updContent: (p: string, c: string) => void;
  msCfg: { autosave: boolean; spellcheck: boolean; };
  runOcr: (req: OcrImageRequest) => Promise<void>;
  runPdf: (req: PdfDropRequest) => Promise<void>;
  ocrBusy: string[];
  ocrLabels: { ocr: string; settings: string; busy: string; };
  tree: VaultFile[];
  openFile: (p: string) => Promise<void>;
  setLeftTab: React.Dispatch<React.SetStateAction<Side>>;
  setSq: React.Dispatch<React.SetStateAction<string>>;
  setAttachError: React.Dispatch<React.SetStateAction<string>>;
}

const noteViewBtn: React.CSSProperties = {
  background: "transparent",
  border: "none",
  padding: "3px 5px",
  borderRadius: 4,
  cursor: "pointer",
  color: "var(--text-tertiary)",
  fontSize: 11,
  fontWeight: 600,
};

export default function EditorArea({ setLeftOpen, leftOpen, openFiles, setActiveTab, activeTab, closeTab, saving, aiBusy, t, activeFile, pickPos, setPickerOpen, runNotesAi, openAiCfg, aiCfgOpen, cycleDocTheme, docThemes, setOcrDlg, setRightOpen, rightOpen, error, aiNotice, imageFileInputRef, uploadAndInsertImage, pdfJob, attachError, edContent, updContent, msCfg, runOcr, runPdf, ocrBusy, ocrLabels, tree, openFile, setLeftTab, setSq, setAttachError }: EditorAreaProps) {
  const [nv, setNv] = useState(getNoteView);
  useEffect(() => subscribeNoteView(setNv), []);
  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0 }}>
                <div
                  style={{
                    flex: 1,
                    display: "flex",
                    flexDirection: "column",
                    minHeight: 0,
                    margin: "4px 0",
                    background: "var(--surface-glass)",
                    border: "1px solid var(--glass-border)",
                    borderRadius: 12,
                    backdropFilter: "blur(8px)",
                    overflow: "hidden",
                  }}
                >
                  {/* Header - matches side panel headers for alignment */}
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      padding: "6px 8px",
                      borderBottom: "1px solid var(--glass-border)",
                      minHeight: 28,
                    }}
                  >
                    {/* Свернуть/развернуть левую панель — постоянная кнопка у левого
                        края шапки редактора, симметрично кнопке правой панели у
                        правого края (см. ниже, PanelRightOpen/Close). Раньше кнопка
                        появлялась только при свёрнутой панели и была абсолютно
                        спозиционирована (top: 60) без position: relative на предке —
                        из-за этого "улетала" при сворачивании. */}
                    <button
                      onClick={() => setLeftOpen(!leftOpen)}
                      title={leftOpen ? "Collapse sidebar" : "Expand sidebar"}
                      style={{
                        background: "transparent",
                        border: "none",
                        padding: 3,
                        cursor: "pointer",
                        color: "var(--text-tertiary)",
                        display: "flex",
                        marginRight: 4,
                        flexShrink: 0,
                      }}
                    >
                      {leftOpen ? <PanelLeftClose size={13} /> : <PanelLeftOpen size={13} />}
                    </button>
                    <div
                      style={{
                        flex: 1,
                        display: "flex",
                        overflow: "auto",
                        gap: 2,
                        alignItems: "center",
                      }}
                    >
                      {openFiles.map((f) => (
                        <div
                          key={f.path}
                          onClick={() => setActiveTab(f.path)}
                          style={{
                            display: "flex",
                            alignItems: "center",
                            gap: 4,
                            padding: "3px 8px",
                            borderRadius: "6px 6px 0 0",
                            fontSize: 12,
                            cursor: "pointer",
                            whiteSpace: "nowrap",
                            background: activeTab === f.path ? "var(--surface-glass)" : "transparent",
                            color:
                              activeTab === f.path ? "var(--text-primary)" : "var(--text-secondary)",
                            borderTop:
                              activeTab === f.path
                                ? "1px solid var(--glass-border)"
                                : "1px solid transparent",
                            borderLeft:
                              activeTab === f.path
                                ? "1px solid var(--glass-border)"
                                : "1px solid transparent",
                            borderRight:
                              activeTab === f.path
                                ? "1px solid var(--glass-border)"
                                : "1px solid transparent",
                            borderBottom: "none",
                            marginBottom: -0,
                          }}
                        >
                          <FileText size={11} />
                          <span>{f.name.replace(/\.md$/, "")}</span>
                          {f.modified && (
                            <span
                              style={{
                                width: 5,
                                height: 5,
                                borderRadius: "50%",
                                background: "var(--amber)",
                                display: "inline-block",
                              }}
                            />
                          )}
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              closeTab(f.path);
                            }}
                            style={{
                              background: "transparent",
                              border: "none",
                              padding: 1,
                              cursor: "pointer",
                              color: "var(--text-tertiary)",
                              display: "flex",
                              marginLeft: 2,
                            }}
                          >
                            <X size={9} />
                          </button>
                        </div>
                      ))}
                      {openFiles.length === 0 && (
                        <span style={{ fontSize: 12, color: "var(--text-tertiary)" }}>
                          No open files
                        </span>
                      )}
                    </div>
                    <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                      {saving && (
                        <span style={{ fontSize: 11, color: "var(--text-tertiary)" }}>saving...</span>
                      )}
                      {aiBusy && (
                        <span style={{ fontSize: 11, color: "var(--amber)" }}>
                          {t("myspace.ai.busy")}
                        </span>
                      )}
                      {activeFile && (
                        <>
                          {/* ИИ-оформление заметки: «Оформить» (Sparkles) — аккуратный
                              Markdown из текущего текста; «Регенерировать» (RefreshCw)
                              — заново из сохранённого исходника, полная замена. */}
                          <button
                            onClick={() => {
                              const ta = document.querySelector(
                                ".ms-edit-textarea",
                              ) as HTMLTextAreaElement | null;
                              pickPos.current = ta ? ta.selectionStart : null;
                              setPickerOpen(true);
                            }}
                            title={t("sem.insertLinkHint")}
                            aria-label={t("linkPicker.title")}
                            style={{
                              background: "transparent",
                              border: "none",
                              padding: 3,
                              cursor: "pointer",
                              color: "var(--text-tertiary)",
                              display: "flex",
                            }}
                          >
                            <Link2 size={13} />
                          </button>
                          <button
                            onClick={() => runNotesAi("format")}
                            disabled={!!aiBusy}
                            title={t("myspace.ai.formatHint")}
                            aria-label={t("myspace.ai.format")}
                            style={{
                              background: "transparent",
                              border: "none",
                              padding: 3,
                              cursor: aiBusy ? "default" : "pointer",
                              color: aiBusy === "format" ? "var(--amber)" : "var(--text-tertiary)",
                              opacity: aiBusy && aiBusy !== "format" ? 0.4 : 1,
                              display: "flex",
                            }}
                          >
                            <Sparkles size={13} />
                          </button>
                          <button
                            onClick={() => runNotesAi("regenerate")}
                            disabled={!!aiBusy}
                            title={t("myspace.ai.regenerateHint")}
                            aria-label={t("myspace.ai.regenerate")}
                            style={{
                              background: "transparent",
                              border: "none",
                              padding: 3,
                              cursor: aiBusy ? "default" : "pointer",
                              color: aiBusy === "regenerate" ? "var(--amber)" : "var(--text-tertiary)",
                              opacity: aiBusy && aiBusy !== "regenerate" ? 0.4 : 1,
                              display: "flex",
                            }}
                          >
                            <RefreshCw size={13} />
                          </button>
                          {/* Выбор провайдера и модели: раньше брался из настроек чата,
                              и опечатка в имени модели всплывала сырым JSON сервиса.
                              Выбор сохраняется (myspace.ai.*) — повторять не нужно. */}
                          <button
                            onClick={() => void openAiCfg()}
                            title={t("myspace.ai.cfgHint")}
                            aria-label={t("myspace.ai.cfg")}
                            style={{
                              background: aiCfgOpen ? "var(--track)" : "transparent",
                              border: "none",
                              padding: 3,
                              cursor: "pointer",
                              color: aiCfgOpen ? "var(--amber)" : "var(--text-tertiary)",
                              display: "flex",
                            }}
                          >
                            <SlidersHorizontal size={13} />
                          </button>
                        </>
                      )}
                      {activeTab && (
                        <>
                          <select
                            value={nv.font}
                            onChange={(e) => setNoteFont(e.target.value)}
                            title={t("myspace.fontTitle")}
                            aria-label={t("myspace.fontTitle")}
                            style={{
                              background: "var(--track)",
                              color: "var(--text-secondary)",
                              border: "1px solid var(--glass-border)",
                              borderRadius: 6,
                              fontSize: 11,
                              padding: "2px 4px",
                              maxWidth: 110,
                            }}
                          >
                            {NOTE_FONTS.map((f) => (
                              <option key={f.id} value={f.id}>
                                {f.label}
                              </option>
                            ))}
                          </select>
                          <button
                            onClick={() => zoomNote(-1)}
                            title={`${t("myspace.zoomOut")} (Ctrl −)`}
                            style={noteViewBtn}
                          >
                            A−
                          </button>
                          <button
                            onClick={() => zoomNote(0)}
                            title={`${t("myspace.zoomReset")} (Ctrl 0)`}
                            style={{ ...noteViewBtn, minWidth: 38 }}
                          >
                            {Math.round(nv.scale * 100)}%
                          </button>
                          <button
                            onClick={() => zoomNote(1)}
                            title={`${t("myspace.zoomIn")} (Ctrl +)`}
                            style={noteViewBtn}
                          >
                            A+
                          </button>
                        </>
                      )}
                      {activeTab && (
                        <button
                          onClick={() => cycleDocTheme(activeTab)}
                          title={
                            docThemes[activeTab] === "light"
                              ? t("sem.docThemeLight")
                              : docThemes[activeTab] === "dark"
                                ? t("sem.docThemeDark")
                                : t("sem.docThemeAuto")
                          }
                          style={{
                            background: docThemes[activeTab] ? "var(--track)" : "transparent",
                            border: "none",
                            padding: "3px 5px",
                            borderRadius: 4,
                            cursor: "pointer",
                            color: docThemes[activeTab] ? "var(--amber)" : "var(--text-tertiary)",
                            display: "flex",
                          }}
                        >
                          {docThemes[activeTab] === "dark" ? <Moon size={12} /> : <Sun size={12} />}
                        </button>
                      )}
                      {activeTab && (
                        <button
                          onClick={() => setOcrDlg(true)}
                          title={t("myspace.ocr.settings")}
                          style={{
                            background: "transparent",
                            border: "none",
                            padding: "3px 5px",
                            borderRadius: 4,
                            cursor: "pointer",
                            color: "var(--text-tertiary)",
                            display: "flex",
                          }}
                        >
                          <Settings2 size={12} />
                        </button>
                      )}
                      <button
                        onClick={() => setRightOpen(!rightOpen)}
                        style={{
                          background: "transparent",
                          border: "none",
                          padding: 3,
                          cursor: "pointer",
                          color: "var(--text-tertiary)",
                        }}
                      >
                        {rightOpen ? <PanelRightClose size={13} /> : <PanelRightOpen size={13} />}
                      </button>
                    </div>
                  </div>
                  {/* Editor with live preview & scroll sync */}
                  <div style={{ flex: 1, display: "flex", flexDirection: "column", minHeight: 0 }}>
                    {error && (
                      <div
                        style={{
                          padding: "4px 12px",
                          fontSize: 12,
                          color: "var(--coral)",
                          background: "var(--coral-soft)",
                          borderBottom: "1px solid var(--glass-border)",
                        }}
                      >
                        {error}
                      </div>
                    )}
                    {aiNotice && !error && (
                      <div
                        style={{
                          padding: "4px 12px",
                          fontSize: 12,
                          color: "var(--amber)",
                          background: "var(--amber-soft)",
                          borderBottom: "1px solid var(--glass-border)",
                        }}
                      >
                        {aiNotice}
                      </div>
                    )}
                    <input
                      ref={imageFileInputRef}
                      type="file"
                      accept="image/*"
                      hidden
                      onChange={(e) => {
                        const f = e.target.files?.[0];
                        e.target.value = "";
                        if (f) void uploadAndInsertImage(f, f.name);
                      }}
                    />
                    {pdfJob && (
                      <div
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 10,
                          padding: "4px 12px",
                          fontSize: 12,
                          color: "var(--text-secondary)",
                          background: "var(--amber-soft)",
                          borderBottom: "1px solid var(--glass-border)",
                        }}
                      >
                        <span style={{ flex: 1 }}>
                          {t("myspace.ocr.pdfProgress", {
                            name: pdfJob.name,
                            done: Math.min(pdfJob.done + 1, pdfJob.total || 1),
                            total: pdfJob.total || "…",
                          })}
                        </span>
                        <button
                          type="button"
                          className="btn btn-ghost"
                          onClick={() => pdfJob.ac.abort()}
                        >
                          {t("myspace.ocr.pdfCancel")}
                        </button>
                      </div>
                    )}
                    {attachError && (
                      <div
                        style={{
                          padding: "4px 12px",
                          fontSize: 12,
                          color: "var(--coral)",
                          background: "var(--coral-soft)",
                          borderBottom: "1px solid var(--glass-border)",
                        }}
                      >
                        {attachError}
                      </div>
                    )}
                    {activeTab && (
                      <div
                        className={
                          docThemes[activeTab] ? `note-doc-${docThemes[activeTab]}` : undefined
                        }
                        style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}
                      >
                        {(() => {
                          const af = openFiles.find((f) => f.path === activeTab);
                          if (!af) return null;
                          return (
                            <CodeMirrorLiveEditor
                              key={activeTab}
                              content={edContent}
                              onChange={(v: string) => updContent(activeTab, v)}
                              spellCheck={msCfg.spellcheck}
                              readOnly={!!aiBusy}
                              onOcrImage={(r) => void runOcr(r)}
                              onOcrSettings={() => setOcrDlg(true)}
                              onDropPdf={(r) => void runPdf(r)}
                              ocrBusy={ocrBusy}
                              ocrLabels={ocrLabels}
                              placeholder="Start writing... Use [[wiki-links]] and #tags"
                              onWikiLink={(title: string) => {
                                const findNote = (
                                  nodes: VaultFile[],
                                  ttl: string,
                                ): VaultFile | null => {
                                  for (const n of nodes) {
                                    if (
                                      n.type === "note" &&
                                      (n.name.replace(/\.md$/, "").toLowerCase() ===
                                        ttl.toLowerCase() ||
                                        n.name === ttl + ".md")
                                    )
                                      return n;
                                    if (n.children) {
                                      const r: VaultFile | null = findNote(n.children, ttl);
                                      if (r) return r;
                                    }
                                  }
                                  return null;
                                };
                                const t2 = findNote(tree, title);
                                const fn = t2 ? t2.path : title.replace(/[/\\?%*:|"<>]/g, "_") + ".md";
                                openFile(fn);
                              }}
                              onTagClick={(tag: string) => {
                                setLeftTab("search");
                                setSq(tag);
                              }}
                              onToggleCheckbox={(lineIndex: number) => {
                                const lines = edContent.split("\n");
                                if (lineIndex >= lines.length) return;
                                const l = lines[lineIndex];
                                const m = l.match(/^(\s*(?:[-*+]\s+)?\[)([ xX])(\]\s*.*)/);
                                if (!m) return;
                                const newChar = m[2] === "x" || m[2] === "X" ? " " : "x";
                                lines[lineIndex] = m[1] + newChar + m[3];
                                updContent(activeTab, lines.join("\n"));
                              }}
                              onPasteImage={async (blob: Blob) => {
                                try {
                                  const ext = blob.type.split("/")[1] || "png";
                                  const { url } = await api.myspaceUploadAsset(
                                    blob,
                                    `clipboard.${ext}`,
                                  );
                                  return `![image](${url})`;
                                } catch (e) {
                                  setAttachError((e as Error).message);
                                  return null;
                                }
                              }}
                            />
                          );
                        })()}
                      </div>
                    )}
                    {!activeTab && (
                      <div
                        style={{
                          flex: 1,
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                          flexDirection: "column",
                          gap: 12,
                          color: "var(--text-tertiary)",
                        }}
                      >
                        <FileText size={40} strokeWidth={1} />
                        <span style={{ fontSize: 13 }}>Select a note or create a new one</span>
                      </div>
                    )}
                  </div>
                </div>
              </div>
  );
}
