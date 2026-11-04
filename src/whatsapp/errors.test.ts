import { describe, expect, it } from "vitest";
import { describeStatusErrors, errorFromResponse } from "./errors.js";

describe("error detail surfacing", () => {
  it("keeps error_data.details on a 131053 response", () => {
    const err = errorFromResponse(400, {
      error: {
        code: 131053,
        message: "Unable to upload the media used in the message",
        error_data: { details: "Media upload error: unsupported mime type" },
      },
    });
    expect(err.kind).toBe("bad-request");
    expect(err.message).toContain("Media upload error: unsupported mime type");
    expect(err.message).toContain("code 131053");
  });

  it("appends details for kinds that have a canned description", () => {
    const err = errorFromResponse(503, {
      error: { code: 131016, message: "Service unavailable", error_data: { details: "try again later" } },
    });
    expect(err.kind).toBe("unavailable");
    expect(err.message).toContain("Details: try again later");
  });

  it("summarizes a failed status's errors including details", () => {
    expect(
      describeStatusErrors({
        id: "wamid.1",
        status: "failed",
        errors: [
          {
            code: 131053,
            title: "Media upload error",
            error_data: { details: "Downloading media from the media store failed." },
          },
        ],
      }),
    ).toBe("code 131053 Media upload error — Downloading media from the media store failed.");
    expect(describeStatusErrors({ id: "wamid.2", status: "failed" })).toBe("no error detail provided");
  });

  it("does not throw on a malformed errors field", () => {
    const bogus = { id: "wamid.3", status: "failed", errors: "nope" } as unknown as Parameters<typeof describeStatusErrors>[0];
    expect(describeStatusErrors(bogus)).toBe("no error detail provided");
    const holes = { id: "wamid.4", status: "failed", errors: [null, {}] } as unknown as Parameters<typeof describeStatusErrors>[0];
    expect(describeStatusErrors(holes)).toBe("unknown error");
  });

  it("surfaces the live 131053 body's details and fbtrace_id in the agent-visible message", () => {
    // Captured verbatim from POST /agent/v1/media on 2026-11-04 (v0.1.0 sent type=document).
    const body = {
      error: {
        message: "(#131053) The declared media type is not one WhatsApp can render",
        code: 131053,
        type: "OAuthException",
        error_data: { messaging_product: "whatsapp", details: "document is not a supported media type" },
        fbtrace_id: "ATXeBzDKXHB4Ag5soW-UEuR",
      },
    };
    const err = errorFromResponse(400, body);
    expect(err.kind).toBe("bad-request");
    expect(err.details).toBe("document is not a supported media type");
    expect(err.fbtraceId).toBe("ATXeBzDKXHB4Ag5soW-UEuR");
    expect(err.message).toBe(
      "(#131053) The declared media type is not one WhatsApp can render. Details: document is not a supported media type " +
        "(HTTP 400, code 131053, fbtrace_id ATXeBzDKXHB4Ag5soW-UEuR)",
    );
  });
});
