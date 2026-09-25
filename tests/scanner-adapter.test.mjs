import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  fallbackCorners,
  imageBoundsCorners,
  predictOutputSize,
  isConvexQuad,
  DETECT_MAX_DIMENSION,
  MAX_OUTPUT_PIXELS,
} from '../js/scanner-adapter.js';
import { MAX_INPUT_PIXELS } from '../js/image-loader.js';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const quad = (tl, tr, br, bl) => ({
  topLeft: { x: tl[0], y: tl[1] },
  topRight: { x: tr[0], y: tr[1] },
  bottomRight: { x: br[0], y: br[1] },
  bottomLeft: { x: bl[0], y: bl[1] },
});
const image = { width: 4032, height: 3024 };

test('検出失敗時の初期四隅は画像の内側 8% に置く（手動調整の出発点）', () => {
  const c = fallbackCorners(image);
  assert.deepEqual(c.topLeft, { x: 4032 * 0.08, y: 3024 * 0.08 });
  assert.deepEqual(c.bottomRight, { x: 4032 * 0.92, y: 3024 * 0.92 });
  assert.equal(isConvexQuad(c), true);
});

test('「写真全体」の四隅は画像の四隅と一致し、naturalWidth を優先する', () => {
  const c = imageBoundsCorners({ naturalWidth: 3024, naturalHeight: 4032, width: 300, height: 400 });
  assert.deepEqual(c.bottomRight, { x: 3024, y: 4032 });
});

test('出力サイズは対辺のうち長い方の実ピクセル距離（縮小しない）', () => {
  assert.deepEqual(predictOutputSize(imageBoundsCorners(image)), { width: 4032, height: 3024 });
  const trapezoid = quad([100, 0], [900, 0], [1000, 500], [0, 500]);
  assert.deepEqual(predictOutputSize(trapezoid), { width: 1000, height: 510 });
});

test('辺が交差した砂時計型や一直線は凸四角形として扱わない', () => {
  assert.equal(isConvexQuad(quad([0, 0], [100, 0], [0, 100], [100, 100])), false);
  assert.equal(isConvexQuad(quad([0, 0], [1, 0], [2, 0], [3, 0])), false);
  assert.equal(isConvexQuad(quad([10, 5], [90, 0], [100, 80], [0, 100])), true);
});

test('README に書いたメモリ上限・検出解像度がコードと一致している', () => {
  const readme = read('README.md');
  assert.equal(MAX_INPUT_PIXELS, 40_000_000);
  assert.match(readme, /MAX_INPUT_PIXELS`（40MP）/);
  assert.equal(MAX_OUTPUT_PIXELS, 16_700_000);
  assert.match(readme, /MAX_OUTPUT_PIXELS`（16\.7MP/);
  assert.match(readme, new RegExp(`最大辺 ${DETECT_MAX_DIMENSION}px`));
});

test('本体は ML 検出器（CDN からモデルを読む）を使わず、画像を外部送信しない', () => {
  const app = read('js/app.js');
  assert.doesNotMatch(app, /detectBoard\([^)]*["']ml["']/);
  for (const f of ['js/app.js', 'js/image-loader.js', 'js/scanner-adapter.js']) {
    assert.doesNotMatch(read(f), /\bfetch\(|sendBeacon|XMLHttpRequest|WebSocket|https?:\/\//, f);
  }
});
