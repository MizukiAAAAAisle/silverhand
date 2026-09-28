import type { ClientPlatform } from "@silverhand/client";

let platform: ClientPlatform | undefined;
export function configurePlatform(value: ClientPlatform): void {
  if (platform) throw new Error("Client platform already configured");
  platform = value;
}
export function getPlatform(): ClientPlatform {
  if (!platform) throw new Error("Configure the client platform before mounting the app");
  return platform;
}
export function requireLocalHost() {
  const host = getPlatform().localHost;
  if (!host) throw new Error("This application does not provide a local host");
  return host;
}
