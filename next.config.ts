import type { NextConfig } from "next";
import { withSentryConfig } from "@sentry/nextjs";

const nextConfig: NextConfig = {
  /* config options here */
};

// Обёртка Sentry: загрузка source maps включается только при наличии
// SENTRY_AUTH_TOKEN (плагин сам читает его из env); без токена сборка проходит,
// загрузка тихо пропускается. telemetry/silent — чтобы плагин не шумел и не слал
// свою телеметрию.
export default withSentryConfig(nextConfig, {
  org: process.env.SENTRY_ORG,
  project: process.env.SENTRY_PROJECT,
  silent: true,
  telemetry: false,
});
