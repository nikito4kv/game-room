// Общие константы аналитики. Дефолтный хост приёма событий PostHog (ingestion)
// для региона EU — используется и клиентом (posthog-js), и сервером (posthog-node),
// чтобы значение не расходилось по копиям. Переопределяется через
// NEXT_PUBLIC_POSTHOG_HOST. Внимание: API-хост для экспорта (eu.posthog.com,
// без «i.») задаётся отдельно в scripts/analytics-export.mjs.
export const DEFAULT_POSTHOG_INGESTION_HOST = "https://eu.i.posthog.com";
