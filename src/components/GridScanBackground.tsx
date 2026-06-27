"use client";

import dynamic from "next/dynamic";
import { useEffect, useState } from "react";

// Тяжёлый WebGL-фон (three + postprocessing + face-api) грузим только в браузере.
// ssr:false убирает его из серверного рендера (WebGL недоступен на сервере), а сам
// динамический импорт выносит этот код из стартового бандла страницы.
const GridScan = dynamic(() => import("@/components/GridScan").then((m) => m.GridScan), {
  ssr: false,
});

/**
 * Анимированная сетка-скан фоном главной страницы. Перекрашена под скин «Arena»
 * (ирис-акцент на тёмной базе) и приглушена, чтобы не спорить с формой лобби.
 */
export default function GridScanBackground() {
  // Уважаем «меньше движения»: при reduce анимированную сетку не показываем вовсе
  // (см. prefers-reduced-motion в globals.css — единая политика проекта).
  const [animate, setAnimate] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const apply = () => setAnimate(!mq.matches);
    apply();
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, []);

  if (!animate) return null;

  return (
    <div aria-hidden className="fixed inset-0 -z-10">
      <GridScan
        style={{ position: "absolute", inset: 0 }}
        sensitivity={0.5}
        lineThickness={1}
        linesColor="#262b40"
        gridScale={0.1}
        scanColor="#8e86ff"
        scanOpacity={0.32}
        scanDirection="pingpong"
        enablePost
        bloomIntensity={0.5}
        chromaticAberration={0.0015}
        noiseIntensity={0.012}
      />
      {/* Скрим: гасит центр под формой, оставляя сетку живой по краям. */}
      <div
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            "radial-gradient(115% 85% at 50% 32%, color-mix(in srgb, var(--bg-deep) 80%, transparent), transparent 72%)",
        }}
      />
    </div>
  );
}
