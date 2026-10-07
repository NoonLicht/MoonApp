import { useMemo } from "react";
import { Select } from "@/components/ui";
import { useI18n } from "@/app/i18n";

function displayName(code: string, ui: string): string {
  try {
    return new Intl.DisplayNames([ui], { type: "language" }).of(code) || code;
  } catch {
    return code;
  }
}

/** Выбор языка: названия на языке интерфейса, «Определить автоматически» — для источника. */
export default function LangSelect({
  value,
  onChange,
  codes,
  auto,
}: {
  value: string;
  onChange: (code: string) => void;
  codes: string[];
  auto?: boolean;
}) {
  const { t, lang } = useI18n();
  const options = useMemo(() => {
    const list = codes
      .map((c) => ({ value: c, label: `${displayName(c, lang)} (${c})` }))
      .sort((a, b) => a.label.localeCompare(b.label, lang));
    return auto ? [{ value: "auto", label: t("translate.auto") }, ...list] : list;
  }, [codes, lang, auto, t]);
  return <Select value={value} onChange={(e) => onChange(e.target.value)} options={options} />;
}
