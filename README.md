# 黒板・ホワイトボード写真の傾き補正ツール

斜めから撮った黒板・ホワイトボードの写真を、正面から撮ったような長方形に補正するツールです。

https://edi-tool.github.io/kokuban-adjust/

## 概要

授業中・授業後にスマートフォンで斜めから撮った黒板やホワイトボードの写真を、
台形のゆがみを取り除いて正面から見た長方形に補正します。
元写真の高解像度を生かしたまま保存できます。

処理はすべてブラウザ内で完結し、**画像は外部へ送信されません**。
児童生徒や氏名、授業内容が写り込んでいても、端末の外に出ることはありません。

## 使い方

1. 黒板の写真を選ぶ
2. 四隅を確認する（自動検出されます。ずれていれば指でドラッグして調整）
   - 「元に戻す」で 1 つ前の四隅へ、「リセット」で検出直後の四隅へ戻せます
   - 黒板が写真いっぱいに写っているときは「写真全体」から内側へ寄せられます
3. 「補正する」
4. 必要なら縦横比を整える（プリセット / カスタム / 画像の境界をドラッグ）
5. JPEG（高品質）または PNG（無劣化）で保存

## 使用技術

- **Frontend**: HTML5, CSS3
- **Scripting**: Vanilla JavaScript (ES Modules / ビルド工程なし)
- **画像処理**: [scanic](https://github.com/marquaye/scanic) v1.6.0 (MIT)

## 仕様について

### 1. 高解像度の維持

単に長方形へ変形できればよいのではなく、元写真の解像度を保つことを最重要要件と
しています。四隅の自動検出は縮小画像（最大辺 1024px）で行いますが、
**透視補正は必ず原寸画像に対して**実行します。検出された四隅は原寸画像の
座標系へ復元されるため、出力解像度は検出処理の解像度に影響されません。

```
元画像 (4032 × 3024)
  ├─ 検出用コピーのみ縮小 (1024px) → 四隅検出 → 原寸座標へ復元
  └─ 原寸画像に Perspective Transform → 高解像度画像を書き出し
```

実測（Chromium、合成の 12MP 画像）:

| 入力              | 検出  | 補正  | 出力        |
| ----------------- | ----- | ----- | ----------- |
| 4032 × 3024       | 372ms | 511ms | 3557 × 2208 |
| 3024 × 4032（縦） | 278ms | 461ms | 2457 × 2688 |

出力が入力より小さいのは、黒板が写真の一部を占めるためです。四隅の実ピクセル
距離がそのまま出力サイズになるので、不要な縮小は発生していません。

透視変換では画素の補間が発生するため、厳密な無劣化ではありません。
不要な縮小・再圧縮をしない、という方針です。JPEG は品質 0.92 固定、
PNG は無劣化で書き出します。

### 2. メモリの上限

透視補正 1 回につき、原寸の RGBA バッファが複数同時に確保されます。
スマートフォンでのクラッシュを避けるため上限を設けています。値と理由は
`js/image-loader.js` の `MAX_INPUT_PIXELS`（40MP）と
`js/scanner-adapter.js` の `MAX_OUTPUT_PIXELS`（16.7MP、iOS Safari の
canvas 面積上限）にコメントとして明記しています。

一般的なスマートフォン写真（12MP 前後）ではどちらの上限にも達しないため、
縮小は一切発生しません。上限に達した場合は、何 px から縮小したかを画面に表示します。

### 3. 自動検出を前提にしない

黒板は「壁との色差が小さい」「角が画面外にある」「掲示物が多い」など、
自動検出が難しい条件が揃いやすい被写体です。そのため:

- 確度が低い場合や、黒板としてありえない形（細長い / 小さすぎる / 辺が
  交差している）の場合は検出失敗として扱う
- 検出に失敗しても、画像の少し内側に初期四隅を置いて手動調整へ移る
- ただし「形は黒板としてありえるが確度が足りない」候補があれば、採用はせず
  手動調整の出発点としてだけ使う（一律の長方形より合わせ直す距離が短い）
- 手動 4 点指定は非常用機能ではなく、主要機能として扱う

判定条件は `js/scanner-adapter.js` の `hasBoardShape()` と
`isConvexQuad()` にあります。

### 4. 対応画像形式

JPEG / PNG / WebP に対応しています。EXIF Orientation は
`createImageBitmap` の `imageOrientation: 'from-image'` で適用します。

HEIC / HEIF は Safari 以外のブラウザでデコードできず、対応には数 MB の
wasm デコーダが必要になるため、初版では非対応とし、案内を表示します。
iPhone では「設定 → カメラ → フォーマット」を「互換性優先」にすると
JPEG で撮影できます。

## 開発

```bash
python -m http.server 8000   # プレビュー
npx prettier --write .       # 整形
```

ビルド工程はありません。`index.html` をそのまま GitHub Pages が配信します。

### GitHub Pages の有効化（初回のみ・手動）

新規リポジトリでは GitHub Pages は自動で有効になりません。公開前に、
リポジトリの **Settings → Pages** で以下を設定してください（管理者権限が必要）。

- Build and deployment → Source: **Deploy from a branch**
- Branch: **main** / **/(root)**

保存すると Jekyll のビルドが走り、数分で https://edi-tool.github.io/kokuban-adjust/
が閲覧できるようになります。有効化されているかは、Actions タブに
`pages build and deployment`（`page_build` イベント）の実行履歴があるかで確認できます。

`lab.html` で、同じ写真に対して Scanic classical / Scanic ML / jscanify を
並べて比較できます（開発用、検索対象外）。

## 参考文献 / References

### 画像処理

- [marquaye/scanic](https://github.com/marquaye/scanic) (MIT)
  - 四隅検出、透視変換、Corner Editor（タッチ操作・拡大ルーペ）に使用
  - ライセンス全文は `lib/LICENSE.scanic`
- [puffinsoft/jscanify](https://github.com/puffinsoft/jscanify) (MIT)
  - 検出精度の比較対象（`lab.html` からのみ利用）
- [santiagoisra/nitidoc](https://github.com/santiagoisra/nitidoc) (AGPL-3.0)
  - スマートフォン UX と非破壊編集の設計を参考にしたのみ。コードは流用していません

### デザイン

- [kzhrknt/awesome-design-md-jp](https://github.com/kzhrknt/awesome-design-md-jp)
  - 本ツールのデザインの参考

---

© 2026 ISHIKAWA, Natsuki
