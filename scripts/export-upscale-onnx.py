"""
Экспорт апскейлеров Real-CUGAN и Real-ESRGAN Compact в ONNX для каталога апскейла.

Зачем инструмент: в открытом доступе лежат только PyTorch-веса, а движок апскейла
(`server/ts/upscale.ts`) работает на ONNX Runtime. Скрипт конвертирует официальные
веса в графы с динамическими H/W, которые движок уже понимает.

  * Real-CUGAN (`bilibili/ailab`, MIT) — `upcunet_v3.py` даёт три сети (2x/3x/4x),
    а пресеты шума задаются весами (`-no-denoise`, `-conservative`, `-denoise3x`).
    Оригинальный `forward` содержит ветки tile/cache, которые ONNX не трассирует,
    поэтому сети оборачиваются в «плоский» путь (tile_mode=0) с фиксированными
    reflect-паддингами: так граф статичен по структуре и динамичен по размеру.
    Отрицательные `F.pad` (это кроп) заменяются срезом — DirectML не умеет
    отрицательный Pad.
  * Real-ESRGAN Compact (`realesr-animevideov3.pth`) — компактная сеть для видео:
    SRVGGNetCompact (64 канала, 16 конв.), 4×. Архитектура описана прямо здесь,
    внешние исходники не нужны; число слоёв берётся из state dict.

Подготовка (один раз):
    git clone --depth 1 https://github.com/bilibili/ailab  # нужен Real-CUGAN/upcunet_v3.py
    # веса Real-CUGAN: ассет updated_weights.zip релиза Real-CUGAN
    # веса compact: https://github.com/xinntao/Real-ESRGAN/releases/download/v0.2.5.0/realesr-animevideov3.pth

Запуск:
    python scripts/export-upscale-onnx.py --model cugan --scale 2 --weights up2x-latest-denoise3x.pth \
        --src ailab/Real-CUGAN --out cugan-2x-denoise3x.onnx
    python scripts/export-upscale-onnx.py --model cugan --scale 4 --weights up4x-latest-conservative.pth \
        --src ailab/Real-CUGAN --out cugan-4x-conservative.onnx
    python scripts/export-upscale-onnx.py --model esrgan-compact --weights realesr-animevideov3.pth \
        --out realesr-compact-x4.onnx

Проверить результат: `node scripts/verify-model.js --url <URL> --id <ид>` (скачает,
сверит sha256 и прогонит реальный инференс через движок приложения).
"""

import argparse
import os
import sys

import torch
import torch.nn as nn
import torch.nn.functional as F

# Оригинал использует отрицательный pad как кроп; DirectML такого не умеет —
# подменяем на эквивалентный срез, чтобы в граф ушёл Slice.
_original_pad = F.pad


def _pad_or_crop(tensor, pad, mode="constant", value=None):
    if mode == "constant" and all(amount <= 0 for amount in pad) and any(a < 0 for a in pad):
        index = [slice(None)] * tensor.dim()
        for i in range(len(pad) // 2):
            begin, end = pad[2 * i], pad[2 * i + 1]
            index[tensor.dim() - 1 - i] = slice(-begin or None, end or None)
        return tensor[tuple(index)]
    return _original_pad(tensor, pad, mode=mode, value=value)


F.pad = _pad_or_crop


# --- Real-CUGAN -------------------------------------------------------------


class Cugan2x(nn.Module):
    """2× путь UpCunet2x без веток tile/cache.

    Внутри UNet1 есть down/up-семплинг, поэтому вход должен быть чётным: движок
    выравнивает тайл (поле `align` в каталоге) и обрезает результат.
    """

    def __init__(self, base: nn.Module) -> None:
        super().__init__()
        self.unet1, self.unet2 = base.unet1, base.unet2

    def forward(self, x):
        x = F.pad(x, (18, 18, 18, 18), "reflect")
        body = self.unet1(x)
        head = self.unet2(body, 1.0)
        return torch.add(head, F.pad(body, (-20, -20, -20, -20)))


class Cugan3x(nn.Module):
    """3× путь UpCunet3x."""

    def __init__(self, base: nn.Module) -> None:
        super().__init__()
        self.unet1, self.unet2 = base.unet1, base.unet2

    def forward(self, x):
        x = F.pad(x, (14, 14, 14, 14), "reflect")
        body = self.unet1(x)
        head = self.unet2(body, 1.0)
        return torch.add(head, F.pad(body, (-20, -20, -20, -20)))


class Cugan4x(nn.Module):
    """4× путь UpCunet4x: пиксель-шафл и остаточная ветка nearest."""

    def __init__(self, base: nn.Module) -> None:
        super().__init__()
        self.unet1, self.unet2 = base.unet1, base.unet2
        self.ps, self.conv_final = base.ps, base.conv_final

    def forward(self, x):
        base = x
        body = self.unet1(F.pad(x, (19, 19, 19, 19), "reflect"))
        head = self.unet2(body, 1.0)
        x = self.conv_final(torch.add(head, F.pad(body, (-20, -20, -20, -20))))
        x = self.ps(F.pad(x, (-1, -1, -1, -1)))
        return x + F.interpolate(base, scale_factor=4, mode="nearest")


CUGAN = {2: (Cugan2x, "UpCunet2x"), 3: (Cugan3x, "UpCunet3x"), 4: (Cugan4x, "UpCunet4x")}


# --- Real-ESRGAN Compact ----------------------------------------------------


class SRVGGNetCompact(nn.Module):
    """Архитектура `realesr-animevideov3` (basicsr): тело conv+PReLU и PixelShuffle."""

    def __init__(self, num_feat: int, num_conv: int, upscale: int) -> None:
        super().__init__()
        self.upscale = upscale
        body: list[nn.Module] = [nn.Conv2d(3, num_feat, 3, 1, 1), nn.PReLU(num_feat)]
        for _ in range(num_conv):
            body += [nn.Conv2d(num_feat, num_feat, 3, 1, 1), nn.PReLU(num_feat)]
        body += [nn.Conv2d(num_feat, 3 * upscale * upscale, 3, 1, 1), nn.PixelShuffle(upscale)]
        self.body = nn.Sequential(*body)

    def forward(self, x):
        return self.body(x) + F.interpolate(x, scale_factor=self.upscale, mode="nearest")


def unwrap_state(path: str) -> dict:
    """Снять обёртку чекпоинта (`params`/`state_dict`) и префикс DataParallel."""
    state = torch.load(os.path.abspath(path), map_location="cpu", weights_only=True)
    for key in ("params", "state_dict", "params_ema"):
        if isinstance(state, dict) and key in state and isinstance(state[key], dict):
            state = state[key]
            break
    return {k.replace("module.", "", 1): v for k, v in state.items()}


def export_summary(path: str, scale: int) -> None:
    print(f"  OK  {os.path.basename(path)}  x{scale}  {os.path.getsize(path) / 1048576:.2f} MB")


def export_cugan(args: argparse.Namespace) -> None:
    sys.path.insert(0, os.path.abspath(args.src))
    import upcunet_v3  # noqa: E402

    wrap_cls, base_name = CUGAN[args.scale]
    base = getattr(upcunet_v3, base_name)(in_channels=3, out_channels=3)
    state = unwrap_state(args.weights)
    base.load_state_dict(state, strict=True)
    model = wrap_cls(base).eval()
    dummy = torch.randn(1, 3, 64, 64)
    with torch.no_grad():
        out = model(dummy)
    torch.onnx.export(
        model,
        (dummy,),
        args.out,
        input_names=["input"],
        output_names=["output"],
        opset_version=17,
        dynamo=False,
        dynamic_axes={
            "input": {0: "batch", 2: "height", 3: "width"},
            "output": {0: "batch", 2: "height", 3: "width"},
        },
    )
    print(f"  dummy 64x64 -> {tuple(out.shape)[2:]}")
    export_summary(args.out, args.scale)


def export_compact(args: argparse.Namespace) -> None:
    state = unwrap_state(args.weights)
    keys = [k for k in state if k.startswith("body.") and k.endswith(".weight")]
    num_feat = state["body.0.weight"].shape[0]
    # Тело: один входной conv + num_conv пар (conv + PReLU) + выходной conv.
    last = max(int(k.split(".")[1]) for k in keys)
    num_conv = (last - 2) // 2
    model = SRVGGNetCompact(num_feat, num_conv, args.scale).eval()
    model.load_state_dict(state, strict=True)
    dummy = torch.randn(1, 3, 64, 64)
    torch.onnx.export(
        model,
        (dummy,),
        args.out,
        input_names=["input"],
        output_names=["output"],
        opset_version=17,
        dynamo=False,
        dynamic_axes={
            "input": {0: "batch", 2: "height", 3: "width"},
            "output": {0: "batch", 2: "height", 3: "width"},
        },
    )
    print(f"  num_feat={num_feat} num_conv={num_conv}")
    export_summary(args.out, args.scale)


def wrap_fp32(args: argparse.Namespace) -> None:
    """Обернуть fp16-граф в fp32-интерфейс: Cast на входе и на выходе.

    ONNX Runtime (в частности сборка onnxruntime-node 1.30) отказывается принимать
    fp16-тензоры из JS — «Tensor.data must be a typed array (4 or Float16Array)».
    Поэтому fp16-модели (экспорты rigaya, kato-megumi и подобные) переупаковываются:
    снаружи граф становится float32, внутри остаётся fp16 (веса не пересчитываются,
    точность та же).
    """

    import onnx
    from onnx import TensorProto, helper

    model = onnx.load(os.path.abspath(args.weights))
    graph = model.graph
    inp = graph.input[0]
    out = graph.output[0]

    def retype(src, name: str, dtype: int):
        """Копия value_info с другим именем и типом (форма сохраняется как была)."""
        vi = onnx.ValueInfoProto()
        vi.CopyFrom(src)
        vi.name = name
        vi.type.tensor_type.elem_type = dtype
        return vi

    half_in_name = inp.name + "__fp16"
    half_out_name = out.name + "__fp16"

    # Оригинальные узлы переводим на fp16-ветку: потребители входа — на
    # `input__fp16`, производитель выхода — на `output__fp16`.
    for node in graph.node:
        for i, name in enumerate(node.input):
            if name == inp.name:
                node.input[i] = half_in_name
        for i, name in enumerate(node.output):
            if name == out.name:
                node.output[i] = half_out_name

    cast_in = helper.make_node("Cast", [inp.name], [half_in_name], to=TensorProto.FLOAT16)
    cast_out = helper.make_node("Cast", [half_out_name], [out.name], to=TensorProto.FLOAT)

    # Снаружи имена входов/выходов не меняются (движку ничего править не нужно),
    # меняется только их тип: было fp16, стало fp32. Промежуточные fp16-имена —
    # это value_info, а не вход/выход графа (иначе ONNX-чекер ругается на SSA).
    f32_in = retype(inp, inp.name, TensorProto.FLOAT)
    f32_out = retype(out, out.name, TensorProto.FLOAT)
    half_in = retype(inp, half_in_name, TensorProto.FLOAT16)
    half_out = retype(out, half_out_name, TensorProto.FLOAT16)

    graph.input.remove(inp)
    graph.input.append(f32_in)
    graph.output.remove(out)
    graph.output.append(f32_out)
    graph.value_info.extend([half_in, half_out])
    # Cast на входе — до всех узлов; на выходе — сразу после узла, который
    # производит результат (порядок узлов должен остаться топологическим).
    graph.node.insert(0, cast_in)
    producer = next(
        (i for i, n in enumerate(graph.node) if half_out_name in n.output), len(graph.node) - 1
    )
    graph.node.insert(producer + 1, cast_out)

    onnx.checker.check_model(model)
    onnx.save(model, args.out)
    print(f"  fp16 -> fp32 interface: {os.path.basename(args.weights)} -> {os.path.basename(args.out)}")
    export_summary(args.out, args.scale)


def main() -> None:
    ap = argparse.ArgumentParser(description="Real-CUGAN / Real-ESRGAN Compact → ONNX для MoonApp")
    ap.add_argument("--model", choices=["cugan", "esrgan-compact", "fp32-wrap"], required=True)
    ap.add_argument("--weights", required=True, help="путь к *.pth (или *.onnx для fp32-wrap)")
    ap.add_argument("--out", required=True, help="куда сохранить .onnx")
    ap.add_argument("--scale", type=int, default=4, help="множитель (2/3/4)")
    ap.add_argument("--src", help="папка Real-CUGAN (нужна для --model cugan)")
    args = ap.parse_args()

    if args.model == "cugan" and not args.src:
        ap.error("--src обязателен для --model cugan")
    if args.model == "cugan":
        export_cugan(args)
    elif args.model == "esrgan-compact":
        export_compact(args)
    else:
        wrap_fp32(args)


if __name__ == "__main__":
    main()

