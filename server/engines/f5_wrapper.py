# -*- coding: utf-8 -*-
"""
F5-TTS engine sidecar (embedded, persistent).

Протокол: JSON-lines через stdin/stdout. Модель загружается ОДИН раз на
задание, чанки приходят построчно — это в разы быстрее, чем спавнить
python на каждый чанк, и позволяет держать VRAM-гард в том же процессе.

Вход (каждая строка — JSON):
  {"type":"init","precision":"float16|bfloat16|float32|int8",
   "attention":"sdpa|flash|eager","nfe":32,"solver":"euler|midpoint|rk4",
   "speed":1.0,"vramBudgetGb":4.5,"gcEveryChunks":1}
  {"type":"infer","ref":"C:/.../ref_xxx.wav","text":"...","out":".../chunk_0000.wav",
   "cfg":2.2,"exaggeration":1.0,"nfe":32}
  {"type":"shutdown"}

Выход (каждая строка — JSON):
  {"type":"ready","device":"cuda:0","vramGb":8.0}   (или "device":"cpu")
  {"type":"vram","usedGb":4.2,"totalGb":8.0,"utilPct":68}
  {"type":"done","out":"...","sec":3.41}
  {"type":"error","message":"..."}

Устройство выбирается автоматически: CUDA есть — считаем на видеокарте, нет —
на CPU в FP32 (раньше в этом случае сайдкар падал «cuda_not_available» и студия
озвучки была нерабочей на машинах без NVIDIA; установщик окружения в UI теперь
честно предлагает сборку torch CPU или CUDA).

ВНИМАНИЕ про версии f5-tts: имена аргументов у них разные. В актуальных сборках
конструктор F5TTS не принимает `dtype` — вызов падал с
«F5TTS.__init__() got an unexpected keyword argument 'dtype'», а в infer вместо
`nfe` используется `nfe_step`. Поэтому аргументы не передаются «наугад»: их
фильтрует inspect.signature (см. _kwargs_for), а точность модели выставляется
напрямую, если конструктор её не понимает.
"""
import os
import sys
import inspect
import json
import time
import gc


def _load_f5():
    import torch
    from f5_tts.api import F5TTS
    return torch, F5TTS


def _kwargs_for(fn, kwargs):
    """Только те именованные аргументы, которые функция реально принимает.

    Зачем: у сборок f5-tts разный API (dtype в конструкторе, nfe против nfe_step
    в infer, необязательный exaggeration). Передавать лишнее нельзя — TypeError
    убивает рендер целиком, а перебирать комбинации try/except по одному вызову
    значит терять смысл ошибки, если она в другом аргументе.
    """
    try:
        params = inspect.signature(fn).parameters
    except (TypeError, ValueError):
        return dict(kwargs)  # подпись недоступна — пусть функция решает сама
    if any(p.kind == p.VAR_KEYWORD for p in params.values()):
        return dict(kwargs)  # **kwargs — принимает всё
    return {k: v for k, v in kwargs.items() if k in params}


def _first_accepted(fn, names):
    """Первое из имён, которое функция принимает (nfe / nfe_step / nfe_steps)."""
    for name in names:
        if name in _kwargs_for(fn, {name: None}):
            return name
    return ""


def _save_wav(path, wav, sr):
    """Записать результат в WAV.

    Библиотека f5-tts отдаёт numpy-массив (внутри себя она пишет его же через
    soundfile.write), а старые сборки могли вернуть тензор. Поэтому сначала
    пробуем soundfile, а тензор отдаём torchaudio: torchaudio.save объявлен как
    `src: torch.Tensor` (а с 2.9 ещё и требует torchcodec), и numpy-массив он не
    принимает — из-за чего рендер доходил до последней строки, чтобы упасть уже на
    записи файла.

    Форму приводим к soundfile: тензор формы (1, N) без разворота записался бы как
    N каналов по одному сэмплу (звук превращался бы в щелчок).
    """
    data = wav
    if hasattr(data, "detach"):
        data = data.detach().cpu().numpy()
    import numpy as np

    data = np.asarray(data)
    if data.ndim == 2 and data.shape[0] < data.shape[1]:
        data = data.T
    data = np.squeeze(data)
    try:
        import soundfile as sf
        sf.write(path, data, int(sr))
        return
    except Exception:
        pass
    import torch
    import torchaudio
    tensor = torch.as_tensor(data)
    if tensor.dim() == 1:
        tensor = tensor.unsqueeze(0)
    torchaudio.save(path, tensor, int(sr))


def _put_dtype(tts, dtype):
    """Выставить точность модели, если конструктор её не принимает.

    Старые сборки f5-tts знали dtype только в конструкторе; новые — не знают
    вовсе, и точность задаётся приведением модели. Если и это не выйдет, работаем
    на точности по умолчанию: это медленнее/тяжелее по VRAM, но рендер идёт.
    """
    for attr in ("ema_model", "model"):
        model = getattr(tts, attr, None)
        try:
            if model is not None and hasattr(model, "to"):
                model.to(dtype)
                return True
        except Exception:
            pass
    return False


class F5Engine:
    def __init__(self, cfg):
        self.torch, F5TTS = _load_f5()
        t = self.torch
        # Устройство: CUDA при наличии, иначе CPU. Это не «оптимизация», а
        # работоспособность: раньше без CUDA сайдкар сразу падал.
        self.device = "cuda" if t.cuda.is_available() else "cpu"
        self.deviceId = "cuda:0" if self.device == "cuda" else "cpu"
        # Precision: FP16/BF16 вдвое режут VRAM (8GB карта), FP32 — риск OOM.
        # На CPU half-точность не ускоряет, а часть ядер её не поддерживает,
        # поэтому там всегда FP32 (выбор пользователя игнорируем осознанно).
        dtype_map = {
            "float16": t.float16,
            "bfloat16": t.bfloat16,
            "float32": t.float32,
        }
        dtype = t.float32 if self.device == "cpu" else dtype_map.get(
            cfg.get("precision", "float16"), t.float16
        )
        # dtype передаём ТОЛЬКО если конструктор его принимает: в актуальных
        # сборках f5-tts аргумента нет, и вызов падал с «F5TTS.__init__() got an
        # unexpected keyword argument 'dtype'» (см. _kwargs_for).
        ctor = _kwargs_for(F5TTS.__init__, {"dtype": dtype})
        try:
            self.tts = F5TTS(**ctor)  # nfe задаётся на infer
        except TypeError:
            # Подпись соврала (обёртки, декораторы) — работаем без параметров.
            self.tts = F5TTS()
        if "dtype" not in ctor:
            _put_dtype(self.tts, dtype)
        self.cfg = cfg
        if self.device == "cuda":
            dev = t.cuda.current_device()
            props = t.cuda.get_device_properties(dev)
            self.vramTotal = props.total_memory / (1024 ** 3)
        else:
            self.vramTotal = 0.0
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
            # pynvml если доступен — реальная загрузка CUDA-ядер
            import pynvml
            if not pynvml.nvmlInitialized:
                pynvml.nvmlInit()
            h = pynvml.nvmlDeviceGetHandleByIndex(0)
            r = pynvml.nvmlDeviceGetUtilizationRates(h)
            util = int(r.gpu)
        except Exception:
            pass
        return {"usedGb": round(used, 2), "totalGb": round(self.vramTotal, 2), "utilPct": util}

    def infer(self, req):
        t0 = time.time()
        # Имена аргументов infer тоже различаются между сборками: nfe в старых,
        # nfe_step в новых, exaggeration появился не сразу. Поэтому собираем
        # «желаемое» и отдаём только то, что подпись метода принимает.
        kwargs = {
            "ref_file": req["ref"],
            "ref_text": "",
            "gen_text": req["text"],
            "file_type": "wav",
            "cfg_strength": float(req.get("cfg", 2.0)),
            "exaggeration": float(req.get("exaggeration", 1.0)),
            "speed": float(self.cfg.get("speed", 1.0)),
        }
        nfe_name = _first_accepted(self.tts.infer, ("nfe", "nfe_step", "nfe_steps"))
        if nfe_name:
            kwargs[nfe_name] = int(req.get("nfe", 32))
        wav, sr, _ = self.tts.infer(**_kwargs_for(self.tts.infer, kwargs))
        _save_wav(req["out"], wav, sr)
        # VRAM-гард: strict GC после каждого чанка (многокилограммовые рендеры
        # без него утекают в OOM на 8GB).
        gc.collect()
        self.empty_cache()
        return round(time.time() - t0, 2)


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
                eng = F5Engine(req)
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


def _emit(obj):
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


if __name__ == "__main__":
    main()
