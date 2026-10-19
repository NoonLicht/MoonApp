import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildGraph, DEFAULTS } from "../src/pages/photo/comfy/presets";

/** Настройки запуска ComfyUI, обновление, узлы с GitHub и расширения пресетов (LoRA, свой VAE, плитки). */
const STORAGE = fs.mkdtempSync(path.join(os.tmpdir(), "moonapp-comfyadm-"));
process.env.MOONAPP_STORAGE = STORAGE;
const req = createRequire(import.meta.url);
/* eslint-disable @typescript-eslint/no-explicit-any */
let rt: any;
let mt: any;

beforeAll(() => {
  rt = req("../server/comfy/runtime");
  mt = req("../server/comfy/maintenance");
});
afterAll(() => {
  try {
    fs.rmSync(STORAGE, { recursive: true, force: true });
  } catch {
    /* не критично */
  }
});

describe("настройки запуска → ключи ComfyUI", () => {
  it("по умолчанию отключены только платные узлы", () => {
    expect(rt.buildRunArgs(rt.DEFAULT_RUN)).toEqual(["--disable-partner-nodes"]);
  });

  it("денойзер в видеопамяти, VAE на процессоре, свежие ключи памяти", () => {
    const s = rt.sanitize({ memory: "low", cpuVae: true, reserveVramGb: 0.6, smartMemory: false, asyncOffload: "on", cache: "none" });
    const a = rt.buildRunArgs(s);
    for (const k of ["--lowvram", "--cpu-vae", "--disable-smart-memory", "--async-offload", "--cache-none"]) expect(a).toContain(k);
    expect(a.slice(a.indexOf("--reserve-vram"), a.indexOf("--reserve-vram") + 2)).toEqual(["--reserve-vram", "0.6"]);
  });

  it("точность и внимание", () => {
    const a = rt.buildRunArgs(rt.sanitize({ unet: "fp8_e4m3fn", vae: "bf16", textEnc: "fp16", attention: "sage", preview: "taesd" }));
    expect(a).toEqual(expect.arrayContaining(["--fp8_e4m3fn-unet", "--bf16-vae", "--fp16-text-enc", "--use-sage-attention", "--preview-method", "taesd"]));
    expect(rt.buildRunArgs(rt.sanitize({ attention: "pytorch" }))).toContain("--use-pytorch-cross-attention");
  });

  it("менеджер включается ключом только когда он установлен", () => {
    const s = rt.sanitize({ manager: true });
    expect(rt.buildRunArgs(s)).not.toContain("--enable-manager");
    expect(rt.buildRunArgs(s, { managerReady: true })).toContain("--enable-manager");
  });

  it("неизвестные значения отбрасываются, числа ограничиваются", () => {
    const s = rt.sanitize({ memory: "rm -rf", unet: "x", reserveVramGb: 9999, cacheLru: -5, cudaDevice: "0; calc", cpuVae: "yes" });
    expect(s.memory).toBe("auto");
    expect(s.unet).toBe("auto");
    expect(s.reserveVramGb).toBe(64);
    expect(s.cacheLru).toBe(1);
    expect(s.cudaDevice).toBe("");
    expect(s.cpuVae).toBe(false);
    expect(rt.sanitize({ cudaDevice: "0,1" }).cudaDevice).toBe("0,1");
  });

  it("свои ключи: сетевые и путевые игнорируются вместе со значением, мусор — тоже", () => {
    const a = rt.parseExtraArgs('--listen 0.0.0.0 --port 80 --verbose --foo=bar "x" --base-directory C:/x --cache-lru 4; calc --use-flash-attention');
    expect(a).toEqual(["--verbose", "--foo=bar", "--cache-lru", "--use-flash-attention"]);
    expect(rt.parseExtraArgs("--reserve-vram 2")).toEqual(["--reserve-vram", "2"]);
    expect(rt.parseExtraArgs("rm -rf /")).toEqual([]);
  });

  it("настройки сохраняются на диск и читаются обратно", () => {
    expect(rt.readRunSettings().memory).toBe("auto");
    rt.writeRunSettings({ memory: "none", cpuVae: true });
    const r = rt.readRunSettings();
    expect(r.memory).toBe("none");
    expect(r.cpuVae).toBe(true);
    // частичное обновление не сбрасывает остальное
    rt.writeRunSettings({ fast: true });
    expect(rt.readRunSettings().memory).toBe("none");
    expect(rt.readRunSettings().fast).toBe(true);
  });
});

describe("версии и адреса GitHub", () => {
  it("сравнение версий по числам", () => {
    expect(mt.isNewer("0.43.0", "0.42.1")).toBe(true);
    expect(mt.isNewer("0.42.1", "0.42.1")).toBe(false);
    expect(mt.isNewer("0.9.0", "0.10.0")).toBe(false);
    expect(mt.isNewer("1.0", "0.99.9")).toBe(true);
  });

  it("принимается только https://github.com/владелец/репозиторий", () => {
    expect(mt.parseGithub("https://github.com/ltdrdata/ComfyUI-Manager")).toEqual({ owner: "ltdrdata", repo: "ComfyUI-Manager", branch: "" });
    expect(mt.parseGithub("https://github.com/a/b.git")).toEqual({ owner: "a", repo: "b", branch: "" });
    expect(mt.parseGithub("https://github.com/a/b/tree/dev")).toEqual({ owner: "a", repo: "b", branch: "dev" });
    for (const bad of ["http://github.com/a/b", "https://evil.com/a/b", "https://github.com/a", "https://github.com/../b", "https://github.com/a/b/../../c", "git@github.com:a/b.git", ""]) {
      expect(mt.parseGithub(bad), bad).toBe(null);
    }
  });

  it("имя папки узла очищается от лишнего", () => {
    expect(mt.nodeDirName("Comfy UI/..x")).toBe("Comfy_UI_..x");
  });

  it("каналы обновления", () => {
    expect(mt.isChannel("stable")).toBe(true);
    expect(mt.isChannel("latest")).toBe(true);
    expect(mt.isChannel("nightly")).toBe(false);
  });

  it("без установки ComfyUI обновление, менеджер и узлы отклоняются", () => {
    expect(mt.updateComfy("stable")).toEqual({ ok: false, error: "not_installed" });
    expect(mt.installManager()).toEqual({ ok: false, error: "not_installed" });
    expect(mt.installNode("https://github.com/a/b")).toEqual({ ok: false, error: "not_installed" });
    expect(mt.listNodes()).toEqual([]);
    expect(mt.removeNode("x")).toBe(false);
  });
});

describe("пресеты: LoRA, свой VAE, пропуск CLIP, плитки", () => {
  const info: any = {
    LoraLoader: {},
    LoraLoaderModelOnly: {},
    CLIPSetLastLayer: {},
    VAEDecodeTiled: { input: { required: { samples: ["LATENT"], vae: ["VAE"], tile_size: ["INT", { default: 512 }], overlap: ["INT", { default: 64 }] } } },
  };
  const base = { ...DEFAULTS, ckpt: "a.safetensors", prompt: "cat" };

  it("стопка LoRA цепляется по порядку, CLIP идёт через последнюю", () => {
    const g: any = buildGraph(
      "txt2img",
      { ...base, loras: [{ name: "one.safetensors", strength: 0.8, clip: 0.5 }, { name: "two.safetensors", strength: 1, clip: 1 }] },
      info,
    );
    expect(g.lora0.class_type).toBe("LoraLoader");
    expect(g.lora0.inputs).toMatchObject({ model: ["1", 0], clip: ["1", 1], lora_name: "one.safetensors", strength_model: 0.8, strength_clip: 0.5 });
    expect(g.lora1.inputs).toMatchObject({ model: ["lora0", 0], clip: ["lora0", 1] });
    expect(g["6"].inputs.model).toEqual(["lora1", 0]);
    expect(g["2"].inputs.clip).toEqual(["lora1", 1]);
  });

  it("пустые строки LoRA пропускаются", () => {
    const g: any = buildGraph("txt2img", { ...base, loras: [{ name: "", strength: 1, clip: 1 }] }, info);
    expect(g.lora0).toBeUndefined();
    expect(g["6"].inputs.model).toEqual(["1", 0]);
  });

  it("свой VAE подменяет вшитый и в декодировании, и в кодировании", () => {
    const g: any = buildGraph("img2img", { ...base, image: "x.png", vae: "my.safetensors" }, info);
    expect(g["11"]).toMatchObject({ class_type: "VAELoader", inputs: { vae_name: "my.safetensors" } });
    expect(g["7"].inputs.vae).toEqual(["11", 0]);
    expect(g["5"].inputs.vae).toEqual(["11", 0]);
    const plain: any = buildGraph("txt2img", base, info);
    expect(plain["7"].inputs.vae).toEqual(["1", 2]);
  });

  it("пропуск слоёв CLIP и декодирование плитками", () => {
    const g: any = buildGraph("txt2img", { ...base, clipSkip: 2, vaeTiled: true }, info);
    expect(g["12"]).toMatchObject({ class_type: "CLIPSetLastLayer", inputs: { stop_at_clip_layer: -2 } });
    expect(g["2"].inputs.clip).toEqual(["12", 0]);
    expect(g["7"].class_type).toBe("VAEDecodeTiled");
    expect(g["7"].inputs).toMatchObject({ tile_size: 512, overlap: 64 });
  });

  it("без узла плиточного VAE остаётся обычное декодирование", () => {
    const g: any = buildGraph("txt2img", { ...base, vaeTiled: true }, { ...info, VAEDecodeTiled: undefined });
    expect(g["7"].class_type).toBe("VAEDecode");
  });

  it("Qwen: LoRA только на денойзер, энкодер на процессоре", () => {
    const qinfo: any = { ...info, UnetLoaderGGUF: {}, CLIPLoader: {}, VAELoader: {}, TextEncodeQwenImage21: { input: { required: {} } }, KSampler: {} };
    const g: any = buildGraph(
      "qwen",
      { ...base, unet: "q.gguf", clip: "c.safetensors", vae: "v.safetensors", clipDevice: "cpu", loras: [{ name: "l.safetensors", strength: 0.7, clip: 1 }] },
      qinfo,
    );
    expect(g.lora0.class_type).toBe("LoraLoaderModelOnly");
    expect(g.lora0.inputs).toMatchObject({ model: ["1", 0], strength: 0.7 });
    expect(g["7"].inputs.model).toEqual(["lora0", 0]);
    expect(g["2"].inputs.device).toBe("cpu");
  });
});
