import { describe, it, expect, beforeAll } from "vitest";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Привязка модели к ИИ-функциям: хранение, «авто», подмена цели запроса. */
const STORAGE = fs.mkdtempSync(path.join(os.tmpdir(), "moonapp-bind-"));
process.env.MOONAPP_STORAGE = STORAGE;
const req = createRequire(import.meta.url);
/* eslint-disable @typescript-eslint/no-explicit-any */
let b: any;

beforeAll(() => {
  b = req("../server/aiBindings");
});

describe("привязка моделей к ИИ-функциям", () => {
  it("по умолчанию у всех функций «авто» — привязки нет", () => {
    for (const f of b.FEATURES) expect(b.boundOf(f.id)).toBeNull();
    expect(b.boundTarget("chat")).toBeNull();
    expect(b.boundTarget(undefined)).toBeNull();
  });

  it("снятое «авто» с провайдером и моделью включает привязку, возврат «авто» её снимает", () => {
    b.setBinding("notes.commands", { auto: false, provider: "llamacpp", model: "Qwen3.5-4B-Q4_K_M.gguf" });
    expect(b.boundOf("notes.commands")).toEqual({
      provider: "llamacpp",
      model: "Qwen3.5-4B-Q4_K_M.gguf",
    });
    expect(b.boundOf("mail")).toBeNull();
    b.setBinding("notes.commands", { auto: true });
    expect(b.boundOf("notes.commands")).toBeNull();
    // выбранные провайдер и модель запоминаются, чтобы при повторном снятии «авто» не вводить заново
    expect(b.getBindings()["notes.commands"].model).toBe("Qwen3.5-4B-Q4_K_M.gguf");
  });

  it("без модели привязка не считается рабочей; неизвестная функция отклоняется", () => {
    b.setBinding("mail", { auto: false, provider: "llamacpp", model: "" });
    expect(b.boundOf("mail")).toBeNull();
    expect(() => b.setBinding("nope", { auto: false })).toThrow();
  });

  it("цель для локальной модели добавляет задачу функции в запрос", async () => {
    const providers = req("../server/providers");
    const llama = providers.getProvider("llamacpp");
    const seen: any[] = [];
    const orig = llama.chat;
    llama.chat = async (o: any) => {
      seen.push(o);
      return "ok";
    };
    try {
      b.setBinding("notes.commands", { auto: false, provider: "llamacpp", model: "x.gguf" });
      const t = b.boundTarget("notes.commands");
      expect(t.model).toBe("x.gguf");
      expect(t.provider.id).toBe("llamacpp");
      await t.provider.chat({ model: t.model, messages: [] });
      expect(seen[0].task).toBe("command");
    } finally {
      llama.chat = orig;
    }
  });

  it("выключатель: функции по умолчанию включены, чат/щит/перевод выключить нельзя", () => {
    expect(b.featureEnabled("notes.ai")).toBe(true);
    b.setBinding("notes.ai", { enabled: false });
    expect(b.featureEnabled("notes.ai")).toBe(false);
    expect(() => b.assertFeature("notes.ai")).toThrow(/ai_feature_disabled/);
    b.setBinding("notes.ai", { enabled: true });
    expect(b.featureEnabled("notes.ai")).toBe(true);
    for (const id of ["chat", "shield", "translate"]) {
      b.setBinding(id, { enabled: false });
      expect(b.featureEnabled(id)).toBe(true);
    }
  });

  it("сброс возвращает все функции в «авто»", () => {
    b.setBinding("chat", { auto: false, provider: "llamacpp", model: "y.gguf" });
    b.resetBindings();
    expect(b.boundOf("chat")).toBeNull();
    expect(Object.keys(b.getBindings())).toHaveLength(0);
  });
});
