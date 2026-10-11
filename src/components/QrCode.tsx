import { useMemo } from "react";
import qrcode from "qrcode-generator";

/**
 * QR-код как SVG (без внешних сервисов и без innerHTML). Данные кодируются в браузере,
 * наружу ничего не уходит. Светлая подложка — чтобы код читался и в тёмной теме.
 */
export default function QrCode({ text, size = 168 }: { text: string; size?: number }) {
  const { count, dark } = useMemo(() => {
    const qr = qrcode(0, "M");
    qr.addData(text);
    qr.make();
    const n = qr.getModuleCount();
    const cells: [number, number][] = [];
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) cells.push([c, r]);
    return { count: n, dark: cells };
  }, [text]);
  const quiet = 3;
  const total = count + quiet * 2;
  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${total} ${total}`}
      role="img"
      aria-label={text}
      shapeRendering="crispEdges"
      style={{ borderRadius: 8, background: "#fff" }}
    >
      <rect width={total} height={total} fill="#fff" />
      {dark.map(([x, y]) => (
        <rect key={`${x}-${y}`} x={x + quiet} y={y + quiet} width={1} height={1} fill="#111" />
      ))}
    </svg>
  );
}
