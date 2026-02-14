import { describe, expect, test } from "bun:test";

describe("sanity", () => {
  test("true is truthy", () => {
    expect(true).toBe(true);
  });

  test("basic arithmetic", () => {
    expect(1 + 1).toBe(2);
  });
});
