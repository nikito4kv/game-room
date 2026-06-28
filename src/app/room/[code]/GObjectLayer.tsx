"use client";

import { useRef, useState } from "react";
import { normToRect, type GameObject, type Technique } from "@/lib/board";
import { CS2_OBJECTS, objDef, TECHNIQUE_LABELS, type ObjGeom } from "@/lib/boardObjects";
import Icon from "@/components/Icon";

type DragPart = "landing" | "from" | "radius";

/**
 * DOM-слой игровых объектов поверх доски (по образцу FigureLayer).
 *
 * Хит-тест: КОРЕНЬ слоя всегда `pointer-events:none` (рисунок виден, но клики
 * проходят насквозь), а перехватывают указатель только интерактивные дети
 * (маркеры/ручки) — и только в режиме «Перемещение». Так слой не перекрывает
 * стрелки/фигурки/холст: каждый слой ловит указатель лишь там, где есть его
 * элементы, а клик по пустому месту проваливается на холст (он снимает выделение
 * и ставит гранату — см. TacticsBoard). Порядок отрисовки при этом не меняется,
 * поэтому зоны по-прежнему под фигурками визуально.
 *
 * Зоны — круглые div (aspect-ratio:1 + ширина в % держат круг при любых
 * пропорциях карты). Линии броска — общий SVG под маркерами.
 */
export default function GObjectLayer({
  objects, draggable, selectedId, onSelect, onGeom, onGeomEnd, onEdit, onDelete,
}: {
  objects: GameObject[];
  draggable: boolean;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onGeom: (id: string, g: ObjGeom) => void;
  onGeomEnd: (id: string, g: ObjGeom) => void;
  onEdit: (id: string, patch: { technique?: Technique; note?: string }) => void;
  onDelete: (id: string) => void;
}) {
  const layerRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{ id: string; part: DragPart } | null>(null);
  const last = useRef<ObjGeom>({});
  const moved = useRef(false);
  const [editId, setEditId] = useState<string | null>(null);

  function norm(e: React.PointerEvent) {
    const [x, y] = normToRect(e.clientX, e.clientY, layerRef.current!.getBoundingClientRect());
    return { x, y };
  }

  function startDrag(e: React.PointerEvent, id: string, part: DragPart) {
    if (!draggable) return;
    e.stopPropagation();
    (e.target as Element).setPointerCapture?.(e.pointerId);
    drag.current = { id, part };
    last.current = {};
    moved.current = false;
    // Переключение на другой объект закрывает чужой поповер тайминга (иначе он
    // «залипал» бы на уже не выделенном объекте и правки уходили бы не туда).
    if (editId !== id) setEditId(null);
    onSelect(id);
  }

  function move(e: React.PointerEvent) {
    const d = drag.current;
    if (!d) return;
    const obj = objects.find((o) => o.id === d.id);
    if (!obj) return;
    const p = norm(e);
    let patch: ObjGeom;
    if (d.part === "landing") patch = { x: p.x, y: p.y };
    else if (d.part === "from") patch = { fromX: p.x, fromY: p.y };
    else {
      // Радиус — доля ШИРИНЫ доски, поэтому вертикальную дельту приводим к
      // единицам ширины через аспект слоя (иначе на неквадратной карте круг
      // менялся бы не в такт курсору).
      const rect = layerRef.current!.getBoundingClientRect();
      const aspect = rect.height > 0 ? rect.width / rect.height : 1;
      patch = { radius: Math.hypot(p.x - obj.x, (p.y - obj.y) / aspect) };
    }
    last.current = patch;
    moved.current = true;
    onGeom(d.id, patch);
  }

  function up() {
    const d = drag.current;
    if (!d) return;
    if (moved.current) onGeomEnd(d.id, last.current);
    drag.current = null;
  }

  return (
    <div
      ref={layerRef}
      className="pointer-events-none absolute inset-0"
      style={{ touchAction: "none" }}
      onPointerMove={move}
      onPointerUp={up}
      onPointerCancel={up}
    >
      {/* Линии броска (общий SVG под маркерами). preserveAspectRatio="none" +
          non-scaling-stroke держат толщину постоянной — как в ArrowLayer.
          Наконечники — по одному маркеру НА ТИП (а не на объект), чтобы дефы не
          плодились и не перестраивались на каждый кадр драга. */}
      <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="pointer-events-none absolute inset-0 h-full w-full">
        <defs>
          {CS2_OBJECTS.map((d) => (
            <marker key={d.kind} id={`oah-${d.kind}`} markerWidth="6" markerHeight="6" refX="4.5" refY="3" orient="auto" markerUnits="strokeWidth">
              <path d="M0,0 L5,3 L0,6 Z" fill={d.color} />
            </marker>
          ))}
        </defs>
        {objects.map((o) =>
          o.from ? (
            <line
              key={`l-${o.id}`}
              x1={o.from.x * 100} y1={o.from.y * 100} x2={o.x * 100} y2={o.y * 100}
              stroke={objDef(o.kind).color} strokeWidth={1.2} strokeLinecap="round"
              strokeDasharray="3 2.4" markerEnd={`url(#oah-${o.kind})`} vectorEffect="non-scaling-stroke"
            />
          ) : null,
        )}
      </svg>

      {objects.map((o) => {
        const def = objDef(o.kind);
        const isZone = def.cls === "zone";
        const selected = o.id === selectedId;
        const r = o.radius ?? def.defaultRadius ?? 0.05;
        // Подпись: у середины линии, либо чуть ниже объекта (за краем зоны для зон).
        const labelX = o.from ? (o.from.x + o.x) / 2 : o.x;
        const labelY = o.from ? (o.from.y + o.y) / 2 : o.y + (isZone ? r : 0.03) + 0.02;
        return (
          <div key={o.id}>
            {/* Зона эффекта (круг) + ручка радиуса как её ребёнок — так ручка сидит
                на краю круга при любых пропорциях карты. */}
            {isZone && (
              <div
                className="absolute -translate-x-1/2 -translate-y-1/2 rounded-full"
                style={{
                  left: `${o.x * 100}%`, top: `${o.y * 100}%`,
                  width: `${r * 2 * 100}%`, aspectRatio: "1",
                  background: `radial-gradient(circle, ${def.color}e6 0%, ${def.color}b3 55%, ${def.color}1f 100%)`,
                  border: `1px dashed ${def.color}`,
                  boxShadow: selected ? "0 0 0 2px var(--text)" : undefined,
                  pointerEvents: "none",
                }}
              >
                {selected && draggable && (
                  <div
                    onPointerDown={(e) => startDrag(e, o.id, "radius")}
                    title="Тянуть — радиус зоны"
                    className="absolute h-3.5 w-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-[var(--text)] bg-[var(--accent)]"
                    // NE-точка на окружности (центр div = 50/50, радиус = 50% его бокса).
                    style={{ left: `${50 + 50 * Math.SQRT1_2}%`, top: `${50 - 50 * Math.SQRT1_2}%`, cursor: "nwse-resize", pointerEvents: "auto" }}
                  />
                )}
              </div>
            )}

            {/* Маркер-иконка в точке приземления (он же ручка перетаскивания landing) */}
            <div
              onPointerDown={(e) => startDrag(e, o.id, "landing")}
              onDoubleClick={(e) => { e.stopPropagation(); if (draggable) { onSelect(o.id); setEditId(o.id); } }}
              className="absolute flex h-7 w-7 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full shadow-[0_2px_6px_rgba(0,0,0,.55)]"
              style={{
                left: `${o.x * 100}%`, top: `${o.y * 100}%`,
                background: "#0c131c", color: def.color, border: `2px solid ${def.color}`,
                boxShadow: selected && !isZone ? "0 0 0 2px var(--text)" : undefined,
                cursor: draggable ? "grab" : "default",
                pointerEvents: draggable ? "auto" : "none",
              }}
            >
              <Icon name={def.icon} size={16} />
            </div>

            {/* Точка броска (если есть) — перетаскиваемая ручка */}
            {o.from && (
              <div
                onPointerDown={(e) => startDrag(e, o.id, "from")}
                className="absolute h-4 w-4 -translate-x-1/2 -translate-y-1/2 rounded-full border-2"
                style={{
                  left: `${o.from.x * 100}%`, top: `${o.from.y * 100}%`,
                  background: "#131c27", borderColor: def.color,
                  cursor: draggable ? "grab" : "default", pointerEvents: draggable ? "auto" : "none",
                }}
              />
            )}

            {/* Подпись тайминга */}
            {(o.technique || o.note) && (
              <div
                className="absolute -translate-x-1/2 -translate-y-1/2 whitespace-nowrap rounded-full border border-border-strong bg-surface px-2 py-0.5 text-[11px] font-semibold text-text"
                style={{ left: `${labelX * 100}%`, top: `${labelY * 100}%`, pointerEvents: "none" }}
              >
                {[o.technique && TECHNIQUE_LABELS.find((t) => t.id === o.technique)?.label, o.note].filter(Boolean).join(" · ")}
              </div>
            )}

            {/* Ручки на выделенном объекте в режиме «Перемещение» */}
            {selected && draggable && (
              <>
                {/* ручка-хвост (создать линию) — если from ещё нет */}
                {!o.from && (
                  <div
                    onPointerDown={(e) => startDrag(e, o.id, "from")}
                    title="Тянуть — задать точку броска"
                    className="absolute flex h-5 w-5 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border border-border-strong bg-surface text-text-dim"
                    style={{ left: `calc(${o.x * 100}% - 22px)`, top: `calc(${o.y * 100}% - 22px)`, cursor: "crosshair", pointerEvents: "auto" }}
                  >
                    <Icon name="arrow" size={12} />
                  </div>
                )}
                {/* удалить */}
                <button
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={(e) => { e.stopPropagation(); onDelete(o.id); }}
                  aria-label="Удалить объект"
                  className="absolute flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded-full bg-danger text-[11px] text-white"
                  style={{ left: `calc(${o.x * 100}% + 14px)`, top: `calc(${o.y * 100}% - 14px)`, pointerEvents: "auto" }}
                >
                  ✕
                </button>
              </>
            )}

            {/* Поповер тайминга (двойной клик). Привязан к выделению: как только
                выделение уходит на другой объект или снимается — поповер скрыт. */}
            {editId === o.id && selected && draggable && (
              <div
                className="absolute z-[var(--z-dock,80)] -translate-x-1/2 rounded-[var(--radius)] border border-border-strong bg-surface p-2 shadow-[var(--shadow-2)]"
                style={{ left: `${o.x * 100}%`, top: `calc(${o.y * 100}% + 18px)`, pointerEvents: "auto" }}
                onPointerDown={(e) => e.stopPropagation()}
              >
                <div className="mb-1.5 flex flex-wrap gap-1" role="group" aria-label="Техника броска">
                  {TECHNIQUE_LABELS.map((t) => (
                    <button
                      key={t.id}
                      onClick={() => onEdit(o.id, { technique: o.technique === t.id ? undefined : t.id })}
                      aria-pressed={o.technique === t.id}
                      className={"btn btn--sm" + (o.technique === t.id ? " btn--primary" : "")}
                    >
                      {t.label}
                    </button>
                  ))}
                </div>
                <input
                  defaultValue={o.note ?? ""}
                  placeholder="Заметка / тайминг"
                  maxLength={24}
                  onBlur={(e) => onEdit(o.id, { note: e.target.value })}
                  onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
                  className="field w-44"
                />
                <button onClick={() => setEditId(null)} className="btn btn--sm mt-1.5 w-full">Готово</button>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
