"use client";

import { OTPInput } from "input-otp";

// Поле кода комнаты: отдельные ячейки вместо одного текстового инпута.
// База — пакет `input-otp` (зависимость shadcn @shadcn/input-otp), но стили
// полностью на токенах дизайн-системы (.otp* в globals.css), чтобы скины
// перекрашивали его сами, как .field/.btn. Код алфавитно-цифровой, uppercase.
export default function CodeInput({
  value,
  onChange,
  length = 6,
  autoFocus,
  disabled,
}: {
  value: string;
  onChange: (next: string) => void;
  length?: number;
  autoFocus?: boolean;
  disabled?: boolean;
}) {
  return (
    <OTPInput
      maxLength={length}
      value={value}
      onChange={(next) => onChange(next.toUpperCase())}
      autoFocus={autoFocus}
      disabled={disabled}
      inputMode="text"
      autoComplete="one-time-code"
      aria-label="Код комнаты"
      containerClassName="otp"
      render={({ slots }) => (
        <div className="otp-group">
          {slots.map((slot, i) => (
            <div
              key={i}
              className="otp-slot"
              data-active={slot.isActive}
              data-filled={slot.char != null}
            >
              {slot.char}
              {slot.hasFakeCaret && <span className="otp-caret" />}
            </div>
          ))}
        </div>
      )}
    />
  );
}
