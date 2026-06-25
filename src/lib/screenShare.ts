// Настройки демонстрации экрана (screen share) для LiveKit.
// Единое место для профиля захвата/кодирования и выбора видеокодека под ОС —
// чтобы UI-компонент комнаты оставался тонким, а значения профиля не разъезжались.
//
// Базовый уровень — НАМЕРЕННО лёгкий: 480p@30fps. Цель — экономный, плавный поток
// для динамичного контента (игры), а не максимальная чёткость. Плавность даёт связка
// degradationPreference 'maintain-framerate' + поднятый fps/битрейт, а НЕ смена кодека
// на «более качественный» (vp9/av1): для screen share они в LiveKit включают SVC-режим
// L1T3 (~5 fps в Chrome, помечен в исходниках как buggy/untested) и тянут backup-дорожку.

import type { RoomOptions } from "livekit-client";

/**
 * Целевой профиль ЗАХВАТА экрана (getDisplayMedia). От ОС не зависит.
 * Разрешение задаётся только тут — в screenShareEncoding поля resolution нет.
 */
export const SCREEN_SHARE_CAPTURE = {
  width: 854, // 16:9 480p (853.33 → 854)
  height: 480,
  frameRate: 30,
} as const;

/**
 * Профиль КОДИРОВАНИЯ (битрейт/фреймрейт). Без resolution.
 * 1.5 Мбит/с — разумная середина для 480p30 motion-контента (диапазон ~1.2–2.0).
 */
export const SCREEN_SHARE_ENCODING = {
  maxBitrate: 1_500_000,
  maxFramerate: 30,
} as const;

export type DetectedOS = "windows" | "macos" | "ios" | "linux" | "unknown";

/** Современный Client Hints API; в типах DOM пока неполный — читаем аккуратно. */
type UADataLike = { platform?: string };

/**
 * Грубое определение ОS клиента. Нужно, т.к. готовых кросс-ОС хелперов у LiveKit нет
 * (его getBrowser().os различает только iOS/macOS и помечен @internal).
 * Приоритет — navigator.userAgentData.platform (точнее), затем regex по userAgent.
 * На сервере (SSR, нет navigator) → "unknown".
 */
export function detectOS(): DetectedOS {
  if (typeof navigator === "undefined") return "unknown";

  const uaData = (navigator as Navigator & { userAgentData?: UADataLike })
    .userAgentData;
  const platform = uaData?.platform?.toLowerCase();
  if (platform) {
    if (platform.includes("win")) return "windows";
    if (platform.includes("mac")) return "macos";
    if (platform.includes("linux") || platform.includes("android"))
      return "linux";
  }

  const ua = navigator.userAgent.toLowerCase();
  if (/iphone|ipad|ipod/.test(ua)) return "ios";
  if (/windows|win32|win64/.test(ua)) return "windows";
  if (/macintosh|mac os x/.test(ua)) return "macos";
  if (/android|linux|x11/.test(ua)) return "linux";
  return "unknown";
}

/** Реально ли браузер умеет кодировать H.264 (а не только заявляет в UA). */
function supportsH264Encode(): boolean {
  if (
    typeof RTCRtpSender === "undefined" ||
    typeof RTCRtpSender.getCapabilities !== "function"
  ) {
    return false;
  }
  const caps = RTCRtpSender.getCapabilities("video");
  return !!caps?.codecs.some((c) => /video\/h264/i.test(c.mimeType));
}

/**
 * Выбор видеокодека под ОС демонстрирующего:
 *  - Windows → H.264 (аппаратное кодирование NVENC/QuickSync/VCE разгружает CPU,
 *    важно когда параллельно крутится игра), но только если браузер реально его кодирует;
 *  - macOS/iOS/Linux/неизвестно/SSR → VP8 (безопасный софтовый дефолт, низкая задержка).
 * И vp8, и h264 — НЕ SVC-кодеки: идут через надёжный simulcast-путь без L1T3-проблемы.
 */
export function pickScreenShareCodec(): "h264" | "vp8" {
  if (detectOS() === "windows" && supportsH264Encode()) return "h264";
  return "vp8";
}

/**
 * Полный RoomOptions для <LiveKitRoom>. Строится на клиенте (зависит от navigator),
 * поэтому вызывать через useMemo(…, []) — один раз, со стабильной ссылкой, иначе
 * LiveKit пересоздаёт Room.
 *
 * webAudioMix: приём звука через общий AudioContext — чтобы громкость участника можно
 * было поднимать ВЫШЕ 100% (через gain); иначе LiveKit пишет в HTMLMediaElement.volume
 * напрямую и значение >1 роняет ошибку.
 *
 * backupCodec:false — критично при h264: с дефолтным backupCodec:true LiveKit добавил бы
 * вторую vp8-дорожку и авто-включил dynacast (двойное кодирование, нагрузка на CPU/канал).
 * H.264 декодит практически всё, резервная дорожка не нужна.
 */
export function buildRoomOptions(): RoomOptions {
  return {
    webAudioMix: true,
    publishDefaults: {
      degradationPreference: "maintain-framerate",
      screenShareEncoding: { ...SCREEN_SHARE_ENCODING },
      videoCodec: pickScreenShareCodec(),
      backupCodec: false,
    },
  };
}
