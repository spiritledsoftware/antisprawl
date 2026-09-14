# Agent hook lifecycle research

**Issue:** [#6](https://github.com/spiritledsoftware/antisprawl/issues/6)
**Research date:** 2026-09-14
**Question:** Which lifecycle and hook points can start sessions, report changed paths, flush before model work where possible, shut down watchers, and deliver fail-open advisory JSON for Pi, Codex CLI, and Claude Code?

This report describes the documented behavior and source at the revisions below. It does not treat a hook as an enforcement boundary: Antisprawl remains advisory and its adapters must fail open.

## Revisions checked

| Harness     | Revision checked                                                                                                                                                                                 | Primary source                                                                                                                                                                                                                                                                                          |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pi          | `@earendil-works/pi-coding-agent` 0.85.1; tag `v0.85.1`, commit [`d981de1229ef899957bbe968bc8dcda02a21f477`](https://github.com/earendil-works/pi/tree/d981de1229ef899957bbe968bc8dcda02a21f477) | [Extension docs](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/coding-agent/docs/extensions.md); [extension types](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/coding-agent/src/core/extensions/types.ts) |
| Codex CLI   | `codex-cli 0.152.0`; source checkout commit [`e9633d7a0226eac91c7a791dc4f92cf8f25df2ae`](https://github.com/openai/codex/tree/e9633d7a0226eac91c7a791dc4f92cf8f25df2ae)                          | [Official hooks reference](https://developers.openai.com/codex/hooks.md); [hook runtime](https://github.com/openai/codex/blob/e9633d7a0226eac91c7a791dc4f92cf8f25df2ae/codex-rs/core/src/hook_runtime.rs)                                                                                               |
| Claude Code | Current official reference fetched 2026-09-14; no Claude binary was installed in this environment                                                                                                | [Hooks reference](https://code.claude.com/docs/en/hooks.md); [hooks guide](https://code.claude.com/docs/en/hooks-guide.md)                                                                                                                                                                              |

## Short answer

| Harness         | Start / watcher lease                                                                                                                                                                                | Changed paths                                                                                                                                                                                  | Best synchronous pre-model flush                                                                                                                               | Shutdown                                                                                                                                                                         | Advisory delivery and timeout posture                                                                                                                                                                                                                                                                                              |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Pi**          | `session_start`; use `reason` to distinguish startup, reload, new, resume, and fork. Start a watcher there, not in the extension factory.                                                            | No native file-change event. Use `fs.watch` (or another watcher) and/or `tool_result` inputs; queue paths.                                                                                     | `context`: awaited before **each** LLM call and may replace messages.                                                                                          | `session_shutdown` on quit, reload, new, resume, or fork; close watcher idempotently.                                                                                            | Extension handlers are awaited. There is no documented general handler deadline; impose Antisprawl's 5-second deadline. Extension errors are logged and the run continues; do not return blocking `tool_call` results for advisory work.                                                                                           |
| **Codex CLI**   | `SessionStart` (root) and `SubagentStart` (thread-spawned child). Source also supports `fork`; current docs list startup/resume/clear/compact. Start a helper from a synchronous session-start hook. | `PostToolUse` receives tool name/input/output after supported local tools, including nonzero Bash. No file watcher event or batch event; use a helper watcher for writes outside tool calls.   | No universal before-every-model hook. Synchronous `PostToolUse` is the closest after-tool point; `SessionStart` and `UserPromptSubmit` cover start/new prompt. | `SessionEnd` is root-only and synchronous, after transcript flush. Async work is cancelled at session end; explicitly close the helper in `SessionEnd` and recover stale leases. | Hook JSON is stdout. Sync errors generally record a failed hook and continue; only explicit decisions block. Defaults: 600s for most hooks, 1s (max 3s) for `SessionEnd`/`Interrupt`; set adapter timeout below 5s. Async output arrives only at a later safe point and is unsuitable for a same-request flush.                    |
| **Claude Code** | `SessionStart` with startup/resume/clear/compact/fork source. It can return `watchPaths`; `FileChanged` can then watch literal paths.                                                                | Native `FileChanged` fires for any writer (tool, Bash, or external process); matcher names literal files, or use dynamic `watchPaths`. `PostToolUse`/`PostToolUseFailure` report tool results. | Synchronous `PostToolBatch`: one event after the full parallel tool batch, before the next model call.                                                         | `SessionEnd`; no decision control, so cleanup is best effort.                                                                                                                    | JSON arrives on stdin/stdout for command hooks. Exit 2 blocks only where allowed; ordinary failures and timeouts fail open on most events. Defaults: 600s for command/http/MCP, 30s for `UserPromptSubmit`, 1.5s for `SessionEnd` (configurable up to 60s). `async` output arrives next turn and cannot flush the current request. |

“Best” means the narrowest native point that is synchronous and runs before the next model request. A filesystem event by itself is not a flush boundary.

## Pi (0.85.1)

### Lifecycle and startup

Pi awaits an extension factory before it emits `session_start`; the factory is registration/initialization, not a session boundary. The extension API exposes `session_start` with `reason` values `startup`, `reload`, `new`, `resume`, and `fork`, followed by `resources_discover` for extension-provided skill, prompt, and theme paths. See [`types.ts` session events`](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/coding-agent/src/core/extensions/types.ts#L545-L680), [`loader.ts` factory await](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/coding-agent/src/core/extensions/loader.ts#L535-L560), and [`agent-session.ts` bind/start/resources order](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/coding-agent/src/core/agent-session.ts#L2440-L2495).

`project_trust` is a pre-project-resource trust decision. It is useful for deciding whether project extensions/resources may load, but it is not a watcher start event. Pi supplies `hasUI` and a no-op UI in non-interactive modes; a watcher must not require a prompt. See [`project-trust.ts`](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/coding-agent/src/core/project-trust.ts#L43-L90).

**Adapter rule:** register handlers in the factory, then acquire the per-session watcher lease in `session_start`. Make startup idempotent because reload/replacement creates a fresh extension runtime.

### Changed paths and the model boundary

Pi has no documented native file-change hook. The official file-trigger example starts `fs.watch` from `session_start`, demonstrating the available mechanism (but it omits cleanup and is not a complete production lifecycle): [file-trigger.ts](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/coding-agent/examples/extensions/file-trigger.ts).

For tool-originated changes, `tool_result` runs after a tool and can replace content/details/error/usage; its event includes the tool name and original input. It cannot undo a side effect. [`types.ts` tool result](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/coding-agent/src/core/extensions/types.ts#L940-L1021) and [`runner.ts` result dispatch](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/coding-agent/src/core/extensions/runner.ts#L927-L980) define this contract. A watcher remains necessary for Bash-created files and writes made by processes outside Pi.

The strongest flush point is `context`. Pi documents it as “fired before each LLM call,” and the runner awaits each handler and carries its returned message list to the provider. The SDK wires that runner to the agent's context transformation immediately before streaming: [`types.ts` context contract](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/coding-agent/src/core/extensions/types.ts#L687-L700), [`runner.ts` awaited context](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/coding-agent/src/core/extensions/runner.ts#L1028-L1075), and [`sdk.ts` transformContext wiring](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/coding-agent/src/core/sdk.ts#L348-L370). Run a bounded `check` from this handler, then return a compact custom/context message only when findings exist.

`turn_end` occurs after the assistant response and all tool results for that turn; `agent_settled` occurs after automatic retries, compaction, and queued continuations are done. They are useful fallback/reporting points, but are too late for the immediately completed model request. See [`types.ts` turn/settled contracts](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/coding-agent/src/core/extensions/types.ts#L735-L780) and [`agent-session.ts` settled/turn handling](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/coding-agent/src/core/agent-session.ts#L632-L640).

### Shutdown and failure behavior

Pi emits `session_shutdown` before disposing the current session runtime for quit and session replacement. Replacement first aborts/persists the outgoing response, emits shutdown, then invalidates/disposes it; reload emits shutdown before the new runtime's `session_start`. See [`agent-session-runtime.ts` teardown](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/coding-agent/src/core/agent-session-runtime.ts#L167-L180), [`runtime.ts` replacement sequencing](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/coding-agent/src/core/agent-session-runtime.ts#L210-L365), and [`types.ts` shutdown event](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/coding-agent/src/core/extensions/types.ts#L633-L645). Close watcher handles and release leases in this event; tolerate duplicate/late close calls.

`ctx.shutdown()` requests graceful shutdown and is deferred by interactive/RPC modes until idle; `hasUI` is false in print/JSON modes. There is no general extension-handler timeout in the documented contract. The extension runner catches ordinary handler exceptions, logs them, and continues. `tool_call` is intentionally different: a returned block or thrown error prevents tool execution. These semantics are visible in [`types.ts` context API](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/coding-agent/src/core/extensions/types.ts#L300-L350) and [`runner.ts` dispatch/error handling](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/coding-agent/src/core/extensions/runner.ts#L810-L925).

### Pi adapter shape

```text
session_start       -> acquire watcher lease (no provider call)
watch/tool_result   -> queue repository-relative paths
context              -> drain queue; `antisprawl check ... --json` with <=5s budget
                      -> return compact advisory context, or nothing on no findings/error
session_shutdown    -> stop watcher; release lease; never block session teardown
```

## Codex CLI (0.152.0 / source revision above)

### Lifecycle and event ordering

The official reference lists `SessionStart`/`SubagentStart` at session start, `PostToolUse` after tools, `UserPromptSubmit` before prompt processing, `Stop` after a completed turn, and root-only `SessionEnd` at main-thread end. Matching handlers all run; multiple matching command handlers launch concurrently, and non-managed handlers require trust review: [Codex hooks reference](https://developers.openai.com/codex/hooks.md).

The source queues `SessionStart` until the turn is ready, then runs it before sampling. A root fork is represented by `SessionStartSource::Fork` in the current source even though the docs' matcher table currently lists startup/resume/clear/compact; use `fork` only when the installed build exposes it. See [`session_start.rs` source enum](https://github.com/openai/codex/blob/e9633d7a0226eac91c7a791dc4f92cf8f25df2ae/codex-rs/hooks/src/events/session_start.rs#L20-L70), [`session.rs` source selection](https://github.com/openai/codex/blob/e9633d7a0226eac91c7a791dc4f92cf8f25df2ae/codex-rs/core/src/session/session.rs#L1780-L1820), and [`hook_runtime.rs` dispatch](https://github.com/openai/codex/blob/e9633d7a0226eac91c7a791dc4f92cf8f25df2ae/codex-rs/core/src/hook_runtime.rs#L126-L180).

`UserPromptSubmit` is inspected before the pending user input is recorded; its output can add context or block the prompt. `Stop` runs only once no follow-up input remains; a block creates a continuation prompt rather than undoing a finished response. See [`hook_runtime.rs` prompt handling](https://github.com/openai/codex/blob/e9633d7a0226eac91c7a791dc4f92cf8f25df2ae/codex-rs/core/src/hook_runtime.rs#L670-L740) and [`turn.rs` stop ordering](https://github.com/openai/codex/blob/e9633d7a0226eac91c7a791dc4f92cf8f25df2ae/codex-rs/core/src/session/turn.rs#L635-L690).

### Changed paths and the model boundary

`PostToolUse` runs after supported tools produce output. The documented tool coverage includes Bash, `apply_patch`, MCP tools, and other local function tools; Bash also triggers when it exits nonzero. Hosted tools such as WebSearch are not covered by this local hook path. The hook receives `tool_name`, `tool_input`, and `tool_response`, but there is no native arbitrary-file-change event and no `PostToolBatch`: [tool coverage and PostToolUse](https://developers.openai.com/codex/hooks.md#posttooluse), [`hook_runtime.rs` PostToolUse request](https://github.com/openai/codex/blob/e9633d7a0226eac91c7a791dc4f92cf8f25df2ae/codex-rs/core/src/hook_runtime.rs#L283-L330).

A synchronous `PostToolUse` hook is therefore the closest tool-originated flush point, but it is not a universal before-every-model boundary: parallel calls have separate hook invocations, and writes from external processes are invisible to the event. Start one bounded helper watcher from `SessionStart` and let both it and `PostToolUse` enqueue paths. Do not use async `PostToolUse` when the finding must reach the next request: the source drains finished async results only after sampling and tools, then injects them into a later sampling request. See [`turn.rs` ordering](https://github.com/openai/codex/blob/e9633d7a0226eac91c7a791dc4f92cf8f25df2ae/codex-rs/core/src/session/turn.rs#L490-L555) and [`drain_async_hook_results`](https://github.com/openai/codex/blob/e9633d7a0226eac91c7a791dc4f92cf8f25df2ae/codex-rs/core/src/hook_runtime.rs#L767-L810).

### Shutdown, deadlines, and fail-open JSON

`SessionEnd` runs only for the root session. Codex flushes the rollout before dispatching it, and the event has no steering effect. The source's shutdown path cancels unfinished background hook tasks; `SessionEnd` is always synchronous, even when configured `async`. See [`run_session_end_hooks`](https://github.com/openai/codex/blob/e9633d7a0226eac91c7a791dc4f92cf8f25df2ae/codex-rs/core/src/hook_runtime.rs#L464-L493), [`session_end.rs`](https://github.com/openai/codex/blob/e9633d7a0226eac91c7a791dc4f92cf8f25df2ae/codex-rs/hooks/src/events/session_end.rs#L20-L65), and [`command_runner.rs` async shutdown](https://github.com/openai/codex/blob/e9633d7a0226eac91c7a791dc4f92cf8f25df2ae/codex-rs/hooks/src/engine/command_runner.rs#L108-L190).

Command timeouts are 600 seconds by default for most hooks. `SessionEnd` and `Interrupt` default to one second and are clamped to a maximum of three seconds; this is implemented in [`discovery.rs`](https://github.com/openai/codex/blob/e9633d7a0226eac91c7a791dc4f92cf8f25df2ae/codex-rs/hooks/src/engine/discovery.rs#L742-L761). The command runner includes stdin/output in the deadline and kills the process group/tree on timeout: [`command_runner.rs`](https://github.com/openai/codex/blob/e9633d7a0226eac91c7a791dc4f92cf8f25df2ae/codex-rs/hooks/src/engine/command_runner.rs#L206-L365). Set Antisprawl's hook-level deadline to five seconds or less; never inherit the 600-second default for a quality advisory.

Synchronous hook failures are recorded as failed runs and normally leave the operation continuing. Advisory adapters should return valid JSON on success, no blocking decision, and exit successfully when there is no finding. Codex's normal output is JSON on stdout; `additionalContext` is model-visible, while oversized output spills to a bounded file/preview. Async hooks run in the background (up to eight concurrent invocations), deliver context at a later safe point, and discard unfinished output at session end. Details and the output schema are in [Common output fields](https://developers.openai.com/codex/hooks.md#common-output-fields) and [background hooks](https://developers.openai.com/codex/hooks.md#run-hooks-in-the-background).

### Codex adapter shape

```text
SessionStart (sync) -> start/renew watcher lease
PostToolUse (sync)  -> enqueue tool-derived paths; bounded check when useful
watcher              -> enqueue external paths; never call the provider directly
SessionEnd (sync)   -> stop helper/release lease (root only)
```

Because no universal pre-model event exists, the adapter must document that a path discovered after the last `PostToolUse` can be reported on the next prompt/session start rather than pretending to provide a stronger guarantee.

## Claude Code (current official reference)

### Lifecycle and startup

`SessionStart` runs for startup, resume, clear, compact, and fork. It can return model-visible `additionalContext` and absolute `watchPaths`; command and MCP tool hooks are supported there. On interactive `/clear`, hooks may run in the background while input is accepted, but the first response waits for their completion so startup context is available. See [`SessionStart`](https://code.claude.com/docs/en/hooks.md#sessionstart).

`SessionEnd` runs at termination with reason `clear`, `resume`, `logout`, `prompt_input_exit`, or `other`. It has no decision control and cannot block termination; it is for cleanup/logging. See [`SessionEnd`](https://code.claude.com/docs/en/hooks.md#sessionend).

### Changed paths and the model boundary

`FileChanged` uses a filesystem watcher and fires regardless of writer: Claude's file tools, a Bash process, or an external process. Its matcher builds a list of **literal filenames**; regex syntax is not a useful watch pattern. A `SessionStart` or `CwdChanged` hook can return dynamic absolute `watchPaths`. The event has no decision control and cannot prevent a write. See [`FileChanged`](https://code.claude.com/docs/en/hooks.md#filechanged).

`PostToolUse` runs once after a successful tool; `PostToolUseFailure` covers failed tools. A `PostToolUse` matcher on `Edit|Write` does not see a Bash or external rewrite, which is why `FileChanged` or a broad `PostToolUse` hook that runs `git status --porcelain` is needed for changed-path discovery. See [`PostToolUse`](https://code.claude.com/docs/en/hooks.md#posttooluse) and [`PostToolUseFailure`](https://code.claude.com/docs/en/hooks.md#posttoolusefailure).

`PostToolBatch` runs exactly once after every parallel tool batch resolves and before Claude sends the next request. It receives the complete batch and can inject `hookSpecificOutput.additionalContext`; `decision: block` or exit 2 can stop the loop before that next request. This is the strongest native synchronous flush point for Antisprawl: drain the queue, run a bounded check, and return only compact advisory context. See [`PostToolBatch`](https://code.claude.com/docs/en/hooks.md#posttoolbatch).

### Shutdown, deadlines, and fail-open JSON

Command hooks receive event JSON on stdin and communicate with exit status/stdout/stderr. All matching hooks run in parallel, so one advisory hook must not assume it serializes other hooks. Exit 0 with valid JSON is the normal structured-output path; plain stdout is model-visible context for selected events including `SessionStart` and `UserPromptSubmit`. Exit 2 blocks only events that support blocking. For most events, malformed output, nonzero status other than 2, and command timeout are non-blocking errors and the action proceeds. See [`Hook input and output`](https://code.claude.com/docs/en/hooks.md#hook-input-and-output), [`exit code output`](https://code.claude.com/docs/en/hooks.md#exit-code-output), and [`timeouts`](https://code.claude.com/docs/en/hooks.md#timeouts).

Default synchronous command/http/MCP timeout is 600 seconds; `UserPromptSubmit` is 30 seconds. `SessionEnd` has a 1.5-second default budget, raised to the highest configured per-hook timeout up to 60 seconds (or overridden by `CLAUDE_CODE_SESSIONEND_HOOKS_TIMEOUT_MS`). `async: true` command hooks do not block and have no enforced timeout; their context is delivered on the next conversation turn, or next user interaction when idle. They cannot control the already-completed operation. Unfinished async hooks are cancelled at teardown. See [`common fields`](https://code.claude.com/docs/en/hooks.md#common-fields), [`SessionEnd`](https://code.claude.com/docs/en/hooks.md#sessionend), and [`background hooks`](https://code.claude.com/docs/en/hooks.md#run-hooks-in-the-background).

The adapter should set its own five-second deadline for `PostToolBatch` and any model-facing check, keep `SessionEnd` cleanup short, and fail open on timeout/error. Do not make an advisory finding a `decision: block` or exit-2 result.

### Claude adapter shape

```text
SessionStart (sync context) -> start/renew watcher lease; optionally seed watchPaths
FileChanged              -> enqueue path (no provider call, no blocking)
PostToolBatch (sync)     -> drain queue; bounded `check ... --json`; return additionalContext
SessionEnd               -> stop watcher/release lease; best effort
```

## Recommended cross-harness contract

Keep native overlays thin and make the executable the only detector interface:

1. **Start:** acquire one project watcher lease from the earliest reliable session-start hook. Do not start it from a module/factory that may be loaded once and reused across sessions.
2. **Queue:** watcher events and native post-tool events enqueue normalized repository-relative paths. Watchers never call embeddings or block the agent.
3. **Flush:** run `antisprawl check <paths> --json` only at the harness's synchronous boundary: Pi `context`; Claude `PostToolBatch`; Codex synchronous `PostToolUse` plus next `SessionStart`/`UserPromptSubmit` fallback. Use a single-flight lock so overlapping hooks reuse the queue rather than start duplicate checks.
4. **Deliver:** translate only findings into a compact model-context payload. Empty findings and operational errors produce no model-visible block. Keep stderr for diagnostics.
5. **Stop:** close watcher handles and release the lease in the native shutdown event. Since shutdown can be interrupted or skipped, stale lease expiry and next-session reconciliation remain mandatory.
6. **Budget:** enforce the existing five-second Antisprawl deadline inside every adapter. Host defaults are not a safe SLA: Pi has no general deadline, Codex defaults most hooks to 600s, and Claude defaults most command hooks to 600s.
7. **Fail open:** never return a policy deny/block/exit 2 for advisory findings. Invalid CLI JSON, unavailable index/provider, lock contention, watcher errors, and deadline expiry all continue the agent and leave a bounded diagnostic for `status`.

## Architecture check

No architecture correction is required. The accepted design already names the correct asymmetry:

- Pi's awaited `context` hook is the before-every-model boundary.
- Claude's synchronous `PostToolBatch` is the complete-batch boundary; `FileChanged` supplies writer-independent queue input.
- Codex has no universal before-every-model hook; `PostToolUse` is only an after-tool point, so lifecycle-started watcher plus reconciliation is required.

The only implementation guardrail to carry forward is explicit: Antisprawl's five-second deadline is stricter than all three hosts' ordinary defaults, and every adapter must fail open rather than inherit or wait on a host timeout.
