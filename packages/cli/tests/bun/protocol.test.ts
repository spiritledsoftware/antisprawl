import { test } from "bun:test";
import * as Effect from "effect/Effect";
import { encodeProtocolJson } from "../../src/protocol.ts";

test("malformed command output fails before serialization", () =>
  Effect.runPromise(encodeProtocolJson({ command: "check" }).pipe(Effect.flip, Effect.asVoid)));
