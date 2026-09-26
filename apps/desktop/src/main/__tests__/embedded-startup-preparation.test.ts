import { describe, expect, it, vi } from "vitest";
import { prepareEmbeddedStartup } from "../embedded-startup-preparation.js";

describe("pre-child cleanup ownership", () => {
  it.each(["verification", "async launch", "sync launch"])(
    "cleans before verification and again after %s failure",
    async (fault) => {
      const error = new Error(fault);
      const order: string[] = [];
      const cleanupTokens = vi.fn(async () => {
        order.push("cleanup");
      });
      const launch = vi.fn(() => {
        order.push("launch");
        if (fault === "sync launch") throw error;
        return Promise.reject(error);
      });
      await expect(
        prepareEmbeddedStartup({
          cleanupTokens,
          verify: async () => {
            order.push("verify");
            if (fault === "verification") throw error;
            return "verified artifact";
          },
          launch,
        }),
      ).rejects.toBe(error);
      expect(order).toEqual(
        fault === "verification"
          ? ["cleanup", "verify", "cleanup"]
          : ["cleanup", "verify", "launch", "cleanup"],
      );
      if (fault === "verification") expect(launch).not.toHaveBeenCalled();
      else expect(launch).toHaveBeenCalledExactlyOnceWith("verified artifact");
    },
  );

  it("transfers the verified artifact and returns the handle without failure cleanup", async () => {
    const artifact = { executablePath: "/verified/backend" };
    const handle = { url: "http://127.0.0.1:1234" };
    const order: string[] = [];
    const result = await prepareEmbeddedStartup({
      cleanupTokens: async () => {
        order.push("cleanup");
      },
      verify: async () => {
        order.push("verify");
        return artifact;
      },
      launch: async (verified) => {
        expect(verified).toBe(artifact);
        order.push("launch");
        return handle;
      },
    });
    expect(result).toBe(handle);
    expect(order).toEqual(["cleanup", "verify", "launch"]);
  });
});
