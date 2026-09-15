import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { appError } from "./errors.ts";

const configNames = [
  ".antisprawl/config.jsonc",
  ".antisprawl/config.json",
  ".antisprawl.jsonc",
  ".antisprawl.json",
] as const;

const ConfigSchema = Schema.Struct({
  version: Schema.optionalKey(Schema.Int),
  sources: Schema.Struct({
    include: Schema.Array(Schema.String),
    exclude: Schema.optionalKey(Schema.Array(Schema.String)),
  }),
  embedding: Schema.optionalKey(Schema.Unknown),
});

const UnknownRecord = Schema.Record(Schema.String, Schema.Unknown);

export interface Diagnostic {
  readonly severity: "warning";
  readonly code: string;
  readonly path?: string;
}

export interface Project {
  readonly root: string;
  readonly configHash: string;
  readonly include: ReadonlyArray<string>;
  readonly exclude: ReadonlyArray<string>;
  readonly diagnostics: ReadonlyArray<Diagnostic>;
}

const sha256 = (value: string) => new Bun.CryptoHasher("sha256").update(value).digest("hex");

export const resolveProject = Effect.fn("Project.resolve")(function* (startingDirectory: string) {
  const fs = yield* FileSystem.FileSystem;
  const paths = yield* Path.Path;
  let directory = paths.resolve(startingDirectory);

  while (true) {
    const existing: Array<(typeof configNames)[number]> = [];

    for (const name of configNames) {
      if (yield* fs.exists(paths.join(directory, name))) existing.push(name);
    }

    if (existing.length > 0) {
      const selected = existing[0];

      if (selected === undefined) throw new Error("unreachable");

      const configPath = paths.join(directory, selected);

      const text = yield* fs
        .readFileString(configPath)
        .pipe(Effect.mapError(() => appError("config_unreadable", `Cannot read ${selected}.`)));

      const raw = yield* Effect.try({
        try: () => Bun.JSONC.parse(text),
        catch: () => appError("config_invalid_jsonc", `${selected} is not valid JSONC.`),
      });

      const rawRecord = yield* Schema.decodeUnknownEffect(UnknownRecord)(raw).pipe(
        Effect.mapError(() => appError("config_invalid", `${selected} must contain an object.`)),
      );

      const decoded = yield* Schema.decodeUnknownEffect(ConfigSchema)(raw).pipe(
        Effect.mapError((error) => appError("config_invalid", String(error))),
      );

      if (decoded.version !== undefined && decoded.version !== 1) {
        return yield* appError(
          "config_version_unsupported",
          `Configuration version ${decoded.version} is unsupported.`,
        );
      }

      if (decoded.embedding !== undefined) {
        return yield* appError(
          "embedding_not_supported",
          "This increment supports Structural-only configuration.",
        );
      }

      if (decoded.sources.include.length === 0) {
        return yield* appError(
          "config_invalid",
          "sources.include must contain at least one pattern.",
        );
      }

      const diagnostics: Array<Diagnostic> = existing.slice(1).map((name) => ({
        severity: "warning",
        code: "config_shadowed",
        path: name,
      }));

      if (decoded.version === undefined) {
        diagnostics.push({ severity: "warning", code: "config_version_defaulted", path: selected });
      }

      const knownKeys = new Set([
        "$schema",
        "detection",
        "embedding",
        "grammars",
        "sources",
        "suppressions",
        "version",
      ]);

      for (const key of Object.keys(rawRecord)) {
        if (!knownKeys.has(key)) {
          diagnostics.push({ severity: "warning", code: "config_unknown_key", path: key });
        }
      }

      return {
        root: directory,
        configHash: sha256(text),
        include: decoded.sources.include,
        exclude: decoded.sources.exclude ?? [],
        diagnostics,
      } satisfies Project;
    }

    const parent = paths.dirname(directory);

    if (parent === directory) {
      return yield* appError("project_not_found", `No ${configNames.join(", ")} found.`);
    }

    directory = parent;
  }
});

const isTypeScriptPath = (path: string) => {
  if (path.endsWith(".tsx")) return false;

  return path.endsWith(".ts") || path.endsWith(".mts") || path.endsWith(".cts");
};

export const discoverSourcePaths = Effect.fn("Project.discoverSources")(function* (
  project: Project,
) {
  const fs = yield* FileSystem.FileSystem;
  const paths = yield* Path.Path;
  const root = paths.resolve(project.root);

  const realRoot = yield* fs
    .realPath(root)
    .pipe(Effect.mapError(() => appError("project_unreadable", "The Project cannot be read.")));

  const matches = new Set<string>();

  const isInside = (parent: string, child: string) => {
    const relative = paths.relative(parent, child);

    return (
      relative !== ".." && !relative.startsWith(`..${paths.sep}`) && !paths.isAbsolute(relative)
    );
  };

  for (const include of project.include) {
    const discovered = yield* fs.glob(include, {
      root,
      exclude: [".antisprawl/**", ...project.exclude],
    });

    for (const path of discovered) {
      if (!isTypeScriptPath(path)) continue;

      const absolutePath = paths.resolve(root, path);

      const realPath = yield* fs
        .realPath(absolutePath)
        .pipe(Effect.mapError(() => appError("source_unreadable", `Cannot read ${path}.`)));

      if (!isInside(root, absolutePath) || !isInside(realRoot, realPath)) {
        return yield* appError(
          "source_outside_project",
          `Source path ${path} escapes the Project.`,
        );
      }

      matches.add(paths.relative(root, absolutePath).split(paths.sep).join("/"));
    }
  }

  return [...matches].sort();
});
