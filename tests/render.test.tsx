import { describe, it, expect } from "vitest";
import React from "react";
import { renderToString } from "react-dom/server";

import App from "@/app/App";
import StorePage from "@/pages/store/StorePage";
import MyspacePage from "@/pages/myspace/MyspacePage";
import AiChatPage from "@/pages/ai-chat/AiChatPage";
import ConverterPage from "@/pages/convert/ConverterPage";
import VideoPage from "@/pages/video/VideoPage";
import MusicPage from "@/pages/music/MusicPage";
import BooksPage from "@/pages/books/BooksPage";
import AudiobookTTSPage from "@/pages/voice/AudiobookTTSPage";
import ArchiverPage from "@/pages/archiver/ArchiverPage";
import SettingsPage from "@/pages/settings/SettingsPage";
import MonitorPage from "@/pages/monitor/MonitorPage";
import LectureRecorderPage from "@/pages/lecture/LectureRecorderPage";
import BypassControlPage from "@/pages/bypass/BypassControlPage";
import CompressorPage from "@/pages/compressor/CompressorPage";

describe("render smoke (ловит runtime-краши рендера)", () => {
  it("App (Store по умолчанию) рендерится без ошибок", () => {
    expect(() => renderToString(React.createElement(App))).not.toThrow();
  });

  const pages: [string, React.ComponentType][] = [
    ["Store", StorePage],
    ["Myspace", MyspacePage],
    ["AiChat", AiChatPage],
    ["Convert", ConverterPage],
    ["Video", VideoPage],
    ["Music", MusicPage],
    ["Books", BooksPage],
    ["Voice", AudiobookTTSPage],
    ["Archive", ArchiverPage],
    ["Compress", CompressorPage],
    ["Settings", SettingsPage],
    ["Monitor", MonitorPage],
    ["Lecture", LectureRecorderPage],
    ["Bypass", BypassControlPage],
  ];

  for (const [name, Page] of pages) {
    it(`${name} рендерится без ошибок`, () => {
      expect(() => renderToString(React.createElement(Page))).not.toThrow();
    });
  }
});
