import { useRef, useState, useEffect, useCallback } from "react";
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
} from "lucide-react";
import { Glass, Btn, SectionHead, EmptyHint, Badge } from "@/components/ui";
import { useI18n } from "@/app/i18n";
import { saveBlob } from "@/lib/download";

type AnnotateTool = "pen" | "arrow" | "blur";

interface Point {
  x: number;
  y: number;
}

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

function rectFrom(a: Point, b: Point): { x: number; y: number; w: number; h: number } {
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) };
}

function drawRectPreview(ctx: CanvasRenderingContext2D, a: Point, b: Point): void {
  const r = rectFrom(a, b);
  ctx.save();
  ctx.strokeStyle = "#4fc3d9";
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

/**
 * Скриншоты + запись экрана — через Electron getDisplayMedia (без ffmpeg:
 * MediaRecorder в рендерере пишет webm напрямую). Захват экрана заведён
 * через тот же приём, что уже работает на странице «Лекторий» для системного
 * звука (electron/main.js → installScreenHandler, rec:capture-mode "screen").
 *
 * ОГРАНИЧЕНИЕ: выбор конкретного экрана/окна не реализован — всегда
 * захватывается первый найденный монитор (см. main.js), честно указано в UI.
 *
 * Аннотации: маркер (фрихенд), стрелка (drag) и блюр региона — блюр сделан
 * через встроенный CanvasRenderingContext2D.filter = "blur(...)" на офскрин-
 * канвасе, без внешних библиотек.
 */
export default function ScreenshotsPage() {
  const { t } = useI18n();
  const [error, setError] = useState("");

  // --- Скриншот + аннотации ---
  const [shot, setShot] = useState<string | null>(null); // data URL исходного кадра
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const drawingRef = useRef(false);
  const lastPtRef = useRef<Point | null>(null);
  const startPtRef = useRef<Point | null>(null);
  const baseSnapshotRef = useRef<ImageData | null>(null); // снимок канваса на момент pointerdown — для превью arrow/blur
  const strokesRef = useRef<ImageData[]>([]); // для undo — снимки канваса перед каждым штрихом
  const [tool, setTool] = useState<AnnotateTool>("pen");

  const takeScreenshot = async () => {
    setError("");
    try {
      await window.appBridge?.setCaptureMode?.("screen");
      const stream = await navigator.mediaDevices.getDisplayMedia({ video: true });
      const video = document.createElement("video");
      video.srcObject = stream;
      await video.play();
      // Один кадр достаточно, ждём первого реального размера видео.
      await new Promise((r) => setTimeout(r, 150));
      const canvas = document.createElement("canvas");
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      canvas.getContext("2d")?.drawImage(video, 0, 0);
      stream.getTracks().forEach((tr) => tr.stop());
      await window.appBridge?.setCaptureMode?.("default");
      setShot(canvas.toDataURL("image/png"));
    } catch (e) {
      await window.appBridge?.setCaptureMode?.("default").catch(() => {});
      setError((e as Error).message || String(e));
    }
  };

  // Загружаем скриншот в редактируемый канвас, как только он готов.
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
    };
    img.src = shot;
  }, [shot]);

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
    }
    lastPtRef.current = p;
  };

  const onPointerUp = () => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (ctx && canvas && tool === "blur" && startPtRef.current && lastPtRef.current) {
      if (baseSnapshotRef.current) ctx.putImageData(baseSnapshotRef.current, 0, 0);
      applyBlurRect(ctx, canvas, startPtRef.current, lastPtRef.current);
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

  // --- Запись экрана ---
  const [recording, setRecording] = useState(false);
  const [recSeconds, setRecSeconds] = useState(0);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const startRecording = async () => {
    setError("");
    try {
      await window.appBridge?.setCaptureMode?.("screen");
      const stream = await navigator.mediaDevices.getDisplayMedia({ video: true });
      streamRef.current = stream;
      chunksRef.current = [];
      const rec = new MediaRecorder(stream, { mimeType: "video/webm;codecs=vp9" });
      rec.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };
      rec.onstop = () => {
        const blob = new Blob(chunksRef.current, { type: "video/webm" });
        saveBlob(blob, `recording_${Date.now()}.webm`);
        stream.getTracks().forEach((tr) => tr.stop());
        void window.appBridge?.setCaptureMode?.("default");
      };
      rec.start(1000);
      recorderRef.current = rec;
      setRecording(true);
      setRecSeconds(0);
      timerRef.current = setInterval(() => setRecSeconds((s) => s + 1), 1000);
    } catch (e) {
      await window.appBridge?.setCaptureMode?.("default").catch(() => {});
      setError((e as Error).message || String(e));
    }
  };

  const stopRecording = () => {
    recorderRef.current?.stop();
    setRecording(false);
    if (timerRef.current) clearInterval(timerRef.current);
  };

  useEffect(
    () => () => {
      if (timerRef.current) clearInterval(timerRef.current);
      streamRef.current?.getTracks().forEach((tr) => tr.stop());
    },
    [],
  );

  const fmtTime = useCallback((s: number) => {
    const m = Math.floor(s / 60);
    const sec = s % 60;
    return `${m}:${sec.toString().padStart(2, "0")}`;
  }, []);

  return (
    <div className="page">
      <SectionHead eyebrow={t("screenshots.eyebrow")} title={t("screenshots.title")} />
      <div className="muted-sm" style={{ marginBottom: 10 }}>
        {t("screenshots.hint")}
      </div>

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 12 }}>
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

      {error && (
        <Glass className="source-placeholder" style={{ borderColor: "var(--coral)" }}>
          <AlertTriangle size={16} style={{ color: "var(--coral)" }} />
          <span>{error}</span>
        </Glass>
      )}

      {shot && (
        <Glass style={{ flexDirection: "column", alignItems: "stretch", gap: 8, padding: 12 }}>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {(
              [
                ["pen", Pencil, "screenshots.toolPen"],
                ["arrow", ArrowUpRight, "screenshots.toolArrow"],
                ["blur", Blend, "screenshots.toolBlur"],
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
          <div style={{ display: "flex", gap: 8 }}>
            <Btn icon={Eraser} onClick={undoStroke}>
              {t("screenshots.undo")}
            </Btn>
            <Btn icon={Copy} onClick={() => void copyToClipboard()}>
              {t("screenshots.copy")}
            </Btn>
            <Btn icon={Download} onClick={downloadShot}>
              {t("screenshots.download")}
            </Btn>
          </div>
          <div className="muted-sm">{t("screenshots.annotateHint")}</div>
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

      {!shot && !recording && <EmptyHint icon={Camera} text={t("screenshots.empty")} />}
    </div>
  );
}
