import { describe, it, expect } from "vitest";
import React from "react";
import { renderToString } from "react-dom/server";

import App from "../src/App";
import StorePage from "../src/pages/StorePage";
import MyspacePage from "../src/pages/MyspacePage";
import AiChatPage from "../src/pages/AiChatPage";
import ConverterPage from "../src/pages/ConverterPage";
import VideoPage from "../src/pages/VideoPage";
import MusicPage from "../src/pages/MusicPage";
import BooksPage from "../src/pages/BooksPage";
import AudiobookTTSPage from "../src/pages/AudiobookTTSPage";
import ArchiverPage from "../src/pages/ArchiverPage";
import SettingsPage from "../src/pages/SettingsPage";
import MonitorPage from "../src/pages/MonitorPage";
import LectureRecorderPage from "../src/pages/LectureRecorderPage";
import BypassControlPage from "../src/pages/BypassControlPage";
import CompressorPage from "../src/pages/CompressorPage";

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