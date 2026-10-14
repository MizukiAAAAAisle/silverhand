import type { DesktopPreferencesSnapshot } from "./event-hooks.js";

export interface NotificationSoundFile {
  id: string;
  name: string;
}
export interface NotificationSoundEdit {
  revision: string;
  notificationSoundEnabled: boolean;
  /** null selects the system sound; omitted preserves the current selection. */
  notificationSound?: NotificationSoundFile | null;
}
export interface NotificationSoundsCapability {
  load(): Promise<DesktopPreferencesSnapshot>;
  save(input: NotificationSoundEdit): Promise<DesktopPreferencesSnapshot>;
  chooseFile(): Promise<NotificationSoundFile | null>;
  preview(sound: NotificationSoundFile | null): Promise<void>;
}
