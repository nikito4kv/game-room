"use client";

import { useRef } from "react";
import { normToRect, TEAM_COLORS, type Figure } from "@/lib/board";

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
  // Двигали ли фигурку в этом жесте. Без этого простой клик-выделение (pointerdown
  // без move) на pointerup закоммитил бы last={0,0} и телепортировал фигурку в угол.
  const moved = useRef(false);

  function norm(e: React.PointerEvent) {
    const [x, y] = normToRect(e.clientX, e.clientY, layerRef.current!.getBoundingClientRect());
    return { x, y };
  }

  function down(e: React.PointerEvent, id: string) {
    if (!draggable) return;
    e.stopPropagation();
    (e.target as Element).setPointerCapture?.(e.pointerId);
    dragId.current = id;
    moved.current = false;
    onSelect(id);
  }
  function move(e: React.PointerEvent) {
    if (!dragId.current) return;
    const p = norm(e);
    last.current = p;
    moved.current = true;
    onMove(dragId.current, p.x, p.y);
  }
  function up() {
    if (!dragId.current) return;
    if (moved.current) onMoveEnd(dragId.current, last.current.x, last.current.y);
    dragId.current = null;
  }

  // Корень всегда сквозной (pointer-events:none): перехватывают указатель только
  // сами фигурки и только в режиме «Перемещение». Так слой не перекрывает соседние
  // (стрелки/объекты/холст), а снятие выделения по клику в пустоту делает холст.
  // onPointerMove/Up на корне всё равно срабатывают во время драга — события
  // приходят по всплытию от захваченной (setPointerCapture) фигурки.
  return (
    <div
      ref={layerRef}
      className="pointer-events-none absolute inset-0"
      onPointerMove={move}
      onPointerUp={up}
      onPointerCancel={up}
    >
      {figures.map((f) => {
        const s = TEAM_COLORS[f.team];
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
              background: s.base, color: s.fg, border: `2px solid ${s.border}`,
              boxShadow: selected ? "0 0 0 2px var(--text)" : undefined,
              cursor: draggable ? "grab" : "default",
              touchAction: "none",
              pointerEvents: draggable ? "auto" : "none",
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
