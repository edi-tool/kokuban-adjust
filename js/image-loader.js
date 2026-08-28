/**
 * 画像の読み込み。EXIF Orientation の適用、非対応形式の判定、
 * メモリ上限の適用をここに集約する。
 */

/**
 * 入力画像として扱う最大ピクセル数。
 *
 * 理由: 透視補正 1 回につき、原寸の RGBA バッファが複数同時に確保される
 * （元画像 canvas / 読み取り用 ImageData / 出力 ImageData / 出力 canvas）。
 * 1 ピクセル 4 バイトなので、40MP の画像では合計 500MB 超になり、
 * iOS Safari のタブメモリ上限を超えてクラッシュする。
 *
 * 40MP は iPhone の標準的な写真 (12MP = 4032x3024) や 48MP 相当の
 * 高画素モードを素通しできる値。ここを超える画像のみ縮小する。
 * つまり通常のスマートフォン写真は一切縮小されない。
 */
export const MAX_INPUT_PIXELS = 40_000_000;

export class UnsupportedImageError extends Error {
  constructor(message) {
    super(message);
    this.name = "UnsupportedImageError";
  }
}

const HEIC_MESSAGE =
  "この画像形式 (HEIC/HEIF) には対応していません。iPhone の「設定 → カメラ → フォーマット」を「互換性優先」にするか、JPEG または PNG で保存し直してください。";

const GENERIC_MESSAGE =
  "この画像形式には対応していません。JPEG または PNG を使用してください。";

/**
 * 先頭バイトから HEIC/HEIF を判定する。
 *
 * iPhone から選んだ画像は MIME が空になることがあるため、File.type だけに
 * 頼らずマジックナンバーも見る。HEIC のデコードは Safari 以外では非対応で、
 * 対応するには数 MB の wasm デコーダが必要になるため、初版では非対応とする。
 */
async function isHeic(file) {
  const type = (file.type || "").toLowerCase();
  if (type.includes("heic") || type.includes("heif")) return true;
  if (/\.(heic|heif)$/i.test(file.name)) return true;

  const head = new Uint8Array(await file.slice(0, 12).arrayBuffer());
  if (head.length < 12) return false;
  // ISO BMFF: bytes 4..8 が 'ftyp'
  const isFtyp =
    head[4] === 0x66 &&
    head[5] === 0x74 &&
    head[6] === 0x79 &&
    head[7] === 0x70;
  if (!isFtyp) return false;
  const brand = String.fromCharCode(head[8], head[9], head[10], head[11]);
  return ["heic", "heix", "hevc", "hevx", "mif1", "msf1"].includes(brand);
}

/**
 * EXIF Orientation を適用してデコードする。
 *
 * EXIF パーサは自作しない。createImageBitmap の imageOrientation:'from-image'
 * がブラウザ側で回転を適用してくれるため、これを第一手段にする。
 * 未対応環境では <img> にフォールバックする（<img> も現行ブラウザでは
 * 既定で EXIF Orientation を適用して描画する）。
 */
async function decode(file) {
  if (typeof createImageBitmap === "function") {
    try {
      return await createImageBitmap(file, { imageOrientation: "from-image" });
    } catch {
      // 下の <img> フォールバックへ
    }
  }

  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    await new Promise((resolve, reject) => {
      img.onload = resolve;
      img.onerror = () => reject(new UnsupportedImageError(GENERIC_MESSAGE));
      img.src = url;
    });
    if (!img.naturalWidth || !img.naturalHeight) {
      throw new UnsupportedImageError(GENERIC_MESSAGE);
    }
    return img;
  } finally {
    URL.revokeObjectURL(url);
  }
}

function toCanvas(file, decoded) {
  const srcW = decoded.naturalWidth || decoded.width;
  const srcH = decoded.naturalHeight || decoded.height;
  if (!srcW || !srcH) throw new UnsupportedImageError(GENERIC_MESSAGE);

  // 上限を超えるときだけ等比縮小する。通常のスマホ写真は scale = 1。
  const pixels = srcW * srcH;
  const scale =
    pixels > MAX_INPUT_PIXELS ? Math.sqrt(MAX_INPUT_PIXELS / pixels) : 1;
  const width = Math.round(srcW * scale);
  const height = Math.round(srcH * scale);

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new UnsupportedImageError(GENERIC_MESSAGE);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(decoded, 0, 0, width, height);

  // ImageBitmap はメモリを持つので、canvas へ写したら即解放する。
  if (typeof decoded.close === "function") decoded.close();

  return {
    canvas,
    width,
    height,
    scale,
    fileName: file.name,
  };
}

export async function loadImageFile(file) {
  if (await isHeic(file)) {
    // Safari は HEIC をデコードできるので、まず試してから固有の案内を出す。
    try {
      return toCanvas(file, await decode(file));
    } catch {
      throw new UnsupportedImageError(HEIC_MESSAGE);
    }
  }
  return toCanvas(file, await decode(file));
}

/** canvas のバックストアを明示的に解放する（連続処理でメモリが増え続けるのを防ぐ）。 */
export function releaseCanvas(canvas) {
  if (!canvas) return;
  canvas.width = 0;
  canvas.height = 0;
}
