import { describe, it, expect } from "vitest";
import React from "react";
import { renderToString } from "react-dom/server";

import App from "../src/App";
import StorePage from "../src/pages/StorePage";
import TodoPage from "../src/pages/TodoPage";
import AiChatPage from "../src/pages/AiChatPage";
import ConverterPage from "../src/pages/ConverterPage";
import VideoPage from "../src/pages/VideoPage";
import MusicPage from "../src/pages/MusicPage";
import BooksPage from "../src/pages/BooksPage";
import VoicePage from "../src/pages/VoicePage";
import ArchiverPage from "../src/pages/ArchiverPage";
import SettingsPage from "../src/pages/SettingsPage";

describe("render smoke (ловит runtime-краши рендера)", () => {
  it("App (Store по умолчанию) рендерится без ошибок", () => {
    expect(() => renderToString(React.createElement(App))).not.toThrow();
  });

  const pages = [
    ["Store", StorePage],
    ["Todo", TodoPage],
    ["AiChat", AiChatPage],
    ["Convert", ConverterPage],
    ["Video", VideoPage],
    ["Music", MusicPage],
    ["Books", BooksPage],
    ["Voice", VoicePage],
    ["Archive", ArchiverPage],
    ["Settings", SettingsPage],
  ];

  for (const [name, Page] of pages) {
    it(`${name} рендерится без ошибок`, () => {
      expect(() => renderToString(React.createElement(Page))).not.toThrow();
    });
  }
});