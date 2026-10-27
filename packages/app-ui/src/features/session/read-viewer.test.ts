import { describe, expect, it, vi } from "vitest";

const getAuthState = vi.fn();
vi.mock("@/platform", () => ({ getPlatform: () => ({ client: { getAuthState } }) }));

import { ApiError } from "@/lib/api";
import { readViewer } from "./hooks";

const user = {
  id: "u",
  name: "u",
  display_name: "U",
  avatar_url: null,
  created_at: 0,
  updated_at: 0,
};
const unreachable = {
  status: "backend_unreachable",
  server_url: "https://down.example",
  message: "connect ECONNREFUSED",
};

describe("readViewer", () => {
  it("keeps a signed-in viewer when the server becomes unreachable", async () => {
    getAuthState.mockResolvedValueOnce(unreachable);
    const read = readViewer(user);
    await expect(read).rejects.toBeInstanceOf(ApiError);
    await expect(read).rejects.toMatchObject({ kind: "backend_unreachable" });
  });

  it("reports an unreachable server before anyone has signed in", async () => {
    getAuthState.mockResolvedValueOnce(unreachable);
    await expect(readViewer(undefined)).resolves.toMatchObject({ backend_unreachable: true });
    getAuthState.mockResolvedValueOnce(unreachable);
    await expect(
      readViewer({ registration_required: true, suggested_name: "" }),
    ).resolves.toMatchObject({ backend_unreachable: true });
  });

  it("lets a signed-out answer replace the signed-in viewer", async () => {
    getAuthState.mockResolvedValueOnce({ status: "unauthenticated" });
    await expect(readViewer(user)).resolves.toMatchObject({ registration_required: true });
  });
});
