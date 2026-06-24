import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

// Юнит-тесты чистой логики (без браузера/Next). Алиас @/* — как в tsconfig.
export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
