// Клиентская инициализация (Next 15.3+): выполняется после загрузки документа и
// ДО гидрации React. Здесь поднимаем аналитику и шлём первый $pageview.
// Навигации между маршрутами ловим через onRouterTransitionStart.
// Весь код обёрнут в try/catch (по доке Next): сбой инструментации не должен
// влиять на приложение.
import { capturePageview, initAnalytics } from "@/lib/analytics/posthogClient";

try {
  initAnalytics();
  // Первый просмотр (вход на сайт) — onRouterTransitionStart на него не сработает.
  capturePageview(window.location.pathname + window.location.search);
} catch (err) {
  console.error("analytics init failed", err);
}

export function onRouterTransitionStart(url: string): void {
  try {
    capturePageview(url);
  } catch {
    // молча — навигация важнее телеметрии
  }
}
