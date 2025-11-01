import {
  defineConfig,
} from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    exclude: ["dist/**", "node_modules/**", "e2e/**"],
    coverage: {
      provider: "istanbul", // or 'v8'
    },
  },
});
