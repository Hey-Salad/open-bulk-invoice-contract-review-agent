import * as entry from "../src/index";
import { describe, expect, it } from "vitest";

describe("entry module exports", () => {
  it("exports only the default handler and Durable Object classes", () => {
    const named = Object.entries(entry).filter(([name]) => name !== "default");

    expect(named.map(([name]) => name)).toEqual(["GlobalSessionLimiter"]);
    for (const [name, value] of named) {
      expect(typeof value, name).toBe("function");
    }

    expect(typeof entry.default).toBe("object");
    expect(typeof entry.default.fetch).toBe("function");
  });
});
