import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const iosDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export function archiveOptions(args, env) {
  const { values } = parseArgs({
    args,
    options: {
      build: { type: "string" },
      version: { type: "string" },
      unsigned: { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
  });
  if (values.help) return values;
  if (!/^[1-9]\d{0,3}(?:\.\d{1,2}){0,2}$/.test(values.build ?? "")) {
    throw new Error("Pass --build with a new build number (for example --build 2).");
  }
  if (values.version !== undefined && !/^\d+\.\d+(?:\.\d+)?$/.test(values.version)) {
    throw new Error("--version must be a release version such as 1.0 or 1.0.1.");
  }
  if (!env.SILVERHAND_DEFAULT_SERVER_URL?.trim()) {
    throw new Error("Set SILVERHAND_DEFAULT_SERVER_URL explicitly for a release archive.");
  }
  return values;
}

function run(command, args) {
  const result = spawnSync(command, args, { cwd: iosDir, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed (${result.status ?? result.signal})`);
}

function main() {
  const options = archiveOptions(process.argv.slice(2), process.env);
  if (options.help) {
    console.log("pnpm --filter @silverhand/ios archive --build N [--version 1.0] [--unsigned]");
    console.log("Requires SILVERHAND_DEFAULT_SERVER_URL. Archives locally; never uploads.");
    return;
  }
  run("pnpm", ["sync"]);
  const root = resolve(iosDir, "../../.cache/ios-release");
  mkdirSync(root, { recursive: true });
  const output = mkdtempSync(resolve(root, `build-${options.build}-`));
  const archive = resolve(output, "Silverhand.xcarchive");
  const args = [
    "-project",
    "ios/App/App.xcodeproj",
    "-scheme",
    "App",
    "-configuration",
    "Release",
    "-destination",
    "generic/platform=iOS",
    "-archivePath",
    archive,
    "-derivedDataPath",
    resolve(root, "DerivedData"),
    `CURRENT_PROJECT_VERSION=${options.build}`,
  ];
  if (options.version) args.push(`MARKETING_VERSION=${options.version}`);
  if (options.unsigned) args.push("CODE_SIGNING_ALLOWED=NO");
  run("xcodebuild", [...args, "archive"]);
  console.log(`Archive: ${archive}`);
  console.log(
    options.unsigned
      ? "UNSIGNED validation only: not eligible for upload or installation."
      : "Open the archive in Xcode Organizer to validate and distribute when approved.",
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
