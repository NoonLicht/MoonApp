import { describe, it, expect, beforeAll } from "vitest";
import { createRequire } from "module";

/** Режимы приложения (server/ts/appModes.ts). */
const req = createRequire(import.meta.url);
let am: any;
beforeAll(() => {
  am = req("../server/appModes");
});

const settings = () => ({
  appearance: { reduceMotion: false, density: "comfortable", theme: "dark" },
  monitor: { alertsEnabled: true, autoStart: false },
  performance: { keepPagesAlive: true, backgroundBlur: true },
  clipboardHistory: { enabled: true },
});

describe("snapshotFor / effectivePatch", () => {
  it("запоминает только ключи патча", () => {
    const snap = am.snapshotFor(settings(), { appearance: { reduceMotion: true }, nope: { x: 1 } });
    expect(snap).toEqual({ appearance: { reduceMotion: false }, nope: {} });
  });

  it("effectivePatch убирает уже выставленные значения", () => {
    const p = am.effectivePatch(settings(), { appearance: { reduceMotion: true, theme: "dark" } });
    expect(p).toEqual({ appearance: { reduceMotion: true } });
    expect(am.effectivePatch(settings(), { appearance: { theme: "dark" } })).toEqual({});
  });
});

describe("activate / deactivate", () => {
  let study: any;
  let game: any;
  beforeAll(() => {
    study = am.BUILTIN_MODES.find((m: any) => m.id === "study");
    game = am.BUILTIN_MODES.find((m: any) => m.id === "game");
  });

  it("включает режим и запоминает прежние значения", () => {
    const r = am.activate(settings(), am.EMPTY_STATE, study);
    expect(r.patch.appearance).toEqual({ reduceMotion: true, density: "compact" });
    expect(r.state.active).toBe("study");
    expect(r.state.previous.appearance).toEqual({ reduceMotion: false, density: "comfortable" });
    expect(r.state.previous.monitor).toEqual({ alertsEnabled: true });
  });

  it("выход возвращает прежние значения", () => {
    const on = am.activate(settings(), am.EMPTY_STATE, study);
    const off = am.deactivate(on.state);
    expect(off.patch).toEqual(on.state.previous);
    expect(off.state).toEqual(am.EMPTY_STATE);
    expect(am.deactivate(am.EMPTY_STATE).patch).toEqual({});
  });

  it("смена режима на лету не теряет исходные значения", () => {
    const cur = settings();
    const a = am.activate(cur, am.EMPTY_STATE, study);
    // настройки после включения «Учёбы»
    const applied = JSON.parse(JSON.stringify(cur));
    applied.appearance = { ...applied.appearance, ...a.patch.appearance };
    applied.monitor = { ...applied.monitor, ...a.patch.monitor };
    applied.clipboardHistory = { ...applied.clipboardHistory, ...a.patch.clipboardHistory };
    const b = am.activate(applied, a.state, game);
    expect(b.state.active).toBe("game");
    // исходное значение reduceMotion (false) сохранено, несмотря на два режима подряд
    expect(b.state.previous.appearance.reduceMotion).toBe(false);
    const off = am.deactivate(b.state);
    expect(off.patch.appearance.reduceMotion).toBe(false);
  });
});
