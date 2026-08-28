# 黒板補正さん

**斜めに撮った黒板を、まっすぐに。**

黒板・ホワイトボードの写真を、正面から撮ったように補正する静的 Web ツールです。
元写真の高解像度を生かしたまま保存できます。

> 画像は外部へ送信されません。すべて端末内で処理されます。

## 使い方

1. 黒板の写真を選ぶ
2. 四隅を確認する（自動検出。ずれていれば指でドラッグして調整）
3. 「補正する」
4. JPEG（高品質）または PNG（無劣化）で保存

## 設計方針

### 高解像度の維持

検出は縮小画像（最大辺 1024px）で行いますが、**透視補正は必ず原寸画像に対して**
実行します。検出された四隅は原寸画像の座標系へ復元されるため、出力解像度は
検出処理の解像度に影響されません。

```
元画像 (4032x3024)
  ├→ 検出用コピーのみ縮小 (1024px) → 四隅検出 → 原寸座標へ復元
  └→ 原寸画像に Perspective Transform → 高解像度画像を書き出し
```

実測（Chromium, 合成 12MP 画像）:

| 入力 | 検出 | 補正 | 出力 |
|---|---|---|---|
| 4032 × 3024 (12.2MP) | 500ms | 1.7s | 3557 × 2208 (7.9MP) |
| 3024 × 4032 (12.2MP, 縦) | 286ms | 646ms | 2457 × 2688 (6.6MP) |

出力が入力より小さいのは、黒板が写真の一部を占めるためです。四隅の実ピクセル
距離がそのまま出力サイズになるので、不要な縮小は発生していません。

### メモリ上限

透視補正 1 回につき原寸の RGBA バッファが複数同時に確保されるため、
スマートフォンでのクラッシュを避ける上限を設けています。値と理由は
`src/imageLoader.ts` の `MAX_INPUT_PIXELS` / `MAX_OUTPUT_PIXELS` に
コメントとして明記しています。通常のスマートフォン写真（12MP 前後）では
どちらの上限にも達しないため、縮小は一切発生しません。

連続処理でメモリが増え続けないことは確認済みです（12MP を 6 回連続処理して
JS heap 93.6MB で横ばい）。

### 自動検出を前提にしない

黒板は「壁との色差が小さい」「角が画面外」「掲示物が多い」など自動検出が
難しいケースが多くあります。そのため:

- 検出の確度が低い場合・形状が黒板としてありえない場合は、検出失敗として扱う
- 検出に失敗しても、画像の少し内側に初期四隅を置いて手動調整へ倒す
- 手動 4 点指定は非常用機能ではなく、主要機能として扱う

判定条件は `src/scanner/scannerAdapter.ts` の `isPlausibleBoard()` にあります。

## 採用技術

- **[scanic](https://github.com/marquaye/scanic) v1.6 (MIT)** — 四隅検出、
  透視変換、Corner Editor（タッチ操作・拡大ルーペ込み）
- **Vite + TypeScript（バニラ、フレームワークなし）**

Canny / findContours / polygon approximation / perspective transform /
corner editor / touch drag / magnifier は、いずれも scanic の実装を使っています。
自作していません。

### 採用しなかったもの

- **jscanify** — OpenCV.js に依存し、`node_modules` で約 30MB。
  学校の回線でスマートフォンから開く用途には重すぎます。Corner Editor と
  ルーペも自前実装が必要になります。検出比較のため、ラボページからのみ
  CDN 経由で読み込めます。
- **Nitidoc** — AGPL-3.0 のため、MIT である本プロジェクトへコードは
  流用していません。UX とアーキテクチャの参考のみ。
- **OpenCV.js の直接利用** — scanic で足りているため不要。

### ライブラリ依存の隔離

アプリ本体は `src/scanner/scannerAdapter.ts` の関数（`detectBoard`,
`correctPerspective`, `createCornerEditorAdapter` など）だけを呼びます。
scanic の API はこのファイルの外に出ません。差し替える場合の変更範囲は
このファイルに閉じます。

## 対応画像形式

JPEG / PNG / WebP。EXIF Orientation は
`createImageBitmap(file, { imageOrientation: 'from-image' })` で適用します
（EXIF パーサは自作していません）。

HEIC / HEIF は Safari 以外でデコードできず、対応には数 MB の wasm デコーダが
必要になるため、初版では非対応とし、案内を表示します。

## 開発

```bash
npm install
npm run dev      # http://localhost:5173/
npm run build    # tsc --noEmit + vite build → dist/
```

### 検出比較ラボ

`/dev/lab.html` で、同じ写真に対して Scanic classical / Scanic ML /
jscanify を並べて比較できます（写真は端末内でのみ処理されます）。

## 公開

`main` への push で GitHub Actions が `dist/` を GitHub Pages へ配置します
(`.github/workflows/deploy.yml`)。バックエンド・データベース・外部画像処理 API は
一切使用していません。

## ライセンス

MIT
