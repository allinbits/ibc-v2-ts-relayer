import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import {
  log,
} from "./logging";

describe("log (winston logger)", () => {
  let infoSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    infoSpy = vi.spyOn(log, "info");
    errorSpy = vi.spyOn(log, "error");
  });

  afterEach(() => {
    infoSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it("should log info messages", () => {
    log.info("Test info message");
    expect(infoSpy).toHaveBeenCalledWith("Test info message");
  });

  it("should log error messages", () => {
    log.error("Test error message");
    expect(errorSpy).toHaveBeenCalledWith("Test error message");
  });

  it("should support metadata", () => {
    log.info(
      "Test with meta",
      {
        foo: "bar",
      },
    );
    expect(infoSpy).toHaveBeenCalledWith(
      "Test with meta",
      {
        foo: "bar",
      },
    );
  });
});
