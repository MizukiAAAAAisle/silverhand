/** @type {import("ts-to-zod").TsToZodConfig} */
module.exports = [
  {
    name: "wire",
    input: "./wire-types.ts",
    output: "./generated/Wire.zod.ts",
  },
];
