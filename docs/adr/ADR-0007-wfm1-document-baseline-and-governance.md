# ADR-0007: WFM1 Document Baseline and Governance

- Status: Accepted
- Date: 2026-08-01
- Scope: WFM1 document baseline, milestone naming, task numbering, and
  development-review governance

## Context

The original M1 minimal loop is complete and accepted. The reusable short-film
workflow described in `docs/ai_shortfilm_pipeline_workflow.md` adds creative
review, production planning, budget control, and reusable workflow assets. It
is a new incremental milestone, not a replacement definition of M1.

The workflow document originally reused the names `M1` and `TASK-001` through
`TASK-006`, required cloud video as the only generation route, applied one
approval state machine to all persisted objects, and proposed a directory and
YAML layout that overlapped accepted M1 contracts. It also prescribed
per-task approval, while the repository already uses batch milestone review.

## Decision

1. **Incremental milestone**: the new workflow milestone is named **WFM1**.
   Original M1 remains complete and accepted; WFM1 builds on it and does not
   reopen its acceptance.
2. **Task identity**: existing task identifiers remain immutable. New WFM1
   implementation tasks start at `TASK-014` and continue the repository-wide
   sequence. This ADR does not create or define those task cards.
3. **Review governance**: WFM1 uses the existing batch milestone review model.
   Task cards are approved as a batch design baseline, implementation may then
   proceed continuously within that baseline, and independent review occurs at
   the milestone gate. The implementer/reviewer separation in `AGENTS.md`
   remains mandatory.
4. **Human approval is a workflow concern**: creative and production approval
   checkpoints in WFM1 are runtime workflow requirements. They are not a
   requirement for per-task development approval and do not replace
   GenerationTask, StepManifest, Provider, or orchestration states. Their exact
   persistence contract is deferred to a later approved task or ADR.
5. **Provider policy**: cloud video is the default WFM1 production route under
   ADR-0006 and future vendor/budget decisions. The core architecture remains
   provider-neutral; ManualVideoProvider and future local providers are not
   invalidated.
6. **Persistence and directories**: WFM1 keeps JSON as the structured
   persistence format. It does not introduce YAML. ADR-0001 remains the
   authoritative project data directory contract. `workflow/` denotes the
   conceptual collection of reusable cross-project assets; this baseline does
   not require a new physical directory or migration.
7. **Frozen contracts**: WFM1 must reuse existing reliable M1 capabilities.
   This baseline does not modify any frozen data model, Provider,
   orchestration, QCD, path-safety, recovery, validation, or composition
   contract. A later task that requires such a change must identify it
   explicitly and follow the existing ADR and approval rules.

## Document Authority

The repository documents have the following roles:

1. `AGENTS.md` contains mandatory repository-wide agent and safety rules.
2. Accepted ADRs contain durable decisions and scoped exceptions. A later ADR
   must explicitly supersede an earlier decision before implementation may
   contradict it.
3. `docs/product_spec.md` defines product scope and success criteria.
4. `docs/architecture.md` defines technical boundaries and long-lived
   contracts.
5. `docs/ai_shortfilm_pipeline_workflow.md` defines WFM1 workflow requirements
   within the preceding rules and contracts.
6. `docs/implementation_plan.md` maps approved scope to milestones, tasks, and
   current status.
7. Task cards and design reports define bounded implementation work. Historical
   plans and review records preserve context but do not override the current
   documents above.

If two current documents cannot be reconciled by these roles, implementation
must stop until an ADR or an explicit baseline correction resolves the conflict.

## Consequences

- M1 remains a stable foundation and regression baseline for WFM1.
- WFM1 can add workflow-level approval, planning, and budget gates without
  merging their states into existing runtime state domains.
- Cloud-provider work may advance as the WFM1 default route, but only within
  ADR-0006 and later approved vendor, credential, and budget decisions.
- Concrete approval, budget, provider-selection, and reusable-asset schemas are
  intentionally outside this docs-only baseline.

## Not Decided Here

- Approval record, lock, revision, or change-request schemas;
- budget estimation, reservation, guard, exchange-rate, or ledger schemas;
- cloud vendor selection, endpoints, credentials, or provider configuration;
- a physical `workflow/` directory or changes to ADR-0001;
- the detailed scope and acceptance criteria of `TASK-014` and later tasks.
