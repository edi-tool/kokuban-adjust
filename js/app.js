/**
 * 黒板補正さん — アプリ本体。
 *
 * 画面は 3 つだけ:
 *   start  … 写真を選ぶ
 *   edit   … 四隅を確認・調整して「補正する」
 *   result … 高解像度プレビューと保存
 *
 * 画像処理そのものは js/scanner-adapter.js 越しにしか呼ばない。
 */

import {
  loadImageFile,
  releaseCanvas,
  UnsupportedImageError,
} from "./image-loader.js";
import {
  correctPerspective,
  createCornerEditorAdapter,
  detectBoard,
  predictOutputSize,
} from "./scanner-adapter.js";

/**
 * JPEG 書き出し品質。
 *
 * 0.92 はブラウザ既定と同等で、チョーク文字のような細い高コントラスト線でも
 * モスキートノイズが目立ちにくい水準。これ以上下げると文字の可読性が落ちるため、
 * UI からは変更させない。
 */
const JPEG_QUALITY = 0.92;

const el = (id) => document.getElementById(id);

const screens = {
  start: el("screenStart"),
  edit: el("screenEdit"),
  result: el("screenResult"),
};

const state = {
  source: null, // { canvas, width, height, fileName }
  corners: null,
  // 自動検出が成功したか。編集画面の案内文の出し分けに使う。
  // 手動指定で確定した後の「再調整」では自動検出扱いにしないよう保持する。
  detected: false,
  result: null, // { canvas, width, height, limited } 透視補正そのままの結果（不変）
  output: null, // 表示・保存に使う canvas。縦横比指定がなければ result.canvas と同一。
  editor: null,
};

function showScreen(name) {
  for (const [key, node] of Object.entries(screens)) {
    node.hidden = key !== name;
  }
}

function destroyEditor() {
  if (state.editor) {
    state.editor.destroy();
    state.editor = null;
  }
}

/** state.output が state.result.canvas と別物なら解放する（縦横比変更で作った canvas）。 */
function releaseOutputIfDistinct() {
  if (state.output && state.output !== state.result?.canvas) {
    releaseCanvas(state.output);
  }
}

/** 元画像・補正結果を破棄する。連続処理でメモリが増え続けないようにする。 */
function releaseAll() {
  destroyEditor();
  if (state.source) releaseCanvas(state.source.canvas);
  releaseOutputIfDistinct();
  releaseCanvas(state.result?.canvas);
  state.source = null;
  state.result = null;
  state.output = null;
  state.corners = null;
}

/** 処理中の表示を出す。戻り値を呼ぶと消える。 */
function showBusy(stage, label) {
  const busy = document.createElement("div");
  busy.className = "busy";
  busy.innerHTML = '<div class="spinner"></div>';
  busy.appendChild(document.createTextNode(label));
  stage.appendChild(busy);
  return () => busy.remove();
}

/** ブラウザに描画させてから重い同期処理へ入るための 1 フレーム待ち。 */
const nextFrame = () =>
  new Promise((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(resolve)),
  );

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/* ------------------------------------------------------------------ start */

el("pickBtn").addEventListener("click", () => el("fileInput").click());

el("fileInput").addEventListener("change", async (event) => {
  const file = event.target.files?.[0];
  // 同じ写真を続けて選べるように値を消す。
  event.target.value = "";
  if (!file) return;

  const error = el("startError");
  error.textContent = "";
  const button = el("pickBtn");
  const original = button.textContent;
  button.disabled = true;
  button.textContent = "読み込んでいます…";
  await nextFrame();

  try {
    releaseAll();
    state.source = await loadImageFile(file);

    const detection = await detectBoard(state.source.canvas);
    state.corners = detection.corners;
    state.detected = detection.success;
    openEditor(state.detected);
  } catch (err) {
    error.textContent =
      err instanceof UnsupportedImageError
        ? err.message
        : "写真を読み込めませんでした。別の写真を試してください。";
  } finally {
    button.disabled = false;
    button.textContent = original;
  }
});

/* ------------------------------------------------------------------- edit */

/**
 * 四隅編集画面を開く。
 * @param {boolean} detected 自動検出に成功したか（案内文の出し分けに使う）
 */
function openEditor(detected) {
  const { canvas, width, height } = state.source;
  const stage = el("editStage");
  destroyEditor();
  stage.innerHTML = "";
  // 画像のアスペクト比に合わせ、余白を作らず最大面積で表示する。
  stage.style.aspectRatio = `${width} / ${height}`;

  el("editError").textContent = "";
  const hint = el("editHint");
  hint.className = detected ? "note" : "note note-warn";
  hint.textContent = detected
    ? "自動で四隅を検出しました。ずれていれば、白い丸を指でドラッグして合わせてください。"
    : "自動検出できませんでした。白い丸を指でドラッグして、黒板の四隅に合わせてください。";

  state.editor = createCornerEditorAdapter({
    container: stage,
    image: canvas,
    corners: state.corners,
    onChange: (corners) => {
      state.corners = corners;
    },
  });

  showScreen("edit");
}

el("backBtn").addEventListener("click", () => {
  releaseAll();
  el("startError").textContent = "";
  showScreen("start");
});

el("resetBtn").addEventListener("click", () => {
  state.editor?.reset();
  state.corners = state.editor?.getCorners() ?? state.corners;
});

el("applyBtn").addEventListener("click", async () => {
  state.corners = state.editor?.getCorners() ?? state.corners;
  const stage = el("editStage");
  const error = el("editError");
  error.textContent = "";

  const done = showBusy(stage, "補正しています…");
  await nextFrame();

  try {
    releaseOutputIfDistinct();
    releaseCanvas(state.result?.canvas);
    state.result = await correctPerspective(state.source.canvas, state.corners);
    showResult();
  } catch {
    error.textContent =
      "補正できませんでした。四隅の位置を少し変えて、もう一度お試しください。";
  } finally {
    done();
  }
});

/* ----------------------------------------------------------------- result */

/**
 * 透視補正の出力サイズは四隅の対辺長（scanner-adapter.js の predictOutputSize
 * と同じ式）から決まり、実際の黒板の縦横比とは一致しない。強い斜め撮影ほど
 * ずれる（progress.md 参照）。ここでは補正結果 canvas はそのまま保持し、
 * 指定された縦横比に引き伸ばした「表示・保存用」の別 canvas を都度作る。
 * 面積（総ピクセル数）は保つので、指定してもしなくても解像度は変わらない。
 */
function stretchToRatio(sourceCanvas, ratioW, ratioH) {
  const area = sourceCanvas.width * sourceCanvas.height;
  const ratio = ratioW / ratioH;
  const width = Math.max(1, Math.round(Math.sqrt(area * ratio)));
  const height = Math.max(1, Math.round(Math.sqrt(area / ratio)));

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(sourceCanvas, 0, 0, width, height);
  return canvas;
}

/** 縦横比 UI の現在値を { w, h } で返す。「自動」または未入力なら null。 */
function selectedRatio() {
  const mode = el("aspectSelect").value;
  if (mode === "auto") return null;
  if (mode === "custom") {
    const w = parseFloat(el("aspectW").value);
    const h = parseFloat(el("aspectH").value);
    return w > 0 && h > 0 ? { w, h } : null;
  }
  const [w, h] = mode.split(":").map(Number);
  return { w, h };
}

/** 縦横比 UI の選択に合わせて state.output を作り直し、結果画面を再描画する。 */
function applyAspectSelection() {
  const ratio = selectedRatio();
  const nextOutput = ratio
    ? stretchToRatio(state.result.canvas, ratio.w, ratio.h)
    : state.result.canvas;

  releaseOutputIfDistinct();
  state.output = nextOutput;
  renderResultStage();
}

function renderResultStage() {
  const canvas = state.output;
  const stage = el("resultStage");
  stage.innerHTML = "";
  stage.style.aspectRatio = `${canvas.width} / ${canvas.height}`;
  // 大きな canvas を複製するとメモリを二重に持つため、そのまま表示に使う。
  stage.appendChild(canvas);

  const ideal = predictOutputSize(state.corners);
  el("resultMeta").innerHTML =
    `元の写真 ${state.source.width} × ${state.source.height} px → ` +
    `補正後 <strong>${canvas.width} × ${canvas.height} px</strong>` +
    (state.result.limited
      ? `<br>ブラウザが扱える上限を超えるため、${ideal.width} × ${ideal.height} px から縮小しました。`
      : "");
}

function showResult() {
  el("aspectSelect").value = "auto";
  el("aspectCustom").hidden = true;
  state.output = state.result.canvas;
  renderResultStage();

  el("saveStatus").textContent = "";
  showScreen("result");
}

el("aspectSelect").addEventListener("change", () => {
  el("aspectCustom").hidden = el("aspectSelect").value !== "custom";
  applyAspectSelection();
});
el("aspectW").addEventListener("input", applyAspectSelection);
el("aspectH").addEventListener("input", applyAspectSelection);

el("readjustBtn").addEventListener("click", () => {
  // 元画像と四隅は保持したまま編集へ戻る（非破壊）。
  // 案内文は元の検出結果（自動 / 手動）をそのまま踏襲する。
  openEditor(state.detected);
});

el("restartBtn").addEventListener("click", () => {
  releaseAll();
  el("startError").textContent = "";
  showScreen("start");
});

el("saveBtn").addEventListener("click", async () => {
  const button = el("saveBtn");
  const status = el("saveStatus");
  const format = document.querySelector('input[name="format"]:checked').value;

  button.disabled = true;
  status.className = "note";
  status.textContent = "書き出しています…";

  try {
    const blob = await new Promise((resolve, reject) => {
      state.output.toBlob(
        (b) => (b ? resolve(b) : reject(new Error("toBlob failed"))),
        format === "png" ? "image/png" : "image/jpeg",
        format === "png" ? undefined : JPEG_QUALITY,
      );
    });

    const base = state.source.fileName.replace(/\.[^.]+$/, "") || "board";
    const fileName = `${base}_correct.${format === "png" ? "png" : "jpg"}`;

    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = fileName;
    document.body.appendChild(link);
    link.click();
    link.remove();
    // revoke が早すぎると iOS Safari でダウンロードが中断されることがある。
    setTimeout(() => URL.revokeObjectURL(url), 60_000);

    status.textContent = `${fileName}（${formatBytes(blob.size)}）を保存しました。`;
  } catch {
    status.className = "error-msg";
    status.textContent = "保存できませんでした。もう一度お試しください。";
  } finally {
    button.disabled = false;
  }
});

showScreen("start");
