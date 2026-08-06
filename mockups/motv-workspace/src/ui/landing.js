// View switching (landing ⇄ canvas) + theme toggle + home buttons. Project-card
// wiring and the async data bootstrap live in app.js.
import { $, $$ } from "../util/dom.js";

export function createViews() {
  const landing = $("#landing"), canvas = $("#canvas");
  const goCanvas = () => { landing.style.display = "none"; canvas.style.display = "block"; };
  const goHome = () => { canvas.style.display = "none"; landing.style.display = "block"; };

  $("#back-home").onclick = goHome;
  $("#home-canvas").onclick = goHome;
  $("#wz-home").onclick = () => { $("#wz-scrim").classList.remove("show"); goHome(); };

  $$("#theme1,#theme2").forEach((b) => (b.onclick = () => {
    const r = document.documentElement;
    const c = r.getAttribute("data-theme") || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
    r.setAttribute("data-theme", c === "dark" ? "light" : "dark");
  }));

  return { goCanvas, goHome };
}
