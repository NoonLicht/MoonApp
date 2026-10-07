import { useState } from "react";
import { ArrowLeftRight, Copy, Languages, Square } from "lucide-react";
import { Glass, Btn } from "@/components/ui";
import { useI18n } from "@/app/i18n";
import { api } from "@/api/client";
import type { TrStatus } from "@/api/client";
import LangSelect from "@/pages/translate/parts/LangSelect";
import JobStatus from "@/pages/translate/parts/JobStatus";
import { memo, useJob } from "@/pages/translate/parts/useTranslate";
import type { TrSettings } from "@/pages/translate/parts/useTranslate";

/** Перевод текста любой длины: источник слева, результат справа появляется по мере готовности. */
export default function TextTab({
  status,
  settings,
  set,
  ready,
  notify,
}: {
  status: TrStatus;
  settings: TrSettings;
  set: (p: Partial<TrSettings>) => void;
  ready: boolean;
  notify: (text: string, ok?: boolean) => void;
}) {
  const { t } = useI18n();
  const [text, setText] = useState(memo.text);
  const { job, running, start, cancel, error } = useJob("text");

  const out = job?.partial ?? "";
  const swap = (): void => {
    if (settings.src === "auto") return;
    set({ src: settings.tgt, tgt: settings.src });
    if (out) {
      memo.text = out;
      setText(out);
    }
  };

  return (
    <Glass className="tr-fill" style={{ padding: 14 }}>
      <div className="tr-langs">
        <LangSelect
          value={settings.src}
          onChange={(src) => set({ src })}
          codes={status.languages}
          auto
        />
        <Btn
          icon={ArrowLeftRight}
          onClick={swap}
          disabled={settings.src === "auto" || running}
          title={t("translate.swap")}
        />
        <LangSelect
          value={settings.tgt}
          onChange={(tgt) => set({ tgt })}
          codes={status.languages}
        />
        <div style={{ flex: 1 }} />
        {running ? (
          <Btn icon={Square} onClick={cancel}>
            {t("translate.cancel")}
          </Btn>
        ) : (
          <Btn
            variant="primary"
            icon={Languages}
            disabled={!ready || !text.trim()}
            onClick={() =>
              void start(() =>
                api.trText(text, {
                  src: settings.src,
                  tgt: settings.tgt,
                  provider: settings.provider,
                  variant: settings.variant,
                }),
              )
            }
          >
            {t("translate.run")}
          </Btn>
        )}
      </div>
      <div className="tr-panes">
        <textarea
          className="tr-area"
          value={text}
          placeholder={t("translate.textPlaceholder")}
          onChange={(e) => {
            memo.text = e.target.value;
            setText(e.target.value);
          }}
        />
        <div className="tr-area tr-out">
          {out || <span className="muted-sm">{t("translate.outPlaceholder")}</span>}
        </div>
      </div>
      <div className="tr-foot">
        <span className="muted-sm">{t("translate.chars", { n: text.length })}</span>
        <Btn
          icon={Copy}
          disabled={!out}
          onClick={() => {
            void navigator.clipboard.writeText(out);
            notify(t("translate.copied"));
          }}
        >
          {t("translate.copy")}
        </Btn>
      </div>
      {job && <JobStatus job={job} />}
      {error && <div className="tn-msg bad">{error}</div>}
    </Glass>
  );
}
