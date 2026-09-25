# kokuban-adjust

斜めから撮った黒板・ホワイトボードの写真を長方形に補正するブラウザツール。公開URL: https://edi-tool.github.io/kokuban-adjust/
詳しい方針は CLAUDE.md、共通方針は [edi-tool 開発原則](https://github.com/edi-tool/.github/blob/main/PRINCIPLES.md)。

## 実行コマンド

- プレビュー: `python -m http.server 8000`
- テスト: `npm test`（Node.js 22 以上、依存なし）
- HTML 静的チェック: `npm run check`

## 守ること

- 画像を外部送信しない。本体（app.js / image-loader.js / scanner-adapter.js）に URL・fetch を入れない（テストで確認）。
- `MAX_INPUT_PIXELS` / `MAX_OUTPUT_PIXELS` / `DETECT_MAX_DIMENSION` を変えたら、コードのコメント・README・テストを同時に更新する。
- `scripts/check-static.mjs` は edi-tool/.github の templates からのコピー。直すときは原本も直す。
- 軽微な修正での push 禁止。複数修正をまとめてから push する。
