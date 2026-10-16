import {
  defineConfig,
} from "vitest/config";

export default defineConfig({
  test: {
    include: ["**/ethereum-host.e2e.?(c|m)[jt]s?(x)"],
  },
});
