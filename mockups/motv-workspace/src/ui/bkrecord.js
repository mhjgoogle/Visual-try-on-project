// 录一段画布。**顺序就是这个模块存在的理由。**
//
// 原来的写法（`production.js` 里 `bkRecord`，来自 23f80ec）是：
//
//     const view = document.querySelector("[data-bk-view]");
//     const stream = view.captureStream(30);      // ← 绑在这块 canvas 上
//     ui.bkRecording = "…"; render();             // ← render() 换掉 root.innerHTML
//     rec.start(); await bkPlay();                // ← 动画画在**新**节点上
//
// `render()` 一换，手里那块 canvas 就成了孤儿：没人再往它上面画，于是录出来的
// 白膜**不含动画**。它不会报错、不会是空文件，只是一段静止的画面 —— 正是那种
// 「看起来成功了」的失败，所以这里把它钉成一条守卫，而不是靠注释提醒下一个人。
//
// 抽出来是因为**写在 production.js 里没法测**：那段逻辑要有真 DOM 才跑得起来，
// 而顺序错了在真 DOM 里也只表现为「录出来的视频不动」—— 断言性质不要断言写法。

/** 拿 `e` 里那句能给人看的话。 */
const say = (e) => (e && e.message) || String(e || "未知原因");

/**
 * 录一段画布，返回 `{ ok, blob }` 或 `{ ok: false, reason }`。
 * **不负责写入资产** —— 登记留给调用方，这样这个函数只回答一个问题：录到的是不是那块画布。
 *
 * @param {object}   d
 * @param {number}   d.seconds        这段有多长，只用来显示
 * @param {Function} d.showRecording  `(secondsOrNull) => void`，会重绘界面（换掉 DOM）
 * @param {Function} d.getView        `() => canvas|null`，**每次都重新去屏幕上取**
 * @param {Function} d.makeRecorder   `(canvas) => MediaRecorder`
 * @param {Function} d.play           `() => Promise<void>`，把这一镜走一遍
 * @param {Function} d.toast          `(msg) => void`
 */
export async function recordCanvas({ seconds, showRecording, getView, makeRecorder, play, toast }) {
  // ① 先把「录制中」画上去。这一下会换掉整块 DOM，所以**必须在取画布之前**。
  showRecording(seconds);

  // ② 再去屏幕上取那块画布 —— 取到的一定是 ① 之后活着的那块。
  const view = getView();
  if (!view) {
    showRecording(null);
    toast("画布不在了 —— 没有录，也没有写入任何资产");
    return { ok: false, reason: "no-view" };
  }

  let rec;
  try {
    rec = makeRecorder(view);
  } catch (e) {
    showRecording(null);
    toast(`录不了：${say(e)}`);
    return { ok: false, reason: "recorder-failed" };
  }
  if (!rec) {
    showRecording(null);
    toast("这个浏览器不支持录制画布 —— 白膜录不了");
    return { ok: false, reason: "unsupported" };
  }

  // ③ 开录之前再问一次：手里这块，还是屏幕上那块吗？
  // ①②之间没有别的重绘，所以正常永远成立。它防的是**以后**有人在中间加一次
  // `render()` —— 那时这里会当场出声，而不是又交出一段不动的白膜。
  if (getView() !== view) {
    showRecording(null);
    toast("画布在开录前被换掉了 —— 没有录，也没有写入任何资产");
    return { ok: false, reason: "view-swapped" };
  }

  const chunks = [];
  rec.ondataavailable = (ev) => {
    if (ev && ev.data && ev.data.size) chunks.push(ev.data);
  };
  const stopped = new Promise((resolve) => { rec.onstop = resolve; });

  rec.start();
  try {
    await play();
  } finally {
    rec.stop();
    await stopped;
    showRecording(null);
  }

  const blob = new Blob(chunks, { type: "video/webm" });
  if (!blob.size) {
    toast("录出来是空的 —— 没有写入任何资产");
    return { ok: false, reason: "empty" };
  }
  return { ok: true, blob };
}
