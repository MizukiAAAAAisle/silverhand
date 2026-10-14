/** One playback channel for previews and incoming alerts; bursts never stack sounds. */
let stop: (() => void) | undefined;
export function playNotificationAudio(source: string): Promise<void> {
  stop?.();
  return new Promise((resolve, reject) => {
    const audio = new Audio(source);
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      audio.onended = audio.onerror = audio.onloadedmetadata = null;
      audio.pause();
      audio.removeAttribute("src");
      if (stop === cancel) stop = undefined;
      if (error) reject(error);
      else resolve();
    };
    const cancel = () => finish();
    stop = cancel;
    const timer = setTimeout(
      () => finish(new Error("Choose a notification sound under 30 seconds.")),
      30000,
    );
    audio.onloadedmetadata = () => {
      if (!Number.isFinite(audio.duration) || audio.duration > 30)
        finish(new Error("Choose a notification sound under 30 seconds."));
    };
    audio.onended = () => finish();
    audio.onerror = () =>
      finish(new Error("This audio file could not be played. Try another file."));
    void audio
      .play()
      .catch(() =>
        finish(new Error("Audio playback failed. Check your sound output or choose another file.")),
      );
  });
}
