import { useMemo } from "react";
import qrcode from "qrcode-generator";

/** A QR code drawn in ink on paper, as one SVG path (4-module quiet zone). */
export function QrCode({ value, size = 184, label }: { value: string; size?: number; label?: string }) {
  const { n, d } = useMemo(() => {
    const qr = qrcode(0, "M");
    qr.addData(value);
    qr.make();
    const count = qr.getModuleCount();
    let path = "";
    for (let r = 0; r < count; r++) {
      for (let c = 0; c < count; c++) if (qr.isDark(r, c)) path += `M${c + 4} ${r + 4}h1v1h-1z`;
    }
    return { n: count + 8, d: path };
  }, [value]);
  return (
    <svg className="qr" width={size} height={size} viewBox={`0 0 ${n} ${n}`} role="img" aria-label={label ?? value}
         shapeRendering="crispEdges">
      <rect width={n} height={n} fill="var(--card)" />
      <path d={d} fill="var(--ink)" />
    </svg>
  );
}
