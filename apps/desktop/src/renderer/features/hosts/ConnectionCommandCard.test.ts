import { describe, expect, it } from "vitest";
import { maskToken } from "./ConnectionCommandCard";

/**
 * #task:1348 — pin the reveal-once masking helper. The masked display
 * must hide the cleartext token; reveal (and copy) always use the
 * verbatim command, so `maskToken` must never be the copy source and
 * must not mangle the command around the token.
 */
describe("maskToken", () => {
  const command =
    "npx @silverhand-ai/daemon@latest connect --server-url https://hub.example --connect-token ct_live_SECRET123";
  const token = "ct_live_SECRET123";

  it("hides the token in the masked display", () => {
    const masked = maskToken(command, token);
    expect(masked).not.toContain(token);
    expect(masked).toContain("••••");
    // Everything around the token stays verbatim.
    expect(masked.startsWith("npx @silverhand-ai/daemon@latest connect")).toBe(true);
    expect(masked).toContain("--connect-token ");
  });

  it("is a no-op when there is no token to mask", () => {
    expect(maskToken(command, "")).toBe(command);
  });

  it("masks every occurrence of the token", () => {
    const doubled = `${token} ${token}`;
    expect(maskToken(doubled, token)).not.toContain(token);
  });
});
