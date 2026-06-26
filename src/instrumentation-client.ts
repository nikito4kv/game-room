// Клиентская инициализация (Next 15.3+): выполняется после загрузки документа и
// ДО гидрации React. Здесь поднимаем телеметрию (Sentry + аналитику) и шлём
// первый $pageview. Навигации между маршрутами ловим через onRouterTransitionStart.
// Каждая телеметрия — в своём try/catch (по доке Next): сбой инструментации не
// должен влиять на приложение, и сбой одной не должен валить другую.
import * as Sentry from "@sentry/nextjs";
import { capturePageview, initAnalytics } from "@/lib/analytics/posthogClient";
import { sentryCommonOptions } from "@/lib/observability/sentryOptions";

// Sentry первым: чтобы поймать в том числе сбой инициализации аналитики ниже.
try {
  Sentry.init(sentryCommonOptions);
} catch (err) {
  console.error("sentry init failed", err);
}

try {
  initAnalytics();
  // Первый просмотр (вход на сайт) — onRouterTransitionStart на него не сработает.
  capturePageview(window.location.pathname + window.location.search);
} catch (err) {
  console.error("analytics init failed", err);
}

export function onRouterTransitionStart(
  url: string,
  navigationType: "push" | "replace" | "traverse",
): void {
  // Sentry-навигация и аналитика независимы: сбой одной не мешает другой.
  try {
    Sentry.captureRouterTransitionStart(url, navigationType);
  } catch {
    // молча — навигация важнее телеметрии
  }
  try {
    capturePageview(url);
  } catch {
    // молча — навигация важнее телеметрии
  }
}
