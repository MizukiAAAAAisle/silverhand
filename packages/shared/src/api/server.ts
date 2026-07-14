// AUTO-SPLIT from the former monolithic api/dto.ts (#task:963).
// Bounded context: server. Re-exported via api/index.ts → @silverhand/shared.
import { z } from 'zod';

export const BindAddressScopeSchema = z.enum(['loopback', 'lan', 'public']);
export type BindAddressScope = z.infer<typeof BindAddressScopeSchema>;

export const ServerInfoSchema = z.object({
  signup_enabled: z.boolean(),
  /**
   * Exact outbound daemon protocol version accepted by this server build.
   *
   * The websocket handshake is exact-version gated, so desktop can compare
   * this value with the protocol compiled into its bundled daemon and explain
   * a required upgrade before an agent action fails. Optional on receive so a
   * new desktop can still connect to a server build that predates this field;
   * production servers emit it unconditionally.
   */
  outbound_protocol_version: z.number().int().nonnegative().optional(),
  /**
   * Classification of the address the standalone /
   * embedded backend is bound to, so desktop and ops tooling can
   * read "signup_enabled + bind_address_scope" together
   * programmatically.
   *
   *   - 'loopback' — `127.0.0.1` / `::1` / `localhost`. Embedded
   *     backend's default. No external reachability.
   *   - 'lan' — RFC1918 (10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16),
   *     link-local (169.254/16, fe80::/10), unique-local IPv6
   *     (fc00::/7), or an mDNS `*.local` name. Reachable from
   *     hosts on the same network but not the public internet.
   *   - 'public' — anything else: a public IP, a globally
   *     resolvable DNS name, or a wildcard bind (`0.0.0.0` / `::`)
   *     because the latter exposes whichever interfaces the host
   *     has, including public ones. The conservative classification
   *     for wildcards (Cindy D4.a invariant: never under-state
   *     exposure scope in a field used to gate a warning).
   *
   * Optional in the schema for backward compat — older standalone
   * builds without the field still parse — but production
   * `/api/server/info` MUST populate it.
   */
  bind_address_scope: BindAddressScopeSchema.optional(),
});
export type ServerInfo = z.infer<typeof ServerInfoSchema>;
