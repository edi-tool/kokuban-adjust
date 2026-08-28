# kokuban-adjust

斜めから撮った黒板・ホワイトボードの写真を、高解像度のまま正面から見た長方形へ補正するツール。
学校教員がスマートフォンで使うことを想定。
公開URL: https://edi-tool.github.io/kokuban-adjust/ （GitHub Pages）

## 実行コマンド

- プレビュー: `python -m http.server 8000`
- 整形: `npx prettier --write .`

ビルド工程はない。`index.html` をそのまま GitHub Pages が配信する。
ローカルプレビューでは Jekyll のフロントマターがページ上部に文字列として
見えるが、公開時は Jekyll が除去するため問題ない（他ツールと同じ挙動）。

## プロジェクト方針

- ビルドなしの Vanilla JS（ES Modules）。バンドラ・トランスパイラを導入しない。
- JS ライブラリは原則不使用。例外は `lib/scanic.js`（MIT）のみで、四隅検出・
  透視変換・Corner Editor（タッチ操作・拡大ルーペ）を担う。npm ではなく
  ビルド済み ESM を `lib/` にベンダリングして読み込む。
  Canny / findContours / polygon approximation / perspective transform /
  corner editor / touch drag / magnifier を自作しない。
- scanic の API はアプリ本体から直接呼ばない。必ず `js/scanner-adapter.js`
  越しに呼び、差し替え時の変更範囲をこの 1 ファイルに閉じる。
- **最終的な透視補正は必ず原寸画像に対して行う。** 検出用の縮小は可、
  補正結果の縮小は不可。縮小画像を `correctPerspective` に渡さない。
- メモリ上限（`MAX_INPUT_PIXELS` / `MAX_OUTPUT_PIXELS`）を変更するときは、
  値だけでなく**理由のコメントも必ず更新**する。勝手に品質を落とさない。
- 画像を外部送信しない設計を崩さない。
- 自動検出は前提にしない。検出失敗時も手動 4 点指定で最後まで完了できること。
  手動指定は非常用ではなく主要機能。
- デザインは全ツール共通のトークン（背景 #f8f6f2 / アクセント #f28c06 ほか）で統一。
- 軽微な修正での push 禁止。ローカルサーバーで検証し、複数修正を1コミットに集約
  （GitHub Actions 節約）。
- セッション終了時に `progress.md` を更新。

## 検証

`lab.html`（noindex）で、同じ写真に対し Scanic classical / Scanic ML /
jscanify を並べて比較できる。四隅・確度・処理時間・出力解像度を表示する。
