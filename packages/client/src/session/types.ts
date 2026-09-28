import type { UserDto } from "@silverhand/shared";

export type ClientAuthState =
  | { status: "authenticated"; signup_enabled: boolean; user: UserDto }
  | { status: "unauthenticated"; signup_enabled: boolean }
  | { status: "backend_unreachable"; server_url: string; message: string }
  | {
      status: "app_update_required";
      server_api_epoch: number;
      minimum_client_epoch: number;
    }
  | {
      status: "server_update_required";
      server_api_epoch: number;
      client_api_epoch: number;
    };

export type ClientAuthResult =
  | { ok: true; user: UserDto }
  | { ok: false; status: number; statusText: string; bodyText: string };
