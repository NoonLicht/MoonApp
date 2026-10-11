/**
 * Подпись кода Windows для electron-builder (win.sign в package.json).
 *
 * electron-builder вызывает этот модуль для каждого файла, который нужно подписать
 * (MoonApp.exe, установщик, деинсталлятор). Подпись происходит ВНУТРИ сборки, поэтому
 * хэши в latest.yml и blockmap считаются уже от подписанного файла — автообновление
 * не ломается (подпись «после» сборки сломала бы проверку sha512).
 *
 * Способ выбирается по переменным окружения; если ни один не задан — файл остаётся
 * неподписанным, а сборка проходит как раньше (локальные сборки и форки без секретов).
 *
 *  1) Azure Trusted Signing (рекомендуется: нет файла сертификата, ключ не покидает
 *     Microsoft; для открытых проектов выдаётся быстро):
 *       AZURE_TS_ENDPOINT, AZURE_TS_ACCOUNT, AZURE_TS_PROFILE  + AZURE_TENANT_ID,
 *       AZURE_CLIENT_ID, AZURE_CLIENT_SECRET (служебный принципал)
 *       AZURE_TS_DLIB — путь к Azure.CodeSigning.Dlib.dll (ставит шаг CI)
 *  2) Обычный сертификат .pfx:  WIN_CSC_FILE (путь) + WIN_CSC_KEY_PASSWORD
 *  3) SignPath и другие облачные подписчики подписывают готовый артефакт отдельным
 *     шагом workflow — см. .github/workflows/release.yml.
 *
 * Чистые функции (выбор способа, сборка аргументов) вынесены для тестов.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type SignMethod = "azure" | "pfx" | "none";

export interface SignEnv {
  [k: string]: string | undefined;
}

export function chooseMethod(env: SignEnv): SignMethod {
  if (env.AZURE_TS_ENDPOINT && env.AZURE_TS_ACCOUNT && env.AZURE_TS_PROFILE && env.AZURE_TS_DLIB)
    return "azure";
  if (env.WIN_CSC_FILE && env.WIN_CSC_KEY_PASSWORD) return "pfx";
  return "none";
}

const TIMESTAMP_AZURE = "http://timestamp.acs.microsoft.com";
const TIMESTAMP_PFX = "http://timestamp.digicert.com";

/** Аргументы signtool для файла. Секреты в командной строке не светим там, где этого можно избежать. */
export function buildSignArgs(
  method: Exclude<SignMethod, "none">,
  file: string,
  env: SignEnv,
  metadataPath?: string,
): string[] {
  if (method === "azure") {
    return [
      "sign", "/v", "/fd", "SHA256",
      "/tr", TIMESTAMP_AZURE, "/td", "SHA256",
      "/dlib", env.AZURE_TS_DLIB!, "/dmdf", metadataPath!,
      file,
    ];
  }
  return [
    "sign", "/fd", "SHA256",
    "/tr", TIMESTAMP_PFX, "/td", "SHA256",
    "/f", env.WIN_CSC_FILE!, "/p", env.WIN_CSC_KEY_PASSWORD!,
    file,
  ];
}

/** Файл metadata.json для Azure Trusted Signing dlib. */
export function azureMetadata(env: SignEnv): string {
  return JSON.stringify({
    Endpoint: env.AZURE_TS_ENDPOINT,
    CodeSigningAccountName: env.AZURE_TS_ACCOUNT,
    CertificateProfileName: env.AZURE_TS_PROFILE,
  });
}

function findSigntool(env: SignEnv): string {
  if (env.SIGNTOOL_PATH && fs.existsSync(env.SIGNTOOL_PATH)) return env.SIGNTOOL_PATH;
  return "signtool.exe"; // из PATH (на windows-latest он доступен через Windows SDK)
}

/** Точка входа electron-builder: `sign(configuration)`. */
export default async function sign(configuration: { path: string }): Promise<void> {
  const env = process.env as SignEnv;
  const method = chooseMethod(env);
  const file = configuration.path;
  if (method === "none") {
    console.log(`[sign] ${path.basename(file)}: signing not configured, leaving unsigned`);
    return;
  }
  let metadata: string | undefined;
  try {
    if (method === "azure") {
      metadata = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "moonapp-sign-")), "metadata.json");
      fs.writeFileSync(metadata, azureMetadata(env), "utf8");
    }
    execFileSync(findSigntool(env), buildSignArgs(method, file, env, metadata), {
      stdio: "inherit",
    });
    console.log(`[sign] ${path.basename(file)}: signed (${method})`);
  } finally {
    if (metadata) fs.rmSync(path.dirname(metadata), { recursive: true, force: true });
  }
}

// electron-builder делает require() и берёт module.exports как функцию; ES-экспорт
// default под CommonJS превращается в exports.default, поэтому дублируем явно.
module.exports = sign;
module.exports.default = sign;
module.exports.chooseMethod = chooseMethod;
module.exports.buildSignArgs = buildSignArgs;
module.exports.azureMetadata = azureMetadata;
