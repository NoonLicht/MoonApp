import { useEffect, useRef, type ReactNode } from "react";
import { animate, motion, useMotionValue, useSpring, useTransform } from "motion/react";

const MAX_PULL = 90;

/**
 * Прокручиваемое тело экрана в предпросмотре, как на телефоне:
 * у краёв контент резиново растягивается и пружинит назад, во время быстрой прокрутки слегка
 * «течёт» (наклон по скорости), а блоки, до которых ещё не доехали, вплывают с отскоком.
 */
export function ScrollBody({
  length,
  reduced,
  children,
}: {
  length: number;
  reduced?: boolean;
  children: ReactNode;
}) {
  const box = useRef<HTMLDivElement | null>(null);
  const pull = useMotionValue(0);
  const spring = useSpring(pull, { stiffness: 380, damping: 26, mass: 0.6 });
  const lean = useMotionValue(0);
  const leanSpring = useSpring(lean, { stiffness: 260, damping: 22 });
  const scaleY = useTransform(spring, (v) => 1 + Math.abs(v) / 900);
  const y = useTransform(spring, (v) => v * 0.5);
  const origin = useTransform(spring, (v) => (v > 0 ? "50% 0%" : "50% 100%"));
  const skew = useTransform(leanSpring, (v) => Math.max(-1.6, Math.min(1.6, v)));

  useEffect(() => {
    const el = box.current;
    if (!el || reduced) return;
    let idle = 0;
    let last = el.scrollTop;
    let lastT = performance.now();
    const release = () => {
      window.clearTimeout(idle);
      idle = window.setTimeout(
        () => animate(pull, 0, { type: "spring", stiffness: 320, damping: 18 }),
        90,
      );
    };
    const atTop = () => el.scrollTop <= 0;
    const atBottom = () => el.scrollTop + el.clientHeight >= el.scrollHeight - 1;
    const onWheel = (e: WheelEvent) => {
      if ((e.deltaY < 0 && atTop()) || (e.deltaY > 0 && atBottom())) {
        const next = pull.get() - e.deltaY * 0.35;
        pull.set(Math.max(-MAX_PULL, Math.min(MAX_PULL, next)));
        release();
      }
    };
    let startY = 0;
    let startTop = 0;
    const onDown = (e: PointerEvent) => {
      startY = e.clientY;
      startTop = el.scrollTop;
    };
    const onMove = (e: PointerEvent) => {
      if (e.buttons === 0 || e.pointerType === "mouse") return;
      const dy = e.clientY - startY;
      if ((dy > 0 && atTop() && startTop <= 0) || (dy < 0 && atBottom())) {
        pull.set(Math.max(-MAX_PULL, Math.min(MAX_PULL, dy * 0.45)));
      }
    };
    const onUp = () => animate(pull, 0, { type: "spring", stiffness: 320, damping: 18 });
    const onScroll = () => {
      const now = performance.now();
      const v = ((el.scrollTop - last) / Math.max(1, now - lastT)) * 16;
      last = el.scrollTop;
      lastT = now;
      lean.set(v * 0.25);
      window.clearTimeout(idle);
      idle = window.setTimeout(() => lean.set(0), 80);
    };
    el.addEventListener("wheel", onWheel, { passive: true });
    el.addEventListener("pointerdown", onDown);
    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerup", onUp);
    el.addEventListener("pointercancel", onUp);
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      window.clearTimeout(idle);
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("pointerdown", onDown);
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerup", onUp);
      el.removeEventListener("pointercancel", onUp);
      el.removeEventListener("scroll", onScroll);
    };
  }, [reduced, pull, lean]);

  /* блоки, лежащие ниже видимой части, вплывают, когда до них доезжают; уже видимые не трогаем */
  useEffect(() => {
    const el = box.current;
    const inner = el?.firstElementChild;
    if (!el || !inner || reduced || typeof IntersectionObserver === "undefined") return;
    const kids = Array.from(inner.children) as HTMLElement[];
    const io = new IntersectionObserver(
      (entries, obs) => {
        for (const en of entries) {
          const k = en.target as HTMLElement;
          if (!en.isIntersecting) continue;
          k.dataset.seen = "1";
          obs.unobserve(k);
        }
      },
      { root: el, threshold: 0.05 },
    );
    const viewH = el.clientHeight;
    kids.forEach((k, i) => {
      if (k.offsetTop > viewH * 0.9) {
        k.dataset.reveal = "1";
        k.style.setProperty("--m3e-i", String(i % 4));
        io.observe(k);
      }
    });
    return () => {
      io.disconnect();
      kids.forEach((k) => {
        delete k.dataset.reveal;
        delete k.dataset.seen;
      });
    };
  }, [reduced, length]);

  return (
    <div
      ref={box}
      data-scroll-body
      className="m3-hidden-scrollbar m3e-sbody"
      style={{
        position: "absolute",
        inset: 0,
        overflowX: "hidden",
        overflowY: "auto",
        overscrollBehavior: "contain",
        touchAction: "pan-y",
      }}
    >
      <motion.div
        style={{
          position: "relative",
          height: length,
          scaleY,
          y,
          skewY: skew,
          transformOrigin: origin,
        }}
      >
        {children}
      </motion.div>
    </div>
  );
}
