import { getPlatform } from "@/platform";
import {
  apiPaths,
  CompleteEmbeddedProfileSetupInputSchema,
  EmbeddedProfileSetupResponseSchema,
  type UserDto,
} from "@silverhand/shared";
import { api, apiUpload, ApiError } from "@/lib/api";
import type { ProfileSetupValues } from "./profile-setup-form";

export type SetupPhase =
  | "checking"
  | "required"
  | "saving"
  | "uploading"
  | "avatar-error"
  | "read-error"
  | "ready";
export interface SetupState {
  phase: SetupPhase;
  error: string | null;
}
export interface SetupDependencies {
  mode: () => Promise<"embedded" | "remote">;
  request: (method: "GET" | "PUT", body?: string) => Promise<unknown>;
  upload: (file: File) => Promise<UserDto>;
  applyUser: (user: UserDto) => void;
  isCurrent: () => boolean;
  changed: (state: SetupState) => void;
}

export function setupErrorCode(error: unknown): string | null {
  if (!(error instanceof ApiError)) {
    return null;
  }
  try {
    return JSON.parse(error.body).error ?? null;
  } catch {
    return null;
  }
}

export const setupTransport = {
  mode: async () => {
    const info = await getPlatform().client.getConnectionInfo();
    if (!info) {
      throw new Error("Backend not ready");
    }
    return info.mode;
  },
  request: (method: "GET" | "PUT", body?: string) =>
    api(apiPaths.embeddedProfileSetup, { method, body }),
  upload: async (file: File) => {
    const form = new FormData();
    form.set("file", file);
    const result = await apiUpload<{ user: UserDto }>(apiPaths.meAvatar, form);
    return result.user;
  },
};

export class EmbeddedProfileSetup {
  state: SetupState = { phase: "checking", error: null };
  private disposed = false;
  private generation = 0;
  private busy = false;
  private avatar: File | null = null;

  constructor(private readonly deps: SetupDependencies) {}

  dispose(): void {
    this.disposed = true;
    this.generation++;
  }

  private current(generation: number): boolean {
    return !this.disposed && generation === this.generation && this.deps.isCurrent();
  }

  private publish(phase: SetupPhase, error: string | null = null): void {
    this.state = { phase, error };
    this.deps.changed(this.state);
  }

  private apply(value: unknown, generation: number): boolean | null {
    const result = EmbeddedProfileSetupResponseSchema.parse(value);
    if (!this.current(generation)) {
      return null;
    }
    this.deps.applyUser(result.user);
    return result.required;
  }

  async read(): Promise<void> {
    if (this.busy || this.disposed || this.state.phase === "avatar-error") {
      return;
    }
    const generation = ++this.generation;
    if (this.state.phase !== "ready") {
      this.publish("checking");
    }
    try {
      const mode = await this.deps.mode();
      if (!this.current(generation)) {
        return;
      }
      if (mode === "remote") {
        this.publish("ready");
        return;
      }
      const required = this.apply(await this.deps.request("GET"), generation);
      if (required === null) {
        return;
      }
      if (!required && this.avatar) {
        this.busy = true;
        await this.upload(generation);
      } else {
        this.publish(required ? "required" : "ready");
      }
    } catch {
      if (this.current(generation)) {
        this.publish("read-error", "Unable to load profile setup. Retry to continue.");
      }
    } finally {
      if (this.current(generation)) {
        this.busy = false;
      }
    }
  }

  async submit(values: ProfileSetupValues): Promise<void> {
    if (this.busy || this.state.phase !== "required" || this.disposed) {
      return;
    }
    const input = CompleteEmbeddedProfileSetupInputSchema.safeParse({
      name: values.username,
      display_name: values.displayName,
    });
    if (!input.success) {
      this.publish("required", "Check your display name and username.");
      return;
    }
    this.busy = true;
    this.avatar = values.avatar;
    const generation = ++this.generation;
    this.publish("saving");
    try {
      let required: boolean | null;
      try {
        required = this.apply(
          await this.deps.request("PUT", JSON.stringify(input.data)),
          generation,
        );
      } catch (error) {
        if (!this.current(generation)) {
          return;
        }
        if (setupErrorCode(error) === "name_taken") {
          this.publish("required", "This username is already taken.");
          return;
        }
        // A lost response can follow a committed write. Read before offering another submission.
        required = this.apply(await this.deps.request("GET"), generation);
      }
      if (required === null) {
        return;
      }
      if (required) {
        this.publish("required", "Profile setup was not completed. Please try again.");
        return;
      }
      await this.upload(generation);
    } catch {
      if (this.current(generation)) {
        this.publish("read-error", "Unable to confirm profile setup. Retry to check its status.");
      }
    } finally {
      if (this.current(generation)) {
        this.busy = false;
      }
    }
  }

  private async upload(generation: number): Promise<void> {
    this.publish("uploading");
    if (this.avatar) {
      try {
        const user = await this.deps.upload(this.avatar);
        if (!this.current(generation)) {
          return;
        }
        this.deps.applyUser(user);
        this.avatar = null;
      } catch {
        if (this.current(generation)) {
          this.publish("avatar-error", "Profile saved. Profile photo could not be uploaded.");
        }
        return;
      }
    }
    if (this.current(generation)) {
      this.publish("ready");
    }
  }

  async retryAvatar(): Promise<void> {
    if (this.busy || this.state.phase !== "avatar-error" || this.disposed) {
      return;
    }
    this.busy = true;
    const generation = ++this.generation;
    await this.upload(generation);
    if (this.current(generation)) {
      this.busy = false;
    }
  }

  continueWithoutAvatar(): void {
    if (!this.busy && !this.disposed && this.state.phase === "avatar-error") {
      this.avatar = null;
      this.publish("ready");
    }
  }
}
