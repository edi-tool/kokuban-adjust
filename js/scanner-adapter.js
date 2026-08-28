/**
 * scanic (MIT) を隔離するための薄い Adapter 層。
 *
 * アプリ本体 (js/app.js) はこのファイルが公開する関数だけを呼ぶ。
 * 将来 scanic を jscanify / OpenCV.js / 別の WASM 実装へ差し替える場合も、
 * 変更はこのファイルに閉じる。抽象化はここまでで止める。
 *
 * scanic は lib/ にベンダリングしたビルド済み ESM をそのまま読み込む
 * （ビルド工程を持たない方針のため、npm/バンドラは使わない）。
 */

import {
  scanDocument,
  extractDocument,
  createCornerEditor,
} from "../lib/scanic.js";

/**
 * 検出処理を行う縮小画像の最大辺 (px)。
 *
 * 検出だけを縮小画像で行い、最終的な透視補正は必ず原寸画像に対して行う
 * (correctPerspective を参照)。scanic は検出後に四隅座標を原寸画像の
 * 座標系へ復元して返すため、ここを小さくしても出力解像度は落ちない。
 * 黒板は被写体が大きく写るので 1024 で足りる。
 */
const DETECT_MAX_DIMENSION = 1024;

/**
 * 出力画像の最大ピクセル数。
 *
 * iOS Safari は canvas の総面積に上限があり（概ね 16.7MP 相当）、
 * それを超えると canvas が空になる。補正後がこれを超える場合のみ、
 * 四隅から算出した理想サイズを等比で縮める。通常のスマートフォン写真では
 * 補正後は元画像より小さくなるため発動しない。
 */
export const MAX_OUTPUT_PIXELS = 16_700_000;

/** 自動検出が失敗したときに置く初期四隅の、画像端からの内側マージン比率。 */
const FALLBACK_INSET_RATIO = 0.08;

/**
 * 自動検出の下限確度。
 *
 * 実測では、正しく検出できた黒板・ホワイトボードは 0.90 前後、
 * 壁と板面の色差が小さく誤検出した場合は 0.16 程度だった。
 * 誤検出をそのまま採用すると「補正したら細長い帯になった」という
 * 最悪の体験になるため、確度が低いものは検出失敗として扱い、
 * 手動 4 点指定へ倒す。
 */
const MIN_CONFIDENCE = 0.45;

/** 検出された四角形が占めるべき、画像全体に対する最小面積比。 */
const MIN_AREA_RATIO = 0.15;

/** 四角形の各辺が持つべき、画像短辺に対する最小長さの比。 */
const MIN_SIDE_RATIO = 0.1;

function sourceSize(image) {
  return {
    width: image.naturalWidth || image.width,
    height: image.naturalHeight || image.height,
  };
}

/**
 * 自動検出に失敗した場合の初期四隅。
 *
 * 手動 4 点指定は非常用機能ではなく主要機能なので、失敗時も必ず
 * 「編集を始められる四隅」を返す。
 */
export function fallbackCorners(image) {
  const { width, height } = sourceSize(image);
  const mx = width * FALLBACK_INSET_RATIO;
  const my = height * FALLBACK_INSET_RATIO;
  return {
    topLeft: { x: mx, y: my },
    topRight: { x: width - mx, y: my },
    bottomRight: { x: width - mx, y: height - my },
    bottomLeft: { x: mx, y: height - my },
  };
}

/** 四隅が画像の外へ出ないよう丸める。 */
function clampCorners(corners, image) {
  const { width, height } = sourceSize(image);
  const clamp = (p) => ({
    x: Math.min(Math.max(p.x, 0), width),
    y: Math.min(Math.max(p.y, 0), height),
  });
  return {
    topLeft: clamp(corners.topLeft),
    topRight: clamp(corners.topRight),
    bottomRight: clamp(corners.bottomRight),
    bottomLeft: clamp(corners.bottomLeft),
  };
}

/**
 * 補正後の出力サイズを、透視補正を実行する前に予測する。
 * scanic の出力サイズ決定と同じ式（対辺のうち長い方のピクセル距離）を使う。
 */
export function predictOutputSize(corners) {
  const { topLeft, topRight, bottomRight, bottomLeft } = corners;
  const width = Math.round(
    Math.max(
      Math.hypot(bottomRight.x - bottomLeft.x, bottomRight.y - bottomLeft.y),
      Math.hypot(topRight.x - topLeft.x, topRight.y - topLeft.y),
    ),
  );
  const height = Math.round(
    Math.max(
      Math.hypot(topRight.x - bottomRight.x, topRight.y - bottomRight.y),
      Math.hypot(topLeft.x - bottomLeft.x, topLeft.y - bottomLeft.y),
    ),
  );
  return { width: Math.max(1, width), height: Math.max(1, height) };
}

function quadArea(c) {
  const pts = [c.topLeft, c.topRight, c.bottomRight, c.bottomLeft];
  let sum = 0;
  for (let i = 0; i < 4; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % 4];
    sum += a.x * b.y - b.x * a.y;
  }
  return Math.abs(sum) / 2;
}

/**
 * 検出結果が「黒板・ホワイトボードとしてありえる形か」を判定する。
 *
 * 黒板は写真の大部分を占め、極端に細長くはならない、という用途固有の
 * 前提を使った絞り込み。汎用の Document Scanner では弾けない誤検出
 * （壁の模様や掲示物の縁を拾った細長い四角形）をここで落とす。
 */
function isPlausibleBoard(corners, confidence, image) {
  if (confidence != null && confidence < MIN_CONFIDENCE) return false;

  const { width, height } = sourceSize(image);
  if (quadArea(corners) < width * height * MIN_AREA_RATIO) return false;

  const predicted = predictOutputSize(corners);
  const minSide = Math.min(width, height) * MIN_SIDE_RATIO;
  return predicted.width >= minSide && predicted.height >= minSide;
}

/**
 * 黒板・ホワイトボードの四隅を自動検出する。
 *
 * 検出は縮小画像で行われるが、返る座標は常に原寸画像座標系。
 * 検出に失敗しても例外にはせず、success:false と手動編集用の初期四隅を返す。
 *
 * @param {HTMLCanvasElement|HTMLImageElement} image 原寸画像
 * @param {'classical'|'ml'} detector
 */
export async function detectBoard(image, detector = "classical") {
  const startedAt = performance.now();
  const fail = () => ({
    success: false,
    corners: fallbackCorners(image),
    confidence: null,
    elapsedMs: performance.now() - startedAt,
  });

  try {
    const result = await scanDocument(image, {
      mode: "detect",
      detector,
      maxProcessingDimension: DETECT_MAX_DIMENSION,
    });
    const confidence = result.confidence ?? result.score ?? null;

    if (
      result.success &&
      result.corners &&
      isPlausibleBoard(result.corners, confidence, image)
    ) {
      return {
        success: true,
        corners: clampCorners(result.corners, image),
        confidence,
        elapsedMs: performance.now() - startedAt,
      };
    }
    return fail();
  } catch {
    // 検出の失敗でアプリを止めない。手動 4 点指定へ倒す。
    return fail();
  }
}

function scaleCorners(corners, factor) {
  const s = (p) => ({ x: p.x * factor, y: p.y * factor });
  return {
    topLeft: s(corners.topLeft),
    topRight: s(corners.topRight),
    bottomRight: s(corners.bottomRight),
    bottomLeft: s(corners.bottomLeft),
  };
}

/**
 * 原寸画像に対して透視補正をかける。
 *
 * 入力 image は必ず原寸のものを渡すこと。scanic の extractDocument は
 * 渡された画像をそのままの解像度で読み取り、出力サイズを四隅の実ピクセル
 * 距離から決めるため、ここに縮小画像を渡すと解像度が失われる。
 *
 * MAX_OUTPUT_PIXELS を超える場合のみ、入力と四隅をまとめて等比縮小してから
 * 補正する。品質を勝手に落とすのではなく、ブラウザの canvas 上限を超えて
 * 出力が空になるのを防ぐための、明示的で最小限の制限。
 */
export async function correctPerspective(image, corners) {
  let sourceImage = image;
  let effectiveCorners = corners;
  let downscaled = null;

  const predicted = predictOutputSize(corners);
  const predictedPixels = predicted.width * predicted.height;

  if (predictedPixels > MAX_OUTPUT_PIXELS) {
    const factor = Math.sqrt(MAX_OUTPUT_PIXELS / predictedPixels);
    const { width, height } = sourceSize(image);
    downscaled = document.createElement("canvas");
    downscaled.width = Math.max(1, Math.round(width * factor));
    downscaled.height = Math.max(1, Math.round(height * factor));
    const ctx = downscaled.getContext("2d", { willReadFrequently: true });
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(image, 0, 0, downscaled.width, downscaled.height);
    sourceImage = downscaled;
    effectiveCorners = scaleCorners(corners, factor);
  }

  try {
    const result = await extractDocument(sourceImage, effectiveCorners, {
      output: "canvas",
    });
    if (!result.success || !result.output) {
      throw new Error(result.message || "補正に失敗しました");
    }
    const canvas = result.output;
    return {
      canvas,
      width: canvas.width,
      height: canvas.height,
      limited: downscaled !== null,
    };
  } finally {
    // 一時バッファを必ず解放し、連続処理でメモリが積み上がらないようにする。
    if (downscaled) {
      downscaled.width = 0;
      downscaled.height = 0;
    }
  }
}

/**
 * 四隅ドラッグ用エディタを作る。
 * タッチ操作・拡大ルーペ・キーボード操作は scanic 側の実装を使う（再実装しない）。
 */
export function createCornerEditorAdapter({
  container,
  image,
  corners,
  onChange,
}) {
  const editor = createCornerEditor({
    container,
    image,
    corners,
    // 指で角が隠れる問題を避けるため、ルーペは必ず有効にする。
    magnifier: { enabled: true, size: 128, zoom: 2.5 },
    nudges: { enabled: false },
    // 操作ボタンはアプリ側の UI に統一するため、scanic のツールバーは出さない。
    toolbar: { enabled: false },
    handleHitArea: 44,
    keyboard: true,
    theme: {
      accent: "#f28c06",
      mask: "rgba(15, 15, 15, 0.5)",
      handleSize: 22,
      handleHit: 44,
      handleColor: "#ffffff",
      handleRingColor: "#f28c06",
    },
    onChange,
  });

  return {
    getCorners: () => editor.getCorners(),
    reset: () => editor.reset(),
    destroy: () => editor.destroy(),
  };
}
