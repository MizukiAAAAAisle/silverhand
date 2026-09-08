import { describe, expect, it } from "vitest";
import { describeProtocolSkew } from "./protocol-skew-presentation";

describe("describeProtocolSkew", () => {
  it("renders nothing when the field is absent (embedded / pre-probe)", () => {
    expect(describeProtocolSkew(null)).toBeNull();
  });

  it("renders nothing when protocols match", () => {
    expect(
      describeProtocolSkew({
        status: "compatible",
        app_protocol_version: 7,
        server_protocol_version: 7,
      }),
    ).toBeNull();
  });

  it("stays silent on unknown (older server predates the signal)", () => {
    // The whole point of `unknown`: never raise a false "please update"
    // alarm just because the server can't advertise its version.
    expect(
      describeProtocolSkew({
        status: "unknown",
        app_protocol_version: 7,
        server_protocol_version: null,
      }),
    ).toBeNull();
  });

  it("asks the user to update the app when the app is behind", () => {
    const view = describeProtocolSkew({
      status: "app_update_required",
      app_protocol_version: 7,
      server_protocol_version: 8,
    });
    expect(view).not.toBeNull();
    // Names Silverhand + an update directive — the actionable app-behind arm.
    expect(view?.title).toMatch(/silverhand update required/i);
    expect(`${view?.title} ${view?.detail ?? ""}`.toLowerCase()).toContain("update silverhand");
  });

  it("does NOT tell the user to update the app when the server is behind", () => {
    const view = describeProtocolSkew({
      status: "server_update_required",
      app_protocol_version: 8,
      server_protocol_version: 7,
    });
    expect(view).not.toBeNull();
    // Guard the invariant Alice/Cindy pinned: the server-behind arm must
    // never point the user at an app update they can't act on — it must not
    // even mention Silverhand.
    const combined = `${view?.title} ${view?.detail ?? ""}`.toLowerCase();
    expect(combined).not.toContain("silverhand");
    expect(combined).toContain("server");
    expect(combined).toContain("agent operations");
  });
});
