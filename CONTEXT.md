# Antisprawl

Vocabulary for Antisprawl, an advisory system that surfaces evidence of likely duplicate implementations after coding-agent edits. These terms distinguish possible reuse opportunities from proven duplication or required refactoring.

## Analysis scope

**Project**:
The configured source scope Antisprawl analyzes as one unit.
_Avoid_: Repository, workspace

**Agent session**:
One continuous coding-agent lifecycle used as the boundary for repeated advisory delivery.
_Avoid_: Process, command invocation

**Edit batch**:
A group of source changes checked together after an agent action.
_Avoid_: Commit, changeset

**Symbol**:
A named function, method, or named closure that Antisprawl can extract from a supported source language.
_Avoid_: Code block, snippet, class, module

**Meaningful-size**:
Large enough under the active policy to be useful for reuse analysis rather than trivial boilerplate.
_Avoid_: Complex, important

**Eligible symbol**:
A Symbol that is supported and Meaningful-size, so it can enter duplicate detection.
_Avoid_: Parsed symbol

**Edited symbol**:
An Eligible symbol whose source has changed in the current Edit batch.
_Avoid_: New symbol

**Candidate symbol**:
An existing Eligible symbol selected for comparison with an Edited symbol.
_Avoid_: Match, duplicate

**Symbol pair**:
The ordered combination of an Edited symbol and Candidate symbol evaluated as one possible reuse opportunity.
_Avoid_: Clone

## Detection language

**Probable duplicate**:
A same-language, Meaningful-size Symbol pair that passes the structural gates and, when embeddings are enabled, the semantic gate. It is a strong inspection candidate, not proof that reuse is correct.
_Avoid_: Duplicate, confirmed clone, violation

**Related implementation**:
An opt-in, lower-confidence cross-language Symbol pair that may reveal duplicated responsibility but usually cannot be reused directly.
_Avoid_: Cross-language duplicate

**Structural evidence**:
Evidence that two Symbols share deterministic code shape after language-specific details are normalized.
_Avoid_: Semantic equivalence

**Semantic evidence**:
Embedding similarity interpreted under a specific Profile.
_Avoid_: Proof, meaning

**Embedding input**:
The versioned, comment-free Symbol text sent to an embedding provider and never stored in the Index.
_Avoid_: Source body, prompt

**Embedding identity**:
The provider, model, dimensions, language, and representation version that determine whether a stored vector can be reused.
_Avoid_: Profile, cache key

**Profile**:
An Embedding identity plus the detector version and thresholds used to interpret Semantic evidence.
_Avoid_: Model, provider configuration

**Calibration state**:
Whether a Profile's semantic thresholds have been validated for that exact combination of inputs. Custom or untested profiles are uncalibrated.
_Avoid_: Confidence score

**Structural-only mode**:
Detection that relies on Structural evidence without an embedding provider.
_Avoid_: Offline mode, local mode

**Analysis mode**:
The evidence path actually used for a check: Structural-only or semantic under a Profile.
_Avoid_: Configured provider, search backend

## Findings and project state

**Finding**:
A versioned advisory about a Symbol pair, carrying separate evidence and guidance for inspection. It is neither a verdict nor a refactoring instruction.
_Avoid_: Error, violation, mandate

**Suppression**:
Committed project policy that withholds a specific Symbol pair from Findings, normally with a reason.
_Avoid_: Exemption, deletion

**Finding outcome**:
The observable later state of a surfaced Finding: `resolved`, `suppressed`, `persisting`, or `unknown`.
_Avoid_: Agent compliance

**Index**:
A disposable project-local record of source state and derived Symbol representations used for checking.
_Avoid_: Source of truth, repository

**Coverage**:
Whether every Eligible source file and, under an active Profile, its required vectors are current in the Index. Coverage may be `complete`, `partial`, `stale`, or `degraded`.
_Avoid_: Accuracy, confidence

**Reconciliation**:
A bounded comparison between eligible project sources and the Index that discovers missed or outdated work.
_Avoid_: Rebuild, full scan

**Source egress**:
Transfer of source-derived embedding input beyond the local machine to a remote provider.
_Avoid_: Telemetry
