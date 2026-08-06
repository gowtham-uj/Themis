import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts", "tests/**/*.test.tsx"],
    testTimeout: 30_000,
    // Default node env keeps existing suite fast; UI tests opt into jsdom.
    environment: "node",
  },
  esbuild: {
    jsx: "automatic",
  },
});
