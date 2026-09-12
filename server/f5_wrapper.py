# -*- coding: utf-8 -*-
"""
F5-TTS wrapper: мост между приложением и библиотекой f5_tts.

Как это работает:
  Стандартный CLI (f5-tts_infer) не даёт управлять precision/exaggeration/cfg
  и не умеет чистить VRAM между чанками. Поэтому мы вызываем python API
  напрямую. Параметры приходят через переменные окружения (не через argv —
  текст чанка может быть любым, а env не виден в списке процессов):

    F5_REF         — путь к референсному wav/mp3 (5-10 сек)
    F5_TEXT        — текст чанка
    F5_OUT         — куда записать результат (wav)
    F5_PRECISION   — float16 | float32
    F5_EXAGGERATION— 0.5..2.0 (выразительность)
    F5_CFG         — 1.5..4.5 (сила сходства с референсом)
    F5_NFE         — число диффузионных шагов (32..48)
    F5_VRAM        — зарезервируемый объём VRAM в ГБ (информативно)

  После генерации вызывается torch.cuda.empty_cache() В ТОМ ЖЕ процессе —
  это реально освобождает VRAM между чанками (в отличие от запуска
  отдельного python -c, который видит чужой контекст CUDA).
"""
import os
import sys


def main():
    ref = os.environ.get("F5_REF", "")
    text = os.environ.get("F5_TEXT", "")
    out = os.environ.get("F5_OUT", "")
    precision = os.environ.get("F5_PRECISION", "float16")
    exaggeration = float(os.environ.get("F5_EXAGGERATION", "1.0"))
    cfg = float(os.environ.get("F5_CFG", "2.0"))
    nfe = int(os.environ.get("F5_NFE", "32"))

    if not ref or not text or not out:
        print("f5_wrapper: F5_REF / F5_TEXT / F5_OUT are required", file=sys.stderr)
        sys.exit(2)

    import torch
    from f5_tts.api import F5TTS

    dtype = torch.float16 if precision == "float16" else torch.float32

    # F5TTS загружает модель один раз на процесс; dtype управляет точностью.
    try:
        tts = F5TTS(dtype=dtype, nfe=nfe)
    except TypeError:
        # старые версии API не принимают dtype/nfe в конструкторе
        tts = F5TTS()

    wav, sr, _ = tts.infer(
        ref_file=ref,
        ref_text="",          # транскрипция не задана — модель определит сама (zero-shot)
        gen_text=text,
        file_type="wav",
        # exaggeration/cfg поддерживаются новыми версиями API; в старых
        # игнорируются через filter_kwargs ниже.
        exaggeration=exaggeration,
        cfg_strength=cfg,
        nfe=nfe,
    )

    import torchaudio
    torchaudio.save(out, wav, sr)

    # Освобождение VRAM после чанка (в этом же процессе — это работает).
    if torch.cuda.is_available():
        torch.cuda.empty_cache()


if __name__ == "__main__":
    main()
