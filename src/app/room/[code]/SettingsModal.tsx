"use client";

import { useEffect, useRef, useState } from "react";
import { useMediaDeviceSelect } from "@livekit/components-react";
import { supportsAudioOutputSelection } from "livekit-client";
import { setInputDevice, setOutputDevice } from "@/lib/clientStorage";
import { startMicTest, type MicTest } from "@/lib/audio/micTest";

/**
 * Окно настроек звука (Этап 5a). Рендерится внутри комнаты, поэтому имеет доступ
 * к контексту LiveKit (useMediaDeviceSelect переключает реальные устройства).
 *
 * Громкость приёма (masterVolume) и усиление микрофона (inputGain) живут выше —
 * сюда приходят значениями + колбэками, чтобы их видел и плеер звука, и процессор.
 */
export default function SettingsModal({
  onClose,
  masterVolume,
  onChangeMasterVolume,
  inputGain,
  onChangeInputGain,
}: {
  onClose: () => void;
  masterVolume: number;
  onChangeMasterVolume: (v: number) => void;
  inputGain: number;
  onChangeInputGain: (v: number) => void;
}) {
  // requestPermissions:true — чтобы получить названия устройств (в комнате доступ
  // к микрофону уже есть, повторного запроса не будет).
  const micSel = useMediaDeviceSelect({ kind: "audioinput", requestPermissions: true });
  const spkSel = useMediaDeviceSelect({ kind: "audiooutput" });
  const canPickOutput = supportsAudioOutputSelection();

  // Закрытие по Esc.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onClick={onClose}
    >
      <div
        className="flex max-h-[90vh] w-full max-w-lg flex-col gap-6 overflow-y-auto rounded-lg border border-zinc-200 bg-white p-6 shadow-xl dark:border-zinc-800 dark:bg-zinc-900"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-bold">Настройки звука</h2>
          <button
            onClick={onClose}
            aria-label="Закрыть"
            className="rounded-md border border-zinc-300 px-2 py-1 text-sm dark:border-zinc-700 dark:hover:bg-zinc-800 hover:bg-zinc-100"
          >
            ✕
          </button>
        </div>

        {/* ── Микрофон ─────────────────────────────────────────── */}
        <section className="flex flex-col gap-3">
          <h3 className="text-sm font-semibold text-zinc-500">Микрофон</h3>

          <label className="flex flex-col gap-1 text-sm">
            Устройство
            <select
              value={micSel.activeDeviceId}
              onChange={(e) => {
                const id = e.target.value;
                void micSel.setActiveMediaDevice(id);
                setInputDevice(id);
              }}
              className="rounded-md border border-zinc-300 px-2 py-1.5 dark:border-zinc-700 dark:bg-zinc-800"
            >
              {micSel.devices.map((d) => (
                <option key={d.deviceId} value={d.deviceId}>
                  {d.label || "Микрофон"}
                </option>
              ))}
            </select>
          </label>

          <Slider
            label="Громкость микрофона"
            value={Math.round(inputGain * 100)}
            min={0}
            max={200}
            onChange={(v) => onChangeInputGain(v / 100)}
            suffix="%"
          />

          <MicTester deviceId={micSel.activeDeviceId} gain={inputGain} />
        </section>

        {/* ── Вывод ────────────────────────────────────────────── */}
        <section className="flex flex-col gap-3">
          <h3 className="text-sm font-semibold text-zinc-500">Звук участников</h3>

          {canPickOutput ? (
            <label className="flex flex-col gap-1 text-sm">
              Устройство вывода
              <select
                value={spkSel.activeDeviceId}
                onChange={(e) => {
                  const id = e.target.value;
                  void spkSel.setActiveMediaDevice(id);
                  setOutputDevice(id);
                }}
                className="rounded-md border border-zinc-300 px-2 py-1.5 dark:border-zinc-700 dark:bg-zinc-800"
              >
                {spkSel.devices.map((d) => (
                  <option key={d.deviceId} value={d.deviceId}>
                    {d.label || "Устройство вывода"}
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <p className="text-xs text-zinc-400">
              Выбор устройства вывода не поддерживается этим браузером.
            </p>
          )}

          <Slider
            label="Общая громкость"
            value={Math.round(masterVolume * 100)}
            min={0}
            max={100}
            onChange={(v) => onChangeMasterVolume(v / 100)}
            suffix="%"
          />
          <p className="text-xs text-zinc-400">
            Громкость каждого участника отдельно настраивается в списке справа.
          </p>
        </section>
      </div>
    </div>
  );
}

/** Простой ползунок с подписью и значением. */
function Slider({
  label,
  value,
  min,
  max,
  onChange,
  suffix = "",
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  onChange: (v: number) => void;
  suffix?: string;
}) {
  return (
    <label className="flex flex-col gap-1 text-sm">
      <span className="flex justify-between">
        {label}
        <span className="tabular-nums text-zinc-500">
          {value}
          {suffix}
        </span>
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={5}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="accent-emerald-600"
      />
    </label>
  );
}

/**
 * Проверка микрофона: полоска уровня + «слышать себя» (loopback). Использует
 * собственный getUserMedia (не зависит от комнаты). Тест останавливается при
 * закрытии окна / смене устройства — иначе горит индикатор микрофона ОС.
 */
function MicTester({ deviceId, gain }: { deviceId: string; gain: number }) {
  const [testing, setTesting] = useState(false);
  const [loopback, setLoopback] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const testRef = useRef<MicTest | null>(null);
  const rafRef = useRef<number | null>(null);
  // Уровень рисуем напрямую через ref, без setState — иначе ~60 ре-рендеров в
  // секунду на время теста ради ширины одной полоски.
  const barRef = useRef<HTMLDivElement | null>(null);

  // Останавливаем тест и освобождаем микрофон.
  const stop = () => {
    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
    void testRef.current?.stop();
    testRef.current = null;
    if (barRef.current) barRef.current.style.width = "0%";
  };

  // Старт/стоп по флагу testing. deviceId в зависимостях — при смене устройства
  // тест перезапускается на новый микрофон.
  useEffect(() => {
    if (!testing) return;
    let cancelled = false;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- сброс ошибки при старте теста
    setError(null);
    void startMicTest(deviceId, gain)
      .then((t) => {
        if (cancelled) {
          void t.stop();
          return;
        }
        testRef.current = t;
        t.setLoopback(loopback);
        const tick = () => {
          if (barRef.current) {
            barRef.current.style.width = `${Math.round(t.level() * 100)}%`;
          }
          rafRef.current = requestAnimationFrame(tick);
        };
        tick();
      })
      .catch(() => {
        if (!cancelled) setError("Не удалось открыть микрофон для проверки.");
      });
    return () => {
      cancelled = true;
      stop();
    };
    // loopback намеренно не в deps — им управляет отдельный эффект ниже.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [testing, deviceId]);

  // Живое изменение усиления и loopback без перезапуска теста.
  useEffect(() => {
    testRef.current?.setGain(gain);
  }, [gain]);
  useEffect(() => {
    testRef.current?.setLoopback(loopback);
  }, [loopback]);

  return (
    <div className="flex flex-col gap-2 rounded-md border border-zinc-200 p-3 dark:border-zinc-800">
      <div className="flex items-center justify-between">
        <span className="text-sm">Проверка микрофона</span>
        <button
          onClick={() => setTesting((v) => !v)}
          className={
            "rounded-md px-3 py-1 text-sm font-medium " +
            (testing
              ? "border border-zinc-300 dark:border-zinc-700"
              : "bg-emerald-600 text-white hover:bg-emerald-500")
          }
        >
          {testing ? "Остановить" : "Проверить"}
        </button>
      </div>

      {/* Полоска уровня громкости (ширину двигаем через barRef в rAF). */}
      <div className="h-3 w-full overflow-hidden rounded bg-zinc-200 dark:bg-zinc-700">
        <div
          ref={barRef}
          className="h-full bg-emerald-500 transition-[width] duration-75"
          style={{ width: "0%" }}
        />
      </div>

      {testing && (
        <label className="flex items-center gap-2 text-xs text-zinc-500">
          <input
            type="checkbox"
            checked={loopback}
            onChange={(e) => setLoopback(e.target.checked)}
            className="accent-emerald-600"
          />
          Слышать себя (наденьте наушники, чтобы не было эха)
        </label>
      )}

      {!testing && (
        <p className="text-xs text-zinc-400">
          Нажмите «Проверить» и скажите что-нибудь — полоска должна двигаться.
        </p>
      )}

      {error && <p className="text-xs text-red-500">{error}</p>}
    </div>
  );
}
