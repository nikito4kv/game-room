"use client";

import Icon, { type IconName } from "@/components/Icon";
import ElasticSlider from "@/components/ElasticSlider";
import { TEAM_COLORS, type ArrowStyle, type ObjKind } from "@/lib/board";
import { CS2_OBJECTS, objDef } from "@/lib/boardObjects";

export type Tool = "move" | "draw" | "erase" | "arrow" | "nade";

const TOOLS: { id: Tool; icon: IconName; label: string }[] = [
  { id: "move", icon: "move", label: "Перемещение" },
  { id: "draw", icon: "pencil", label: "Кисть" },
  { id: "erase", icon: "eraser", label: "Ластик" },
  { id: "arrow", icon: "arrow", label: "Стрелка" },
  { id: "nade", icon: "nade-he", label: "Граната" },
];

/**
 * Боковой HUD-рельс доски (направление B): инструменты + спавн фигурок + очистка.
 * Контекстный поповер (цвет/толщина/тип стрелки) виден только для рисующих
 * инструментов — правило «не захламляем HUD» (DESIGN_SYSTEM §10).
 */
export default function BoardRail({
  tool, onTool, color, presetColors, onColor,
  size, minSize, maxSize, onSize, arrowStyle, onArrowStyle,
  objKind, onObjKind,
  onAddFigure, onClear,
}: {
  tool: Tool; onTool: (t: Tool) => void;
  color: string; presetColors: string[]; onColor: (c: string) => void;
  size: number; minSize: number; maxSize: number; onSize: (n: number) => void;
  arrowStyle: ArrowStyle; onArrowStyle: (s: ArrowStyle) => void;
  objKind: ObjKind; onObjKind: (k: ObjKind) => void;
  onAddFigure: (team: "ct" | "t") => void;
  onClear: () => void;
}) {
  const showColor = tool === "draw" || tool === "arrow";
  const showSize = tool === "draw" || tool === "erase";
  const showArrowStyle = tool === "arrow";
  const showKinds = tool === "nade";
  const showPopover = showColor || showSize || showArrowStyle || showKinds;

  return (
    <div className="pointer-events-none absolute left-2 top-2 z-[var(--z-dock,80)] flex items-start gap-2">
      <div className="pointer-events-auto flex flex-col gap-1 rounded-[var(--radius)] border border-border bg-surface/90 p-1.5 backdrop-blur">
        {TOOLS.map((t) => (
          <button
            key={t.id}
            onClick={() => onTool(t.id)}
            aria-pressed={tool === t.id}
            aria-label={t.label}
            title={t.label}
            className={
              "flex h-11 w-11 items-center justify-center rounded-lg transition-colors " +
              (tool === t.id ? "bg-accent text-on-accent" : "text-text-dim hover:text-text")
            }
          >
            <Icon name={t.icon} size={20} />
          </button>
        ))}
        <div className="my-1 h-px bg-border" />
        <button
          onClick={() => onAddFigure("ct")}
          aria-label="Добавить игрока CT"
          title="Добавить CT"
          className="flex h-11 w-11 items-center justify-center rounded-lg text-[13px] font-bold"
          style={{ color: TEAM_COLORS.ct.base, border: `1.5px solid ${TEAM_COLORS.ct.base}80`, background: `${TEAM_COLORS.ct.base}1f` }}
        >
          CT
        </button>
        <button
          onClick={() => onAddFigure("t")}
          aria-label="Добавить игрока T"
          title="Добавить T"
          className="flex h-11 w-11 items-center justify-center rounded-lg text-[13px] font-bold"
          style={{ color: TEAM_COLORS.t.base, border: `1.5px solid ${TEAM_COLORS.t.base}80`, background: `${TEAM_COLORS.t.base}1f` }}
        >
          T
        </button>
        <div className="my-1 h-px bg-border" />
        <button
          onClick={onClear}
          aria-label="Очистить доску"
          title="Очистить всё"
          className="flex h-11 w-11 items-center justify-center rounded-lg text-text-dim hover:text-danger"
        >
          <Icon name="trash" size={20} />
        </button>
      </div>

      {showPopover && (
        <div className="pointer-events-auto flex flex-wrap items-center gap-3 rounded-[var(--radius)] border border-border-strong bg-surface p-2 shadow-[var(--shadow-2)]">
          {showColor && (
            <div className="flex items-center gap-1.5">
              {presetColors.map((c) => (
                <button
                  key={c}
                  onClick={() => onColor(c)}
                  aria-label={`Цвет ${c}`}
                  aria-pressed={color === c}
                  className={
                    "h-6 w-6 rounded-full border-2 " +
                    (color === c ? "border-text" : "border-border-strong hover:scale-105")
                  }
                  style={{ backgroundColor: c }}
                />
              ))}
              <input
                type="color"
                value={color}
                onChange={(e) => onColor(e.target.value)}
                aria-label="Свой цвет"
                className="h-6 w-6 cursor-pointer rounded border border-border-strong bg-transparent p-0"
              />
            </div>
          )}
          {showSize && (
            <div className="flex items-center gap-2 text-sm text-text-dim">
              Толщина
              <ElasticSlider
                className="w-28"
                startingValue={minSize}
                maxValue={maxSize}
                defaultValue={size}
                isStepped
                stepSize={1}
                showValue
                onChange={onSize}
                ariaLabel="Толщина кисти"
              />
            </div>
          )}
          {showArrowStyle && (
            <div className="flex items-center gap-1.5" role="group" aria-label="Тип стрелки">
              <button
                onClick={() => onArrowStyle("solid")}
                aria-pressed={arrowStyle === "solid"}
                className={"btn btn--sm" + (arrowStyle === "solid" ? " btn--primary" : "")}
              >
                Раш —
              </button>
              <button
                onClick={() => onArrowStyle("dashed")}
                aria-pressed={arrowStyle === "dashed"}
                className={"btn btn--sm" + (arrowStyle === "dashed" ? " btn--primary" : "")}
              >
                Ротация ╴╴
              </button>
            </div>
          )}
          {showKinds && (
            <div className="flex items-center gap-1.5" role="group" aria-label="Тип гранаты">
              {CS2_OBJECTS.map((d) => (
                <button
                  key={d.kind}
                  onClick={() => onObjKind(d.kind)}
                  aria-pressed={objKind === d.kind}
                  title={d.name}
                  className="flex h-8 items-center gap-1 rounded-lg px-2 text-[12px] font-semibold"
                  style={{
                    color: d.color,
                    border: `1.5px solid ${d.color}${objKind === d.kind ? "" : "66"}`,
                    background: objKind === d.kind ? `${d.color}26` : "transparent",
                  }}
                >
                  <Icon name={objDef(d.kind).icon} size={15} />
                  {d.name}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
