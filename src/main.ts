/**
 * 黒板補正さん — アプリ本体。
 *
 * 画面は 3 つだけ:
 *   start   … 写真を選ぶ
 *   edit    … 四隅を確認・調整して「補正する」
 *   result  … 高解像度プレビューと保存
 */

import './style.css';
import {
  loadImageFile,
  releaseCanvas,
  UnsupportedImageError,
  type LoadedImage,
} from './imageLoader';
import {
  correctPerspective,
  createCornerEditorAdapter,
  detectBoard,
  predictOutputSize,
} from './scanner/scannerAdapter';
import type { Corners, CornerEditorHandle } from './scanner/types';
import { downloadCanvas, formatBytes, type ExportFormat } from './exportImage';

type Screen = 'start' | 'edit' | 'result';

interface State {
  screen: Screen;
  source: LoadedImage | null;
  corners: Corners | null;
  /** 自動検出が成功したか。edit 画面の案内文の出し分けに使う。 */
  detected: boolean;
  detectMs: number;
  result: HTMLCanvasElement | null;
  resultLimited: boolean;
  format: ExportFormat;
}

const state: State = {
  screen: 'start',
  source: null,
  corners: null,
  detected: false,
  detectMs: 0,
  result: null,
  resultLimited: false,
  format: 'jpeg',
};

const app = document.getElementById('app')!;
let editor: CornerEditorHandle | null = null;

const LOCK_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>`;

/** 進行中の重い処理を隠さないためのオーバーレイ。 */
function overlay(label: string) {
  return `<div class="spinner"><div><div class="spinner__ring"></div>${label}</div></div>`;
}

function destroyEditor() {
  editor?.destroy();
  editor = null;
}

/** 元画像・補正結果を破棄する。連続処理でメモリが増え続けないようにする。 */
function releaseAll() {
  destroyEditor();
  releaseCanvas(state.source?.canvas);
  releaseCanvas(state.result);
  state.source = null;
  state.result = null;
  state.corners = null;
}

function render() {
  destroyEditor();
  if (state.screen === 'start') renderStart();
  else if (state.screen === 'edit') renderEdit();
  else renderResult();
}

/* ------------------------------------------------------------------ start */

function renderStart() {
  app.innerHTML = `
    <div class="screen">
      <div class="hero">
        <div class="hero__mark">
          <svg viewBox="0 0 100 100" aria-hidden="true">
            <rect x="10" y="22" width="80" height="56" rx="4" fill="#f4f1e8"/>
            <path d="M22 62 L44 40 L58 54 L74 38" fill="none" stroke="#2f9e6e" stroke-width="5"
                  stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
        </div>
        <h1 class="hero__title">黒板補正さん</h1>
        <p class="hero__copy">斜めに撮った黒板を、まっすぐに。</p>
        <p class="hero__lead">
          黒板・ホワイトボードの写真を、正面から撮ったように補正します。<br />
          元写真の高解像度を生かしたまま保存できます。
        </p>

        <button class="cta" id="pick" type="button">黒板の写真を選ぶ</button>
        <p class="status status--error" id="status"></p>

        <p class="privacy">${LOCK_ICON}
          <span>画像は外部へ送信されません。すべて端末内で処理されます。</span>
        </p>
      </div>
      <p class="footer">オープンソースの <a href="https://github.com/marquaye/scanic" rel="noopener">scanic</a> を利用しています。</p>
      <input type="file" id="file" accept="image/jpeg,image/png,image/webp,image/*" hidden />
    </div>`;

  const input = app.querySelector<HTMLInputElement>('#file')!;
  app.querySelector<HTMLButtonElement>('#pick')!.onclick = () => input.click();
  input.onchange = () => {
    const file = input.files?.[0];
    if (file) void handleFile(file);
  };
}

async function handleFile(file: File) {
  const status = app.querySelector<HTMLElement>('#status');
  const hero = app.querySelector<HTMLElement>('.hero');
  if (status) status.textContent = '';
  if (hero) hero.insertAdjacentHTML('beforeend', overlay('写真を読み込んでいます…'));

  try {
    releaseAll();
    const source = await loadImageFile(file);
    state.source = source;

    const detection = await detectBoard(source.canvas, 'classical');
    state.corners = detection.corners;
    state.detected = detection.success;
    state.detectMs = detection.elapsedMs;
    state.screen = 'edit';
    render();
  } catch (err) {
    app.querySelector('.spinner')?.remove();
    const message =
      err instanceof UnsupportedImageError
        ? err.message
        : '写真を読み込めませんでした。別の写真を試してください。';
    const el = app.querySelector<HTMLElement>('#status');
    if (el) el.textContent = message;
  }
}

/* ------------------------------------------------------------------- edit */

function renderEdit() {
  const source = state.source!;
  const hint = state.detected
    ? '自動で四隅を検出しました。ずれていれば、白い丸を指でドラッグして合わせてください。'
    : '自動検出できませんでした。白い丸を指でドラッグして、黒板の四隅に合わせてください。';

  app.innerHTML = `
    <div class="screen">
      <div class="workhead">
        <h2 class="workhead__title">四隅を合わせる</h2>
        <p class="workhead__hint">${source.width} × ${source.height} px</p>
      </div>
      <div class="stage" id="stage" style="aspect-ratio: ${source.width} / ${source.height}"></div>
      <p class="status${state.detected ? '' : ' status--warn'}" id="status">${hint}</p>
      <div class="actions">
        <button class="btn" id="back" type="button">写真を選び直す</button>
        <button class="btn" id="reset" type="button">四隅をリセット</button>
        <button class="btn btn--primary" id="apply" type="button">補正する</button>
      </div>
      <p class="privacy">${LOCK_ICON}
        <span>画像は外部へ送信されません。すべて端末内で処理されます。</span>
      </p>
    </div>`;

  const stage = app.querySelector<HTMLElement>('#stage')!;
  editor = createCornerEditorAdapter({
    container: stage,
    image: source.canvas,
    corners: state.corners!,
    onChange: (corners) => {
      state.corners = corners;
    },
  });

  app.querySelector<HTMLButtonElement>('#back')!.onclick = () => {
    releaseAll();
    state.screen = 'start';
    render();
  };
  app.querySelector<HTMLButtonElement>('#reset')!.onclick = () => {
    editor?.reset();
    state.corners = editor?.getCorners() ?? state.corners;
  };
  app.querySelector<HTMLButtonElement>('#apply')!.onclick = () => void applyCorrection();
}

async function applyCorrection() {
  const source = state.source!;
  const corners = editor?.getCorners() ?? state.corners!;
  state.corners = corners;

  const stage = app.querySelector<HTMLElement>('#stage')!;
  stage.insertAdjacentHTML('beforeend', overlay('補正しています…'));
  // オーバーレイを描画させてから重い処理に入る。
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

  try {
    releaseCanvas(state.result);
    const result = await correctPerspective(source.canvas, corners);
    state.result = result.canvas;
    state.resultLimited = result.limited;
    state.screen = 'result';
    render();
  } catch {
    app.querySelector('.spinner')?.remove();
    const el = app.querySelector<HTMLElement>('#status');
    if (el) {
      el.className = 'status status--error';
      el.textContent =
        '補正できませんでした。四隅の位置を少し変えて、もう一度お試しください。';
    }
  }
}

/* ----------------------------------------------------------------- result */

function renderResult() {
  const source = state.source!;
  const result = state.result!;
  const ideal = predictOutputSize(state.corners!);

  const limitNote = state.resultLimited
    ? `<br />ブラウザの上限を超えるため、${ideal.width} × ${ideal.height} px から縮小しました。`
    : '';

  app.innerHTML = `
    <div class="screen">
      <div class="workhead">
        <h2 class="workhead__title">補正しました</h2>
        <p class="workhead__hint">${result.width} × ${result.height} px</p>
      </div>
      <div class="stage preview" id="stage" style="aspect-ratio: ${result.width} / ${result.height}"></div>
      <p class="meta">
        元の写真 ${source.width} × ${source.height} px →
        補正後 <strong>${result.width} × ${result.height} px</strong>${limitNote}
      </p>
      <div class="formats">
        <label><input type="radio" name="fmt" value="jpeg" ${state.format === 'jpeg' ? 'checked' : ''} />JPEG（高品質）</label>
        <label><input type="radio" name="fmt" value="png" ${state.format === 'png' ? 'checked' : ''} />PNG（無劣化）</label>
      </div>
      <div class="actions">
        <button class="btn" id="readjust" type="button">四隅を再調整</button>
        <button class="btn" id="restart" type="button">最初からやり直す</button>
        <button class="btn btn--primary" id="save" type="button">保存する</button>
      </div>
      <p class="status" id="status"></p>
      <p class="privacy">${LOCK_ICON}
        <span>画像は外部へ送信されません。すべて端末内で処理されます。</span>
      </p>
    </div>`;

  // 大きな canvas をそのまま DOM に置くとメモリを二重に持つため、表示は
  // canvas 要素を直接使う（コピーを作らない）。
  app.querySelector<HTMLElement>('#stage')!.appendChild(result);

  app.querySelectorAll<HTMLInputElement>('input[name="fmt"]').forEach((input) => {
    input.onchange = () => {
      state.format = input.value as ExportFormat;
    };
  });

  app.querySelector<HTMLButtonElement>('#readjust')!.onclick = () => {
    // 元画像と四隅は保持したまま編集へ戻る（非破壊）。
    state.screen = 'edit';
    render();
  };
  app.querySelector<HTMLButtonElement>('#restart')!.onclick = () => {
    releaseAll();
    state.screen = 'start';
    render();
  };
  app.querySelector<HTMLButtonElement>('#save')!.onclick = () => void save();
}

async function save() {
  const status = app.querySelector<HTMLElement>('#status')!;
  const button = app.querySelector<HTMLButtonElement>('#save')!;
  button.disabled = true;
  status.className = 'status';
  status.textContent = '書き出しています…';
  try {
    const { blob, fileName } = await downloadCanvas(
      state.result!,
      state.source!.fileName,
      state.format
    );
    status.textContent = `${fileName}（${formatBytes(blob.size)}）を保存しました。`;
  } catch {
    status.className = 'status status--error';
    status.textContent = '保存できませんでした。もう一度お試しください。';
  } finally {
    button.disabled = false;
  }
}

render();
