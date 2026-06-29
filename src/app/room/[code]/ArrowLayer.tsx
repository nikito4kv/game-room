"use client";

import { useRef, useState } from "react";
import { normToRect, type Arrow, type ArrowStyle } from "@/lib/board";

/**
 * SVG-слой стрелок. В режиме «Стрелка» рисует резиновую прямую (превью локальное),
 * на отпускании отдаёт endpoints через onCommit. В режиме «Перемещение» — хит-тест
 * по линиям для выделения/удаления. Иначе указатель сквозной.
 *
 * viewBox 0..100; vectorEffect="non-scaling-stroke" держит видимую толщину линии
 * постоянной при растяжении доски (координаты нормированы, толщина — нет).
 */
export default function ArrowLayer({
  arrows, drawing, selecting, color, style, size, selectedId, onSelect, onCommit, onDelete,
}: {
  arrows: Arrow[];
  drawing: boolean;
  selecting: boolean;
  color: string;
  style: ArrowStyle;
  size: number;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onCommit: (a: { x1: number; y1: number; x2: number; y2: number }) => void;
  onDelete: (id: string) => void;
}) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [draft, setDraft] = useState<{ x1: number; y1: number; x2: number; y2: number } | null>(null);

  function norm(e: React.PointerEvent) {
    const [x, y] = normToRect(e.clientX, e.clientY, svgRef.current!.getBoundingClientRect());
    return { x, y };
  }
  function down(e: React.PointerEvent) {
    // Снятие выделения по клику в пустоту делает холст (он лежит под слоями) —
    // здесь корень сквозной в режиме выделения, чтобы не перекрывать соседние слои.
    if (!drawing) return;
    (e.target as Element).setPointerCapture?.(e.pointerId);
    const p = norm(e);
    setDraft({ x1: p.x, y1: p.y, x2: p.x, y2: p.y });
  }
  function move(e: React.PointerEvent) {
    if (!draft) return;
    const p = norm(e);
    setDraft((d) => (d ? { ...d, x2: p.x, y2: p.y } : d));
  }
  function up() {
    if (!draft) return;
    const moved = Math.hypot(draft.x2 - draft.x1, draft.y2 - draft.y1) > 0.02; // отсекаем случайный тык
    if (moved) onCommit(draft);
    setDraft(null);
  }

  // Корень SVG ловит указатель только при рисовании (резиновая прямая по пустому
  // месту). В режиме выделения корень сквозной, а кликабельны лишь сами стрелки
  // (широкие хит-линии ниже) — так слой не перекрывает фигурки/объекты/холст.
  const pe = drawing ? "auto" : "none";

  return (
    <svg
      ref={svgRef}
      viewBox="0 0 100 100"
      preserveAspectRatio="none"
      className="absolute inset-0 h-full w-full"
      style={{ pointerEvents: pe, touchAction: "none", cursor: drawing ? "crosshair" : "default" }}
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={up}
      onPointerCancel={up}
    >
      {arrows.map((a) => {
        const mid = `ah-${a.id}`;
        const sel = a.id === selectedId;
        return (
          <g key={a.id}>
            <marker id={mid} markerWidth="6" markerHeight="6" refX="4.5" refY="3" orient="auto" markerUnits="strokeWidth">
              <path d="M0,0 L5,3 L0,6 Z" fill={a.color} />
            </marker>
            {/* широкая прозрачная линия — удобный хит-тест для выделения */}
            {selecting && (
              <line
                x1={a.x1 * 100} y1={a.y1 * 100} x2={a.x2 * 100} y2={a.y2 * 100}
                stroke="transparent" strokeWidth={3}
                style={{ cursor: "pointer", pointerEvents: "auto" }}
                onPointerDown={(e) => { e.stopPropagation(); onSelect(a.id); }}
              />
            )}
            <line
              x1={a.x1 * 100} y1={a.y1 * 100} x2={a.x2 * 100} y2={a.y2 * 100}
              stroke={a.color} strokeWidth={(a.size ?? 1) + (sel ? 0.6 : 0)} strokeLinecap="round"
              strokeDasharray={a.style === "dashed" ? "3 2.4" : undefined}
              markerEnd={`url(#${mid})`}
              vectorEffect="non-scaling-stroke"
            />
            {sel && selecting && (
              <g
                transform={`translate(${((a.x1 + a.x2) / 2) * 100} ${((a.y1 + a.y2) / 2) * 100})`}
                style={{ cursor: "pointer", pointerEvents: "auto" }}
                onPointerDown={(e) => { e.stopPropagation(); onDelete(a.id); }}
              >
                <circle r="2.6" fill="var(--danger)" />
                <path d="M-1.2,-1.2 L1.2,1.2 M1.2,-1.2 L-1.2,1.2" stroke="#fff" strokeWidth="0.6" />
              </g>
            )}
          </g>
        );
      })}
      {draft && (
        <line
          x1={draft.x1 * 100} y1={draft.y1 * 100} x2={draft.x2 * 100} y2={draft.y2 * 100}
          stroke={color} strokeWidth={size} strokeLinecap="round"
          strokeDasharray={style === "dashed" ? "3 2.4" : undefined}
          vectorEffect="non-scaling-stroke" opacity={0.8}
        />
      )}
    </svg>
  );
}
