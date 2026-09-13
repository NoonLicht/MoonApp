import { describe, it, expect, beforeAll, afterAll } from "vitest";
import path from "path";
import fs from "fs";
import os from "os";

/**
 * Регресс на «⚠ Generation stopped»: на Node 18+ событие 'close' у req
 * срабатывает сразу после чтения тела запроса (а не при отключении клиента),
 * из-за чего генерация абортилась на первой миллисекунде у любого провайдера.
 * Здесь стартуем реальный роут /api/chat/:id/send с заглушённым провайдером и
 * проверяем, что:
 *   1) обычный стрим доходит до done и НЕ превращается в error;
 *   2) реальное отключение клиента всё ещё абортит генерацию.
 */

interface StreamEvent { type: string; text?: string; message?: string }

describe("chat SSE (регресс 'Generation stopped')", () => {
  let srv: { close: () => void; address: () => { port: number } } | null = null;
  let base = "";
  let lastSignal: AbortSignal | null = null;

  beforeAll(async () => {
    // Изолированное хранилище: реальные ключи и чаты не трогаем.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pa-chat-"));
    process.env.MOONAPP_STORAGE = tmp;

    const express = (await import("express")).default;
    const security: any = await import("../server/security");
    security.setSecret("deepseek", "test-key");

    const providers: any = await import("../server/providers");
    providers.getProvider("deepseek").chat = async ({ onToken, signal }: any) => {
      lastSignal = signal ?? null;
      let full = "";
      for (let i = 0; i < 6; i++) {
        if (signal?.aborted) throw Object.assign(new Error("aborted"), { name: "AbortError" });
        full += `tok${i} `;
        onToken?.(`tok${i} `);
        await new Promise((r) => setTimeout(r, 40));
      }
      return full;
    };

    const chatRouter = (await import("../server/routes/chat")).default;
    const app = express();
    app.use(express.json({ limit: "2mb" }));
    app.use("/api/chat", chatRouter);
    await new Promise<void>((resolve) => {
      srv = app.listen(0, "127.0.0.1", () => resolve());
    });
    base = `http://127.0.0.1:${srv!.address().port}`;
  });

  afterAll(() => { try { srv?.close(); } catch { /* noop */ } });

  async function newConversation(): Promise<number> {
    const res = await fetch(`${base}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: "deepseek", title: "regression test" }),
    });
    return (await res.json()).id;
  }

  async function readSse(res: Response, onEvent: (e: StreamEvent) => void): Promise<void> {
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    const dec = new TextDecoder();
    let buf = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const parts = buf.split("\n\n");
      buf = parts.pop() || "";
      for (const p of parts) {
        const line = p.split("\n").find((l) => l.startsWith("data:"));
        if (line) { try { onEvent(JSON.parse(line.slice(5).trim())); } catch { /* skip */ } }
      }
    }
  }

  it("стрим доходит до done и не падает в error", async () => {
    const id = await newConversation();
    const res = await fetch(`${base}/api/chat/${id}/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "привет", model: "deepseek-chat", stream: true }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");

    const events: StreamEvent[] = [];
    await readSse(res, (e) => events.push(e));

    const tokens = events.filter((e) => e.type === "token");
    const doneEv = events.find((e) => e.type === "done");
    const errEv = events.find((e) => e.type === "error");

    expect(errEv).toBeUndefined(); // ← здесь раньше был "Generation stopped"
    expect(tokens).toHaveLength(6);
    expect(doneEv?.text).toBe("tok0 tok1 tok2 tok3 tok4 tok5 ");
  }, 15000);

  it("отключение клиента по-прежнему абортит генерацию на сервере", async () => {
    const id = await newConversation();
    const ctl = new AbortController();
    let got = 0;
    try {
      const res = await fetch(`${base}/api/chat/${id}/send`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "второй", model: "deepseek-chat", stream: true }),
        signal: ctl.signal,
      });
      await readSse(res, () => { if (++got >= 2) ctl.abort(); });
    } catch { /* ожидаемый AbortError на клиенте */ }
    expect(got).toBeGreaterThanOrEqual(2);
    await new Promise((r) => setTimeout(r, 300));
    expect(lastSignal?.aborted).toBe(true);
  }, 15000);
});
