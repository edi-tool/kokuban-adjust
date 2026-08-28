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
  result: null, // { canvas, width, height, limited }
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

/** 元画像・補正結果を破棄する。連続処理でメモリが増え続けないようにする。 */
function releaseAll() {
  destroyEditor();
  if (state.source) releaseCanvas(state.source.canvas);
  releaseCanvas(state.result?.canvas);
  state.source = null;
  state.result = null;
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
    openEditor(detection.success);
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

function showResult() {
  const { canvas, width, height, limited } = state.result;
  const stage = el("resultStage");
  stage.innerHTML = "";
  stage.style.aspectRatio = `${width} / ${height}`;
  // 大きな canvas を複製するとメモリを二重に持つため、そのまま表示に使う。
  stage.appendChild(canvas);

  const ideal = predictOutputSize(state.corners);
  el("resultMeta").innerHTML =
    `元の写真 ${state.source.width} × ${state.source.height} px → ` +
    `補正後 <strong>${width} × ${height} px</strong>` +
    (limited
      ? `<br>ブラウザが扱える上限を超えるため、${ideal.width} × ${ideal.height} px から縮小しました。`
      : "");

  el("saveStatus").textContent = "";
  showScreen("result");
}

el("readjustBtn").addEventListener("click", () => {
  // 元画像と四隅は保持したまま編集へ戻る（非破壊）。
  openEditor(true);
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
      state.result.canvas.toBlob(
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
