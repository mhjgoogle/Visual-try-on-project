// VIDEO FRAME extraction — the one genuinely browser-bound step in the studio.
//
// Moved out of `app.js` (TASK-073 §1.8 · TASK-072 §1.9 #10) for one concrete
// reason: it could not be tested. `framectl` already takes it as an INJECTED
// dependency precisely because it touches a `<video>` element, so every test of
// the frame flow stubs it — which means the thing that actually talks to the
// media element was the one piece nobody exercised. `tests/e2e/` now drives THIS
// module in a real Chromium against a real H.264 file.
//
// Pure move otherwise: same behaviour, same messages, same 20 s ceiling.

/** The wall-clock ceiling on one extraction. A stuck decode must not hang the
 *  creator's click forever. */
export const GRAB_TIMEOUT_MS = 20000;

/**
 * Extract one frame from `url` and return it as a PNG `File`.
 *
 * `pick: "last"` takes the final decodable frame; `pick: "at"` takes the frame
 * at `timecodeMs`.
 *
 * @returns {Promise<{file: File, timecodeMs: number, width: number, height: number}>}
 */
export function grabVideoFrame(url, { timecodeMs = null, pick = "last" } = {}) {
  return new Promise((resolve, reject) => {
    const v = document.createElement("video");
    v.preload = "auto";
    v.muted = true;
    v.playsInline = true;
    // same-origin (/api/uploads/…), so the canvas stays untainted and toBlob works
    v.crossOrigin = "anonymous";
    let settled = false;
    const done = (fn, arg) => { if (settled) return; settled = true; clearTimeout(timer); v.src = ""; fn(arg); };
    const timer = setTimeout(
      () => done(reject, new Error("读取视频超时：无法提取帧")),
      GRAB_TIMEOUT_MS,
    );
    v.onerror = () => done(reject, new Error("无法读取这条视频（文件可能已不在本地）"));

    /** Draw whatever frame is currently decoded and finish. */
    const capture = () => {
      try {
        const w = v.videoWidth;
        const h = v.videoHeight;
        if (!w || !h) { done(reject, new Error("这条视频没有可读的画面尺寸")); return; }
        const cv = document.createElement("canvas");
        cv.width = w;
        cv.height = h;
        cv.getContext("2d").drawImage(v, 0, 0, w, h);
        const at = Math.round(v.currentTime * 1000);
        cv.toBlob((blob) => {
          if (!blob) { done(reject, new Error("帧编码失败")); return; }
          const file = new File([blob], `frame-${at}ms.png`, { type: "image/png" });
          done(resolve, { file, timecodeMs: at, width: w, height: h });
        }, "image/png");
      } catch (e) {
        // a tainted canvas throws here; report it rather than registering nothing
        done(reject, new Error(`无法读取画面像素：${e && e.message ? e.message : e}`));
      }
    };

    v.onseeked = capture;
    v.onloadedmetadata = () => {
      const dur = Number.isFinite(v.duration) && v.duration > 0 ? v.duration : null;
      if (!dur) { done(reject, new Error("这条视频没有可用的时长信息，无法定位帧")); return; }
      // the LAST frame is not `duration` exactly: seeking there lands past the
      // final sample in most containers and decodes nothing. One frame back at a
      // conservative 30 fps is the usual "last valid frame".
      const want = pick === "at" && Number.isFinite(timecodeMs)
        ? Math.min(Math.max(0, timecodeMs / 1000), Math.max(0, dur - 0.001))
        : Math.max(0, dur - 1 / 30);

      // NOTE (TASK-072 §1.9 #10): 报告说「`currentTime` 设到 0 ms 时若视频本来
      // 就停在 0，浏览器不保证派发 `seeked`」，卡上写的是**先实测，不要凭报告改**。
      // 这一版是**纯搬运**，行为与 app.js 里那一份逐字相同；实测见
      // `tests/e2e/test_video_frame_grab_task072.py`。
      v.currentTime = want;
    };
    v.src = url;
  });
}
