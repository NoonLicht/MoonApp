"""
OCR-мост для PDF-тулкита (PaddleOCR + PyMuPDF).

Вызывается как: python ocr_paddle.py <config.json>
config.json:
  {
    "mode": "rasterize" | "ocr" | "rasterize_ocr",
    "pdfPath": "...",       # для rasterize/rasterize_ocr
    "imagePaths": [...],    # для ocr (уже готовые картинки)
    "outDir": "...",        # куда класть растеризованные страницы
    "dpi": 200,
    "device": "cpu" | "gpu",
    "lang": "ru"
  }

Печатает в stdout ОДНУ строку JSON: {"pages": [{"index", "imagePath"?, "text"?}]}.
Ошибки — в stderr + ненулевой код возврата (см. server/ts/ocrEngine.ts).

rasterize и ocr разделены намеренно: PDF->JPG (rasterize) нужен многим чаще
и не требует тяжёлого PaddleOCR/paddlepaddle — тянуть их ради конвертации
картинок не нужно.
"""
import sys
import os
import json
import warnings

warnings.filterwarnings("ignore")


def rasterize(pdf_path: str, out_dir: str, dpi: int) -> list:
    import fitz  # PyMuPDF

    os.makedirs(out_dir, exist_ok=True)
    doc = fitz.open(pdf_path)
    zoom = dpi / 72.0
    mat = fitz.Matrix(zoom, zoom)
    paths = []
    for i, page in enumerate(doc):
        pix = page.get_pixmap(matrix=mat)
        p = os.path.join(out_dir, f"page_{i + 1}.png")
        pix.save(p)
        paths.append(p)
    doc.close()
    return paths


_ocr_instance = None


def get_ocr(lang: str, device: str):
    global _ocr_instance
    if _ocr_instance is not None:
        return _ocr_instance
    from paddleocr import PaddleOCR

    # Разные версии paddleocr по-разному называют флаг устройства — пробуем
    # известные варианты, вместо того чтобы жёстко зависеть от одной версии API.
    kwargs_variants = [
        {"use_angle_cls": True, "lang": lang, "device": "gpu" if device == "gpu" else "cpu"},
        {"use_angle_cls": True, "lang": lang, "use_gpu": device == "gpu"},
        {"use_angle_cls": True, "lang": lang},
    ]
    last_err = None
    for kwargs in kwargs_variants:
        try:
            _ocr_instance = PaddleOCR(**kwargs)
            return _ocr_instance
        except TypeError as e:
            last_err = e
            continue
    raise last_err or RuntimeError("paddleocr_init_failed")


def ocr_images(image_paths: list, lang: str, device: str) -> list:
    ocr = get_ocr(lang, device)
    pages = []
    for i, p in enumerate(image_paths):
        result = ocr.ocr(p, cls=True)
        lines = []
        if result and result[0]:
            for line in result[0]:
                try:
                    lines.append(line[1][0])
                except Exception:
                    continue
        pages.append({"index": i + 1, "text": "\n".join(lines)})
    return pages


def main() -> None:
    cfg_path = sys.argv[1]
    with open(cfg_path, "r", encoding="utf-8") as f:
        cfg = json.load(f)

    mode = cfg.get("mode", "ocr")
    dpi = int(cfg.get("dpi", 200))
    device = cfg.get("device", "cpu")
    lang = cfg.get("lang", "ru")
    out = {"pages": []}

    image_paths = cfg.get("imagePaths") or []
    if mode in ("rasterize", "rasterize_ocr"):
        image_paths = rasterize(cfg["pdfPath"], cfg["outDir"], dpi)
        if mode == "rasterize":
            out["pages"] = [{"index": i + 1, "imagePath": p} for i, p in enumerate(image_paths)]

    if mode in ("ocr", "rasterize_ocr"):
        out["pages"] = ocr_images(image_paths, lang, device)

    sys.stdout.write(json.dumps(out, ensure_ascii=False))
    sys.stdout.flush()


if __name__ == "__main__":
    try:
        main()
    except Exception as e:  # noqa: BLE001 — мост обязан вернуть код ошибки, а не трассировку в stdout
        sys.stderr.write(f"{type(e).__name__}: {e}\n")
        sys.exit(1)
