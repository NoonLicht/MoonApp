# -*- coding: utf-8 -*-
"""
Общие шимы звукового стека для сайдкаров озвучки (F5-TTS и Coqui XTTS).

Зачем модуль. Оба движка сами читают референсный голос, и их внутренности
рассчитаны на «обычный» аудиостек, которого у пользователя может не быть:

  • f5-tts декодирует референс через pydub (`AudioSegment.from_file`), а pydub
    запускает `ffmpeg` ПО ИМЕНИ, то есть ищет его в PATH. В приложении ffmpeg
    лежит в `storage/ffmpeg` и в PATH не прописан — поэтому рендер падал с
    «[WinError 2] Не удается найти указанный файл» ровно на первом чанке
    (проверено на .mp3/.ogg референсах из storage/tts);
  • и f5-tts, и coqui-tts читают аудио через `torchaudio.load`. Начиная с
    torchaudio 2.9 этот вызов идёт ТОЛЬКО через torchcodec (параметр `backend`
    игнорируется), а torchcodec грузит свои libtorchcodec_core*.dll, которым
    нужны DLL «full-shared» сборки FFmpeg. Без установленного FFmpeg падает
    любой файл, включая WAV («Could not load libtorchcodec»). На машине без
    FFmpeg это проверено: torchaudio.load не читает ни mp3, ни ogg, ни wav, а
    soundfile (libsndfile) и librosa читают всё это штатно;
  • coqui-tts требует `transformers>=4.57`, но в transformers 5.x из
    `transformers.pytorch_utils` убрали `isin_mps_friendly`, который импортирует
    TTS (`TTS/tts/layers/tortoise/autoregressive.py`) — движок падал уже на
    `import TTS.api` с «cannot import name 'isin_mps_friendly'».

Что делает модуль (сайдкар вызывает `prepare()` ДО импорта движка):

  1. `use_app_ffmpeg()` — находит ffmpeg приложения (или путь из настроек),
     добавляет его каталог в PATH и подставляет его же в pydub
     (`AudioSegment.converter`/`ffprobe`), после чего pydub снова читает
     mp3/ogg/m4a;
  2. `fix_torchaudio_load()` — если штатный `torchaudio.load` не работает,
     подменяет его чтением через soundfile. Штатный вызов не выбрасывается: у
     кого FFmpeg есть, всё работает как раньше, а «сломанность» запоминается,
     чтобы не тратить время на падающий вызов на каждом файле;
  3. `fix_transformers_import()` — возвращает `isin_mps_friendly` в
     `transformers.pytorch_utils` (копия удалённой функции на torch.isin).

Шимы мягкие: нет библиотеки, нет ffmpeg, всё уже исправно — вызов просто вернёт
описание состояния и ничего не сломает. Модуль подключается как обычный соседний
модуль (`from py_audio import prepare`): каталог скрипта сайдкара всегда в sys.path.
"""
import os
import sys


def _script_dir():
    """Каталог этого файла (server/engines) — от него ищем storage приложения."""
    return os.path.dirname(os.path.abspath(__file__))


def force_utf8():
    """Перевести stdin/stdout/stderr сайдкара в UTF-8 — ДО чтения протокола.

    Зачем это обязательно. Протокол сайдкара — JSON-строки в UTF-8, так их пишет
    Node. Но python, запущенный с ПРИСОЕДИНЁННЫМ конвейером, берёт кодировку не
    из протокола, а из локали Windows: на русской системе это cp1251
    (`sys.stdin.encoding == 'cp1251'`, проверено). В итоге русский текст книжки
    декодировался как крякозябры, и движок озвучивал уже МУСОР: проверка длины
    видела 196 символов вместо 108 (столько занимают UTF-8 байты правильного
    текста, прочитанные как cp1251), XTTS ругался «character limit of 182», а на
    слух получалась «тарабарщина» вместо русского — при этом и язык, и параметры,
    и модель были тут ни при чём.

    reconfigure() есть с Python 3.7, но у старых сборок и у «завёрнутых» потоков
    его может не быть — тогда работает только обходной путь в spawne
    (PYTHONIOENCODING/PYTHONUTF8, см. EngineSidecar в server/ts/tts.ts).
    """
    for stream in (sys.stdin, sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass
    return getattr(sys.stdin, "encoding", "") or ""


def find_ffmpeg(explicit=""):
    """Путь к ffmpeg: явный (из настроек сайдкара) → сборка приложения → PATH.

    Приложение держит ffmpeg в `storage/ffmpeg` (и допускает распакованный архив
    целиком, то есть `storage/ffmpeg/bin`), поэтому проверяем оба варианта.
    """
    root = os.path.abspath(os.path.join(_script_dir(), "..", ".."))
    candidates = []
    if explicit:
        candidates.append(explicit)
    for rel in ("storage/ffmpeg/bin", "storage/ffmpeg", "bin"):
        for name in ("ffmpeg.exe", "ffmpeg"):
            candidates.append(os.path.join(root, *rel.split("/"), name))
    for c in candidates:
        if c and os.path.isfile(c):
            return os.path.abspath(c)
    try:
        from shutil import which

        return which("ffmpeg") or ""
    except Exception:
        return ""


def use_app_ffmpeg(explicit=""):
    """Прописать ffmpeg приложения для pydub. Возвращает путь (или «»).

    pydub ищет бинарь по имени (`pydub.utils.which`) и запускает его как процесс,
    поэтому одного абсолютного пути мало: и `ffmpeg`, и `ffprobe` должны
    находиться через PATH — тогда работают любые форматы референса.
    """
    ff = find_ffmpeg(explicit)
    if not ff:
        return ""
    folder = os.path.dirname(ff)
    path_parts = [p for p in os.environ.get("PATH", "").split(os.pathsep) if p]
    if folder not in path_parts:
        os.environ["PATH"] = folder + os.pathsep + os.environ.get("PATH", "")
    # Некоторые библиотеки читают путь из переменных окружения, а не из PATH.
    os.environ.setdefault("FFMPEG_BINARY", ff)
    try:
        from pydub import AudioSegment
    except Exception:
        return ff  # pydub нет — PATH всё равно полезен (torchcodec/ffmpeg-обёртки)
    probe = os.path.join(folder, "ffprobe.exe" if ff.lower().endswith(".exe") else "ffprobe")
    try:
        AudioSegment.converter = ff
        if os.path.isfile(probe):
            AudioSegment.ffprobe = probe
    except Exception:
        pass
    return ff


def fix_torchaudio_load():
    """Читать аудио через soundfile, если torchaudio (torchcodec) не может.

    TorchAudio 2.9+ делегирует декодирование torchcodec, которому нужны DLL
    полноценного FFmpeg; без них падает даже на WAV. soundfile (libsndfile) читает
    wav/flac/ogg/mp3 без внешних зависимостей — движки и так построены на нём.

    Штатный вызов пробуем первым: если он работает (у пользователя есть FFmpeg),
    поведение не меняется. Результат первой неудачи запоминается, чтобы не платить
    за падающий вызов на каждом файле.
    """
    try:
        import torch
        import torchaudio
    except Exception as e:
        return "нет torchaudio: %s" % e
    real = getattr(torchaudio, "load", None)
    if real is None:
        return "torchaudio.load отсутствует"
    if getattr(real, "_moonapp_shim", False):
        return "уже подменён"
    state = {"broken": False}

    def load(
        uri,
        frame_offset=0,
        num_frames=-1,
        normalize=True,
        channels_first=True,
        format=None,
        backend=None,
        **kw,
    ):
        if not state["broken"]:
            try:
                return real(
                    uri,
                    frame_offset=frame_offset,
                    num_frames=num_frames,
                    normalize=normalize,
                    channels_first=channels_first,
                    format=format,
                    backend=backend,
                    **kw,
                )
            except Exception:
                # Первое падение = «torchcodec без FFmpeg» либо иная несовместимость
                # окружения: дальше сразу идём в soundfile.
                state["broken"] = True
        import numpy as np
        import soundfile as sf

        data, sr = sf.read(
            str(uri),
            start=max(0, int(frame_offset or 0)),
            frames=int(num_frames) if num_frames and num_frames > 0 else -1,
            dtype="float32",
            always_2d=True,
        )
        # soundfile отдаёт (frames, channels), torchaudio — (channels, frames).
        arr = data.T if channels_first else data
        return torch.from_numpy(np.ascontiguousarray(arr)), int(sr)

    load._moonapp_shim = True
    torchaudio.load = load
    return "подменён на soundfile"


def fix_transformers_import():
    """Вернуть isin_mps_friendly, убранный в transformers 5, но нужный coqui-tts.

    Комплект `isin_mps_friendly` импортирует TTS (слой tortoise) ДО того, как дело
    дойдёт до XTTS, поэтому без него `import TTS.api` падает целиком. Функция
    маленькая и полностью восстанавливается: это обёртка над torch.isin.
    """
    try:
        import transformers.pytorch_utils as pu
    except Exception as e:
        return "нет transformers: %s" % e
    if hasattr(pu, "isin_mps_friendly"):
        return "не требуется"
    try:
        import torch
    except Exception as e:
        return "нет torch: %s" % e

    def isin_mps_friendly(elements, test_elements):
        """Копия функции из transformers 4.x (убрана в 5.0)."""
        if test_elements.ndim == 0:
            test_elements = test_elements.unsqueeze(0)
        return torch.isin(elements, test_elements)

    pu.isin_mps_friendly = isin_mps_friendly
    # Отдельные сборки импортируют символ из transformers.utils — подстрахуемся.
    try:
        import transformers.utils as tu

        if not hasattr(tu, "isin_mps_friendly"):
            tu.isin_mps_friendly = isin_mps_friendly
    except Exception:
        pass
    return "поставлен"


def allow_coqui_tos():
    """Разрешить скачивание XTTS без интерактивного вопроса про лицензию.

    Модель XTTS v2 у Coqui помечена `tos_required`: ModelManager спрашивает в
    stdin «I have purchased a commercial license… / Otherwise, I agree to the
    non-commercial CPML» и ждёт y/n. У сайдкара stdin занят протоколом задания
    (JSON-строки), вопроса пользователю показать негде — без этого шага первый
    рендер XTTS висел бы на ожидании ответа, а прочитанная из stdin строка с
    командой была бы истолкована как отказ.

    Coqui сама предусмотрела неинтерактивный путь: переменная окружения
    `COQUI_TOS_AGREED=1` (см. TTS/utils/manage.py → ModelManager.tos_agreed).
    Ставим её только для сайдкара XTTS: лицензия CPML —
    https://coqui.ai/cpml (модель некоммерческая), приложение работает с ней
    как с обычным локальным движком, а условие принимается за пользователя.
    """
    if os.environ.get("COQUI_TOS_AGREED") != "1":
        os.environ["COQUI_TOS_AGREED"] = "1"
        return "поставлена"
    return "уже"


def prepare(ffmpeg=""):
    """Все шимы сразу — вызывается сайдкаром до импорта движка.

    Возвращает словарь состояния (попадает в лог, когда что-то не сошлось):
    `{"ffmpeg": путь или "", "torchaudio": ..., "transformers": ...}`.
    """
    state = {
        "ffmpeg": use_app_ffmpeg(ffmpeg),
        "torchaudio": fix_torchaudio_load(),
        "transformers": fix_transformers_import(),
    }
    return state


if __name__ == "__main__":  # ручная диагностика: python py_audio.py [ffmpeg.exe]
    import json

    print(json.dumps(prepare(sys.argv[1] if len(sys.argv) > 1 else ""), ensure_ascii=False, indent=1))