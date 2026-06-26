// Серверная инструментация Next 16. register() вызывается один раз при старте
// инстанса сервера: грузим нужный конфиг Sentry по рантайму. onRequestError —
// хук Next (см. node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/instrumentation.md),
// через него Sentry ловит ошибки серверных Route Handlers / RSC.
import * as Sentry from "@sentry/nextjs";

export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    await import("../sentry.server.config");
  }
  if (process.env.NEXT_RUNTIME === "edge") {
    await import("../sentry.edge.config");
  }
}

export const onRequestError = Sentry.captureRequestError;
