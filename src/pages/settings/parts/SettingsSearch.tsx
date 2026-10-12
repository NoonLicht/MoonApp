import { useEffect, useState } from "react";
import { Search } from "lucide-react";
import { api } from "@/api/client";
import { useDeepLink } from "@/lib/deepLink";
import { useI18n } from "@/app/i18n";

const HIT = "set-row-hit";

/**
 * Поиск по настройкам: «звук», «не показывать при старте», «сворачивать в трей» — находит строки
 * по смыслу (EmbeddingGemma), а без модели — по словам. Найденные строки подсвечиваются,
 * первая прокручивается в область видимости.
 */
export default function SettingsSearch() {
  const { t } = useI18n();
  const [q, setQ] = useState("");
  const [note, setNote] = useState("");
  useDeepLink("settings", (t) => {
    if (t.view === "search" && t.ref) setQ(t.ref);
  });

  useEffect(() => {
    const clear = () =>
      document.querySelectorAll(`.${HIT}`).forEach((n) => n.classList.remove(HIT));
    const text = q.trim();
    clear();
    setNote("");
    if (text.length < 2) return;
    let live = true;
    const tm = setTimeout(async () => {
      const rows = Array.from(
        document.querySelectorAll<HTMLElement>(".settings-scroll-wrap .set-row"),
      );
      const texts = rows.map((r) =>
        (r.querySelector(".set-info")?.textContent ?? r.textContent ?? "").trim(),
      );
      const low = text.toLowerCase();
      const byWord = texts.map((t) => (t.toLowerCase().includes(low) ? 1 : 0));
      let scores: number[] = byWord;
      try {
        const sem = await api.semRank(text, texts);
        scores = sem.map((s, i) => Math.max(byWord[i] ? 1 : 0, s));
      } catch {
        /* модели нет — остаётся поиск по словам */
      }
      if (!live) return;
      const top = Math.max(...scores, 0);
      const order = scores
        .map((s, i) => ({ s, i }))
        .filter((x) => x.s >= Math.max(0.7, top - 0.05))
        .sort((a, b) => b.s - a.s)
        .slice(0, 4);
      clear();
      order.forEach((x) => {
        rows[x.i].classList.add(HIT);
        rows[x.i].closest(".set-section-wrap")?.dispatchEvent(new Event("set-open"));
      });
      if (order.length) {
        const first = rows[order[0].i];
        // секция разворачивается на следующем кадре — после этого прокручиваем
        requestAnimationFrame(() => first.scrollIntoView({ block: "center", behavior: "smooth" }));
      }
      if (!order.length) setNote(t("common.nothingFound"));
    }, 350);
    return () => {
      live = false;
      clearTimeout(tm);
    };
  }, [q]);

  useEffect(
    () => () => document.querySelectorAll(`.${HIT}`).forEach((n) => n.classList.remove(HIT)),
    [],
  );

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <label
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          padding: "5px 10px",
          borderRadius: 999,
          border: "1px solid var(--glass-border)",
          background: "var(--track)",
        }}
      >
        <Search size={13} style={{ color: "var(--text-tertiary)" }} />
        <input
          className="text-input"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={t("settings.searchPh")}
          style={{ border: "none", background: "transparent", width: 220, padding: 0 }}
        />
      </label>
      {note && <span className="muted-sm">{note}</span>}
    </div>
  );
}
