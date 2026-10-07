/**
 * Выделено из MonitorPage.tsx при разбиении крупного файла (поведение не менялось).
 */
import type { DiskNode, DiskExtStat, DiskScanStatus } from "@/api/types";
import React, { useState, useEffect } from "react";
import {
  Files,
  Folder,
  File as FileIcon,
  HardDrive,
  Copy,
  FolderOpen,
  TerminalSquare,
  Archive,
  Trash2,
  FolderSearch,
  StopCircle,
  RefreshCw,
  ChevronLeft,
} from "lucide-react";
import { useI18n } from "@/app/i18n";
import { EmptyHint, Glass, Btn, Badge } from "@/components/ui";
import { useContextMenu, copyToClipboard } from "@/components/ContextMenu";
import { api } from "@/api/client";
import { SubHead } from "@/pages/monitor/parts/MonitorSensors";

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

/**
 * Список папок/файлов текущего уровня — иконка, имя, полоска относительного
 * веса (% от самого тяжёлого элемента уровня) и размер справа, как в
 * обычном проводнике/WinDirStat-списке. Пришли к этому виду вместо
 * treemap-квадратиков (recharts на реальных данных диска либо не
 * рендерился, либо ломался необъяснимо, а свой squarify-treemap на
 * практике читался хуже обычного списка).
 */
function DiskList({
  nodes,
  onOpenDir,
  onOpenBucket,
  onMenu,
}: {
  nodes: DiskNode[];
  onOpenDir: (n: DiskNode) => void;
  onOpenBucket: (n: DiskNode) => void;
  onMenu: (n: DiskNode, e: React.MouseEvent) => void;
}) {
  const maxSize = Math.max(1, ...nodes.map((n) => n.size));
  return (
    <div className="disk-list">
      {nodes.map((n, i) => {
        const clickable = (n.isDir && (n.hasChildren || n.fileCount > 0)) || n.isFilesBucket;
        const pct = Math.max(1.5, (n.size / maxSize) * 100);
        const Icon = n.isFilesBucket ? Files : n.isDir ? Folder : FileIcon;
        return (
          <div
            key={`${n.path}|${n.name}|${i}`}
            className="disk-list-row"
            title={n.path || n.name}
            onClick={() => {
              if (n.isFilesBucket) onOpenBucket(n);
              else if (n.isDir) onOpenDir(n);
            }}
            onContextMenu={(e) => {
              if (n.path) onMenu(n, e);
            }}
            style={{ cursor: clickable ? "pointer" : "default" }}
          >
            <div className="disk-list-bar" style={{ width: `${pct}%` }} />
            <Icon size={14} className="disk-list-icon" />
            <span className="disk-list-name">{n.name}</span>
            <span className="disk-list-meta muted-sm mono-val">
              {n.fileCount > 1 ? `${n.fileCount} · ` : ""}
              {fmtBytes(n.size)}
            </span>
          </div>
        );
      })}
    </div>
  );
}

/** Правая панель — разбивка ВСЕГО скана по расширениям файлов: .mp4, .zip
 *  и т.д. с суммарным весом и числом файлов. Клик — самые тяжёлые файлы
 *  этого расширения (см. api.diskScanExtFiles). */
function DiskExtPanel({
  exts,
  selected,
  onSelect,
}: {
  exts: DiskExtStat[];
  selected: string | null;
  onSelect: (ext: string) => void;
}) {
  const { t } = useI18n();
  const maxSize = Math.max(1, ...exts.map((e) => e.size));
  if (exts.length === 0) return <EmptyHint icon={HardDrive} text={t("monitor.diskScanEmptyDir")} />;
  return (
    <div className="disk-list">
      {exts.map((e) => (
        <div
          key={e.ext}
          className={`disk-list-row${selected === e.ext ? " is-active" : ""}`}
          onClick={() => onSelect(e.ext)}
          style={{ cursor: "pointer" }}
        >
          <div
            className="disk-list-bar"
            style={{ width: `${Math.max(1.5, (e.size / maxSize) * 100)}%` }}
          />
          <span className="disk-list-name">.{e.ext || t("monitor.diskScanNoExt")}</span>
          <span className="disk-list-meta muted-sm mono-val">
            {e.count} · {fmtBytes(e.size)}
          </span>
        </div>
      ))}
    </div>
  );
}

/**
 * Анализатор занятого места на диске (аналог WinDirStat): выбор корня →
 * фоновое сканирование (server/ts/diskScan.ts, попадает в общий Task Manager
 * как engine "diskscan") → список папок/файлов (DiskList выше) с drill-down
 * по клику плюс панель расширений (DiskExtPanel) справа. Каждый уровень
 * дерева подгружается лениво с сервера (api.diskScanResult(jobId, path)) —
 * полное дерево на клиент целиком не скачивается, только уже развёрнутые по
 * пути уровни, поэтому даже на полном диске в памяти рендерера не оседают
 * десятки МБ JSON.
 */
export function DiskScanPanel() {
  const { t } = useI18n();
  const [roots, setRoots] = useState<string[]>([]);
  const [customPath, setCustomPath] = useState("");
  const [jobId, setJobId] = useState<string | null>(null);
  const [status, setStatus] = useState<DiskScanStatus | null>(null);
  const [pathStack, setPathStack] = useState<DiskNode[]>([]);
  const [error, setError] = useState("");
  const [info, setInfo] = useState("");
  const [levelLoading, setLevelLoading] = useState(false);
  const [exts, setExts] = useState<DiskExtStat[]>([]);
  const [extSelected, setExtSelected] = useState<string | null>(null);
  const [extFiles, setExtFiles] = useState<DiskNode[]>([]);
  const menu = useContextMenu();

  // Клик по папке — подгружаем ОДИН уровень (сама папка + её прямые дети, без
  // внуков) лениво с сервера вместо того, чтобы держать всё дерево на клиенте
  // сразу (см. api.diskScanResult / server/ts/diskScan.ts:getNode).
  const openDir = async (node: DiskNode) => {
    if (!jobId) return;
    setLevelLoading(true);
    try {
      const level = await api.diskScanResult(jobId, node.path);
      setPathStack((s) => [...s, level]);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLevelLoading(false);
    }
  };

  // Клик по бакету "Файлы (N)" — реальный список файлов этой ОДНОЙ папки
  // считается лениво на сервере (см. server/ts/diskScan.ts:listFiles), а не
  // хранится заранее в дереве, поэтому запрашиваем его только сейчас.
  const openFilesBucket = async (bucket: DiskNode) => {
    setLevelLoading(true);
    try {
      const { files } = await api.diskScanFiles(bucket.path);
      setPathStack((s) => [...s, { ...bucket, children: files }]);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLevelLoading(false);
    }
  };

  // Убрать плитку из текущего уровня (или из списка файлов расширения) после
  // успешного действия (удаление) — без повторного похода на сервер.
  const removeFromCurrentLevel = (nodePath: string) => {
    setPathStack((s) => {
      const stack = [...s];
      const top = stack[stack.length - 1];
      if (top?.children) {
        stack[stack.length - 1] = {
          ...top,
          children: top.children.filter((c) => c.path !== nodePath),
        };
      }
      return stack;
    });
    setExtFiles((files) => files.filter((f) => f.path !== nodePath));
  };

  // Панель расширений (справа) — клик выбирает/снимает выбор и лениво тянет
  // самые тяжёлые файлы этого расширения (см. server/ts/diskScan.ts:getExtFiles).
  const selectExt = async (ext: string) => {
    if (!jobId) return;
    if (extSelected === ext) {
      setExtSelected(null);
      setExtFiles([]);
      return;
    }
    setExtSelected(ext);
    setLevelLoading(true);
    try {
      const { files } = await api.diskScanExtFiles(jobId, ext);
      setExtFiles(files);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLevelLoading(false);
    }
  };

  const handleDelete = async (node: DiskNode) => {
    if (!window.confirm(t("monitor.diskScanDeleteConfirm", { name: node.name }))) return;
    try {
      await api.diskScanDelete(node.path, node.isDir);
      removeFromCurrentLevel(node.path);
      setInfo(t("monitor.diskScanDeleteDone", { name: node.name }));
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const handleCompress = async (node: DiskNode) => {
    try {
      const { dest } = await api.diskScanCompress(node.path);
      setInfo(t("monitor.diskScanCompressStarted", { name: dest }));
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const openMenuFor = (node: DiskNode, e: React.MouseEvent) => {
    // Псевдо-узлы ("…ещё N элементов", бакет "Файлы (N)") не соответствуют
    // одному реальному пути на диске — действия над ними не имеют смысла.
    if (node.isFilesBucket) return;
    menu.open(e, [
      {
        label: t("monitor.diskScanCopyPath"),
        icon: Copy,
        onClick: () => void copyToClipboard(node.path),
      },
      {
        label: t("monitor.diskScanReveal"),
        icon: FolderOpen,
        onClick: () =>
          void api.diskScanReveal(node.path).catch((e) => setError((e as Error).message)),
      },
      {
        label: t("monitor.diskScanOpenConsole"),
        icon: TerminalSquare,
        onClick: () =>
          void api
            .diskScanConsole(node.path, node.isDir)
            .catch((e) => setError((e as Error).message)),
      },
      {
        label: t("monitor.diskScanCompress"),
        icon: Archive,
        onClick: () => void handleCompress(node),
      },
      { separator: true },
      {
        label: node.isDir ? t("monitor.diskScanDeleteDir") : t("monitor.diskScanDeleteFile"),
        icon: Trash2,
        danger: true,
        onClick: () => void handleDelete(node),
      },
    ]);
  };

  useEffect(() => {
    api
      .diskScanRoots()
      .then((r) => setRoots(r.roots))
      .catch(() => setRoots([]));
  }, []);

  useEffect(() => {
    if (!jobId) return undefined;
    let stopped = false;
    // poll сам останавливает интервал по достижении финальной стадии —
    // раньше условие в setInterval сверялось с `status` из замыкания
    // эффекта (навсегда равным null, потому что эффект перезапускается
    // только по jobId), из-за чего опрос и повторное скачивание всего
    // результата продолжались раз в секунду бесконечно даже после
    // завершения скана — отсюда неконтролируемый рост памяти и зависание
    // после готового результата. `poll` ссылается на `timer` из
    // замыкания — это безопасно, т.к. само тело функции выполняется
    // асинхронно (после await), к этому моменту `timer` уже проинициализирован
    // ниже по коду.
    const poll = async () => {
      try {
        const st = await api.diskScanStatus(jobId);
        if (stopped) return;
        setStatus(st);
        if (st.stage === "done") {
          clearInterval(timer);
          const [result, extRes] = await Promise.all([
            api.diskScanResult(jobId),
            api.diskScanExts(jobId),
          ]);
          if (!stopped) {
            setPathStack([result]);
            setExts(extRes.exts);
          }
        } else if (st.stage === "error" || st.stage === "cancelled") {
          clearInterval(timer);
          if (st.stage === "error") setError(st.error || "Ошибка сканирования");
        }
      } catch (e) {
        clearInterval(timer);
        if (!stopped) setError((e as Error).message);
      }
    };
    void poll();
    const timer = setInterval(() => void poll(), 1000);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [jobId]);

  const start = async (root: string) => {
    setError("");
    setInfo("");
    setPathStack([]);
    setStatus(null);
    setExts([]);
    setExtSelected(null);
    setExtFiles([]);
    try {
      const { id } = await api.diskScanStart(root);
      setJobId(id);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const cancel = async () => {
    if (jobId) await api.diskScanCancel(jobId);
    // Сбрасываем jobId и status вместе: иначе последний опрошенный статус
    // (ещё "scanning") остаётся висеть в state после остановки поллинга,
    // и кнопки запуска нового скана остаются задизейблены навсегда.
    setJobId(null);
    setStatus(null);
  };

  const current = pathStack[pathStack.length - 1] || null;
  const listData = current?.children?.filter((c) => c.size > 0) || [];

  return (
    <Glass className="chart-panel">
      <SubHead>{t("monitor.diskScan")}</SubHead>
      <div className="muted-sm" style={{ marginBottom: 8 }}>
        {t("monitor.diskScanHint")}
      </div>

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 10 }}>
        {roots.map((r) => (
          <Btn
            key={r}
            icon={HardDrive}
            onClick={() => void start(r)}
            disabled={status?.stage === "scanning"}
          >
            {r}
          </Btn>
        ))}
        <input
          className="text-input"
          style={{ width: 220 }}
          placeholder={t("monitor.diskScanCustomPath")}
          value={customPath}
          onChange={(e) => setCustomPath(e.target.value)}
        />
        <Btn
          icon={FolderSearch}
          disabled={!customPath.trim() || status?.stage === "scanning"}
          onClick={() => void start(customPath.trim())}
        >
          {t("monitor.diskScanStart")}
        </Btn>
        {status?.stage === "scanning" && (
          <Btn icon={StopCircle} onClick={() => void cancel()}>
            {t("monitor.diskScanCancel")}
          </Btn>
        )}
      </div>

      {status?.stage === "scanning" && (
        <div className="muted-sm" style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <RefreshCw size={14} className="spin" />
          {t("monitor.diskScanProgress", { n: status.scannedEntries })}
        </div>
      )}

      {error && (
        <div className="muted-sm" style={{ color: "var(--coral)" }}>
          {error}
        </div>
      )}

      {info && (
        <div className="muted-sm" style={{ color: "var(--teal, #3fc7ab)" }}>
          {info}
        </div>
      )}

      {levelLoading && (
        <div className="muted-sm" style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <RefreshCw size={14} className="spin" />
          {t("monitor.diskScanFilesLoading")}
        </div>
      )}

      {current && (
        <div style={{ display: "flex", gap: 14, alignItems: "flex-start" }}>
          <div style={{ flex: "2 1 0", minWidth: 0 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, margin: "8px 0" }}>
              {extSelected ? (
                <button
                  type="button"
                  className="icon-btn"
                  onClick={() => {
                    setExtSelected(null);
                    setExtFiles([]);
                  }}
                  title={t("monitor.diskScanUp")}
                >
                  <ChevronLeft size={15} />
                </button>
              ) : (
                pathStack.length > 1 && (
                  <button
                    type="button"
                    className="icon-btn"
                    onClick={() => setPathStack((s) => s.slice(0, -1))}
                    title={t("monitor.diskScanUp")}
                  >
                    <ChevronLeft size={15} />
                  </button>
                )
              )}
              {extSelected ? (
                <>
                  <Badge tone="amber" mono>
                    .{extSelected || t("monitor.diskScanNoExt")}
                  </Badge>
                  <span className="muted-sm">{t("monitor.diskScanExtFilesTitle")}</span>
                </>
              ) : (
                <>
                  <Badge tone="teal" mono>
                    {fmtBytes(current.size)}
                  </Badge>
                  <span className="muted-sm">{current.path || current.name}</span>
                </>
              )}
            </div>

            {extSelected ? (
              extFiles.length === 0 ? (
                <EmptyHint icon={HardDrive} text={t("monitor.diskScanEmptyDir")} />
              ) : (
                <div className="disk-list-scroll">
                  <DiskList
                    nodes={extFiles}
                    onOpenDir={() => {
                      /* файлы расширения — папок среди них не бывает */
                    }}
                    onOpenBucket={() => {
                      /* бакетов среди файлов расширения не бывает */
                    }}
                    onMenu={openMenuFor}
                  />
                </div>
              )
            ) : listData.length === 0 ? (
              <EmptyHint icon={HardDrive} text={t("monitor.diskScanEmptyDir")} />
            ) : (
              <div className="disk-list-scroll">
                <DiskList
                  nodes={listData}
                  onOpenDir={(n) => void openDir(n)}
                  onOpenBucket={(n) => void openFilesBucket(n)}
                  onMenu={openMenuFor}
                />
              </div>
            )}
          </div>

          <div style={{ flex: "1 1 0", minWidth: 220, maxWidth: 320 }}>
            <div className="muted-sm" style={{ margin: "8px 0" }}>
              {t("monitor.diskScanExtTitle")}
            </div>
            <div className="disk-list-scroll">
              <DiskExtPanel
                exts={exts}
                selected={extSelected}
                onSelect={(ext) => void selectExt(ext)}
              />
            </div>
          </div>
        </div>
      )}
    </Glass>
  );
}

export function fmtDuration(totalSeconds: number): string {
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  if (h > 0) return `${h} ч ${m} мин`;
  if (m > 0) return `${m} мин`;
  return `${totalSeconds} с`;
}
