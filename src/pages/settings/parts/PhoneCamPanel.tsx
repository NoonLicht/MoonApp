import { useEffect, useRef, useState } from "react";
import { Camera, Copy, KeyRound } from "lucide-react";
import { useI18n } from "@/app/i18n";
import { api } from "@/api/client";
import type { CompanionStatus } from "@/api/apiCompanion";
import { Btn } from "@/components/ui";
import QrCode from "@/components/QrCode";
import { Row } from "@/pages/settings/parts/SettingsControls";

/**
 * Телефон как веб-камера: адрес защищённой страницы (QR), статус, живой просмотр,
 * снимок и адрес потока MJPEG для OBS. Кадры идут по локальной сети и нигде не пишутся.
 */
export function PhoneCamPanel({ st, onStatus }: { st: CompanionStatus; onStatus: (s: CompanionStatus) => void }) {
  const { t } = useI18n();
  const [src, setSrc] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const live = st.camera.active;
  const prev = useRef<string | null>(null);

  // Живой просмотр: пока кадры идут, подтягиваем последний несколько раз в секунду.
  useEffect(() => {
    if (!live) return undefined;
    let stop = false;
    let busy = false;
    const pull = async () => {
      if (stop || busy) return;
      busy = true;
      try {
        const url = await api.companionCamFrame();
        if (url && !stop) {
          if (prev.current) URL.revokeObjectURL(prev.current);
          prev.current = url;
          setSrc(url);
        } else if (url) URL.revokeObjectURL(url);
      } catch {
        /* кадр не пришёл — попробуем в следующий раз */
      } finally {
        busy = false;
      }
    };
    const id = window.setInterval(() => void pull(), 250);
    void pull();
    return () => {
      stop = true;
      window.clearInterval(id);
    };
  }, [live]);

  useEffect(
    () => () => {
      if (prev.current) URL.revokeObjectURL(prev.current);
    },
    [],
  );

  const copy = (text: string) => {
    void navigator.clipboard?.writeText(text).then(() => setNote(t("phoneCam.copied")));
  };

  const https = st.httpsUrls[0];
  return (
    <Row label={t("phoneCam.title")} hint={t("phoneCam.hint")}>
      <div style={{ display: "grid", gap: 10 }}>
        {https ? (
          <div style={{ display: "flex", gap: 14, alignItems: "center", flexWrap: "wrap" }}>
            <QrCode text={`${https}#cam`} />
            <div>
              <code>{https}#cam</code>
              <div className="muted-sm">{t("phoneCam.certHint")}</div>
            </div>
          </div>
        ) : (
          <div className="muted-sm">{t("phoneCam.noHttps")}</div>
        )}
        <div className="muted-sm">
          <Camera size={13} style={{ verticalAlign: "-2px" }} />{" "}
          {live
            ? t("phoneCam.live", {
                device: st.camera.device,
                w: st.camera.width,
                h: st.camera.height,
                fps: st.camera.fps,
                kb: st.camera.kbPerFrame,
              })
            : t("phoneCam.idle")}
        </div>
        {live && src && (
          <img
            src={src}
            alt=""
            style={{ maxWidth: 360, width: "100%", borderRadius: 10, background: "#000", display: "block" }}
          />
        )}
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <Btn
            icon={Camera}
            disabled={!live}
            onClick={() =>
              void api
                .companionCamSnapshot()
                .then((r) => setNote(t("phoneCam.saved", { name: r.name })))
                .catch((e: Error) => setNote(e.message))
            }
          >
            {t("phoneCam.snapshot")}
          </Btn>
          <Btn icon={KeyRound} onClick={() => void api.companionCamKey().then(onStatus)}>
            {t("phoneCam.newKey")}
          </Btn>
        </div>
        {st.camera.streamUrls[0] && (
          <div>
            <div className="field-label">{t("phoneCam.stream")}</div>
            <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
              <code style={{ wordBreak: "break-all" }}>{st.camera.streamUrls[0]}</code>
              <Btn icon={Copy} onClick={() => copy(st.camera.streamUrls[0])}>
                {t("phoneCam.copy")}
              </Btn>
            </div>
            <div className="muted-sm">{t("phoneCam.streamHint")}</div>
          </div>
        )}
        {note && <div className="muted-sm">{note}</div>}
      </div>
    </Row>
  );
}
