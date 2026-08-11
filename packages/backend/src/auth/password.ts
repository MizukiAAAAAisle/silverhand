import { randomBytes } from 'node:crypto';
import { cpus, totalmem } from 'node:os';
import { performance } from 'node:perf_hooks';
import { hash as argon2Hash, verify as argon2Verify } from '@node-rs/argon2';
import type { UserPasswordCredentialRow } from '@silverhand/shared';
import type {
  Argon2idCostCandidate,
  Argon2idPasswordHashParams,
  PasswordHashResult,
} from './credential-types.js';
import type { AuthCredentialsPort } from './ports.js';

type Argon2HashOptions = NonNullable<Parameters<typeof argon2Hash>[1]>;

const ARGON2ID_ALGORITHM = 2;
const ARGON2_VERSION_0X13 = 1;
const ARGON2_FLOOR_MEMORY_KIB = 19 * 1024;
const ARGON2_FLOOR_TIME_COST = 2;

export type {
  Argon2idCostCandidate,
  Argon2idPasswordHashParams,
  PasswordHashResult,
} from './credential-types.js';

export interface PasswordHasher {
  hashPassword(password: string): Promise<PasswordHashResult>;
  verifyPassword(password: string, passwordHash: string): Promise<boolean>;
  verifyDummyPassword(password: string): Promise<boolean>;
}

export interface PasswordHashBenchmarkOptions {
  env?: NodeJS.ProcessEnv;
  targetMs?: number;
  candidates?: Argon2idCostCandidate[];
  measureCandidate?: (candidate: Argon2idCostCandidate) => Promise<number>;
}

export class Argon2idPasswordHasher implements PasswordHasher {
  private paramsPromise: Promise<Argon2idPasswordHashParams> | null = null;
  private dummyHashPromise: Promise<string> | null = null;
  private readonly paramsProvider: () => Promise<Argon2idPasswordHashParams>;
  private readonly dummyPassword: string;

  constructor(opts: {
    paramsProvider?: () => Promise<Argon2idPasswordHashParams>;
    dummyPassword?: string;
  } = {}) {
    this.paramsProvider = opts.paramsProvider ?? (() => benchmarkPasswordHashParams());
    this.dummyPassword =
      opts.dummyPassword ?? randomBytes(32).toString('base64url');
  }

  async hashPassword(password: string): Promise<PasswordHashResult> {
    const params = await this.getParams();
    const passwordHash = await argon2Hash(password, argon2Options(params));
    return { passwordHash, passwordHashParams: params };
  }

  async verifyPassword(password: string, passwordHash: string): Promise<boolean> {
    try {
      return await argon2Verify(passwordHash, password);
    } catch {
      return false;
    }
  }

  async verifyDummyPassword(password: string): Promise<boolean> {
    const dummyHash = await this.getDummyHash();
    return this.verifyPassword(password, dummyHash);
  }

  async warmDummyHash(): Promise<void> {
    await this.getDummyHash();
  }

  private getParams(): Promise<Argon2idPasswordHashParams> {
    if (!this.paramsPromise) this.paramsPromise = this.paramsProvider();
    return this.paramsPromise;
  }

  private async getDummyHash(): Promise<string> {
    if (!this.dummyHashPromise) {
      this.dummyHashPromise = this.getParams().then(params =>
        argon2Hash(this.dummyPassword, argon2Options(params)),
      );
    }
    return this.dummyHashPromise;
  }
}

/** Login/credential orchestration (Argon2 cost floor, dummy-verify
 *  uniformity); persistence goes through the driver-free
 *  `AuthCredentialsPort`. */
export class PasswordCredentialService {
  constructor(
    private readonly credentials: AuthCredentialsPort,
    private readonly hasher: PasswordHasher = new Argon2idPasswordHasher(),
  ) {}

  getCredential(userId: string): UserPasswordCredentialRow | null {
    return this.credentials.getCredential(userId);
  }

  async setUserPasswordCredential(
    userId: string,
    password: string,
  ): Promise<UserPasswordCredentialRow> {
    return this.setPreparedUserPasswordCredential(
      userId,
      await this.hashPasswordCredential(password),
    );
  }

  async hashPasswordCredential(password: string): Promise<PasswordHashResult> {
    return this.hasher.hashPassword(password);
  }

  setPreparedUserPasswordCredential(
    userId: string,
    prepared: PasswordHashResult,
  ): UserPasswordCredentialRow {
    return this.credentials.upsertPreparedCredential(userId, prepared);
  }

  async verifyLoginPassword(input: {
    email: string;
    password: string;
  }): Promise<{ ok: true; userId: string } | { ok: false; code: 'auth_failed' }> {
    const email = normalizeLoginEmail(input.email);
    const row = this.credentials.lookupLoginCredential(email);

    if (!row?.passwordHash) {
      // Unknown email and profile-only users share the same credential
      // failure path: execute an Argon2id verify against the dummy PHC
      // before returning the generic auth failure.
      await this.hasher.verifyDummyPassword(input.password);
      return { ok: false, code: 'auth_failed' };
    }

    const ok = await this.hasher.verifyPassword(input.password, row.passwordHash);
    if (!ok) return { ok: false, code: 'auth_failed' };
    return { ok: true, userId: row.userId };
  }
}

export async function benchmarkPasswordHashParams(
  opts: PasswordHashBenchmarkOptions = {},
): Promise<Argon2idPasswordHashParams> {
  const env = opts.env ?? process.env;
  const targetMs =
    opts.targetMs ?? readPositiveInt(env.SILVERHAND_PASSWORD_HASH_TARGET_MS) ?? 250;
  const candidates = opts.candidates ?? defaultBenchmarkCandidates(env);
  if (candidates.length === 0) {
    throw new Error('benchmarkPasswordHashParams: no candidates available');
  }

  let selected = candidates[0]!;
  let measuredMs = 0;
  let candidateCount = 0;
  for (const candidate of candidates) {
    candidateCount += 1;
    measuredMs = opts.measureCandidate
      ? await opts.measureCandidate(candidate)
      : await measureArgon2Candidate(candidate);
    selected = candidate;
    if (measuredMs >= targetMs) break;
  }

  const flooredFrom =
    selected.memoryCostKiB < ARGON2_FLOOR_MEMORY_KIB
    || selected.timeCost < ARGON2_FLOOR_TIME_COST
      ? {
          memoryCostKiB: selected.memoryCostKiB,
          timeCost: selected.timeCost,
        }
      : undefined;
  const floored = {
    ...selected,
    memoryCostKiB: Math.max(selected.memoryCostKiB, ARGON2_FLOOR_MEMORY_KIB),
    timeCost: Math.max(selected.timeCost, ARGON2_FLOOR_TIME_COST),
  };

  return {
    algorithm: 'argon2id',
    library: '@node-rs/argon2',
    version: '0x13',
    ...floored,
    benchmark: {
      targetMs,
      measuredMs,
      candidateCount,
      selectedAt: Date.now(),
      cpuCount: cpuCount(),
      totalMemoryMiB: Math.round(totalmem() / 1024 / 1024),
      ...(flooredFrom ? { flooredFrom } : {}),
    },
  };
}

export function normalizeLoginEmail(email: string): string {
  return email.trim().toLowerCase();
}

function argon2Options(params: Argon2idCostCandidate) {
  return {
    algorithm: ARGON2ID_ALGORITHM,
    version: ARGON2_VERSION_0X13,
    memoryCost: params.memoryCostKiB,
    timeCost: params.timeCost,
    parallelism: params.parallelism,
    outputLen: params.outputLen,
  } as Argon2HashOptions;
}

async function measureArgon2Candidate(
  candidate: Argon2idCostCandidate,
): Promise<number> {
  const started = performance.now();
  await argon2Hash('silverhand-password-benchmark', argon2Options(candidate));
  return performance.now() - started;
}

function defaultBenchmarkCandidates(
  env: NodeJS.ProcessEnv,
): Argon2idCostCandidate[] {
  // Candidate bounds only. The concrete params used for a credential
  // come from measuring this environment and are stored with the hash.
  const parallelism =
    readPositiveInt(env.SILVERHAND_PASSWORD_HASH_PARALLELISM)
    ?? clamp(cpuCount(), 1, 4);
  const outputLen = readPositiveInt(env.SILVERHAND_PASSWORD_HASH_OUTPUT_LEN) ?? 32;
  const maxTimeCost = readPositiveInt(env.SILVERHAND_PASSWORD_HASH_MAX_TIME_COST) ?? 6;
  const maxMemoryKiB =
    readPositiveInt(env.SILVERHAND_PASSWORD_HASH_MAX_MEMORY_KIB)
    ?? powerOfTwoAtMost(clamp(Math.floor(totalmem() / 1024 / 256), 8 * 1024, 256 * 1024));
  const minMemoryKiB =
    readPositiveInt(env.SILVERHAND_PASSWORD_HASH_MIN_MEMORY_KIB)
    ?? Math.max(8 * 1024, powerOfTwoAtMost(Math.floor(maxMemoryKiB / 8)));

  const candidates: Argon2idCostCandidate[] = [];
  for (
    let memoryCostKiB = minMemoryKiB;
    memoryCostKiB <= maxMemoryKiB;
    memoryCostKiB *= 2
  ) {
    for (let timeCost = 1; timeCost <= maxTimeCost; timeCost += 1) {
      candidates.push({ memoryCostKiB, timeCost, parallelism, outputLen });
    }
  }
  return candidates.sort(
    (a, b) =>
      a.memoryCostKiB * a.timeCost - b.memoryCostKiB * b.timeCost
      || a.memoryCostKiB - b.memoryCostKiB
      || a.timeCost - b.timeCost,
  );
}

function readPositiveInt(value: string | undefined): number | null {
  if (!value) return null;
  if (!/^\d+$/.test(value)) return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function cpuCount(): number {
  return Math.max(1, cpus().length);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function powerOfTwoAtMost(value: number): number {
  if (value <= 1) return 1;
  return 2 ** Math.floor(Math.log2(value));
}
