import {
  defineConfig,
} from "vitest/config";

export default defineConfig({
  test: {
    include: ["**/txs.e2e.?(c|m)[jt]s?(x)"],
    coverage: {
      provider: "istanbul", // or 'v8'
    },
  },
});
