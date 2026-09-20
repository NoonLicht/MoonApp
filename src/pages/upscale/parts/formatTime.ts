/** Секунды → m:ss (или h:mm:ss) — для оценки времени и длительности. */
export function fmtTime(sec: number): string {
  const total = Math.max(0, Math.round(sec || 0));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`
    : `${m}:${String(s).padStart(2, "0")}`;
}

/**
 * ISO-время (когда обновляли каталог моделей) → «20.09.2026, 14:12» по локали
 * системы. Пустая строка — даты нет (вшитый каталог, часовой пояс сломан).
 */
export function fmtDateTime(iso: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleString();
}
