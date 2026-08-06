// Node-type registry — the primary extension point.
//
// To add a new workflow step: write one file in ../workflow/nodes/<type>.js that
// default-exports a NodeType definition, then register it once in app.js. The
// engine, step-bar, inspector and adjacency rule all derive from what is
// registered here, so nothing else needs to change.
//
// NodeType definition shape:
//   {
//     type:  'video',          // unique id
//     step:  3,                // workflow order (adjacency + progress bar position)
//     stage: 'S4',             // maps to workflow/contract.js (inspector data)
//     title: '视频生成', icon: '▶',
//     render(node, ctx): string,          // node body HTML
//     bind?(node, bodyEl, ctx): void,     // node-specific handlers (optional)
//     run?(node, ctx): void,              // [data-run] handler (optional)
//     next?: ['edit'],                    // suggested next step(s)
//   }

const types = new Map();

export function register(def) {
  if (!def || !def.type) throw new Error("node type needs a `type`");
  types.set(def.type, def);
}
export function get(type) {
  return types.get(type);
}
export function list() {
  return [...types.values()];
}
export function stepOf(type) {
  const d = types.get(type);
  return d && typeof d.step === "number" ? d.step : null;
}

/** Adjacency rule: connect only to the immediate NEXT step ("只能连相邻的下一步").
 *  Same-step (would allow parallel-sibling links / cycles), cross-step and
 *  backward links are rejected. Unknown types are permissive (tool nodes). */
export function canConnect(aType, bType) {
  const a = stepOf(aType);
  const b = stepOf(bType);
  if (a == null || b == null) return true;
  return b - a === 1;
}

/** Build a fresh node data object for a registered type. */
export function createNodeData(type, x, y) {
  const d = get(type);
  if (!d) throw new Error(`unknown node type: ${type}`);
  return {
    type,
    title: d.title,
    icon: d.icon,
    stage: d.stage,
    x,
    y,
    state: "",
    ...(d.init ? d.init() : {}),
  };
}
