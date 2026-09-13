import { describe, expect, it } from "vitest";
import { apiPaths, type UserDto } from "@silverhand/shared";
import { extractViewerUserFromProxyResponse } from "../profile-session-sync";

function userDto(overrides: Partial<UserDto> = {}): UserDto {
  return {
    id: "u-1",
    name: "iu",
    display_name: "@iu lakphy",
    avatar_url: null,
    created_at: 1,
    updated_at: 2,
    ...overrides,
  };
}

describe("extractViewerUserFromProxyResponse", () => {
  it("refreshes bootstrap identity from setup completion and recovery reads", () => {
    const user = userDto({ name: "Alice", display_name: "Alice" });
    for (const method of ["GET", "PUT"]) {
      expect(
        extractViewerUserFromProxyResponse(
          { method, path: apiPaths.embeddedProfileSetup },
          { status: 200, bodyText: JSON.stringify({ required: false, user }) },
        ),
      ).toEqual(user);
    }
    for (const response of [
      { status: 409, bodyText: JSON.stringify({ required: false, user }) },
      { status: 200, bodyText: JSON.stringify({ user }) },
      { status: 200, bodyText: JSON.stringify({ required: false, user: {} }) },
    ]) {
      expect(
        extractViewerUserFromProxyResponse(
          { method: "PUT", path: apiPaths.embeddedProfileSetup },
          response,
        ),
      ).toBeNull();
    }
  });

  it("extracts PATCH /api/me UserDto responses, preserving display names with spaces", () => {
    const user = userDto();

    expect(
      extractViewerUserFromProxyResponse(
        { method: "PATCH", path: apiPaths.me },
        { status: 200, bodyText: JSON.stringify(user) },
      ),
    ).toEqual(user);
  });

  it("extracts DELETE /api/me/avatar UserDto responses", () => {
    const user = userDto({ avatar_url: null });

    expect(
      extractViewerUserFromProxyResponse(
        { method: "DELETE", path: apiPaths.meAvatar },
        { status: 200, bodyText: JSON.stringify(user) },
      ),
    ).toEqual(user);
  });

  it("extracts POST /api/me/avatar upload responses from the nested user field", () => {
    const user = userDto({ avatar_url: "silverhand-blob://users/u-1/avatar" });

    expect(
      extractViewerUserFromProxyResponse(
        { method: "POST", path: apiPaths.meAvatar },
        {
          status: 200,
          bodyText: JSON.stringify({
            avatar_url: user.avatar_url,
            user,
          }),
        },
      ),
    ).toEqual(user);
  });

  it("extracts a fresh GET /api/me read, so a remote profile edit can reseat the cache", () => {
    // #task:1702: a profile edit made on ANOTHER machine never passes
    // through this machine's mutation proxy. The only thing that arrives
    // is an invalidation signal, after which the client re-reads
    // `/api/me` — that read is authoritative and must land in the
    // session snapshot, otherwise `auth:getState` keeps serving the
    // login-time DTO until the app restarts. (The narrower #1701 version
    // of this helper ignored reads; that arm is what made the remote case
    // unfixable from the renderer alone.)
    const user = userDto({ display_name: "renamed elsewhere" });

    expect(
      extractViewerUserFromProxyResponse(
        { method: "GET", path: apiPaths.me },
        { status: 200, bodyText: JSON.stringify(user) },
      ),
    ).toEqual(user);
  });

  it("ignores the pre-registration GET /api/me shape", () => {
    // `GET /api/me` is a union: a viewer DTO or `{registration_required,
    // suggested_name}`. The latter is not a profile and must not overwrite
    // a cached session user.
    expect(
      extractViewerUserFromProxyResponse(
        { method: "GET", path: apiPaths.me },
        {
          status: 200,
          bodyText: JSON.stringify({
            registration_required: true,
            suggested_name: "user-ab12",
          }),
        },
      ),
    ).toBeNull();
  });

  it("ignores non-profile routes, failures, and malformed bodies", () => {
    const user = userDto();

    expect(
      extractViewerUserFromProxyResponse(
        { method: "PATCH", path: apiPaths.me },
        { status: 401, bodyText: JSON.stringify(user) },
      ),
    ).toBeNull();
    expect(
      extractViewerUserFromProxyResponse(
        { method: "PATCH", path: apiPaths.me },
        { status: 200, bodyText: '{"not":"a user"}' },
      ),
    ).toBeNull();
    expect(
      extractViewerUserFromProxyResponse(
        { method: "PATCH", path: "/api/workspaces" },
        { status: 200, bodyText: JSON.stringify(user) },
      ),
    ).toBeNull();
    expect(
      extractViewerUserFromProxyResponse(
        { method: "GET", path: apiPaths.users },
        { status: 200, bodyText: JSON.stringify({ users: [user] }) },
      ),
    ).toBeNull();
  });
});
