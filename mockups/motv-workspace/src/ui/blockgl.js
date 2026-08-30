// 白膜渲染器（TASK-123 / ADR-0094 决策 2）。
//
// **一个只画方块和地面的极小 WebGL**，约两百行，着色器内联。这个仓库零第三方依赖、
// CSP 也只允许自身来源，所以 Three.js 既装不了也取不到 —— 而白膜真正需要的东西
// 只有三件：摆几个方块、一台有焦距的相机、一盏方向光。库能给的其余一切
// （材质、贴图、后期、GLTF）在白膜这一步都是噪音。
//
// 它只读 `blocking.sampleAt()` 的输出。预览与录制读同一份采样，
// 所以「看到的」与「录出来的」不会是两回事。

import { fovOf } from "../workflow/blocking.js";

/* --- 一点点线性代数（够用就行，不引库）------------------------------------- */

function mul(a, b) {
  const out = new Float32Array(16);
  for (let i = 0; i < 4; i += 1) {
    for (let j = 0; j < 4; j += 1) {
      out[i * 4 + j] =
        a[i * 4] * b[j] +
        a[i * 4 + 1] * b[4 + j] +
        a[i * 4 + 2] * b[8 + j] +
        a[i * 4 + 3] * b[12 + j];
    }
  }
  return out;
}

function perspective(fov, aspect, near, far) {
  const f = 1 / Math.tan(fov / 2);
  const out = new Float32Array(16);
  out[0] = f / aspect;
  out[5] = f;
  out[10] = (far + near) / (near - far);
  out[11] = -1;
  out[14] = (2 * far * near) / (near - far);
  return out;
}

function lookAt(eye, target, up = [0, 1, 0]) {
  const z = norm([eye[0] - target[0], eye[1] - target[1], eye[2] - target[2]]);
  const x = norm(cross(up, z));
  const y = cross(z, x);
  const out = new Float32Array(16);
  out[0] = x[0]; out[1] = y[0]; out[2] = z[0]; out[3] = 0;
  out[4] = x[1]; out[5] = y[1]; out[6] = z[1]; out[7] = 0;
  out[8] = x[2]; out[9] = y[2]; out[10] = z[2]; out[11] = 0;
  out[12] = -dot(x, eye); out[13] = -dot(y, eye); out[14] = -dot(z, eye); out[15] = 1;
  return out;
}

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
function norm(v) {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
}

/** 位移 + 绕 Y 旋转 + 缩放 —— 白膜里的每个方块都只需要这三样。 */
function model(tx, ty, tz, sx, sy, sz, yawDeg = 0) {
  const r = (yawDeg * Math.PI) / 180;
  const c = Math.cos(r);
  const s = Math.sin(r);
  const out = new Float32Array(16);
  out[0] = c * sx; out[2] = -s * sx;
  out[5] = sy;
  out[8] = s * sz; out[10] = c * sz;
  out[12] = tx; out[13] = ty; out[14] = tz; out[15] = 1;
  return out;
}

/* --- 几何：一个单位立方体 + 一张地面网格 ------------------------------------ */

const CUBE = (() => {
  // 每面四点两三角，法线按面给 —— 白膜要的是「看得出体块朝向」，不是平滑着色
  const f = [
    [[0, 0, 1], [-0.5, 0, 0.5], [0.5, 0, 0.5], [0.5, 1, 0.5], [-0.5, 1, 0.5]],
    [[0, 0, -1], [0.5, 0, -0.5], [-0.5, 0, -0.5], [-0.5, 1, -0.5], [0.5, 1, -0.5]],
    [[1, 0, 0], [0.5, 0, 0.5], [0.5, 0, -0.5], [0.5, 1, -0.5], [0.5, 1, 0.5]],
    [[-1, 0, 0], [-0.5, 0, -0.5], [-0.5, 0, 0.5], [-0.5, 1, 0.5], [-0.5, 1, -0.5]],
    [[0, 1, 0], [-0.5, 1, 0.5], [0.5, 1, 0.5], [0.5, 1, -0.5], [-0.5, 1, -0.5]],
    [[0, -1, 0], [-0.5, 0, -0.5], [0.5, 0, -0.5], [0.5, 0, 0.5], [-0.5, 0, 0.5]],
  ];
  const data = [];
  for (const [n, a, b, c, d] of f) {
    for (const v of [a, b, c, a, c, d]) data.push(v[0], v[1], v[2], n[0], n[1], n[2]);
  }
  return new Float32Array(data);
})();

function gridLines(size) {
  const half = size / 2;
  const step = 1;
  const out = [];
  for (let i = -half; i <= half; i += step) {
    out.push(i, 0, -half, 0, 1, 0, i, 0, half, 0, 1, 0);
    out.push(-half, 0, i, 0, 1, 0, half, 0, i, 0, 1, 0);
  }
  return new Float32Array(out);
}

/* --- 着色器 ----------------------------------------------------------------- */

const VS = `
attribute vec3 aPos;
attribute vec3 aNormal;
uniform mat4 uModel, uView, uProj;
varying vec3 vN;
varying float vDepth;
void main() {
  vec4 world = uModel * vec4(aPos, 1.0);
  vec4 eye = uView * world;
  gl_Position = uProj * eye;
  vN = mat3(uModel) * aNormal;
  vDepth = -eye.z;
}`;

const FS = `
precision mediump float;
uniform vec3 uColor;
uniform float uFlat;
varying vec3 vN;
varying float vDepth;
void main() {
  // 一盏方向光 + 一点环境：够看出体块的三个面，不做更多
  vec3 L = normalize(vec3(0.45, 0.85, 0.3));
  float d = max(dot(normalize(vN), L), 0.0);
  float shade = mix(0.42 + 0.58 * d, 1.0, uFlat);
  // 远处淡出：白膜里景深感全靠它，代价是零
  float fog = clamp(vDepth / 60.0, 0.0, 0.55);
  vec3 c = mix(uColor * shade, vec3(0.07, 0.08, 0.10), fog);
  gl_FragColor = vec4(c, 1.0);
}`;

function compile(gl, type, src) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
    throw new Error(gl.getShaderInfoLog(s) || "着色器编译失败");
  }
  return s;
}

/* --- 渲染器 ----------------------------------------------------------------- */

/**
 * 建一个白膜渲染器。**拿不到 WebGL 就说拿不到**（fail-closed，ADR-0094 决策 4 同一条
 * 纪律）：返回 `{ ok: false, error }`，而不是一个画不出东西的空壳。
 */
export function createStage(canvas) {
  const gl =
    canvas.getContext("webgl", { antialias: true, preserveDrawingBuffer: true }) ||
    canvas.getContext("experimental-webgl", { antialias: true, preserveDrawingBuffer: true });
  if (!gl) return { ok: false, error: "这个浏览器没有可用的 WebGL —— 白膜画不出来" };

  let prog;
  try {
    prog = gl.createProgram();
    gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, VS));
    gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, FS));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      return { ok: false, error: gl.getProgramInfoLog(prog) || "着色器链接失败" };
    }
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }

  const cube = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, cube);
  gl.bufferData(gl.ARRAY_BUFFER, CUBE, gl.STATIC_DRAW);
  const grid = gl.createBuffer();
  let gridSize = 0;
  let gridCount = 0;

  const loc = {
    pos: gl.getAttribLocation(prog, "aPos"),
    normal: gl.getAttribLocation(prog, "aNormal"),
    model: gl.getUniformLocation(prog, "uModel"),
    view: gl.getUniformLocation(prog, "uView"),
    proj: gl.getUniformLocation(prog, "uProj"),
    color: gl.getUniformLocation(prog, "uColor"),
    flat: gl.getUniformLocation(prog, "uFlat"),
  };

  function bind(buffer) {
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.enableVertexAttribArray(loc.pos);
    gl.vertexAttribPointer(loc.pos, 3, gl.FLOAT, false, 24, 0);
    gl.enableVertexAttribArray(loc.normal);
    gl.vertexAttribPointer(loc.normal, 3, gl.FLOAT, false, 24, 12);
  }

  function box(m, color, flat = 0) {
    gl.uniformMatrix4fv(loc.model, false, m);
    gl.uniform3fv(loc.color, color);
    gl.uniform1f(loc.flat, flat);
    gl.drawArrays(gl.TRIANGLES, 0, CUBE.length / 6);
  }

  /** 画一帧。`shot` 是 `blocking.sampleAt()` 的输出。 */
  function draw(shot) {
    const w = canvas.width;
    const h = canvas.height;
    gl.viewport(0, 0, w, h);
    gl.enable(gl.DEPTH_TEST);
    gl.clearColor(0.055, 0.06, 0.075, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.useProgram(prog);

    const aspect = w / Math.max(1, h);
    const proj = perspective(fovOf(shot.camera.lens, aspect), aspect, 0.05, 300);
    const view = lookAt(
      [shot.camera.at.x, shot.camera.y, shot.camera.at.z],
      [shot.camera.look.x, 1.0, shot.camera.look.z],
    );
    gl.uniformMatrix4fv(loc.proj, false, proj);
    gl.uniformMatrix4fv(loc.view, false, view);

    // 地面（一块极扁的板，比线框更像「地」）
    bind(cube);
    box(model(0, -0.02, 0, shot.stage, 0.02, shot.stage), [0.16, 0.17, 0.2]);

    // 网格线：一米一格，看得出距离
    if (gridSize !== shot.stage) {
      const data = gridLines(shot.stage);
      gl.bindBuffer(gl.ARRAY_BUFFER, grid);
      gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
      gridSize = shot.stage;
      gridCount = data.length / 6;
    }
    bind(grid);
    gl.uniformMatrix4fv(loc.model, false, model(0, 0.001, 0, 1, 1, 1));
    gl.uniform3fv(loc.color, [0.28, 0.3, 0.34]);
    gl.uniform1f(loc.flat, 1);
    gl.drawArrays(gl.LINES, 0, gridCount);

    bind(cube);
    // 道具：低一点、暗一点 —— 它们是环境，不是主角
    for (const p of shot.props) {
      box(model(p.at.x, 0, p.at.z, p.w, p.h, p.d), [0.42, 0.44, 0.48]);
    }
    // 演员：白膜的「白」在这里 —— 一个有身高、有朝向的体块
    for (const a of shot.actors) {
      const shoulder = 0.46;
      box(model(a.at.x, 0, a.at.z, shoulder, a.height * 0.82, 0.28, a.facing), [0.86, 0.87, 0.9]);
      // 头：一个小方块，让「朝哪」在剪影上就能看出来
      box(
        model(a.at.x, a.height * 0.82, a.at.z, 0.22, a.height * 0.18, 0.22, a.facing),
        [0.93, 0.94, 0.96],
      );
      // 走位线：从起点到终点的一条贴地细板
      if (a.moves) {
        const dx = a.to.x - a.from.x;
        const dz = a.to.z - a.from.z;
        const len = Math.hypot(dx, dz);
        const yaw = (Math.atan2(dx, dz) * 180) / Math.PI;
        box(
          model((a.from.x + a.to.x) / 2, 0.005, (a.from.z + a.to.z) / 2, 0.06, 0.01, len, yaw),
          [0.55, 0.72, 0.95],
          1,
        );
      }
    }
  }

  return { ok: true, gl, draw, canvas };
}
