import dayjs from "dayjs";
import relativeTime from "dayjs/plugin/relativeTime";
import "dayjs/locale/zh-cn";
import { useEffect, useState } from "react";

dayjs.extend(relativeTime);
dayjs.locale("zh-cn");

const MINUTE = 60_000;

/**
 * Returns ("3 分钟前", "2026-05-02 14:32:01") for an epoch-ms timestamp.
 * Re-renders consumers every minute so the relative label stays fresh
 * without each MessageItem mounting its own interval.
 */
export function useRelativeTime(epochMs: number): { relative: string; absolute: string } {
  // version bumps every minute → forces re-derivation across all callers.
  const [, setVersion] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setVersion((v) => v + 1), MINUTE);
    return () => clearInterval(id);
  }, []);

  const m = dayjs(epochMs);
  return {
    relative: m.fromNow(),
    absolute: m.format("YYYY-MM-DD HH:mm:ss"),
  };
}
