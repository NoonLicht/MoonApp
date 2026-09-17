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

Выход: ready / vram / done / error — как у F5 (device = "cuda:0" либо "cpu").

Как и у F5, устройство выбирается автоматически: CUDA есть — считаем на
видеокарте, нет — на CPU (раньше здесь стоял жёсткий «cuda_not_available»).

Про загрузку модели: проверенный порядок — сначала готовый синтезатор
`TTS.api.TTS("tts_models/multilingual/multi-dataset/xtts_v2")`, он сам скачивает
модель xtts_v2 (~1.8 ГБ) в кэш и загружает её; модель берётся из
`api.synthesizer.tts_model` (coqui-tts) или `api.tts_model` (классический TTS).
Прямой путь `XttsConfig()` + `init_from_config` + `load_checkpoint()` БЕЗ
`checkpoint_dir` не работает ни там, ни там (внутри `os.path.join(None,
"model.pth")`), поэтому он остался запасным — уже с каталогом модели от
ModelManager.
"""
import sys
import json
import time
import gc


def _xtts_model(api):
    """Инстанс XTTS из «готового синтезатора» — варианты API различаются.

    coqui-tts (0.27): api.synthesizer.tts_model;
    классический TTS (0.22): api — это сам Synthesizer, модель в api.tts_model;
    отдельные сборки отдавали модель как api.to_model (свойство или метод).
    """
    for obj in (api, getattr(api, "synthesizer", None)):
        model = getattr(obj, "tts_model", None) if obj is not None else None
        if model is not None:
            return model
    alias = getattr(api, "to_model", None)
    if alias is None:
        raise RuntimeError("xtts_model_not_found")
    if callable(alias) and not hasattr(alias, "inference_stream"):
        return alias()
    return alias


class XttsEngine:
    def __init__(self, cfg):
        import torch
        self.torch = torch
        # Устройство: CUDA при наличии, иначе CPU (без этого сайдкар падал
        # «cuda_not_available», и студия озвучки не работала без NVIDIA).
        self.device = "cuda" if torch.cuda.is_available() else "cpu"
        self.deviceId = "cuda:0" if self.device == "cuda" else "cpu"
        known = {"en", "ru", "zh", "es", "fr", "de", "ja", "it", "pt", "pl", "tr", "nl", "cs", "ar", "hu", "ko", "hi"}
        self.languages = known
        # Модель сама скачается в кэш TTS (~1.8 ГБ) при первом init.
        try:
            # Путь 1 (проверенный на coqui-tts 0.27 и классическом TTS 0.22):
            # готовый синтезатор скачивает xtts_v2 и загружает его сам.
            from TTS.api import TTS as CoquiTTS

            api = CoquiTTS("tts_models/multilingual/multi-dataset/xtts_v2", progress_bar=False)
            self.tts = _xtts_model(api)
        except Exception:
            # Путь 2: скачать модель через ModelManager и загрузить её напрямую в
            # Xtts. Нужен, если в сборке нет API-обёртки (init_from_config с
            # пустым checkpoint_dir падал бы: os.path.join(None, "model.pth")).
            from TTS.tts.configs.xtts_config import XttsConfig
            from TTS.tts.models.xtts import Xtts
            from TTS.utils.manage import ModelManager

            model_dir, config_path, _ = ModelManager().download_model(
                "tts_models/multilingual/multi-dataset/xtts_v2"
            )
            cfgx = XttsConfig()
            cfgx.load_json(config_path)
            self.tts = Xtts.init_from_config(cfgx)
            self.tts.load_checkpoint(cfgx, checkpoint_dir=model_dir, use_deepspeed=False, eval=True)
        # Модель держим на выбранном устройстве (torch.nn.Module.to); если
        # конкретная сборка XTTS этого не умеет — оставляем как есть.
        try:
            self.tts.to(self.device)
        except Exception:
            pass
        if self.device == "cuda":
            self.vramTotal = torch.cuda.get_device_properties(0).total_memory / (1024 ** 3)
        else:
            self.vramTotal = 0.0
        self.cfg = cfg
        return

    def empty_cache(self):
        """Сброс кэша VRAM — только когда реально считаем на видеокарте."""
        if self.device != "cuda":
            return
        try:
            self.torch.cuda.empty_cache()
        except Exception:
            pass

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
                self.empty_cache()
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
        self.empty_cache()
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
                _emit({"type": "ready", "device": eng.deviceId, "vramGb": eng.vramTotal})
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
        eng.empty_cache()


if __name__ == "__main__":
    main()
