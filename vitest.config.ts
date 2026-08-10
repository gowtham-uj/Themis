import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts", "tests/**/*.test.tsx"],
    testTimeout: 120_000,
    hookTimeout: 120_000,
    // Default node env keeps existing suite fast; UI tests opt into jsdom.
    environment: "node",
  },
  esbuild: {
    jsx: "automatic",
  },
});
