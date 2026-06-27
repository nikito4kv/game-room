"use client";

// ElasticSlider (React Bits, TS+Tailwind) — «упругий» ползунок с оттяжкой за край
// и hover-scale. Отличия от оригинала:
//   • добавлен onChange — оригинал держал значение только внутри и наружу не отдавал,
//     для управляемых регуляторов это обязательно;
//   • добавлены disabled, showValue, valueSuffix;
//   • серые цвета заменены на токены дизайн-системы (перекрашивается под скин).
import React, { useRef, useState } from "react";
import {
  animate,
  motion,
  useMotionValue,
  useMotionValueEvent,
  useTransform,
} from "motion/react";

const MAX_OVERFLOW = 50;

interface ElasticSliderProps {
  defaultValue?: number;
  startingValue?: number;
  maxValue?: number;
  className?: string;
  isStepped?: boolean;
  stepSize?: number;
  leftIcon?: React.ReactNode;
  rightIcon?: React.ReactNode;
  /** Колбэк изменения значения (срабатывает только на действие пользователя). */
  onChange?: (value: number) => void;
  /** Отключённый ползунок — не реагирует на указатель, приглушён. */
  disabled?: boolean;
  /** Показывать встроенный числовой отсчёт под дорожкой. */
  showValue?: boolean;
  /** Суффикс к встроенному отсчёту (напр. "%"). */
  valueSuffix?: string;
  /** Доступная подпись для клавиатуры/скринридера (role="slider"). */
  ariaLabel?: string;
}

const ElasticSlider: React.FC<ElasticSliderProps> = ({
  defaultValue = 50,
  startingValue = 0,
  maxValue = 100,
  className = "",
  isStepped = false,
  stepSize = 1,
  leftIcon = <>-</>,
  rightIcon = <>+</>,
  onChange,
  disabled = false,
  showValue = false,
  valueSuffix = "",
  ariaLabel,
}) => {
  return (
    <div
      className={`flex w-full flex-col items-center justify-center gap-3 ${className}`}
    >
      <Slider
        defaultValue={defaultValue}
        startingValue={startingValue}
        maxValue={maxValue}
        isStepped={isStepped}
        stepSize={stepSize}
        leftIcon={leftIcon}
        rightIcon={rightIcon}
        onChange={onChange}
        disabled={disabled}
        showValue={showValue}
        valueSuffix={valueSuffix}
        ariaLabel={ariaLabel}
      />
    </div>
  );
};

interface SliderProps {
  defaultValue: number;
  startingValue: number;
  maxValue: number;
  isStepped: boolean;
  stepSize: number;
  leftIcon: React.ReactNode;
  rightIcon: React.ReactNode;
  onChange?: (value: number) => void;
  disabled: boolean;
  showValue: boolean;
  valueSuffix: string;
  ariaLabel?: string;
}

const Slider: React.FC<SliderProps> = ({
  defaultValue,
  startingValue,
  maxValue,
  isStepped,
  stepSize,
  leftIcon,
  rightIcon,
  onChange,
  disabled,
  showValue,
  valueSuffix,
  ariaLabel,
}) => {
  const [value, setValue] = useState<number>(defaultValue);
  const sliderRef = useRef<HTMLDivElement>(null);
  const [region, setRegion] = useState<"left" | "middle" | "right">("middle");
  const clientX = useMotionValue(0);
  const overflow = useMotionValue(0);
  const scale = useMotionValue(1);

  // Синхронизация с управляемым значением без useEffect (правка состояния при
  // изменении пропа — рекомендованный React-паттерн, без каскадных ре-рендеров).
  const [prevDefault, setPrevDefault] = useState<number>(defaultValue);
  if (defaultValue !== prevDefault) {
    setPrevDefault(defaultValue);
    setValue(defaultValue);
  }

  useMotionValueEvent(clientX, "change", (latest: number) => {
    if (sliderRef.current) {
      const { left, right } = sliderRef.current.getBoundingClientRect();
      let newValue: number;
      if (latest < left) {
        setRegion("left");
        newValue = left - latest;
      } else if (latest > right) {
        setRegion("right");
        newValue = latest - right;
      } else {
        setRegion("middle");
        newValue = 0;
      }
      overflow.jump(decay(newValue, MAX_OVERFLOW));
    }
  });

  // Единая точка применения значения: кламп, локальный стейт и колбэк наружу.
  // Используется и указателем, и клавиатурой, чтобы поведение совпадало.
  const commitValue = (raw: number) => {
    const clamped = Math.min(Math.max(raw, startingValue), maxValue);
    setValue(clamped);
    onChange?.(clamped);
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (disabled) return;
    if (e.buttons > 0 && sliderRef.current) {
      const { left, width } = sliderRef.current.getBoundingClientRect();
      let newValue =
        startingValue + ((e.clientX - left) / width) * (maxValue - startingValue);
      if (isStepped) {
        newValue = Math.round(newValue / stepSize) * stepSize;
      }
      commitValue(newValue);
      clientX.jump(e.clientX);
    }
  };

  // Клавиатурное управление (role="slider"): стрелки — на шаг, Home/End — края,
  // PageUp/PageDown — крупный шаг. Без этого регулятор недоступен с клавиатуры.
  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (disabled) return;
    const span = maxValue - startingValue;
    const step = isStepped ? stepSize : span / 100 || 1;
    const bigStep = isStepped ? stepSize * 10 : span / 10 || step;
    let next: number | null = null;
    switch (e.key) {
      case "ArrowLeft":
      case "ArrowDown":
        next = value - step;
        break;
      case "ArrowRight":
      case "ArrowUp":
        next = value + step;
        break;
      case "PageDown":
        next = value - bigStep;
        break;
      case "PageUp":
        next = value + bigStep;
        break;
      case "Home":
        next = startingValue;
        break;
      case "End":
        next = maxValue;
        break;
      default:
        return;
    }
    e.preventDefault();
    commitValue(next);
  };

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (disabled) return;
    handlePointerMove(e);
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const handlePointerUp = () => {
    animate(overflow, 0, { type: "spring", bounce: 0.5 });
  };

  const getRangePercentage = (): number => {
    const totalRange = maxValue - startingValue;
    if (totalRange === 0) return 0;
    return ((value - startingValue) / totalRange) * 100;
  };

  // Хуки вызываем безусловно (правила хуков): прозрачность считаем всегда,
  // а для disabled подменяем готовое число ниже в style.
  const activeOpacity = useTransform(scale, [1, 1.2], [0.7, 1]);

  return (
    <>
      <motion.div
        onHoverStart={() => !disabled && animate(scale, 1.2)}
        onHoverEnd={() => animate(scale, 1)}
        onTouchStart={() => !disabled && animate(scale, 1.2)}
        onTouchEnd={() => animate(scale, 1)}
        style={{
          // Намеренно НЕ применяем scale к строке: масштаб 1.2 раздувал ползунок
          // по ширине и он вылезал за границы карточки. scale продолжает жить как
          // motion-value (его читают высота дорожки/смещение иконок) — растёт
          // только толщина дорожки, ширина остаётся в пределах контейнера.
          opacity: disabled ? 0.45 : activeOpacity,
        }}
        className={`flex w-full touch-none select-none items-center justify-center gap-4 text-[var(--text)] ${
          disabled ? "pointer-events-none" : ""
        }`}
      >
        <motion.div
          animate={{
            scale: region === "left" ? [1, 1.4, 1] : 1,
            transition: { duration: 0.25 },
          }}
          style={{
            x: useTransform(() =>
              region === "left" ? -overflow.get() / scale.get() : 0,
            ),
          }}
          className="flex items-center text-[var(--text-dim)]"
        >
          {leftIcon}
        </motion.div>

        <div
          ref={sliderRef}
          role="slider"
          aria-label={ariaLabel}
          aria-valuemin={startingValue}
          aria-valuemax={maxValue}
          aria-valuenow={Math.round(value)}
          aria-valuetext={valueSuffix ? `${Math.round(value)}${valueSuffix}` : undefined}
          aria-disabled={disabled || undefined}
          tabIndex={disabled ? -1 : 0}
          onKeyDown={handleKeyDown}
          className={`relative flex w-full flex-grow touch-none select-none items-center rounded-[var(--radius-pill)] py-4 outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] ${
            disabled ? "cursor-not-allowed" : "cursor-grab"
          }`}
          onPointerMove={handlePointerMove}
          onPointerDown={handlePointerDown}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerUp}
          onLostPointerCapture={handlePointerUp}
        >
          <motion.div
            style={{
              scaleX: useTransform(() => {
                if (sliderRef.current) {
                  const { width } = sliderRef.current.getBoundingClientRect();
                  return 1 + overflow.get() / width;
                }
                return 1;
              }),
              scaleY: useTransform(overflow, [0, MAX_OVERFLOW], [1, 0.8]),
              transformOrigin: useTransform(() => {
                if (sliderRef.current) {
                  const { left, width } = sliderRef.current.getBoundingClientRect();
                  return clientX.get() < left + width / 2 ? "right" : "left";
                }
                return "center";
              }),
              height: useTransform(scale, [1, 1.2], [6, 12]),
              marginTop: useTransform(scale, [1, 1.2], [0, -3]),
              marginBottom: useTransform(scale, [1, 1.2], [0, -3]),
            }}
            className="flex flex-grow"
          >
            <div className="relative h-full flex-grow overflow-hidden rounded-[var(--radius-pill)] bg-[var(--border-strong)]">
              <div
                className="absolute h-full rounded-[var(--radius-pill)] bg-[var(--accent)]"
                style={{ width: `${getRangePercentage()}%` }}
              />
            </div>
          </motion.div>
        </div>

        <motion.div
          animate={{
            scale: region === "right" ? [1, 1.4, 1] : 1,
            transition: { duration: 0.25 },
          }}
          style={{
            x: useTransform(() =>
              region === "right" ? overflow.get() / scale.get() : 0,
            ),
          }}
          className="flex items-center text-[var(--text-dim)]"
        >
          {rightIcon}
        </motion.div>
      </motion.div>
      {showValue && (
        <p className="text-xs font-medium tracking-wide text-[var(--text-dim)]">
          {Math.round(value)}
          {valueSuffix}
        </p>
      )}
    </>
  );
};

function decay(value: number, max: number): number {
  if (max === 0) {
    return 0;
  }
  const entry = value / max;
  const sigmoid = 2 * (1 / (1 + Math.exp(-entry)) - 0.5);
  return sigmoid * max;
}

export default ElasticSlider;
