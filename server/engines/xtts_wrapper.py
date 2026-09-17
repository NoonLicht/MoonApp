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
import re
import logging
import inspect
import time
import gc

# Общие шимы звукового стека: ffmpeg приложения для pydub и torchaudio.load через
# soundfile, плюс возврат isin_mps_friendly для transformers 5 (иначе coqui-tts
# падает уже на `import TTS.api`). Подробности — server/engines/py_audio.py.
import os

try:
    from py_audio import prepare as prepare_audio
    from py_audio import allow_coqui_tos as prepare_tos
except ImportError:  # запуск не из каталога скрипта
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    from py_audio import prepare as prepare_audio
    from py_audio import allow_coqui_tos as prepare_tos


def _accepts(fn, name):
    """Принимает ли функция параметр с таким именем (или **kwargs)."""
    try:
        params = inspect.signature(fn).parameters
    except (TypeError, ValueError):
        return True  # подпись недоступна — пусть решает сама функция
    if any(p.kind == p.VAR_KEYWORD for p in params.values()):
        return True
    return name in params


def _has_param(fn, name):
    """Есть ли у функции ЯВНЫЙ параметр с таким именем.

    Именно «явный»: **kwargs принимает любое имя, но не значит, что третьим
    позиционным аргументом функция ждёт путь к референсу, а не латенты.
    """
    try:
        return name in inspect.signature(fn).parameters
    except (TypeError, ValueError):
        return True


def _filter_kwargs(fn, kwargs):
    """Оставить только те именованные аргументы, которые функция принимает.

    Сборки XTTS отличаются набором параметров (speed появился позже, где-то нет
    top_k), а лишний kwarg — это TypeError, который роняет рендер целиком.
    """
    return {k: v for k, v in kwargs.items() if _accepts(fn, k)}


KNOWN_LANGUAGES = {
    "en",
    "ru",
    "zh-cn",
    "es",
    "fr",
    "de",
    "ja",
    "it",
    "pt",
    "pl",
    "tr",
    "nl",
    "cs",
    "ar",
    "hu",
    "ko",
    "hi",
}


def _lang_code(value):
    """Язык → код XTTS: «Russian» → «ru», «Chinese» → «zh-cn».

    Почему это нужно здесь, а не только в сервере: названия языков приходят из
    интерфейса и уже сохранены в настройках (`voice.defaultLanguage`) и в голосовых
    профилях. XTTS принимает только коды и падает с «Language 'Russian' is not
    supported», поэтому переводим и в сайдкаре — на случай старого сохранённого
    профиля или вызова обёртки из другого места.
    """
    raw = str(value or "").strip().lower()
    if not raw:
        return "ru"
    names = {
        "russian": "ru",
        "русский": "ru",
        "english": "en",
        "английский": "en",
        "chinese": "zh-cn",
        "китайский": "zh-cn",
        "zh": "zh-cn",
        "spanish": "es",
        "испанский": "es",
        "french": "fr",
        "французский": "fr",
        "german": "de",
        "немецкий": "de",
        "japanese": "ja",
        "японский": "ja",
        "italian": "it",
        "итальянский": "it",
        "portuguese": "pt",
        "португальский": "pt",
        "polish": "pl",
        "польский": "pl",
        "turkish": "tr",
        "турецкий": "tr",
        "dutch": "nl",
        "нидерландский": "nl",
        "czech": "cs",
        "чешский": "cs",
        "arabic": "ar",
        "арабский": "ar",
        "hungarian": "hu",
        "венгерский": "hu",
        "korean": "ko",
        "корейский": "ko",
        "hindi": "hi",
        "хинди": "hi",
    }
    return names.get(raw, raw)


# ---------------------------------------------------------------------------
# Лимит текста за один проход.
#
# В начале inference/inference_stream стоит проверка
#     assert text_tokens.shape[-1] < self.args.gpt_max_text_tokens   # 402 у v2
# и проверяет она ВЕСЬ переданный текст: `enable_text_splitting` по умолчанию
# выключен, поэтому внутри text = [text] (TTS/tts/models/xtts.py). То есть
# длинный абзац падал посреди задания с «❗ XTTS can only generate text with a
# maximum of 400 tokens», хотя XTTS умеет считать по частям.
#
# Поэтому режем текст сами — по границам предложений, затем по запятым, затем по
# пробелам, а если разделителей нет вовсе (длинное слово, ссылка) — по символам —
# и склеиваем звук с паузой sentencePauseMs, как конвейер делает между чанками.
TOKEN_MARGIN = 22  # запас на служебные токены («[ru]», [SPACE]) и чистку текста

# Символов на токен: русский ~1.8, английский ~1.5, а на цифрах и аббревиатурах
# доходит до 1. Резервный путь — когда токенизатора под рукой нет.
_FALLBACK_CHARS_PER_TOKEN = 1.6

_SENT_SPLIT = re.compile(r"(?<=[.!?;…])\s+")
_CLAUSE_SPLIT = re.compile(r"(?<=[,:—–])\s+")

# Логгер самой библиотеки: `VoiceBpeTokenizer.encode` ругается «exceeds the
# character limit ... might cause truncated audio» на текст ДЛИННЕЕ рекомендованного.
# Мы именно такой текст и режем, поэтому на измерении шум глушим, а на реальном
# синтезе (там куски уже короткие) он остаётся.
_TTS_LOGGER = logging.getLogger("TTS")


def _tokens(tk, text, language):
    """Число токенов так, как его считает сам XTTS (без ложных предупреждений)."""
    level = _TTS_LOGGER.level
    try:
        _TTS_LOGGER.setLevel(logging.ERROR)
        return len(tk.encode(text, lang=language))
    finally:
        _TTS_LOGGER.setLevel(level)


def _split_text(text, budget, count):
    """Текст → куски, каждый из которых укладывается в budget токенов.

    Порядок попыток: границы предложений → запятые и тире → пробелы → символы.
    Атомы (предложения) режутся дальше теми же правилами, а затем ЖАДНО
    упаковываются в куски: просто «резать по каждому пробелу» нельзя — «слово
    слово слово» превратилось бы в куски по одному слову, и каждый стоил бы
    отдельного прохода модели.
    """
    text = text.strip()
    if not text:
        return []
    if count(text) <= budget:
        return [text]
    atoms = []
    for split in (_SENT_SPLIT.split, _CLAUSE_SPLIT.split, str.split):
        parts = [p.strip() for p in split(text) if p.strip()]
        if len(parts) > 1:
            atoms = parts
            break
    if not atoms:  # разделителей нет (длинное слово, ссылка) — режем по символам
        return _split_by_chars(text, budget, count)
    out, cur = [], ""
    for atom in atoms:
        for part in _split_text(atom, budget, count) if count(atom) > budget else [atom]:
            cand = f"{cur} {part}" if cur else part
            if cur and count(cand) > budget:
                out.append(cur)
                cur = part
            else:
                cur = cand
            if count(cur) > budget:  # одиночный атом не влез — дорезаем по символам
                out.extend(_split_by_chars(cur, budget, count))
                cur = ""
    if cur:
        out.append(cur)
    return out


def _split_by_chars(text, budget, count):
    """Кусок без разделителей: длину подбираем измерением (двоичный поиск).

    Оценка «символов на токен» врёт на цифрах и аббревиатурах (там ~1 символ на
    токен), и угаданный размер снова упёрся бы в тот же ассерт.
    """
    lo, hi, best = 1, len(text), 1
    while lo <= hi:
        mid = (lo + hi) // 2
        if count(text[:mid]) <= budget:
            best, lo = mid, mid + 1
        else:
            hi = mid - 1
    return [text[:best]] + _split_text(text[best:], budget, count)


def _flat(wav, torch):
    """Одномерный тензор для склейки: движок отдаёт (1, N), список или numpy."""
    if isinstance(wav, (list, tuple)):
        import numpy as np

        wav = torch.as_tensor(np.asarray(wav, dtype="float32"))
    if hasattr(wav, "reshape"):
        return wav.reshape(-1)
    return torch.as_tensor(wav).reshape(-1)


def _save_wav(path, wav, sr):
    """Записать результат в WAV.

    torchaudio.save в torchaudio 2.9+ работает только через torchcodec: у f5-tts
    он в зависимостях, а у coqui-tts — нет, поэтому вызов падал с ImportError
    ровно на сохранении готового звука. soundfile есть у обоих движков, поэтому
    пишем через него, а тензор сначала снимаем на CPU.

    Форму приводим к soundfile: модели отдают (channels, frames), а soundfile ждёт
    (frames, channels) — без разворота тензор (1, N) записался бы как N каналов по
    одному сэмплу (звук превращался в щелчок).
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
        # Шимы ДО импорта TTS: возврат isin_mps_friendly (его нет в transformers 5,
        # а TTS импортирует его на уровне модуля) и torchaudio.load через soundfile
        # — torchaudio 2.9+ читает только через torchcodec, которому нужен
        # полноценный FFmpeg (без него падает и референс, и любой WAV).
        self.shims = prepare_audio(str(cfg.get("ffmpeg", "") or ""))
        # Первое скачивание XTTS v2 иначе упирается в интерактивный вопрос про
        # лицензию CPML (stdin сайдкара занят протоколом — вопрос некому показать).
        self.shims["tos"] = prepare_tos()
        import torch
        self.torch = torch
        # Устройство: CUDA при наличии, иначе CPU (без этого сайдкар падал
        # «cuda_not_available», и студия озвучки не работала без NVIDIA).
        self.device = "cuda" if torch.cuda.is_available() else "cpu"
        self.deviceId = "cuda:0" if self.device == "cuda" else "cpu"
        # Набор языков уточняется по конфигу загруженной модели (у XTTS v2 китайский
        # — именно `zh-cn`, а не `zh`): хардкод ниже — запасной вариант для сборок
        # без конфига.
        self.languages = KNOWN_LANGUAGES
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
        # Языки берём у самой модели: наборы у сборок XTTS различаются.
        offer = getattr(getattr(self.tts, "config", None), "languages", None)
        if offer:
            self.languages = {str(x).lower() for x in offer}
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
        language = _lang_code(req.get("language", "ru"))
        # Набор языков у сборок отличается, поэтому проверяем по конфигу модели и
        # отвечаем понятной ошибкой: у самого XTTS сообщение без списка доступных.
        if self.languages and language not in self.languages:
            raise ValueError(
                "language_not_supported: '%s' (доступны: %s)"
                % (language, ", ".join(sorted(self.languages)))
            )
        kwargs = {
            "temperature": float(req.get("temperature", 0.7)),
            "repetition_penalty": float(req.get("repetitionPenalty", 3.5)),
            "top_k": int(req.get("topK", 50)),
            "top_p": float(req.get("topP", 0.85)),
            "speed": float(req.get("speed", 1.0)),
        }
        # Латентов хватает и стриму, и полному инференсу — считаем их один раз:
        # это самая дорогая часть после загрузки самой модели.
        gpt_cond_latent, speaker_embedding = self.tts.get_conditioning_latents(
            audio_path=[req["ref"]]
        )
        pieces = self.text_pieces(req["text"], language)
        if not pieces:
            raise ValueError("empty_text")
        pause_ms = int(req.get("sentencePauseMs", 0) or 0)
        seq, sr = [], 24000
        for piece in pieces:
            wav, sr = self.synth_split(
                piece, language, gpt_cond_latent, speaker_embedding, kwargs, req["ref"]
            )
            # Между кусками одного чанка — та же пауза, что конвейер ставит между
            # предложениями: иначе длинный текст звучит слитной скороговоркой.
            if seq and pause_ms > 0:
                seq.append(self.silence(seq[-1], sr, pause_ms))
            seq.append(wav)
            # VRAM-гард на каждый кусок: длинный текст теперь считается не одним
            # проходом, и без сброса кэша на 8 ГБ куски складываются в OOM.
            gc.collect()
            self.empty_cache()
        out = seq[0] if len(seq) == 1 else t.cat(seq, dim=-1)
        _save_wav(req["out"], out, sr)
        gc.collect()
        self.empty_cache()
        return round(time.time() - t0, 2)

    def token_budget(self):
        """Сколько токенов можно отдать XTTS за один проход.

        Порог берём у самой модели (`gpt_max_text_tokens`, 402 у v2) и оставляем
        запас: проверка внутри XTTS строгая (`<`), а чистка текста добавляет свои
        токены уже после нашей оценки.
        """
        limit = getattr(getattr(self.tts, "args", None), "gpt_max_text_tokens", None)
        try:
            limit = int(limit or 402)
        except (TypeError, ValueError):
            limit = 402
        return max(64, limit - TOKEN_MARGIN)

    def text_pieces(self, text, language):
        """Текст задания → куски, которые XTTS проглотит за один проход.

        Ограничений два: жёсткое по токенам (иначе ассерт внутри XTTS) и
        рекомендованное самой моделью по символам (`char_limits`: 182 для русского
        — дальше начинают пропадать хвосты фраз). Токены считает тот же
        токенизатор, что и модель, с кэшем на чанк: он же применяет чистку текста,
        поэтому наша проверка совпадает с её собственной.
        """
        budget = self.token_budget()
        text = str(text or "")
        tk = getattr(self.tts, "tokenizer", None)
        memo = {}
        if tk is not None and hasattr(tk, "encode"):

            def count(s):
                if s not in memo:
                    memo[s] = _tokens(tk, s, language)
                return memo[s]

        else:  # токенизатора нет — консервативная оценка по символам

            def count(s):
                return int(len(s) / _FALLBACK_CHARS_PER_TOKEN) + 1

        char_limit = 0
        try:
            limits = getattr(tk, "char_limits", None) or {}
            char_limit = int(limits.get(language.split("-")[0], 0) or 0)
        except (TypeError, ValueError):
            char_limit = 0
        # Рекомендация библиотеки — не догма: у XTTS это предупреждение «может
        # обрезать хвост», а не запрет. Поэтому даём запас, чтобы обычный чанк
        # конвейера (220 символов у русского) оставался ОДНИМ проходом, а длинный
        # текст из UI всё равно резался по-человечески.
        if char_limit:
            char_limit = int(char_limit * 1.25)
        # Сначала по символам (качество, как у самой библиотеки), затем по токенам
        # (жёсткий лимит): первый проход не сработает, если язык новый и в
        # char_limits его ещё нет.
        pre = _split_text(text, char_limit, len) if char_limit else [text]
        pieces = []
        for part in pre:
            pieces.extend(_split_text(part, budget, count))
        return [p for p in pieces if p.strip()]

    def silence(self, like, sr, ms):
        """Тишина между кусками — того же типа и на том же устройстве, что звук."""
        n = max(1, int(sr * ms / 1000))
        try:
            return self.torch.zeros(n, dtype=like.dtype, device=like.device)
        except Exception:
            return self.torch.zeros(n)

    def synth_split(self, text, language, latent, emb, kwargs, ref, depth=0):
        """Синтез куска с самолечением по лимиту токенов.

        Наша оценка длины может разойтись с моделью (сборки считают по-разному).
        Тогда срабатывает тот же ассерт: вместо падения задания режем кусок
        пополам и считаем по частям — редкий путь, но именно он превращает
        «ошибку рендера» в готовый звук.
        """
        try:
            return self.synth(text, language, latent, emb, kwargs, ref)
        except Exception as e:
            if depth >= 4 or "400 tokens" not in str(e) or len(text) < 32:
                raise
            mid = text.rfind(" ", 0, len(text) // 2)
            if mid <= 0:
                mid = len(text) // 2
            half = [
                text[:mid].strip(),
                text[mid:].strip(),
            ]
            left, sr = self.synth_split(half[0], language, latent, emb, kwargs, ref, depth + 1)
            right, _ = self.synth_split(half[1], language, latent, emb, kwargs, ref, depth + 1)
            return self.torch.cat([left, right], dim=-1), sr

    def synth(self, text, language, latent, emb, kwargs, ref):
        """Один проход XTTS: стрим, а при неудаче — полный инференс.

        Стрим отдаёт звук инкрементально, поэтому он основной; в старых сборках
        его может не быть вовсе. Сигнатуры тоже разные: новым нужны латенты,
        старым — путь к референсу.
        """
        t = self.torch
        try:
            chunks = self.tts.inference_stream(
                text,
                language,
                latent,
                emb,
                **_filter_kwargs(self.tts.inference_stream, kwargs),
            )
            parts, sr = [], 24000
            for c in chunks:
                parts.append(c)
                sr = getattr(c, "sr", None) or sr
                # инкрементальный VRAM-гард внутри стрима
                self.empty_cache()
            # Чанки стрима — тензоры формы (1, N): складывать их по нулевой оси
            # нельзя (вышел бы «N каналов»), поэтому по последней.
            wav = t.cat(parts, dim=-1) if parts and hasattr(parts[0], "dim") else parts
        except Exception:
            # Фолбэк: полный (не стриминговый) инференс.
            inf = self.tts.inference
            if _has_param(inf, "speaker_wav"):
                wav = inf(text, language, ref, **_filter_kwargs(inf, kwargs))
            else:
                wav = inf(text, language, latent, emb, **_filter_kwargs(inf, kwargs))
            if isinstance(wav, tuple):
                wav, sr = wav[0], wav[1]
            else:
                sr = 24000
        return _flat(wav, t), sr


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
                _emit({"type": "ready", "device": eng.deviceId, "vramGb": eng.vramTotal, "shims": eng.shims})
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
