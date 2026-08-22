/** @type {import('ts-to-zod').TsToZodConfig} */
module.exports = [
  {
    name: 'rustBackendWire',
    input: '../../../packages/shared/src/generated/rust-backend/wire.ts',
    output: '../../../packages/shared/src/generated/rust-backend/wire.zod.ts',
  },
];
