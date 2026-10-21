import { describe, it, expect, vi } from "vitest";
import { WcLink } from "../src/lib/wcLink";

/** Связь страницы с рамкой WordCraft: запросы, ответы, ожидание готовности и события. */
const make = () => {
  const sent: Array<Record<string, unknown>> = [];
  const events = { changed: vi.fn(), download: vi.fn() };
  const link = new WcLink(events);
  link.win = { postMessage: (m: Record<string, unknown>) => sent.push(m) } as unknown as Window;
  return { link, sent, events };
};

describe("WcLink", () => {
  it("команда уходит в рамку и получает ответ по номеру запроса", async () => {
    const { link, sent } = make();
    const p = link.run("text.insert", { text: "Привет" });
    expect(sent[0]).toMatchObject({ wc: 1, op: "run", params: { command: "text.insert", params: { text: "Привет" } } });
    link.handle({ wc: 1, id: sent[0].id, ok: true, result: { done: 1 } });
    await expect(p).resolves.toEqual({ done: 1 });
  });

  it("ошибка команды — исключение для run и значение {ok:false} для exec", async () => {
    const { link, sent } = make();
    const p = link.run("bad");
    link.handle({ wc: 1, id: sent[0].id, ok: false, error: "нет такой команды" });
    await expect(p).rejects.toThrow("нет такой команды");
    const e = link.exec("bad");
    link.handle({ wc: 1, id: sent[1].id, ok: false, error: "нет такой команды" });
    await expect(e).resolves.toEqual({ ok: false, error: "нет такой команды" });
  });

  it("выгрузка документа возвращает байты, чужой номер запроса игнорируется", async () => {
    const { link, sent } = make();
    const p = link.exportFile("a.docx");
    link.handle({ wc: 1, id: 9999, ok: true, result: {}, bytes: new Uint8Array([1]) });
    const bytes = new Uint8Array([80, 75]);
    link.handle({ wc: 1, id: sent[0].id, ok: true, result: {}, bytes });
    await expect(p).resolves.toBe(bytes);
  });

  it("действия ждут сообщения ready; состояние и скачивание доходят до страницы", () => {
    const { link, events } = make();
    const ready = vi.fn();
    link.whenReady(ready);
    expect(ready).not.toHaveBeenCalled();
    link.handle({ wc: 1, evt: "ready" });
    expect(ready).toHaveBeenCalledOnce();
    link.whenReady(ready);
    expect(ready).toHaveBeenCalledTimes(2);

    link.handle({ wc: 1, evt: "state", state: JSON.stringify({ rev: 3, dirty: true, pages: 1, words: 2 }) });
    expect(link.state?.rev).toBe(3);
    expect(events.changed).toHaveBeenCalledOnce();

    const bytes = new Uint8Array([1, 2]);
    link.handle({ wc: 1, evt: "download", name: "Отчёт.docx", bytes });
    expect(events.download).toHaveBeenCalledWith("Отчёт.docx", bytes);
  });

  it("закрытие связи отклоняет ждущие запросы", async () => {
    const { link } = make();
    const p = link.run("x");
    link.dispose();
    await expect(p).rejects.toThrow("closed");
  });
});
