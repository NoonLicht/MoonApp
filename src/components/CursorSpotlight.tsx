import { useEffect, useRef, useState } from "react";
import { api } from "@/api/client";

/**
 * Подсветка курсора для презентаций и записи экрана: мягкий круг следует за
 * указателем, а клик отмечается расходящимся кольцом. Включается настройкой
 * appearance.cursorHighlight; в выключенном состоянии ничего не слушает.
 */
export default function CursorSpotlight() {
  const [on, setOn] = useState(false);
  const dot = useRef<HTMLDivElement>(null);
  const [rings, setRings] = useState<{ id: number; x: number; y: number }[]>([]);

  useEffect(() => {
    api
      .getSettings()
      .then((s) => setOn(!!(s as { appearance?: { cursorHighlight?: boolean } })?.appearance?.cursorHighlight))
      .catch(() => undefined);
    const onSetting = (e: Event) => {
      const { path, value } = (e as CustomEvent<{ path: string; value: unknown }>).detail || {};
      if (path === "appearance.cursorHighlight") setOn(!!value);
    };
    window.addEventListener("app:setting", onSetting);
    return () => window.removeEventListener("app:setting", onSetting);
  }, []);

  useEffect(() => {
    if (!on) return;
    let raf = 0;
    let x = -100;
    let y = -100;
    const move = (e: MouseEvent) => {
      x = e.clientX;
      y = e.clientY;
      if (!raf) {
        raf = requestAnimationFrame(() => {
          raf = 0;
          if (dot.current) dot.current.style.transform = `translate(${x - 28}px, ${y - 28}px)`;
        });
      }
    };
    let n = 0;
    const down = (e: MouseEvent) => {
      const id = ++n;
      setRings((r) => [...r.slice(-4), { id, x: e.clientX, y: e.clientY }]);
      setTimeout(() => setRings((r) => r.filter((q) => q.id !== id)), 500);
    };
    window.addEventListener("mousemove", move, { passive: true });
    window.addEventListener("mousedown", down, { passive: true });
    return () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mousedown", down);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [on]);

  if (!on) return null;
  return (
    <div
      aria-hidden="true"
      style={{ position: "fixed", inset: 0, pointerEvents: "none", zIndex: 2147483000 }}
    >
      <div
        ref={dot}
        style={{
          position: "absolute",
          width: 56,
          height: 56,
          borderRadius: "50%",
          background: "radial-gradient(circle, rgba(255,214,64,0.38) 0%, rgba(255,214,64,0.16) 60%, transparent 72%)",
          border: "2px solid rgba(255,214,64,0.65)",
          transform: "translate(-100px, -100px)",
        }}
      />
      {rings.map((r) => (
        <div
          key={r.id}
          style={{
            position: "absolute",
            left: r.x - 8,
            top: r.y - 8,
            width: 16,
            height: 16,
            borderRadius: "50%",
            border: "3px solid rgba(255,90,60,0.85)",
            animation: "cursor-ring 0.5s ease-out forwards",
          }}
        />
      ))}
      <style>{`@keyframes cursor-ring{from{transform:scale(1);opacity:1}to{transform:scale(4.5);opacity:0}}`}</style>
    </div>
  );
}
