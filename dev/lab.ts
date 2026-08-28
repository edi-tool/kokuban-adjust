/**
 * Phase 1: 検出エンジンの比較ページ（開発用）。
 *
 * 黒板・ホワイトボードの写真に対して
 *   - Scanic classical detector
 *   - Scanic ML detector
 *   - jscanify (OpenCV.js)
 * を同じ画像へ適用し、四隅・処理時間・補正後の出力解像度を並べて確認する。
 */

import './lab.css';
import { scanDocument } from 'scanic';
import { loadImageFile } from '../src/imageLoader';
import { correctPerspective, predictOutputSize } from '../src/scanner/scannerAdapter';
import type { Corners } from '../src/scanner/types';

const fileInput = document.querySelector<HTMLInputElement>('#file')!;
const useMl = document.querySelector<HTMLInputElement>('#useMl')!;
const useJscanify = document.querySelector<HTMLInputElement>('#useJscanify')!;
const statusEl = document.querySelector<HTMLElement>('#status')!;
const resultsEl = document.querySelector<HTMLElement>('#results')!;

interface Trial {
  name: string;
  corners: Corners | null;
  confidence: number | null;
  detectMs: number;
  extractMs: number;
  outputWidth: number;
  outputHeight: number;
  note: string;
}

/** 検出結果を元画像の縮小プレビュー上に重ねて描く。 */
function drawOverlay(
  source: HTMLCanvasElement,
  corners: Corners | null,
  target: HTMLCanvasElement
) {
  const maxSide = 420;
  const scale = Math.min(1, maxSide / Math.max(source.width, source.height));
  target.width = Math.round(source.width * scale);
  target.height = Math.round(source.height * scale);
  const ctx = target.getContext('2d')!;
  ctx.drawImage(source, 0, 0, target.width, target.height);
  if (!corners) return;

  const pts = [corners.topLeft, corners.topRight, corners.bottomRight, corners.bottomLeft];
  ctx.beginPath();
  pts.forEach((p, i) => {
    const x = p.x * scale;
    const y = p.y * scale;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.closePath();
  ctx.strokeStyle = '#2f9e6e';
  ctx.lineWidth = 3;
  ctx.stroke();
  ctx.fillStyle = '#ffffff';
  pts.forEach((p) => {
    ctx.beginPath();
    ctx.arc(p.x * scale, p.y * scale, 5, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#2f9e6e';
    ctx.lineWidth = 2;
    ctx.stroke();
  });
}

async function runScanic(
  canvas: HTMLCanvasElement,
  detector: 'classical' | 'ml'
): Promise<Trial> {
  const name = detector === 'ml' ? 'Scanic ML' : 'Scanic classical';
  const t0 = performance.now();
  try {
    const res = await scanDocument(canvas, {
      mode: 'detect',
      detector,
      maxProcessingDimension: 1024,
    });
    const detectMs = performance.now() - t0;
    if (!res.success || !res.corners) {
      return {
        name, corners: null, confidence: null, detectMs,
        extractMs: 0, outputWidth: 0, outputHeight: 0,
        note: res.message || '検出できず',
      };
    }
    const corners = res.corners as Corners;
    const t1 = performance.now();
    const out = await correctPerspective(canvas, corners);
    const extractMs = performance.now() - t1;
    const ideal = predictOutputSize(corners);
    const note = out.limited ? `上限により ${ideal.width}x${ideal.height} から縮小` : '原寸で補正';
    // プレビュー用途では保持しないので即解放する。
    out.canvas.width = 0;
    out.canvas.height = 0;
    return {
      name, corners,
      confidence: res.confidence ?? res.score ?? null,
      detectMs, extractMs,
      outputWidth: out.width, outputHeight: out.height, note,
    };
  } catch (err) {
    return {
      name, corners: null, confidence: null,
      detectMs: performance.now() - t0, extractMs: 0,
      outputWidth: 0, outputHeight: 0,
      note: `エラー: ${(err as Error).message}`,
    };
  }
}

let jscanifyReady: Promise<any> | null = null;

/** jscanify + OpenCV.js を CDN から読み込む（チェックしたときだけ）。 */
function loadJscanify(): Promise<any> {
  if (jscanifyReady) return jscanifyReady;
  jscanifyReady = new Promise((resolve, reject) => {
    const cv = document.createElement('script');
    cv.src = 'https://docs.opencv.org/4.7.0/opencv.js';
    cv.onerror = () => reject(new Error('OpenCV.js の読み込みに失敗'));
    cv.onload = () => {
      const w = window as any;
      const ready = () => {
        const js = document.createElement('script');
        js.src = 'https://cdn.jsdelivr.net/npm/jscanify@1.4.3/src/jscanify.min.js';
        js.onerror = () => reject(new Error('jscanify の読み込みに失敗'));
        js.onload = () => resolve(new w.jscanify());
        document.head.appendChild(js);
      };
      if (w.cv?.Mat) ready();
      else w.cv.onRuntimeInitialized = ready;
    };
    document.head.appendChild(cv);
  });
  return jscanifyReady;
}

async function runJscanify(canvas: HTMLCanvasElement): Promise<Trial> {
  const name = 'jscanify (OpenCV.js)';
  const t0 = performance.now();
  try {
    const scanner = await loadJscanify();
    // jscanify も検出は縮小画像で十分なので、条件を Scanic と揃える。
    const maxSide = 1024;
    const scale = Math.min(1, maxSide / Math.max(canvas.width, canvas.height));
    const small = document.createElement('canvas');
    small.width = Math.round(canvas.width * scale);
    small.height = Math.round(canvas.height * scale);
    small.getContext('2d')!.drawImage(canvas, 0, 0, small.width, small.height);

    const contour = scanner.findPaperContour((window as any).cv.imread(small));
    const detectMs = performance.now() - t0;
    if (!contour) {
      small.width = 0; small.height = 0;
      return {
        name, corners: null, confidence: null, detectMs,
        extractMs: 0, outputWidth: 0, outputHeight: 0, note: '検出できず',
      };
    }
    const c = scanner.getCornerPoints(contour);
    small.width = 0; small.height = 0;
    if (!c?.topLeftCorner) {
      return {
        name, corners: null, confidence: null, detectMs,
        extractMs: 0, outputWidth: 0, outputHeight: 0, note: '四隅を取得できず',
      };
    }
    // 縮小画像の座標を原寸へ戻す。
    const back = (p: any) => ({ x: p.x / scale, y: p.y / scale });
    const corners: Corners = {
      topLeft: back(c.topLeftCorner),
      topRight: back(c.topRightCorner),
      bottomRight: back(c.bottomRightCorner),
      bottomLeft: back(c.bottomLeftCorner),
    };

    const t1 = performance.now();
    const out = await correctPerspective(canvas, corners);
    const extractMs = performance.now() - t1;
    const w = out.width, h = out.height;
    out.canvas.width = 0; out.canvas.height = 0;
    return {
      name, corners, confidence: null, detectMs, extractMs,
      outputWidth: w, outputHeight: h,
      note: '補正は Scanic 側で実施（検出のみ比較）',
    };
  } catch (err) {
    return {
      name, corners: null, confidence: null,
      detectMs: performance.now() - t0, extractMs: 0,
      outputWidth: 0, outputHeight: 0,
      note: `エラー: ${(err as Error).message}`,
    };
  }
}

function memoryNote(): string {
  const mem = (performance as any).memory;
  if (!mem) return 'JS heap: 計測不可（Chromium 以外）';
  return `JS heap: ${(mem.usedJSHeapSize / 1024 / 1024).toFixed(0)} MB`;
}

function renderTrial(source: HTMLCanvasElement, trial: Trial): HTMLElement {
  const card = document.createElement('div');
  card.className = 'card';
  card.innerHTML = `
    <h3>${trial.name}</h3>
    <canvas></canvas>
    <dl>
      <dt>検出</dt><dd class="${trial.corners ? 'ok' : 'ng'}">${trial.corners ? '成功' : '失敗'}</dd>
      <dt>確度</dt><dd>${trial.confidence != null ? trial.confidence.toFixed(3) : '—'}</dd>
      <dt>検出時間</dt><dd>${trial.detectMs.toFixed(0)} ms</dd>
      <dt>補正時間</dt><dd>${trial.extractMs ? trial.extractMs.toFixed(0) + ' ms' : '—'}</dd>
      <dt>出力解像度</dt><dd>${trial.outputWidth ? `${trial.outputWidth} × ${trial.outputHeight} px` : '—'}</dd>
      <dt>備考</dt><dd>${trial.note}</dd>
    </dl>`;
  drawOverlay(source, trial.corners, card.querySelector('canvas')!);
  return card;
}

fileInput.onchange = async () => {
  const files = Array.from(fileInput.files ?? []);
  if (!files.length) return;
  resultsEl.innerHTML = '';

  for (const file of files) {
    statusEl.textContent = `${file.name} を処理中…`;
    let source;
    try {
      source = await loadImageFile(file);
    } catch (err) {
      statusEl.textContent = `${file.name}: ${(err as Error).message}`;
      continue;
    }

    const block = document.createElement('div');
    block.className = 'imgblock';
    block.innerHTML = `<h2>${file.name}</h2>
      <p class="sub">入力 ${source.width} × ${source.height} px
        （${(source.width * source.height / 1e6).toFixed(1)} MP、
        元ファイル ${(file.size / 1024 / 1024).toFixed(1)} MB、
        縮小率 ${source.scale.toFixed(3)}） / ${memoryNote()}</p>
      <div class="grid"></div>`;
    resultsEl.appendChild(block);
    const grid = block.querySelector<HTMLElement>('.grid')!;

    const trials: Trial[] = [await runScanic(source.canvas, 'classical')];
    if (useMl.checked) trials.push(await runScanic(source.canvas, 'ml'));
    if (useJscanify.checked) trials.push(await runJscanify(source.canvas));

    trials.forEach((t) => grid.appendChild(renderTrial(source.canvas, t)));
    block.querySelector('.sub')!.textContent += ` / 処理後 ${memoryNote()}`;

    // 次の画像へ進む前に元画像を解放する。
    source.canvas.width = 0;
    source.canvas.height = 0;
  }
  statusEl.textContent = '完了しました。';
};
