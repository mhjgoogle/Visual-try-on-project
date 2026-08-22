// View switching (landing ⇄ canvas) + theme toggle + home buttons. Project-card
// wiring and the async data bootstrap live in app.js.
import { $, $$ } from "../util/dom.js";

/**
 * @param onHome  called when the creator LEAVES a project by one of the home
 *                buttons (TASK-081). The landing page is not a place inside a
 *                project, so its address is dropped — leaving the deep link in
 *                the bar would make the next refresh re-enter the project the
 *                creator just walked out of. Not called by `goHome()` itself,
 *                which the router also uses to HONOUR an empty address.
 */
export function createViews({ onHome = null } = {}) {
  const landing = $("#landing"), canvas = $("#canvas");
  const goCanvas = () => { landing.style.display = "none"; canvas.style.display = "block"; };
  const goHome = () => { canvas.style.display = "none"; landing.style.display = "block"; };
  const leaveForHome = () => { goHome(); if (onHome) onHome(); };

  $("#back-home").onclick = leaveForHome;
  $("#home-canvas").onclick = leaveForHome;
  $("#wz-home").onclick = () => { $("#wz-scrim").classList.remove("show"); leaveForHome(); };

  $$("#theme1,#theme2").forEach((b) => (b.onclick = () => {
    const r = document.documentElement;
    const c = r.getAttribute("data-theme") || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
    r.setAttribute("data-theme", c === "dark" ? "light" : "dark");
  }));

  return { goCanvas, goHome };
}
