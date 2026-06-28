"use client";

import { useState } from "react";
import Icon from "@/components/Icon";
import { CS2_MAPS, type GameMap } from "@/lib/maps";

/** Чип-дропдаун выбора встроенной карты. Показывается только хосту. */
export default function MapPicker({
  currentSrc,
  onPick,
}: {
  currentSrc: string | null;
  onPick: (map: GameMap) => void;
}) {
  const [open, setOpen] = useState(false);
  const current = CS2_MAPS.find((m) => m.src === currentSrc);

  return (
    <div className="absolute right-2 top-2 z-[var(--z-dropdown,100)]">
      <button
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="listbox"
        className="flex items-center gap-2 rounded-[var(--radius)] border border-border bg-surface/90 px-3 py-2 text-sm text-text backdrop-blur"
      >
        <Icon name="map" size={16} />
        {current ? current.name : "Выбрать карту"}
        <span className="text-text-mute">▾</span>
      </button>
      {open && (
        <ul
          role="listbox"
          className="absolute right-0 mt-1 max-h-72 w-44 overflow-auto rounded-[var(--radius)] border border-border-strong bg-surface-2 p-1 shadow-[var(--shadow-2)]"
        >
          {CS2_MAPS.map((m) => (
            <li key={m.id}>
              <button
                role="option"
                aria-selected={m.src === currentSrc}
                onClick={() => { onPick(m); setOpen(false); }}
                className={
                  "flex w-full items-center justify-between rounded px-2.5 py-2 text-left text-sm hover:bg-surface " +
                  (m.src === currentSrc ? "text-accent-hi" : "text-text-dim")
                }
              >
                {m.name}
                {m.src === currentSrc && <Icon name="check" size={15} />}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
