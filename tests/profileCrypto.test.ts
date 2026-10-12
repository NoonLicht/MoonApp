import { describe, it, expect } from "vitest";
import { encryptProfile, decryptProfile, isEncryptedProfile } from "../src/lib/profileCrypto";

/** Зашифрованный профиль (src/lib/profileCrypto.ts). Малое число итераций — для скорости тестов. */
const ITER = 2000;

describe("profileCrypto", () => {
  it("шифрует и расшифровывает, включая кириллицу", async () => {
    const plain = JSON.stringify({ settings: { тема: "тёмная" }, secrets: { openai: "sk-test" } });
    const file = await encryptProfile(plain, "пароль-123", ITER);
    expect(file).not.toContain("sk-test");
    expect(isEncryptedProfile(file)).toBe(true);
    expect(await decryptProfile(file, "пароль-123")).toBe(plain);
  });

  it("неверный пароль и порча данных дают одну ошибку", async () => {
    const file = await encryptProfile("секрет", "правильный", ITER);
    await expect(decryptProfile(file, "неправильный")).rejects.toThrow("wrong_password_or_corrupted");
    const env = JSON.parse(file);
    env.data = env.data.slice(0, -4) + "AAAA";
    await expect(decryptProfile(JSON.stringify(env), "правильный")).rejects.toThrow(
      "wrong_password_or_corrupted",
    );
  });

  it("каждый раз разная соль и вектор", async () => {
    const a = JSON.parse(await encryptProfile("x", "123456", ITER));
    const b = JSON.parse(await encryptProfile("x", "123456", ITER));
    expect(a.salt).not.toBe(b.salt);
    expect(a.iv).not.toBe(b.iv);
  });

  it("короткий пароль и чужой файл отвергаются", async () => {
    await expect(encryptProfile("x", "123", ITER)).rejects.toThrow("password_too_short");
    await expect(decryptProfile("{}", "123456")).rejects.toThrow("not_a_profile");
    await expect(decryptProfile("не json", "123456")).rejects.toThrow("not_a_profile");
    expect(isEncryptedProfile("{}")).toBe(false);
  });

  it("файл с чрезмерным числом итераций не разбирается", async () => {
    const env = JSON.parse(await encryptProfile("x", "123456", ITER));
    env.iter = 50_000_000;
    await expect(decryptProfile(JSON.stringify(env), "123456")).rejects.toThrow("not_a_profile");
  });
});
