import { describe, it, expect } from "vitest";
import { parseModelNameError, splitModelNames } from "@/lib/modelError";

/**
 * Разбор ошибки провайдера про имя модели.
 *
 * Реальная жалоба: в конспекте лекции появлялось
 * `api error 400: {"error":{"message":"The supported API model names are
 * deepseek-flash, deepseek-v4-pro, but you passed depseek-flash."}}` — опечатка
 * в сохранённой модели, а интерфейс показывал сырой JSON без подсказки.
 */
describe("parseModelNameError — имена моделей из ответа провайдера", () => {
  it("достаёт принимаемые имена и отправленное имя (кейс из жалобы)", () => {
    const raw =
      'api error 400: {"error":{"message":"The supported API model names are deepseek-flash, ' +
      'deepseek-v4-pro, but you passed depseek-flash.","type":"invalid_request_error"}}';
    expect(parseModelNameError(raw)).toEqual({
      names: ["deepseek-flash", "deepseek-v4-pro"],
      model: "depseek-flash",
    });
  });

  it("работает с одиночным именем в списке", () => {
    const e = parseModelNameError(
      "The supported API model names are gpt-4o-mini, but you passed gpt-4o-mni",
    );
    expect(e).toEqual({ names: ["gpt-4o-mini"], model: "gpt-4o-mni" });
  });

  it("перечисляет имена и без части «but you passed»", () => {
    expect(parseModelNameError("Supported model names are llama3, mistral.")).toEqual({
      names: ["llama3", "mistral"],
      model: "",
    });
  });

  it("понимает «Model Not Exist» и «does not exist»", () => {
    expect(parseModelNameError("Model Not Exist")).toEqual({ names: [], model: "" });
    expect(parseModelNameError("The model `gpt-5-turbo` does not exist")).toEqual({
      names: [],
      model: "gpt-5-turbo",
    });
  });

  it("не считает ошибкой модели всё остальное", () => {
    for (const msg of [
      "",
      "api error 401: invalid api key",
      "conspectus_not_configured: deepseek",
      "HTTP 500",
      "no_transcript_yet",
    ]) {
      expect(parseModelNameError(msg), msg).toBeNull();
    }
  });

  it("splitModelNames чистит кавычки, «or» и мусорные слова", () => {
    expect(splitModelNames('"a-1", `b_2` or c.3 and but you passed')).toEqual([
      "a-1",
      "b_2",
      "c.3",
    ]);
    expect(splitModelNames("")).toEqual([]);
  });
});
