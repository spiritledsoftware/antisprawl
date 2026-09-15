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
  detection: Schema.optionalKey(Schema.Unknown),
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
        Effect.mapError(() => appError("config_invalid", `${selected} is invalid.`)),
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

      if (decoded.detection !== undefined) {
        return yield* appError(
          "detection_not_supported",
          "Custom detection settings are not supported in this increment.",
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

export const isTypeScriptPath = (path: string) => {
  if (path.endsWith(".tsx")) return false;

  return path.endsWith(".ts") || path.endsWith(".mts") || path.endsWith(".cts");
};

const isInside = (paths: Path.Path, parent: string, child: string) => {
  const relative = paths.relative(parent, child);

  return relative !== ".." && !relative.startsWith(`..${paths.sep}`) && !paths.isAbsolute(relative);
};

const matchesSourcePolicy = (project: Project, path: string) => {
  const included = project.include.some((pattern) => new Bun.Glob(pattern).match(path));

  const excluded = [".antisprawl/**", ...project.exclude].some((pattern) =>
    new Bun.Glob(pattern).match(path),
  );

  return included && !excluded;
};

export interface NamedSourcePath {
  readonly path: string;
  readonly exists: boolean;
}

export const resolveNamedSourcePaths = Effect.fn("Project.resolveNamedSources")(function* (
  project: Project,
  startingDirectory: string,
  arguments_: ReadonlyArray<string>,
) {
  const fs = yield* FileSystem.FileSystem;
  const paths = yield* Path.Path;
  const root = paths.resolve(project.root);

  const realRoot = yield* fs
    .realPath(root)
    .pipe(Effect.mapError(() => appError("project_unreadable", "The Project cannot be read.")));

  const resolved = new Map<string, NamedSourcePath>();

  for (const argument of arguments_) {
    if (/[*?[\]{}]/.test(argument)) {
      return yield* appError("source_path_invalid", `Source path ${argument} must be literal.`);
    }

    const absolutePath = paths.resolve(startingDirectory, argument);

    if (!isInside(paths, root, absolutePath)) {
      return yield* appError(
        "source_outside_project",
        `Source path ${argument} escapes the Project.`,
      );
    }

    const path = paths.relative(root, absolutePath).split(paths.sep).join("/");

    if (!isTypeScriptPath(path) || !matchesSourcePolicy(project, path)) {
      return yield* appError(
        "source_path_unsupported",
        `Source path ${argument} is outside the configured TypeScript source scope.`,
      );
    }

    const exists = yield* fs.exists(absolutePath);

    if (exists) {
      const info = yield* fs
        .stat(absolutePath)
        .pipe(Effect.mapError(() => appError("source_unreadable", `Cannot read ${path}.`)));

      if (info.type !== "File") {
        return yield* appError("source_path_invalid", `Source path ${argument} is not a file.`);
      }

      const realPath = yield* fs
        .realPath(absolutePath)
        .pipe(Effect.mapError(() => appError("source_unreadable", `Cannot read ${path}.`)));

      if (!isInside(paths, realRoot, realPath)) {
        return yield* appError(
          "source_outside_project",
          `Source path ${argument} escapes the Project.`,
        );
      }
    }

    resolved.set(path, { path, exists });
  }

  return [...resolved.values()].sort((left, right) => left.path.localeCompare(right.path));
});

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

      if (!isInside(paths, root, absolutePath) || !isInside(paths, realRoot, realPath)) {
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
