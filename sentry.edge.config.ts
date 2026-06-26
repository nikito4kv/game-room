// Инициализация Sentry для edge-рантайма (middleware и edge Route Handlers).
// Подключается из src/instrumentation.ts (register), когда NEXT_RUNTIME === "edge".
// Опции — общие, из одной точки правды. Без DSN — no-op.
import * as Sentry from "@sentry/nextjs";
import { sentryCommonOptions } from "@/lib/observability/sentryOptions";

Sentry.init(sentryCommonOptions);
