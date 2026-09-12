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
  {"type":"ready","device":"cuda:0","vramGb":8.0}
  {"type":"vram","usedGb":4.2,"totalGb":8.0,"utilPct":68}
  {"type":"done","out":"...","sec":3.41}
  {"type":"error","message":"..."}
"""
import os
import sys
import json
import time
import gc


def _load_f5():
    import torch
    from f5_tts.api import F5TTS
    return torch, F5TTS


class F5Engine:
    def __init__(self, cfg):
        self.torch, F5TTS = _load_f5()
        t = self.torch
        if not t.cuda.is_available():
            raise RuntimeError("cuda_not_available")
        # Precision: FP16/BF16 вдвое режут VRAM (8GB карта), FP32 — риск OOM.
        dtype_map = {
            "float16": t.float16,
            "bfloat16": t.bfloat16,
            "float32": t.float32,
        }
        dtype = dtype_map.get(cfg.get("precision", "float16"), t.float16)
        self.tts = F5TTS(dtype=dtype)  # nfe задаётся на infer
        self.cfg = cfg
        dev = t.cuda.current_device()
        props = t.cuda.get_device_properties(dev)
        self.vramTotal = props.total_memory / (1024 ** 3)
        return

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
        t = self.torch
        t0 = time.time()
        wav, sr, _ = self.tts.infer(
            ref_file=req["ref"],
            ref_text="",
            gen_text=req["text"],
            file_type="wav",
            cfg_strength=float(req.get("cfg", 2.0)),
            exaggeration=float(req.get("exaggeration", 1.0)),
            nfe=int(req.get("nfe", 32)),
            speed=float(self.cfg.get("speed", 1.0)),
        )
        import torchaudio
        torchaudio.save(req["out"], wav, sr)
        # VRAM-гард: strict GC после каждого чанка (многокилограммовые рендеры
        # без него утекают в OOM на 8GB).
        gc.collect()
        t.cuda.empty_cache()
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


def _emit(obj):
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


if __name__ == "__main__":
    main()
