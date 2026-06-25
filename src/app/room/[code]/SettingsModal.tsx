"use client";

import { useEffect, useRef, useState, type CSSProperties } from "react";
import { useMediaDeviceSelect } from "@livekit/components-react";
import { supportsAudioOutputSelection } from "livekit-client";
import {
  DEFAULT_KEYBINDS,
  getSfxEnabled,
  getSfxVolume,
  setInputDevice,
  setOutputDevice,
  type KeyAction,
  type Keybinds,
  type VoiceMode,
} from "@/lib/clientStorage";
import { playSfx, setSfxEnabled, setSfxVolume } from "@/lib/audio/sfx";
import { startMicTest, type MicTest } from "@/lib/audio/micTest";
import { ACTION_LABELS, formatKeyCode } from "@/lib/keys";
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
  noiseSuppression,
  onChangeNoiseSuppression,
  voiceMode,
  onChangeVoiceMode,
  binds,
  onChangeBinds,
  showKeys,
  onChangeShowKeys,
}: {
  onClose: () => void;
  masterVolume: number;
  onChangeMasterVolume: (v: number) => void;
  inputGain: number;
  onChangeInputGain: (v: number) => void;
  noiseSuppression: boolean;
  onChangeNoiseSuppression: (on: boolean) => void;
  voiceMode: VoiceMode;
  onChangeVoiceMode: (mode: VoiceMode) => void;
  binds: Keybinds;
  onChangeBinds: (binds: Keybinds) => void;
  showKeys: boolean;
  onChangeShowKeys: (on: boolean) => void;
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
        <header className="settings-header">
          <h2 className="flex items-center gap-2 text-lg font-bold">
            <Icon name="sliders" size={22} className="text-accent-hi" />
            Настройки звука
          </h2>
          <button onClick={onClose} aria-label="Закрыть" className="btn btn--ghost btn--icon">
            <Icon name="close" />
          </button>
        </header>

        {/* ── Микрофон ─────────────────────────────────────────── */}
        <section className="flex flex-col gap-3">
          <h3 className="panel-h flex items-center gap-2">
            <Icon name="mic" size={15} /> Микрофон
          </h3>

          <div className="settings-card">
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

            <SettingRow
              title="Шумоподавление"
              desc="Убирает дыхание, клавиатуру и фоновый шум"
            >
              <Toggle
                checked={noiseSuppression}
                onChange={onChangeNoiseSuppression}
                label="Шумоподавление"
              />
            </SettingRow>
          </div>

          <MicTester deviceId={micSel.activeDeviceId} gain={inputGain} />
        </section>

        {/* ── Вывод ────────────────────────────────────────────── */}
        <section className="flex flex-col gap-3">
          <h3 className="panel-h flex items-center gap-2">
            <Icon name="volume" size={15} /> Звук участников
          </h3>

          <div className="settings-card">
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
          </div>
          <p className="text-xs text-text-mute">
            Громкость каждого участника отдельно настраивается в списке отряда.
          </p>
        </section>

        {/* ── Звуки интерфейса ─────────────────────────────────── */}
        <section className="flex flex-col gap-3">
          <h3 className="panel-h flex items-center gap-2">
            <Icon name="volume" size={15} /> Интерфейс
          </h3>

          <div className="settings-card">
            <SettingRow
              title="Звуки интерфейса"
              desc="Клики, вход и выход, уведомления"
            >
              <Toggle
                checked={sfxOn}
                onChange={(on) => {
                  setSfxOn(on);
                  setSfxEnabled(on);
                  if (on) playSfx("mic-on", { urgent: true }); // короткий предпросмотр
                }}
                label="Звуки интерфейса"
              />
            </SettingRow>

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
          </div>
        </section>

        {/* ── Управление ───────────────────────────────────────── */}
        <section className="flex flex-col gap-3">
          <h3 className="panel-h flex items-center gap-2">
            <Icon name="sliders" size={15} /> Управление
          </h3>

          <div className="settings-card">
            <SettingRow
              title="Режим голоса"
              desc={
                voiceMode === "ptt"
                  ? "Рация: держите клавишу, чтобы говорить"
                  : "Открытый микрофон: передаёт постоянно"
              }
            >
              <Segmented
                value={voiceMode}
                onChange={onChangeVoiceMode}
                options={[
                  { value: "toggle", label: "Открытый" },
                  { value: "ptt", label: "Рация" },
                ]}
              />
            </SettingRow>

            <SettingRow
              title="Показывать клавиши"
              desc="Буква бинда в углу кнопок управления"
            >
              <Toggle
                checked={showKeys}
                onChange={onChangeShowKeys}
                label="Показывать клавиши"
              />
            </SettingRow>
          </div>

          {/* Привязки клавиш. Рацию показываем только в её режиме. */}
          <div className="settings-card">
            {(Object.keys(ACTION_LABELS) as KeyAction[])
              .filter((a) => a !== "ptt" || voiceMode === "ptt")
              .map((action) => (
                <BindRow
                  key={action}
                  action={action}
                  binds={binds}
                  onChangeBinds={onChangeBinds}
                />
              ))}
          </div>

          <button
            type="button"
            onClick={() => onChangeBinds(DEFAULT_KEYBINDS)}
            className="btn btn--ghost btn--sm self-start"
          >
            Сбросить к умолчанию
          </button>
        </section>
      </div>
    </div>
  );
}

/**
 * Сегмент-переключатель: ряд radio-кнопок в одной пилюле. Активная залита --accent.
 * Доступен с клавиатуры (роли radio/radiogroup, видимый фокус из .btn-токенов).
 */
function Segmented<T extends string>({
  value,
  onChange,
  options,
}: {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: string }[];
}) {
  return (
    <div className="segmented" role="radiogroup">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          onClick={() => onChange(o.value)}
          className={"segmented__btn" + (value === o.value ? " is-active" : "")}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/**
 * Строка привязки клавиши: подпись действия + кнопка с текущей клавишей. Клик по
 * кнопке включает режим захвата — следующий keydown становится новой привязкой.
 * Esc отменяет; уже занятая клавиша отклоняется с пояснением.
 */
function BindRow({
  action,
  binds,
  onChangeBinds,
}: {
  action: KeyAction;
  binds: Keybinds;
  onChangeBinds: (binds: Keybinds) => void;
}) {
  const [capturing, setCapturing] = useState(false);
  const [conflict, setConflict] = useState<KeyAction | null>(null);

  useEffect(() => {
    if (!capturing) return;
    // capture:true — перехватываем раньше горячих клавиш комнаты, чтобы нажатие
    // ушло в привязку, а не сработало как действие.
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.code === "Escape") {
        setCapturing(false);
        setConflict(null);
        return;
      }
      // Клавиша уже занята другим действием — не присваиваем, поясняем и ждём дальше.
      const taken = (Object.keys(binds) as KeyAction[]).find(
        (a) => a !== action && binds[a] === e.code,
      );
      if (taken) {
        setConflict(taken);
        return;
      }
      onChangeBinds({ ...binds, [action]: e.code });
      setCapturing(false);
      setConflict(null);
    };
    window.addEventListener("keydown", onKey, { capture: true });
    return () => window.removeEventListener("keydown", onKey, { capture: true });
  }, [capturing, binds, action, onChangeBinds]);

  return (
    <div className="setting-row">
      <span className="setting-row-text">
        <span className="setting-row-title">{ACTION_LABELS[action]}</span>
        {capturing && (
          <span className="setting-row-desc">
            {conflict ? (
              <span className="text-warn">Уже занято: {ACTION_LABELS[conflict]}</span>
            ) : (
              "Нажмите клавишу… (Esc — отмена)"
            )}
          </span>
        )}
      </span>
      <button
        type="button"
        onClick={() => {
          setCapturing((v) => !v);
          setConflict(null);
        }}
        className={"kbd kbd--btn" + (capturing ? " kbd--capturing" : "")}
        aria-label={`Клавиша для «${ACTION_LABELS[action]}»: ${formatKeyCode(binds[action])}`}
      >
        {capturing ? "…" : formatKeyCode(binds[action])}
      </button>
    </div>
  );
}

/**
 * Тумблер — кнопка role="switch" (доступнее «голого» чекбокса: фокус с клавиатуры,
 * понятная роль для скринридера). Включён = зелёный --live, как «в эфире».
 */
function Toggle({
  checked,
  onChange,
  label,
  size,
}: {
  checked: boolean;
  onChange: (on: boolean) => void;
  label: string;
  size?: "sm";
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      data-on={checked}
      onClick={() => onChange(!checked)}
      className={"switch" + (size === "sm" ? " switch--sm" : "")}
    >
      <span className="switch-thumb" />
    </button>
  );
}

/** Ряд настройки: подпись + пояснение слева, контрол (обычно тумблер) справа. */
function SettingRow({
  title,
  desc,
  children,
}: {
  title: string;
  desc?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="setting-row">
      <span className="setting-row-text">
        <span className="setting-row-title">{title}</span>
        {desc && <span className="setting-row-desc">{desc}</span>}
      </span>
      {children}
    </div>
  );
}

/** Ползунок с подписью и моноширинным отсчётом; дорожка залита до --fill. */
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
  const fill = ((value - min) / (max - min)) * 100;
  return (
    <label className="flex flex-col gap-2 text-sm text-text-dim">
      <span className="flex items-center justify-between">
        {label}
        <span className="settings-readout">
          {value}
          {suffix}
        </span>
      </span>
      <input
        type="range"
        className="range"
        min={min}
        max={max}
        step={5}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        style={{ "--fill": `${fill}%` } as CSSProperties}
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
        <div className="flex items-center justify-between gap-3 text-xs text-text-mute">
          <span>Слышать себя — наденьте наушники, чтобы не было эха</span>
          <Toggle size="sm" checked={loopback} onChange={setLoopback} label="Слышать себя" />
        </div>
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
