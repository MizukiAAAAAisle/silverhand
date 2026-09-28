import { describe, expect, it } from "vitest";
import { maskToken } from "./connection-command-card";

describe("maskToken", () => {
  const command =
    "npx @silverhand-ai/daemon@latest connect --server-url https://hub.example --connect-token ct_live_SECRET123";
  const token = "ct_live_SECRET123";

  it("hides the token in the masked display", () => {
    const masked = maskToken(command, token);
    expect(masked).not.toContain(token);
    expect(masked).toContain("****");
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
