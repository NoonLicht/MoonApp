import { useEffect, useState } from "react";
import { MonitorUp, Save, Trash2 } from "lucide-react";
import { useI18n } from "@/app/i18n";
import { Btn } from "@/components/ui";
import { Row } from "@/pages/settings/parts/SettingsControls";
import { PAGES } from "@/app/navigation";

type Display = { id: number; label: string; primary: boolean };
interface LayoutItem {
  page: string;
  /** Порядковый номер монитора в списке: id мониторов между запусками не гарантированы. */
  displayIndex: number;
}
interface Layout {
  name: string;
  items: LayoutItem[];
}

const KEY = "moonapp.window-layouts";

function readLayouts(): Layout[] {
  try {
    const raw = JSON.parse(globalThis.localStorage?.getItem(KEY) ?? "[]");
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}
function writeLayouts(l: Layout[]): void {
  try {
    globalThis.localStorage?.setItem(KEY, JSON.stringify(l));
  } catch {
    /* хранилище недоступно */
  }
}

/**
 * Окна страниц на нескольких мониторах: открыть страницу в отдельном окне на
 * выбранном экране, а набор таких окон — сохранить как раскладку и восстановить
 * одним нажатием. Раскладки хранятся на этом устройстве (мониторы у каждого свои).
 */
export function WindowRows() {
  const { t } = useI18n();
  const bridge = window.appBridge;
  const [displays, setDisplays] = useState<Display[]>([]);
  const [page, setPage] = useState("lecture");
  const [display, setDisplay] = useState(0);
  const [pending, setPending] = useState<LayoutItem[]>([]);
  const [name, setName] = useState("");
  const [layouts, setLayouts] = useState<Layout[]>(readLayouts());

  useEffect(() => {
    bridge?.listDisplays?.().then((d) => setDisplays(d ?? [])).catch(() => undefined);
  }, [bridge]);

  if (!bridge?.openPageWindow) return null;

  const open = async (item: LayoutItem) => {
    const d = displays[item.displayIndex] ?? displays[0];
    await bridge.openPageWindow?.(item.page, d?.id);
  };

  const openNow = async () => {
    const item = { page, displayIndex: display };
    await open(item);
    setPending((p) => [...p, item]);
  };

  const saveLayout = () => {
    if (!name.trim() || !pending.length) return;
    const next = [...layouts.filter((l) => l.name !== name.trim()), { name: name.trim(), items: pending }];
    writeLayouts(next);
    setLayouts(next);
    setName("");
    setPending([]);
  };

  const pageLabel = (id: string) => {
    const p = PAGES.find((x) => x.id === id);
    return p ? t(p.i18n) : id;
  };

  return (
    <>
      <Row label={t("settings.windows.open")} hint={t("settings.windows.openHint")}>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <select className="input" value={page} onChange={(e) => setPage(e.target.value)}>
            {PAGES.map((p) => (
              <option key={p.id} value={p.id}>
                {t(p.i18n)}
              </option>
            ))}
          </select>
          <select
            className="input"
            value={display}
            onChange={(e) => setDisplay(Number(e.target.value))}
          >
            {(displays.length ? displays : [{ id: 0, label: "", primary: true }]).map((d, i) => (
              <option key={d.id} value={i}>
                {t("settings.windows.display", { n: i + 1 })}
                {d.primary ? ` · ${t("settings.windows.primary")}` : ""}
              </option>
            ))}
          </select>
          <Btn icon={MonitorUp} onClick={() => void openNow()}>
            {t("settings.windows.openBtn")}
          </Btn>
        </div>
      </Row>
      <Row label={t("settings.windows.layouts")} hint={t("settings.windows.layoutsHint")}>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <input
            className="input"
            placeholder={t("settings.windows.layoutName")}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <Btn icon={Save} disabled={!name.trim() || !pending.length} onClick={saveLayout}>
            {t("settings.windows.save", { n: pending.length })}
          </Btn>
        </div>
      </Row>
      {layouts.map((l) => (
        <div key={l.name} style={{ display: "flex", gap: 8, alignItems: "center", marginTop: -4 }}>
          <Btn
            variant="primary"
            onClick={async () => {
              for (const it of l.items) await open(it);
            }}
          >
            {l.name}
          </Btn>
          <span className="muted-sm">
            {l.items.map((i) => `${pageLabel(i.page)} → ${i.displayIndex + 1}`).join(", ")}
          </span>
          <Btn
            variant="ghost"
            icon={Trash2}
            onClick={() => {
              const next = layouts.filter((x) => x.name !== l.name);
              writeLayouts(next);
              setLayouts(next);
            }}
          />
        </div>
      ))}
    </>
  );
}
