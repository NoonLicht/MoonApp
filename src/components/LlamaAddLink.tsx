import { useState } from "react";
import { Download, Search, X } from "lucide-react";
import { Btn } from "@/components/ui";
import { useI18n } from "@/app/i18n";
import { api } from "@/api/client";
import type { LlamaRepoFiles, LlamaSection } from "@/api/client";

const mb = (n: number): string => (n < 1024 ? `${n} MB` : `${(n / 1024).toFixed(1)} GB`);

/**
 * Добавление своей модели в раздел списка: вставляется ссылка на страницу Hugging Face
 * (репозиторий целиком) или на конкретный файл. Для репозитория показывается список файлов —
 * выбираются нужные кванты, для картинок VAE и текстовый энкодер докачиваются сами.
 */
export default function LlamaAddLink({
  section,
  busy,
  onDone,
  notify,
}: {
  section: LlamaSection;
  busy: boolean;
  onDone: () => void;
  notify?: (text: string, ok?: boolean) => void;
}) {
  const { t } = useI18n();
  const [url, setUrl] = useState("");
  const [loading, setLoading] = useState(false);
  const [repo, setRepo] = useState<LlamaRepoFiles | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());

  const fail = (e: unknown): void => notify?.(String((e as Error).message || e), false);

  const look = async (): Promise<void> => {
    const u = url.trim();
    if (!u) return;
    setLoading(true);
    try {
      const r = await api.llamaHf(u);
      // Ссылка на файл — качаем сразу; ссылка на страницу — показываем список.
      if (r.file) {
        await api.llamaModelDownload({ url: u, section });
        setUrl("");
        setRepo(null);
        onDone();
        return;
      }
      const models = r.files.filter((f) => f.role === "model");
      if (!models.length) {
        notify?.(t("llama.repoEmpty"), false);
        return;
      }
      setRepo(r);
      setPicked(new Set());
    } catch (e) {
      fail(e);
    } finally {
      setLoading(false);
    }
  };

  const toggle = (file: string): void =>
    setPicked((p) => {
      const n = new Set(p);
      if (n.has(file)) n.delete(file);
      else n.add(file);
      return n;
    });

  const start = async (): Promise<void> => {
    if (!repo || !picked.size) return;
    const files = repo.files.filter((f) => picked.has(f.file));
    // Проектор нужен модели с картинками: берём из того же репозитория, если он там есть.
    const mm = repo.files.find((f) => f.role === "mmproj" && /f16|bf16/i.test(f.file));
    if (mm && section !== "image" && !files.includes(mm)) files.push(mm);
    // У картинок VAE берём из того же репозитория, если он там лежит (иначе докачается стандартный).
    const vae = repo.files.find((f) => f.role === "vae");
    if (vae && section === "image") files.push(vae);
    try {
      await api.llamaModelDownload({
        repo: repo.repo,
        rev: repo.rev,
        section,
        files: files.map((f) => ({ file: f.file, role: f.role })),
      });
      setRepo(null);
      setUrl("");
      onDone();
    } catch (e) {
      fail(e);
    }
  };

  return (
    <div className="llama-add">
      <div style={{ display: "flex", gap: 8 }}>
        <input
          className="text-input"
          style={{ flex: 1 }}
          value={url}
          placeholder={t("llama.repoPlaceholder")}
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void look();
          }}
        />
        <Btn icon={Search} disabled={loading || busy || !url.trim()} onClick={() => void look()}>
          {t("llama.repoLook")}
        </Btn>
      </div>
      {repo && (
        <div className="llama-add-list">
          <div className="muted-sm">
            {repo.repo} · {t("llama.repoPick")}
            {section === "image" ? ` · ${t("llama.repoImageNote")}` : ""}
          </div>
          {repo.files
            .filter((f) => f.role === "model")
            .map((f) => (
              <label key={f.file} className="llama-check">
                <input type="checkbox" checked={picked.has(f.file)} onChange={() => toggle(f.file)} />
                <span>
                  {f.file} <span className="muted-sm">· {mb(f.sizeMb)}</span>
                </span>
              </label>
            ))}
          <div style={{ display: "flex", gap: 8, marginTop: 6 }}>
            <Btn icon={Download} disabled={busy || !picked.size} onClick={() => void start()}>
              {t("translate.download")}
            </Btn>
            <Btn icon={X} onClick={() => setRepo(null)}>
              {t("translate.cancel")}
            </Btn>
          </div>
        </div>
      )}
    </div>
  );
}
