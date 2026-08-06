// Command Gateway seam (STUB).
//
// In the real system every mutation is a registered Command Gateway command
// (ADR-0033): the browser POSTs a CommandEnvelope to the loopback backend, which
// enforces version binding, idempotency and fail-closed admission — the UI never
// calls a Provider or writes a business file directly. This stub keeps the SAME
// shape so swapping in the real path is one function body:
//
//   real submitCommand -> fetch('/api/projects/<p>/command', {method:'POST', ...})
//
// The mockup only logs and resolves; it changes no authoritative state.

/**
 * @param {{name:string, target?:string, params?:object}} cmd
 * @returns {{status:string, command:object, note:string}}
 */
export function submitCommand(cmd) {
  const envelope = {
    command_id: "cmd-" + Math.round(performance.now()),
    name: cmd.name,
    actor: "user", // forced by the surface — provenance cannot be forged
    target: cmd.target || null,
    params: cmd.params || {},
  };
  // eslint-disable-next-line no-console
  console.info("[gateway:stub] submit", envelope);
  return { status: "accepted", command: envelope, note: "prototype stub — no real write" };
}
