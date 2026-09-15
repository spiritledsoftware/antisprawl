import packageJson from "../package.json" with { type: "json" };
import * as BunRuntime from "@effect/platform-bun/BunRuntime";
import * as BunServices from "@effect/platform-bun/BunServices";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Command from "effect/unstable/cli/Command";
import { indexProject } from "./app.ts";
import { appError } from "./errors.ts";

const expectedBunVersion = packageJson.devEngines.packageManager.version;

const index = Command.make("index", {}, () =>
  Effect.gen(function* () {
    if (process.versions.bun !== expectedBunVersion) {
      return yield* appError(
        "bun_version_mismatch",
        `Expected Bun ${expectedBunVersion}, got ${process.versions.bun}.`,
      );
    }

    const output = yield* indexProject(process.cwd());

    for (const diagnostic of output.diagnostics) {
      yield* Console.error(
        `warning[${diagnostic.code}]${diagnostic.path === undefined ? "" : `: ${diagnostic.path}`}`,
      );
    }

    const json = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(output);

    yield* Console.log(json);
  }),
);

const app = Command.make("antisprawl").pipe(Command.withSubcommands([index]));

const program = Command.runWith(app, { version: packageJson.version })(process.argv.slice(2)).pipe(
  Effect.provide(BunServices.layer),
);

BunRuntime.runMain(program);
