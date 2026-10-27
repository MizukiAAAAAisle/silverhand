import { useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import {
  messageActivityCalendar,
  messageActivityLevel,
  type MessageActivityDay,
} from "./message-activity-calendar";
import { useCoarsePointer } from "@/navigation/layout";
import { localeTag, t } from "@/lib/i18n";
import "./message-activity.css";

interface Props {
  year: number | "recent";
  days: readonly MessageActivityDay[];
  today: string;
  /** The Less/More intensity key. */
  legend?: boolean;
  /** Show only the most recent weeks that fit the width, with no scrolling and
   * no weekday column; cells stretch to fill the row. */
  fit?: boolean;
}

/** Cell and gap of the fitted grid at its narrowest. */
const FIT_CELL_MIN = 12;
const FIT_GAP = 3;

export function MessageActivityCalendar({
  year,
  days,
  today,
  legend = true,
  fit = false,
}: Props): JSX.Element {
  const allCells = useMemo(() => messageActivityCalendar(year, days, today), [year, days, today]);

  const root = useRef<HTMLDivElement>(null);
  const [fitWeeks, setFitWeeks] = useState<number | null>(null);

  useLayoutEffect(() => {
    const node = root.current;
    if (!fit || !node) {
      return;
    }

    const measure = () => {
      setFitWeeks(Math.max(1, Math.floor((node.clientWidth + FIT_GAP) / (FIT_CELL_MIN + FIT_GAP))));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);

    return () => {
      observer.disconnect();
    };
  }, [fit]);

  const cells =
    fit && fitWeeks ? allCells.slice(-Math.min(fitWeeks * 7, allCells.length)) : allCells;

  const [focusedDate, setFocusedDate] = useState<string | null>(null);
  // A tooltip opens on hover or keyboard focus, never on touch: on a touch
  // screen a tap shows the day instead, until the next tap elsewhere.
  const coarse = useCoarsePointer();
  const [tappedDate, setTappedDate] = useState<string | null>(null);

  const scrollContainer = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const container = scrollContainer.current;

    if (container) {
      container.scrollLeft = year === "recent" ? container.scrollWidth : 0;
    }
  }, [year, today]);

  const buttons = useRef(new Map<string, HTMLButtonElement>());

  const firstVisible = cells.find((cell) => cell.visible)?.date;
  const activeDate = cells.some((cell) => cell.date === focusedDate && cell.visible)
    ? focusedDate
    : firstVisible;

  const columns = cells.length / 7;
  const monthLabels = cells.flatMap((cell, index) =>
    (year === "recent" ? cell.visible : cell.date.startsWith(`${year}-`)) &&
    cell.date.endsWith("-01") &&
    // A fitted grid has no scroll room: a label needs three columns to stay whole.
    (!fit || Math.floor(index / 7) + 3 <= columns)
      ? [{ column: Math.floor(index / 7) + 1, date: cell.date }]
      : [],
  );

  const monthFormat = new Intl.DateTimeFormat(localeTag, { month: "short", timeZone: "UTC" });
  const dateFormat = new Intl.DateTimeFormat(localeTag, {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });

  return (
    <div
      ref={root}
      data-message-activity
      data-activity-columns={fit ? undefined : columns}
      data-activity-fit={fit || undefined}
    >
      <div ref={scrollContainer} className="message-activity-calendar">
        <div
          className="message-activity-plot"
          style={{ "--activity-columns": columns } as CSSProperties}
        >
          <div className="message-activity-months" aria-hidden>
            {monthLabels.map((month) => (
              <span key={month.date} style={{ gridColumn: `${month.column} / span 1` }}>
                {monthFormat.format(new Date(`${month.date}T00:00:00Z`))}
              </span>
            ))}
          </div>
          <div className="message-activity-matrix">
            {fit ? null : (
              <div className="message-activity-weekdays" aria-hidden>
                <span />
                <span>{t("profile.mon")}</span>
                <span />
                <span>{t("profile.wed")}</span>
                <span />
                <span>{t("profile.fri")}</span>
                <span />
              </div>
            )}
            <TooltipProvider>
              <div
                className="message-activity-grid"
                role="group"
                aria-label={t("profile.dailyCounts", { year })}
              >
                {cells.map((cell, index) =>
                  cell.visible ? (
                    <Tooltip
                      key={cell.date}
                      open={coarse ? tappedDate === cell.date : undefined}
                      onOpenChange={(open) => {
                        if (coarse && !open) {
                          setTappedDate((date) => (date === cell.date ? null : date));
                        }
                      }}
                    >
                      <TooltipTrigger
                        asChild
                        onClick={(event) => {
                          if (coarse) {
                            event.preventDefault();
                            setTappedDate(cell.date);
                          }
                        }}
                      >
                        <button
                          type="button"
                          className="message-activity-cell"
                          data-level={messageActivityLevel(cell.count)}
                          aria-label={`${cell.date}: ${cell.count.toLocaleString()} ${cell.count === 1 ? "message" : "messages"}`}
                          tabIndex={cell.date === activeDate ? 0 : -1}
                          ref={(node) => {
                            if (node) {
                              buttons.current.set(cell.date, node);
                            } else {
                              buttons.current.delete(cell.date);
                            }
                          }}
                          onFocus={() => setFocusedDate(cell.date)}
                          onKeyDown={(event) => {
                            const offsets: Record<string, number | undefined> = {
                              ArrowLeft: -7,
                              ArrowRight: 7,
                              ArrowUp: -1,
                              ArrowDown: 1,
                            };

                            const delta = offsets[event.key];

                            if (delta === undefined) {
                              return;
                            }

                            event.preventDefault();

                            const next = cells[index + delta];

                            if (next?.visible) {
                              buttons.current.get(next.date)?.focus();
                            }
                          }}
                        />
                      </TooltipTrigger>
                      <TooltipContent>
                        <div className="font-semibold">
                          {dateFormat.format(new Date(`${cell.date}T00:00:00Z`))}
                        </div>
                        <div className="mt-1 text-white/75">
                          {cell.count.toLocaleString()} {cell.count === 1 ? "message" : "messages"}
                        </div>
                      </TooltipContent>
                    </Tooltip>
                  ) : (
                    <span key={cell.date} />
                  ),
                )}
              </div>
            </TooltipProvider>
          </div>
        </div>
      </div>
      {legend ? (
        <div className="mt-3 flex items-center justify-end gap-3 text-[11px] text-text-muted">
          <div className="message-activity-legend" aria-label={t("profile.messageCountIntensity")}>
            <span>{t("profile.less")}</span>
            {[0, 1, 2, 3, 4].map((level) => (
              <i key={level} data-level={level} />
            ))}
            <span>{t("profile.more")}</span>
          </div>
        </div>
      ) : null}
    </div>
  );
}
