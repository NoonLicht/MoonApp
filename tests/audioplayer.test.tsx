import React from "react";
import { describe, it, expect } from "vitest";
import { renderToString } from "react-dom/server";
import { I18nProvider } from "../src/i18n";
import AudioPlayer from "../src/components/AudioPlayer";

describe("AudioPlayer", () => {
  it("рендерится в SSR и содержит кнопки перемотки/скорости", () => {
    const html = renderToString(
      <I18nProvider lang="ru">
        <AudioPlayer src="blob:demo" />
      </I18nProvider>
    );
    expect(html).toContain("audio-player");
    expect(html).toContain("Назад на 10 секунд");
    expect(html).toContain("Вперёд на 10 секунд");
    expect(html).toContain("Играть");
    expect(html).toContain("1<!-- -->×");
    expect(html).toContain("0:00");
    expect(html).toContain("ap-seek");
  });

  it("compact-вариант скрывает перемотку и скорость", () => {
    const html = renderToString(
      <I18nProvider lang="ru">
        <AudioPlayer src="blob:demo" compact />
      </I18nProvider>
    );
    expect(html).toContain("is-compact");
    expect(html).not.toContain("Назад на 10 секунд");
    expect(html).not.toContain("Скорость воспроизведения");
  });
});
