/**
 * Распознавание страниц и картинок моделью Chandra OCR 2 (datalab-to/chandra, код Apache-2.0,
 * веса OpenRAIL-M — для личного использования) через встроенный llama.cpp.
 *
 * Модель отвечает HTML-блоками с координатами `data-bbox` (0–1000) и типом `data-label`.
 * Здесь только запуск модели; разбор HTML в Markdown и вырезание рисунков делает клиент
 * (у него есть DOM и canvas), см. src/lib/chandraMarkdown.ts.
 */
import path from "path";
import dns from "dns/promises";
import net from "net";
import { withServer } from "./engine";
import type { Device } from "./engine";
import { installed, modelPath } from "./models";

/** Подсказка Chandra «OCR в HTML блоками с разметкой» (chandra/prompts.py, OCR_LAYOUT_PROMPT). */
const ALLOWED_TAGS =
  "['math', 'br', 'i', 'b', 'u', 'del', 'sup', 'sub', 'table', 'tr', 'td', 'p', 'th', 'div', 'pre', 'h1', 'h2', 'h3', 'h4', 'h5', 'ul', 'ol', 'li', 'input', 'a', 'span', 'img', 'hr', 'tbody', 'small', 'caption', 'strong', 'thead', 'big', 'code', 'chem']";
const ALLOWED_ATTRIBUTES =
  "['class', 'colspan', 'rowspan', 'display', 'checked', 'type', 'border', 'value', 'style', 'href', 'alt', 'align', 'data-bbox', 'data-label']";

const PROMPT = `OCR this image to HTML, arranged as layout blocks.  Each layout block should be a div with the data-bbox attribute representing the bounding box of the block in x0 y0 x1 y1 format.  Bboxes are normalized 0-1000. The data-label attribute is the label for the block.

Use the following labels:
- Caption
- Footnote
- Equation-Block
- List-Group
- Page-Header
- Page-Footer
- Image
- Section-Header
- Table
- Text
- Complex-Block
- Code-Block
- Form
- Table-Of-Contents
- Figure
- Chemical-Block
- Diagram
- Bibliography
- Blank-Page

Only use these tags ${ALLOWED_TAGS}, and these attributes ${ALLOWED_ATTRIBUTES}.

Guidelines:
* Inline math: Surround math with <math>...</math> tags. Math expressions should be rendered in KaTeX-compatible LaTeX. Use display for block math.
* Tables: Use colspan and rowspan attributes to match table structure.
* Formatting: Maintain consistent formatting with the image, including spacing, indentation, subscripts/superscripts, and special characters.
* Images: Include a description of any images in the alt attribute of an <img> tag. Do not fill out the src property. Describe in detail inside the div tag. Also convert charts to high fidelity data, and convert diagrams to mermaid.
* Forms: Mark checkboxes and radio buttons properly.
* Text: join lines together properly into paragraphs using <p>...</p> tags.  Use <br> tags for line breaks within paragraphs, but only when absolutely necessary to maintain meaning.
* Chemistry: Use <chem>...</chem> tags for chemical formulas with reactive SMILES.
* Lists: Preserve indents and proper list markers.
* Use the simplest possible HTML structure that accurately represents the content of the block.
* Make sure the text is accurate and easy for a human to read and interpret.  Reading order should be correct and natural.`;

export interface OcrFiles {
  model: string;
  mmproj: string;
}

/** Установленные модели Chandra (основной GGUF), без проекторов. */
export function ocrModels(): { file: string; sizeMb: number }[] {
  return installed().filter((m) => /chandra/i.test(m.file) && !/mmproj/i.test(m.file));
}

/** Пара «модель + проектор»: выбранная модель или первая установленная. */
export function ocrFiles(wanted?: string): OcrFiles {
  const all = installed().map((m) => m.file);
  const models = ocrModels().map((m) => m.file);
  const model = wanted && models.includes(wanted) ? wanted : models[0];
  const mmproj = all.find((f) => /chandra/i.test(f) && /mmproj/i.test(f));
  if (!model || !mmproj) throw new Error("ocr_model_missing");
  return { model: modelPath(model), mmproj: modelPath(mmproj) };
}

export interface OcrResult {
  html: string;
  tokens: number;
  ms: number;
  build: string;
  gpu: boolean;
  model: string;
}

/** Контекст: изображение на 1,5–2,5 тыс. токенов плюс до 12 тыс. токенов ответа. */
const CTX = 16384;
const MAX_TOKENS = 12384;

export async function ocrImage(o: {
  image: Buffer;
  mime: string;
  model?: string;
  device?: Device;
  signal?: AbortSignal;
}): Promise<OcrResult> {
  const files = ocrFiles(o.model);
  const t0 = Date.now();
  return withServer(
    { model: files.model, mmproj: files.mmproj, ctx: CTX, device: o.device ?? "auto" },
    async (server) => {
      const res = await fetch(`${server.baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: o.signal,
        body: JSON.stringify({
          messages: [
            {
              role: "user",
              content: [
                {
                  type: "image_url",
                  image_url: { url: `data:${o.mime};base64,${o.image.toString("base64")}` },
                },
                { type: "text", text: PROMPT },
              ],
            },
          ],
          temperature: 0,
          max_tokens: MAX_TOKENS,
        }),
      });
      if (!res.ok) throw new Error(`llamacpp_${res.status}: ${(await res.text()).slice(0, 300)}`);
      const j = (await res.json()) as {
        choices?: { message?: { content?: string } }[];
        usage?: { completion_tokens?: number };
      };
      const html = j.choices?.[0]?.message?.content ?? "";
      if (!html.trim()) throw new Error("ocr_empty");
      return {
        html,
        tokens: j.usage?.completion_tokens ?? 0,
        ms: Date.now() - t0,
        build: server.build,
        gpu: server.gpu,
        model: path.basename(files.model),
      };
    },
  );
}

// ───────────────────── картинка по внешней ссылке ─────────────────────

const MAX_REMOTE = 25 * 1024 * 1024;

const privateIp = (ip: string): boolean => {
  if (net.isIPv6(ip)) return ip === "::1" || /^f[cd]/i.test(ip) || /^fe80/i.test(ip);
  const [a, b] = ip.split(".").map(Number);
  return (
    a === 10 ||
    a === 127 ||
    a === 0 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168)
  );
};

/** Скачать картинку по http(s)-ссылке (клиент не может: CORS). Локальные адреса запрещены. */
export async function fetchRemoteImage(url: string): Promise<{ data: Buffer; mime: string }> {
  let u = new URL(url);
  for (let hop = 0; hop < 4; hop++) {
    if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("bad_url");
    const host = u.hostname.replace(/^\[|\]$/g, "");
    const addrs = net.isIP(host)
      ? [host]
      : (await dns.lookup(host, { all: true })).map((a) => a.address);
    if (!addrs.length || addrs.some(privateIp)) throw new Error("private_address");
    const res = await fetch(u, {
      redirect: "manual",
      signal: AbortSignal.timeout(30000),
      headers: { "User-Agent": "MoonApp/1.0" },
    });
    const loc = res.headers.get("location");
    if (res.status >= 300 && res.status < 400 && loc) {
      u = new URL(loc, u);
      continue;
    }
    if (!res.ok) throw new Error(`remote_${res.status}`);
    const mime = (res.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
    if (!mime.startsWith("image/")) throw new Error("not_image");
    const data = Buffer.from(await res.arrayBuffer());
    if (data.length > MAX_REMOTE) throw new Error("too_large");
    return { data, mime };
  }
  throw new Error("too_many_redirects");
}
