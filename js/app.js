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
  imageBoundsCorners,
  isConvexQuad,
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

/**
 * canvas の 1 辺の上限。
 *
 * iOS Safari は 1 辺 16384 px を超える canvas を作れず、例外も出さずに
 * 描画結果が空になる。縦横比を極端な値にしたときだけ効く保険なので、
 * ここを緩めると「保存したら真っ白」という気付きにくい壊れ方に戻る。
 */
const MAX_CANVAS_DIMENSION = 16384;

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
  // 四隅編集の「元に戻す」用。1 回のドラッグ＝1 段として積む（pushUndoState 参照）。
  history: [],
  committedCorners: null,
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

/**
 * 結果画面は canvas を 2 つ持つ。
 *   result.canvas … 透視補正そのままの結果（不変。再計算しない）
 *   output        … 縦横比を適用したもの（指定なしなら result.canvas と同一）
 * 同一のときに解放すると元まで壊すため、別物のときだけ解放する。
 */
function releaseOutputIfDistinct() {
  if (state.output && state.output !== state.result?.canvas) {
    releaseCanvas(state.output);
  }
  state.output = null;
}

/** 元画像・補正結果を破棄する。連続処理でメモリが増え続けないようにする。 */
function releaseAll() {
  destroyEditor();
  if (state.source) releaseCanvas(state.source.canvas);
  releaseOutputIfDistinct();
  releaseCanvas(state.result?.canvas);
  state.source = null;
  state.result = null;
  state.corners = null;
  state.history = [];
  state.committedCorners = null;
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

/**
 * 写真 1 枚を読み込んで四隅を検出し、編集画面へ進む。
 * カメラ（capture 付き）と写真選択の両方の input から呼ぶ。
 */
async function handleFile(file) {
  const error = el("startError");
  const buttons = [el("shootBtn"), el("pickBtn")];
  const busyStage = el("startBusy");

  error.textContent = "";
  for (const button of buttons) button.disabled = true;
  busyStage.hidden = false;
  busyStage.setAttribute("aria-busy", "true");
  // 40MP では読み込みと検出で 1.5 秒以上かかる。どちらの段階かを出す。
  let done = showBusy(busyStage, "写真を読み込んでいます…");
  await nextFrame();

  try {
    releaseAll();
    state.source = await loadImageFile(file);

    done();
    done = showBusy(busyStage, "黒板の四隅をさがしています…");
    await nextFrame();

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
    done();
    busyStage.hidden = true;
    busyStage.removeAttribute("aria-busy");
    for (const button of buttons) button.disabled = false;
  }
}

function onFileInputChange(event) {
  const file = event.target.files?.[0];
  // 同じ写真を続けて選べるように値を消す。
  event.target.value = "";
  if (file) handleFile(file);
}

el("shootBtn").addEventListener("click", () => el("cameraInput").click());
el("pickBtn").addEventListener("click", () => el("fileInput").click());
el("cameraInput").addEventListener("change", onFileInputChange);
el("fileInput").addEventListener("change", onFileInputChange);

/* ------------------------------------------------------------------- edit */

/**
 * 「元に戻す」の 1 段。
 *
 * scanic の onChange はドラッグ中に何度も飛んでくるため、1 ピクセル動くたびに
 * 履歴が増えると「元に戻す」が実質使えない。手が止まってからこの時間だけ
 * 待って 1 段にまとめる（ドラッグ 1 回＝1 段、微調整ボタンの連打も 1 段）。
 */
const UNDO_COMMIT_DELAY = 350;

/** 履歴の上限。四隅 4 点だけなので軽いが、際限なく持つ必要もない。 */
const UNDO_LIMIT = 30;

let undoCommitTimer = null;

const cloneCorners = (c) => ({
  topLeft: { ...c.topLeft },
  topRight: { ...c.topRight },
  bottomRight: { ...c.bottomRight },
  bottomLeft: { ...c.bottomLeft },
});

function updateUndoButton() {
  el("undoBtn").disabled = state.history.length === 0;
}

/** 現在の確定状態を履歴へ積む（setCorners で置き換える操作の直前に呼ぶ）。 */
function pushUndoState() {
  if (!state.committedCorners) return;
  state.history.push(state.committedCorners);
  if (state.history.length > UNDO_LIMIT) state.history.shift();
  updateUndoButton();
}

/** 履歴を初期化する。編集画面を開くたびに呼ぶ。 */
function resetUndoHistory(corners) {
  clearTimeout(undoCommitTimer);
  undoCommitTimer = null;
  state.history = [];
  state.committedCorners = cloneCorners(corners);
  updateUndoButton();
}

/** 四隅をアプリ側から差し替える（履歴に 1 段積んでから置き換える）。 */
function replaceCorners(next) {
  clearTimeout(undoCommitTimer);
  undoCommitTimer = null;
  pushUndoState();
  state.corners = cloneCorners(next);
  state.committedCorners = cloneCorners(next);
  state.editor?.setCorners(next);
}

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
      // 手が止まってから 1 段だけ履歴に積む（UNDO_COMMIT_DELAY 参照）。
      clearTimeout(undoCommitTimer);
      undoCommitTimer = setTimeout(() => {
        undoCommitTimer = null;
        pushUndoState();
        state.committedCorners = cloneCorners(state.corners);
      }, UNDO_COMMIT_DELAY);
    },
  });

  resetUndoHistory(state.corners);
  showScreen("edit");
}

el("backBtn").addEventListener("click", () => {
  releaseAll();
  el("startError").textContent = "";
  showScreen("start");
});

el("resetBtn").addEventListener("click", () => {
  clearTimeout(undoCommitTimer);
  undoCommitTimer = null;
  pushUndoState();
  state.editor?.reset();
  state.corners = state.editor?.getCorners() ?? state.corners;
  state.committedCorners = cloneCorners(state.corners);
});

// 黒板が写真いっぱいに写っているときは、検出結果を直すより写真全体から
// 内側へ寄せるほうが早い。
el("wholeBtn").addEventListener("click", () => {
  replaceCorners(imageBoundsCorners(state.source.canvas));
});

el("undoBtn").addEventListener("click", () => {
  clearTimeout(undoCommitTimer);
  undoCommitTimer = null;
  const previous = state.history.pop();
  if (!previous) return;
  state.corners = cloneCorners(previous);
  state.committedCorners = cloneCorners(previous);
  state.editor?.setCorners(previous);
  updateUndoButton();
});

el("applyBtn").addEventListener("click", async () => {
  state.corners = state.editor?.getCorners() ?? state.corners;
  const stage = el("editStage");
  const error = el("editError");
  error.textContent = "";

  // ねじれた四角形（辺が交差している）を渡すと透視変換が破綻し、渦を巻いた
  // 画像や真っ黒の画像が出てくる。scanic のドラッグは交差する移動自体を
  // 受け付けないので通常は起きないが、破綻した結果を黙って保存させるより、
  // 原因の分かる文言で止めるほうがよい（最後の砦としてのチェック）。
  if (!isConvexQuad(state.corners)) {
    error.textContent =
      "四隅がねじれています。左上・右上・右下・左下がこの順に並ぶよう、白い丸を動かしてください。";
    return;
  }

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
  let width = Math.max(1, Math.round(Math.sqrt(area * ratio)));
  let height = Math.max(1, Math.round(Math.sqrt(area / ratio)));

  // 面積を保つ計算なので総ピクセル数は増えないが、極端な比では 1 辺だけが
  // 伸びて canvas の 1 辺の上限を超える（例 1000:0.1 で 298547×30）。
  // 超えた canvas は例外を出さず「真っ白のまま」になり、保存まで気付けない。
  // iOS Safari の上限が 16384 px なので、そこに収まるよう比を保って縮める。
  const longest = Math.max(width, height);
  if (longest > MAX_CANVAS_DIMENSION) {
    const shrink = MAX_CANVAS_DIMENSION / longest;
    width = Math.max(1, Math.round(width * shrink));
    height = Math.max(1, Math.round(height * shrink));
  }

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

  // 保存済みの表示が残っていると、比を変えた後の画像も保存済みだと誤解する。
  el("saveStatus").textContent = "";
  el("nextRow").hidden = true;
}

function renderResultStage() {
  const canvas = state.output;
  const stage = el("resultStage");
  // stage.innerHTML でまとめて消すと境界ドラッグ用ハンドル（常設の DOM）も
  // 消えてしまうため、前回の canvas だけを取り除く。
  stage.querySelector("canvas")?.remove();
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
  el("nextRow").hidden = true;
  showScreen("result");
}

/**
 * 縦横比 UI の「カスタム…」へ w:h を書き込む。
 *
 * 高さを 10 に固定して幅を小数第 1 位までにそろえる。境界ドラッグ・回転・
 * 入れ替えのどれも、最終的にはこの 1 か所を通して applyAspectSelection に
 * 渡すので、UI の表示と実際の出力が食い違わない。
 */
function setCustomRatio(w, h) {
  el("aspectSelect").value = "custom";
  el("aspectCustom").hidden = false;
  el("aspectH").value = "10";
  el("aspectW").value = String(Math.round((w / h) * 100) / 10);
}

el("aspectSelect").addEventListener("change", () => {
  el("aspectCustom").hidden = el("aspectSelect").value !== "custom";
  clearTimeout(aspectInputTimer);
  applyAspectSelection();
});
// 1 文字打つたびに数百万画素の canvas を描き直すと入力が引っかかるので、
// 数値入力のあいだだけ少し待つ。プルダウンは即時でよい。
let aspectInputTimer = null;
const applyAspectSelectionSoon = () => {
  clearTimeout(aspectInputTimer);
  aspectInputTimer = setTimeout(applyAspectSelection, 150);
};
el("aspectW").addEventListener("input", applyAspectSelectionSoon);
el("aspectH").addEventListener("input", applyAspectSelectionSoon);

/**
 * 結果画像の上下左右の境界をドラッグして縦横比を変える。
 *
 * 縦横比 UI（プルダウン・カスタム入力）と同じ stretchToRatio を使うため、
 * 仕組みは別物ではなく「カスタム欄への別の入力手段」。ドラッグ中は毎フレーム
 * 数百万画素の canvas を描き直すと重いので、CSS で canvas を枠いっぱいに
 * 引き伸ばして見た目だけ追従させ、指を離した瞬間に一度だけ本物の
 * stretchToRatio で描き直す。
 */
const MIN_EDGE_FRACTION = 0.25;
const MAX_EDGE_FRACTION = 4;
let edgeDrag = null;

function beginEdgeDrag(handle, event) {
  if (!state.output || edgeDrag) return;
  event.preventDefault();
  const stage = el("resultStage");
  const rect = stage.getBoundingClientRect();
  edgeDrag = {
    edge: handle.dataset.edge,
    pointerId: event.pointerId,
    startX: event.clientX,
    startY: event.clientY,
    startWidth: rect.width,
    startHeight: rect.height,
    width: rect.width,
    height: rect.height,
  };
  handle.classList.add("is-active");
  stage.classList.add("is-dragging");
  try {
    handle.setPointerCapture(event.pointerId);
  } catch {
    // Pointer Events 非対応環境向けのフォールバックは持たない。
  }
}

function moveEdgeDrag(event) {
  if (!edgeDrag || event.pointerId !== edgeDrag.pointerId) return;
  const dx = event.clientX - edgeDrag.startX;
  const dy = event.clientY - edgeDrag.startY;
  let width = edgeDrag.startWidth;
  let height = edgeDrag.startHeight;
  if (edgeDrag.edge === "left") width -= dx;
  else if (edgeDrag.edge === "right") width += dx;
  else if (edgeDrag.edge === "top") height -= dy;
  else if (edgeDrag.edge === "bottom") height += dy;

  width = Math.min(
    edgeDrag.startWidth * MAX_EDGE_FRACTION,
    Math.max(edgeDrag.startWidth * MIN_EDGE_FRACTION, width),
  );
  height = Math.min(
    edgeDrag.startHeight * MAX_EDGE_FRACTION,
    Math.max(edgeDrag.startHeight * MIN_EDGE_FRACTION, height),
  );

  edgeDrag.width = width;
  edgeDrag.height = height;
  el("resultStage").style.aspectRatio = `${width} / ${height}`;
}

function endEdgeDrag(event) {
  if (!edgeDrag || event.pointerId !== edgeDrag.pointerId) return;
  const { edge, width, height } = edgeDrag;
  edgeDrag = null;

  const stage = el("resultStage");
  stage.classList.remove("is-dragging");
  stage.querySelector(`.edge-handle--${edge}`)?.classList.remove("is-active");

  // 比率を扱いやすい数値にそろえてカスタム欄へ反映し、既存の縦横比 UI と
  // 状態を一致させる（保存・再描画は applyAspectSelection に一本化する）。
  setCustomRatio(width, height);

  clearTimeout(aspectInputTimer);
  applyAspectSelection();
}

for (const handle of document.querySelectorAll(".edge-handle")) {
  handle.addEventListener("pointerdown", (event) =>
    beginEdgeDrag(handle, event),
  );
  handle.addEventListener("pointermove", moveEdgeDrag);
  handle.addEventListener("pointerup", endEdgeDrag);
  handle.addEventListener("pointercancel", endEdgeDrag);
}

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

/**
 * 補正結果を端末に渡す。
 *
 * iOS Safari では `<a download>` はカメラロールに保存されず、ファイル App に
 * 落ちるか単に開くだけになる。共有シート経由なら「画像を保存」で写真アプリへ
 * 入るため、使える端末では Web Share を優先する。
 *
 * @returns {Promise<"shared"|"downloaded"|"canceled">}
 */
async function deliverBlob(blob, fileName) {
  const file = new File([blob], fileName, { type: blob.type });

  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file] });
      return "shared";
    } catch (err) {
      // シートを閉じただけ。失敗として扱わない。
      if (err?.name === "AbortError" || err?.name === "NotAllowedError") {
        return "canceled";
      }
      // 共有が使えなかった場合はダウンロードへ倒す。
    }
  }

  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  // revoke が早すぎると iOS Safari でダウンロードが中断されることがある。
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
  return "downloaded";
}

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
    const size = formatBytes(blob.size);
    const result = await deliverBlob(blob, fileName);

    if (result === "canceled") {
      status.textContent = "保存を中止しました。";
    } else {
      status.textContent =
        result === "shared"
          ? `${fileName}（${size}）を渡しました。共有メニューの「画像を保存」で写真アプリに入ります。`
          : `${fileName}（${size}）を保存しました。`;
      el("nextRow").hidden = false;
    }
  } catch {
    status.className = "error-msg";
    status.textContent = "保存できませんでした。もう一度お試しください。";
  } finally {
    button.disabled = false;
  }
});

el("nextBtn").addEventListener("click", () => {
  releaseAll();
  el("startError").textContent = "";
  showScreen("start");
  // 撮り直しが続く使い方が多いのでカメラを直接開く。
  el("cameraInput").click();
});

/* -------------------------------------------------------------------- 初期化 */

// 共有シートが使える端末では保存先が写真アプリになるので文言を合わせる。
// canShare は実際の File を渡さないと判定しないため、空のダミーで確認する。
if (
  navigator.canShare?.({
    files: [new File([], "board.jpg", { type: "image/jpeg" })],
  })
) {
  el("saveBtn").textContent = "写真に保存";
}

showScreen("start");
