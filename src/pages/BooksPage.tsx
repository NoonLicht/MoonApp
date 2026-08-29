import React, { useState, useEffect } from "react";
import { Search, BookOpen, Download } from "lucide-react";
import { Glass, Btn, Badge, Select, SectionHead, EmptyHint } from "../components/ui";
import { usePageToolbar } from "../components/Toolbar";
import { useI18n } from "../i18n";
import { api } from "../api/client";
import type { BooksItem } from "../api/types";

export default function BooksPage() {
  const { t } = useI18n();
  const [books, setBooks] = useState<BooksItem[]>([]);
  const [query, setQuery] = useState("");
  const [fmtFilter, setFmtFilter] = useState(t("books.allFormats"));

  useEffect(() => { api.getBooks().then(setBooks).catch(() => {}); }, []);

  usePageToolbar(
    <Select value={fmtFilter} onChange={(e) => setFmtFilter(e.target.value)} options={[t("books.allFormats"), "EPUB", "PDF", "MOBI"]} />,
    [fmtFilter, t]
  );

  const results = books.filter(
    (b) =>
      b.title.toLowerCase().includes(query.toLowerCase()) &&
      (fmtFilter === t("books.allFormats") || (b.fmt || "").includes(fmtFilter))
  );

  return (
    <div className="page">
      <SectionHead eyebrow={t("books.results", { n: results.length })} title={t("books.title")} />
      <Glass className="url-bar">
        <Search size={16} />
        <input placeholder={t("books.search")} value={query} onChange={(e) => setQuery(e.target.value)} />
      </Glass>

      <div className="book-list">
        {results.map((b) => (
          <Glass className="book-row" key={b.id}>
            <div className={`book-cover tone-${b.tone}`}>
              <BookOpen size={20} strokeWidth={1.6} />
              <span>{b.title.split(" ").map((w) => w[0]).slice(0, 2).join("")}</span>
            </div>
            <div className="book-body">
              <div className="book-title-row">
                <div>
                  <div className="media-title">{b.title}</div>
                  <div className="muted-sm">{b.author} · {b.year}</div>
                </div>
                <div className="quality-row">
                  {(b.fmt || "").split(",").filter(Boolean).map((f) => <Badge key={f} tone={b.tone} mono>{f}</Badge>)}
                </div>
              </div>
              <p className="book-desc">{b.description}</p>
              <Btn variant="secondary" icon={Download} style={{ width: 130 }}>{t("books.download")}</Btn>
            </div>
          </Glass>
        ))}
        {results.length === 0 && <EmptyHint icon={BookOpen} text={t("books.empty")} />}
      </div>
    </div>
  );
}