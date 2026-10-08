import { describe, expect, it } from "vitest";

import { formatBytes } from "@/lib/format";

describe("formatBytes", () => {
  it.each([
    [0, "0 KB"],
    [1, "<1 KB"],
    [1023, "<1 KB"],
    [1024, "1 KB"],
    [1536, "1.5 KB"],
    [1024 ** 2, "1 MB"],
    [1024 ** 2 * 1.5, "1.5 MB"],
    [1024 ** 3, "1 GB"],
    [1024 ** 3 * 1.5, "1.5 GB"],
  ])("formats %i bytes as %s", (bytes, expected) => {
    expect(formatBytes(bytes)).toBe(expected);
  });
});
