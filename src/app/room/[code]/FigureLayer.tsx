"use client";

import { useRef } from "react";
import type { Figure } from "@/lib/board";

export const TEAM_STYLE: Record<"ct" | "t", { bg: string; bd: string; fg: string }> = {
  ct: { bg: "#3aa0ff", bd: "#bfe0ff", fg: "#04101f" },
  t: { bg: "#f5b70a", bd: "#ffe39a", fg: "#1a1205" },
};

/**
 * DOM-слой фигурок поверх доски. Указатель ловит только когда draggable (режим
 * «Перемещение»); иначе сквозной, чтобы рисовать кистью под фигурками.
 * Драг идёт по слою (нормируем координаты от его rect — он совпадает с рамкой).
 */
export default function FigureLayer({
  figures, draggable, selectedId, onSelect, onMove, onMoveEnd, onEditLabel, onDelete,
}: {
  figures: Figure[];
  draggable: boolean;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onMove: (id: string, x: number, y: number) => void;
  onMoveEnd: (id: string, x: number, y: number) => void;
  onEditLabel: (id: string, label: string) => void;
  onDelete: (id: string) => void;
}) {
  const layerRef = useRef<HTMLDivElement>(null);
  const dragId = useRef<string | null>(null);
  const last = useRef<{ x: number; y: number }>({ x: 0, y: 0 });

  function norm(e: React.PointerEvent) {
    const r = layerRef.current!.getBoundingClientRect();
    const x = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    const y = Math.min(1, Math.max(0, (e.clientY - r.top) / r.height));
    return { x, y };
  }

  function down(e: React.PointerEvent, id: string) {
    if (!draggable) return;
    e.stopPropagation();
    (e.target as Element).setPointerCapture?.(e.pointerId);
    dragId.current = id;
    onSelect(id);
  }
  function move(e: React.PointerEvent) {
    if (!dragId.current) return;
    const p = norm(e);
    last.current = p;
    onMove(dragId.current, p.x, p.y);
  }
  function up() {
    if (!dragId.current) return;
    onMoveEnd(dragId.current, last.current.x, last.current.y);
    dragId.current = null;
  }

  return (
    <div
      ref={layerRef}
      className={"absolute inset-0 " + (draggable ? "" : "pointer-events-none")}
      onPointerMove={move}
      onPointerUp={up}
      onPointerCancel={up}
      onClick={(e) => { if (e.target === layerRef.current) onSelect(null); }}
    >
      {figures.map((f) => {
        const s = TEAM_STYLE[f.team];
        const selected = f.id === selectedId;
        const isNumber = /^\d+$/.test(f.label);
        return (
          <div
            key={f.id}
            onPointerDown={(e) => down(e, f.id)}
            onDoubleClick={(e) => {
              e.stopPropagation();
              const next = window.prompt("Подпись фигурки:", f.label);
              if (next != null) onEditLabel(f.id, next);
            }}
            className="absolute flex h-8 w-8 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full text-[13px] font-bold shadow-[0_2px_6px_rgba(0,0,0,.55)]"
            style={{
              left: `${f.x * 100}%`, top: `${f.y * 100}%`,
              background: s.bg, color: s.fg, border: `2px solid ${s.bd}`,
              boxShadow: selected ? "0 0 0 2px var(--text)" : undefined,
              cursor: draggable ? "grab" : "default",
              touchAction: "none",
            }}
          >
            {isNumber ? f.label : ""}
            {f.label && !isNumber && (
              <span className="absolute left-1/2 top-full mt-0.5 -translate-x-1/2 whitespace-nowrap text-[11px] font-semibold text-text [text-shadow:0_1px_2px_#000]">
                {f.label}
              </span>
            )}
            {selected && draggable && (
              <button
                onPointerDown={(e) => e.stopPropagation()}
                onClick={(e) => { e.stopPropagation(); onDelete(f.id); }}
                aria-label="Удалить фигурку"
                className="absolute -right-2 -top-2 flex h-5 w-5 items-center justify-center rounded-full bg-danger text-[11px] text-white"
              >
                ✕
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}
