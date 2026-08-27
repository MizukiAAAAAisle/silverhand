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

/**
 * The honest calibration provenance the Rust `argon2` (RustCrypto) producer
 * records. It deliberately omits the Node-only wall-clock/host fields
 * (`selectedAt`/`cpuCount`/`totalMemoryMiB`) — a different runtime measured this
 * cost, so it reports only what it actually knows.
 */
export interface Argon2idRustCalibration {
  targetMs: number;
  measuredMs: number;
  candidateCount: number;
  floorMemoryCostKiB: number;
  floorTimeCost: number;
}

/**
 * The Rust producer arm of the persisted `password_hash_params`. It shares the
 * top-level cost fields with the Node arm (`Argon2idCostCandidate`) and is
 * discriminated from it by `library`; its provenance sits under `calibration`,
 * never the Node-shaped `benchmark`.
 */
export interface RustArgon2idPasswordHashParams extends Argon2idCostCandidate {
  algorithm: 'argon2id';
  library: 'silverhand/argon2-rustcrypto';
  version: '0x13';
  calibration: Argon2idRustCalibration;
}

/**
 * A persisted `password_hash_params` value, from EITHER producer. Reads
 * (`parsePasswordHashParams`) admit both arms, discriminated by `library`, so a
 * credential written by the Rust backend and one written by the legacy Node
 * hasher are both first-class. The TS hasher still produces only the Node arm
 * (`Argon2idPasswordHashParams`); this union is a read-side widening.
 */
export type PersistedPasswordHashParams =
  | Argon2idPasswordHashParams
  | RustArgon2idPasswordHashParams;

export interface PasswordHashResult {
  passwordHash: string;
  passwordHashParams: Argon2idPasswordHashParams;
}
