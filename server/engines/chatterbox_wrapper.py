# -*- coding: utf-8 -*-
"""
Chatterbox Multilingual (Resemble AI, MIT) — сайдкар озвучки.

Протокол тот же, что у f5_wrapper.py / xtts_wrapper.py: JSON-lines через stdin/stdout.

Вход:
  {"type":"init","ffmpeg":"..."}
  {"type":"infer","ref":".../ref.wav","text":"...","out":".../chunk.wav",
   "exaggeration":0.5,"cfg":0.5,"temperature":0.8,"sentencePauseMs":400}
  {"type":"shutdown"}

Выход: ready / vram / done / error — как у соседних движков.

Язык синтеза — русский (LANGUAGE): как и у XTTS, он не определяется по тексту.
Знаки ударения Chatterbox не понимает, поэтому «+» и акуты вырезаются.
Каждый файл модель помечает невидимым водяным знаком Perth (так задумано авторами).
"""
import sys
import json
import re
import gc
import time

try:
    from py_audio import force_utf8, prepare as prepare_audio
except ImportError:  # запуск не из каталога скрипта
    import os

    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    from py_audio import force_utf8, prepare as prepare_audio

LANGUAGE = "ru"
# Модель устойчиво держит ~300 символов за проход; длиннее режем по предложениям.
MAX_CHARS = 280

_COMBINING = re.compile("[̀-ͯ҃-҉]")
_PLUS_BEFORE_VOWEL = re.compile(r"\+([аеёиоуыэюяАЕЁИОУЫЭЮЯ])")
_SENT_SPLIT = re.compile(r"(?<=[.!?;…])\s+")
_CLAUSE_SPLIT = re.compile(r"(?<=[,:—–])\s+")


def drop_stress(text):
    return _PLUS_BEFORE_VOWEL.sub(r"\1", _COMBINING.sub("", str(text or "")))


def split_text(text, limit=MAX_CHARS):
    """Режем по предложениям, затем по запятым, затем по пробелам, затем по символам."""
    text = text.strip()
    if not text:
        return []
    if len(text) <= limit:
        return [text]
    for splitter in (_SENT_SPLIT, _CLAUSE_SPLIT, re.compile(r"\s+")):
        parts = [p for p in splitter.split(text) if p.strip()]
        if len(parts) > 1:
            out, cur = [], ""
            for p in parts:
                if cur and len(cur) + 1 + len(p) > limit:
                    out.append(cur)
                    cur = p
                else:
                    cur = (cur + " " + p).strip()
            if cur:
                out.append(cur)
            res = []
            for piece in out:
                res.extend(split_text(piece, limit) if len(piece) > limit else [piece])
            return res
    return [text[i : i + limit] for i in range(0, len(text), limit)]


def _load_model(device):
    """Класс многоязычной модели называется по-разному в версиях пакета."""
    errors = []
    for mod, cls in (
        ("chatterbox.mtl_tts", "ChatterboxMultilingualTTS"),
        ("chatterbox", "ChatterboxMultilingualTTS"),
    ):
        try:
            m = __import__(mod, fromlist=[cls])
            return getattr(m, cls).from_pretrained(device=device)
        except Exception as e:  # пробуем следующий путь, ошибку запоминаем
            errors.append("%s.%s: %s" % (mod, cls, e))
    raise RuntimeError("chatterbox_load_failed: " + " | ".join(errors))[:600]


class ChatterboxEngine:
    def __init__(self, cfg):
        self.shims = prepare_audio(str(cfg.get("ffmpeg", "") or ""))
        import torch

        self.torch = torch
        self.device = "cuda" if torch.cuda.is_available() else "cpu"
        self.deviceId = "cuda:0" if self.device == "cuda" else "cpu"
        self.model = _load_model(self.device)
        self.sr = int(getattr(self.model, "sr", 24000) or 24000)
        self.vramTotal = (
            torch.cuda.get_device_properties(0).total_memory / (1024 ** 3)
            if self.device == "cuda"
            else 0.0
        )

    def empty_cache(self):
        if self.device == "cuda":
            try:
                self.torch.cuda.empty_cache()
            except Exception:
                pass

    def vram(self):
        t = self.torch
        if not t.cuda.is_available():
            return {"usedGb": 0, "totalGb": 0, "utilPct": 0}
        return {
            "usedGb": round(t.cuda.memory_allocated() / (1024 ** 3), 2),
            "totalGb": round(self.vramTotal, 2),
            "utilPct": 0,
        }

    def _gen(self, text, req):
        kw = {
            "language_id": LANGUAGE,
            "audio_prompt_path": req["ref"],
            "exaggeration": float(req.get("exaggeration", 0.5)),
            "cfg_weight": float(req.get("cfg", 0.5)),
            "temperature": float(req.get("temperature", 0.8)),
        }
        with self.torch.inference_mode():
            wav = self.model.generate(text, **kw)
        return wav.detach().cpu().reshape(-1)

    def infer(self, req):
        t0 = time.time()
        text = drop_stress(req["text"])
        pieces = split_text(text)
        if not pieces:
            raise ValueError("empty_text")
        pause = int(req.get("sentencePauseMs", 0) or 0)
        seq = []
        for piece in pieces:
            if seq and pause > 0:
                seq.append(self.torch.zeros(int(self.sr * pause / 1000)))
            seq.append(self._gen(piece, req))
            gc.collect()
            self.empty_cache()
        out = seq[0] if len(seq) == 1 else self.torch.cat(seq, dim=-1)
        import numpy as np
        import soundfile as sf

        sf.write(req["out"], np.asarray(out.numpy(), dtype="float32"), self.sr)
        return round(time.time() - t0, 2)


def _emit(obj):
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


def main():
    force_utf8()
    eng = None
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except Exception as e:
            _emit({"type": "error", "message": "bad_json: %s" % e})
            continue
        try:
            rtype = req.get("type")
            if rtype == "init":
                eng = ChatterboxEngine(req)
                _emit({"type": "ready", "device": eng.deviceId, "vramGb": eng.vramTotal,
                       "shims": eng.shims, "model": "chatterbox-multilingual",
                       "modelLicense": "MIT"})
                _emit({"type": "vram", **eng.vram()})
            elif rtype == "infer":
                if eng is None:
                    raise RuntimeError("not_initialized")
                sec = eng.infer(req)
                _emit({"type": "vram", **eng.vram()})
                _emit({"type": "done", "out": req["out"], "sec": sec})
            elif rtype == "shutdown":
                break
            else:
                _emit({"type": "error", "message": "unknown_type: %s" % rtype})
        except Exception as e:
            _emit({"type": "error", "message": str(e)[:500]})
    if eng is not None:
        eng.empty_cache()


if __name__ == "__main__":
    main()
