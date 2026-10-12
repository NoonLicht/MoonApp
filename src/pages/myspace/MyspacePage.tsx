import { matchesCombo, getCombo } from "@/lib/hotkeys";
import { useI18n } from "@/app/i18n";
import { useContextMenu } from "@/components/ContextMenu";
import { usePageToolbar, usePageActive } from "@/components/Toolbar";
import React, { useState, useRef, useEffect, useCallback, useMemo, lazy, Suspense } from "react";
import type {
  VaultFile,
  VaultSearchResult,
  VaultTag,
  NotesAiConfig,
  GraphData,
  GraphNode,
  GraphEdge,
} from "@/api/types";
import { api } from "@/api/client";
import { parseModelNameError } from "@/lib/modelError";
import {
  Bookmark,
  CheckSquare,
  ChevronDown,
  FileText,
  PenLine,
  Trash2,
  ChevronRight,
  Folder,
  Palette,
  Puzzle,
  RefreshCw,
} from "lucide-react";
import { useDeepLink, moonHref, SOURCE_ICON } from "@/lib/deepLink";
import LinkPicker, { type PickItem } from "@/components/LinkPicker";
import { insertIntoLiveEditor } from "@/pages/myspace/parts/CodeMirrorLiveEditor";
import type { OcrImageRequest, PdfDropRequest } from "@/pages/myspace/parts/CodeMirrorLiveEditor";
import OcrDialog from "@/pages/myspace/parts/OcrDialog";
import { loadOcrPrefs, recognizeNoteImage, recognizePdf } from "@/lib/noteOcr";
import type { OcrPrefs } from "@/lib/noteOcr";
import TasksPanel from "@/pages/myspace/parts/TasksPanel";
import CanvasPage from "@/pages/myspace/canvas/CanvasPage";

// Редактор M3E тяжёлый (таблицы токенов, редактор холста): грузим при первом открытии вкладки.
const M3ePage = lazy(() => import("@/pages/myspace/m3e/M3ePage"));
import BookmarksView from "@/pages/myspace/parts/BookmarksView";
import GitSyncView from "@/pages/myspace/parts/GitSyncView";
import { createPortal } from "react-dom";
import { askText } from "@/lib/askText";
import { getOverlayRoot } from "@/components/overlayHost";
import {
  dirname,
  notesAiError,
  type OFile,
  type Right,
  type Side,
} from "@/pages/myspace/parts/MyspaceHelpers";
import NotesAiModal from "@/pages/myspace/parts/NotesAiModal";
import GraphFullscreen from "@/pages/myspace/parts/GraphFullscreen";
import RightPanel from "@/pages/myspace/parts/RightPanel";
import EditorArea from "@/pages/myspace/parts/EditorArea";
import LeftSidebar from "@/pages/myspace/parts/LeftSidebar";

export default function MyspacePage() {
  const { t } = useI18n();
  const menu = useContextMenu();
  // Показываем пустой тулбар, чтобы убрать старую надпись
  usePageToolbar(<div style={{ display: "flex", alignItems: "center", gap: 10 }}></div>, []);

  const [leftOpen, setLeftOpen] = useState(true);
  const [rightOpen, setRightOpen] = useState(true);
  const [myspaceView, setMyspaceView] = useState<
    "notes" | "tasks" | "canvas" | "m3e" | "bookmarks" | "sync"
  >("notes");
  const [leftTab, setLeftTab] = useState<Side>("explorer");
  const [rightTab, setRightTab] = useState<Right>("backlinks");
  // Левая панель по умолчанию максимально узкая — пользователь не должен
  // постоянно зажимать разделитель, чтобы её сузить.
  const [leftW, setLeftW] = useState(220);
  const [rightW, setRightW] = useState(280);
  // Адаптивность колонок notes-раскладки: считаем ширину именно строки
  // (flex-контейнера с левой/правой панелью), а не окна — страница может быть
  // уже видового порта (боковая навигация приложения). Ниже 1150px правая
  // панель схлопывается и открывается уже поверх контента, ниже 850px то же
  // происходит и с левой; клик по остальной части страницы сворачивает её
  // обратно (см. backdrop ниже).
  const notesRowRef = useRef<HTMLDivElement | null>(null);
  const [notesRowW, setNotesRowW] = useState(0);
  useEffect(() => {
    const el = notesRowRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width || 0;
      setNotesRowW(w);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const narrowRight = notesRowW > 0 && notesRowW < 1150;
  const narrowLeft = notesRowW > 0 && notesRowW < 850;
  // Срабатывает только в момент пересечения порога — не мешает пользователю
  // открыть панель как оверлей и держать её открытой, пока ширина не изменится.
  useEffect(() => {
    if (narrowRight) setRightOpen(false);
  }, [narrowRight]);
  useEffect(() => {
    if (narrowLeft) setLeftOpen(false);
  }, [narrowLeft]);
  const [tree, setTree] = useState<VaultFile[]>([]);
  const [exp, setExp] = useState<Set<string>>(new Set());
  const [selPath, setSelPath] = useState<string | null>(null);
  const [openFiles, setOpenFiles] = useState<OFile[]>([]);
  const [activeTab, setActiveTab] = useState<string | null>(null);
  const [sq, setSq] = useState("");
  const [sres, setSres] = useState<VaultSearchResult[]>([]);
  // Поиск по смыслу (EmbeddingGemma) вместо точного совпадения слов.
  const [semSearch, setSemSearch] = useState(false);
  const [tags, setTags] = useState<VaultTag[]>([]);
  const [showCreate, setShowCreate] = useState(false);
  const [crName, setCrName] = useState("");
  const [crType, setCrType] = useState<"note" | "folder">("note");
  const [edContent, setEdContent] = useState("");
  const saveTimer = useRef<any>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  // ИИ-оформление заметки: какая операция идёт сейчас ("" — ничего) и короткая
  // плашка об успехе. Ошибки живут в общем `error` над редактором.
  const [aiBusy, setAiBusy] = useState<"" | "format" | "regenerate">("");
  const [pickerOpen, setPickerOpen] = useState(false);
  const pickPos = useRef<number | null>(null);
  const [aiNotice, setAiNotice] = useState("");
  const aiNoticeTimer = useRef<any>(null);
  // Выбор провайдера/модели для ИИ-оформления (всплывающее окно рядом с
  // кнопками). Настройки живут на сервере (myspace.ai.*), поэтому выбор
  // сохраняется и не спрашивается заново при следующем запуске.
  const [aiCfgOpen, setAiCfgOpen] = useState(false);
  const [aiCfg, setAiCfg] = useState<NotesAiConfig | null>(null);
  const [aiModels, setAiModels] = useState<string[] | null>(null);
  const [aiBusyCfg, setAiBusyCfg] = useState<"" | "models" | "save">("");
  const [aiCfgError, setAiCfgError] = useState("");
  // Имена моделей, которые сервис ПРИНИМАЕТ: приходят из текста ошибки, чтобы
  // можно было поправить опечатку одним кликом (см. src/lib/modelError.ts).
  const [modelChoices, setModelChoices] = useState<string[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);
  // Вставка картинки в заметку (кнопка "Вложить" в тулбаре): скрытый файловый
  // инпут открывается программно, insertPos запоминает позицию курсора на
  // момент клика (после закрытия системного диалога фокус/selection теряются).
  const imageFileInputRef = useRef<HTMLInputElement>(null);
  const attachInsertPos = useRef<{ start: number; end: number } | null>(null);
  const [attachError, setAttachError] = useState("");
  // Распознавание картинок заметки (Chandra OCR 2 в llama.cpp).
  const [ocrBusy, setOcrBusy] = useState<string[]>([]);
  const [ocrDlg, setOcrDlg] = useState(false);
  const [ocrPrefs, setOcrPrefs] = useState<OcrPrefs>(loadOcrPrefs);
  const openFilesRef = useRef<OFile[]>([]);
  // Тема самого документа (светлый/тёмный лист), независимо от темы приложения; по заметке.
  const [docThemes, setDocThemes] = useState<Record<string, "light" | "dark">>(() => {
    try {
      return JSON.parse(localStorage.getItem("moonapp.noteDocTheme") || "{}");
    } catch {
      return {};
    }
  });
  const cycleDocTheme = (p: string) =>
    setDocThemes((prev) => {
      const cur = prev[p];
      const next = { ...prev };
      if (!cur) next[p] = document.querySelector(".app-shell.theme-dark") ? "light" : "dark";
      else if (cur === "light") next[p] = "dark";
      else delete next[p];
      try {
        localStorage.setItem("moonapp.noteDocTheme", JSON.stringify(next));
      } catch {
        /* без запоминания */
      }
      return next;
    });
  // PDF, брошенный в заметку: идёт постраничное распознавание, его можно отменить.
  const [pdfJob, setPdfJob] = useState<{
    name: string;
    done: number;
    total: number;
    ac: AbortController;
  } | null>(null);
  // Активная вкладка в ref: ответ ИИ приходит асинхронно, и если пользователь
  // успел переключиться, текст чужой заметки в редактор попасть не должен.
  const activeTabRef = useRef<string | null>(null);
  useEffect(() => {
    activeTabRef.current = activeTab;
  }, [activeTab]);
  // Load tree + auto-create welcome note if vault empty
  useEffect(() => {
    loadTree();
    api
      .myspaceTags()
      .then(setTags)
      .catch(() => {});
    const timer = setTimeout(() => {
      api
        .myspaceTree()
        .then(async (t) => {
          setTree(t);
          if (!t || t.length === 0) {
            // Create a "Getting Started" welcome note on first visit
            try {
              await api.myspaceWrite(
                "Welcome.md",
                "# Welcome to My Space!\n\n" +
                  "This is your personal knowledge base. Here's what you can do:\n\n" +
                  "## Quick Start\n\n" +
                  "- **Create notes** with the + button in the sidebar\n" +
                  "- **Link notes** using [[WikiLinks]] like [[Another Note]]\n" +
                  "- **Tag content** with #tags for easy organization\n" +
                  "- **Search** across all your notes\n\n" +
                  "## Features\n\n" +
                  "- `Code blocks` with syntax highlighting\n" +
                  "- Task lists: - [ ] todo, - [x] done\n" +
                  "- Auto-save while you type\n" +
                  "- Backlinks in the right panel\n" +
                  "- Full-text search across your vault\n\n" +
                  "Start writing by creating a new note or editing this one!\n",
                { title: "Welcome", tags: "getting-started" },
              );
              const upd = await api.myspaceTree();
              setTree(upd);
              // Open the welcome note
              const d = await api.myspaceRead("Welcome.md");
              const f: OFile = {
                path: d.path,
                name: d.name,
                content: d.content,
                frontmatter: d.frontmatter,
                outline: d.outline,
                backlinks: d.backlinks,
                modified: false,
              };
              setOpenFiles([f]);
              setActiveTab("Welcome.md");
              setSelPath("Welcome.md");
              setEdContent(d.content);
            } catch (e: any) {
              setError("Could not create welcome note: " + e.message);
            }
          }
        })
        .catch(() => {});
    }, 300);
    return () => clearTimeout(timer);
  }, []);

  const loadTree = () => {
    api
      .myspaceTree()
      .then((t) => {
        setTree(t);
        setExpAutoExpand(t);
      })
      .catch(() => {});
  };
  const setExpAutoExpand = (nodes: VaultFile[]) => {
    const toExpand = new Set<string>();
    const walk = (list: VaultFile[]) => {
      for (const n of list) {
        if (n.type === "folder") {
          if (n.children && n.children.length > 0) {
            toExpand.add(n.path);
            walk(n.children);
          }
        }
      }
    };
    walk(nodes);
    setExp((prev) => {
      const nxt = new Set(prev);
      toExpand.forEach((p) => nxt.add(p));
      return nxt;
    });
  };
  const openFile = useCallback(
    async (p: string) => {
      const ex = openFiles.find((f) => f.path === p);
      if (ex) {
        setActiveTab(p);
        setSelPath(p);
        return;
      }
      try {
        const d = await api.myspaceRead(p);
        if (!d) {
          setError("File not found: " + p);
          return;
        }
        const f: OFile = {
          path: d.path,
          name: d.name,
          content: d.content,
          frontmatter: d.frontmatter,
          outline: d.outline,
          backlinks: d.backlinks,
          modified: false,
        };
        setOpenFiles((prev) => [...prev, f]);
        setActiveTab(p);
        setSelPath(p);
        setEdContent(d.content);
        setError("");
      } catch (e: any) {
        setError("Could not open file: " + e.message);
      }
    },
    [openFiles],
  );

  // Переход из общего поиска / палитры: нужная вкладка и заметка.
  useDeepLink("myspace", (t) => {
    if (
      t.view === "notes" ||
      t.view === "tasks" ||
      t.view === "bookmarks" ||
      t.view === "canvas" ||
      t.view === "m3e"
    )
      setMyspaceView(t.view);
    if (t.view === "notes" && t.ref) void openFile(t.ref);
    if ((t.view === "canvas" || t.view === "tasks") && t.ref) return false; // дальше — вложенная страница
  });

  const closeTab = (p: string) => {
    setOpenFiles((prev) => prev.filter((f) => f.path !== p));
    if (activeTab === p) {
      const rem = openFiles.filter((f) => f.path !== p);
      setActiveTab(rem.length ? rem[rem.length - 1].path : null);
    }
  };

  const schedSave = useCallback((p: string) => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(async () => {
      setSaving(true);
      /* из ref, а не из замыкания: к моменту срабатывания таймера вкладка уже обновлена,
       * а замыкание помнит текст до последней правки (вставленная картинка не записывалась) */
      const f = openFilesRef.current.find((x) => x.path === p);
      if (f && f.modified) {
        try {
          await api.myspaceWrite(p, f.content, f.frontmatter);
          setError("");
        } catch (e: any) {
          setError("Save failed: " + e.message);
        }
        /* правка, сделанная пока шла запись, остаётся несохранённой */
        setOpenFiles((prev) =>
          prev.map((x) =>
            x.path === p && x.content === f.content ? { ...x, modified: false } : x,
          ),
        );
      }
      setSaving(false);
    }, 250);
  }, []);

  useEffect(() => {
    openFilesRef.current = openFiles;
  }, [openFiles]);

  const updContentRef = useRef<(p: string, c: string) => void>(() => undefined);

  const updContent = (p: string, c: string) => {
    setOpenFiles((prev) =>
      prev.map((f) => (f.path === p ? { ...f, content: c, modified: true } : f)),
    );
    if (activeTab === p) setEdContent(c);
    // Автосохранение можно выключить в настройках (раздел «My Space»):
    // тогда изменения сохраняются по Ctrl+S или при закрытии вкладки.
    if (msCfg.autosave) schedSave(p);
  };
  useEffect(() => {
    updContentRef.current = updContent;
  });

  /**
   * Кнопка «OCR» на картинке: модель переводит её в Markdown (текст, таблицы, формулы), а рисунки
   * и графики вырезает и вставляет картинками на нужные места. Результат заменяет саму картинку.
   */
  const runOcr = useCallback(
    async (req: OcrImageRequest) => {
      const path = activeTab;
      setAttachError("");
      setOcrBusy((b) => (b.includes(req.src) ? b : [...b, req.src]));
      try {
        const r = await recognizeNoteImage(
          req.src,
          async (blob, name) => (await api.myspaceUploadAsset(blob, name)).url,
          ocrPrefs,
        );
        if (req.replace(r.markdown)) return;
        // Редактор уже закрыт (переключились на другую заметку): правим сохранённый текст файла.
        const f = path ? openFilesRef.current.find((x) => x.path === path) : undefined;
        const needle = `![${req.alt}](${req.src}`;
        const at = f ? f.content.indexOf(needle) : -1;
        const end = f && at >= 0 ? f.content.indexOf(")", at + needle.length) : -1;
        if (f && path && at >= 0 && end >= 0) {
          updContentRef.current(
            path,
            f.content.slice(0, at) + r.markdown + f.content.slice(end + 1),
          );
        } else setAttachError(t("myspace.ocr.imageGone"));
      } catch (e) {
        const m = (e as Error).message;
        if (/ocr_model_missing|build_missing/.test(m)) {
          setAttachError(t("myspace.ocr.needSetup"));
          setOcrDlg(true);
        } else setAttachError(t("myspace.ocr.failed", { error: m }));
      } finally {
        setOcrBusy((b) => b.filter((x) => x !== req.src));
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [activeTab, ocrPrefs, t],
  );
  const ocrLabels = useMemo(
    () => ({
      ocr: t("myspace.ocr.btn"),
      settings: t("myspace.ocr.settings"),
      busy: t("myspace.ocr.busy"),
    }),
    [t],
  );

  /**
   * PDF, брошенный на редактор: страницы по очереди распознаются, текст каждой подставляется на место
   * маркера (результат появляется в заметке по мере готовности).
   */
  const runPdf = useCallback(
    async (req: PdfDropRequest) => {
      const path = activeTab;
      const ac = new AbortController();
      setAttachError("");
      setPdfJob({ name: req.file.name, done: 0, total: 0, ac });
      // Если редактор закрыли (ушли в другую заметку), правим сохранённый текст файла.
      const swap = (from: string, to: string): void => {
        if (req.replace(from, to)) return;
        const f = path ? openFilesRef.current.find((x) => x.path === path) : undefined;
        if (f && path && f.content.includes(from))
          updContentRef.current(
            path,
            f.content.replace(from, () => to),
          );
      };
      try {
        const r = await recognizePdf(
          req.file,
          async (blob, name) => (await api.myspaceUploadAsset(blob, name)).url,
          ocrPrefs,
          {
            signal: ac.signal,
            onProgress: (done, total) => setPdfJob((j) => (j ? { ...j, done, total } : j)),
            onPage: (n, _total, md) =>
              swap(req.marker, `${n > 1 ? "---\n\n" : ""}${md}\n\n${req.marker}`),
          },
        );
        if (r.empty.length)
          setAttachError(t("myspace.ocr.pdfEmpty", { pages: r.empty.join(", ") }));
      } catch (e) {
        const m = (e as Error).message;
        if ((e as Error).name === "AbortError" || ac.signal.aborted) {
          /* отмена пользователем: уже распознанное остаётся в заметке */
        } else if (/ocr_model_missing|build_missing/.test(m)) {
          setAttachError(t("myspace.ocr.needSetup"));
          setOcrDlg(true);
        } else setAttachError(t("myspace.ocr.failed", { error: m }));
      } finally {
        swap(`${req.marker}\n`, "");
        swap(req.marker, "");
        setPdfJob(null);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [activeTab, ocrPrefs, t],
  );

  /** Вставляет ![alt](url) в позицию, запомненную в момент клика по кнопке
   * "Вложить" (fallback — конец текста, если курсор не был захвачен). */
  const insertImageMarkdown = useCallback(
    (url: string, alt: string) => {
      if (!activeTab) return;
      const pos = attachInsertPos.current || { start: edContent.length, end: edContent.length };
      const md = `![${alt}](${url})`;
      const nc = edContent.substring(0, pos.start) + md + edContent.substring(pos.end);
      updContent(activeTab, nc);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [activeTab, edContent],
  );

  const uploadAndInsertImage = useCallback(
    async (blob: Blob, filename: string) => {
      try {
        const { url } = await api.myspaceUploadAsset(blob, filename);
        insertImageMarkdown(url, filename.replace(/\.[a-z0-9]+$/i, "") || "image");
      } catch (e) {
        setAttachError((e as Error).message);
      }
    },
    [insertImageMarkdown],
  );

  /**
   * ИИ-оформление заметки.
   *
   * format — «Оформить»: сервер сохраняет текущий текст как исходник
   *   (storage/vault/notes/.ai/<имя>.txt) и возвращает аккуратную версию.
   * regenerate — «Регенерировать»: заново из сохранённого исходника, текст
   *   заметки заменяется целиком (правки после «Оформить» будут перезаписаны).
   *
   * Файл пишет сервер, поэтому вкладку обновляем без автосохранения (modified:
   * false) — иначе debounce-save записал бы старый текст поверх готового.
   */
  /** Конфигурация ИИ-оформления с сервера (провайдер, модель, список). */
  const loadAiCfg = useCallback(async () => {
    try {
      const cfg = await api.myspaceAiConfig();
      setAiCfg(cfg);
      return cfg;
    } catch (e: any) {
      setAiCfgError(notesAiError(String(e?.message || ""), t));
      return null;
    }
  }, [t]);

  /** Живой список моделей провайдера (нет сети — каталог провайдера). */
  const loadAiModels = useCallback(
    async (providerId: string) => {
      if (!providerId) {
        setAiModels(null);
        return;
      }
      setAiBusyCfg("models");
      try {
        const r = await api.myspaceAiModels(providerId);
        setAiModels(r.models || []);
        setAiCfgError("");
      } catch (e: any) {
        setAiModels(null);
        setAiCfgError(notesAiError(String(e?.message || ""), t));
      } finally {
        setAiBusyCfg("");
      }
    },
    [t],
  );

  /** Открыть окно выбора провайдера/модели и подтянуть актуальные данные. */
  const openAiCfg = useCallback(async () => {
    setAiCfgOpen(true);
    setAiCfgError("");
    const cfg = await loadAiCfg();
    if (cfg?.providerId) void loadAiModels(cfg.providerId);
  }, [loadAiCfg, loadAiModels]);

  /** Сохранить выбор (частично): сервер пишет myspace.ai.provider/model. */
  const saveAiCfg = useCallback(
    async (patch: { providerId?: string; model?: string }) => {
      setAiBusyCfg("save");
      try {
        const cfg = await api.myspaceAiSaveConfig(patch);
        setAiCfg(cfg);
        setAiCfgError("");
        // Сменили провайдера — список моделей прежнего больше не актуален.
        if (patch.providerId !== undefined) setAiModels(null);
        return cfg;
      } catch (e: any) {
        setAiCfgError(notesAiError(String(e?.message || ""), t));
        return null;
      } finally {
        setAiBusyCfg("");
      }
    },
    [t],
  );

  /** Клик по чипсу с моделью из текста ошибки: сохраняем имя и закрываем окно. */
  const pickModelChoice = useCallback(
    async (model: string) => {
      const saved = await saveAiCfg({ model });
      if (!saved) return;
      setModelChoices([]);
      setError("");
      setAiNotice(t("myspace.ai.modelSaved", { model }));
    },
    [saveAiCfg, t],
  );

  /**
   * Список моделей для селекта: живой список провайдера, а если его получить не
   * удалось — каталог из ответа. Текущая модель добавляется первой, чтобы селект
   * не «терял» сохранённое значение.
   */
  const aiCfgModels = useMemo(() => {
    const fromCatalog =
      (aiCfg?.providers || []).find((p) => p.id === aiCfg?.providerId)?.models || [];
    const list = aiModels && aiModels.length ? aiModels : fromCatalog;
    const cur = aiCfg?.model || "";
    return cur && !list.includes(cur) ? [cur, ...list] : list;
  }, [aiModels, aiCfg]);

  const runNotesAi = async (mode: "format" | "regenerate") => {
    const target = activeTab;
    if (!target || aiBusy) return;
    const file = openFiles.find((f) => f.path === target);
    if (!file) return;
    setAiBusy(mode);
    setAiNotice("");
    try {
      // «Оформить» работает с файлом на диске: сохраняем правки, иначе ИИ
      // оформит предыдущую версию заметки.
      if (mode === "format") await api.myspaceWrite(target, file.content, file.frontmatter);
      const res =
        mode === "format"
          ? await api.myspaceAiFormat(target)
          : await api.myspaceAiRegenerate(target);
      // Отложенное автосохранение больше не нужно и опасно: сервер уже записал
      // готовый текст, а таймер записал бы поверх него содержимое вкладки,
      // снятое ДО запроса (в «format» оно уже сохранено явно, в «regenerate» —
      // намеренно выброшено).
      if (saveTimer.current) clearTimeout(saveTimer.current);
      // Заголовки (блок «Содержание») и обратные ссылки после ответа модели
      // другие — подтягиваем их с диска, текст берём из ответа (он уже записан).
      const fresh = await api.myspaceRead(target).catch(() => null);
      setOpenFiles((prev) =>
        prev.map((f) =>
          f.path === target
            ? {
                ...f,
                content: res.content,
                outline: fresh?.outline ?? f.outline,
                backlinks: fresh?.backlinks ?? f.backlinks,
                modified: false,
              }
            : f,
        ),
      );
      // Перегенерированная заметка целиком написана ИИ — «Автор мысли» пометит её абзацы.
      if (mode === "regenerate") void api.mindProvenanceRecord(target, res.content, "ai").catch(() => undefined);
      // В редактор — только если пользователь не переключился на другую заметку.
      if (activeTabRef.current === target) setEdContent(res.content);
      setError("");
      setAiNotice(
        t(res.regenerated ? "myspace.ai.regenerated" : "myspace.ai.formatted", {
          model: res.model,
          chars: res.chars,
        }),
      );
      if (aiNoticeTimer.current) clearTimeout(aiNoticeTimer.current);
      aiNoticeTimer.current = setTimeout(() => setAiNotice(""), 7000);
      // Список тегов в правой панели мог измениться вместе с текстом.
      api
        .myspaceTags()
        .then(setTags)
        .catch(() => {});
    } catch (e: any) {
      // Ошибка «сервис не принимает такую модель» (обычная опечатка в имени)
      // приходила сырым JSON. Разбираем её: показываем понятный текст, чипсы с
      // именами, которые сервис принимает, и открываем окно выбора модели.
      const bad = parseModelNameError(String(e?.message || ""));
      if (bad) {
        const names = bad.names.length ? bad.names : aiModels || [];
        setModelChoices(names);
        setError(t("myspace.ai.errModelName", { model: bad.model || "—" }));
        void openAiCfg();
      } else {
        setModelChoices([]);
        setError(notesAiError(String(e?.message || ""), t));
      }
    } finally {
      setAiBusy("");
    }
  };

  // Ручное сохранение открытой вкладки по Ctrl+S (когда автосейв выключен).
  useEffect(() => {
    if (typeof window === "undefined") return; // SSR-окружение (smoke-тесты)
    const onKey = (e: KeyboardEvent) => {
      if (matchesCombo(e, getCombo("noteSave")) && activeTab) {
        e.preventDefault();
        const f = openFiles.find((x) => x.path === activeTab);
        if (f) {
          api
            .myspaceWrite(activeTab, f.content, f.frontmatter)
            .then(() => {
              setError("");
              setOpenFiles((prev) =>
                prev.map((x) => (x.path === activeTab ? { ...x, modified: false } : x)),
              );
            })
            .catch((ex: any) => setError("Save failed: " + ex?.message));
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [activeTab, openFiles]);

  // Настройки My Space: автосохранение и проверка орфографии.
  const [msCfg, setMsCfg] = useState<{ autosave: boolean; spellcheck: boolean }>({
    autosave: true,
    spellcheck: false,
  });
  useEffect(() => {
    api
      .getSettings()
      .then((s: any) => {
        const m = s?.myspace || {};
        setMsCfg({ autosave: m.autosave !== false, spellcheck: !!m.spellcheck });
      })
      .catch(() => {});
  }, []);
  useEffect(() => {
    if (activeTab) {
      const f = openFiles.find((x) => x.path === activeTab);
      if (f) setEdContent(f.content);
    }
  }, [activeTab, openFiles]);

  const createItem = async () => {
    if (!crName.trim()) return;
    const p = crType === "note" ? crName.trim() + ".md" : crName.trim();
    // Check duplicate
    const dup = (nodes: VaultFile[]): boolean => {
      for (const n of nodes) {
        if (n.path === p) return true;
        if (n.children && dup(n.children)) return true;
      }
      return false;
    };
    if (dup(tree)) {
      setError('A file/folder named "' + crName.trim() + '" already exists');
      return;
    }
    try {
      if (crType === "note") {
        await api.myspaceWrite(p, "", { title: crName.trim() });
        await openFile(p);
      } else {
        await api.myspaceCreateFolder(p);
        toggleExpand(dirname(p));
      }
      loadTree();
      setShowCreate(false);
      setCrName("");
      setError("");
    } catch (e: any) {
      setError("Failed to create: " + e.message);
    }
  };

  const delFile = async (p: string) => {
    try {
      await api.myspaceDelete(p);
      closeTab(p);
      loadTree();
      setError("");
    } catch (e: any) {
      setError("Delete failed: " + e.message);
    }
  };
  const deleteFolder = async (node: any) => {
    // Move all children notes to root first
    const moveFiles = async (nodes: VaultFile[]) => {
      for (const n of nodes) {
        if (n.type === "note") {
          const destName = n.name;
          const exists = tree.some((x) => x.path === destName);
          if (exists) {
            setError('Cannot move "' + n.name + '" ? a file with this name already exists at root');
            continue;
          }
          try {
            await api.myspaceRename(n.path, destName);
          } catch (ex: any) {
            setError("Failed to move: " + ex.message);
          }
        } else if (n.type === "folder" && n.children) {
          await moveFiles(n.children);
        }
      }
    };
    if (node.children) {
      await moveFiles(node.children);
      await new Promise((r) => setTimeout(r, 200)); // wait for moves
    }
    // Delete the now-empty folder
    try {
      await api.myspaceDelete(node.path);
    } catch (ex: any) {
      setError("Delete failed: " + ex.message);
    }
    loadTree();
  };

  useEffect(() => {
    if (!sq.trim()) {
      setSres([]);
      return;
    }
    const t = setTimeout(() => {
      if (semSearch) {
        api
          .semSearch(sq, ["note"], 20)
          .then((hits) =>
            setSres(
              hits.map((h) => ({
                path: h.ref,
                name: h.title || h.ref.replace(/^.*\//, ""),
                snippet: `${Math.round(h.score * 100)}% · ${h.snippet.slice(0, 120)}`,
                matchStart: 0,
              })),
            ),
          )
          .catch((e) => setError((e as Error).message));
        return;
      }
      api
        .myspaceSearch(sq)
        .then(setSres)
        .catch(() => {});
    }, 400);
    return () => clearTimeout(t);
  }, [sq, semSearch]);

  const toggleExpand = (p: string) => {
    setExp((prev) => {
      const n = new Set(prev);
      if (n.has(p)) n.delete(p);
      else n.add(p);
      return n;
    });
  };

  const activeFile = openFiles.find((f) => f.path === activeTab);
  const startRes = (s: string, e: React.MouseEvent) => {
    const r = { s, sx: e.clientX, sw: s === "l" ? leftW : rightW };
    const mv = (ev: MouseEvent) => {
      const d = ev.clientX - r.sx;
      if (r.s === "l") setLeftW(Math.max(220, Math.min(400, r.sw + d)));
      else setRightW(Math.max(200, Math.min(500, r.sw - d)));
    };
    const up = () => {
      document.removeEventListener("mousemove", mv);
      document.removeEventListener("mouseup", up);
    };
    document.addEventListener("mousemove", mv);
    document.addEventListener("mouseup", up);
  };

  const [hoverDel, setHoverDel] = useState<string | null>(null);
  const [dragOverPath, setDragOverPath] = useState<string | null>(null);
  const [graphFullscreen, setGraphFullscreen] = useState(false);
  const [graphShowOrphans, setGraphShowOrphans] = useState(true);
  const [graphDepth, setGraphDepth] = useState(3);
  const [graphSearch, setGraphSearch] = useState("");

  // Полноэкранный граф рендерится порталом, т.е. ВНЕ .page-host. Неактивные
  // страницы прячутся правилом `.page-host:not(.is-active) *`, поэтому оверлей
  // гейтим сами (как MediaDetailModal/PlayerModal): иначе он остался бы висеть
  // поверх дока при переключении страницы.
  const pageActive = usePageActive();
  // Дерево Vault раньше обновлялось только после действий САМОГО приложения
  // (создать/удалить/переименовать) — если закинуть файл в папку заметок
  // снаружи (проводник), он не появлялся, пока не перезайти на страницу.
  // Лёгкий поллинг раз в 5с, пока страница активна — тот же паттерн, что и
  // у остальных списков в приложении (ArchiverPage и т.п.).
  useEffect(() => {
    if (!pageActive) return undefined;
    const timer = window.setInterval(() => {
      api
        .myspaceTree()
        .then((t) => {
          // Не подменяем ссылку на tree, если содержимое не изменилось —
          // иначе graphData (useMemo от tree) пересчитывается заново каждые
          // 5с, GraphView получает новый объект data и дёргает физическую
          // симуляцию заново (узлы прыгают), хотя реально ничего не менялось.
          setTree((prev) => (JSON.stringify(prev) === JSON.stringify(t) ? prev : t));
        })
        .catch(() => {});
    }, 5000);
    return () => window.clearInterval(timer);
  }, [pageActive]);
  // Esc закрывает полноэкранный граф. Слушатель на window (как в
  // MediaDetailModal/ContextMenu): оверлей рендерится порталом, поэтому
  // onKeyDown на самом div никогда не срабатывал — фокус туда не попадал.
  useEffect(() => {
    if (!graphFullscreen) return undefined;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setGraphFullscreen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [graphFullscreen]);
  // Build graph data from all files' [[wikiLinks]]
  const buildGraphData = useCallback((): GraphData => {
    const nodesMap = new Map<string, GraphNode>();
    const edgeSet = new Set<string>();
    // Build a lookup: lowercase title -> real path (from tree)
    const titleToPath = new Map<string, string>();
    const walkTree = (nodes: VaultFile[]) => {
      for (const n of nodes) {
        if (n.type === "note") {
          const key = n.name.replace(/\.md$/i, "").toLowerCase();
          if (!titleToPath.has(key)) titleToPath.set(key, n.path);
        }
        if (n.children) walkTree(n.children);
      }
    };
    walkTree(tree);
    // Also index openFiles
    for (const f of openFiles) {
      const key = f.name.replace(/\.md$/i, "").toLowerCase();
      if (!titleToPath.has(key)) titleToPath.set(key, f.path);
    }
    // Add openFiles as nodes
    for (const f of openFiles) {
      if (!nodesMap.has(f.path)) {
        nodesMap.set(f.path, { id: f.path, type: "note", label: f.name.replace(/\.md$/, "") });
      }
      // Extract [[WikiLinks]] from content and resolve to real paths
      const linkRegex = /(?<!!)\[\[(?!(?:task|canvas):)([^\]]+)\]\]/g;
      let m;
      while ((m = linkRegex.exec(f.content)) !== null) {
        const targetTitle = m[1].trim();
        const targetLower = targetTitle.toLowerCase();
        // Try to find the actual file path from tree or openFiles
        let targetPath = titleToPath.get(targetLower);
        if (!targetPath) {
          // Also try with .md suffix
          targetPath =
            titleToPath.get(targetLower + ".md") ||
            titleToPath.get(targetLower.replace(/\.md$/i, ""));
        }
        if (!targetPath) {
          // Fallback: sanitize
          targetPath = targetTitle.replace(/[<>:"/\\|?*]/g, "_").trim() + ".md";
        }
        if (!nodesMap.has(targetPath)) {
          nodesMap.set(targetPath, {
            id: targetPath,
            type: "note",
            label: targetPath.replace(/\.md$/i, "").replace(/_/g, " "),
          });
        }
        const edgeKey = f.path + "||" + targetPath;
        edgeSet.add(edgeKey);
      }
    }
    // Add remaining tree nodes that aren't already in the map
    const addTreeNodes = (nodes: VaultFile[]) => {
      for (const n of nodes) {
        if (n.type === "note" && !nodesMap.has(n.path)) {
          nodesMap.set(n.path, { id: n.path, type: "note", label: n.name.replace(/\.md$/, "") });
        }
        if (n.children) addTreeNodes(n.children);
      }
    };
    addTreeNodes(tree);
    let allNodes = Array.from(nodesMap.values());
    const edges = Array.from(edgeSet).map((k) => {
      const [s, t] = k.split("||");
      return { source: s, target: t } as GraphEdge;
    });
    if (activeTab && graphDepth < 5) {
      // BFS from active tab to find depth-reachable nodes
      const visited = new Set<string>();
      const queue: { path: string; depth: number }[] = [{ path: activeTab, depth: 0 }];
      visited.add(activeTab);
      const depthNodes = new Set<string>();
      while (queue.length > 0) {
        const q = queue.shift()!;
        depthNodes.add(q.path);
        if (q.depth >= graphDepth) continue;
        for (const e of edges) {
          const neighbor = e.source === q.path ? e.target : e.target === q.path ? e.source : null;
          if (neighbor && !visited.has(neighbor)) {
            visited.add(neighbor);
            queue.push({ path: neighbor, depth: q.depth + 1 });
          }
        }
      }
      allNodes = allNodes.filter((n) => depthNodes.has(n.id));
    } else if (!activeTab && !graphShowOrphans) {
      // No file open: show only connected nodes (hide orphans) unless user explicitly wants orphans
      const connected = new Set<string>();
      for (const e of edges) {
        connected.add(e.source);
        connected.add(e.target);
      }
      allNodes = allNodes.filter((n) => connected.has(n.id));
    }
    if (!graphShowOrphans) {
      const connected = new Set<string>();
      for (const e of edges) {
        connected.add(e.source);
        connected.add(e.target);
      }
      allNodes = allNodes.filter((n) => connected.has(n.id));
    }
    if (graphSearch.trim()) {
      const q = graphSearch.toLowerCase();
      allNodes = allNodes.filter((n) => n.label.toLowerCase().includes(q));
    }
    const finalIds = new Set(allNodes.map((n) => n.id));
    let finalEdges = edges.filter((e) => finalIds.has(e.source) && finalIds.has(e.target));
    // Жёсткая фильтрация: если depth < 5 (локальный граф), показываем ТОЛЬКО
    // рёбра, где хотя бы один конец — это активный файл (activeTab).
    // Никаких транзитивных связей между файлами 2-го+ уровня!
    if (activeTab && graphDepth < 5) {
      finalEdges = finalEdges.filter((e) => e.source === activeTab || e.target === activeTab);
    }
    return { nodes: allNodes, edges: finalEdges };
  }, [openFiles, tree, activeTab, graphDepth, graphShowOrphans, graphSearch]);

  const graphData = useMemo(buildGraphData, [
    openFiles,
    tree,
    activeTab,
    graphDepth,
    graphShowOrphans,
    graphSearch,
  ]);
  const [rightSplit, setRightSplit] = useState(55); // % for backlinks top section
  // Переименование заметки/папки из контекстного меню: спрашиваем имя,
  // строим новый путь в той же папке и обновляем открытые вкладки.
  const renameNode = async (node: VaultFile) => {
    const name = await askText(t("ctx.rename"), node.name);
    if (!name || !name.trim() || name === node.name) return;
    const dir = dirname(node.path);
    const dest = dir ? `${dir}/${name.trim()}` : name.trim();
    try {
      await api.myspaceRename(node.path, dest);
      setOpenFiles((prev) =>
        prev.map((f) => (f.path === node.path ? { ...f, path: dest, name: name.trim() } : f)),
      );
      setActiveTab((p) => (p === node.path ? dest : p));
      setSelPath((p) => (p === node.path ? dest : p));
      loadTree();
      setError("");
    } catch (ex) {
      setError("Rename failed: " + (ex as Error).message);
    }
  };

  const renderNode = (node: VaultFile, depth: number = 0) => {
    const isExp = exp.has(node.path);
    const isSel = selPath === node.path;
    if (node.type === "folder") {
      return (
        <div key={node.path}>
          <div
            onClick={() => toggleExpand(node.path)}
            onContextMenu={(e) =>
              menu.open(e, [
                { label: t("ctx.open"), icon: ChevronDown, onClick: () => toggleExpand(node.path) },
                {
                  label: t("ctx.newNote"),
                  icon: FileText,
                  onClick: async () => {
                    const name = await askText(t("ctx.newNote"));
                    if (!name || !name.trim()) return;
                    const p = node.path + "/" + name.trim().replace(/\.md$/, "") + ".md";
                    try {
                      await api.myspaceWrite(p, "", { title: name.trim() });
                      loadTree();
                      openFile(p);
                      setError("");
                    } catch (ex) {
                      setError("Create failed: " + (ex as Error).message);
                    }
                  },
                },
                { label: t("ctx.rename"), icon: PenLine, onClick: () => renameNode(node) },
                { separator: true },
                {
                  label: t("ctx.delFolder"),
                  icon: Trash2,
                  danger: true,
                  onClick: async () => {
                    if (
                      window.confirm(
                        'Delete folder "' + node.name + '"? Files inside will be moved to root.',
                      )
                    )
                      await deleteFolder(node);
                  },
                },
              ])
            }
            onDragOver={(e) => {
              e.preventDefault();
              e.stopPropagation();
              setDragOverPath(node.path);
            }}
            onDragLeave={() => setDragOverPath(null)}
            onDrop={async (e) => {
              e.preventDefault();
              e.stopPropagation();
              const src = e.dataTransfer.getData("text/plain");
              if (!src || src === node.path) return;
              const base = src.split("/").pop() || src;
              const dest = node.path + "/" + base;
              const exists = tree.some(
                (n) => n.path === dest || (n.children && n.children.some((ch) => ch.path === dest)),
              );
              if (exists) {
                setError('A file/folder named "' + base + '" already exists in this folder');
                setDragOverPath(null);
                return;
              }
              try {
                await api.myspaceRename(src, dest);
                loadTree();
                setOpenFiles((prev) =>
                  prev.map((f) => (f.path === src ? { ...f, path: dest, name: base } : f)),
                );
                setActiveTab((prev) => (prev === src ? dest : prev));
                setSelPath((prev) => (prev === src ? dest : prev));
                setError("");
              } catch (ex: any) {
                setError("Move failed: " + ex.message);
              }
              setDragOverPath(null);
            }}
            onMouseEnter={() => setHoverDel(node.path)}
            onMouseLeave={() => setHoverDel(null)}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 4,
              padding: "3px 6px",
              paddingLeft: 12 + depth * 16,
              borderRadius: 4,
              fontSize: 12,
              cursor: "pointer",
              color: "var(--text-secondary)",
              background: dragOverPath === node.path ? "var(--teal-soft)" : "transparent",
            }}
          >
            <span>{isExp ? <ChevronDown size={12} /> : <ChevronRight size={12} />}</span>
            <Folder size={14} style={{ color: "var(--amber)" }} />
            <span style={{ flex: 1 }}>{node.name}</span>
            {hoverDel === node.path && (
              <button
                onClick={async (e) => {
                  e.stopPropagation();
                  if (
                    !window.confirm(
                      'Delete folder "' + node.name + '"? Files inside will be moved to root.',
                    )
                  )
                    return;
                  setError("");
                  await deleteFolder(node);
                }}
                style={{
                  background: "transparent",
                  border: "none",
                  padding: 1,
                  cursor: "pointer",
                  color: "var(--coral)",
                  display: "flex",
                  flexShrink: 0,
                }}
              >
                <Trash2 size={11} />
              </button>
            )}
          </div>
          {isExp && node.children?.map((child) => renderNode(child, depth + 1))}
        </div>
      );
    }
    return (
      <div
        key={node.path}
        onClick={() => {
          openFile(node.path);
          setSelPath(node.path);
        }}
        onContextMenu={(e) =>
          menu.open(e, [
            {
              label: t("ctx.open"),
              icon: FileText,
              onClick: () => {
                openFile(node.path);
                setSelPath(node.path);
              },
            },
            { label: t("ctx.rename"), icon: PenLine, onClick: () => renameNode(node) },
            { separator: true },
            {
              label: t("ctx.del"),
              icon: Trash2,
              danger: true,
              onClick: () => {
                if (window.confirm("Delete " + node.name + "?")) delFile(node.path);
              },
            },
          ])
        }
        draggable={true}
        onDragStart={(e) => {
          e.dataTransfer.setData("text/plain", node.path);
          e.dataTransfer.effectAllowed = "move";
        }}
        onMouseEnter={() => setHoverDel(node.path)}
        onMouseLeave={() => setHoverDel(null)}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 2,
          padding: "3px 6px",
          paddingLeft: 28 + depth * 16,
          borderRadius: 4,
          fontSize: 12,
          cursor: "pointer",
          background: isSel ? "var(--amber-soft)" : "transparent",
          color: isSel ? "var(--amber)" : "var(--text-secondary)",
        }}
      >
        <FileText size={13} />
        <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis" }}>{node.name}</span>
        {hoverDel === node.path && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              if (window.confirm("Delete " + node.name + "?")) {
                delFile(node.path);
              }
            }}
            style={{
              background: "transparent",
              border: "none",
              padding: 1,
              cursor: "pointer",
              color: "var(--coral)",
              display: "flex",
              flexShrink: 0,
              marginLeft: 4,
            }}
          >
            <Trash2 size={11} />
          </button>
        )}
      </div>
    );
  };

  return (
    <div
      className="page-wide"
      style={{
        display: "flex",
        flexDirection: "column",
        flex: 1,
        minHeight: 0,
        overflow: "hidden",
      }}
    >
      {/* ─── VIEW SWITCHER ─── */}
      <div className="page-tabs" style={{ padding: "4px 4px 0 4px" }}>
        <button type="button" className={`page-tab${myspaceView === "notes" ? " active" : ""}`} onClick={() => setMyspaceView("notes")}>
          <FileText size={14} /> {t("myspace.notesTab")}
        </button>
        <button type="button" className={`page-tab${myspaceView === "tasks" ? " active" : ""}`} onClick={() => setMyspaceView("tasks")}>
          <CheckSquare size={14} /> {t("myspace.tasksTab")}
        </button>
        <button type="button" className={`page-tab${myspaceView === "canvas" ? " active" : ""}`} onClick={() => setMyspaceView("canvas")}>
          <Palette size={14} /> {t("myspace.canvasTab")}
        </button>
        <button type="button" className={`page-tab${myspaceView === "m3e" ? " active" : ""}`} onClick={() => setMyspaceView("m3e")}>
          <Puzzle size={14} /> {t("myspace.m3eTab")}
        </button>
        <button type="button" className={`page-tab${myspaceView === "bookmarks" ? " active" : ""}`} onClick={() => setMyspaceView("bookmarks")}>
          <Bookmark size={14} /> {t("myspace.bookmarksTab")}
        </button>
        <button type="button" className={`page-tab${myspaceView === "sync" ? " active" : ""}`} onClick={() => setMyspaceView("sync")}>
          <RefreshCw size={14} /> {t("myspace.syncTab")}
        </button>
      </div>
      {myspaceView === "notes" && (
        <div
          ref={notesRowRef}
          style={{
            display: "flex",
            flex: 1,
            minHeight: 0,
            overflow: "hidden",
            position: "relative",
          }}
        >
          {/* Оверлейные панели на узкой ширине рисуются поверх контента — клик
              по остальной странице их сворачивает. */}
          {((narrowLeft && leftOpen) || (narrowRight && rightOpen)) && (
            <div
              onClick={() => {
                if (narrowLeft) setLeftOpen(false);
                if (narrowRight) setRightOpen(false);
              }}
              style={{ position: "absolute", inset: 0, zIndex: 30 }}
            />
          )}
          {/* LEFT SIDEBAR */}
          {leftOpen && (
            <LeftSidebar narrowLeft={narrowLeft} leftW={leftW} setLeftTab={setLeftTab} leftTab={leftTab} setLeftOpen={setLeftOpen} setShowCreate={setShowCreate} setCrType={setCrType} setCrName={setCrName} inputRef={inputRef} showCreate={showCreate} crType={crType} crName={crName} createItem={createItem} tree={tree} setError={setError} loadTree={loadTree} setOpenFiles={setOpenFiles} setActiveTab={setActiveTab} setSelPath={setSelPath} renderNode={renderNode} setSemSearch={setSemSearch} t={t} semSearch={semSearch} sq={sq} setSq={setSq} sres={sres} openFile={openFile} tags={tags} startRes={startRes} />
          )}
          {/* CENTER EDITOR */}
          <EditorArea setLeftOpen={setLeftOpen} leftOpen={leftOpen} openFiles={openFiles} setActiveTab={setActiveTab} activeTab={activeTab} closeTab={closeTab} saving={saving} aiBusy={aiBusy} t={t} activeFile={activeFile} pickPos={pickPos} setPickerOpen={setPickerOpen} runNotesAi={runNotesAi} openAiCfg={openAiCfg} aiCfgOpen={aiCfgOpen} cycleDocTheme={cycleDocTheme} docThemes={docThemes} setOcrDlg={setOcrDlg} setRightOpen={setRightOpen} rightOpen={rightOpen} error={error} aiNotice={aiNotice} imageFileInputRef={imageFileInputRef} uploadAndInsertImage={uploadAndInsertImage} pdfJob={pdfJob} attachError={attachError} edContent={edContent} updContent={updContent} msCfg={msCfg} runOcr={runOcr} runPdf={runPdf} ocrBusy={ocrBusy} ocrLabels={ocrLabels} tree={tree} openFile={openFile} setLeftTab={setLeftTab} setSq={setSq} setAttachError={setAttachError} />
          {/* RIGHT SIDEBAR */}
          {rightOpen && (
            <RightPanel narrowRight={narrowRight} rightW={rightW} setRightTab={setRightTab} rightTab={rightTab} setRightOpen={setRightOpen} activeTab={activeTab} edContent={edContent} openFile={openFile} updContent={updContent} rightSplit={rightSplit} openFiles={openFiles} setRightSplit={setRightSplit} setGraphFullscreen={setGraphFullscreen} setGraphDepth={setGraphDepth} setGraphShowOrphans={setGraphShowOrphans} setGraphSearch={setGraphSearch} graphData={graphData} graphSearch={graphSearch} graphShowOrphans={graphShowOrphans} graphDepth={graphDepth} startRes={startRes} />
          )}
        </div>
      )}
      {/* ─── TASKS VIEW ─── */}
      {myspaceView === "tasks" && (
        <div style={{ display: "flex", flex: 1, minHeight: 0, overflow: "hidden" }}>
          <TasksPanel
            onOpenNote={openFile}
            vaultFiles={tree?.map((f) => f.name.replace(/\.md$/i, "")) || []}
          />
        </div>
      )}
      {/* ─── CANVAS VIEW ─── */}
      {pickerOpen && activeTab && (
        <LinkPicker
          kinds={["task", "bookmark", "note", "canvas", "lecture", "chat"]}
          onClose={() => setPickerOpen(false)}
          onPick={(it: PickItem) => {
            // Задачи и доски встраиваются блоком (виджет в тексте), остальное — ссылкой.
            const block = it.kind === "task" || it.kind === "canvas";
            const href = it.kind === "bookmark" && it.url ? it.url : moonHref(it.kind, it.ref);
            const label = it.title.replace(/[[\]]/g, "");
            const text = block
              ? `![[${it.kind}:${it.ref}]]`
              : `[${SOURCE_ICON[it.kind]} ${label}](${href})`;
            setPickerOpen(false);
            if (!insertIntoLiveEditor(text, block) && activeTab) {
              // режим исходного текста: вставляем в позицию курсора textarea
              const at = Math.min(pickPos.current ?? edContent.length, edContent.length);
              const pre = edContent.slice(0, at);
              const lead = block && pre && !pre.endsWith("\n") ? "\n" : "";
              const tail = block && !edContent.slice(at).startsWith("\n") ? "\n" : "";
              updContent(activeTab, pre + lead + text + tail + edContent.slice(at));
            }
          }}
        />
      )}
      {myspaceView === "canvas" && (
        <div
          style={{ display: "flex", flex: 1, minHeight: 0, overflow: "hidden", margin: "8px 12px" }}
        >
          <CanvasPage />
        </div>
      )}
      {/* ─── M3E VIEW ─── */}
      {myspaceView === "m3e" && (
        <div
          style={{ display: "flex", flex: 1, minHeight: 0, overflow: "hidden", margin: "8px 12px" }}
        >
          <Suspense fallback={<div style={{ margin: "auto", fontSize: 13 }}>…</div>}>
            <M3ePage />
          </Suspense>
        </div>
      )}
      {/* ─── BOOKMARKS VIEW ─── */}
      {myspaceView === "bookmarks" && (
        <div
          style={{ display: "flex", flex: 1, minHeight: 0, overflow: "hidden", margin: "8px 12px" }}
        >
          <BookmarksView
            onOpenNote={(p) => {
              setMyspaceView("notes");
              void openFile(p);
            }}
          />
        </div>
      )}
      {/* ─── SYNC VIEW ─── */}
      {myspaceView === "sync" && (
        <div
          style={{ display: "flex", flex: 1, minHeight: 0, overflow: "hidden", margin: "8px 12px" }}
        >
          <GitSyncView />
        </div>
      )}
      {/* Полноэкранный граф: портал в #overlay-root + панель по прямоугольнику
        контентной области (.graph-fs-* в notes.css). Раньше оверлей жил внутри
        .content-area (z-index:1) и центрировался по окну, из-за чего часть графа
        уходила под вертикальный рельс страниц, а снизу оставалась пустая полоса
        от старого нижнего меню. */}
      {ocrDlg && pageActive && (
        <OcrDialog prefs={ocrPrefs} onChange={setOcrPrefs} onClose={() => setOcrDlg(false)} />
      )}
      {graphFullscreen &&
        pageActive &&
        createPortal(
          <GraphFullscreen setGraphFullscreen={setGraphFullscreen} setGraphDepth={setGraphDepth} setGraphShowOrphans={setGraphShowOrphans} setGraphSearch={setGraphSearch} graphShowOrphans={graphShowOrphans} graphDepth={graphDepth} graphSearch={graphSearch} graphData={graphData} openFile={openFile} />,
          getOverlayRoot() ?? document.body,
        )}
      {/* --- Окно выбора провайдера и модели для ИИ-оформления заметок.
            Сохраняется сразу при выборе (myspace.ai.*), поэтому повторять
            настройку в следующий раз не нужно. Открывается и по кнопке с
            ползунками, и автоматически, если сервис отверг имя модели:
            тогда ниже появляются чипсы с именами, которые он принимает. --- */}
      {aiCfgOpen &&
        createPortal(
          <NotesAiModal setAiCfgOpen={setAiCfgOpen} t={t} aiCfg={aiCfg} aiBusyCfg={aiBusyCfg} saveAiCfg={saveAiCfg} aiCfgModels={aiCfgModels} loadAiModels={loadAiModels} aiModels={aiModels} modelChoices={modelChoices} pickModelChoice={pickModelChoice} aiCfgError={aiCfgError} />,
          getOverlayRoot() ?? document.body,
        )}
    </div>
  );
}
