// Tiny DOM + helpers shared across the mockup. No framework, no build step.

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/** Create an element with optional class and text content. */
export function el(tag, cls, txt) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (txt != null) e.textContent = txt;
  return e;
}

/** Escape a string for safe interpolation into innerHTML. */
export const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

/** Deterministic hash of a string (for stable per-id gradients/seeds). */
export function hash(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h;
}

const PALS = [
  ["#ff5f6d", "#3b1f5e"], ["#12c2e9", "#1a2a6c"], ["#f7971e", "#2b1055"],
  ["#c94b4b", "#1c1533"], ["#2b5876", "#4e4376"], ["#e65c00", "#12183a"],
  ["#8e2de2", "#101736"], ["#0cebeb", "#164e63"], ["#f0a742", "#241a05"],
];
/** Neon-noir gradient keyed off an id — placeholder for real media thumbnails. */
export function grad(id) {
  const p = PALS[hash(id) % PALS.length];
  const a = (hash(id) % 80) + 50;
  return `linear-gradient(${a}deg, ${p[0]}, ${p[1]})`;
}

let toastEl = null;
let toastT = null;
/** Transient confirmation banner. Reuses a single #toast element. */
export function toast(msg) {
  if (!toastEl) {
    toastEl = el("div", "toast");
    toastEl.id = "toast";
    document.body.appendChild(toastEl);
  }
  toastEl.textContent = "✓ " + msg;
  toastEl.classList.add("show");
  clearTimeout(toastT);
  toastT = setTimeout(() => toastEl.classList.remove("show"), 2800);
}
