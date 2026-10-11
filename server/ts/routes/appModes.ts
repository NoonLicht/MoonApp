/**
 * Режимы приложения (логика — в appModes.ts).
 *
 *  GET  /api/app-modes             — { modes: [{ id }], active }
 *  POST /api/app-modes/activate    — { id } → включить режим; возвращает применённые настройки
 *  POST /api/app-modes/deactivate  — вернуть настройки, которые были до режима
 */
import express from "express";
import fs from "fs";
import path from "path";
import config from "../config";
import settings from "../settings";
import * as am from "../appModes";

const router = express.Router();

const stateFile = (): string => path.join(config.DIRS.storage, "app-mode.json");

function loadState(): am.ModeState {
  try {
    const raw = JSON.parse(fs.readFileSync(stateFile(), "utf8"));
    if (raw && typeof raw === "object" && "previous" in raw) return raw as am.ModeState;
  } catch {
    /* нет файла — режим не включён */
  }
  return am.EMPTY_STATE;
}

const saveState = (s: am.ModeState): void => fs.writeFileSync(stateFile(), JSON.stringify(s), "utf8");

router.get("/", (_req, res) => {
  res.json({ modes: am.BUILTIN_MODES.map((m) => ({ id: m.id })), active: loadState().active });
});

router.post("/activate", (req, res) => {
  const mode = am.BUILTIN_MODES.find((m) => m.id === String(req.body?.id ?? ""));
  if (!mode) return res.status(404).json({ error: "mode_not_found" });
  const r = am.activate(settings.get() as am.Tree, loadState(), mode);
  const applied = settings.set(r.patch as never);
  saveState(r.state);
  res.json({ active: r.state.active, settings: applied });
});

router.post("/deactivate", (_req, res) => {
  const r = am.deactivate(loadState());
  const applied = settings.set(r.patch as never);
  saveState(r.state);
  res.json({ active: null, settings: applied });
});

export = router;
