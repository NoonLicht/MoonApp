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

ВНИМАНИЕ: это старая (пофайловая) версия обёртки, приложение её не запускает —
рабочий сайдкар живёт в server/engines/f5_wrapper.py. Правки держим
синхронными, чтобы файл не выглядел «работающим», оставаясь сломанным: у
актуальных сборок f5-tts конструктор не принимает dtype, а infer — nfe.
"""
import inspect
import os
import sys


def _kwargs_for(fn, kwargs):
    """Только те именованные аргументы, которые функция реально принимает."""
    try:
        params = inspect.signature(fn).parameters
    except (TypeError, ValueError):
        return dict(kwargs)
    if any(p.kind == p.VAR_KEYWORD for p in params.values()):
        return dict(kwargs)
    return {k: v for k, v in kwargs.items() if k in params}


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

    # dtype/nfe передаём только если конструктор их принимает: в актуальных
    # сборках f5-tts их нет («unexpected keyword argument 'dtype'»), и рендер
    # падал ещё до загрузки модели.
    tts = F5TTS(**_kwargs_for(F5TTS.__init__, {"dtype": dtype, "nfe": nfe}))

    # В infer шаги диффузии зовутся по-разному: nfe (старые) / nfe_step (новые).
    nfe_name = "nfe" if _kwargs_for(tts.infer, {"nfe": None}) else "nfe_step"
    wav, sr, _ = tts.infer(
        **_kwargs_for(
            tts.infer,
            {
                "ref_file": ref,
                "ref_text": "",  # транскрипция не задана — модель определит сама (zero-shot)
                "gen_text": text,
                "file_type": "wav",
                "exaggeration": exaggeration,
                "cfg_strength": cfg,
                nfe_name: nfe,
            },
        )
    )

    # Библиотека отдаёт numpy-массив (torchaudio.save с 2.9 требует torchcodec, а
    # numpy-массив не принимает вовсе), поэтому пишем через soundfile — как делает
    # сама f5-tts. Форму приводим к (frames,): иначе тензор (1, N) записался бы как
    # N каналов по одному сэмплу.
    import numpy as np
    import soundfile as sf

    data = wav.detach().cpu().numpy() if hasattr(wav, "detach") else np.asarray(wav)
    if data.ndim == 2 and data.shape[0] < data.shape[1]:
        data = data.T
    sf.write(out, np.squeeze(data), int(sr))

    # Освобождение VRAM после чанка (в этом же процессе — это работает).
    if torch.cuda.is_available():
        torch.cuda.empty_cache()


if __name__ == "__main__":
    main()
