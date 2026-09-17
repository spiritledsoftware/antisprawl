import {
  isEditToolResult,
  isWriteToolResult,
  type ExecResult,
  type ExtensionAPI,
  type ExtensionContext,
  type ToolResultEvent,
} from "@earendil-works/pi-coding-agent";

const checkTimeoutMs = 5000;

const silentCodes = new Set(["project_not_found", "source_path_unsupported"]);

const indexCodes = new Set(["index_missing", "index_incompatible"]);

const configCodes = new Set(["config_invalid", "config_invalid_jsonc", "config_unreadable"]);

type Json = string | number | boolean | null | readonly Json[] | JsonObject;

type JsonObject = { readonly [key: string]: Json };

type Location = {
  readonly path: string;
  readonly qualifiedName: string;
  readonly range: { readonly start: { readonly line: number; readonly column: number } };
};

type Finding = {
  readonly id: string;
  readonly edited: Location;
  readonly candidate: Location;
  readonly structuralEvidence: {
    readonly strictHashEqual: boolean;
    readonly normalizedHashEqual: boolean;
    readonly qgramSimilarity: number;
    readonly orderedTokenSimilarity: number;
  };
  readonly semanticEvidence: { readonly cosineSimilarity: number } | undefined;
  readonly guidance: string;
};

type Diagnostic = {
  readonly code: string;
  readonly path: string | undefined;
  readonly message: string | undefined;
};

type CheckOutput = {
  readonly findings: readonly Finding[];
  readonly diagnostics: readonly Diagnostic[];
};

type ToolResultPatch = {
  readonly content: ToolResultEvent["content"];
};

const jsonTag = (value: Json | undefined): string => Object.prototype.toString.call(value);

const asObject = (value: Json | undefined): JsonObject | undefined => {
  if (value === undefined || jsonTag(value) !== "[object Object]") return;

  // SAFETY: JSON objects are string-key maps.
  return value as JsonObject;
};

const asString = (value: Json | undefined): string | undefined => {
  if (jsonTag(value) !== "[object String]") return;

  // SAFETY: JSON string primitives tag as [object String].
  return value as string;
};

const asBoolean = (value: Json | undefined): boolean | undefined => {
  if (jsonTag(value) !== "[object Boolean]") return;

  return value === true;
};

const asFinite = (value: Json | undefined): number | undefined => {
  if (jsonTag(value) !== "[object Number]" || !Number.isFinite(value)) return;

  // SAFETY: JSON numbers that pass Number.isFinite are finite numbers.
  return value as number;
};

const asArray = (value: Json | undefined): readonly Json[] | undefined =>
  Array.isArray(value) ? value : undefined;

const parseJson = (text: string): Json | undefined => {
  try {
    // SAFETY: JSON.parse returns JSON values.
    return JSON.parse(text) as Json;
  } catch {
    return;
  }
};

const asLocation = (value: Json | undefined): Location | undefined => {
  const object = asObject(value);

  if (object === undefined) return;

  const path = asString(object.path);
  const qualifiedName = asString(object.qualifiedName);
  const range = asObject(object.range);
  const start = range === undefined ? undefined : asObject(range.start);
  const line = start === undefined ? undefined : asFinite(start.line);
  const column = start === undefined ? undefined : asFinite(start.column);

  if (
    path === undefined ||
    qualifiedName === undefined ||
    line === undefined ||
    column === undefined
  ) {
    return;
  }

  return { path, qualifiedName, range: { start: { line, column } } };
};

const asFinding = (value: Json): Finding | undefined => {
  const object = asObject(value);

  if (object === undefined) return;

  const id = asString(object.id);
  const edited = asLocation(object.edited);
  const candidate = asLocation(object.candidate);
  const structural = asObject(object.structuralEvidence);
  const guidance = asString(object.guidance);

  const strictHashEqual =
    structural === undefined ? undefined : asBoolean(structural.strictHashEqual);

  const normalizedHashEqual =
    structural === undefined ? undefined : asBoolean(structural.normalizedHashEqual);

  const qgramSimilarity =
    structural === undefined ? undefined : asFinite(structural.qgramSimilarity);

  const orderedTokenSimilarity =
    structural === undefined ? undefined : asFinite(structural.orderedTokenSimilarity);

  if (
    id === undefined ||
    edited === undefined ||
    candidate === undefined ||
    guidance === undefined ||
    strictHashEqual === undefined ||
    normalizedHashEqual === undefined ||
    qgramSimilarity === undefined ||
    orderedTokenSimilarity === undefined
  ) {
    return;
  }

  let semanticEvidence: Finding["semanticEvidence"];

  if (object.semanticEvidence !== undefined) {
    const cosineSimilarity = asFinite(asObject(object.semanticEvidence)?.cosineSimilarity);

    if (cosineSimilarity === undefined) return;

    semanticEvidence = { cosineSimilarity };
  }

  return {
    id,
    edited,
    candidate,
    structuralEvidence: {
      strictHashEqual,
      normalizedHashEqual,
      qgramSimilarity,
      orderedTokenSimilarity,
    },
    semanticEvidence,
    guidance,
  };
};

const asDiagnostic = (value: Json): Diagnostic | undefined => {
  const object = asObject(value);

  if (object === undefined) return;

  const code = asString(object.code);

  if (code === undefined) return;

  return {
    code,
    path: object.path === undefined ? undefined : asString(object.path),
    message: object.message === undefined ? undefined : asString(object.message),
  };
};

const parseCheck = (stdout: string): CheckOutput | undefined => {
  const object = asObject(parseJson(stdout));

  if (object === undefined) return;

  if (asFinite(object.protocolVersion) !== 1 || asString(object.command) !== "check") return;

  const findingsJson = asArray(object.findings);
  const diagnosticsJson = asArray(object.diagnostics);

  if (findingsJson === undefined || diagnosticsJson === undefined) return;

  const findings: Finding[] = [];

  for (const item of findingsJson) {
    const finding = asFinding(item);

    if (finding === undefined) return;

    findings.push(finding);
  }

  const diagnostics: Diagnostic[] = [];

  for (const item of diagnosticsJson) {
    const diagnostic = asDiagnostic(item);

    if (diagnostic === undefined) return;

    diagnostics.push(diagnostic);
  }

  return { findings, diagnostics };
};

const errorCode = (stderr: string): string | undefined => /error\[([^\]]+)\]:/.exec(stderr)?.[1];

const formatLocation = (location: Location): string =>
  `${location.qualifiedName} (${location.path}:${location.range.start.line}:${location.range.start.column})`;

const renderFinding = (finding: Finding): string => {
  const lines = [
    `id: ${finding.id}`,
    `Edited: ${formatLocation(finding.edited)}`,
    `Candidate: ${formatLocation(finding.candidate)}`,
    `strictHashEqual: ${finding.structuralEvidence.strictHashEqual}`,
    `normalizedHashEqual: ${finding.structuralEvidence.normalizedHashEqual}`,
    `qgramSimilarity: ${finding.structuralEvidence.qgramSimilarity}`,
    `orderedTokenSimilarity: ${finding.structuralEvidence.orderedTokenSimilarity}`,
  ];

  if (finding.semanticEvidence !== undefined) {
    lines.push(`cosineSimilarity: ${finding.semanticEvidence.cosineSimilarity}`);
  }

  lines.push(finding.guidance);

  return lines.join("\n");
};

const renderDiagnostic = (diagnostic: Diagnostic): string => {
  const parts = [diagnostic.code];

  if (diagnostic.path !== undefined) parts.push(diagnostic.path);

  if (diagnostic.message !== undefined) parts.push(diagnostic.message);

  return parts.join(" ");
};

const appendText = (
  event: ToolResultEvent,
  lines: readonly string[],
): ToolResultPatch | undefined => {
  if (lines.length === 0) return;

  return {
    content: [...event.content, { type: "text", text: lines.join("\n") }],
  };
};

const note = (seen: Set<string>, key: string, text: string, lines: string[]): void => {
  if (seen.has(key)) return;

  seen.add(key);
  lines.push(text);
};

const pathArgument = (event: ToolResultEvent): string | undefined => {
  // SAFETY: edit/write path arguments are JSON strings when present.
  const path = asString(event.input.path as Json | undefined);

  if (path === undefined || path.length === 0) return;

  return path.startsWith("@") ? path.slice(1) : path;
};

const onToolResult = async (
  event: ToolResultEvent,
  ctx: Pick<ExtensionContext, "cwd" | "signal">,
  exec: ExtensionAPI["exec"],
  seen: Set<string>,
): Promise<ToolResultPatch | undefined> => {
  if (event.isError || !(isEditToolResult(event) || isWriteToolResult(event))) return;

  const path = pathArgument(event);

  if (path === undefined) return;

  const result: ExecResult = await exec("antisprawl", ["check", path], {
    cwd: ctx.cwd,
    signal: ctx.signal,
    timeout: checkTimeoutMs,
  });

  if (result.killed) return;

  const code = errorCode(result.stderr);
  const lines: string[] = [];

  if (result.code !== 0) {
    if (code !== undefined) {
      if (silentCodes.has(code)) return;

      if (indexCodes.has(code)) note(seen, "index", "Run antisprawl index.", lines);
      else if (configCodes.has(code)) {
        note(seen, "config", "Antisprawl configuration is invalid.", lines);
      }

      return appendText(event, lines);
    }

    if (result.stderr.trim() === "") {
      note(seen, "missing", "antisprawl is not on PATH.", lines);
    }

    return appendText(event, lines);
  }

  const check = parseCheck(result.stdout);

  if (check === undefined) {
    note(seen, "protocol", "Update antisprawl and @antisprawl/pi to compatible versions.", lines);

    return appendText(event, lines);
  }

  const shown = check.findings.slice(0, 3);

  for (const finding of shown) lines.push(renderFinding(finding));

  const omitted = check.findings.length - shown.length;

  if (omitted > 0) lines.push(`(+${omitted} more Findings)`);

  for (const diagnostic of check.diagnostics) {
    if (seen.has(diagnostic.code)) continue;

    seen.add(diagnostic.code);
    lines.push(renderDiagnostic(diagnostic));
  }

  return appendText(event, lines);
};

export default function (pi: ExtensionAPI): void {
  const seen = new Set<string>();

  pi.on("session_start", () => {
    seen.clear();
  });
  pi.on("tool_result", (event, ctx) =>
    onToolResult(event, ctx, (command, args, options) => pi.exec(command, args, options), seen),
  );
}
