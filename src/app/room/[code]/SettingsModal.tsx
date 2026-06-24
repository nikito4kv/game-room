"use client";

import { useEffect, useRef, useState } from "react";
import { useMediaDeviceSelect } from "@livekit/components-react";
import { supportsAudioOutputSelection } from "livekit-client";
import { getSfxEnabled, getSfxVolume, setInputDevice, setOutputDevice } from "@/lib/clientStorage";
import { playSfx, setSfxEnabled, setSfxVolume } from "@/lib/audio/sfx";
import { startMicTest, type MicTest } from "@/lib/audio/micTest";
import Icon from "@/components/Icon";

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

  // Звуки интерфейса: своё локальное состояние, источник правды — localStorage.
  // Сеттеры из sfx.ts сразу и персистят, и обновляют горячую копию в модуле.
  const [sfxOn, setSfxOn] = useState(getSfxEnabled);
  const [sfxVol, setSfxVol] = useState(getSfxVolume);

  // Закрытие по Esc.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Настройки звука"
        className="modal"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <h2 className="flex items-center gap-2 text-lg font-bold">
            <Icon name="sliders" size={22} className="text-accent-hi" />
            Настройки звука
          </h2>
          <button onClick={onClose} aria-label="Закрыть" className="btn btn--ghost btn--icon">
            <Icon name="close" />
          </button>
        </div>

        {/* ── Микрофон ─────────────────────────────────────────── */}
        <section className="flex flex-col gap-3">
          <h3 className="panel-h flex items-center gap-2">
            <Icon name="mic" size={15} /> Микрофон
          </h3>

          <label className="field-label">
            Устройство
            <select
              value={micSel.activeDeviceId}
              onChange={(e) => {
                const id = e.target.value;
                void micSel.setActiveMediaDevice(id);
                setInputDevice(id);
              }}
              className="field"
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
          <h3 className="panel-h flex items-center gap-2">
            <Icon name="volume" size={15} /> Звук участников
          </h3>

          {canPickOutput ? (
            <label className="field-label">
              Устройство вывода
              <select
                value={spkSel.activeDeviceId}
                onChange={(e) => {
                  const id = e.target.value;
                  void spkSel.setActiveMediaDevice(id);
                  setOutputDevice(id);
                }}
                className="field"
              >
                {spkSel.devices.map((d) => (
                  <option key={d.deviceId} value={d.deviceId}>
                    {d.label || "Устройство вывода"}
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <p className="text-xs text-text-mute">
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
          <p className="text-xs text-text-mute">
            Громкость каждого участника отдельно настраивается в списке отряда.
          </p>
        </section>

        {/* ── Звуки интерфейса ─────────────────────────────────── */}
        <section className="flex flex-col gap-3">
          <h3 className="panel-h flex items-center gap-2">
            <Icon name="volume" size={15} /> Звуки интерфейса
          </h3>

          <label className="flex cursor-pointer items-center justify-between gap-3 text-sm text-text-dim">
            <span>Клики, вход/выход, уведомления</span>
            <input
              type="checkbox"
              checked={sfxOn}
              onChange={(e) => {
                const on = e.target.checked;
                setSfxOn(on);
                setSfxEnabled(on);
                if (on) playSfx("mic-on", { urgent: true }); // короткий предпросмотр
              }}
            />
          </label>

          {sfxOn && (
            <Slider
              label="Громкость звуков"
              value={Math.round(sfxVol * 100)}
              min={0}
              max={100}
              onChange={(v) => {
                const vol = v / 100;
                setSfxVol(vol);
                setSfxVolume(vol);
                playSfx("mic-on", { urgent: true }); // слышно выбранный уровень
              }}
              suffix="%"
            />
          )}
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
    <label className="flex flex-col gap-1.5 text-sm text-text-dim">
      <span className="flex justify-between">
        {label}
        <span className="tabular-nums text-text">
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
  // Свежее усиление: тест стартует асинхронно (getUserMedia + resume), и gain мог
  // измениться за это время — берём актуальное из ref, а не захваченное в аргументе.
  const gainRef = useRef(gain);
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
        t.setGain(gainRef.current); // применяем свежее усиление (могло смениться при старте)
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
    gainRef.current = gain;
    testRef.current?.setGain(gain);
  }, [gain]);
  useEffect(() => {
    testRef.current?.setLoopback(loopback);
  }, [loopback]);

  return (
    <div className="flex flex-col gap-2 rounded-[var(--radius)] border border-border bg-inset p-3">
      <div className="flex items-center justify-between">
        <span className="text-sm">Проверка микрофона</span>
        <button
          onClick={() => setTesting((v) => !v)}
          className={"btn btn--sm" + (testing ? "" : " btn--live")}
        >
          {testing ? "Остановить" : "Проверить"}
        </button>
      </div>

      {/* Полоска уровня громкости (ширину двигаем через barRef в rAF). */}
      <div className="h-3 w-full overflow-hidden rounded-full bg-surface-2">
        <div
          ref={barRef}
          className="h-full rounded-full transition-[width] duration-75"
          style={{ width: "0%", background: "var(--live)" }}
        />
      </div>

      {testing && (
        <label className="flex items-center gap-2 text-xs text-text-mute">
          <input
            type="checkbox"
            checked={loopback}
            onChange={(e) => setLoopback(e.target.checked)}
          />
          Слышать себя (наденьте наушники, чтобы не было эха)
        </label>
      )}

      {!testing && (
        <p className="text-xs text-text-mute">
          Нажмите «Проверить» и скажите что-нибудь — полоска должна двигаться.
        </p>
      )}

      {error && <p className="text-xs text-danger">{error}</p>}
    </div>
  );
}
