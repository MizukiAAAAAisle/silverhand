/**
 * Auth credential value types — a dependency-free leaf shared by the
 * password-hashing service, the application ports, and the persistence
 * adapter, so no type has to travel through a service module (which would
 * re-create service↔port cycles and reverse repo→service dependencies).
 */

export interface Argon2idCostCandidate {
  memoryCostKiB: number;
  timeCost: number;
  parallelism: number;
  outputLen: number;
}

export interface Argon2idPasswordHashParams extends Argon2idCostCandidate {
  algorithm: 'argon2id';
  library: '@node-rs/argon2';
  version: '0x13';
  benchmark: {
    targetMs: number;
    measuredMs: number;
    candidateCount: number;
    selectedAt: number;
    cpuCount: number;
    totalMemoryMiB: number;
    flooredFrom?: {
      memoryCostKiB: number;
      timeCost: number;
    };
  };
}

export interface PasswordHashResult {
  passwordHash: string;
  passwordHashParams: Argon2idPasswordHashParams;
}
