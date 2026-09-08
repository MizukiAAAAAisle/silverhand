import { describe, expect, it } from "vitest";
import { formatOsShort } from "./format-os";

/**
 * #task:809 polish — pure `formatOsShort` test. Pins the shapes the
 * daemon's `composeHostOs()` actually emits (per
 * `packages/host/src/daemon/host-os.ts`) so a future change to that
 * formatter or this helper trips a test rather than silently
 * lengthening the System card.
 */

describe("formatOsShort", () => {
  it("passes macOS sw_vers output through unchanged", () => {
    expect(formatOsShort("macOS 15.0.1")).toBe("macOS 15.0.1");
    expect(formatOsShort("macOS 26.0")).toBe("macOS 26.0");
  });

  it("passes the macOS kernel fallback through unchanged", () => {
    expect(formatOsShort("macOS 24.0.0")).toBe("macOS 24.0.0");
  });

  it('strips trailing " LTS" decoration from Ubuntu/Debian PRETTY_NAME', () => {
    expect(formatOsShort("Ubuntu 22.04.4 LTS")).toBe("Ubuntu 22.04.4");
    expect(formatOsShort("Ubuntu 24.04 LTS")).toBe("Ubuntu 24.04");
  });

  it("strips a trailing parenthesized codename / edition", () => {
    expect(formatOsShort("Debian GNU/Linux 12 (bookworm)")).toBe("Debian GNU/Linux 12");
    expect(formatOsShort("Fedora Linux 40 (Workstation Edition)")).toBe("Fedora Linux 40");
  });

  it("strips a trailing macOS build code if a future caller appends one", () => {
    // Defensive: composeHostOs() doesn't currently emit this shape, but
    // a future swap to `sw_vers -productVersion -buildVersion` style
    // would — the helper should still hide it.
    expect(formatOsShort("macOS 15.0.1 (24A335)")).toBe("macOS 15.0.1");
  });

  it("strips both a paren suffix and an LTS marker (whichever the daemon emits)", () => {
    // Hypothetical "Ubuntu 22.04.4 LTS (Jammy Jellyfish)" — strip both.
    expect(formatOsShort("Ubuntu 22.04.4 LTS (Jammy Jellyfish)")).toBe("Ubuntu 22.04.4");
  });

  it("leaves short distro names untouched", () => {
    expect(formatOsShort("Arch Linux")).toBe("Arch Linux");
    expect(formatOsShort("Linux 6.5.0-27-generic")).toBe("Linux 6.5.0-27-generic");
  });

  it("leaves the Windows / generic fallback shape untouched", () => {
    expect(formatOsShort("win32 10.0.19045")).toBe("win32 10.0.19045");
    expect(formatOsShort("freebsd 13.2-RELEASE")).toBe("freebsd 13.2-RELEASE");
  });

  it("does not collapse mid-string parens (rare but possible)", () => {
    // Hypothetical "Linux (custom) 6.5" — middle paren survives,
    // trailing suffix would strip if present.
    expect(formatOsShort("Linux (custom) 6.5")).toBe("Linux (custom) 6.5");
  });

  it("falls back to the original input on an empty result", () => {
    // Edge: if the daemon emits something like "(unknown)" the regex
    // would empty it — keep the raw string so we never render nothing.
    expect(formatOsShort("(unknown)")).toBe("(unknown)");
  });

  it("handles non-string input defensively", () => {
    // composeHostOs() is typed to return string, but renderer-side this
    // helper sees `snapshot.os: string` via zod. Defensive trim still
    // OK — empty in, empty out.
    expect(formatOsShort("")).toBe("");
  });
});
