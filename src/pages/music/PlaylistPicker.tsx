import { useMemo, useState } from "react";
import { Download, ListMusic } from "lucide-react";
import { useI18n } from "@/app/i18n";
import { Btn, Glass } from "@/components/ui";
import type { MusicTrack } from "@/api/types";

function fmtDur(sec?: number | null): string {
  if (sec == null) return "";
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`;
}

/**
 * Список треков плейлиста со ссылки: можно отметить нужные песни и скачать
 * сразу несколько. Сама очередь скачивания живёт в MusicPage (onDownload).
 */
export default function PlaylistPicker({
  title,
  tracks,
  busy,
  progress,
  onDownload,
}: {
  title: string;
  tracks: MusicTrack[];
  busy: boolean;
  /** «3 / 12» — ход очереди, пока busy. */
  progress: string;
  onDownload: (picked: MusicTrack[]) => void;
}) {
  const { t } = useI18n();
  const [picked, setPicked] = useState<Set<string>>(() => new Set(tracks.map((x) => x.id)));
  const list = useMemo(() => tracks.filter((x) => picked.has(x.id)), [tracks, picked]);
  const toggle = (id: string) =>
    setPicked((prev) => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  return (
    <Glass className="pl-picker">
      <div className="pl-picker-head">
        <ListMusic size={18} />
        <div className="pl-picker-title">
          {title || t("music.playlistFromLink")} · {tracks.length}
        </div>
        <Btn variant="ghost" onClick={() => setPicked(new Set(tracks.map((x) => x.id)))}>
          {t("music.pickAll")}
        </Btn>
        <Btn variant="ghost" onClick={() => setPicked(new Set())}>
          {t("music.pickNone")}
        </Btn>
        <Btn
          variant="primary"
          icon={Download}
          disabled={busy || list.length === 0}
          onClick={() => onDownload(list)}
        >
          {busy ? progress : t("music.downloadPicked", { n: list.length })}
        </Btn>
      </div>
      <div className="pl-picker-list">
        {tracks.map((tr) => (
          <label key={tr.id} className={`pl-picker-row${picked.has(tr.id) ? " on" : ""}`}>
            <input type="checkbox" checked={picked.has(tr.id)} onChange={() => toggle(tr.id)} />
            <span className="pl-picker-name">{tr.title}</span>
            <span className="muted-sm">{tr.artist}</span>
            <span className="muted-sm pl-picker-dur">{fmtDur(tr.duration)}</span>
          </label>
        ))}
      </div>
    </Glass>
  );
}
