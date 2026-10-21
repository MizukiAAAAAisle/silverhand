import type { UserDto } from "@silverhand/shared";

export type ClientAuthState =
  | { status: "authenticated"; user: UserDto }
  | { status: "unauthenticated" }
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

/** An anonymous password-recovery call on the selected server. A response that
 *  arrives after the server or session changed is answered as 409. */
export interface PasswordRecoveryCall {
  action: "request" | "reset";
  body: string;
}
export interface PasswordRecoveryResult {
  status: number;
  bodyText: string;
}

export type ClientAuthResult =
  | { ok: true; user: UserDto }
  | { ok: false; status: number; statusText: string; bodyText: string };
