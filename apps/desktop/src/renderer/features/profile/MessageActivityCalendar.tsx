import { useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import * as Tooltip from "@radix-ui/react-tooltip";
import {
  messageActivityCalendar,
  messageActivityLevel,
  type MessageActivityDay,
} from "./message-activity-calendar";
import "./message-activity.css";

interface Props {
  year: number | "recent";
  days: readonly MessageActivityDay[];
  today: string;
}

export function MessageActivityCalendar({ year, days, today }: Props): JSX.Element {
  const cells = useMemo(() => messageActivityCalendar(year, days, today), [year, days, today]);

  const [focusedDate, setFocusedDate] = useState<string | null>(null);

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
    cell.date.endsWith("-01")
      ? [{ column: Math.floor(index / 7) + 1, date: cell.date }]
      : [],
  );

  const monthFormat = new Intl.DateTimeFormat("en-US", { month: "short", timeZone: "UTC" });
  const dateFormat = new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });

  return (
    <div data-message-activity data-activity-columns={columns}>
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
            <div className="message-activity-weekdays" aria-hidden>
              <span />
              <span>Mon</span>
              <span />
              <span>Wed</span>
              <span />
              <span>Fri</span>
              <span />
            </div>
            <Tooltip.Provider delayDuration={120} skipDelayDuration={0}>
              <div
                className="message-activity-grid"
                role="group"
                aria-label={`Daily message counts for ${year}`}
              >
                {cells.map((cell, index) =>
                  cell.visible ? (
                    <Tooltip.Root key={cell.date}>
                      <Tooltip.Trigger asChild>
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
                      </Tooltip.Trigger>
                      <Tooltip.Portal>
                        <Tooltip.Content
                          sideOffset={8}
                          collisionPadding={8}
                          data-popover-frame="info"
                          className="z-[var(--z-popover)] bg-bg-floating px-3 py-2 text-xs text-text-primary shadow-popover"
                        >
                          <div className="font-semibold">
                            {dateFormat.format(new Date(`${cell.date}T00:00:00Z`))}
                          </div>
                          <div className="mt-1 text-text-secondary">
                            {cell.count.toLocaleString()}{" "}
                            {cell.count === 1 ? "message" : "messages"}
                          </div>
                        </Tooltip.Content>
                      </Tooltip.Portal>
                    </Tooltip.Root>
                  ) : (
                    <span key={cell.date} />
                  ),
                )}
              </div>
            </Tooltip.Provider>
          </div>
        </div>
      </div>
      <div className="mt-3 flex items-center justify-end gap-3 text-[11px] text-text-muted">
        <div className="message-activity-legend" aria-label="Message count intensity">
          <span>Less</span>
          {[0, 1, 2, 3, 4].map((level) => (
            <i key={level} data-level={level} />
          ))}
          <span>More</span>
        </div>
      </div>
    </div>
  );
}
