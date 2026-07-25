# ADR-0001: Project Data Directory Contract

- Status: Proposed
- Date: 2026-07-26

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
  inputs/
  staging/
  assets/
    media/
  manifests/
    <step-instance>.json
  qcd/
    events/
  outputs/
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
| `inputs/` | Original user or external-system inputs. These are not generated formal assets. |
| `staging/` | Temporary or unregistered media produced or transferred before validation and formal import. |
| `assets/media/` | Validated, formally registered media referenced by VideoAsset records. |
| `manifests/` | StepManifest records describing individual recoverable step results. |
| `qcd/events/` | Future append-only raw QCD event records. Aggregates are not authoritative here. |
| `outputs/` | Final deliverables. These files are not the formal source of reusable asset truth. |

`staging/` content never becomes a formal asset merely by existing there.
Formal media belongs under `assets/media/` only after future validation and
registration behavior completes. A final file under `outputs/` is a delivery
result, not a replacement for VideoAsset metadata or formal source media.

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
