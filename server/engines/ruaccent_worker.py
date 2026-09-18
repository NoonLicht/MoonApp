# -*- coding: utf-8 -*-
"""
Рабочий процесс расстановки ударений (RUAccent) для студии озвучки.

Зачем отдельный процесс, а не работа внутри сайдкара движка: onnxruntime на CPU
и torch в одном процессе делят память, а рендер F5-TTS и так занимает несколько
гигабайт. Плюс ударения нужны ДО инференса и одни и те же для любого движка.

Процесс живёт долго (приложением управляет server/ts/tts.ts): загрузка моделей
RUAccent занимает секунды и сотни мегабайт памяти, поэтому держать его между
заданиями выгодно, а по бездействию приложение его само снимет (`unload` —
выгрузить модели, `shutdown` — выйти).

Вход (каждая строка — JSON):
  {"type":"load","model":"tiny2.1","dict":false,"tiny":true}
  {"type":"accent","id":7,"texts":["...","..."]}
  {"type":"unload"}
  {"type":"shutdown"}

Выход (каждая строка — JSON):
  {"type":"ready","model":"tiny2.1","version":"1.5.8.3","dict":false,"tiny":true,"sec":6.1}
  {"type":"accented","id":7,"texts":["зам+ок ..."],"sec":0.4}
  {"type":"unloaded"}
  {"type":"error","id":7,"message":"ruaccent_not_installed: ..."}

Ошибка НЕ завершает процесс: ударения — необязательный шаг, приложение
продолжает рендер без них (см. accentItems в server/ts/tts.ts), а причину
показывает в логе.
"""
import json
import os
import sys
import time

try:
    from py_audio import force_utf8
    from ru_accent import MODEL_DEFAULT, Accenter, AccenterError
except ImportError:  # запуск не из каталога скрипта (например, импорт как модуля)
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    from py_audio import force_utf8
    from ru_accent import MODEL_DEFAULT, Accenter, AccenterError


def _emit(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


class Worker:
    """Один Accenter на процесс: настраивается первым запросом."""

    def __init__(self):
        self.accenter = None
        self.version = ""

    def _accenter(self, req):
        """Аксентер запрошенной сборки. Смена модели/словаря — перезагрузка."""
        model = str(req.get("model") or MODEL_DEFAULT)
        use_dict = req.get("dict")
        tiny = req.get("tiny")
        if self.accenter and (
            self.accenter.model != model
            or self.accenter.tiny_mode is not tiny
            or (use_dict is not None and self.accenter.use_dictionary != use_dict)
        ):
            self.accenter.unload()
            self.accenter = None
        if self.accenter is None:
            self.accenter = Accenter(
                model=model, use_dictionary=use_dict, tiny_mode=True if tiny is None else tiny
            )
        return self.accenter

    def load(self, req):
        """Явная загрузка моделей: ответ ready сообщает, чем расставляем и сколько ждали.

        Отдельный запрос (а не ленивая загрузка на первом accent) нужен, чтобы
        приложение показало шаг «Ударения» в прогрессе и получило причину, если
        моделей нет: тогда озвучка идёт без ударений, а не падает.
        """
        accenter = self._accenter(req)
        t0 = time.time()
        state = accenter.load() if accenter.accentizer is None else accenter.state()
        state["sec"] = round(time.time() - t0, 1)
        return {"type": "ready", **state}

    def accent(self, req):
        """Ударения для списка текстов.

        Если модели ещё не загружены (accent без предварительного load), грузим
        молча: на этот запрос приложение ждёт РОВНО один ответ — accented.
        """
        accenter = self._accenter(req)
        texts = [str(t or "") for t in (req.get("texts") or [])]
        t0 = time.time()
        if accenter.accentizer is None:
            accenter.load()
            t0 = time.time()
        return {
            "type": "accented",
            "id": req.get("id"),
            "texts": accenter.accent_many(texts),
            "sec": round(time.time() - t0, 2),
        }

    def unload(self):
        if self.accenter:
            self.accenter.unload()
        return {"type": "unloaded"}


def main():
    # Протокол — UTF-8 JSON-lines: без этого русский текст приезжает крякозябрами
    # (подробности в py_audio.force_utf8).
    force_utf8()
    worker = Worker()
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
            if rtype == "load":
                _emit(worker.load(req))
            elif rtype == "accent":
                _emit(worker.accent(req))
            elif rtype == "unload":
                _emit(worker.unload())
            elif rtype == "shutdown":
                break
            else:
                _emit({"type": "error", "id": req.get("id"), "message": "unknown_type: %s" % rtype})
        except AccenterError as e:
            # Понятная причина для лога: нет библиотеки или не скачались модели.
            _emit({"type": "error", "id": req.get("id"), "message": str(e)[:500]})
        except Exception as e:
            _emit({"type": "error", "id": req.get("id"), "message": "%s: %s" % (type(e).__name__, e)})
    worker.unload()


if __name__ == "__main__":
    main()