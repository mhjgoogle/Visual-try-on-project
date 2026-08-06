// Generic node-canvas engine. Workflow-agnostic: it knows only that nodes have
// {id, type, x, y, title, icon, stage, state} and that edges connect them. All
// film-workflow knowledge lives in the node defs / registry / contract. The
// engine delegates body rendering + behaviour back to the host via callbacks.
//
// Host callbacks (all optional except renderBody):
//   renderBody(node)          -> body HTML string
//   bindBody(node, bodyEl)    -> attach node-specific handlers after (re)render
//   onNodeClick(node)
//   canConnect(srcNode, dstNode) -> bool     (adjacency rule)
//   onConnect(srcNode, dstNode)              (after a successful manual wire)
//   onWireRejected(srcNode, dstNode)
//   onCanvasMenu(worldX, worldY, clientX, clientY, srcNode|null)
//   onEdgeInsert(edge, clientX, clientY)
//   onChange()                               (after any structural change)

const SVGNS = "http://www.w3.org/2000/svg";

export class GraphEngine {
  constructor(opts) {
    this.o = opts;
    this.viewport = opts.viewport;
    this.world = opts.world;
    this.svg = opts.svg;
    this.edgectl = opts.edgectl;
    this.emptyhint = opts.emptyhint || null;
    this.nodes = [];
    this.edges = [];
    this.panX = opts.panX ?? 140;
    this.panY = opts.panY ?? 120;
    this._pan0 = { x: this.panX, y: this.panY }; // default viewport, restored on reset()
    this.selId = null;
    this.selEdges = new Set();
    this._seq = 0;
    this._eseq = 0;
    this._pan = null;
    this._bindViewport();
    this.applyPan();
  }

  // ---- state mutation ----
  addNode(data) {
    data.id = "n" + ++this._seq;
    this.nodes.push(data);
    return data;
  }
  findNode(id) {
    return this.nodes.find((n) => n.id === id);
  }
  addEdge(from, to, state = "") {
    if (from === to) return null;
    if (this.edges.some((e) => e.from === from && e.to === to)) return null;
    const ed = { id: "e" + ++this._eseq, from, to, state };
    this.edges.push(ed);
    return ed;
  }
  removeEdge(ed) {
    this.edges = this.edges.filter((e) => e !== ed);
    this.selEdges.delete(ed.id);
  }
  /** Clear the whole graph (used when switching projects / restoring). */
  reset() {
    this.nodes = [];
    this.edges = [];
    this.selId = null;
    this.selEdges = new Set();
    this.world.querySelectorAll(".node").forEach((e) => e.remove());
    this.panX = this._pan0.x; // reset viewport so a new project doesn't inherit the last offset
    this.panY = this._pan0.y;
    this.applyPan();
    this.renderEdges();
    if (this.emptyhint) this.emptyhint.style.display = "flex";
  }

  /** Colour every edge feeding a node (e.g. active while its node generates). */
  markIncoming(toId, state) {
    this.edges.forEach((e) => {
      if (e.to === toId) e.state = state;
    });
    this.renderEdges();
  }

  // ---- rendering ----
  render() {
    const ex = {};
    this.world.querySelectorAll(".node").forEach((e) => (ex[e.dataset.id] = e));
    for (const n of this.nodes) {
      let e = ex[n.id];
      if (!e) {
        e = this._buildNode(n);
        this.world.appendChild(e);
      }
      e.style.left = n.x + "px";
      e.style.top = n.y + "px";
      e.classList.toggle("sel", n.id === this.selId);
      e.classList.toggle("done", n.state === "done");
      e.classList.toggle("gen", n.state === "gen");
      delete ex[n.id];
    }
    Object.values(ex).forEach((e) => e.remove());
    if (this.emptyhint) this.emptyhint.style.display = this.nodes.length ? "none" : "flex";
    this.renderEdges();
    this.o.onChange && this.o.onChange();
  }

  refreshBody(node) {
    const e = this.world.querySelector(`[data-id="${node.id}"]`);
    if (!e) return;
    e.querySelector(".nbody").innerHTML = this.o.renderBody(node);
    this.o.bindBody && this.o.bindBody(node, e.querySelector(".nbody"));
    e.classList.toggle("done", node.state === "done");
    e.classList.toggle("gen", node.state === "gen");
    this.renderEdges();
    this.o.onChange && this.o.onChange();
  }

  renderEdges() {
    this.svg.innerHTML = "";
    this.edgectl.innerHTML = "";
    for (const ed of this.edges) {
      const a = this.world.querySelector(`[data-id="${ed.from}"]`);
      const b = this.world.querySelector(`[data-id="${ed.to}"]`);
      if (!a || !b) continue;
      const x1 = a.offsetLeft + a.offsetWidth;
      const y1 = a.offsetTop + a.offsetHeight / 2;
      const x2 = b.offsetLeft;
      const y2 = b.offsetTop + b.offsetHeight / 2;
      const dx = Math.max(40, Math.abs(x2 - x1) * 0.5);
      const d = `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`;
      const p = document.createElementNS(SVGNS, "path");
      p.setAttribute("d", d);
      p.setAttribute("class", "edge" + (ed.state ? " " + ed.state : "") + (this.selEdges.has(ed.id) ? " sel" : ""));
      this.svg.appendChild(p);
      const hit = document.createElementNS(SVGNS, "path");
      hit.setAttribute("d", d);
      hit.setAttribute("class", "edgehit");
      hit.addEventListener("click", (e) => {
        e.stopPropagation();
        if (e.shiftKey || e.ctrlKey || e.metaKey) {
          this.selEdges.has(ed.id) ? this.selEdges.delete(ed.id) : this.selEdges.add(ed.id);
        } else {
          this.selEdges = new Set([ed.id]);
        }
        this.renderEdges();
      });
      this.svg.appendChild(hit);
      const mx = (x1 + x2) / 2;
      const my = (y1 + y2) / 2;
      const c = document.createElement("div");
      c.className = "ectl";
      c.style.left = mx + "px";
      c.style.top = my + "px";
      const bi = document.createElement("button");
      bi.textContent = "+";
      bi.title = "在此插入节点";
      bi.onclick = (e) => {
        e.stopPropagation();
        this.o.onEdgeInsert && this.o.onEdgeInsert(ed, e.clientX, e.clientY);
      };
      const bd = document.createElement("button");
      bd.className = "del";
      bd.textContent = "×";
      bd.title = "删除连线";
      bd.onclick = (e) => {
        e.stopPropagation();
        this.removeEdge(ed);
        this.renderEdges();
      };
      c.appendChild(bi);
      c.appendChild(bd);
      this.edgectl.appendChild(c);
    }
  }

  _buildNode(n) {
    const e = document.createElement("div");
    e.className = "node";
    e.dataset.id = n.id;
    e.style.left = n.x + "px";
    e.style.top = n.y + "px";
    const head = document.createElement("div");
    head.className = "nhead";
    head.innerHTML = `<span class="ic">${n.icon || ""}</span><span class="tt">${n.title || ""}</span><span class="stg mono">${n.stage || ""}</span>`;
    e.appendChild(head);
    const body = document.createElement("div");
    body.className = "nbody";
    body.innerHTML = this.o.renderBody(n);
    e.appendChild(body);
    const pin = document.createElement("div");
    pin.className = "port in";
    const pout = document.createElement("div");
    pout.className = "port out";
    e.appendChild(pin);
    e.appendChild(pout);
    head.addEventListener("pointerdown", (ev) => this._startDrag(ev, n, e));
    pout.addEventListener("pointerdown", (ev) => this._startWire(ev, n));
    e.addEventListener("click", (ev) => {
      if (ev.target.closest("button,textarea,.genprog,.vmenu,.port")) return;
      this.selId = n.id;
      this.render();
      this.o.onNodeClick && this.o.onNodeClick(n);
    });
    setTimeout(() => this.o.bindBody && this.o.bindBody(n, body), 0);
    return e;
  }

  // ---- interaction ----
  applyPan() {
    this.world.style.transform = `translate(${this.panX}px,${this.panY}px)`;
  }
  clientToWorld(cx, cy) {
    const r = this.viewport.getBoundingClientRect();
    return { x: cx - r.left - this.panX, y: cy - r.top - this.panY };
  }
  panTo(id) {
    const e = this.world.querySelector(`[data-id="${id}"]`);
    if (!e) return;
    const r = this.viewport.getBoundingClientRect();
    this.panX = r.width / 2 - (e.offsetLeft + e.offsetWidth / 2);
    this.panY = Math.max(90, r.height / 2 - (e.offsetTop + e.offsetHeight / 2));
    this.world.style.transition = "transform .3s ease";
    this.applyPan();
    setTimeout(() => (this.world.style.transition = ""), 320);
  }

  _startDrag(ev, n, e) {
    ev.preventDefault();
    ev.stopPropagation();
    const s = { sx: ev.clientX, sy: ev.clientY, ox: n.x, oy: n.y };
    const mv = (m) => {
      n.x = s.ox + (m.clientX - s.sx);
      n.y = s.oy + (m.clientY - s.sy);
      e.style.left = n.x + "px";
      e.style.top = n.y + "px";
      this.renderEdges();
    };
    const up = () => {
      document.removeEventListener("pointermove", mv);
      document.removeEventListener("pointerup", up);
      this.o.onChange && this.o.onChange(); // persist moved position
    };
    document.addEventListener("pointermove", mv);
    document.addEventListener("pointerup", up);
  }

  _bindViewport() {
    this.viewport.addEventListener("pointerdown", (ev) => {
      if (ev.target.closest(".node,.ectl") || ev.target.classList.contains("edgehit")) return;
      if (this.selEdges.size) {
        this.selEdges = new Set();
        this.renderEdges();
      }
      this._pan = { sx: ev.clientX, sy: ev.clientY, ox: this.panX, oy: this.panY };
      this.viewport.classList.add("panning");
    });
    document.addEventListener("pointermove", (ev) => {
      if (!this._pan) return;
      this.panX = this._pan.ox + (ev.clientX - this._pan.sx);
      this.panY = this._pan.oy + (ev.clientY - this._pan.sy);
      this.applyPan();
    });
    document.addEventListener("pointerup", () => {
      if (this._pan) {
        this._pan = null;
        this.viewport.classList.remove("panning");
        this.o.onChange && this.o.onChange(); // persist pan offset
      }
    });
    this.viewport.addEventListener("dblclick", (ev) => {
      if (ev.target.closest(".node,.ectl")) return;
      const w = this.clientToWorld(ev.clientX, ev.clientY);
      this.o.onCanvasMenu && this.o.onCanvasMenu(w.x, w.y, ev.clientX, ev.clientY, null);
    });
    document.addEventListener("keydown", (e) => {
      if (e.key !== "Delete" && e.key !== "Backspace") return;
      // Don't hijack Delete/Backspace while the user is editing text (e.g. the
      // script textarea) — that would silently drop a selected edge.
      const t = e.target;
      if (t && (t.tagName === "TEXTAREA" || t.tagName === "INPUT" || t.isContentEditable)) return;
      if (this.selEdges.size) {
        this.edges = this.edges.filter((ed) => !this.selEdges.has(ed.id));
        this.selEdges = new Set();
        this.renderEdges();
        this.o.onDeleteEdges && this.o.onDeleteEdges();
      }
    });
  }

  _startWire(ev, n) {
    ev.preventDefault();
    ev.stopPropagation();
    const e = this.world.querySelector(`[data-id="${n.id}"]`);
    const sx = e.offsetLeft + e.offsetWidth;
    const sy = e.offsetTop + e.offsetHeight / 2;
    const p = document.createElementNS(SVGNS, "path");
    p.setAttribute("class", "edge pending");
    p.id = "pendingedge";
    this.svg.appendChild(p);
    const mv = (m) => {
      const w = this.clientToWorld(m.clientX, m.clientY);
      const dx = Math.max(40, Math.abs(w.x - sx) * 0.5);
      p.setAttribute("d", `M ${sx} ${sy} C ${sx + dx} ${sy}, ${w.x - dx} ${w.y}, ${w.x} ${w.y}`);
      this.world.querySelectorAll(".port.tgt").forEach((t) => t.classList.remove("tgt"));
      const t = document.elementFromPoint(m.clientX, m.clientY);
      if (t && t.classList.contains("in")) t.classList.add("tgt");
    };
    const up = (m) => {
      document.removeEventListener("pointermove", mv);
      document.removeEventListener("pointerup", up);
      this.world.querySelectorAll(".port.tgt").forEach((t) => t.classList.remove("tgt"));
      const pe = document.getElementById("pendingedge");
      if (pe) pe.remove();
      const t = document.elementFromPoint(m.clientX, m.clientY);
      const tn = t && t.closest(".node");
      if (tn && tn.dataset.id !== n.id) {
        const dst = this.findNode(tn.dataset.id);
        if (this.o.canConnect && !this.o.canConnect(n, dst)) {
          this.o.onWireRejected && this.o.onWireRejected(n, dst);
        } else {
          this.addEdge(n.id, dst.id, n.state === "done" ? "done" : "");
          this.renderEdges();
          this.o.onConnect && this.o.onConnect(n, dst);
        }
      } else if (!tn) {
        const w = this.clientToWorld(m.clientX, m.clientY);
        this.o.onCanvasMenu && this.o.onCanvasMenu(w.x - 20, w.y - 30, m.clientX, m.clientY, n);
      }
    };
    document.addEventListener("pointermove", mv);
    document.addEventListener("pointerup", up);
  }
}
