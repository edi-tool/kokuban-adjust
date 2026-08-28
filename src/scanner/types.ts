/**
 * アプリ内部で使う型定義。
 * scanic など特定ライブラリの型をアプリ全体へ漏らさないための境界。
 */

export interface Point {
  x: number;
  y: number;
}

/** 画像のピクセル座標系（原寸）における四隅。 */
export interface Corners {
  topLeft: Point;
  topRight: Point;
  bottomRight: Point;
  bottomLeft: Point;
}

export type DetectorKind = 'classical' | 'ml';

export interface DetectResult {
  /** 検出に成功したか。false でも corners には手動編集用の初期値が入る。 */
  success: boolean;
  /** 原寸画像座標系の四隅。 */
  corners: Corners;
  /** 0..1。detector 実装依存の目安値。 */
  confidence: number | null;
  /** 検出処理にかかった時間 (ms)。 */
  elapsedMs: number;
  /** 検出処理を行った縮小画像の最大辺。 */
  processingDimension: number;
}

export interface CorrectResult {
  canvas: HTMLCanvasElement;
  width: number;
  height: number;
  /** canvas の上限に当たったため出力を縮小した場合 true。 */
  limited: boolean;
}

export interface CornerEditorHandle {
  getCorners(): Corners;
  setCorners(corners: Corners): void;
  reset(): void;
  destroy(): void;
}

export interface CornerEditorConfig {
  container: HTMLElement;
  image: HTMLCanvasElement | HTMLImageElement;
  corners: Corners;
  onChange?: (corners: Corners) => void;
}
