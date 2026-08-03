# ADR-0001: Project Data Directory Contract

- Status: Accepted
- Date: 2026-07-26
- Accepted: 2026-07-26 after Step G independent review and TASK-002 final
  acceptance checks passed.
- Amended: 2026-07-26 — TASK-004 orchestration record and manual
  instruction document contract, per the approved TASK-004 design
  (Revision r6). This amendment extends the layout; it does not change
  any decision unrelated to TASK-004.
- Amended (second): 2026-07-28 — M1 staging naming, `reports/`
  directories, formal media and final output naming, and the staged
  file retention/cleanup rule, per the finalized TASK-005/006/007
  contracts. This amendment extends the layout; it does not change any
  earlier decision.
- Amended (third): 2026-08-03 — `action/events/log.jsonl`, the append-only
  feedback / action fact log (format per ADR-0035 / TASK-029). This amendment
  extends the layout; it does not change any earlier decision.
- Amended (fourth): 2026-08-03 — `gateway/receipts/log.jsonl`, the append-only
  Command Gateway durable receipt/outcome log (format per ADR-0033 / TASK-030).
  This amendment extends the layout; it does not change any earlier decision.
- Amended (fifth): 2026-08-03 — one ACCOUNT-level path
  `<account-root>/knowledge/events/log.jsonl`, the append-only user-confirmed
  promoted-knowledge fact log (format per ADR-0036 / TASK-032). This amendment
  extends the account-level layout; it does not change any earlier decision.
  Cross-project analytics and recommendations remain on-demand derived views
  with no persistent cache (ADR-0031 / ADR-0036).
- Amended (sixth): 2026-08-03 — the WFM2 creative/audiovisual locked-artifact
  index tree `creative/l0/`, `creative/s1/`, `creative/s2/`, `creative/s3/`
  (files `creative/<stage>/<kind>_v<N>.json`), each an immutable create-only
  structured index carrying `ref/version/content_digest`, producing step,
  precise input refs, parent version + change reason, checklist evidence and an
  optional in-project `body_ref` prose/media path (format per ADR-0037 /
  TASK-034). This amendment extends the layout; it does not change any earlier
  decision. WFM1 stage/step ids are unchanged; the existing minimal
  `planning/` and `approval/` paths are unaffected and remain the S3 formal /
  approval surface. Full JSON field schema, DB/projection and any Provider path
  remain out of scope (deferred by ADR-0037 to later ADRs).
- Amended (seventh): 2026-08-04 — the WFM2 multimedia (image/audio) asset,
  batch and selection tree: `media/assets/<kind>/<ref>_v<N>.json` (immutable
  create-only asset index: stable `ref/version/content_digest`, `media_kind` ∈
  {reference, master, keyframe, generated_image, audio_generation}, producer
  operation ref + provider/model/parameters, input refs, optional `batch_id`,
  and the bound media file's `media_sha256`), `media/batches/<batch_id>.json`
  (a generation batch retaining ALL candidate results), and
  `media/selections/<selection_id>.json` (a user selection referencing one
  batch candidate; unselected candidates are never deleted). Media staging uses
  `staging/media/<batch_id>/<candidate_id>.<ext>` (one file per retained
  candidate, keyed by the unique batch so distinct generations never collide)
  with the existing trusted-download
  `.fetched.json` sha256 receipt (format per ADR-0038 / TASK-035). Cost,
  reservation and budget REUSE the existing chain: media cost is recorded
  through the existing `qcd/events/log.jsonl` `provider_cost_recorded` event and
  `budget/reservations/` — no second ledger or cost path is introduced. This
  amendment extends the layout; it does not change any earlier decision. The
  frozen `VideoProvider`, `VideoAsset`, `staging/shots/` and video `asset_kind`
  are untouched; media Providers never write these business facts. Concrete
  final field schema, DB/projection and specific paid vendors remain out of
  scope (ADR-0038 defers them; real paid calls stay explicit opt-in under
  ADR-0006/0009 credential discipline).
- Amended (eighth): 2026-08-04 — TASK-008 subtitle / voice-over / audio (ADR-0039
  clause 9). Three IMPORT-ONLY media kinds join the existing `media/assets/<kind>/`
  index tree: `voiceover`, `sfx`, `subtitle` (files
  `media/assets/<kind>/<ref>_v<N>.json`, same immutable create-only, linear,
  digest-bound asset contract as amendment seven; producer `source=external`, never
  a generation capability). A registered import's bound file is copied to an
  index-owned, immutable, versioned location `media/imported/<kind>/<ref>_v<N>.<ext>`
  (`.wav` for voiceover/sfx, `.srt` for subtitle) — never a pointer to the mutable
  user source, so an old version survives the user replacing their file. The S5
  audio-visual mux step adds: the versioned master `outputs/final_av_v<N>.mp4`
  (the video-only `outputs/final_v<N>.mp4` is untouched), its reports
  `reports/audiovisual/final_av_v<N>.{json,md}`, the durable manifest
  `manifests/audiovisual-<project_id>.json`, the pre-publish intent journal
  `records/step-intents/audiovisual/<project_id>/<N>.json`, and staging
  `staging/audiovisual/v<N>/`. Audio-visual completion is recorded in the existing
  `qcd/events/log.jsonl` as the new `audiovisual_completed` event (ADR-0003
  revision), not a second ledger. This amendment extends the layout; it does not
  change any earlier decision. The frozen `VideoProvider`, `VideoComposer`,
  `CompositionProfile`, M1 `composition` step, `VideoAsset` and `serialization.py`
  are untouched; no TTS / paid API is used (user-provided files; tests
  self-generate deterministic placeholder WAV/SRT).

## Context

The workflow needs a durable, inspectable boundary between source inputs,
unregistered intermediate media, registered assets, resumability records, QCD
events, and final deliverables. Manual, cloud, and local generation methods must
be able to use the same project data layout without making a Provider the owner
of formal assets or workflow state.

The contract must also support repository examples without fixing a production
project to a developer-specific absolute path.

## Decision

Each production project has one caller-selected **project data root**. All
persisted paths in project JSON are POSIX-style strings relative to that root.
The root is not stored as a development-machine absolute path.

The repository example is stored at `examples/projects/minimal/`. That directory
simulates one complete project data root because it can be inspected and loaded
without mixing example data with source code or tests. It does not prescribe a
production location; the runtime caller chooses each real project data root.

One JSON file represents one approved model instance. Related models reference
each other by stable IDs instead of being embedded in one aggregate JSON file.
Loading remains explicit: callers provide every model file path to
`load_project_data`; this contract does not authorize directory scanning.

## Directory Contract

```text
<project-data-root>/
  project.json
  records/
    characters/
      <character-id>.json
    scenes/
      <scene-id>.json
    shots/
      <shot-id>.json
    generation-tasks/
      <task-id>.json
    video-assets/
      <asset-id>.json
    orchestration/
      <task-id>.json
    step-intents/
      composition/
        <project-id>/
          <logical-version>.json
  inputs/
  staging/
    shots/
      <task-id>.mp4
    composition/
      v<N>/
  assets/
    media/
      s<scene-seq>_sh<shot-seq>_v<version>.mp4
  manifests/
    <step-instance>.json
  tasks/
    instructions/
      <task-id>.md
  reports/
    validation/
      <task-id>_v<version>.json
      <task-id>_v<version>.md
    composition/
      final_v<N>.json
      final_v<N>.md
    qcd/
      summary_v<N>.json
      summary_v<N>.md
  qcd/
    events/
      log.jsonl
  evaluation/
    events/
      log.jsonl
  action/
    events/
      log.jsonl
  gateway/
    receipts/
      log.jsonl
  outputs/
    final_v<N>.mp4
```

The directory names are stable parts of the long-lived project data contract.
Directories may be absent until they contain data; Git examples do not add empty
placeholder directories.

## Directory Responsibilities

| Path | Responsibility |
| --- | --- |
| `project.json` | The single Project metadata record and project-level entry point. |
| `records/characters/` | Character records, one model instance per JSON file. |
| `records/scenes/` | Scene records, one model instance per JSON file. |
| `records/shots/` | Shot records, one model instance per JSON file. |
| `records/generation-tasks/` | Current GenerationTask records; not QCD history. |
| `records/video-assets/` | VideoAsset metadata for validated, formally registered media. |
| `records/orchestration/` | One authoritative orchestration record per task: current orchestration state, durable intent / write-ahead-log data, and the recovery protocol. Not QCD history, not an audit event stream, not a provider registry, not media asset records. |
| `tasks/instructions/` | Manual task instruction documents rendered by the Orchestrator's internal executor from provider-returned instruction data. Not video artifacts, not VideoAsset records, not formal asset registration, not provider state records, not QCD reports. |
| `inputs/` | Original user or external-system inputs. These are not generated formal assets. |
| `staging/` | Temporary or unregistered media produced or transferred before validation and formal import. |
| `assets/media/` | Validated, formally registered media referenced by VideoAsset records. |
| `manifests/` | StepManifest records describing individual recoverable step results. |
| `reports/` | Versioned validation, composition, and QCD reports (JSON fact source + deterministic Markdown rendering). Derived documents, never a second source of business truth. |
| `qcd/events/` | Append-only raw QCD event log (`log.jsonl`, format per ADR-0003). Aggregates are not authoritative here. |
| `evaluation/events/` | Append-only evaluation / experiment / creative-decision fact log (`log.jsonl`, format per ADR-0034 / TASK-028). Its own single writer; a separate state domain that only references QC / cost / lineage facts by ref+version+digest and never copies or rewrites them. Comparisons / rankings / incremental cost-time are derived views, not stored here. |
| `gateway/receipts/` | Append-only Command Gateway durable receipt/outcome log (`log.jsonl`, format per ADR-0033 / TASK-030). The Gateway's own single writer; a command_id-keyed idempotent receipt store (first-wins) so a resubmitted or concurrent command returns its existing outcome instead of re-executing or re-paying. Not a second business writer: the Gateway only calls approved application/Orchestrator entries and never writes business files or calls a Provider directly. |
| `action/events/` | Append-only feedback / action fact log (`log.jsonl`, format per ADR-0035 / TASK-029). Its own single writer; a separate state domain whose Action lifecycle states (`pending`/`in_progress`/`waiting_for_user`/`completed`/`blocked`/`cancelled`/`stale`) never reuse workflow-approval / GenerationTask / StepManifest / Provider / reservation state. It only references targets by ref+version+content_digest; the current Action state and the read-only Action Center are derived from these append-only facts. Any change an Action triggers is applied only through the Command Gateway (ADR-0033), never written here as a second writer. |
| `outputs/` | Final deliverables. These files are not the formal source of reusable asset truth. |

`staging/` content never becomes a formal asset merely by existing there.
Formal media belongs under `assets/media/` only after future validation and
registration behavior completes. A final file under `outputs/` is a delivery
result, not a replacement for VideoAsset metadata or formal source media.

## Orchestration Record Contract (TASK-004)

`records/orchestration/<task-id>.json` holds at most **one current
orchestration record per task**. It is the authoritative record of the
current orchestration state and of the recovery protocol. Records are
never discovered by directory scanning: callers provide an explicit
project data root and task_id, and the exact path is derived from them.
The file name is derived from the normalized, validated task_id.
Arbitrary caller-supplied paths must not override this layout rule.

Every orchestration record — stable or in progress — uses one uniform
top-level envelope containing `record_schema`, `phase`, `stable`, and
`pending`:

- in the STABLE phase the record holds the last committed stable state
  and no pending operation;
- in non-STABLE phases the record keeps the last committed stable
  state (or `stable = null` for the very first operation only) together
  with the current durable pending operation;
- the conceptual baseline version of the first operation is `0`; the
  first successfully committed stable state has version `1`;
- `stable = null` is only permitted while no stable state has ever been
  committed for the task;
- later pending operations must coexist with the previous stable state;
  a pending operation never replaces the stable state.

This one file carries the pre-call durable intent, the
provider-result-unknown state, the post-result executable apply
payload, partial-commit recovery data, committed file fingerprints,
the stable record self-fingerprint, and the response-loss idempotency
identity. The detailed schema is defined by the approved TASK-004
design document (Revision r6), which is the authority for record
contents; this ADR fixes only the layout responsibility.

TASK-004 does not create a separate journal location. Durable intent
and write-ahead-log data are merged into
`records/orchestration/<task-id>.json`. No
`records/orchestration/journal/`, `logs/`, `history/`, `events/`, or
any other unapproved recovery directory is added.

Record write and replacement rules:

- orchestration records are written exclusively by the Orchestrator's
  internal executor; external application services must not write them;
- every record write uses a same-directory temporary file and atomic
  replacement: write the complete bytes, flush, fsync, `os.replace`,
  and clean up the temporary file on failure;
- writing the STABLE record last acts as a commit marker, but recovery
  also relies on the durable pending payload and on per-file
  fingerprints — never on write order alone;
- empty approved directories may safely remain after a partial
  directory-creation failure: they are not orchestration state, do not
  imply a committed durable intent, require no rollback deletion, and
  may be reused after containment and symlink checks are re-run;
- half-written records or leftover temporary files are not permitted.

## Manual Instruction Document Contract (TASK-004)

`tasks/instructions/<task-id>.md` holds the manual task instruction
document for one task. It is not a video artifact, not a VideoAsset,
not formal asset registration, not a provider state record, and not a
QCD report. The Provider returns structured ProviderInstruction data;
the Orchestrator's internal executor renders and writes the document
using the approved deterministic template. Providers never write the
instruction file themselves. The path is derived from the project data
root and task_id; directory scanning and writes to arbitrary external
paths are forbidden.

Layout-level overwrite constraints:

- file absent: creation is allowed;
- current bytes equal the planned after bytes: idempotent replay;
- current bytes equal the validated before bytes: atomic replacement
  with the after bytes is allowed;
- current bytes equal neither before nor after: reject and enter
  recovery conflict handling;
- a changed request never unconditionally overwrites an existing
  document; only a validated same-operation/same-plan deterministic
  same-bytes replay may overwrite;
- the mere existence of a file name never authorizes an overwrite.

The exact byte contract (UTF-8, no BOM, LF line endings, exactly one
trailing newline, the fixed template, and the canonical JSON parameter
block) is defined by the approved TASK-004 design document.

## Generation Manifest And Task File Preconditions (TASK-004)

Generation StepManifest records use the file name
`manifests/generation-<task-id>.json`. Preconditions:

- the generation StepManifest must already exist before a task enters
  TASK-004 orchestration; TASK-004 never silently creates it during the
  first prepare;
- the caller passes the target StepManifest explicitly; the target is
  determined jointly by the passed object, the derived canonical path,
  and the before fingerprint;
- `step_name == "generation:<task-id>"` is a semantic check only, not
  a globally unique lookup key; ProjectData may contain duplicate
  step_name values; scanning the manifests collection for "the first
  object with a matching name" is forbidden;
- a missing file, or a snapshot that does not match the file
  fingerprint, is rejected.

GenerationTask records keep the existing approved path
`records/generation-tasks/<task-id>.json`. The GenerationTask file must
already exist before entering TASK-004 orchestration; TASK-004 never
silently creates it from an in-memory object; the passed snapshot must
match the file fingerprint; a missing file is rejected. The
StepManifest model itself is unchanged by this amendment.

## Directory Creation And Path Safety (TASK-004)

The Orchestrator's internal executor may create, on demand, only the
approved parent directories: `records/orchestration/`,
`tasks/instructions/`, and the manifest parent `manifests/` (directory
creation on demand is consistent with the existing rule that
directories may be absent until they contain data). Creation rules:
`mkdir(parents=True, exist_ok=True)` honoring the process umask; never
chmod an existing directory; re-check project-root containment and
parent/target symlinks both before and after creation; never create
artifact or media directories; never scan directory contents.

State-directory safety boundary: a local artifact comparison path must
not equal, or fall under, any of `records/generation-tasks/`,
`manifests/`, `records/orchestration/`, or `tasks/instructions/`. This
applies to the current task file, other task files, subdirectories,
relative/absolute equivalent paths, symlink-resolved paths, and the
lexically normalized suffix after the first nonexistent component.
Only component-level lstat/resolve is permitted for this safety
comparison; opening or reading media content, FFmpeg/ffprobe, media
probing, artifact auto-discovery, and directory scanning are all
forbidden.

Path and environment boundaries: the project data root must be
provided explicitly; all state paths must lie inside the project root;
paths must be normalized; `..` escapes are forbidden; absolute
sub-paths must not replace the project root; symlinks must not redirect
a target outside the root; the state target paths must be mutually
distinct; target file names must match the task_id / manifest
identity. The supported and tested environment is WSL2 Ubuntu / Linux;
Windows path and replace semantics are out of scope.

## Fixed Asset Boundary (TASK-004)

This amendment introduces none of the following: VideoAsset creation,
conversion of an ArtifactReference into a VideoAsset, formal asset
registration, formal asset paths, asset versioning, overwrite version
policy, artifact file reading, FFmpeg, QCD, provider registries, cloud
APIs, or browser automation. TASK-004 stores only the explicit
ArtifactReference handoff; formal asset handling belongs to later
tasks.

## M1 Naming Contracts (Second Amendment)

These names are stable parts of the project data contract. All are
project-root-relative POSIX paths.

- **Staging placement contract**: the manual artifact for one
  GenerationTask is placed at exactly `staging/shots/<task-id>.mp4`.
  The TASK-007 bootstrap allocates this reference (it becomes
  `ProviderRequest.staging_ref` and appears in the instruction
  document); the TASK-005 validation step consumes it. A user retry of
  the same task replaces the file content at the same path; content
  change is detected by digest and produces a new registered asset
  version — never a silent overwrite of registered state.
- **Composition intermediates**: `staging/composition/v<N>/` holds the
  normalized per-shot intermediates for final output version `<N>`
  (TASK-006). They are unregistered temporary media, ignored by Git,
  and may be rebuilt from registered assets at any time.
- **Formal media naming**:
  `assets/media/s<scene-seq:02d>_sh<shot-seq:03d>_v<version>.mp4`,
  version starting at 1 per shot; existing files are never replaced
  (no-replace publication).
- **Reports**: `reports/validation/<task-id>_v<version>.{json,md}`
  (TASK-005), `reports/composition/final_v<N>.{json,md}` (TASK-006),
  `reports/qcd/summary_v<N>.{json,md}` (TASK-009). JSON is the fact
  source; Markdown is a deterministic rendering. Versioned,
  never overwritten.
- **Final deliverables**: `outputs/final_v<N>.mp4`, `<N>` starting
  at 1, never overwritten.

## Staged File Retention And Cleanup (Second Amendment)

After a successful validation and formal import of a staged file:

- the caller's original source file is **never deleted immediately**
  on successful registration; user source files outside the project
  root are never deleted at all;
- the project-managed staging copy (`staging/shots/<task-id>.mp4`)
  **may** be cleaned up only after the durable asset registration
  (VideoAsset record + formal media file) **and** the corresponding
  QCD event write have all succeeded;
- a cleanup failure never rolls back the already-successful
  registration; it is reported as a warning/diagnostic only;
- cleanup never touches anything outside `staging/`.

## Multi-file Partial-Commit Recovery (Second Amendment)

M1 steps that write several durable files (TASK-005 validation +
VideoAsset registration; TASK-006 composition; the TASK-007 driver and
TASK-009 reporting that consume them) follow one uniform partial-commit
recovery contract so an interrupted step re-runs deterministically:

1. the logical output **version is decided by the operation / input
   digest**, not by which files happen to exist on disk;
2. a re-run of the **same operation / input continues to target the
   same version** — it never starts a new version;
3. a file that is already published and whose fingerprint / report
   identity matches the expected value is **reused, not rewritten**;
4. when some files are published but the QCD event / StepManifest is
   not yet committed, the re-run **completes the missing QCD / manifest
   only**, without redoing the finished work;
5. QCD events use deterministic `event_id`s, so an equivalent duplicate
   line is permitted and de-duplicated by the reader (ADR-0003);
6. StepManifest writes are idempotent (matching digests + every
   `output_paths` file valid → a no-op);
7. an already-existing file whose content does **not** match the
   expected value is a formal conflict: the step **refuses to overwrite
   and does not jump to a new version**;
8. a **new version** is produced only for a new input digest, a new
   composition profile, or an explicit redo (`create-redo-task`);
9. a cleanup failure never rolls back a durable success;
10. no-replace publication (default refusal of silent overwrite)
    remains in force throughout.

`StepManifest.output_paths` for such a step must enumerate **every**
durable output of that step (e.g. the versioned JSON report, the
deterministic Markdown report, the formal media, and the registered
record), and the architecture §8 skip/no-op check must verify **each**
listed file — never only the media or only the JSON.

## CompositionPublishIntent (Second Amendment, TASK-006)

TASK-006 composition publishes several durable files (the final MP4,
the JSON report, the Markdown report) and appends a QCD event. To make
that multi-file publish deterministically recoverable, it writes a
durable **CompositionPublishIntent** BEFORE composing or publishing the
final MP4.

Composition is **project-level** (one `outputs/final_v<N>.mp4` covers
all shots), so the intent is keyed by the **project**, never by a task
or shot. Its identity is fully determined by
`(project_id, logical_version, input_digest, profile_digest)` plus the
target paths — the project-level `run_composition_step(project_root,
data, composer, profile, observed_at)` supplies all of these from
`ProjectData` and needs no `task_id` / `shot_id` / `operation_id`.

Path: `records/step-intents/composition/<project_id>/<logical_version>.json`.

Fixed fields (canonical JSON; keys sorted; UTF-8, no BOM):

- `schema_version: 1`
- `project_id: str`
- `logical_version: int`
- `input_digest: str`
- `profile_digest: str`
- `media_path: str`
- `json_report_path: str`
- `markdown_report_path: str`

Rules:

- written with canonical JSON and the atomic same-directory temp →
  fsync → `os.replace` strategy;
- the intent identity is
  `(project_id, logical_version, input_digest, profile_digest)` + target
  paths; a same-identity replay is idempotent;
- a same-path (same `project_id` + `logical_version`) write with a
  different `input_digest` / `profile_digest` / target paths is a
  conflict;
- it is written durably **before** composing or publishing the final
  MP4;
- it is **not** part of the step's final `output_paths`;
- it contains **no** wall-clock time and **no** task/shot/operation
  identity (composition is project-level);
- it never overwrites a different-content intent;
- it is written exclusively by the composition step, never by a
  Provider, and it does **not** modify the TASK-004 orchestration WAL
  (a separate, independent durable record family).

The TASK-006 composition ordering and the intent-based recovery matrix
(rules A–F) are defined in
[TASK-006](../tasks/TASK-006-ffmpeg-composition.md). TASK-005's
validation recovery is source-SHA / input-digest based and does **not**
depend on any composition intent.

## Paths And Overwrite Principles

- Contract paths are relative to the project data root and use POSIX separators.
- JSON must not contain a developer-machine absolute path or Windows drive path.
- Existing formal records, registered media, manifests, and outputs are never
  silently overwritten.
- A caller must explicitly request replacement where supported, or publish a new
  non-conflicting path.
- This ADR does not prescribe a complex asset version scheme. Human-readable,
  stable, sortable names are preferred where a later workflow assigns names.
- `staging/` and formal asset paths remain separate so a future Orchestrator can
  enforce validation, import, registration, and overwrite policy.

## Not Decided Here

This ADR does not define:

- Python package/module layout, tests layout, pytest, Ruff, or build tooling;
- VideoProvider, ProviderResult, Provider status, or Orchestrator interfaces;
- Provider output-path allocation or automatic directory discovery;
- digest algorithms, cache matching, or automatic resume behavior;
- FFmpeg commands, database storage, API, Web UI, Docker, or cloud deployment;
- QCD event schemas or writers;
- complex asset versioning or migration algorithms.

Those decisions require a concrete later task or a separate ADR. This document
does not design them in advance.

## Consequences

- Project data stays portable across WSL2 machines because persisted paths are
  relative and POSIX-style.
- Manual, cloud, and local generation can share staging and formal-asset
  boundaries without owning business-state files.
- Records remain easy to inspect and diff because each JSON file contains one
  approved model instance.
- Explicit loading avoids hidden discovery behavior and remains usable before a
  directory-indexing design exists.
- Some directories will not appear in a repository example until real content
  exists. In particular, the minimal example references formal media and output
  paths but intentionally does not include fabricated media files.

TASK-004 amendment consequences:

- Recovery records and manual instruction documents have canonical
  locations; write-ahead-log data and stable state share one record
  file, so no new journal directory is needed.
- State write paths are controlled by the Orchestrator's internal
  layout resolver, enabling deterministic recovery and conflict
  rejection while keeping the Orchestrator the sole writer of business
  state.
- Costs and limits: multi-file project state still requires the
  durable pending payload and compare-and-set fingerprints; a lost
  orchestration record with existing orchestration traces cannot be
  rebuilt automatically; an unknown provider-call result may require
  manual reconciliation; only WSL2/Linux path semantics are supported;
  the existence of a directory does not imply orchestration has
  started.

## References (TASK-004 amendment)

- `docs/design/TASK-004-provider-orchestrator-design.md`
  (approved Revision r6 — authority for record schema, WAL phases,
  fingerprints, and the instruction byte contract)
- `docs/tasks/TASK-004-provider-orchestrator-foundation.md`
- `docs/architecture.md` §3 (Workflow Orchestrator as the sole writer
  of business state)
- `src/ai_video_workflow/persistence.py` (existing atomic
  temporary-file + fsync + replace publication strategy that record
  writes mirror)

## WFM1 amendment (TASK-015 / TASK-016)

WFM1 adds the following project-relative paths and one account-level
rule. These extend, and do not change, the existing M1 layout.

Per-project paths (all under `<project-root>/`, POSIX, containment-checked
via ADR-0004):

- `config/wfm1.json` — the per-project WFM1 config (provider selection,
  yen budgets, locked FX, and the locked catalog id/version/digest).
  Written once at project creation; overwrite-protected.
- `approval/<stage>.json` — the content-bound approval marker for one
  creative stage (e.g. `approval/concept_lock.json`). Human-maintained.
- `budget/reservations/<task_id>/<operation_id>.json` — one durable
  pre-flight budget reservation, keyed by `(task_id, operation_id)` for
  idempotent dedup. Its status transitions (`held` →
  `committed`/`released`/`needs_reconciliation`) overwrite the same
  file; it is operational state, not a QCD fact.

Global (repository-level, version-controlled, no secrets):

- `config/providers/<catalog_id>.json` — a published provider catalog
  (capabilities, models, prices, billing rules, credential env-var
  names). Addressed by id; a project locks its version + content digest.

Account-level rule (monthly budget scope):

- The **account root** is the directory whose immediate subdirectories
  are project roots (default: the project root's parent). A subdirectory
  is a project only if it carries `config/wfm1.json`; others are skipped,
  as are symlinked entries. The account monthly ledger is the sum, over
  those projects, of each project's authoritative cost for the given
  Asia/Tokyo calendar month, each converted at that project's own locked
  FX. This scope is derived and holds no new source of truth.

Authoritative cloud cost is recorded only in the QCD event log as
`provider_cost_recorded` (ADR-0008); reservations and the account ledger
never become a second source of cost truth.

Account-level rule (cross-project knowledge, ADR-0036 / TASK-032):

- `<account-root>/knowledge/events/log.jsonl` — the append-only, single-writer
  log of USER-CONFIRMED promoted knowledge (reusable, evidence-backed
  experience). A separate state domain (never reuses approval / GenerationTask /
  Provider / reservation / Action state) that only REFERENCES authoritative
  run / cost / evaluation / Action facts by ref + content_digest — it never
  copies or rewrites them. Only user-confirmed knowledge is stored here;
  candidate experiences and cross-project analytics/recommendations are derived
  on demand from authoritative facts, with no persistent cache.
