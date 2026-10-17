import { useEffect, useState } from "react";
import type {
  DesktopPreferencesSnapshot,
  NotificationSoundFile,
  NotificationSoundsCapability,
} from "@silverhand/client";
import { Button } from "@/components/ui/button";
import { SettingToggle } from "@/components/ui/setting-toggle";

export function NotificationSettingsPane({ api }: { api: NotificationSoundsCapability }) {
  const [prefs, setPrefs] = useState<DesktopPreferencesSnapshot>();
  const [busy, setBusy] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    void api
      .load()
      .then((p) => {
        if (active) setPrefs(p);
      })
      .catch((e) => {
        if (active) setError(String(e));
      });
    return () => {
      active = false;
    };
  }, [api]);
  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
      setPlaying(false);
    }
  };
  const save = async (enabled: boolean, sound: NotificationSoundFile | null) => {
    if (prefs)
      setPrefs(
        await api.save({
          revision: prefs.revision,
          notificationSoundEnabled: enabled,
          notificationSound: sound,
        }),
      );
  };
  const choose = () =>
    void run(async () => {
      const sound = await api.chooseFile();
      if (!sound) return;
      setPlaying(true);
      await api.preview(sound);
      await save(true, sound);
    });
  const sound = prefs?.notificationSound ?? null;
  const disabled = busy || !prefs || !!prefs.error;
  return (
    <section className="min-h-0 min-w-0 flex-1 overflow-y-auto px-5 py-6 sm:px-8 sm:py-8">
      <div className="space-y-7">
        <div>
          <h2 className="font-serif text-base font-semibold">Make it your sound</h2>
          <p className="mt-2 text-sm leading-relaxed text-text-secondary">
            A familiar cue when someone needs your attention.
          </p>
        </div>
        {(error || prefs?.error) && (
          <div role="alert" className="rounded-lg border border-error p-3 text-sm text-error">
            <p>{error || prefs?.error}</p>
            <Button
              className="mt-2"
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => void run(async () => setPrefs(await api.load()))}
            >
              Try again
            </Button>
          </div>
        )}
        {!prefs ? (
          <p className="text-sm text-text-muted">Loading preferences…</p>
        ) : (
          <>
            <div className="flex items-center justify-between gap-6 border-b border-border pb-5">
              <div>
                <p className="text-sm font-medium">Notification sounds</p>
                <p className="mt-1 text-xs text-text-muted">
                  New @mentions play a sound, even in the conversation you’re viewing. Turn off
                  sound without hiding notifications.
                </p>
              </div>
              <SettingToggle
                label="Notification sounds"
                checked={prefs.notificationSoundEnabled}
                disabled={disabled}
                onChange={() => void run(() => save(!prefs.notificationSoundEnabled, sound))}
              />
            </div>
            <div className="space-y-3">
              <div className="flex items-center justify-between gap-3">
                <h3 className="text-xs font-medium uppercase tracking-wider text-text-muted">
                  Sound
                </h3>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={disabled || !prefs.notificationSoundEnabled}
                  onClick={() =>
                    void run(async () => {
                      setPlaying(true);
                      await api.preview(sound);
                    })
                  }
                >
                  {playing ? "Playing…" : "Preview"}
                </Button>
              </div>
              <div
                aria-label="Notification sound"
                className="overflow-hidden rounded-xl border border-border divide-y divide-border"
              >
                <button
                  type="button"
                  aria-pressed={!sound}
                  disabled={disabled}
                  onClick={() => void run(() => save(true, null))}
                  className="flex w-full items-center gap-3 p-4 text-left hover:bg-bg-hover focus-outline disabled:opacity-50"
                >
                  <span
                    aria-hidden
                    className={`flex size-4 shrink-0 items-center justify-center rounded-full border ${!sound ? "border-accent" : "border-border"}`}
                  >
                    {!sound && <span className="size-2 rounded-full bg-accent" />}
                  </span>
                  <span>
                    <span className="block text-sm font-medium">System default</span>
                    <span className="mt-0.5 block text-xs text-text-muted">
                      Use your computer’s notification sound; in the current conversation, play its
                      alert sound
                    </span>
                  </span>
                </button>
                <div className={`p-4 ${sound ? "bg-accent-soft" : ""}`}>
                  <div className="flex items-center gap-3">
                    <span
                      aria-hidden="true"
                      className={`flex size-4 shrink-0 items-center justify-center rounded-full border ${sound ? "border-accent" : "border-border"}`}
                    >
                      {sound && <span className="size-2 rounded-full bg-accent" />}
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium">Custom audio</p>
                      <p className="mt-0.5 truncate text-xs text-text-muted" title={sound?.name}>
                        {sound?.name ?? "Your own music, voice or sound effect"}
                      </p>
                    </div>
                  </div>
                  <div className="ml-7 mt-3">
                    <Button variant="outline" size="sm" disabled={disabled} onClick={choose}>
                      {sound ? "Change audio file" : "Choose audio file"}
                    </Button>
                  </div>
                </div>
              </div>
              <p className="text-xs leading-relaxed text-text-muted">
                MP3, WAV, OGG, M4A, AAC or FLAC · up to 8 MB and 30 seconds.
                <br />A copy stays on this computer, even if you move the original.
              </p>
            </div>
            <p role="status" className="text-xs text-text-muted">
              {busy
                ? playing
                  ? "Playing preview…"
                  : "Saving…"
                : "Saved automatically on this computer."}
            </p>
          </>
        )}
      </div>
    </section>
  );
}
