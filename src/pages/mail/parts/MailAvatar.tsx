import { useEffect, useState } from "react";
import { api } from "@/api/client";
import { initials } from "@/pages/mail/parts/mailUtil";

const cache = new Map<string, string | null>();
const pending = new Map<string, Promise<string | null>>();

function load(address: string): Promise<string | null> {
  const key = address.toLowerCase();
  if (cache.has(key)) return Promise.resolve(cache.get(key) ?? null);
  const p =
    pending.get(key) ??
    api.mailAvatar(key).then((u) => {
      cache.set(key, u);
      pending.delete(key);
      return u;
    });
  pending.set(key, p);
  return p;
}

function hue(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h % 360;
}

/** Аватар контакта: буквы на цветном фоне или Gravatar (через сервер приложения). */
export function MailAvatar({
  address,
  name,
  size = 32,
  mode,
}: {
  address: string;
  name?: string;
  size?: number;
  mode: "initials" | "gravatar" | "off";
}) {
  const [src, setSrc] = useState<string | null>(cache.get(address.toLowerCase()) ?? null);

  useEffect(() => {
    if (mode !== "gravatar" || !address) return;
    let live = true;
    void load(address).then((u) => live && setSrc(u));
    return () => {
      live = false;
    };
  }, [address, mode]);

  if (mode === "off") return null;
  const label = name || address;
  const h = hue(address.toLowerCase());
  return (
    <span
      className="mail-avatar"
      style={{
        width: size,
        height: size,
        fontSize: Math.round(size * 0.38),
        background: src ? "transparent" : `hsl(${h} 55% 42%)`,
        color: "#fff",
      }}
      aria-hidden
    >
      {src ? <img src={src} alt="" width={size} height={size} /> : initials(label)}
    </span>
  );
}
