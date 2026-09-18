# -*- coding: utf-8 -*-
"""
Расстановка ударений по смыслу: RUAccent (Den4ikAI/ruaccent).

Зачем модуль. Свой словарь омографов в приложении знает всего четыре слова
(server/ts/ruNlp.ts), поэтому «замо́к» и «му́ка» в книге звучали как попало, а
остальные слова F5-TTS читал без ударения вообще. RUAccent — русский
расстановщик ударений с обработкой омографов: нейросеть-омограф решает по
КОНТЕКСТУ, словарь закрывает частотные слова, движок правил — предлоги и ё.

Формат ударения — «+» ПЕРЕД ударной гласной («зам+ок»). Это не наш выбор:
именно так отдаёт ударение сам RUAccent (`AccentModel.render_stress` и словарь
`{'слово': 'сл+ово'}`), и именно такой формат ждёт русский чекпоинт F5-TTS
(см. RU_MODEL в server/engines/f5_wrapper.py). Совпадение форматов — почему
ударения уезжают в модель без конвертации.

Ёфикация тоже здесь: `process_all` восстанавливает «ё» нейросетью-омографом
(«все» → «всё»), то есть закрывает то, что словарная ёфикация в TS делает лишь
для десятков слов.

ГДЕ ЛЕЖАТ МОДЕЛИ. Скачанные словари и нейросети (≈680 МБ в полном режиме и
≈80 МБ в лёгком — он и стоит по умолчанию) кладутся в `storage/tts/ruaccent`, а
не в site-packages окружения: окружение удаляется кнопкой «удалить сборку», а
каталог моделей должен переживать переустановку и легко находиться
пользователем. Каталог исключён из суточной TTL-уборки storage/tts
(см. keep в server/ts/tts.ts) — иначе модели удалялись бы каждые сутки.

ЧТО МОЖЕТ ПОЙТИ НЕ ТАК и что модуль с этим делает:

  • прерванная закачка. RUAccent считает каталог модели существующим по самому
    ФАКТУ каталога и не смотрит на файлы: оборванная закачка `model.onnx`
    оставляет пустой каталог, и дальше каждая загрузка падает с
    «onnxruntime ... Load model from ...model.onnx failed: File doesn't exist».
    Проверено на прерванной задаче (browser kill): лечится только удалением
    каталога. Поэтому здесь есть repair(): перед загрузкой проверяем
    обязательные файлы и сносим неполные каталоги, а после ошибки пробуем ещё
    раз (один повтор);
  • библиотеки нет вовсе (окружение поставлено до появления RUAccent) — import
    падает, и AccenterError несёт текст для лога. Это НЕ ошибка рендера: озвучка
    продолжается без ударений (см. ruaccent_worker.py);
  • символы вне «белого списка» RUAccent. `process_all` чистит текст своим
    выражением и молча УДАЛЯЕТ всё, что не буквы/цифры/часть пунктуации —
    например многоточие «…», «№», «°», «/», «%». Для книги это потеря (а
    многоточие нередко закрывает фразу). Такие символы защищены через
    skip_regex: process_all обрабатывает текст КУСКАМИ вокруг них, а сами они
    остаются на месте (см. protect_risky);
  • знаки ударения из прошлых шагов. Свой словарь в TS ставит U+0301 ПОСЛЕ
    гласной — перед RUAccent они не нужны (у него свои «+»), поэтому
    combining-диакритика снимается до расстановки.

Модуль запускается только в отдельном процессе-рабочем (ruaccent_worker.py):
onnxruntime на CPU и torch в одном процессе делят память, а рендер F5 и так
занимает несколько гигабайт.
"""
import os
import re
import shutil
import sys

# Модель омографов по умолчанию — tiny2.1 (41 МБ). Замерено на живых текстах:
# лёгкий режим (tiny_mode) с tiny2.1 даёт те же ударения, что turbo3.1 с полным
# словарём и правилами (20/21 на частотных словах и 27/27 на редких, причём на
# «щаве́ль» лёгкий точнее: полный дал «щ+авель»), но занимает 847 МБ памяти
# вместо 3 ГБ и грузится 6 с вместо 12.5 с.
MODEL_DEFAULT = "tiny2.1"

# Лёгкий режим по умолчанию: без движка правил и предиктора нужности ударения.
# В этом режиме ударение ставится ВСЕМ словам с двумя и более гласными (для
# озвучки это как раз то, что нужно), а словарь берётся нейросетевой (0.8 МБ
# вместо 20 МБ). Полный режим включается настройкой voice.stressLite = false.
TINY_DEFAULT = True

# Обязательные файлы каждой скачанной части: каталог без них — недокачанный.
_REQUIRED = {
    "nn/nn_accent": ("model.onnx",),
    "nn/nn_stress_usage_predictor": ("model.onnx",),
    "nn/nn_yo_homograph_resolver": ("model.onnx",),
    "dictionary": ("accents.json.gz", "omographs.json.gz", "yo_words.json.gz"),
}

# Символы, которые RUAccent стирает из текста (его `normalize` их не пропускает),
# но которые нужны озвучке: многоточие держит паузу в конце фразы, «№»/«°»/«%»
# встречаются в тексте книги. Защищаем их, обрабатывая текст кусками вокруг них.
RISKY = "…°№/\\|+=*&^%$#@~<>_`«»„“”"

# Знаки ударения из наших прошлых шагов: ruNlp.markStress ставит U+0301 ПОСЛЕ
# гласной. RUAccent ставит свои «+» перед гласной, и чужой знак только мешает
# разбору слова — снимаем перед расстановкой (в «белый список» RUAccent он и так
# не входит, то есть был бы просто удалён вместе с мусором).
COMBINING = re.compile("[\u0300-\u036f\u0483-\u0489]")


def _script_dir():
    """Каталог этого файла (server/engines) — от него ищем storage приложения."""
    return os.path.dirname(os.path.abspath(__file__))


def app_root():
    """Корень приложения (каталог, в котором лежит storage)."""
    return os.path.abspath(os.path.join(_script_dir(), "..", ".."))


def storage_dir():
    """Каталог данных приложения: MOONAPP_STORAGE, иначе storage рядом с кодом."""
    env = os.environ.get("MOONAPP_STORAGE")
    return os.path.abspath(env) if env else os.path.join(app_root(), "storage")


def workdir():
    """Куда RUAccent складывает словари и модели (переживает переустановку env)."""
    return os.path.join(storage_dir(), "tts", "ruaccent")


class AccenterError(RuntimeError):
    """RUAccent недоступен (нет библиотеки, обрыв закачки) — текст для лога."""


def protect_risky(text):
    """Регулярка для skip_regex: вернуть на место символы из RISKY.

    RUAccent чистит текст и выкидывает всё вне своего «белого списка», а
    skip_regex заставляет его обрабатывать текст КУСКАМИ вокруг совпадений —
    значит защищённые символы остаются в тексте нетронутыми. Возвращаем None,
    если защищать нечего: тогда process_all идёт обычным путём (быстрее).
    """
    found = sorted(set(ch for ch in str(text or "") if ch in RISKY))
    if not found:
        return None
    return "[" + re.escape("".join(found)) + "]+"


def broken_parts(root, model=MODEL_DEFAULT):
    """Недокачанные части: [(путь, чего не хватает)] — их надо перекачать.

    Каталог модели омографов проверяется отдельно (модель выбирается в load) —
    здесь только то, что одинаково для всех сборок.
    """
    out = []
    for rel, names in _REQUIRED.items():
        d = os.path.join(root, *rel.split("/"))
        if not os.path.isdir(d):
            continue
        miss = [n for n in names if not os.path.isfile(os.path.join(d, n))]
        if miss:
            out.append((d, miss))
    omo = os.path.join(root, "nn", "nn_omograph", model)
    if os.path.isdir(omo) and not os.path.isfile(os.path.join(omo, "model.onnx")):
        out.append((omo, ["model.onnx"]))
    return out


def repair(root, model=MODEL_DEFAULT):
    """Снести недокачанные части, чтобы RUAccent скачал их заново.

    Зачем: каталог без `model.onnx` RUAccent считает уже скачанным — без чистки
    каждый следующий запуск падает на «File doesn't exist», и вылечить это из
    интерфейса нельзя.
    """
    removed = []
    for d, _miss in broken_parts(root, model):
        shutil.rmtree(d, ignore_errors=True)
        removed.append(d)
    return removed


class Accenter:
    """Обёртка над RUAccent: загрузка по требованию, ударения, выгрузка."""

    def __init__(self, model=MODEL_DEFAULT, use_dictionary=None, root=None, tiny_mode=TINY_DEFAULT):
        self.model = model or MODEL_DEFAULT
        # Словарь: в лёгком режиме RUAccent всё равно берёт нейросетевой
        # (accents_nn.json.gz), поэтому по умолчанию выбор следует за режимом.
        self.use_dictionary = (not tiny_mode) if use_dictionary is None else use_dictionary
        # tiny_mode убирает движок правил и предиктор нужности ударения: словарь
        # становится маленьким (0.8 МБ вместо 20 МБ), а память — на два гигабайта
        # меньше. Замеры и сравнение качества — в комментарии к MODEL_DEFAULT.
        self.tiny_mode = tiny_mode
        self.root = root or workdir()
        self.accentizer = None
        self.repaired = []

    def _import(self):
        """Импорт библиотеки; отсутствие — понятная ошибка, а не трейсбек."""
        try:
            import ruaccent
        except Exception as e:
            raise AccenterError(
                "ruaccent_not_installed: %s (поставьте окружение озвучки заново — "
                "RUAccent ставится вместе с ним)" % e
            )
        self.version = getattr(ruaccent, "__version__", "")
        return ruaccent.RUAccent

    def load(self):
        """Загрузить модели (первый раз — со скачиванием). Возвращает состояние."""
        RUAccent = self._import()
        os.makedirs(self.root, exist_ok=True)
        # Библиотека считает каталог скачанным по его НАЛИЧИЮ: недокачанные части
        # надо снести ДО загрузки, иначе onnxruntime падает на «File doesn't exist».
        self.repaired = repair(self.root, self.model)
        try:
            self._load_once(RUAccent)
        except Exception as e:
            # Один повтор после чистки: чаще всего это оборванная закачка, о
            # которой по тексту ошибки не догадаться («Load model from … failed»).
            again = repair(self.root, self.model)
            if not again:
                raise AccenterError("ruaccent_load_failed: %s" % e)
            self.repaired.extend(again)
            self._load_once(RUAccent)
        return {
            "model": self.model,
            "version": self.version,
            "dict": self.use_dictionary,
            "tiny": self.tiny_mode,
            "dir": self.root,
            "repaired": len(self.repaired),
        }

    def _load_once(self, RUAccent):
        acc = RUAccent()
        if self.tiny_mode:
            # В лёгком режиме движок правил не создаётся вовсе, а его данные
            # (koziev: лемматизатор и теггер, 188 МБ) библиотека качает
            # безусловно. Читать их никто не будет — не тянем их из сети
            # (пустой список путей = пропустить этот шаг загрузки).
            acc.koziev_paths = []
            # Предиктор «нужно ли ударение в этом слове» в лёгком режиме тоже не
            # создаётся (ударение ставится всем словам с двумя гласными), а его
            # модель весит 111 МБ — не качаем зря.
            acc.accentuator_paths = [
                p for p in acc.accentuator_paths if p != "/nn/nn_stress_usage_predictor"
            ]
        acc.load(
            omograph_model_size=self.model,
            use_dictionary=self.use_dictionary,
            workdir=self.root,
            tiny_mode=self.tiny_mode,
        )
        self.accentizer = acc

    def accent(self, text):
        """Расставить ударения («+» перед ударной гласной) и восстановить «ё»."""
        if self.accentizer is None:
            self.load()
        s = COMBINING.sub("", str(text or ""))
        if not s.strip():
            return s
        return self.accentizer.process_all(s, skip_regex=protect_risky(s))

    def accent_many(self, texts):
        """То же для списка строк — по одной просьбе на список."""
        return [self.accent(t) for t in texts]

    def unload(self):
        """Выгрузить модели: память возвращается, сам процесс остаётся жить."""
        self.accentizer = None
        import gc

        gc.collect()

    def state(self):
        """Краткое состояние для лога: чем расставляем и откуда."""
        return {
            "model": self.model,
            "version": getattr(self, "version", ""),
            "dict": self.use_dictionary,
            "tiny": self.tiny_mode,
            "dir": self.root,
            "loaded": self.accentizer is not None,
        }


if __name__ == "__main__":  # ручная диагностика: python ru_accent.py "текст"
    import json
    import time

    from py_audio import force_utf8

    force_utf8()
    accenter = Accenter()
    t0 = time.time()
    print(json.dumps(accenter.load(), ensure_ascii=False), "за", round(time.time() - t0, 1), "с")
    for sample in sys.argv[1:] or ["на двери висит замок", "Мука из пшеницы", "Все еще пришел…"]:
        print(repr(sample), "->", repr(accenter.accent(sample)))
    print(accenter.state())