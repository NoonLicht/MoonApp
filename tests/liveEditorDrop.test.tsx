// @vitest-environment happy-dom
import React, { act } from "react";
import { describe, it, expect } from "vitest";
import { createRoot } from "react-dom/client";
import CodeMirrorLiveEditor from "../src/pages/myspace/parts/CodeMirrorLiveEditor";
import type {
  OcrImageRequest,
  PdfDropRequest,
} from "../src/pages/myspace/parts/CodeMirrorLiveEditor";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// happy-dom шлёт selectionchange синхронно прямо посреди обновления CodeMirror (в браузере — асинхронно),
// из-за чего CodeMirror падает «update in progress». Подписку на это событие в тестах отключаем.
const addListener = document.addEventListener.bind(document);
document.addEventListener = ((type: string, ...rest: unknown[]) =>
  type === "selectionchange"
    ? undefined
    : (addListener as (...a: unknown[]) => void)(
        type,
        ...rest,
      )) as typeof document.addEventListener;

const LABELS = { ocr: "Распознать", settings: "Настройки", busy: "Распознаю…" };

interface Mounted {
  host: HTMLElement;
  doc: () => string;
}

async function mount(
  content: string,
  props: Partial<React.ComponentProps<typeof CodeMirrorLiveEditor>> = {},
): Promise<Mounted> {
  const host = document.createElement("div");
  document.body.appendChild(host);
  let latest = content;
  await act(async () => {
    createRoot(host).render(
      <CodeMirrorLiveEditor
        content={content}
        onChange={(v) => {
          latest = v;
        }}
        {...props}
      />,
    );
  });
  return { host, doc: () => latest };
}

function drop(host: HTMLElement, files: File[]): void {
  const ev = new Event("drop", { bubbles: true, cancelable: true }) as Event & {
    dataTransfer: unknown;
    clientX: number;
    clientY: number;
  };
  ev.dataTransfer = { files, types: ["Files"] };
  ev.clientX = 0;
  ev.clientY = 0;
  host.querySelector(".cm-content")!.dispatchEvent(ev);
}

describe("живой редактор: PDF и кнопка OCR на картинке", () => {
  it("PDF, брошенный на редактор, ставит маркер и отдаёт запрос на распознавание", async () => {
    const reqs: PdfDropRequest[] = [];
    const m = await mount("Начало\n", { onDropPdf: (r) => reqs.push(r) });
    await act(async () =>
      drop(m.host, [new File(["%PDF-1.4"], "лекция.pdf", { type: "application/pdf" })]),
    );
    expect(reqs).toHaveLength(1);
    expect(reqs[0].file.name).toBe("лекция.pdf");
    expect(m.doc()).toContain(reqs[0].marker);
    expect(reqs[0].marker).toContain("лекция.pdf");

    // Страницы подставляются на место маркера, маркер остаётся для следующей страницы
    await act(async () => {
      expect(reqs[0].replace(reqs[0].marker, `Страница 1\n\n${reqs[0].marker}`)).toBe(true);
    });
    expect(m.doc()).toContain("Страница 1");
    await act(async () => {
      expect(reqs[0].replace(reqs[0].marker, "")).toBe(true);
    });
    expect(m.doc()).not.toContain("⏳");
    expect(reqs[0].replace("нет такого", "x")).toBe(false);
  });

  it("не-PDF файлы игнорируются", async () => {
    const reqs: PdfDropRequest[] = [];
    const m = await mount("a\n", { onDropPdf: (r) => reqs.push(r) });
    await act(async () => drop(m.host, [new File(["x"], "a.txt", { type: "text/plain" })]));
    expect(reqs).toHaveLength(0);
  });

  it("на картинке есть кнопки OCR и настроек; OCR заменяет картинку текстом", async () => {
    const got: OcrImageRequest[] = [];
    let settings = 0;
    const m = await mount("Текст\n\n![скан](/api/myspace/assets/abc)\n\nКонец\n", {
      onOcrImage: (r) => got.push(r),
      onOcrSettings: () => settings++,
      ocrLabels: LABELS,
    });
    const btns = m.host.querySelectorAll<HTMLButtonElement>(".cm-live-imgbtn");
    expect(btns).toHaveLength(2);
    await act(async () => btns[0].click());
    expect(got).toHaveLength(1);
    expect(got[0].src).toBe("/api/myspace/assets/abc");
    await act(async () => btns[1].click());
    expect(settings).toBe(1);
    await act(async () => {
      expect(got[0].replace("## Заголовок\n\nТекст страницы")).toBe(true);
    });
    expect(m.doc()).toContain("## Заголовок");
    expect(m.doc()).not.toContain("/api/myspace/assets/abc");
  });

  it("пока идёт распознавание, на картинке индикатор и кнопка OCR отключена", async () => {
    const m = await mount("a\n\n![](/api/myspace/assets/abc)\n\nb\n", {
      onOcrImage: () => undefined,
      ocrLabels: LABELS,
      ocrBusy: ["/api/myspace/assets/abc"],
    });
    expect(m.host.querySelector(".cm-live-imgbusy")?.textContent).toBe("Распознаю…");
    expect(m.host.querySelector<HTMLButtonElement>(".cm-live-imgbtn")!.disabled).toBe(true);
  });
});
