# -*- coding: utf-8 -*-
"""
Проверка Python-окружения для TTS-движков (F5-TTS / Coqui XTTS v2).

Зачем отдельный скрипт: приложение запускает сайдкар через `python` из PATH, но
torch/f5_tts может быть установлен в ДРУГОЕ окружение (venv, conda, `py -3.11`).
Тогда первый же рендер падал с невнятным «No module named 'torch'».

Здесь мы НЕ импортируем torch (это дорого: загрузка CUDA-библиотек занимает
секунды) — только `importlib.util.find_spec`, поэтому проверка быстрая и
безопасная. Результат — одна JSON-строка в stdout:

    {"python": "3.11.9", "executable": "C:/.../python.exe",
     "modules": {"torch": true, "torchaudio": true, "f5_tts": false, ...}}

Требуется Python 3.8+ (стандартная библиотека, без сторонних зависимостей).
"""
import importlib.util as util
import json
import sys

# Имена пакетов ровно как в import-инструкциях сайдкаров:
#   f5_wrapper.py  -> torch, torchaudio, f5_tts (pynvml — опционально)
#   xtts_wrapper.py-> torch, torchaudio, TTS
#   ruaccent_worker.py -> ruaccent (расстановка ударений; тоже опционально —
#   без него озвучка идёт без ударений, но с ним качество русской речи выше).
MODULES = ["torch", "torchaudio", "f5_tts", "TTS", "pynvml", "ruaccent"]


def probe(name):
    """Модуль установлен? find_spec не грузит его (быстро и без CUDA)."""
    try:
        return util.find_spec(name) is not None
    except Exception:
        return False


def main():
    result = {
        "python": "%d.%d.%d" % sys.version_info[:3],
        "executable": sys.executable or "",
        "modules": {name: probe(name) for name in MODULES},
    }
    sys.stdout.write(json.dumps(result) + "\n")
    sys.stdout.flush()


if __name__ == "__main__":
    main()
