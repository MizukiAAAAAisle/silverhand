import { describe, expect, it, vi } from "vitest";
import { UserDtoSchema } from "@silverhand/shared";
import { ApiError } from "@/lib/api";
import { EmbeddedProfileSetup, type SetupDependencies } from "./embedded-profile-setup";

const values = { username: "shiki", displayName: "Shiki", avatar: null };
function fixture() {
  const user = UserDtoSchema.parse({
    id: "viewer",
    name: "shiki",
    display_name: "Shiki",
    avatar_url: null,
    created_at: 1,
    updated_at: 1,
  });
  const deps: SetupDependencies = {
    mode: vi.fn().mockResolvedValue("embedded"),
    request: vi.fn().mockResolvedValue({ required: true, user }),
    upload: vi.fn().mockResolvedValue(user),
    applyUser: vi.fn(),
    isCurrent: vi.fn().mockReturnValue(true),
    changed: vi.fn(),
  };
  return { user, deps, model: new EmbeddedProfileSetup(deps) };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("embedded profile setup", () => {
  it("does not call embedded endpoints in remote mode", async () => {
    const { deps, model } = fixture();
    vi.mocked(deps.mode).mockResolvedValue("remote");
    await model.read();
    expect(deps.request).not.toHaveBeenCalled();
    expect(model.state.phase).toBe("ready");
  });
  it("keeps a failed status read closed and allows retry", async () => {
    const { deps, model } = fixture();
    vi.mocked(deps.request).mockRejectedValueOnce(new Error("offline"));
    await model.read();
    expect(model.state.phase).toBe("read-error");
    await model.submit(values);
    expect(deps.request).toHaveBeenCalledTimes(1);
    await model.read();
    expect(model.state.phase).toBe("required");
  });
  it("sends only core fields and refreshes the authoritative user before uploading", async () => {
    const { deps, model, user } = fixture();
    await model.read();
    vi.mocked(deps.request).mockResolvedValue({ required: false, user });
    await model.submit(values);
    expect(deps.request).toHaveBeenLastCalledWith(
      "PUT",
      JSON.stringify({ name: "shiki", display_name: "Shiki" }),
    );
    expect(deps.applyUser).toHaveBeenLastCalledWith(user);
    expect(model.state.phase).toBe("ready");
  });
  it("keeps name conflicts on the form", async () => {
    const { deps, model } = fixture();
    await model.read();
    vi.mocked(deps.request).mockRejectedValue(
      new ApiError(409, "Conflict", '{"error":"name_taken"}'),
    );
    await model.submit(values);
    expect(model.state.phase).toBe("required");
    expect(model.state.error).toContain("taken");
    expect(deps.request).toHaveBeenCalledTimes(2);
  });
  it.each([
    new Error("lost response"),
    new ApiError(409, "Conflict", '{"error":"profile_setup_completed"}'),
  ])("recovers ambiguous or already completed writes through GET", async (error) => {
    const { deps, model, user } = fixture();
    await model.read();
    vi.mocked(deps.request)
      .mockRejectedValueOnce(error)
      .mockResolvedValueOnce({ required: false, user });
    await model.submit(values);
    expect(vi.mocked(deps.request).mock.calls.map(([method]) => method)).toEqual([
      "GET",
      "PUT",
      "GET",
    ]);
    expect(model.state.phase).toBe("ready");
  });
  it("retains the selected photo after failure and retries only the upload", async () => {
    const { deps, model, user } = fixture();
    const avatar = {} as File;
    await model.read();
    vi.mocked(deps.request).mockResolvedValue({ required: false, user });
    vi.mocked(deps.upload).mockRejectedValueOnce(new Error("offline"));
    await model.submit({ ...values, avatar });
    expect(model.state.phase).toBe("avatar-error");
    expect(model.state.error).toContain("Profile saved");
    await model.read();
    await model.retryAvatar();
    expect(deps.upload).toHaveBeenNthCalledWith(2, avatar);
    expect(deps.request).toHaveBeenCalledTimes(2);
    expect(model.state.phase).toBe("ready");
  });
  it("allows continuing after optional photo failure", async () => {
    const { deps, model, user } = fixture();
    await model.read();
    vi.mocked(deps.request).mockResolvedValue({ required: false, user });
    vi.mocked(deps.upload).mockRejectedValue(new Error("offline"));
    await model.submit({ ...values, avatar: {} as File });
    model.continueWithoutAvatar();
    expect(model.state.phase).toBe("ready");
  });
  it.each(["dispose", "viewer"])("ignores an old response after %s change", async (change) => {
    const { deps, model, user } = fixture();
    const pending = deferred<unknown>();
    vi.mocked(deps.request).mockReturnValue(pending.promise);
    const read = model.read();
    await Promise.resolve();
    if (change === "dispose") {
      model.dispose();
    } else {
      vi.mocked(deps.isCurrent).mockReturnValue(false);
    }
    pending.resolve({ required: false, user });
    await read;
    expect(deps.applyUser).not.toHaveBeenCalled();
  });
  it("serializes submissions and prevents reconnect reads from racing a save", async () => {
    const { deps, model, user } = fixture();
    await model.read();
    const pending = deferred<unknown>();
    vi.mocked(deps.request).mockReturnValue(pending.promise);
    const saving = model.submit(values);
    await model.submit(values);
    await model.read();
    expect(deps.request).toHaveBeenCalledTimes(2);
    pending.resolve({ required: false, user });
    await saving;
    expect(model.state.phase).toBe("ready");
  });
});

it("does not enter the shell while the optional photo is pending", async () => {
  const { deps, model, user } = fixture();
  await model.read();
  vi.mocked(deps.request).mockResolvedValue({ required: false, user });
  const pending = deferred<typeof user>();
  vi.mocked(deps.upload).mockReturnValue(pending.promise);
  const save = model.submit({ ...values, avatar: {} as File });
  await Promise.resolve();
  await Promise.resolve();
  expect(model.state.phase).toBe("uploading");
  expect(deps.applyUser).toHaveBeenLastCalledWith(user);
  pending.resolve(user);
  await save;
  expect(model.state.phase).toBe("ready");
});

it("does not apply a save or start an upload after viewer replacement", async () => {
  const { deps, model, user } = fixture();
  await model.read();
  vi.mocked(deps.applyUser).mockClear();
  const pending = deferred<unknown>();
  vi.mocked(deps.request).mockReturnValue(pending.promise);
  const save = model.submit({ ...values, avatar: {} as File });
  vi.mocked(deps.isCurrent).mockReturnValue(false);
  pending.resolve({ required: false, user });
  await save;
  expect(deps.applyUser).not.toHaveBeenCalled();
  expect(deps.upload).not.toHaveBeenCalled();
});

it("blocks resubmission after an ambiguous write until status recovery succeeds", async () => {
  const { deps, model, user } = fixture();
  await model.read();
  vi.mocked(deps.request).mockRejectedValue(new Error("offline"));
  await model.submit(values);
  expect(model.state.phase).toBe("read-error");
  await model.submit(values);
  expect(deps.request).toHaveBeenCalledTimes(3);
  vi.mocked(deps.request).mockResolvedValue({ required: false, user });
  await model.read();
  expect(model.state.phase).toBe("ready");
  expect(vi.mocked(deps.request).mock.calls.map(([method]) => method)).toEqual([
    "GET",
    "PUT",
    "GET",
    "GET",
  ]);
});

it("reads durable completion on a fresh controller without showing the form", async () => {
  const { deps, model, user } = fixture();
  vi.mocked(deps.request).mockResolvedValue({ required: false, user });
  await model.read();
  expect(model.state.phase).toBe("ready");
  expect(deps.changed).not.toHaveBeenCalledWith(expect.objectContaining({ phase: "required" }));
  expect(deps.request).toHaveBeenCalledWith("GET");
});

it("keeps repeated status failures closed", async () => {
  const { deps, model } = fixture();
  vi.mocked(deps.request).mockRejectedValue(new Error("offline"));
  await model.read();
  await model.read();
  expect(model.state.phase).toBe("read-error");
  expect(deps.applyUser).not.toHaveBeenCalled();
  expect(deps.changed).not.toHaveBeenCalledWith(expect.objectContaining({ phase: "ready" }));
});
