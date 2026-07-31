import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * #task:1761 (Cindy P1-2) — source-scan drift guard for the main-process
 * backend HTTP seam.
 *
 * Every main→backend HTTP call must flow through `backendFetch`, which
 * injects the client-info header (incl. `desktop_api_epoch`). A raw
 * `fetchBackendWithNetworkPolicy(fetch, ...)` call site added later would
 * silently ship a request WITHOUT the epoch — classified as a pre-epoch
 * legacy desktop and 426-rejected once the observation-bridge cutoff raises
 * the server minimum. This scan makes that regression a test failure at the
 * moment of introduction instead of a fleet incident at cutoff time.
 */
describe('main-process backend HTTP seam (#task:1761)', () => {
  it('index.ts routes all backend HTTP through backendFetch (single raw call site: the seam itself)', () => {
    const source = readFileSync(join(__dirname, 'index.ts'), 'utf8');
    const rawCallSites = source.match(
      /fetchBackendWithNetworkPolicy\(fetch,/g,
    );
    expect(rawCallSites).toHaveLength(1);
    // And that one site lives inside the seam function.
    const seamBody = source.slice(
      source.indexOf('function backendFetch('),
      source.indexOf('function backendFetch(') + 1200,
    );
    expect(seamBody).toContain('fetchBackendWithNetworkPolicy(fetch,');
    expect(seamBody).toContain('CLIENT_INFO_HEADER');
    // Round-2: the ADMISSION header is the dedicated constant-valued one and
    // must be set unconditionally inside the seam.
    expect(seamBody).toContain('DESKTOP_API_EPOCH_HEADER');
  });
});
