import { describe, expect, it } from "vitest";
import { MEDIA_CONSTRAINTS, validateMedia } from "./media.js";

const MiB = 1024 * 1024;

describe("document size limit", () => {
  it("is 16 MiB (Agent Platform), not the Cloud API's 100 MB", () => {
    expect(MEDIA_CONSTRAINTS.document.maxBytes).toBe(16 * MiB);
  });

  it("accepts a PDF at exactly 16 MiB and rejects one byte over", () => {
    expect(validateMedia("document", 16 * MiB, "application/pdf")).toBeNull();
    expect(validateMedia("document", 16 * MiB + 1, "application/pdf")).toMatch(/exceeds the 16MB limit/);
  });
});
