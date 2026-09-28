import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { focusManager, QueryClient, QueryObserver } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { clearCurrentUser, setCurrentUserId } from "@/features/session/current-user";
import {
  profileMessageCountsKey,
  profileMessageCountsOptions,
  shanghaiDate,
} from "./message-counts";

vi.mock("@/lib/api", () => ({ api: vi.fn() }));

const subject = { kind: "user" as const, id: "person/1" };
const response = (count = 1, year = 2026) => ({
  subject,
  year,
  time_zone: "Asia/Shanghai",
  days: [{ date: `${year}-01-01`, count }],
  available_years: [2025, 2026],
});

let client: QueryClient;

beforeEach(() => {
  setCurrentUserId("viewer-a");
  vi.mocked(api).mockReset();
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});

afterEach(() => {
  client.clear();
  client.unmount();
  clearCurrentUser();
  focusManager.setFocused(undefined);
});

describe("profile message count reads", () => {
  it("coalesces concurrent readers and requests only the encoded subject/year aggregate", async () => {
    vi.mocked(api).mockResolvedValue(response());
    const options = profileMessageCountsOptions("viewer-a", subject, 2026);
    const [a, b] = await Promise.all([client.fetchQuery(options), client.fetchQuery(options)]);

    expect(a).toEqual(b);

    expect(api).toHaveBeenCalledTimes(1);

    expect(api).toHaveBeenCalledWith(
      "/api/profiles/user/person%2F1/message-counts?year=2026",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it("separates viewer, subject kind, target id, and year", () => {
    const keys = [
      profileMessageCountsKey("viewer-a", subject, 2026),
      profileMessageCountsKey("viewer-b", subject, 2026),
      profileMessageCountsKey("viewer-a", { ...subject, kind: "agent" }, 2026),
      profileMessageCountsKey("viewer-a", { ...subject, id: "another" }, 2026),
      profileMessageCountsKey("viewer-a", subject, 2025),
    ];

    expect(new Set(keys.map((key) => JSON.stringify(key))).size).toBe(5);
  });

  it.each([
    { ...response(), subject: { kind: "agent", id: subject.id } },
    { ...response(), subject: { kind: "user", id: "another" } },
    response(1, 2025),
  ])("rejects a response for a different target or year", async (data) => {
    vi.mocked(api).mockResolvedValue(data);

    await expect(
      client.fetchQuery(profileMessageCountsOptions("viewer-a", subject, 2026)),
    ).rejects.toThrow("does not match");

    expect(client.getQueryData(profileMessageCountsKey("viewer-a", subject, 2026))).toBeUndefined();
  });

  it("does not admit a late response after the authenticated viewer changes", async () => {
    let resolve!: (value: unknown) => void;
    vi.mocked(api).mockReturnValue(
      new Promise((done) => {
        resolve = done;
      }),
    );
    const pending = client.fetchQuery(profileMessageCountsOptions("viewer-a", subject, 2026));
    setCurrentUserId("viewer-b");
    resolve(response());

    await expect(pending).rejects.toThrow("Session changed");

    expect(client.getQueryData(profileMessageCountsKey("viewer-b", subject, 2026))).toBeUndefined();
  });

  it("refreshes the HTTP authority when remounted and refocused, including count decreases", async () => {
    client.mount();
    vi.mocked(api).mockResolvedValue(response(8));
    const observer = new QueryObserver(
      client,
      profileMessageCountsOptions("viewer-a", subject, 2026),
    );
    let unsubscribe = observer.subscribe(() => {});
    await vi.waitFor(() => expect(observer.getCurrentResult().data?.days[0]?.count).toBe(8));
    unsubscribe();

    vi.mocked(api).mockResolvedValue(response(4));
    unsubscribe = observer.subscribe(() => {});
    await vi.waitFor(() => expect(observer.getCurrentResult().data?.days[0]?.count).toBe(4));

    vi.mocked(api).mockResolvedValue(response(0));
    focusManager.setFocused(false);
    focusManager.setFocused(true);
    await vi.waitFor(() => expect(observer.getCurrentResult().data?.days[0]?.count).toBe(0));

    expect(api).toHaveBeenCalledTimes(3);
    unsubscribe();
  });

  it("preserves an HTTP failure as an error rather than reporting zero messages", async () => {
    vi.mocked(api).mockRejectedValue(new Error("Not found"));

    await expect(
      client.fetchQuery(profileMessageCountsOptions("viewer-a", subject, 2026)),
    ).rejects.toThrow("Not found");

    expect(client.getQueryData(profileMessageCountsKey("viewer-a", subject, 2026))).toBeUndefined();
  });

  it("uses Shanghai midnight for the reporting year and day", () => {
    expect(shanghaiDate(new Date("2025-12-31T15:59:59Z"))).toBe("2025-12-31");

    expect(shanghaiDate(new Date("2025-12-31T16:00:00Z"))).toBe("2026-01-01");
  });
});
