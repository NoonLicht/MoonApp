import { useRef, useState, useEffect, useCallback } from "react";
import { Camera, Video, Square, Copy, Download, Eraser, AlertTriangle } from "lucide-react";
import { Glass, Btn, SectionHead, EmptyHint, Badge } from "@/components/ui";
import { useI18n } from "@/app/i18n";
import { saveBlob } from "@/lib/download";

/**
 * Скриншоты + запись экрана — через Electron getDisplayMedia (без ffmpeg:
 * MediaRecorder в рендерере пишет webm напрямую). Захват экрана заведён
 * через тот же приём, что уже работает на странице «Лекторий» для системного
 * звука (electron/main.js → installScreenHandler, rec:capture-mode "screen").
 *
 * ОГРАНИЧЕНИЕ: выбор конкретного экрана/окна не реализован — всегда
 * захватывается первый найденный монитор (см. main.js), честно указано в UI.
 */
export default function ScreenshotsPage() {
  const { t } = useI18n();
  const [error, setError] = useState("");

  // --- Скриншот + аннотации ---
  const [shot, setShot] = useState<string | null>(null); // data URL исходного кадра
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const drawingRef = useRef(false);
  const lastPtRef = useRef<{ x: number; y: number } | null>(null);
  const strokesRef = useRef<ImageData[]>([]); // для undo — снимки канваса перед каждым штрихом

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
    strokesRef.current.push(ctx.getImageData(0, 0, canvasRef.current.width, canvasRef.current.height));
    if (strokesRef.current.length > 30) strokesRef.current.shift();
    drawingRef.current = true;
    lastPtRef.current = getPos(e);
  };

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!drawingRef.current) return;
    const ctx = canvasRef.current?.getContext("2d");
    if (!ctx || !lastPtRef.current) return;
    const p = getPos(e);
    ctx.strokeStyle = "#ea6b6b";
    ctx.lineWidth = 4;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(lastPtRef.current.x, lastPtRef.current.y);
    ctx.lineTo(p.x, p.y);
    ctx.stroke();
    lastPtRef.current = p;
  };

  const onPointerUp = () => {
    drawingRef.current = false;
    lastPtRef.current = null;
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
