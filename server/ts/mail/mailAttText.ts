/**
 * Текст вложений для поиска: txt/csv/md/html/json, PDF (pdf-parse), DOCX/XLSX/PPTX (XML внутри zip).
 * Размер ограничен, чтобы база не раздувалась.
 */
import AdmZip from "adm-zip";

const MAX_CHARS = 20_000;
const MAX_BYTES = 12 * 1024 * 1024;

function strip(s: string): string {
  return s
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

function officeText(buf: Buffer): string {
  try {
    const zip = new AdmZip(buf);
    const parts: string[] = [];
    for (const e of zip.getEntries()) {
      if (/^(word\/document|xl\/sharedStrings|ppt\/slides\/slide\d+)\.xml$/i.test(e.entryName)) {
        parts.push(strip(e.getData().toString("utf8")));
      }
      if (parts.join(" ").length > MAX_CHARS) break;
    }
    return parts.join(" ");
  } catch {
    return "";
  }
}

async function pdfText(buf: Buffer): Promise<string> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require("pdf-parse") as {
      PDFParse?: new (o: { data: Buffer }) => { getText(): Promise<{ text: string }> };
    };
    if (mod.PDFParse) {
      const p = new mod.PDFParse({ data: buf });
      return (await p.getText()).text || "";
    }
  } catch {
    /* pdf-parse недоступен — пропускаем */
  }
  return "";
}

export async function attachmentText(
  filename: string,
  contentType: string,
  content: Buffer,
): Promise<string> {
  if (!content || content.length > MAX_BYTES) return "";
  const name = filename.toLowerCase();
  const ct = contentType.toLowerCase();
  let out = "";
  if (/^text\/(plain|csv|markdown)/.test(ct) || /\.(txt|csv|md|log|json|xml)$/.test(name)) {
    out = content.toString("utf8");
  } else if (ct.includes("html") || /\.html?$/.test(name)) {
    out = strip(content.toString("utf8"));
  } else if (ct === "application/pdf" || name.endsWith(".pdf")) {
    out = await pdfText(content);
  } else if (/\.(docx|xlsx|pptx)$/.test(name) || ct.includes("officedocument")) {
    out = officeText(content);
  }
  return out.replace(/\s+/g, " ").trim().slice(0, MAX_CHARS);
}
