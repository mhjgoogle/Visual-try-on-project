"""Application layer: bootstrap, request factory, workflow driver (TASK-007).

The caller-side of the Workflow Orchestrator role: it reads the clock
and mints identities (the core never does), assembles orchestration
contexts, and wires the validation and composition steps. Public
exports are finalized once the driver lands.
"""
