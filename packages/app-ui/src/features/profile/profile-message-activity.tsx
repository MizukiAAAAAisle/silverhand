import { useEffect, useState } from "react";
import { useQueries } from "@tanstack/react-query";
import * as Select from "@radix-ui/react-select";
import { ChevronDownIcon } from "@/icons";
import {
  FilterSelectItem,
  FILTER_SELECT_TRIGGER_CLASS,
  FILTER_SELECT_CONTENT_CLASS,
} from "@/components/ui/filter-select";
import { cn } from "@/lib/cn";
import { ProfileSection } from "@/features/profile/profile-summary-sections";
import { getCurrentUserId } from "@/features/session/current-user";
import { messageActivityRange, messageActivityYears } from "./message-activity-calendar";
import { MessageActivityCalendar } from "./message-activity-calendar-view";
import {
  shanghaiDate,
  profileMessageCountsOptions,
  type ProfileMessageSubject,
} from "./message-counts";
import { t } from "@/lib/i18n";

/** `compact` drops the section title, the period picker, the legend and the
 * frame, and fits the last weeks to the width: a glanceable summary whose
 * consumer supplies the surface. */
export type MessageActivityMode = "full" | "compact";

export function ProfileMessageActivity({
  subject,
  mode = "full",
}: {
  subject: ProfileMessageSubject;
  mode?: MessageActivityMode;
}): JSX.Element {
  return (
    <MessageActivitySection
      key={`${getCurrentUserId()}:${subject.kind}:${subject.id}`}
      subject={subject}
      mode={mode}
    />
  );
}

function MessageActivitySection({
  subject,
  mode,
}: {
  subject: ProfileMessageSubject;
  mode: MessageActivityMode;
}): JSX.Element {
  const [year, setYear] = useState<number | "recent">("recent");
  const [availableYears, setAvailableYears] = useState<number[]>([]);

  const today = shanghaiDate();
  const currentYear = Number(today.slice(0, 4));

  const range = messageActivityRange(year, today);
  const queries = useQueries({
    queries: messageActivityYears(range).map((value) =>
      profileMessageCountsOptions(getCurrentUserId(), subject, value),
    ),
  });

  const data = queries.every((query) => query.data)
    ? queries
        .flatMap((query) => query.data?.days ?? [])
        .filter((day) => day.date >= range.start && day.date <= range.end)
    : undefined;

  const isError = queries.some((query) => query.isError);
  const isFetching = queries.some((query) => query.isFetching);

  const yearOptions = queries.flatMap((query) => query.data?.available_years ?? []).join(",");

  useEffect(() => {
    if (yearOptions) {
      setAvailableYears(yearOptions.split(",").map(Number));
    }
  }, [yearOptions]);

  const years = [
    ...new Set([...(year === "recent" ? [] : [year]), currentYear, ...availableYears]),
  ].sort((a, b) => b - a);
  const total = data?.reduce((sum, day) => sum + day.count, 0) ?? 0;

  const content = (
    <>
      {isError ? (
        <div
          className="flex min-h-40 items-center justify-center gap-3 text-xs text-text-muted"
          role="status"
        >
          <span>{t("profile.messageActivityUnavailable")}</span>
          <button
            type="button"
            className="text-text-primary underline underline-offset-2 focus-outline"
            onClick={() => void Promise.all(queries.map((query) => query.refetch()))}
            disabled={isFetching}
          >
            {t("common.retry")}
          </button>
        </div>
      ) : data ? (
        <div>
          {mode === "compact" ? (
            <p className="mb-3.5 flex items-baseline gap-2">
              <span className="text-[30px] font-bold leading-none tracking-tight tabular-nums text-text-primary">
                {total.toLocaleString()}
              </span>
              <span className="text-[13px] text-text-muted">
                {t("profile.messagesLastYearSuffix", { count: total })}
              </span>
            </p>
          ) : (
            <p className="mb-5 text-xs text-text-muted">
              {year === "recent"
                ? t("profile.messagesLastYear", { count: total, total: total.toLocaleString() })
                : t("profile.messagesInYear", {
                    count: total,
                    total: total.toLocaleString(),
                    year,
                  })}
            </p>
          )}
          <MessageActivityCalendar
            year={year}
            days={data}
            today={today}
            legend={mode === "full"}
            fit={mode === "compact"}
          />
        </div>
      ) : (
        <div
          className="flex min-h-40 flex-col justify-center gap-4"
          role="status"
          aria-label={t("profile.loadingMessageActivity")}
        >
          <div className="h-3 w-40 animate-pulse rounded-(--control-radius) bg-bg-elevated" />
          <div className="h-28 animate-pulse rounded-(--control-radius) bg-bg-elevated" />
        </div>
      )}
    </>
  );

  if (mode === "compact") {
    return <section aria-label={t("profile.messageActivity")}>{content}</section>;
  }

  return (
    <ProfileSection
      title={t("profile.messageActivity")}
      headerSlot={
        <Select.Root
          value={String(year)}
          onValueChange={(value) => setYear(value === "recent" ? "recent" : Number(value))}
        >
          <Select.Trigger
            aria-label={t("profile.messageActivityPeriod")}
            className={cn(FILTER_SELECT_TRIGGER_CLASS, "w-auto")}
          >
            <Select.Value />
            <Select.Icon>
              <ChevronDownIcon className="size-3.5 text-text-muted" />
            </Select.Icon>
          </Select.Trigger>
          <Select.Portal>
            <Select.Content
              position="popper"
              sideOffset={4}
              data-dropdown-frame
              className={FILTER_SELECT_CONTENT_CLASS}
            >
              <Select.Viewport className="p-1">
                <FilterSelectItem value="recent">{t("profile.lastYear")}</FilterSelectItem>
                {years.map((value) => (
                  <FilterSelectItem key={value} value={String(value)}>
                    {value}
                  </FilterSelectItem>
                ))}
              </Select.Viewport>
            </Select.Content>
          </Select.Portal>
        </Select.Root>
      }
    >
      {content}
    </ProfileSection>
  );
}
