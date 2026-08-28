/**
 * 補正後画像の保存。
 * 不要な再圧縮を避けるため、JPEG は高品質固定、PNG は無劣化で書き出す。
 */

export type ExportFormat = 'jpeg' | 'png';

/**
 * JPEG 書き出し品質。
 *
 * 0.92 はブラウザ既定 (0.92) と同等で、黒板のチョーク文字のような
 * 細い高コントラスト線でもモスキートノイズが目立ちにくい水準。
 * これ以上下げると文字の可読性が落ちるため、UI からは変更させない。
 */
const JPEG_QUALITY = 0.92;

export function buildFileName(originalName: string, format: ExportFormat): string {
  const base = originalName.replace(/\.[^.]+$/, '') || 'board';
  const ext = format === 'png' ? 'png' : 'jpg';
  return `${base}_corrected.${ext}`;
}

export function canvasToBlob(
  canvas: HTMLCanvasElement,
  format: ExportFormat
): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const type = format === 'png' ? 'image/png' : 'image/jpeg';
    canvas.toBlob(
      (blob) => {
        if (blob) resolve(blob);
        else reject(new Error('画像の書き出しに失敗しました'));
      },
      type,
      format === 'jpeg' ? JPEG_QUALITY : undefined
    );
  });
}

/** ダウンロードを開始する。画像はここでも端末外へ出ない（Blob URL のみ）。 */
export async function downloadCanvas(
  canvas: HTMLCanvasElement,
  originalName: string,
  format: ExportFormat
): Promise<{ blob: Blob; fileName: string }> {
  const blob = await canvasToBlob(canvas, format);
  const fileName = buildFileName(originalName, format);
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // revoke が早すぎると iOS Safari でダウンロードが中断されることがある。
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
  return { blob, fileName };
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
