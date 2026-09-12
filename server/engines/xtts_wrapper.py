# -*- coding: utf-8 -*-
"""
Coqui XTTS v2 engine sidecar (embedded, persistent).

Протокол тот же, что у f5_wrapper.py: JSON-lines через stdin/stdout.
Модель грузится один раз на задание; автокластерное GPT-поколение
управляется temperature/repetition_penalty/top_k/top_p.

Вход:
  {"type":"init","precision":"float16|bfloat16|float32",
   "vramBudgetGb":4.5,"gcEveryChunks":1}
  {"type":"infer","ref":".../ref.wav","text":"...","out":".../chunk.wav",
   "language":"ru","temperature":0.7,"repetitionPenalty":3.5,
   "topK":50,"topP":0.85,"speed":1.0,"sentencePauseMs":400}
  {"type":"shutdown"}

Выход: ready / vram / done / error — как у F5.
"""
import sys
import json
import time
import gc


class XttsEngine:
    def __init__(self, cfg):
        import torch
        from TTS.tts.configs.xtts_config import XttsConfig
        from TTS.tts.models.xtts import Xtts
        self.torch = torch
        if not torch.cuda.is_available():
            raise RuntimeError("cuda_not_available")
        cfgx = XttsConfig()
        known = {"en", "ru", "zh", "es", "fr", "de", "ja", "it", "pt", "pl", "tr", "nl", "cs", "ar", "hu", "ko", "hi"}
        self.languages = known
        # Модель сама скачается в ~/.local/share/tts при первом init (встроенно).
        try:
            self.tts = Xtts.init_from_config(cfgx)
            self.tts.load_checkpoint(
                cfgx, use_deepspeed=False, eval=True
            )
        except Exception:
            # старые версии API
            from TTS.api import TTS as CoquiTTS
            self.tts = CoquiTTS("tts_models/multilingual/multi-dataset/xtts_v2").to_model
        self.vramTotal = torch.cuda.get_device_properties(0).total_memory / (1024 ** 3)
        self.cfg = cfg
        return

    def vram(self):
        t = self.torch
        if not t.cuda.is_available():
            return {"usedGb": 0, "totalGb": 0, "utilPct": 0}
        used = t.cuda.memory_allocated() / (1024 ** 3)
        util = 0
        try:
            import pynvml
            if not pynvml.nvmlInitialized:
                pynvml.nvmlInit()
            h = pynvml.nvmlDeviceGetHandleByIndex(0)
            util = int(pynvml.nvmlDeviceGetUtilizationRates(h).gpu)
        except Exception:
            pass
        return {"usedGb": round(used, 2), "totalGb": round(self.vramTotal, 2), "utilPct": util}

    def infer(self, req):
        t = self.torch
        t0 = time.time()
        kwargs = {
            "temperature": float(req.get("temperature", 0.7)),
            "repetition_penalty": float(req.get("repetitionPenalty", 3.5)),
            "top_k": int(req.get("topK", 50)),
            "top_p": float(req.get("topP", 0.85)),
            "speed": float(req.get("speed", 1.0)),
        }
        try:
            gpt_cond_latent, speaker_embedding = self.tts.get_conditioning_latents(
                audio_path=[req["ref"]]
            )
            chunks = self.tts.inference_stream(
                req["text"], req.get("language", "ru"),
                gpt_cond_latent, speaker_embedding,
                **kwargs,
            )
            import torchaudio
            wav_chunks, sr = [], None
            for c in chunks:
                wav_chunks.append(c)
                sr = getattr(c, "sr", None) or 24000
                # инкрементальный VRAM-гард внутри стрима
                t.cuda.empty_cache()
            wav = t.cat(wav_chunks, dim=0) if wav_chunks and hasattr(wav_chunks[0], "dim") else wav_chunks
            torchaudio.save(req["out"], wav, sr or 24000)
        except Exception:
            # Фолбэк: полный (не стриминговый) инференс
            import torchaudio
            wav = self.tts.inference(req["text"], req.get("language", "ru"), req["ref"], **kwargs)
            sr = wav[1] if isinstance(wav, tuple) else 24000
            data = wav[0] if isinstance(wav, tuple) else wav
            torchaudio.save(req["out"], t.tensor(data).unsqueeze(0), sr)
        gc.collect()
        t.cuda.empty_cache()
        return round(time.time() - t0, 2)


def _emit(obj):
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


def main():
    eng = None
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except Exception as e:
            _emit({"type": "error", "message": f"bad_json: {e}"})
            continue
        try:
            rtype = req.get("type")
            if rtype == "init":
                eng = XttsEngine(req)
                _emit({"type": "ready", "device": "cuda:0", "vramGb": eng.vramTotal})
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
                _emit({"type": "error", "message": f"unknown_type: {rtype}"})
        except Exception as e:
            _emit({"type": "error", "message": str(e)[:500]})
    if eng is not None:
        try:
            eng.torch.cuda.empty_cache()
        except Exception:
            pass


if __name__ == "__main__":
    main()
