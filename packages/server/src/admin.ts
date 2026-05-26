import { constants } from 'node:fs';
import { lstat, readFile, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { emitKeypressEvents } from 'node:readline';
import {
  AdminResetPasswordError,
  createCategorizedLoggers,
  createLogLevelControl,
  resetAdminPassword,
  type CategorizedLoggers,
  type FileLogger,
} from '@silverhand/backend';
import { AuthSignupInputSchema } from '@silverhand/shared';
import {
  DEFAULT_SILVERHAND_DATA_DIR,
  DEFAULT_SILVERHAND_SERVER_LOG_LEVEL,
  SILVERHAND_DATA_DIR_ENV,
  SILVERHAND_SERVER_LOG_LEVEL_ENV,
  ServerEnvConfigError,
  parseDataDir,
  parseLogLevel,
  type ResolvedValue,
} from './config.js';

const RESET_PASSWORD_SCHEMA = AuthSignupInputSchema.pick({
  email: true,
  password: true,
});

export interface ServerAdminCommandIo {
  stdout?: CommandSink;
  stderr?: CommandSink;
  readPassword?: () => Promise<string>;
}

export interface CommandSink {
  write(chunk: string): unknown;
}

export async function runAdminCommand(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env,
  io: ServerAdminCommandIo = {},
): Promise<number> {
  const stdout = io.stdout ?? process.stdout;
  const stderr = io.stderr ?? process.stderr;

  let loggers: CategorizedLoggers | null = null;
  let emailForAudit: string | null = null;
  try {
    const parsed = parseAdminCommand(argv);
    if (parsed.kind === 'help') {
      stdout.write(adminUsage());
      return 0;
    }
    if (parsed.kind !== 'reset-password') {
      throw new AdminCommandError('usage', adminUsage());
    }
    emailForAudit = parsed.email;

    const config = resolveStandaloneAdminEnv(env);
    loggers = createCategorizedLoggers({
      dir: join(config.dataDir.value, 'logs'),
      alsoConsole: false,
      base: { app: 'silverhand-server', cli: 'admin' },
      // Admin recovery audit lines must be durable even when the server's
      // runtime log level is warn/error.
      logControl: createLogLevelControl('info'),
    });

    const password = parsed.passwordFromFile
      ? await readPasswordFile(parsed.passwordFromFile)
      : await (io.readPassword ?? promptMaskedPassword)();
    const input = RESET_PASSWORD_SCHEMA.safeParse({
      email: parsed.email,
      password,
    });
    if (!input.success) {
      throw new AdminCommandError(
        'invalid_input',
        'invalid_input: email must be valid and password must be 8-1024 characters',
      );
    }

    const reset = await resetAdminPassword({
      dbPath: join(config.dataDir.value, 'silverhand.db'),
      email: input.data.email,
      password: input.data.password,
      logger: loggers.cli,
    });
    stdout.write(
      `password reset for ${reset.email}; revoked ${reset.sessionsRevoked} session(s)\n`,
    );
    return 0;
  } catch (err) {
    const mapped = mapAdminCommandError(err);
    logAdminFailure(loggers?.cli ?? null, {
      email: emailForAudit,
      code: mapped.code,
    });
    stderr.write(`[silverhand-server admin] ${mapped.message}\n`);
    return 1;
  } finally {
    await closeLoggers(loggers);
  }
}

type ParsedAdminCommand =
  | { kind: 'help' }
  | {
      kind: 'reset-password';
      email: string;
      passwordFromFile: string | null;
    };

function parseAdminCommand(argv: string[]): ParsedAdminCommand {
  const [subcommand, ...rest] = argv;
  if (subcommand === '--help' || subcommand === '-h') {
    return { kind: 'help' };
  }
  if (!subcommand) {
    throw new AdminCommandError('usage', adminUsage());
  }
  if (subcommand !== 'reset-password') {
    throw new AdminCommandError('usage', adminUsage());
  }

  let email: string | null = null;
  let passwordFromFile: string | null = null;
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i]!;
    if (arg === '--email') {
      email = requiredFlagValue(rest, ++i, '--email');
      continue;
    }
    if (arg.startsWith('--email=')) {
      email = requiredInlineFlagValue(arg, '--email');
      continue;
    }
    if (arg === '--password-from-file') {
      passwordFromFile = requiredFlagValue(rest, ++i, '--password-from-file');
      continue;
    }
    if (arg.startsWith('--password-from-file=')) {
      passwordFromFile = requiredInlineFlagValue(arg, '--password-from-file');
      continue;
    }
    if (arg === '--password' || arg.startsWith('--password=')) {
      throw new AdminCommandError(
        'usage',
        'plain --password is not supported; use --password-from-file or the masked prompt',
      );
    }
    throw new AdminCommandError('usage', `unknown argument: ${arg}`);
  }
  if (!email) {
    throw new AdminCommandError('usage', 'missing required --email');
  }
  return { kind: 'reset-password', email, passwordFromFile };
}

async function readPasswordFile(filepath: string): Promise<string> {
  const linkInfo = await lstat(filepath).catch(err => {
    throw new AdminCommandError(
      'password_file_invalid',
      `could not stat password file: ${errorMessage(err)}`,
    );
  });
  if (linkInfo.isSymbolicLink()) {
    throw new AdminCommandError(
      'password_file_invalid',
      '--password-from-file must not be a symbolic link',
    );
  }

  const info = await stat(filepath).catch(err => {
    throw new AdminCommandError(
      'password_file_invalid',
      `could not stat password file: ${errorMessage(err)}`,
    );
  });
  if (!info.isFile()) {
    throw new AdminCommandError(
      'password_file_invalid',
      '--password-from-file must point to a regular file',
    );
  }
  if ((info.mode & (constants.S_IRWXG | constants.S_IRWXO)) !== 0) {
    throw new AdminCommandError(
      'password_file_permissions',
      '--password-from-file must be readable only by its owner (0600)',
    );
  }
  const raw = await readFile(filepath, 'utf8').catch(err => {
    throw new AdminCommandError(
      'password_file_invalid',
      `could not read password file: ${errorMessage(err)}`,
    );
  });
  try {
    await unlink(filepath);
  } catch (err) {
    throw new AdminCommandError(
      'password_file_unlink_failed',
      `could not unlink password file after reading: ${errorMessage(err)}`,
    );
  }
  return raw.replace(/\r?\n$/, '');
}

async function promptMaskedPassword(): Promise<string> {
  const stdin = process.stdin;
  const stderr = process.stderr;
  if (!stdin.isTTY || typeof stdin.setRawMode !== 'function') {
    throw new AdminCommandError(
      'password_prompt_unavailable',
      'no interactive TTY available; use --password-from-file',
    );
  }

  stderr.write('New password: ');
  emitKeypressEvents(stdin);
  const wasRaw = stdin.isRaw;
  stdin.setRawMode(true);
  stdin.resume();

  return new Promise((resolve, reject) => {
    let value = '';
    let settled = false;
    const finish = (err: Error | null, password = ''): void => {
      if (settled) return;
      settled = true;
      stdin.off('keypress', onKeypress);
      stdin.setRawMode(wasRaw);
      stderr.write('\n');
      if (err) reject(err);
      else resolve(password);
    };
    const onKeypress = (str: string, key: { name?: string; ctrl?: boolean }): void => {
      if (key.ctrl && key.name === 'c') {
        finish(
          new AdminCommandError(
            'password_prompt_interrupted',
            'password prompt interrupted',
          ),
        );
        return;
      }
      if (key.name === 'return' || key.name === 'enter') {
        finish(null, value);
        return;
      }
      if (key.name === 'backspace') {
        if (value.length > 0) {
          value = value.slice(0, -1);
          stderr.write('\b \b');
        }
        return;
      }
      if (str && !key.ctrl) {
        value += str;
        stderr.write('*');
      }
    };
    stdin.on('keypress', onKeypress);
  });
}

interface StandaloneAdminEnvConfig {
  dataDir: ResolvedValue<string>;
  logLevel: ResolvedValue<ReturnType<typeof parseLogLevel>>;
}

function resolveStandaloneAdminEnv(
  env: NodeJS.ProcessEnv,
): StandaloneAdminEnvConfig {
  return {
    dataDir: resolveAdminValue(
      env[SILVERHAND_DATA_DIR_ENV],
      parseDataDir,
      SILVERHAND_DATA_DIR_ENV,
      DEFAULT_SILVERHAND_DATA_DIR,
    ),
    logLevel: resolveAdminValue(
      env[SILVERHAND_SERVER_LOG_LEVEL_ENV],
      parseLogLevel,
      SILVERHAND_SERVER_LOG_LEVEL_ENV,
      DEFAULT_SILVERHAND_SERVER_LOG_LEVEL,
    ),
  };
}

function resolveAdminValue<T>(
  raw: string | undefined,
  parse: (value: string, variable: string) => T,
  variable: string,
  defaultValue: T,
): ResolvedValue<T> {
  if (raw === undefined || raw === '') return { value: defaultValue, source: 'default' };
  return { value: parse(raw, variable), source: 'env' };
}

function logAdminFailure(
  logger: FileLogger | null,
  failure: { email: string | null; code: string },
): void {
  logger?.warn(
    {
      admin_op: 'reset-password',
      user_email: failure.email,
      success: false,
      code: failure.code,
      ts: Date.now(),
    },
    'admin reset-password failed',
  );
}

async function closeLoggers(loggers: CategorizedLoggers | null): Promise<void> {
  if (!loggers) return;
  await Promise.all([
    loggers.system.close(),
    loggers.agent.close(),
    loggers.cli.close(),
  ]);
}

function mapAdminCommandError(err: unknown): { code: string; message: string } {
  if (err instanceof AdminCommandError) {
    return { code: err.code, message: err.message };
  }
  if (err instanceof AdminResetPasswordError) {
    return { code: err.code, message: err.message };
  }
  if (err instanceof ServerEnvConfigError) {
    return { code: 'invalid_configuration', message: err.message };
  }
  return {
    code: 'unexpected',
    message: `unexpected admin failure: ${errorMessage(err)}`,
  };
}

function requiredFlagValue(
  argv: string[],
  index: number,
  flag: string,
): string {
  const value = argv[index];
  if (!value || value.startsWith('--')) {
    throw new AdminCommandError('usage', `${flag} requires a value`);
  }
  return value;
}

function requiredInlineFlagValue(arg: string, flag: string): string {
  const prefix = `${flag}=`;
  const value = arg.slice(prefix.length);
  if (!value) throw new AdminCommandError('usage', `${flag} requires a value`);
  return value;
}

function adminUsage(): string {
  return [
    'Usage:',
    '  silverhand-server admin reset-password --email <email> [--password-from-file <path>]',
    '',
    'Notes:',
    '  --password is intentionally unsupported.',
    '  Without --password-from-file, the command reads a masked TTY prompt.',
    '',
  ].join('\n');
}

class AdminCommandError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'AdminCommandError';
  }
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
