"use client";

import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import Icon, { type IconName } from "@/components/Icon";
import { type ArrowStyle, type ObjKind, type Team } from "@/lib/board";
import { CS2_OBJECTS, objClass, objDef } from "@/lib/boardObjects";

export type Tool = "move" | "draw" | "erase" | "arrow" | "nade";

type TeamColors = Record<Team, { base: string; border: string; fg: string }>;

const TOOLS: { id: Tool; icon: IconName; label: string; settings: boolean }[] = [
  { id: "move", icon: "move", label: "Перемещение", settings: false },
  { id: "draw", icon: "pencil", label: "Кисть", settings: true },
  { id: "erase", icon: "eraser", label: "Ластик", settings: true },
  { id: "arrow", icon: "arrow", label: "Стрелка", settings: true },
  { id: "nade", icon: "nade-he", label: "Граната", settings: true },
];

// Пресеты толщины (px относительно эталонной ширины доски) — быстрый выбор кружком.
const SIZE_PRESETS = [2, 4, 8, 14];

/**
 * Боковой рельс доски — компактная колонка иконок СЛЕВА от сцены. Настройки
 * инструмента выезжают flyout-ом по наведению/фокусу (на тач — по тапу), а не
 * висят постоянно (раньше широкий поповер крал ширину у карты). Палитру убрали —
 * цвет один, RGB-свотч, как в Paint. Рельс лежит в своём stacking-слое (z-30),
 * иначе flyout уходил за крупную сцену. Анимации — motion (spring).
 */
export default function BoardRail({
  tool, onTool, color, onColor,
  size, minSize, maxSize, onSize, arrowStyle, onArrowStyle, arrowSize, onArrowSize,
  objKind, onObjKind, objRadius, onObjRadius,
  teamColors, onTeamColor, pendingTeam,
  onArmFigure, onClear,
}: {
  tool: Tool; onTool: (t: Tool) => void;
  color: string; onColor: (c: string) => void;
  size: number; minSize: number; maxSize: number; onSize: (n: number) => void;
  arrowStyle: ArrowStyle; onArrowStyle: (s: ArrowStyle) => void;
  arrowSize: number; onArrowSize: (n: number) => void;
  objKind: ObjKind; onObjKind: (k: ObjKind) => void;
  objRadius: number; onObjRadius: (r: number) => void;
  teamColors: TeamColors; onTeamColor: (team: Team, color: string) => void;
  pendingTeam: Team | null;
  onArmFigure: (team: Team) => void;
  onClear: () => void;
}) {
  const reduce = useReducedMotion();
  const railRef = useRef<HTMLDivElement>(null);
  // Flyout открывается по hover/focus (hoverKey). Но при взаимодействии с панелью
  // её «закрепляем» (pinKey): иначе нативный пикёр цвета открывается отдельным
  // окном ОС, курсор уходит из flyout → mouse-leave закрыл бы панель и пикёр.
  // Закреплённая панель закрывается только кликом вне рельса или по Esc.
  const [hoverKey, setHoverKey] = useState<string | null>(null);
  const [pinKey, setPinKey] = useState<string | null>(null);
  const openKey = hoverKey ?? pinKey;
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const show = (k: string) => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
    closeTimer.current = null;
    setHoverKey(k);
    // Навели на другой тул — снимаем чужой пин (не «воскрешаем» прошлую панель).
    setPinKey((p) => (p && p !== k ? null : p));
  };
  const scheduleHide = () => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
    closeTimer.current = setTimeout(() => setHoverKey(null), 120); // pin переживает уход мыши
  };
  const pin = (k: string) => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
    closeTimer.current = null;
    setPinKey(k);
    setHoverKey(k);
  };
  const onBlurWrap = (e: React.FocusEvent) => {
    if (!e.currentTarget.contains(e.relatedTarget as Node)) scheduleHide();
  };
  // Закреплённую панель закрываем кликом вне рельса или по Esc.
  useEffect(() => {
    if (!pinKey) return;
    const close = () => { setPinKey(null); setHoverKey(null); };
    const onDown = (e: PointerEvent) => {
      if (railRef.current && !railRef.current.contains(e.target as Node)) close();
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") close(); };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [pinKey]);

  const radiusUsed = tool === "nade" && objClass(objKind) === "zone";
  const springT = reduce ? { duration: 0 } : { type: "spring" as const, stiffness: 520, damping: 36 };

  return (
    <div ref={railRef} className="relative z-30 flex flex-col gap-1 rounded-[var(--radius)] border border-border bg-surface/90 p-1 backdrop-blur">
      {TOOLS.map((t) => {
        const isActive = tool === t.id;
        return (
          <div
            key={t.id}
            className="relative"
            onMouseEnter={() => t.settings && show(t.id)}
            onMouseLeave={scheduleHide}
            onFocusCapture={() => t.settings && show(t.id)}
            onBlur={onBlurWrap}
          >
            <button
              onClick={() => { onTool(t.id); if (t.settings) show(t.id); }}
              aria-pressed={isActive}
              aria-label={t.label}
              title={t.label}
              className={
                "relative flex h-9 w-9 items-center justify-center rounded-lg transition-colors " +
                (isActive ? "text-on-accent" : "text-text-dim hover:text-text")
              }
            >
              {isActive && (
                <motion.span
                  layoutId="rail-active"
                  transition={springT}
                  className="absolute inset-0 -z-10 rounded-lg bg-accent"
                />
              )}
              <Icon name={t.icon} size={18} />
            </button>

            <AnimatePresence>
              {openKey === t.id && t.settings && (
                <Flyout
                  reduce={reduce}
                  onMouseEnter={() => show(t.id)}
                  onMouseLeave={scheduleHide}
                  onInteract={() => { pin(t.id); onTool(t.id); }}
                >
                  {t.id === "draw" && <Swatch color={color} onColor={onColor} title="Цвет" />}
                  {(t.id === "draw" || t.id === "erase") && (
                    <Thickness size={size} min={minSize} max={maxSize} onSize={onSize} />
                  )}
                  {t.id === "arrow" && (
                    <div className="flex flex-col gap-2.5">
                      <div className="flex items-center gap-2">
                        <Swatch color={color} onColor={onColor} title="Цвет" />
                        <div className="flex items-center gap-1.5" role="group" aria-label="Тип стрелки">
                          <Chip active={arrowStyle === "solid"} onClick={() => onArrowStyle("solid")}>Раш —</Chip>
                          <Chip active={arrowStyle === "dashed"} onClick={() => onArrowStyle("dashed")}>Ротация ╴╴</Chip>
                        </div>
                      </div>
                      <Thickness size={arrowSize} min={1} max={10} presets={[1, 2, 4, 6]} onSize={onArrowSize} />
                    </div>
                  )}
                  {t.id === "nade" && (
                    <div className="flex flex-col gap-2">
                      <div className="flex items-center gap-1.5" role="group" aria-label="Тип гранаты">
                        {CS2_OBJECTS.map((d) => (
                          <button
                            key={d.kind}
                            onClick={() => onObjKind(d.kind)}
                            aria-pressed={objKind === d.kind}
                            title={d.name}
                            className="flex h-7 items-center gap-1 rounded-md px-1.5 text-[11px] font-semibold transition-colors"
                            style={{
                              color: d.color,
                              border: `1.5px solid ${d.color}${objKind === d.kind ? "" : "66"}`,
                              background: objKind === d.kind ? `${d.color}26` : "transparent",
                            }}
                          >
                            <Icon name={objDef(d.kind).icon} size={14} />
                            {d.name}
                          </button>
                        ))}
                      </div>
                      {radiusUsed && (
                        <Slider
                          label="Радиус зоны"
                          value={Math.round(objRadius * 100)}
                          min={2}
                          max={25}
                          suffix="%"
                          onChange={(v) => onObjRadius(v / 100)}
                        />
                      )}
                    </div>
                  )}
                </Flyout>
              )}
            </AnimatePresence>
          </div>
        );
      })}

      <div className="mx-1 my-0.5 h-px bg-border" />

      {/* Фигурки: клик — взять фишку (ставится по клику на доске); наведение — цвет команды. */}
      {(["ct", "t"] as const).map((team) => {
        const armed = pendingTeam === team;
        return (
          <div
            key={team}
            className="relative"
            onMouseEnter={() => show(`fig-${team}`)}
            onMouseLeave={scheduleHide}
            onFocusCapture={() => show(`fig-${team}`)}
            onBlur={onBlurWrap}
          >
            <button
              onClick={() => onArmFigure(team)}
              aria-pressed={armed}
              aria-label={team === "ct" ? "Поставить игрока CT" : "Поставить игрока T"}
              title={team === "ct" ? "Поставить CT — затем клик по доске" : "Поставить T — затем клик по доске"}
              className="flex h-9 w-9 items-center justify-center rounded-lg text-[12px] font-bold transition-transform hover:scale-105"
              style={{
                color: teamColors[team].base,
                border: `1.5px solid ${teamColors[team].base}${armed ? "" : "80"}`,
                background: `${teamColors[team].base}${armed ? "33" : "1f"}`,
                boxShadow: armed ? `0 0 0 2px ${teamColors[team].base}` : undefined,
              }}
            >
              {team === "ct" ? "CT" : "T"}
            </button>
            <AnimatePresence>
              {openKey === `fig-${team}` && (
                <Flyout
                  reduce={reduce}
                  onMouseEnter={() => show(`fig-${team}`)}
                  onMouseLeave={scheduleHide}
                  onInteract={() => pin(`fig-${team}`)}
                >
                  <div className="flex items-center gap-2 whitespace-nowrap text-sm text-text-dim">
                    {team === "ct" ? "Цвет CT" : "Цвет T"}
                    <Swatch
                      color={teamColors[team].base}
                      onColor={(c) => onTeamColor(team, c)}
                      title={team === "ct" ? "Цвет CT" : "Цвет T"}
                    />
                  </div>
                </Flyout>
              )}
            </AnimatePresence>
          </div>
        );
      })}

      <div className="mx-1 my-0.5 h-px bg-border" />

      <button
        onClick={onClear}
        aria-label="Очистить доску"
        title="Очистить всё"
        className="flex h-9 w-9 items-center justify-center rounded-lg text-text-dim transition-colors hover:text-danger"
      >
        <Icon name="trash" size={18} />
      </button>
    </div>
  );
}

/** Выезжающая панель настроек инструмента — справа от рельса, к карте.
 *  onInteract — клик по панели: закрепляет её (чтобы не закрылась при уходе мыши,
 *  напр. в нативный пикёр цвета) и делает инструмент активным (ткнул «молотов» —
 *  нада-инструмент включился, лишний клик не нужен). */
function Flyout({
  children, reduce, onMouseEnter, onMouseLeave, onInteract,
}: {
  children: React.ReactNode;
  reduce: boolean | null;
  onMouseEnter: () => void;
  onMouseLeave: () => void;
  onInteract?: () => void;
}) {
  return (
    <motion.div
      // pl-2 — «мостик» к панели: курсор переходит на flyout, не теряя hover.
      className="absolute left-full top-0 z-50 pl-2"
      style={{ transformOrigin: "left center" }}
      initial={reduce ? { opacity: 0 } : { opacity: 0, scale: 0.96, x: -6 }}
      animate={{ opacity: 1, scale: 1, x: 0 }}
      exit={reduce ? { opacity: 0 } : { opacity: 0, scale: 0.96, x: -6 }}
      transition={reduce ? { duration: 0 } : { type: "spring", stiffness: 560, damping: 38 }}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    >
      <div
        onPointerDown={onInteract}
        className="flex w-max items-center gap-3 rounded-[var(--radius)] border border-border-strong bg-surface-2/95 p-2.5 shadow-[var(--shadow-2)] backdrop-blur"
      >
        {children}
      </div>
    </motion.div>
  );
}

/** Толщина линии: пресеты-кружки + ползунок снизу (как в привычных редакторах). */
function Thickness({
  size, min, max, onSize, presets = SIZE_PRESETS,
}: {
  size: number; min: number; max: number; onSize: (n: number) => void; presets?: number[];
}) {
  return (
    <div className="flex w-44 flex-col gap-2">
      <div className="text-xs font-medium text-text-mute">Толщина линии</div>
      <div className="flex items-center justify-between">
        {presets.map((p) => {
          const active = size === p;
          const d = Math.max(4, Math.min(18, Math.round(3 + p * 1.4)));
          return (
            <button
              key={p}
              onClick={() => onSize(p)}
              aria-pressed={active}
              title={`${p}px`}
              className={
                "flex h-9 w-9 items-center justify-center rounded-lg border transition-colors " +
                (active ? "border-accent bg-accent/15" : "border-transparent hover:bg-surface")
              }
            >
              <span className="rounded-full bg-text" style={{ width: d, height: d }} />
            </button>
          );
        })}
      </div>
      <Slider value={size} min={min} max={max} suffix="px" onChange={onSize} ariaLabel="Толщина кисти" />
    </div>
  );
}

/** Универсальный ползунок (нативный range) с подписью значения. */
function Slider({
  value, min, max, onChange, label, suffix = "", ariaLabel,
}: {
  value: number; min: number; max: number; onChange: (n: number) => void;
  label?: string; suffix?: string; ariaLabel?: string;
}) {
  return (
    <div className="flex w-44 flex-col gap-1.5">
      {label && <div className="text-xs font-medium text-text-mute">{label}</div>}
      <div className="flex items-center gap-2">
        <input
          type="range"
          min={min}
          max={max}
          value={value}
          onChange={(e) => onChange(Number(e.target.value))}
          aria-label={ariaLabel ?? label}
          className="h-1.5 flex-1 cursor-pointer rounded-full"
          style={{ accentColor: "var(--accent)" }}
        />
        <span className="w-10 text-right text-sm tabular-nums text-text-dim">{value}{suffix}</span>
      </div>
    </div>
  );
}

/** Один RGB-свотч (нативный пикёр под цветным квадратом) — «как в Paint». */
function Swatch({ color, onColor, title }: { color: string; onColor: (c: string) => void; title: string }) {
  return (
    <label
      title={title}
      className="relative block h-7 w-7 shrink-0 cursor-pointer rounded-md border border-border-strong"
      style={{ background: color }}
    >
      <input
        type="color"
        value={color}
        onChange={(e) => onColor(e.target.value)}
        aria-label={title}
        className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
      />
    </label>
  );
}

function Chip({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button onClick={onClick} aria-pressed={active} className={"btn btn--sm" + (active ? " btn--primary" : "")}>
      {children}
    </button>
  );
}
