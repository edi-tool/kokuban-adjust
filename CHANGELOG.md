# Changelog

このプロジェクトの主な変更を記録します。形式は [Keep a Changelog](https://keepachangelog.com/ja/1.1.0/)、
バージョンは [Semantic Versioning](https://semver.org/lang/ja/) に従います。
1.x 以前の履歴は、この CHANGELOG を作成した時点で Git の履歴からまとめ直したものです。

## [Unreleased]

### Added

- テスト（`npm test`）と HTML 静的チェック（`npm run check`）、GitHub Actions の CI
- README に「データの扱い」・画面例・関連ツールを追記

### Changed

- 開発用ファイル（CLAUDE.md・progress.md・tests など）を GitHub Pages の公開ビルドから除外

### Fixed

- README の検出解像度の記載（1024px）を実装（1600px）に合わせた

## [1.3.0] - 2026-09-25

### Added

- PC で写真のドラッグ＆ドロップと貼り付けに対応
- 共有用 OGP 画像

### Changed

- 微調整パネルを写真の下に移し、スマートフォンで右上の角を操作できるように
- SEO：タイトルをキーワード先頭に、構造化データを拡充、og:site_name を追加

## [1.2.0] - 2026-08-31

### Changed

- 四隅検出・手動調整・出力形状を改善

### Removed

- 出力後の回転・縦横入替

## [1.1.0] - 2026-08-29

### Added

- 四隅編集の虫眼鏡・微調整、縦横比の境界ドラッグ

### Changed

- 検出解像度を 1024px から 1600px に変更（四隅のずれを改善）
- 開始画面のボタンの主従を入れ替え、縦横比プリセットを横長中心に

### Fixed

- 縦横比 UI の不具合 2 件、数値入力のデバウンス

## [1.0.0] - 2026-08-28

- 初回公開：黒板・ホワイトボード写真の四隅検出と透視補正、JPEG / PNG 保存
