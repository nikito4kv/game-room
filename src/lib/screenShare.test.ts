import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildRoomOptions,
  detectOS,
  pickScreenShareCodec,
} from "@/lib/screenShare";

// Окружение тестов — node (см. vitest.config), браузерных глобалов нет.
// Мокаем navigator / RTCRtpSender перед каждым кейсом.
function stubNavigator(nav: unknown) {
  vi.stubGlobal("navigator", nav);
}
function stubH264(supported: boolean) {
  vi.stubGlobal("RTCRtpSender", {
    getCapabilities: () => ({
      codecs: [{ mimeType: supported ? "video/H264" : "video/VP8" }],
    }),
  });
}

afterEach(() => vi.unstubAllGlobals());

describe("detectOS", () => {
  it("Windows через userAgentData", () => {
    stubNavigator({ userAgentData: { platform: "Windows" }, userAgent: "" });
    expect(detectOS()).toBe("windows");
  });
  it("macOS через userAgent", () => {
    stubNavigator({
      userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
    });
    expect(detectOS()).toBe("macos");
  });
  it("iOS через userAgent", () => {
    stubNavigator({
      userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)",
    });
    expect(detectOS()).toBe("ios");
  });
  it("Linux через userAgent", () => {
    stubNavigator({ userAgent: "Mozilla/5.0 (X11; Linux x86_64)" });
    expect(detectOS()).toBe("linux");
  });
  it("SSR (нет navigator) → unknown", () => {
    stubNavigator(undefined);
    expect(detectOS()).toBe("unknown");
  });
});

describe("pickScreenShareCodec", () => {
  it("Windows + поддержка h264 → h264", () => {
    stubNavigator({ userAgentData: { platform: "Windows" }, userAgent: "" });
    stubH264(true);
    expect(pickScreenShareCodec()).toBe("h264");
  });
  it("Windows без поддержки h264 → vp8", () => {
    stubNavigator({ userAgentData: { platform: "Windows" }, userAgent: "" });
    stubH264(false);
    expect(pickScreenShareCodec()).toBe("vp8");
  });
  it("Windows без RTCRtpSender → vp8", () => {
    stubNavigator({ userAgentData: { platform: "Windows" }, userAgent: "" });
    vi.stubGlobal("RTCRtpSender", undefined);
    expect(pickScreenShareCodec()).toBe("vp8");
  });
  it("macOS → vp8 даже при наличии h264", () => {
    stubNavigator({
      userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
    });
    stubH264(true);
    expect(pickScreenShareCodec()).toBe("vp8");
  });
  it("SSR → vp8", () => {
    stubNavigator(undefined);
    expect(pickScreenShareCodec()).toBe("vp8");
  });
});

describe("buildRoomOptions", () => {
  it("всегда backupCodec:false и maintain-framerate; кодек по ОС", () => {
    stubNavigator({ userAgentData: { platform: "Windows" }, userAgent: "" });
    stubH264(true);
    const o = buildRoomOptions();
    expect(o.webAudioMix).toBe(true);
    expect(o.publishDefaults?.backupCodec).toBe(false);
    expect(o.publishDefaults?.degradationPreference).toBe("maintain-framerate");
    expect(o.publishDefaults?.videoCodec).toBe("h264");
    expect(o.publishDefaults?.screenShareEncoding).toEqual({
      maxBitrate: 1_500_000,
      maxFramerate: 30,
    });
  });
});
