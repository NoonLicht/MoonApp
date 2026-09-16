import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import path from "path";
import { streamChatSend, streamArena } from "@/api/client";

/**
 * Единый приём SSE-потока в src/api/client.ts (postStream).
 *
 * Раньше «отправить в чат» и «arena» держали по собственной копии разбора
 * потока: fetch + getReader + разбор кадров «data: {...}» по \n\n. Копии
 * различались только URL и типом тела, а поведение у них обязано совпадать:
 *  1) кадр, разрезанный между чанками, должен собираться, а не теряться;
 *  2) битый JSON в одном кадре не роняет остаток ответа (skip);
 *  3) 409/401 приходят текстом сервера, прочие ошибки — «HTTP <код>»;
 *  4) оба эндпоинта идут каждый на свой путь.
 * Тесты поведенческие (fetch подменяется Response с ReadableStream) плюс
 * контракт по исходникам: вторая копия разбора не должна вернуться.
 */

interface Call {
  url: string;
  init?: RequestInit;
}

let calls: Call[] = [];
let respond: (url: string, init?: RequestInit) => Response | Promise<Response>;

function sseResponse(chunks: string[]): Response {
  const enc = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(enc.encode(c));
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

beforeEach(() => {
  calls = [];
  respond = () => new Response(null, { status: 200 });
  vi.stubGlobal("window", { appBridge: { getToken: () => "test-token" } });
  vi.stubGlobal("fetch", async (url: unknown, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return respond(String(url), init);
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("postStream: общий разбор SSE для чата и арены", () => {
  it("собирает кадр, разрезанный между чанками, и пропускает битый JSON", async () => {
    respond = () =>
      sseResponse([
        'data: {"type":"tok', // кадр разрезан посередине
        'en","text":"a"}\n\n',
        "data: {broken-json\n\n", // битый кадр — пропускается
        'data: {"type":"done","text":"ab"}\n\n',
        'data: {"type":"meta","model":"m"}\n\n',
      ]);

    const events: unknown[] = [];
    await streamChatSend(7, { text: "привет" }, (ev) => events.push(ev));

    expect(events).toEqual([
      { type: "token", text: "a" },
      { type: "done", text: "ab" },
      { type: "meta", model: "m" },
    ]);
  });

  it("незавершённый хвост потока игнорируется (сервер закрывает кадр \\n\\n)", async () => {
    // server/routes/chat.js пишет ровно `data: {...}\n\n`, поэтому хвост без
    // разделителя — это недочитанный кадр, а не событие: отдавать его нельзя,
    // иначе в чат попал бы обрывок ответа.
    respond = () => sseResponse(['data: {"type":"done","text":"ok"}\n\ndata: {"type":"tok']);

    const events: unknown[] = [];
    await streamChatSend(1, { text: "x" }, (ev) => events.push(ev));

    expect(events).toEqual([{ type: "done", text: "ok" }]);
  });

  it("обычная отправка идёт на /send с POST и системными заголовками", async () => {
    await streamChatSend(7, { text: "привет", stream: true }, () => {});
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("/api/chat/7/send");
    expect(calls[0].init?.method).toBe("POST");
    const headers = calls[0].init?.headers as Record<string, string>;
    expect(headers["Content-Type"]).toBe("application/json");
    expect(headers["x-moonapp-token"]).toBe("test-token");
    expect(headers["X-App-Page"]).toBeDefined();
  });

  it("арена идёт на /arena (и это тот же разбор потока)", async () => {
    respond = () => sseResponse(['data: {"type":"done","side":"a","text":"x"}\n\n']);
    const events: unknown[] = [];
    await streamArena(3, { text: "q", models: ["m1", "m2"], persist: false }, (ev) =>
      events.push(ev),
    );
    expect(calls[0].url).toBe("/api/chat/3/arena");
    expect(events).toEqual([{ type: "done", side: "a", text: "x" }]);
  });

  it("409 отдаёт текст сервера, а не «HTTP 409»", async () => {
    respond = () =>
      new Response(JSON.stringify({ error: "Провайдер не настроен" }), { status: 409 });
    await expect(streamChatSend(1, { text: "x" }, () => {})).rejects.toThrow(
      "Провайдер не настроен",
    );
  });

  it("прочие ошибки HTTP приходят кодом", async () => {
    respond = () => new Response("boom", { status: 500 });
    await expect(streamArena(1, { text: "x", models: ["a", "b"] }, () => {})).rejects.toThrow(
      "HTTP 500",
    );
  });
});

describe("контракт: разбор SSE живёт в одном месте", () => {
  const clientSrc = fs.readFileSync(
    path.resolve(__dirname, "..", "src", "api", "client.ts"),
    "utf8",
  );

  it("в client.ts ровно одно чтение потока (getReader)", () => {
    // Вторая копия разбора означала бы, что чинили поведение в одном месте,
    // а второе (арена или чат) осталось бы со старыми багами.
    expect((clientSrc.match(/\.getReader\(\)/g) || []).length).toBe(1);
  });

  it("и чат, и арена делегируют в postStream", () => {
    expect(clientSrc).toMatch(/async function postStream\(/);
    expect((clientSrc.match(/return postStream\(/g) || []).length).toBe(2);
  });

  it("разбор кадров идёт по разделителю \\n\\n (формат server/routes/chat.js)", () => {
    expect(clientSrc).toContain('split("\\n\\n")');
  });
});
