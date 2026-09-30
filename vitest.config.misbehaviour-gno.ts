import {
  defineConfig,
} from "vitest/config";

export default defineConfig({
  test: {
    include: ["**/misbehaviour-gno.e2e.?(c|m)[jt]s?(x)"],
    coverage: {
      provider: "istanbul", // or 'v8'
    },
  },
});
