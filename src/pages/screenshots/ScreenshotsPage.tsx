import { useRef, useState, useEffect, useCallback, useMemo } from "react";
import { createPortal } from "react-dom";
import {
  Camera,
  Video,
  Square,
  Copy,
  Download,
  Eraser,
  AlertTriangle,
  Pencil,
  ArrowUpRight,
  Blend,
  ScanText,
  X,
  Crop,
  Trash2,
  Play,
  Image as ImageIcon,
} from "lucide-react";
import { Glass, Btn, IconBtn, Field, Select, SectionHead, EmptyHint, Badge } from "@/components/ui";
import { getOverlayRoot } from "@/components/overlayHost";
import { useI18n } from "@/app/i18n";
import { saveBlob } from "@/lib/download";
import { api } from "@/api/client";
import type { ScreenshotItem } from "@/api/types";
import VideoPlayer from "@/pages/movies/parts/VideoPlayer";

type AnnotateTool = "pen" | "arrow" | "blur" | "ocrArea";

interface Point {
  x: number;
  y: number;
}

interface CaptureSource {
  id: string;
  name: string;
  kind: "screen" | "window";
  thumbnail: string | null;
  /** Реальное разрешение монитора (физические пиксели) — только для экранов,
   *  см. electron/main.js → capture:list-sources. */
  width?: number;
  height?: number;
}

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

// Масштаб ОТ РЕАЛЬНОГО разрешения выбранного монитора (не фиксированные
// 1920x1080 и т.п.) — мониторы бывают разных пропорций (16:9, ультраширокий
// 21:9, вертикальный 9:16), и фиксированный список "под 16:9" на них просто
// не подходит. Само разрешение источника узнаётся уже ПОСЛЕ getDisplayMedia
// (см. startRecording → track.getSettings()), проценты применяются к нему.
const SCALES = [
  { value: "100", pct: 1 },
  { value: "75", pct: 0.75 },
  { value: "50", pct: 0.5 },
  { value: "25", pct: 0.25 },
] as const;

const FPS_OPTIONS = [15, 24, 30, 60];
const BITRATE_OPTIONS = [2, 5, 8, 15, 25, 40];

const CODEC_CANDIDATES = [
  { id: "vp9", mime: "video/webm;codecs=vp9" },
  { id: "av1", mime: "video/webm;codecs=av1" },
  { id: "h264", mime: "video/webm;codecs=h264" },
  { id: "vp8", mime: "video/webm;codecs=vp8" },
];

function drawArrow(ctx: CanvasRenderingContext2D, from: Point, to: Point): void {
  const dist = Math.hypot(to.x - from.x, to.y - from.y);
  if (dist < 2) return;
  const headLen = Math.max(10, Math.min(24, dist * 0.25));
  const angle = Math.atan2(to.y - from.y, to.x - from.x);
  ctx.strokeStyle = "#ea6b6b";
  ctx.fillStyle = "#ea6b6b";
  ctx.lineWidth = 4;
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(from.x, from.y);
  ctx.lineTo(to.x, to.y);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(to.x, to.y);
  ctx.lineTo(to.x - headLen * Math.cos(angle - Math.PI / 6), to.y - headLen * Math.sin(angle - Math.PI / 6));
  ctx.lineTo(to.x - headLen * Math.cos(angle + Math.PI / 6), to.y - headLen * Math.sin(angle + Math.PI / 6));
  ctx.closePath();
  ctx.fill();
}

function rectFrom(a: Point, b: Point): Rect {
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) };
}

function drawRectPreview(ctx: CanvasRenderingContext2D, a: Point, b: Point, color = "#4fc3d9"): void {
  const r = rectFrom(a, b);
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.setLineDash([6, 4]);
  ctx.strokeRect(r.x, r.y, r.w, r.h);
  ctx.restore();
}

/** Гауссов блюр региона через встроенный CanvasRenderingContext2D.filter — без внешних либ. */
function applyBlurRect(ctx: CanvasRenderingContext2D, canvas: HTMLCanvasElement, a: Point, b: Point): void {
  const r = rectFrom(a, b);
  if (r.w < 2 || r.h < 2) return;
  const pad = 12;
  const sx = Math.max(0, Math.floor(r.x - pad));
  const sy = Math.max(0, Math.floor(r.y - pad));
  const sw = Math.min(canvas.width, Math.ceil(r.x + r.w + pad)) - sx;
  const sh = Math.min(canvas.height, Math.ceil(r.y + r.h + pad)) - sy;
  if (sw < 1 || sh < 1) return;
  const tmp = document.createElement("canvas");
  tmp.width = sw;
  tmp.height = sh;
  const tctx = tmp.getContext("2d");
  if (!tctx) return;
  tctx.filter = "blur(8px)";
  tctx.drawImage(canvas, sx, sy, sw, sh, 0, 0, sw, sh);
  ctx.drawImage(tmp, r.x - sx, r.y - sy, r.w, r.h, r.x, r.y, r.w, r.h);
}

/** Вырезает прямоугольник канваса в отдельный canvas (для обрезки/OCR по области). */
function extractRect(canvas: HTMLCanvasElement, r: Rect): HTMLCanvasElement | null {
  const w = Math.max(1, Math.round(r.w));
  const h = Math.max(1, Math.round(r.h));
  if (r.w < 2 || r.h < 2) return null;
  const out = document.createElement("canvas");
  out.width = w;
  out.height = h;
  const octx = out.getContext("2d");
  if (!octx) return null;
  octx.drawImage(canvas, r.x, r.y, w, h, 0, 0, w, h);
  return out;
}

/**
 * Выбор прямоугольной области перетаскиванием поверх статичного превью-кадра.
 * Возвращает координаты в НАТУРАЛЬНЫХ пикселях исходного изображения (не CSS),
 * поэтому годится и для обрезки скриншота, и для ограничения области записи.
 */
function AreaPicker({
  src,
  onConfirm,
  onCancel,
  confirmLabel,
  fullLabel,
  cancelLabel,
}: {
  src: string;
  onConfirm: (r: Rect) => void;
  onCancel: () => void;
  confirmLabel: string;
  fullLabel: string;
  cancelLabel: string;
}) {
  const imgRef = useRef<HTMLImageElement>(null);
  const [natural, setNatural] = useState({ w: 1, h: 1 });
  const [rect, setRect] = useState<Rect | null>(null);
  const dragStart = useRef<Point | null>(null);

  const toNatural = useCallback(
    (clientX: number, clientY: number): Point => {
      const el = imgRef.current;
      if (!el) return { x: 0, y: 0 };
      const b = el.getBoundingClientRect();
      const scaleX = natural.w / b.width;
      const scaleY = natural.h / b.height;
      const x = Math.min(natural.w, Math.max(0, (clientX - b.left) * scaleX));
      const y = Math.min(natural.h, Math.max(0, (clientY - b.top) * scaleY));
      return { x, y };
    },
    [natural],
  );

  const onDown = (e: React.PointerEvent) => {
    const p = toNatural(e.clientX, e.clientY);
    dragStart.current = p;
    setRect({ x: p.x, y: p.y, w: 0, h: 0 });
  };
  const onMove = (e: React.PointerEvent) => {
    if (!dragStart.current) return;
    const p = toNatural(e.clientX, e.clientY);
    setRect(rectFrom(dragStart.current, p));
  };
  const onUp = () => {
    dragStart.current = null;
  };

  const displayScale = imgRef.current ? imgRef.current.getBoundingClientRect().width / natural.w : 1;

  return (
    <Glass style={{ display: "flex", flexDirection: "column", alignItems: "stretch", gap: 10, padding: 12 }}>
      <div className="muted-sm">{confirmLabel}</div>
      {/* Ширина всегда = ширине контейнера, высота свободная (не сжимается
          отдельным maxHeight на самой картинке) — для широких мониторов этого
          достаточно, чтобы уместиться; для вертикальных (портретных, 9:16)
          картинка при ширине контейнера получается выше окна — тогда скроллит
          именно эта обёртка, а не сжимает превью до нечитаемого размера. */}
      <div style={{ position: "relative", maxHeight: "65vh", overflowY: "auto" }}>
        <img
          ref={imgRef}
          src={src}
          draggable={false}
          onLoad={(e) => {
            const el = e.currentTarget;
            setNatural({ w: el.naturalWidth || 1, h: el.naturalHeight || 1 });
          }}
          style={{ width: "100%", height: "auto", display: "block", cursor: "crosshair" }}
          onPointerDown={onDown}
          onPointerMove={onMove}
          onPointerUp={onUp}
          onPointerLeave={onUp}
        />
        {rect && rect.w > 1 && rect.h > 1 && (
          <div
            style={{
              position: "absolute",
              left: rect.x * displayScale,
              top: rect.y * displayScale,
              width: rect.w * displayScale,
              height: rect.h * displayScale,
              border: "2px dashed var(--teal, #4fc3d9)",
              background: "rgba(79,195,217,0.12)",
              pointerEvents: "none",
            }}
          />
        )}
      </div>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <Btn
          variant="primary"
          icon={Crop}
          disabled={!rect || rect.w < 4 || rect.h < 4}
          onClick={() => rect && onConfirm(rect)}
        >
          {confirmLabel}
        </Btn>
        <Btn icon={ImageIcon} onClick={() => onConfirm({ x: 0, y: 0, w: natural.w, h: natural.h })}>
          {fullLabel}
        </Btn>
        <Btn icon={X} onClick={onCancel}>
          {cancelLabel}
        </Btn>
      </div>
    </Glass>
  );
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function fmtTime(s: number): string {
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, "0")}`;
}

/**
 * Скриншоты + запись экрана — через Electron getDisplayMedia (без ffmpeg:
 * MediaRecorder в рендерере пишет webm напрямую). Захват заведён через тот же
 * приём, что уже работает на странице «Лекторий» для системного звука
 * (electron/main.js → installScreenHandler, rec:capture-mode "screen") —
 * теперь ещё и с выбором конкретного экрана/окна (desktopCapturer.getSources).
 *
 * Область: выбирается ПОСЛЕ захвата полного кадра (по образцу Snipping Tool) —
 * для скриншота это обрезка готового кадра, для записи — предпросмотр первого
 * кадра потока, по которому область фиксируется на всё время записи (дальше
 * кадры идут через canvas.captureStream, ограниченный этим прямоугольником).
 *
 * Аннотации: маркер (фрихенд), стрелка (drag) и блюр региона — блюр сделан
 * через встроенный CanvasRenderingContext2D.filter = "blur(...)" на офскрин-
 * канвасе, без внешних библиотек. Отдельный инструмент — выделение области для
 * распознавания текста (OCR по конкретному фрагменту, а не по всему кадру).
 *
 * Библиотека: все скриншоты/записи автоматически сохраняются в
 * storage/screenshots (сервер), список отображается внизу страницы с общим
 * плеером (переиспользован VideoPlayer со страницы «Фильмы»).
 */
export default function ScreenshotsPage() {
  const { t } = useI18n();
  const [error, setError] = useState("");

  // --- Источник захвата (монитор/окно) ---
  const [sources, setSources] = useState<CaptureSource[]>([]);
  const [sourceId, setSourceId] = useState("");
  const [areaMode, setAreaMode] = useState(false);

  const loadSources = useCallback(async () => {
    const list = (await window.appBridge?.listCaptureSources?.()) || [];
    setSources(list);
  }, []);
  useEffect(() => {
    void loadSources();
  }, [loadSources]);

  const sourceOptions = useMemo(
    () => [
      { value: "", label: t("screenshots.sourceAuto") },
      ...sources.map((s) => ({
        value: s.id,
        label: `${s.kind === "screen" ? t("screenshots.kindScreen") : t("screenshots.kindWindow")} · ${s.name}`,
      })),
    ],
    [sources, t],
  );

  // Реальное разрешение выбранного монитора — для списка масштабов записи
  // ниже (см. SCALES/resolutionOptions). У "авто" (sourceId==="") оно
  // неизвестно заранее (getDisplayMedia сам решит, какой экран отдать), у
  // окна (kind:"window") desktopCapturer его не даёт вовсе — тогда список
  // остаётся в процентах, честно, без выдуманных чисел.
  const selectedSourceRes = useMemo(() => {
    const s = sources.find((x) => x.id === sourceId);
    return s?.width && s?.height ? { w: s.width, h: s.height } : null;
  }, [sources, sourceId]);

  // --- Скриншот + аннотации ---
  const [shot, setShot] = useState<string | null>(null); // data URL исходного кадра
  const [cropPending, setCropPending] = useState<string | null>(null); // ждём выбора области
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const drawingRef = useRef(false);
  const lastPtRef = useRef<Point | null>(null);
  const startPtRef = useRef<Point | null>(null);
  const baseSnapshotRef = useRef<ImageData | null>(null); // снимок канваса на момент pointerdown — для превью arrow/blur/ocrArea
  const strokesRef = useRef<ImageData[]>([]); // для undo — снимки канваса перед каждым штрихом
  const [tool, setTool] = useState<AnnotateTool>("pen");

  const uploadImageFromCanvas = useCallback((c: HTMLCanvasElement) => {
    c.toBlob(async (blob) => {
      if (!blob) return;
      try {
        const item = await api.screenshotsSaveImage(blob, { width: c.width, height: c.height });
        setLibrary((prev) => [item, ...prev]);
      } catch {
        /* библиотека необязательна для UX самого скриншота — не блокируем работу */
      }
    }, "image/png");
  }, []);

  const captureFrame = async (): Promise<{ dataUrl: string; w: number; h: number } | null> => {
    await window.appBridge?.setCaptureMode?.("screen", sourceId || null);
    const stream = await navigator.mediaDevices.getDisplayMedia({ video: true });
    const video = document.createElement("video");
    video.srcObject = stream;
    await video.play();
    await new Promise((r) => setTimeout(r, 150));
    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext("2d")?.drawImage(video, 0, 0);
    stream.getTracks().forEach((tr) => tr.stop());
    await window.appBridge?.setCaptureMode?.("default");
    return { dataUrl: canvas.toDataURL("image/png"), w: video.videoWidth, h: video.videoHeight };
  };

  const takeScreenshot = async () => {
    setError("");
    try {
      const frame = await captureFrame();
      if (!frame) return;
      if (areaMode) {
        setCropPending(frame.dataUrl);
      } else {
        setShot(frame.dataUrl);
      }
    } catch (e) {
      await window.appBridge?.setCaptureMode?.("default").catch(() => {});
      setError((e as Error).message || String(e));
    }
  };

  const applyCrop = (dataUrl: string, r: Rect) => {
    const img = new Image();
    img.onload = () => {
      const c = document.createElement("canvas");
      c.width = Math.max(1, Math.round(r.w));
      c.height = Math.max(1, Math.round(r.h));
      c.getContext("2d")?.drawImage(img, r.x, r.y, r.w, r.h, 0, 0, c.width, c.height);
      setShot(c.toDataURL("image/png"));
      setCropPending(null);
    };
    img.src = dataUrl;
  };

  // Загружаем скриншот в редактируемый канвас, как только он готов — и сразу
  // кладём исходный кадр в библиотеку (аннотации остаются локальным сеансом
  // редактирования; для сохранённой версии с разметкой — кнопка «Скачать»).
  useEffect(() => {
    if (!shot || !canvasRef.current) return;
    const img = new Image();
    img.onload = () => {
      const c = canvasRef.current;
      if (!c) return;
      c.width = img.width;
      c.height = img.height;
      c.getContext("2d")?.drawImage(img, 0, 0);
      strokesRef.current = [];
      uploadImageFromCanvas(c);
    };
    img.src = shot;
  }, [shot, uploadImageFromCanvas]);

  const getPos = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const scaleX = e.currentTarget.width / rect.width;
    const scaleY = e.currentTarget.height / rect.height;
    return { x: (e.clientX - rect.left) * scaleX, y: (e.clientY - rect.top) * scaleY };
  };

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const ctx = canvasRef.current?.getContext("2d");
    if (!ctx || !canvasRef.current) return;
    const snapshot = ctx.getImageData(0, 0, canvasRef.current.width, canvasRef.current.height);
    strokesRef.current.push(snapshot);
    if (strokesRef.current.length > 30) strokesRef.current.shift();
    baseSnapshotRef.current = snapshot;
    drawingRef.current = true;
    const p = getPos(e);
    lastPtRef.current = p;
    startPtRef.current = p;
  };

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!drawingRef.current) return;
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!ctx || !canvas || !lastPtRef.current || !startPtRef.current) return;
    const p = getPos(e);

    if (tool === "pen") {
      ctx.strokeStyle = "#ea6b6b";
      ctx.lineWidth = 4;
      ctx.lineCap = "round";
      ctx.beginPath();
      ctx.moveTo(lastPtRef.current.x, lastPtRef.current.y);
      ctx.lineTo(p.x, p.y);
      ctx.stroke();
    } else if (tool === "arrow") {
      if (baseSnapshotRef.current) ctx.putImageData(baseSnapshotRef.current, 0, 0);
      drawArrow(ctx, startPtRef.current, p);
    } else if (tool === "blur") {
      if (baseSnapshotRef.current) ctx.putImageData(baseSnapshotRef.current, 0, 0);
      drawRectPreview(ctx, startPtRef.current, p);
    } else if (tool === "ocrArea") {
      if (baseSnapshotRef.current) ctx.putImageData(baseSnapshotRef.current, 0, 0);
      drawRectPreview(ctx, startPtRef.current, p, "#c98bf0");
    }
    lastPtRef.current = p;
  };

  const onPointerUp = () => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (ctx && canvas && startPtRef.current && lastPtRef.current) {
      if (tool === "blur") {
        if (baseSnapshotRef.current) ctx.putImageData(baseSnapshotRef.current, 0, 0);
        applyBlurRect(ctx, canvas, startPtRef.current, lastPtRef.current);
      } else if (tool === "ocrArea") {
        const r = rectFrom(startPtRef.current, lastPtRef.current);
        const sub = extractRect(canvas, r);
        if (baseSnapshotRef.current) ctx.putImageData(baseSnapshotRef.current, 0, 0);
        if (sub) runOcr(sub);
      }
    }
    drawingRef.current = false;
    lastPtRef.current = null;
    startPtRef.current = null;
    baseSnapshotRef.current = null;
  };

  const undoStroke = () => {
    const ctx = canvasRef.current?.getContext("2d");
    const prev = strokesRef.current.pop();
    if (ctx && prev) ctx.putImageData(prev, 0, 0);
  };

  const copyToClipboard = async () => {
    const c = canvasRef.current;
    if (!c) return;
    c.toBlob(async (blob) => {
      if (!blob) return;
      try {
        await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
        // Иначе вотчер буфера (автосохранение PrintScreen/Win+Shift+S, см.
        // electron/main.js → startClipboardWatch) принял бы эту же картинку
        // за новую внешнюю и задвоил бы библиотеку тем же кадром.
        void window.appBridge?.clipboardMarkSeen?.();
      } catch (e) {
        setError((e as Error).message);
      }
    });
  };

  const downloadShot = () => {
    const c = canvasRef.current;
    if (!c) return;
    c.toBlob((blob) => {
      if (blob) saveBlob(blob, `screenshot_${Date.now()}.png`);
    });
  };

  // --- OCR: распознать текст со скриншота (весь кадр либо выделенная область) ---
  const [ocrBusy, setOcrBusy] = useState(false);
  const [ocrText, setOcrText] = useState<string | null>(null);

  const runOcr = (source: HTMLCanvasElement) => {
    setOcrBusy(true);
    setOcrText(null);
    setError("");
    source.toBlob(async (blob) => {
      if (!blob) {
        setOcrBusy(false);
        return;
      }
      try {
        const r = await api.ocrRecognize(blob);
        setOcrText(r.text.trim());
        if (r.text.trim()) {
          await navigator.clipboard.writeText(r.text.trim()).catch(() => {});
        }
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setOcrBusy(false);
      }
    });
  };

  // --- Настройки записи ---
  const [resolution, setResolution] = useState<string>("100");
  const [fps, setFps] = useState(30);
  const [bitrateMbps, setBitrateMbps] = useState(8);
  const supportedCodecs = useMemo(
    () =>
      typeof MediaRecorder !== "undefined"
        ? CODEC_CANDIDATES.filter((c) => MediaRecorder.isTypeSupported(c.mime))
        : [],
    [],
  );
  const [codec, setCodec] = useState(supportedCodecs[0]?.id || "vp9");
  useEffect(() => {
    if (supportedCodecs.length && !supportedCodecs.some((c) => c.id === codec)) {
      setCodec(supportedCodecs[0].id);
    }
  }, [supportedCodecs, codec]);

  // --- Аудио записи: микрофон / системный звук / оба одновременно ---
  // Микрофон подхватывается автоматически (micDeviceId="" → устройство по
  // умолчанию), но список ниже даёт выбрать конкретное. Системный звук идёт
  // через WASAPI-loopback (electron/main.js), как на странице «Лекторий».
  const [audioSource, setAudioSource] = useState<"none" | "mic" | "system" | "both">("mic");
  const [micDeviceId, setMicDeviceId] = useState("");
  const [micDevices, setMicDevices] = useState<{ deviceId: string; label: string }[]>([]);
  const loadMicDevices = useCallback(async () => {
    try {
      // Разрешение нужно один раз, иначе enumerateDevices() отдаёт пустые label
      // и микрофоны нельзя отличить друг от друга в списке.
      const tmp = await navigator.mediaDevices.getUserMedia({ audio: true });
      tmp.getTracks().forEach((tr) => tr.stop());
    } catch {
      /* доступ не дали — список всё равно попробуем получить, просто без названий */
    }
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      setMicDevices(
        devices
          .filter((d) => d.kind === "audioinput")
          .map((d, i) => ({ deviceId: d.deviceId, label: d.label || `${t("screenshots.micDeviceFallback")} ${i + 1}` })),
      );
    } catch {
      setMicDevices([]);
    }
  }, [t]);
  useEffect(() => {
    void loadMicDevices();
  }, [loadMicDevices]);

  // --- Запись экрана ---
  const [recording, setRecording] = useState(false);
  const [recSeconds, setRecSeconds] = useState(0);
  // rec.onstop — замыкание, созданное ДО начала записи (в beginRecorder),
  // поэтому читать из него состояние recSeconds напрямую нельзя — оно там
  // навсегда останется тем, каким было в момент вызова beginRecorder (обычно
  // 0). Ref обновляется тем же таймером и всегда актуален на момент остановки.
  const recSecondsRef = useRef(0);
  const [recAreaPreview, setRecAreaPreview] = useState<string | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const canvasLoopRef = useRef<number | null>(null);
  const hiddenVideoRef = useRef<HTMLVideoElement | null>(null);
  const canvasStreamRef = useRef<MediaStream | null>(null);
  const recDimsRef = useRef({ w: 0, h: 0 });
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pendingStreamRef = useRef<MediaStream | null>(null);
  // Итоговый аудиотрек записи (микрофон, системный звук, или их микс — см.
  // startRecording) — присоединяется к видеопотоку/канвасу в startRecordingOnStream.
  const pendingAudioTrackRef = useRef<MediaStreamTrack | null>(null);
  const micTrackRef = useRef<MediaStreamTrack | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  // На Linux Chromium может не дать системный звук через xdg-desktop-portal
  // (композитор без поддержки share-audio, PulseAudio без нужного портала) —
  // в этом случае стрим из getDisplayMedia приходит вовсе без аудиотрека, и
  // мы запускаем резервный захват через PulseAudio/PipeWire monitor-источник
  // (см. window.appBridge.startLinuxSystemAudioFallback). Флаг решает, нужно
  // ли при остановке записи забирать WAV и передавать его на муксинг.
  const linuxAudioFallbackActiveRef = useRef(false);

  /** Микрофон отдельным getUserMedia — системный звук уже приходит вместе с
   *  видео (getDisplayMedia audio:"loopback"), микрофон так не получить. */
  const acquireMicTrack = async (): Promise<MediaStreamTrack | null> => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: micDeviceId ? { deviceId: { exact: micDeviceId } } : true,
      });
      const track = stream.getAudioTracks()[0] || null;
      micTrackRef.current = track;
      return track;
    } catch (e) {
      setError((e as Error).message || String(e));
      return null;
    }
  };

  /** Один источник — трек как есть; два — сводятся через Web Audio API в один
   *  трек (MediaRecorder использует только первый аудиотрек потока, так что
   *  просто добавить оба трека в стрим недостаточно). */
  const mixAudioTracks = (tracks: MediaStreamTrack[]): MediaStreamTrack | null => {
    if (tracks.length === 0) return null;
    if (tracks.length === 1) return tracks[0];
    const ctx = new AudioContext();
    audioCtxRef.current = ctx;
    const dest = ctx.createMediaStreamDestination();
    for (const tr of tracks) ctx.createMediaStreamSource(new MediaStream([tr])).connect(dest);
    return dest.stream.getAudioTracks()[0] || null;
  };

  const pickMime = () => {
    const c = supportedCodecs.find((x) => x.id === codec) || supportedCodecs[0];
    return c?.mime || "video/webm";
  };

  const beginRecorder = (stream: MediaStream, w: number, h: number) => {
    chunksRef.current = [];
    recDimsRef.current = { w, h };
    const rec = new MediaRecorder(stream, {
      mimeType: pickMime(),
      videoBitsPerSecond: Math.round(bitrateMbps * 1_000_000),
      // Раньше не задавался вовсе (браузерный дефолт для голоса — заметно
      // ниже) — отсюда "звук отвратительный". 192 kbps хватает и для музыки,
      // и для системного звука.
      audioBitsPerSecond: 192_000,
    });
    rec.ondataavailable = (e) => {
      if (e.data.size > 0) chunksRef.current.push(e.data);
    };
    rec.onstop = async () => {
      const raw = new Blob(chunksRef.current, { type: "video/webm" });
      // Резервный аудиозахват (см. linuxAudioFallbackActiveRef) пишет свой WAV
      // независимо от MediaRecorder — забираем его путь ПЕРЕД загрузкой видео,
      // чтобы сервер мог смуксировать обе дорожки за один прогон ffmpeg.
      let extraAudioPath: string | null = null;
      if (linuxAudioFallbackActiveRef.current) {
        linuxAudioFallbackActiveRef.current = false;
        try {
          const r = await window.appBridge?.stopLinuxSystemAudioFallback?.();
          extraAudioPath = r?.path || null;
        } catch {
          /* резервный захват не запускался/уже остановлен — просто без звука */
        }
      }
      try {
        // Сервер перегоняет webm в mp4 через ffmpeg (server/screenshots.js →
        // finalizeRecording) — правильная длительность в контейнере и формат,
        // который проигрывается везде. durationSec отсюда — только запасной
        // вариант на случай, если ffmpeg не найден (см. finalizeRecording).
        const item = await api.screenshotsSaveVideo(raw, {
          width: recDimsRef.current.w,
          height: recDimsRef.current.h,
          durationSec: recSecondsRef.current,
          bitrateMbps,
          extraAudioPath,
        });
        setLibrary((prev) => [item, ...prev]);
        const resp = await fetch(api.screenshotFileUrl(item.id));
        const outBlob = await resp.blob();
        const ext = item.file.split(".").pop() || "webm";
        saveBlob(outBlob, `recording_${Date.now()}.${ext}`);
      } catch (e) {
        // Библиотека/перекодирование не удались — хотя бы не теряем саму запись.
        saveBlob(raw, `recording_${Date.now()}.webm`);
        setError((e as Error).message || String(e));
      }
    };
    rec.start(1000);
    recorderRef.current = rec;
    setRecording(true);
    setRecSeconds(0);
    recSecondsRef.current = 0;
    timerRef.current = setInterval(() => {
      recSecondsRef.current += 1;
      setRecSeconds(recSecondsRef.current);
    }, 1000);
  };

  const startRecordingOnStream = (stream: MediaStream, cropRect: Rect | null) => {
    const track = stream.getVideoTracks()[0];
    const settings = track?.getSettings?.() || {};
    const srcW = Number(settings.width) || 1920;
    const srcH = Number(settings.height) || 1080;
    const audioTrack = pendingAudioTrackRef.current;

    if (!cropRect) {
      streamRef.current = stream;
      // Без обрезки область — пишем видеотрек напрямую (без канваса и цикла
      // requestAnimationFrame), это заметно легче для CPU/GPU: MediaRecorder
      // сам умеет аппаратное кодирование готового потока, а перерисовка через
      // canvas такой возможности лишает (см. ветку с cropRect ниже).
      const finalStream = audioTrack ? new MediaStream([track, audioTrack]) : stream;
      beginRecorder(finalStream, srcW, srcH);
      return;
    }

    // Область записи: рисуем обрезанный кадр в скрытый canvas в цикле кадров
    // и пишем именно его captureStream — MediaRecorder не умеет "обрезать"
    // готовый MediaStream сам по себе.
    const video = document.createElement("video");
    video.srcObject = stream;
    video.muted = true;
    hiddenVideoRef.current = video;
    streamRef.current = stream;
    void video.play().then(() => {
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(cropRect.w));
      canvas.height = Math.max(1, Math.round(cropRect.h));
      const ctx = canvas.getContext("2d");
      // requestAnimationFrame сам по себе идёт с частотой обновления монитора
      // (например, 144 Гц), а не с выбранным FPS записи — без троттлинга
      // canvas перерисовывался бы в разы чаще, чем реально уходит в запись
      // (captureStream(fps) всё равно берёт только нужные кадры, лишняя
      // отрисовка — чистая трата CPU/GPU). Рисуем не чаще, чем 1000/fps мс.
      const minFrameMs = 1000 / Math.max(1, fps);
      let lastDrawAt = 0;
      const draw = (ts: number) => {
        if (ts - lastDrawAt >= minFrameMs) {
          lastDrawAt = ts;
          if (ctx) ctx.drawImage(video, cropRect.x, cropRect.y, cropRect.w, cropRect.h, 0, 0, canvas.width, canvas.height);
        }
        canvasLoopRef.current = requestAnimationFrame(draw);
      };
      canvasLoopRef.current = requestAnimationFrame(draw);
      const cStream = canvas.captureStream(fps);
      if (audioTrack) cStream.addTrack(audioTrack);
      canvasStreamRef.current = cStream;
      beginRecorder(cStream, canvas.width, canvas.height);
    });
  };

  const startRecording = async () => {
    setError("");
    try {
      const needSystemAudio = audioSource === "system" || audioSource === "both";
      const needMic = audioSource === "mic" || audioSource === "both";

      await window.appBridge?.setCaptureMode?.(needSystemAudio ? "screenAudio" : "screen", sourceId || null);
      // Без width/height-ограничений — получаем РЕАЛЬНОЕ разрешение выбранного
      // монитора (какое бы оно ни было: 16:9/21:9/9:16), масштаб применяется
      // отдельно ниже через applyConstraints, когда оно уже известно.
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: { ideal: fps } },
        audio: needSystemAudio,
      });
      await window.appBridge?.setCaptureMode?.("default");

      const scale = SCALES.find((s) => s.value === resolution)?.pct ?? 1;
      if (scale < 1) {
        const vTrack = stream.getVideoTracks()[0];
        const native = vTrack?.getSettings?.() || {};
        const nativeW = Number(native.width) || 1920;
        const nativeH = Number(native.height) || 1080;
        try {
          await vTrack?.applyConstraints({
            width: Math.round(nativeW * scale),
            height: Math.round(nativeH * scale),
          });
        } catch {
          /* не критично — просто пишем в нативном разрешении источника */
        }
      }

      // Аудио собираем ДО предпросмотра области — иначе пришлось бы просить
      // микрофон повторно после подтверждения прямоугольника.
      const tracks: MediaStreamTrack[] = [];
      if (needSystemAudio) {
        const sysTrack = stream.getAudioTracks()[0];
        if (sysTrack) {
          tracks.push(sysTrack);
        } else if (window.appBridge?.platform !== "win32") {
          // Chromium/xdg-desktop-portal не приложил звук к видеопотоку —
          // пробуем резервный захват через PulseAudio/PipeWire (Linux). На
          // Windows этой ветки не бывает: там audio:"loopback" либо даёт
          // трек, либо система реально не поддерживает WASAPI loopback (что
          // само по себе означало бы более серьёзную проблему, чем этот код
          // может исправить).
          const r = await window.appBridge?.startLinuxSystemAudioFallback?.();
          if (r?.ok) linuxAudioFallbackActiveRef.current = true;
          else if (r?.error) setError(r.error);
        }
      }
      if (needMic) {
        const micTrack = await acquireMicTrack();
        if (micTrack) tracks.push(micTrack);
      }
      pendingAudioTrackRef.current = mixAudioTracks(tracks);

      if (areaMode) {
        // Предпросмотр первого кадра для выбора области — сама запись стартует
        // только после подтверждения (или выбора «весь экран») в AreaPicker.
        pendingStreamRef.current = stream;
        const video = document.createElement("video");
        video.srcObject = stream;
        await video.play();
        await new Promise((r) => setTimeout(r, 150));
        const c = document.createElement("canvas");
        c.width = video.videoWidth;
        c.height = video.videoHeight;
        c.getContext("2d")?.drawImage(video, 0, 0);
        setRecAreaPreview(c.toDataURL("image/png"));
        return;
      }
      startRecordingOnStream(stream, null);
    } catch (e) {
      if (linuxAudioFallbackActiveRef.current) {
        linuxAudioFallbackActiveRef.current = false;
        void window.appBridge?.stopLinuxSystemAudioFallback?.();
      }
      await window.appBridge?.setCaptureMode?.("default").catch(() => {});
      setError((e as Error).message || String(e));
    }
  };

  const confirmRecordArea = (r: Rect) => {
    const stream = pendingStreamRef.current;
    setRecAreaPreview(null);
    pendingStreamRef.current = null;
    if (!stream) return;
    const isFull = r.w >= (stream.getVideoTracks()[0]?.getSettings?.().width || Infinity);
    startRecordingOnStream(stream, isFull ? null : r);
  };

  const cancelRecordArea = () => {
    pendingStreamRef.current?.getTracks().forEach((tr) => tr.stop());
    pendingStreamRef.current = null;
    stopAudioCapture();
    if (linuxAudioFallbackActiveRef.current) {
      linuxAudioFallbackActiveRef.current = false;
      void window.appBridge?.stopLinuxSystemAudioFallback?.();
    }
    setRecAreaPreview(null);
  };

  /** Останавливает микрофон и закрывает AudioContext микса — вызывается и при
   *  обычной остановке записи, и при отмене выбора области (запись так и не
   *  началась, но микрофон уже был запрошен в startRecording). */
  const stopAudioCapture = () => {
    micTrackRef.current?.stop();
    micTrackRef.current = null;
    if (audioCtxRef.current) {
      void audioCtxRef.current.close();
      audioCtxRef.current = null;
    }
    pendingAudioTrackRef.current = null;
  };

  const stopRecording = () => {
    recorderRef.current?.stop();
    setRecording(false);
    if (timerRef.current) clearInterval(timerRef.current);
    if (canvasLoopRef.current) cancelAnimationFrame(canvasLoopRef.current);
    canvasLoopRef.current = null;
    canvasStreamRef.current?.getTracks().forEach((tr) => tr.stop());
    canvasStreamRef.current = null;
    hiddenVideoRef.current?.pause();
    hiddenVideoRef.current = null;
    streamRef.current?.getTracks().forEach((tr) => tr.stop());
    streamRef.current = null;
    stopAudioCapture();
    void window.appBridge?.setCaptureMode?.("default");
  };

  useEffect(
    () => () => {
      if (timerRef.current) clearInterval(timerRef.current);
      if (canvasLoopRef.current) cancelAnimationFrame(canvasLoopRef.current);
      streamRef.current?.getTracks().forEach((tr) => tr.stop());
      canvasStreamRef.current?.getTracks().forEach((tr) => tr.stop());
      micTrackRef.current?.stop();
      if (audioCtxRef.current) void audioCtxRef.current.close();
    },
    [],
  );

  // --- Библиотека скриншотов и записей ---
  const [library, setLibrary] = useState<ScreenshotItem[]>([]);
  const [viewing, setViewing] = useState<ScreenshotItem | null>(null);
  const reloadLibrary = useCallback(() => {
    api.screenshotsList().then(setLibrary).catch(() => {});
  }, []);
  useEffect(() => {
    reloadLibrary();
    // Скриншоты через PrintScreen/Win+Shift+S попадают в библиотеку в фоне
    // (electron/main.js следит за буфером обмена) — страница про них узнает
    // только перечитав список. Момент возврата в приложение — самый вероятный,
    // когда такой скриншот только что появился.
    window.addEventListener("focus", reloadLibrary);
    return () => window.removeEventListener("focus", reloadLibrary);
  }, [reloadLibrary]);

  // --- Автосохранение скриншотов из буфера обмена (PrintScreen/Win+Shift+S) ---
  const [autoCaptureClipboard, setAutoCaptureClipboard] = useState(true);
  useEffect(() => {
    api
      .getSettings()
      .then((s: any) => setAutoCaptureClipboard(s?.screenshots?.autoCaptureClipboard !== false))
      .catch(() => {});
  }, []);
  const toggleAutoCapture = () => {
    const next = !autoCaptureClipboard;
    setAutoCaptureClipboard(next);
    api.updateSettings({ screenshots: { autoCaptureClipboard: next } }).catch(() => {});
  };

  const removeItem = async (id: string) => {
    setLibrary((prev) => prev.filter((it) => it.id !== id));
    try {
      await api.screenshotsDelete(id);
    } catch {
      /* уже убрали из списка визуально — расхождение поправит следующий список */
    }
    setViewing((v) => (v?.id === id ? null : v));
  };

  return (
    <div className="page">
      <SectionHead eyebrow={t("screenshots.eyebrow")} title={t("screenshots.title")} />
      <div className="muted-sm" style={{ marginBottom: 4 }}>
        {t("screenshots.hint")}
      </div>

      <div className="page-scroll-body">
        <Glass
          style={{ display: "flex", flexDirection: "column", alignItems: "stretch", gap: 14, padding: 12 }}
        >
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "flex-end" }}>
            <Field label={t("screenshots.source")} w={260}>
              <Select
                value={sourceId}
                onChange={(e) => setSourceId(e.target.value)}
                options={sourceOptions}
                onMouseDown={() => void loadSources()}
              />
            </Field>
            <Badge tone="amber" active={areaMode} onClick={() => setAreaMode((v) => !v)}>
              <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                <Crop size={12} />
                {t("screenshots.areaToggle")}
              </span>
            </Badge>
            <Badge tone="amber" active={autoCaptureClipboard} onClick={toggleAutoCapture}>
              <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                <ImageIcon size={12} />
                {t("screenshots.autoCapture")}
              </span>
            </Badge>
          </div>

          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "flex-end" }}>
            <Field label={t("screenshots.resolution")} w={170}>
              <Select
                value={resolution}
                onChange={(e) => setResolution(e.target.value)}
                options={SCALES.map((s) => ({
                  value: s.value,
                  label:
                    s.value === "100"
                      ? selectedSourceRes
                        ? `${selectedSourceRes.w}×${selectedSourceRes.h}`
                        : t("screenshots.resolutionSource")
                      : selectedSourceRes
                        ? `${Math.round(selectedSourceRes.w * s.pct)}×${Math.round(selectedSourceRes.h * s.pct)}`
                        : `${s.value}%`,
                }))}
              />
            </Field>
            <Field label={t("screenshots.fps")} w={100}>
              <Select
                value={String(fps)}
                onChange={(e) => setFps(Number(e.target.value))}
                options={FPS_OPTIONS.map((f) => ({ value: String(f), label: `${f}` }))}
              />
            </Field>
            <Field label={t("screenshots.bitrate")} w={130}>
              <Select
                value={String(bitrateMbps)}
                onChange={(e) => setBitrateMbps(Number(e.target.value))}
                options={BITRATE_OPTIONS.map((b) => ({ value: String(b), label: `${b} Mbps` }))}
              />
            </Field>
            <Field label={t("screenshots.codec")} w={130}>
              <Select
                value={codec}
                onChange={(e) => setCodec(e.target.value)}
                options={
                  supportedCodecs.length
                    ? supportedCodecs.map((c) => ({ value: c.id, label: c.id.toUpperCase() }))
                    : [{ value: "vp9", label: "VP9" }]
                }
              />
            </Field>
          </div>

          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "flex-end" }}>
            <Field label={t("screenshots.audioSource")} w={190}>
              <Select
                value={audioSource}
                onChange={(e) => setAudioSource(e.target.value as typeof audioSource)}
                options={[
                  { value: "none", label: t("screenshots.audioNone") },
                  { value: "mic", label: t("screenshots.audioMic") },
                  { value: "system", label: t("screenshots.audioSystem") },
                  { value: "both", label: t("screenshots.audioBoth") },
                ]}
              />
            </Field>
            {(audioSource === "mic" || audioSource === "both") && (
              <Field label={t("screenshots.micDevice")} w={190}>
                <Select
                  value={micDeviceId}
                  onChange={(e) => setMicDeviceId(e.target.value)}
                  options={[
                    { value: "", label: t("screenshots.micDeviceAuto") },
                    ...micDevices.map((d) => ({ value: d.deviceId, label: d.label })),
                  ]}
                  onMouseDown={() => void loadMicDevices()}
                />
              </Field>
            )}
          </div>

          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <Btn variant="primary" icon={Camera} onClick={() => void takeScreenshot()}>
              {t("screenshots.take")}
            </Btn>
            {!recording ? (
              <Btn icon={Video} onClick={() => void startRecording()}>
                {t("screenshots.recStart")}
              </Btn>
            ) : (
              <Btn icon={Square} onClick={stopRecording} style={{ borderColor: "var(--coral)" }}>
                {t("screenshots.recStop")} · {fmtTime(recSeconds)}
              </Btn>
            )}
            {recording && (
              <Badge tone="coral" mono>
                ● REC
              </Badge>
            )}
          </div>
        </Glass>

        {error && (
          <Glass className="source-placeholder" style={{ borderColor: "var(--coral)" }}>
            <AlertTriangle size={16} style={{ color: "var(--coral)" }} />
            <span>{error}</span>
          </Glass>
        )}

        {cropPending && (
          <AreaPicker
            src={cropPending}
            confirmLabel={t("screenshots.cropConfirm")}
            fullLabel={t("screenshots.cropFull")}
            cancelLabel={t("common.cancel")}
            onConfirm={(r) => applyCrop(cropPending, r)}
            onCancel={() => setCropPending(null)}
          />
        )}

        {recAreaPreview && (
          <AreaPicker
            src={recAreaPreview}
            confirmLabel={t("screenshots.recAreaConfirm")}
            fullLabel={t("screenshots.cropFull")}
            cancelLabel={t("common.cancel")}
            onConfirm={confirmRecordArea}
            onCancel={cancelRecordArea}
          />
        )}

        {shot && (
          <Glass
            style={{ display: "flex", flexDirection: "column", alignItems: "stretch", gap: 10, padding: 12 }}
          >
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              {(
                [
                  ["pen", Pencil, "screenshots.toolPen"],
                  ["arrow", ArrowUpRight, "screenshots.toolArrow"],
                  ["blur", Blend, "screenshots.toolBlur"],
                  ["ocrArea", ScanText, "screenshots.toolOcrArea"],
                ] as const
              ).map(([id, Icon, key]) => (
                <Badge key={id} tone={tool === id ? "amber" : "neutral"} onClick={() => setTool(id)}>
                  <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                    <Icon size={12} />
                    {t(key)}
                  </span>
                </Badge>
              ))}
            </div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <Btn icon={Eraser} onClick={undoStroke}>
                {t("screenshots.undo")}
              </Btn>
              <Btn icon={Copy} onClick={() => void copyToClipboard()}>
                {t("screenshots.copy")}
              </Btn>
              <Btn icon={Download} onClick={downloadShot}>
                {t("screenshots.download")}
              </Btn>
              <Btn
                icon={ScanText}
                disabled={ocrBusy}
                onClick={() => canvasRef.current && runOcr(canvasRef.current)}
              >
                {ocrBusy ? t("screenshots.ocrBusy") : t("screenshots.ocr")}
              </Btn>
            </div>
            <div className="muted-sm">{t("screenshots.annotateHint")}</div>
            {ocrText !== null && (
              <Glass
                style={{ display: "flex", flexDirection: "column", alignItems: "stretch", gap: 6, padding: 10 }}
              >
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <div className="muted-sm">
                    {ocrText ? t("screenshots.ocrCopied") : t("screenshots.ocrEmpty")}
                  </div>
                  <IconBtn icon={X} title={t("common.close")} onClick={() => setOcrText(null)} />
                </div>
                {ocrText && (
                  <div style={{ whiteSpace: "pre-wrap", fontFamily: "var(--font-mono)", fontSize: 13 }}>
                    {ocrText}
                  </div>
                )}
              </Glass>
            )}
            <div style={{ overflow: "auto", maxHeight: "60vh" }}>
              <canvas
                ref={canvasRef}
                style={{ maxWidth: "100%", cursor: "crosshair", border: "1px solid var(--glass-border)" }}
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={onPointerUp}
                onPointerLeave={onPointerUp}
              />
            </div>
          </Glass>
        )}

        {!shot && !recording && !cropPending && !recAreaPreview && (
          <EmptyHint icon={Camera} text={t("screenshots.empty")} />
        )}

        {/* --- Библиотека: скриншоты и записи вместе, новые сверху --- */}
        {library.length > 0 && (
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <SectionHead title={t("screenshots.library")} />
            <div className="ss-lib-grid">
              {library.map((it) => (
                <div key={it.id} className="ss-lib-card">
                  <button
                    type="button"
                    className="ss-lib-thumb"
                    onClick={() => setViewing(it)}
                    title={t("screenshots.libOpen")}
                  >
                    {it.type === "image" ? (
                      <img src={api.screenshotFileUrl(it.id)} alt="" loading="lazy" />
                    ) : (
                      <>
                        <video src={api.screenshotFileUrl(it.id)} muted preload="metadata" />
                        <span className="ss-lib-play">
                          <Play size={22} />
                        </span>
                      </>
                    )}
                    {it.type === "video" && it.durationSec ? (
                      <span className="ss-lib-badge">{fmtTime(it.durationSec)}</span>
                    ) : null}
                  </button>
                  <div className="ss-lib-meta">
                    <span className="muted-sm">{fmtBytes(it.sizeBytes)}</span>
                    <IconBtn
                      icon={Trash2}
                      size={15}
                      title={t("common.delete")}
                      onClick={() => void removeItem(it.id)}
                    />
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Портал в #overlay-root — иначе модалка живёт внутри .content-area
          (z-index:1) и рельс переключения страниц (.bottom-dock, z-index:40 в
          .app-shell) перекрывает её целиком, как бы высоко ни был выставлен
          z-index здесь (свой стек не сравнить с чужим снаружи), см.
          src/components/overlayHost.ts. */}
      {viewing &&
        getOverlayRoot() &&
        createPortal(
          <div className="ss-modal-overlay" onClick={() => setViewing(null)}>
            <div className="ss-modal-box" onClick={(e) => e.stopPropagation()}>
              <div className="ss-modal-head">
                <span className="muted-sm">
                  {new Date(viewing.createdAt).toLocaleString()} · {fmtBytes(viewing.sizeBytes)}
                </span>
                <IconBtn icon={X} title={t("common.close")} onClick={() => setViewing(null)} />
              </div>
              {viewing.type === "image" ? (
                <img src={api.screenshotFileUrl(viewing.id)} alt="" className="ss-modal-img" />
              ) : (
                <div className="ss-modal-video">
                  <VideoPlayer src={api.screenshotFileUrl(viewing.id)} duration={viewing.durationSec || null} />
                </div>
              )}
            </div>
          </div>,
          getOverlayRoot()!,
        )}
    </div>
  );
}
