"""
Экспорт интерполяторов IFRNet и CAIN в ONNX для каталога апскейла.

Зачем инструмент: в открытом доступе лежат только PyTorch-веса (`*.pth`), а движок
апскейла работает на ONNX Runtime (`server/ts/upscale.ts`). Скрипт конвертирует
официальные веса в схемы, которые движок уже понимает:

  * IFRNet — `img0`, `img1`, `timestep`: момент времени передаётся явно, поэтому
    работают ×2/×3/×4 без каскадов (схема `rife-pair-timestep`);
  * CAIN — один вход `input` [1,6,H,W] (две рамки подряд по каналам, схема
    `cain-concat`): CAIN интерполирует ровно середину и момент времени не принимает.

Подготовка (один раз):
    git clone https://github.com/ltkong218/IFRNet  # исходники рядом со скриптом
    git clone https://github.com/myungsub/CAIN
    # веса: IFRNet_GoPro.pth, IFRNet_Vimeo90K.pth, pretrained_cain.pth

Запуск:
    python scripts/export-interp-onnx.py --model ifrnet --weights IFRNet_GoPro.pth \
        --src IFRNet --out ifrnet-gopro.onnx
    python scripts/export-interp-onnx.py --model cain --weights pretrained_cain.pth \
        --src CAIN --out cain.onnx

Проверить результат: `node scripts/verify-model.js --url <URL> --id <ид>`
(скачает, сверит sha256 и прогонит реальный инференс).
"""

import argparse
import os
import sys
import types

import torch
import torch.nn as nn

# Исходники IFRNet тянут imageio для чтения кадров при обучении, а нам нужен
# только `warp` из utils: подставляем заглушку, чтобы не ставить лишние пакеты.
if "imageio" not in sys.modules:
    fake = types.ModuleType("imageio")
    fake.imread = lambda *a, **k: None  # type: ignore[attr-defined]
    fake.imwrite = lambda *a, **k: None  # type: ignore[attr-defined]
    sys.modules["imageio"] = fake


def load_state(model: nn.Module, weights: str) -> None:
    """Загрузить веса, сняв префикс DataParallel (`module.`) и обёртку чекпоинта."""
    state = torch.load(weights, map_location="cpu", weights_only=False)
    if isinstance(state, dict) and "state_dict" in state:
        state = state["state_dict"]
    state = {k.replace("module.", "", 1): v for k, v in state.items()}
    model.load_state_dict(state, strict=True)


def export_ifrnet(args: argparse.Namespace) -> None:
    sys.path.insert(0, os.path.abspath(args.src))
    from models.IFRNet import Model  # noqa: E402

    model = Model().eval()
    load_state(model, os.path.abspath(args.weights))

    class Wrap(nn.Module):
        def __init__(self, m: nn.Module) -> None:
            super().__init__()
            self.m = m

        def forward(self, img0, img1, timestep):
            embt = timestep.reshape(-1, 1, 1, 1)  # IFRNet ждёт (B,1,1,1)
            return self.m.inference(img0, img1, embt, scale_factor=1.0)

    wrap = Wrap(model).eval()
    img0 = torch.rand(1, 3, 64, 64)
    torch.onnx.export(
        wrap,
        (img0, torch.rand(1, 3, 64, 64), torch.tensor([0.5])),
        args.out,
        input_names=["img0", "img1", "timestep"],
        output_names=["frame"],
        opset_version=18,
        dynamo=False,
        dynamic_axes={"img0": {2: "h", 3: "w"}, "img1": {2: "h", 3: "w"}, "frame": {2: "h", 3: "w"}},
    )


def export_cain(args: argparse.Namespace) -> None:
    sys.path.insert(0, os.path.abspath(args.src))
    from model.cain import CAIN  # noqa: E402

    model = CAIN(depth=3).eval()
    load_state(model, os.path.abspath(args.weights))

    class Wrap(nn.Module):
        def __init__(self, m: nn.Module) -> None:
            super().__init__()
            self.m = m

        def forward(self, x):
            # Порядок как у схемы cain-concat: сначала кадр «до», затем «после».
            out, _ = self.m(x[:, 0:3], x[:, 3:6])
            return out

    wrap = Wrap(model).eval()
    torch.onnx.export(
        wrap,
        (torch.rand(1, 6, 64, 64),),
        args.out,
        input_names=["input"],
        output_names=["frame"],
        opset_version=18,
        dynamo=False,
        dynamic_axes={"input": {2: "h", 3: "w"}, "frame": {2: "h", 3: "w"}},
    )


def main() -> None:
    ap = argparse.ArgumentParser(description="IFRNet/CAIN → ONNX для MoonApp")
    ap.add_argument("--model", choices=["ifrnet", "cain"], required=True)
    ap.add_argument("--weights", required=True, help="путь к *.pth с весами")
    ap.add_argument("--src", required=True, help="папка с исходниками репозитория модели")
    ap.add_argument("--out", required=True, help="куда сохранить .onnx")
    args = ap.parse_args()

    if args.model == "ifrnet":
        export_ifrnet(args)
    else:
        export_cain(args)
    print("ONNX готов:", args.out, round(os.path.getsize(args.out) / 1048576, 1), "МБ")


if __name__ == "__main__":
    main()
