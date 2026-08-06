// Landing ⇄ canvas view switching + theme toggle + shared budget readout wiring.
import { $, $$ } from "../util/dom.js";

export function createViews({ onStart, onOpenRecent, renderBudget }) {
  const landing = $("#landing"), canvas = $("#canvas");

  function goCanvas() { landing.style.display = "none"; canvas.style.display = "block"; }
  function goHome() { canvas.style.display = "none"; landing.style.display = "block"; }

  $("#start-create").onclick = () => { goCanvas(); onStart(); };
  $("#open-recent").onclick = () => { goCanvas(); onOpenRecent(); };
  $("#back-home").onclick = goHome;
  $("#home-canvas").onclick = goHome;
  $("#wz-home").onclick = () => { $("#wz-scrim").classList.remove("show"); goHome(); };

  $$("#theme1,#theme2").forEach((b) => (b.onclick = () => {
    const r = document.documentElement;
    const c = r.getAttribute("data-theme") || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
    r.setAttribute("data-theme", c === "dark" ? "light" : "dark");
  }));

  renderBudget();
  return { goCanvas, goHome };
}
