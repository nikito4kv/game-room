// Инициализация Sentry для Node-рантайма. Подключается из src/instrumentation.ts
// (register), когда NEXT_RUNTIME === "nodejs". Опции — общие, из одной точки
// правды. Без DSN — no-op.
import * as Sentry from "@sentry/nextjs";
import { sentryCommonOptions } from "@/lib/observability/sentryOptions";

Sentry.init(sentryCommonOptions);
