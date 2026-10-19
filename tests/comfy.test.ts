import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildGraph, DEFAULTS, isApiGraph, isEditorGraph, missingNodes, PRESETS, TURBO_SIGMAS } from "../src/pages/photo/lib/comfyPresets";

/** ComfyUI во «Фото и видео»: проверка графов, список моделей, безопасность удаления и пресеты. */
const STORAGE = fs.mkdtempSync(path.join(os.tmpdir(), "moonapp-comfy-"));
process.env.MOONAPP_STORAGE = STORAGE;
const req = createRequire(import.meta.url);
/* eslint-disable @typescript-eslint/no-explicit-any */
let assist: any;
let models: any;
let engine: any;

beforeAll(() => {
  assist = req("../server/comfy/assist");
  models = req("../server/comfy/models");
  engine = req("../server/comfy/engine");
});
afterAll(() => {
  try {
    fs.rmSync(STORAGE, { recursive: true, force: true });
  } catch {
    /* не критично */
  }
});

const info: any = {
  CheckpointLoaderSimple: { input: { required: { ckpt_name: [["a.safetensors"]] } }, output: ["MODEL", "CLIP", "VAE"] },
  CLIPTextEncode: { input: { required: { text: ["STRING", {}], clip: ["CLIP", {}] } }, output: ["CONDITIONING"] },
  EmptyLatentImage: { input: { required: { width: ["INT", {}] } }, output: ["LATENT"] },
  SaveImage: { input: { required: { images: ["IMAGE", {}], filename_prefix: ["STRING", {}] } }, output: [] },
  VAEDecode: { input: { required: { samples: ["LATENT", {}], vae: ["VAE", {}] } }, output: ["IMAGE"] },
};

describe("проверка графа помощника", () => {
  const ok = {
    "1": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: "a.safetensors" } },
    "2": { class_type: "CLIPTextEncode", inputs: { text: "cat", clip: ["1", 1] } },
    "3": { class_type: "VAEDecode", inputs: { samples: ["5", 0], vae: ["1", 2] } },
    "4": { class_type: "SaveImage", inputs: { images: ["3", 0], filename_prefix: "x" } },
    "5": { class_type: "EmptyLatentImage", inputs: { width: 512 } },
  };
  it("рабочий граф без замечаний", () => expect(assist.validateGraph(ok, info), JSON.stringify(assist.validateGraph(ok, info))).toEqual([]));
  it("ловит неизвестный узел, пропущенный вход, битую ссылку и отсутствие вывода", () => {
    const bad: any = {
      "1": { class_type: "Nope", inputs: {} },
      "2": { class_type: "CLIPTextEncode", inputs: { text: "x" } },
      "3": { class_type: "VAEDecode", inputs: { samples: ["9", 0], vae: ["1", 7] } },
    };
    const e = assist.validateGraph(bad, info).join("\n");
    expect(e).toMatch(/unknown class_type "Nope"/);
    expect(e).toMatch(/missing required input "clip"/);
    expect(e).toMatch(/links to missing node 9/);
    expect(e).toMatch(/no output node/);
  });
  it("ссылка строкой вместо [id, выход], чужой тип и значение вне списка — замечания", () => {
    const bad: any = {
      "1": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: "nope.safetensors" } },
      "2": { class_type: "CLIPTextEncode", inputs: { text: "x", clip: "1" } },
      "3": { class_type: "VAEDecode", inputs: { samples: ["1", 1], vae: ["1", 2] } },
      "4": { class_type: "SaveImage", inputs: { images: ["3", 0], filename_prefix: "x" } },
    };
    const e = assist.validateGraph(bad, info).join(" ; ");
    expect(e).toMatch(/must be a link .* of type CLIP, not "1"/);
    expect(e).toMatch(/input "samples" needs LATENT but node 1 output 1 is CLIP/);
    expect(e).toMatch(/ckpt_name" value "nope\.safetensors" is not one of \[a\.safetensors\]/);
  });
  it("ссылки-номера чинятся сами: выход выбирается по ожидаемому типу", () => {
    const g: any = {
      "1": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: "a.safetensors" } },
      "2": { class_type: "CLIPTextEncode", inputs: { text: "x", clip: "1" } },
      "3": { class_type: "EmptyLatentImage", inputs: { width: 512 } },
      "4": { class_type: "VAEDecode", inputs: { samples: 3, vae: "node 1" } },
      "5": { class_type: "SaveImage", inputs: { images: "4", filename_prefix: "x" } },
    };
    assist.normalizeGraph(g, info);
    expect(g["2"].inputs.clip).toEqual(["1", 1]);
    expect(g["4"].inputs.samples).toEqual(["3", 0]);
    expect(g["4"].inputs.vae).toEqual(["1", 2]);
    expect(g["5"].inputs.images).toEqual(["4", 0]);
    expect(assist.validateGraph(g, info)).toEqual([]);
  });
  it("динамические входы COMFY_* не считаются обязательными", () => {
    const d: any = { N: { input: { required: { images: ["COMFY_AUTOGROW_V3", {}] } }, output: [] }, SaveImage: info.SaveImage };
    const g: any = { "1": { class_type: "N", inputs: {} }, "2": { class_type: "SaveImage", inputs: { images: ["1", 0], filename_prefix: "x" } } };
    expect(assist.validateGraph(g, d).join()).not.toMatch(/missing required input "images"/);
  });
  it("новый вид выпадающего входа COMBO понимается", () => {
    const v3: any = { Loader: { input: { required: { name: ["COMBO", { options: ["a", "b"] }] } }, output: ["MODEL"] }, SaveImage: info.SaveImage };
    const g = (value: string): any => ({ "1": { class_type: "Loader", inputs: { name: value } }, "2": { class_type: "SaveImage", inputs: { images: ["1", 0], filename_prefix: "x" } } });
    expect(assist.validateGraph(g("a"), v3).join()).not.toMatch(/not one of/);
    expect(assist.validateGraph(g("z"), v3).join()).toMatch(/not one of \[a, b\]/);
  });
  it("не JSON-объект отклоняется", () => {
    expect(assist.validateGraph([], info).length).toBe(1);
    expect(assist.validateGraph({}, info).length).toBe(1);
  });
  it("каталог узлов включает основу и узлы из запроса", () => {
    const text = assist.catalogFor({ ...info, ImageUpscaleWithModel: { input: { required: {} }, output: ["IMAGE"] } }, "upscale the image", undefined);
    expect(text).toMatch(/CheckpointLoaderSimple\(ckpt_name: one of \[a\.safetensors\]\)/);
    expect(text).toMatch(/ImageUpscaleWithModel/);
  });
});

describe("модели ComfyUI", () => {
  it("рекомендуемые модели ведут в известные папки", () => {
    for (const r of models.RECOMMENDED) {
      expect(engine.isModelFolder(r.folder)).toBe(true);
      expect(r.sizeMb).toBeGreaterThan(50);
    }
  });
  it("удаление не выходит за папку и принимает только файлы моделей", () => {
    engine.writeModelPaths();
    const dir = path.join(engine.comfyModelsDir(), "loras");
    fs.writeFileSync(path.join(dir, "a.safetensors"), "x");
    const outside = path.join(engine.comfyModelsDir(), "outside.safetensors");
    fs.writeFileSync(outside, "x");
    expect(models.removeModel("loras", "../outside.safetensors")).toBe(false);
    expect(models.removeModel("loras", "notes.txt")).toBe(false);
    expect(models.removeModel("nope", "a.safetensors")).toBe(false);
    expect(fs.existsSync(outside)).toBe(true);
    expect(models.listModels().map((m: any) => `${m.folder}/${m.file}`)).toContain("loras/a.safetensors");
    expect(models.removeModel("loras", "a.safetensors")).toBe(true);
  });
  it("скачивание отклоняет чужие пути и папки", () => {
    expect(models.startDownload([{ repo: "a/b", rev: "main", file: "../x.safetensors", folder: "vae" }]).ok).toBe(false);
    expect(models.startDownload([{ repo: "a/b", rev: "main", file: "x.safetensors", folder: "etc" }]).ok).toBe(false);
    expect(models.startDownload([{ repo: "no spaces", rev: "main", file: "x.safetensors", folder: "vae" }]).ok).toBe(false);
  });
  it("пути моделей ComfyUI общие с GGUF-папками llama.cpp", () => {
    const yaml = fs.readFileSync(engine.writeModelPaths(), "utf8");
    expect(yaml).toMatch(/diffusion_models: \|/);
    expect(yaml).toMatch(/models\/sd\//);
    expect(yaml).toMatch(/text_encoders: \|/);
    // у VAE формат diffusers (для sd.cpp) не читается ComfyUI — своя папка
    expect(yaml).toMatch(/vae: vae\//);
  });
});

describe("пресеты", () => {
  const ninfo: any = {
    CheckpointLoaderSimple: {}, KSampler: {}, EmptyLatentImage: {}, CLIPTextEncode: {}, VAEDecode: {}, SaveImage: {},
    UnetLoaderGGUF: {}, CLIPLoader: {}, VAELoader: {}, ManualSigmas: {}, KSamplerSelect: {}, RandomNoise: {}, CFGGuider: {}, SamplerCustomAdvanced: {},
    EmptySD3LatentImage: {},
    TextEncodeQwenImage21: {
      input: { required: { clip: ["CLIP", {}], prompt: ["STRING", {}], negative_prompt: ["STRING", {}], resolution: ["INT", { default: 1024 }], images: ["COMFY_AUTOGROW_V3", {}] } },
    },
  };
  const p = { ...DEFAULTS, prompt: "cat", ckpt: "a.safetensors", unet: "q.gguf", clip: "e.safetensors", vae: "v.safetensors", image: "i.png", upscaler: "u.pth" };

  it("каждый пресет собирает граф, в котором все ссылки ведут на существующие узлы", () => {
    for (const d of PRESETS) {
      const g = buildGraph(d.id, p, { ...ninfo, UpscaleModelLoader: {}, ImageUpscaleWithModel: {}, LoadImage: {}, VAEEncode: {} });
      expect(isApiGraph(g)).toBe(true);
      for (const n of Object.values(g))
        for (const v of Object.values(n.inputs))
          if (Array.isArray(v) && v.length === 2 && typeof v[0] === "string") expect(g[v[0]], `${d.id}: ${JSON.stringify(v)}`).toBeTruthy();
      expect(Object.values(g).some((n) => n.class_type === "SaveImage")).toBe(true);
    }
  });
  it("Turbo: восемь шагов — девять сигм, CFG 1; вход энкодера подбирается по типам", () => {
    const g = buildGraph("qwenTurbo", p, ninfo);
    expect(TURBO_SIGMAS.split(",").length).toBe(9);
    expect(Object.values(g).find((n) => n.class_type === "CFGGuider")?.inputs.cfg).toBe(1);
    const enc = Object.values(g).find((n) => n.class_type === "TextEncodeQwenImage21")?.inputs as any;
    expect(enc.prompt).toBe("cat");
    expect(enc.resolution).toBe(1024);
    expect(enc.clip).toEqual(["2", 0]);
    expect("images" in enc).toBe(false);
  });
  it("GGUF-энкодер берёт CLIPLoaderGGUF, если узел есть", () => {
    const g = buildGraph("qwen", { ...p, clip: "enc.gguf" }, { ...ninfo, CLIPLoaderGGUF: {} });
    expect(g["2"].class_type).toBe("CLIPLoaderGGUF");
  });
  it("нехватка узлов определяется", () => {
    expect(missingNodes(PRESETS.find((x) => x.id === "qwen")!, { KSampler: {} } as any).length).toBeGreaterThan(0);
  });
  it("различает API-формат и граф редактора", () => {
    expect(isEditorGraph({ nodes: [], links: [] })).toBe(true);
    expect(isApiGraph({ nodes: [], links: [] })).toBe(false);
    expect(isApiGraph({ "1": { class_type: "X", inputs: {} } })).toBe(true);
  });
});
