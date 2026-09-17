import packageJson from "../package.json" with { type: "json" };
import * as BunRuntime from "@effect/platform-bun/BunRuntime";
import * as BunServices from "@effect/platform-bun/BunServices";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Argument from "effect/unstable/cli/Argument";
import * as Command from "effect/unstable/cli/Command";
import * as Flag from "effect/unstable/cli/Flag";
import { checkProject, dryRunIndex, indexProject } from "./app.ts";
import { AppError, appError } from "./errors.ts";
import { encodeProtocolJson, type ProtocolOutput } from "./protocol.ts";

const expectedBunVersion = packageJson.devEngines.packageManager.version;

const requireBunVersion =
  process.versions.bun === expectedBunVersion
    ? Effect.void
    : appError(
        "bun_version_mismatch",
        `Expected Bun ${expectedBunVersion}, got ${process.versions.bun}.`,
      );

const emitOutput = (output: ProtocolOutput) =>
  Effect.gen(function* () {
    const json = yield* encodeProtocolJson(output).pipe(
      Effect.mapError(() => appError("output_invalid", "The command produced invalid output.")),
    );

    for (const diagnostic of output.diagnostics) {
      yield* Console.error(
        `warning[${diagnostic.code}]${diagnostic.path === undefined ? "" : `: ${diagnostic.path}`}${diagnostic.message === undefined ? "" : `: ${diagnostic.message}`}`,
      );
    }

    yield* Console.log(json);
  });

const index = Command.make(
  "index",
  { dryRun: Flag.Boolean("dry-run").pipe(Flag.withDefault(false)) },
  ({ dryRun }) =>
    Effect.gen(function* () {
      yield* requireBunVersion;
      yield* emitOutput(yield* dryRun ? dryRunIndex(process.cwd()) : indexProject(process.cwd()));
    }),
);

const check = Command.make(
  "check",
  { paths: Argument.String("paths").pipe(Argument.variadic) },
  ({ paths }) =>
    Effect.gen(function* () {
      yield* requireBunVersion;
      yield* emitOutput(yield* checkProject(process.cwd(), paths.map(String)));
    }),
);

const app = Command.make("antisprawl").pipe(Command.withSubcommands([index, check]));

const commandArguments = process.argv.slice(2);

const helpFlags = new Set(["--help", "-h", "--version", "-v"]);

const command = commandArguments[0];

const rest = commandArguments.slice(1);

const separator = rest.indexOf("--");

const flags = separator === -1 ? rest : rest.slice(0, separator);

const invocationIsValid =
  (commandArguments.length === 1 && command !== undefined && helpFlags.has(command)) ||
  (command === "index" &&
    (rest.length === 0 ||
      (rest.length === 1 && (helpFlags.has(rest[0]!) || rest[0] === "--dry-run")))) ||
  (command === "check" &&
    (rest.length === 0 ||
      (rest.length === 1 && helpFlags.has(rest[0]!)) ||
      flags.every((argument) => !argument.startsWith("-"))));

const validateInvocation = invocationIsValid
  ? Effect.void
  : Effect.fail(appError("invocation_invalid", "Invalid command invocation."));

const program = validateInvocation.pipe(
  Effect.andThen(Command.runWith(app, { version: packageJson.version })(commandArguments)),
  Effect.catch((error) =>
    Effect.gen(function* () {
      yield* Console.error(
        Schema.is(AppError)(error)
          ? `error[${error.code}]: ${error.message}`
          : "error: The command failed.",
      );
      process.exitCode = 1;
    }),
  ),
  Effect.provide(BunServices.layer),
);

BunRuntime.runMain(program);
