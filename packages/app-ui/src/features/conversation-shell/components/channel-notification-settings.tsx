import * as Select from "@radix-ui/react-select";
import { ChevronDownIcon } from "@/icons";
import { Button } from "@/components/ui/button";
import {
  FILTER_SELECT_CONTENT_CLASS,
  FILTER_SELECT_TRIGGER_CLASS,
  FilterSelectItem,
} from "@/components/ui/filter-select";
import {
  useSetChannelAttentionPreference,
  useWorkspaceAttentionModes,
} from "@/features/attention/hooks";
import { ATTENTION_OPTIONS } from "./channel-attention-surfaces";

/** Same viewer batch and write authority as the sidebar; no local preference copy. */
export function ChannelNotificationSettings({
  channelId,
  workspaceId,
}: {
  channelId: string;
  workspaceId: string;
}): JSX.Element {
  const modes = useWorkspaceAttentionModes(workspaceId);
  const preference = useSetChannelAttentionPreference(channelId);
  const mode = modes.data?.channels.find((row) => row.conversation_id === channelId)?.mode;
  const unavailable = modes.isError || (!modes.isPending && mode === undefined);

  return (
    <section className="flex flex-col gap-3">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-text-secondary">
        Notifications
      </h3>
      <Select.Root
        value={mode ?? ""}
        disabled={mode === undefined || unavailable || preference.isPending}
        onValueChange={(value) => {
          const option = ATTENTION_OPTIONS.find((item) => item.mode === value);
          if (
            option &&
            mode !== undefined &&
            option.mode !== mode &&
            !unavailable &&
            !preference.isPending
          )
            preference.mutate(option.mode);
        }}
      >
        <Select.Trigger className={FILTER_SELECT_TRIGGER_CLASS} aria-label="Channel notifications">
          <Select.Value placeholder={unavailable ? "Unavailable" : "Loading"} />
          <Select.Icon>
            <ChevronDownIcon className="size-3.5" />
          </Select.Icon>
        </Select.Trigger>
        <Select.Portal>
          <Select.Content position="popper" sideOffset={4} className={FILTER_SELECT_CONTENT_CLASS}>
            <Select.Viewport className="p-1">
              {ATTENTION_OPTIONS.map((option) => (
                <FilterSelectItem
                  key={option.mode}
                  value={option.mode}
                  icon={<option.Icon className="size-3.5" />}
                >
                  {option.label}
                </FilterSelectItem>
              ))}
            </Select.Viewport>
          </Select.Content>
        </Select.Portal>
      </Select.Root>
      {unavailable ? (
        <div className="flex items-center justify-between gap-2 text-xs text-error">
          Unable to load notification preferences.
          <Button variant="neutral" size="sm" onClick={() => void modes.refetch()}>
            Retry
          </Button>
        </div>
      ) : modes.data?.muted ? (
        <p className="text-xs text-text-muted">Muted by workspace</p>
      ) : null}
    </section>
  );
}
