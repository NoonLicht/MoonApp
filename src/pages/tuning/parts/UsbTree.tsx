import { useEffect, useState } from "react";
import { RefreshCw, Usb } from "lucide-react";
import { Glass, Btn, EmptyHint } from "@/components/ui";
import { useI18n } from "@/app/i18n";
import { api } from "@/api/client";
import type { UsbController } from "@/api/client";

/** Карта USB: какие устройства висят на каком контроллере (разносите мышь/клавиатуру/аудио). */
export default function UsbTree({ onError }: { onError: (m: string) => void }) {
  const { t } = useI18n();
  const [list, setList] = useState<UsbController[] | null>(null);

  const load = async () => {
    setList(null);
    try {
      setList(await api.tuningUsb());
    } catch (e) {
      onError((e as Error).message);
      setList([]);
    }
  };

  useEffect(() => {
    void load();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <Glass style={{ padding: 14, marginTop: 12 }}>
      <div className="tn-sub">
        <b className="tn-card-title">{t("tuning.usbTitle")}</b>
        <Btn icon={RefreshCw} onClick={() => void load()}>
          {t("tuning.refresh")}
        </Btn>
      </div>
      <div className="muted-sm">{t("tuning.usbHint")}</div>
      {list === null && <div className="muted-sm">{t("tuning.loading")}</div>}
      {list?.length === 0 && <EmptyHint icon={Usb} text={t("tuning.usbEmpty")} />}
      {list?.map((c) => (
        <div key={c.id} className="tn-usb-ctl">
          <div className="tn-usb-name">
            <Usb size={14} /> {c.name}
            <span className="muted-sm"> · {c.devices.length}</span>
          </div>
          {c.devices.map((d) => (
            <div key={d.id} className="tn-usb-dev muted-sm">
              {d.name}
              {d.status !== "OK" && <span> ({d.status})</span>}
            </div>
          ))}
        </div>
      ))}
    </Glass>
  );
}
