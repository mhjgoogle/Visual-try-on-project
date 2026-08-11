// Procedural placeholder media for DEMO MODE ONLY.
//
// The prototype ships no binary media (AGENTS.md §23 keeps generated video out
// of the repo), yet a media-first studio is unreadable without pictures. These
// generators synthesize labelled SVG frames as `data:` URIs at runtime — no
// files, no network, no bytes committed. Every frame is visibly a placeholder
// (it prints its own shot/version label), so a screenshot can never be mistaken
// for real generated footage.
//
// Used exclusively by fixtures/demo-project.js. Nothing in src/ imports this.

const enc = (svg) => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg.replace(/\s+/g, " ").trim())}`;

/** Deterministic 0..1 hash of a string — same label always yields the same
 *  grade, so a re-seeded demo looks identical screenshot to screenshot. */
function hash01(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 10000) / 10000;
}

// Cinematic two-tone grades. Cool/teal-amber, sodium night, cold clinical, etc.
const GRADES = [
  ["#0f2430", "#1d4a55", "#e8a95c"], // teal / tungsten
  ["#1a0f18", "#4a1f33", "#e06a7a"], // magenta night
  ["#101826", "#263d63", "#7ea8e0"], // cold blue
  ["#1c1409", "#513516", "#f0b23f"], // sodium amber
  ["#0d1a14", "#1e4536", "#6fcf9a"], // green exit-sign
  ["#191019", "#3d2246", "#b98ce0"], // violet neon
];

/**
 * One cinematic placeholder frame.
 * @param {object} o
 * @param {string} o.label   big line (e.g. "EP01 · S03 · SHOT 03")
 * @param {string} [o.sub]   small line (e.g. "近景 · 3.0s · v2")
 * @param {string} [o.kind]  "frame" | "portrait" | "location" | "video"
 * @param {number} [o.w]     intrinsic width
 * @param {number} [o.h]     intrinsic height
 */
export function placeholderFrame({ label, sub = "", kind = "frame", w = 960, h = 540 }) {
  const g = GRADES[Math.floor(hash01(label) * GRADES.length) % GRADES.length];
  const [dark, mid, key] = g;
  const cx = 30 + hash01(label + "x") * 40; // key-light position, %
  const cy = 22 + hash01(label + "y") * 34;
  const id = `g${Math.floor(hash01(label) * 100000)}`;
  // A soft figure/skyline suggestion keeps the frame from reading as a flat
  // swatch without ever implying real photographic content.
  const subject =
    kind === "portrait"
      ? `<ellipse cx="${w / 2}" cy="${h * 0.44}" rx="${h * 0.155}" ry="${h * 0.185}" fill="#000" opacity=".34"/>
         <path d="M ${w / 2 - h * 0.3} ${h} q ${h * 0.3} -${h * 0.42} ${h * 0.6} 0 Z" fill="#000" opacity=".34"/>`
      : kind === "location"
        ? `<path d="M0 ${h * 0.72} L${w * 0.16} ${h * 0.72} L${w * 0.16} ${h * 0.46} L${w * 0.3} ${h * 0.46} L${w * 0.3} ${h * 0.63} L${w * 0.52} ${h * 0.63} L${w * 0.52} ${h * 0.36} L${w * 0.66} ${h * 0.36} L${w * 0.66} ${h * 0.7} L${w} ${h * 0.7} L${w} ${h} L0 ${h} Z" fill="#000" opacity=".38"/>`
        : `<ellipse cx="${w * 0.5}" cy="${h * 0.62}" rx="${w * 0.17}" ry="${h * 0.3}" fill="#000" opacity=".3"/>`;
  const svg = `
<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
  <defs>
    <radialGradient id="${id}k" cx="${cx}%" cy="${cy}%" r="78%">
      <stop offset="0%" stop-color="${key}" stop-opacity=".62"/>
      <stop offset="42%" stop-color="${mid}" stop-opacity=".9"/>
      <stop offset="100%" stop-color="${dark}"/>
    </radialGradient>
    <linearGradient id="${id}v" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#000" stop-opacity=".42"/>
      <stop offset="45%" stop-color="#000" stop-opacity="0"/>
      <stop offset="100%" stop-color="#000" stop-opacity=".6"/>
    </linearGradient>
  </defs>
  <rect width="${w}" height="${h}" fill="url(#${id}k)"/>
  ${subject}
  <rect width="${w}" height="${h}" fill="url(#${id}v)"/>
  <g font-family="Segoe UI, system-ui, sans-serif" fill="#fff">
    <text x="${w / 2}" y="${h / 2 - (sub ? 4 : -6)}" text-anchor="middle"
          font-size="${Math.round(h * 0.05)}" font-weight="700" opacity=".82"
          letter-spacing="${Math.round(h * 0.004)}">${escapeXml(label)}</text>
    ${sub ? `<text x="${w / 2}" y="${h / 2 + Math.round(h * 0.055)}" text-anchor="middle" font-size="${Math.round(h * 0.034)}" opacity=".55">${escapeXml(sub)}</text>` : ""}
    <text x="${w / 2}" y="${h - Math.round(h * 0.04)}" text-anchor="middle"
          font-size="${Math.round(h * 0.026)}" opacity=".32" letter-spacing="2">占位素材 · PLACEHOLDER</text>
  </g>
  ${kind === "video" ? `<g opacity=".8"><circle cx="${w / 2}" cy="${h * 0.5}" r="${h * 0.115}" fill="#000" opacity=".38"/><path d="M ${w / 2 - h * 0.036} ${h * 0.5 - h * 0.055} L ${w / 2 + h * 0.062} ${h * 0.5} L ${w / 2 - h * 0.036} ${h * 0.5 + h * 0.055} Z" fill="#fff"/></g>` : ""}
</svg>`;
  return enc(svg);
}

/** A short waveform strip for an audio asset (dialogue/ambience/sfx/bgm). */
export function placeholderWave({ label, tone = "#4bc5e8", w = 640, h = 96 }) {
  const bars = [];
  const n = 96;
  for (let i = 0; i < n; i++) {
    const a = hash01(`${label}:${i}`);
    const b = hash01(`${label}:${i}:b`);
    // envelope so it reads like speech rather than noise
    const env = 0.35 + 0.65 * Math.abs(Math.sin((i / n) * Math.PI * 3.1 + a));
    const amp = Math.max(0.06, a * 0.55 + b * 0.45) * env;
    const bh = Math.max(2, amp * h * 0.86);
    bars.push(
      `<rect x="${(i * w) / n + 1}" y="${(h - bh) / 2}" width="${Math.max(1, w / n - 2)}" height="${bh}" rx="1" fill="${tone}" opacity="${(0.45 + amp * 0.55).toFixed(2)}"/>`,
    );
  }
  const svg = `
<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
  <rect width="${w}" height="${h}" fill="#11161d"/>
  ${bars.join("")}
</svg>`;
  return enc(svg);
}

function escapeXml(s) {
  return String(s).replace(/[<>&"']/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" })[c]);
}
