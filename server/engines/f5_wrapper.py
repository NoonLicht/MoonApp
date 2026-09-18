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

Модель: по умолчанию русский дообученный чекпоинт (RU_MODEL ниже) — базовая
F5TTS_v1_Base обучена только на английском и китайском и читает кириллицу
своими фонемами (для русского текста это тарабарщина). Если русский чекпоинт
скачать не удалось, работаем на базовой модели, а причину отдаём в `ready`
(`modelError`) — приложение пишет её в лог.

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
import re
import time
import gc

# Общие шимы звукового стека (ffmpeg приложения для pydub и torchaudio.load через
# soundfile) — лежат рядом, каталог скрипта всегда в sys.path. Подробности в
# server/engines/py_audio.py: без них f5-tts падает с «[WinError 2]» на pydub.
try:
    from py_audio import force_utf8
    from py_audio import prepare as prepare_audio
except ImportError:  # запуск не из каталога скрипта (например, импорт как модуля)
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    from py_audio import force_utf8
    from py_audio import prepare as prepare_audio


def _load_f5():
    import torch
    from f5_tts.api import F5TTS
    return torch, F5TTS


# ---------------------------------------------------------------------------
# Какая модель F5-TTS считается.
#
# Базовая `F5TTS_v1_Base` (SWivid/F5-TTS) обучена ТОЛЬКО на английском и
# китайском: кириллицу она раскладывает своими фонемами, и русский текст звучит
# как тарабарщина — не «акцент», а именно чужой язык. Поэтому по умолчанию берём
# русский дообученный чекпоинт Misha24-10/F5-TTS_RUSSIAN (5 000 часов русской и
# английской речи, 229 лайков, ~57k скачиваний в месяц).
#
# Варианты в репозитории: F5TTS_v1_Base (первая версия), F5TTS_v1_Base_accent_tune
# (полная разметка ударений) и F5TTS_v1_Base_v2 (+16 эпох, мягкая фильтрация
# записей с артефактами). Берём v2; файл `*_inference.safetensors` — это те же
# веса, подготовленные для инференса (без состояния оптимизатора, 1.29 ГБ вместо
# 5.4 ГБ у `model_last.pt`).
#
# Словарь (`vocab.txt`) у русского чекпоинта совпадает со штатным словарём
# f5-tts построчно — передавать свой не нужно, размер и индексы символов те же.
#
# Лицензия русского чекпоинта — CC-BY-NC-4.0, то есть НЕкоммерческое
# использование (у базовой F5-TTS лицензия тоже CC-BY-NC).
#
# Ударения: модель умеет их понимать, но ждёт «+» ПЕРЕД ударной гласной
# («молок+о»), а наш русский NLP ставит знак ударения после гласной
# («молоко́», U+0301). Перевод делает _stress_plus ниже.
# ---------------------------------------------------------------------------
RU_MODEL = {
    "repo": "Misha24-10/F5-TTS_RUSSIAN",
    "ckpt": "F5TTS_v1_Base_v2/model_last_inference.safetensors",
    "name": "F5-TTS_RUSSIAN/F5TTS_v1_Base_v2",
    "license": "cc-by-nc-4.0",
}
BASE_MODEL_NAME = "F5TTS_v1_Base (en+zh)"

# Знак ударения после гласной: наш ruNlp.markStress ставит U+0301 (а иногда и
# U+0300). Русская модель ждёт «+» ПЕРЕД гласной, поэтому знак заменяется на
# «+гласная». Второй источник ударений — RUAccent (server/engines/ru_accent.py),
# и он отдаёт ровно этот же формат («молок+о»), так что конвертировать нечего.
_ACUTE_AFTER_VOWEL = re.compile("([аеёиоуыэюяАЕЁИОУЫЭЮЯ])[\u0300\u0301]")
_PLUS_BEFORE_VOWEL = re.compile(r"\+([аеёиоуыэюяАЕЁИОУЫЭЮЯ])")


def _stress_plus(text):
    """«молоко́» → «молок+о»: формат ударений русского чекпоинта F5-TTS.

    «+» перед гласной (формат RUAccent) остаётся как есть — это и есть то, что
    ждёт русская модель.
    """
    return _ACUTE_AFTER_VOWEL.sub(r"+\1", str(text or ""))


def _stress_off(text):
    """Снять знаки ударения для БАЗОВОЙ модели (en+zh).

    Она их не понимает: «+» и комбинирующая акута — просто лишние символы
    словаря, они прозвучали бы как посторонний звук посреди слова. Так бывает,
    когда русский чекпоинт скачать не удалось (см. F5Engine.__init__), а
    ударения в тексте уже расставлены.
    """
    return _PLUS_BEFORE_VOWEL.sub(r"\1", _ACUTE_AFTER_VOWEL.sub(r"\1", str(text or "")))


def _ru_ckpt():
    """Локальный путь к русскому чекпоинту (скачивает в кэш HF при первом запуске).

    Качает сам huggingface_hub: и с прогрессом в stderr (его видно в логе
    сайдкара), и с докачкой после обрыва. Ошибку не глотаем здесь — вызывающий
    решает, работать ли на базовой модели (см. F5Engine.__init__).
    """
    from huggingface_hub import hf_hub_download

    return hf_hub_download(repo_id=RU_MODEL["repo"], filename=RU_MODEL["ckpt"])


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
        # Шимы ДО импорта f5_tts: ffmpeg приложения для pydub (иначе
        # «[WinError 2] Не удается найти указанный файл» на первом же чанке) и
        # torchaudio.load через soundfile (torchcodec без FFmpeg не читает даже
        # WAV). Путь к ffmpeg может прийти из настроек — используем его, если есть.
        self.shims = prepare_audio(str(cfg.get("ffmpeg", "") or ""))
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
        # Русский чекпоинт (см. RU_MODEL): качается в кэш HF при первом запуске.
        # Если не вышло (нет сети, нет места, репозиторий недоступен) — работаем на
        # базовой модели и говорим об этом прямо: лучше английская дикция, чем
        # отказ рендера. Флаг нужен ещё и потому, что «+» в тексте имеет смысл
        # только для русской модели (см. _stress_plus).
        self.ruModel = False
        self.modelError = ""
        ru_ckpt = ""
        try:
            ru_ckpt = _ru_ckpt()
        except Exception as e:
            self.modelError = str(e)[:300]
        # dtype и ckpt_file передаём ТОЛЬКО если конструктор их принимает: в
        # актуальных сборках f5-tts нет `dtype`, и вызов падал с
        # «F5TTS.__init__() got an unexpected keyword argument 'dtype'».
        ctor = _kwargs_for(F5TTS.__init__, {"dtype": dtype, "ckpt_file": ru_ckpt})
        try:
            self.tts = F5TTS(**ctor)  # nfe задаётся на infer
            self.ruModel = bool(ru_ckpt) and "ckpt_file" in ctor
        except TypeError:
            # Подпись соврала (обёртки, декораторы) — работаем без параметров.
            self.tts = F5TTS()
        except Exception as e:
            if not ru_ckpt:
                raise  # дело не в чекпоинте: базовую модель тоже не собрать
            # Русский чекпоинт не приняли этой сборкой f5-tts — не оставляем
            # пользователя без озвучки, но причину показываем в ready.
            self.modelError = str(e)[:300]
            self.tts = F5TTS(**_kwargs_for(F5TTS.__init__, {"dtype": dtype}))
            self.ruModel = False
        if self.ruModel:
            self.modelName = RU_MODEL["name"]
        else:
            self.modelName = BASE_MODEL_NAME
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
        # Ударения приходят в формате «+» перед ударной гласной (так отдаёт
        # RUAccent, и так же их понимает русская модель). Если работаем на
        # БАЗОВОЙ модели (русский чекпоинт не скачался), знаки ударения надо
        # снять: для неё это лишние символы — см. _stress_plus/_stress_off.
        text = _stress_plus(req["text"]) if self.ruModel else _stress_off(req["text"])
        # Имена аргументов infer тоже различаются между сборками: nfe в старых,
        # nfe_step в новых, exaggeration появился не сразу. Поэтому собираем
        # «желаемое» и отдаём только то, что подпись метода принимает.
        kwargs = {
            "ref_file": req["ref"],
            "ref_text": "",
            "gen_text": text,
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
    # Протокол — UTF-8 JSON-lines: без этого русский текст приезжает крякозябрами
    # и движок озвучивает мусор (подробности в py_audio.force_utf8).
    force_utf8()
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
                _emit(
                    {
                        "type": "ready",
                        "device": eng.deviceId,
                        "vramGb": eng.vramTotal,
                        "shims": eng.shims,
                        # Какая модель реально загружена (русский чекпоинт или
                        # базовая en+zh) и почему не получилось взять русскую —
                        # уходит в лог приложения (tts.model), чтобы это было
                        # видно без чтения stderr движка.
                        "model": eng.modelName,
                        "modelError": eng.modelError or None,
                        "modelLicense": RU_MODEL["license"] if eng.ruModel else None,
                    }
                )
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
