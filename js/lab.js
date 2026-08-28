/**
 * 検出比較ラボ（開発用）。
 *
 * 同じ写真に対して Scanic classical / Scanic ML / jscanify を適用し、
 * 四隅・処理時間・補正後の出力解像度を並べて確認する。
 */

import { loadImageFile } from "./image-loader.js";
import { correctPerspective, predictOutputSize } from "./scanner-adapter.js";
import { scanDocument } from "../lib/scanic.js";

const el = (id) => document.getElementById(id);

/** 検出結果を元画像の縮小プレビュー上に重ねて描く。 */
function drawOverlay(source, corners, target) {
  const scale = Math.min(1, 420 / Math.max(source.width, source.height));
  target.width = Math.round(source.width * scale);
  target.height = Math.round(source.height * scale);
  const ctx = target.getContext("2d");
  ctx.drawImage(source, 0, 0, target.width, target.height);
  if (!corners) return;

  const pts = [
    corners.topLeft,
    corners.topRight,
    corners.bottomRight,
    corners.bottomLeft,
  ];
  ctx.beginPath();
  pts.forEach((p, i) => {
    const method = i === 0 ? "moveTo" : "lineTo";
    ctx[method](p.x * scale, p.y * scale);
  });
  ctx.closePath();
  ctx.strokeStyle = "#f28c06";
  ctx.lineWidth = 3;
  ctx.stroke();
  pts.forEach((p) => {
    ctx.beginPath();
    ctx.arc(p.x * scale, p.y * scale, 5, 0, Math.PI * 2);
    ctx.fillStyle = "#fff";
    ctx.fill();
    ctx.strokeStyle = "#f28c06";
    ctx.lineWidth = 2;
    ctx.stroke();
  });
}

/** 補正まで通して、解像度と時間を測る。 */
async function measure(canvas, corners) {
  const startedAt = performance.now();
  const out = await correctPerspective(canvas, corners);
  const extractMs = performance.now() - startedAt;
  const ideal = predictOutputSize(corners);
  const summary = {
    extractMs,
    width: out.width,
    height: out.height,
    note: out.limited
      ? `上限により ${ideal.width}×${ideal.height} から縮小`
      : "原寸で補正",
  };
  // プレビューでは保持しないので即解放する。
  out.canvas.width = 0;
  out.canvas.height = 0;
  return summary;
}

async function runScanic(canvas, detector) {
  const name = detector === "ml" ? "Scanic ML" : "Scanic classical";
  const startedAt = performance.now();
  try {
    const res = await scanDocument(canvas, {
      mode: "detect",
      detector,
      maxProcessingDimension: 1024,
    });
    const detectMs = performance.now() - startedAt;
    if (!res.success || !res.corners) {
      return {
        name,
        corners: null,
        detectMs,
        note: res.message || "検出できず",
      };
    }
    const m = await measure(canvas, res.corners);
    return {
      name,
      corners: res.corners,
      confidence: res.confidence ?? res.score ?? null,
      detectMs,
      ...m,
    };
  } catch (err) {
    return {
      name,
      corners: null,
      detectMs: performance.now() - startedAt,
      note: `エラー: ${err.message}`,
    };
  }
}

let jscanifyReady = null;

/** jscanify + OpenCV.js を CDN から読み込む（チェックしたときだけ）。 */
function loadJscanify() {
  if (jscanifyReady) return jscanifyReady;
  jscanifyReady = new Promise((resolve, reject) => {
    const addScript = (src, onload) => {
      const s = document.createElement("script");
      s.src = src;
      s.onload = onload;
      s.onerror = () => reject(new Error(`${src} の読み込みに失敗`));
      document.head.appendChild(s);
    };
    addScript("https://docs.opencv.org/4.7.0/opencv.js", () => {
      const start = () =>
        addScript(
          "https://cdn.jsdelivr.net/npm/jscanify@1.4.3/src/jscanify.min.js",
          () => resolve(new window.jscanify()),
        );
      if (window.cv?.Mat) start();
      else window.cv.onRuntimeInitialized = start;
    });
  });
  return jscanifyReady;
}

async function runJscanify(canvas) {
  const name = "jscanify (OpenCV.js)";
  const startedAt = performance.now();
  try {
    const scanner = await loadJscanify();
    // 検出条件を Scanic と揃えるため、同じ最大辺まで縮小してから渡す。
    const scale = Math.min(1, 1024 / Math.max(canvas.width, canvas.height));
    const small = document.createElement("canvas");
    small.width = Math.round(canvas.width * scale);
    small.height = Math.round(canvas.height * scale);
    small.getContext("2d").drawImage(canvas, 0, 0, small.width, small.height);

    const contour = scanner.findPaperContour(window.cv.imread(small));
    const detectMs = performance.now() - startedAt;
    const c = contour ? scanner.getCornerPoints(contour) : null;
    small.width = 0;
    small.height = 0;

    if (!c?.topLeftCorner) {
      return { name, corners: null, detectMs, note: "検出できず" };
    }
    // 縮小画像の座標を原寸へ戻す。
    const back = (p) => ({ x: p.x / scale, y: p.y / scale });
    const corners = {
      topLeft: back(c.topLeftCorner),
      topRight: back(c.topRightCorner),
      bottomRight: back(c.bottomRightCorner),
      bottomLeft: back(c.bottomLeftCorner),
    };
    const m = await measure(canvas, corners);
    return {
      name,
      corners,
      detectMs,
      ...m,
      note: "補正は Scanic 側で実施（検出のみ比較）",
    };
  } catch (err) {
    return {
      name,
      corners: null,
      detectMs: performance.now() - startedAt,
      note: `エラー: ${err.message}`,
    };
  }
}

function memoryNote() {
  const mem = performance.memory;
  return mem
    ? `JS heap ${(mem.usedJSHeapSize / 1048576).toFixed(0)} MB`
    : "JS heap 計測不可";
}

function renderTrial(source, trial) {
  const card = document.createElement("div");
  card.className = "card";
  card.innerHTML = `
    <h3>${trial.name}</h3>
    <canvas></canvas>
    <dl>
      <dt>検出</dt><dd class="${trial.corners ? "ok" : "ng"}">${trial.corners ? "成功" : "失敗"}</dd>
      <dt>確度</dt><dd>${trial.confidence != null ? trial.confidence.toFixed(3) : "—"}</dd>
      <dt>検出時間</dt><dd>${trial.detectMs.toFixed(0)} ms</dd>
      <dt>補正時間</dt><dd>${trial.extractMs ? `${trial.extractMs.toFixed(0)} ms` : "—"}</dd>
      <dt>出力解像度</dt><dd>${trial.width ? `${trial.width} × ${trial.height} px` : "—"}</dd>
      <dt>備考</dt><dd>${trial.note ?? ""}</dd>
    </dl>`;
  drawOverlay(source, trial.corners, card.querySelector("canvas"));
  return card;
}

el("fileInput").addEventListener("change", async (event) => {
  const files = Array.from(event.target.files ?? []);
  if (!files.length) return;
  el("results").innerHTML = "";

  for (const file of files) {
    el("status").textContent = `${file.name} を処理中…`;
    let source;
    try {
      source = await loadImageFile(file);
    } catch (err) {
      el("status").textContent = `${file.name}: ${err.message}`;
      continue;
    }

    const block = document.createElement("div");
    block.className = "block";
    block.innerHTML = `
      <h2>${file.name}</h2>
      <p class="sub">入力 ${source.width} × ${source.height} px
        （${((source.width * source.height) / 1e6).toFixed(1)} MP、
        ファイル ${(file.size / 1048576).toFixed(1)} MB、
        読み込み時の縮小率 ${source.scale.toFixed(3)}） / 処理前 ${memoryNote()}</p>
      <div class="grid"></div>`;
    el("results").appendChild(block);
    const grid = block.querySelector(".grid");

    const trials = [await runScanic(source.canvas, "classical")];
    if (el("useMl").checked) trials.push(await runScanic(source.canvas, "ml"));
    if (el("useJscanify").checked)
      trials.push(await runJscanify(source.canvas));

    trials.forEach((t) => grid.appendChild(renderTrial(source.canvas, t)));
    block.querySelector(".sub").textContent += ` / 処理後 ${memoryNote()}`;

    // 次の画像へ進む前に元画像を解放する。
    source.canvas.width = 0;
    source.canvas.height = 0;
  }
  el("status").textContent = "完了しました。";
});
