/** Public surface of `@silverhand/cli`. Most consumers should call the
 *  `silverhand` binary; these exports exist so the backend / tests can
 *  reach the error contract and command catalogue without spawning a
 *  child process. */
export { BackendClient } from './client.js';
export { COMMAND_GROUPS, findCommand, findGroup } from './commands/index.js';
export type { Command, NounGroup } from './commands/index.js';
export type { CliEnv } from './env.js';
export { loadEnv } from './env.js';
export {
  CliError,
  ERROR_CODES,
  exitCodeFor,
  fromNetworkError,
  fromUnknown,
  mapHttpError,
  writeError,
} from './errors.js';
export type { CliErrorPayload, ErrorCode } from './errors.js';
export { nounHelp, topLevelHelp, verbHelp } from './help.js';
export {
  flagBool,
  flagNumber,
  flagNumberArray,
  flagString,
  flagStringArray,
  parseArgs,
} from './parse.js';
export type { ParseOptions, ParsedArgs } from './parse.js';
