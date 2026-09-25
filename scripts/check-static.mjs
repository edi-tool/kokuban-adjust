#!/usr/bin/env node
// 静的サイト共通チェック（依存ゼロ）。原本: edi-tool/.github/templates/scripts/check-static.mjs
// 各リポジトリへは同一内容をコピーして使う。修正は原本に入れてから配る。
//
// 検査内容（ルート直下の *.html）
//   - <html lang="ja">、viewport、<title> があること
//   - <img> に alt 属性があること（装飾画像は alt="" でよい）
//   - 外部スクリプト・スタイルシートが許可ホストからのみ読み込まれ、バージョンが固定されていること
//   - 相対パスで参照しているローカルファイルが存在すること
// 失敗は終了コード 1。description 欠落などの推奨事項は警告のみ。
// Jekyll の front matter（--- ... ---）と {{ page.xxx }} は front matter の値で展開してから検査する。
// 既知の例外は package.json の "checkStatic": { "ignore": ["viewport"] } で理由とともに明示する。
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = process.cwd();
const ALLOWED_HOSTS = ['cdn.jsdelivr.net', 'cdnjs.cloudflare.com'];
// Search Console の所有権確認ファイルなどは対象外
const SKIP = /^google[0-9a-f]+\.html$/;

const errors = [];
const warnings = [];

export function expandFrontMatter(html) {
  const fm = html.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
  if (!fm) return html;
  const vars = {};
  for (const line of fm[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z_]+):\s*(.*)$/);
    if (kv) vars[kv[1]] = kv[2].replace(/^["']|["']$/g, '');
  }
  return html.slice(fm[0].length).replace(/\{\{\s*page\.([A-Za-z_]+)\s*\}\}/g, (_, k) => vars[k] ?? '');
}

export function checkHtml(name, rawHtml, { exists = (p) => existsSync(join(ROOT, p)), ignore = [] } = {}) {
  const html = expandFrontMatter(rawHtml);
  const err = (m, id) => (ignore.includes(id) ? warnings : errors).push(`${name}: ${m}${ignore.includes(id) ? '（package.json で除外中）' : ''}`);
  const warn = (m) => warnings.push(`${name}: ${m}`);

  if (!/<html[^>]*\blang=["']ja["']/i.test(html)) err('<html lang="ja"> がありません', 'lang');
  if (!/<meta[^>]+name=["']viewport["']/i.test(html)) err('viewport の meta がありません', 'viewport');
  if (!/<title>[^<]+<\/title>/i.test(html)) err('<title> が空か、ありません', 'title');
  if (!/<meta[^>]+name=["']description["']/i.test(html)) warn('meta description がありません');

  for (const [tag] of html.matchAll(/<img\b[^>]*>/gi)) {
    if (!/\balt=/i.test(tag)) err(`alt のない <img>: ${tag.slice(0, 80)}`, 'img-alt');
  }

  // <script src> と <link href>（stylesheet / modulepreload のみ）
  const refs = [];
  for (const m of html.matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["']/gi)) refs.push(m[1]);
  for (const m of html.matchAll(/<link\b[^>]*>/gi)) {
    if (!/rel=["'](stylesheet|modulepreload|icon|manifest|apple-touch-icon)["']/i.test(m[0])) continue;
    const href = m[0].match(/href=["']([^"']+)["']/i);
    if (href) refs.push(href[1]);
  }
  // インラインの import('https://...') も外部依存として扱う
  for (const m of html.matchAll(/import\(\s*["'](https?:\/\/[^"']+)["']/g)) refs.push(m[1]);

  for (const ref of refs) {
    if (/^https?:\/\//.test(ref)) {
      const url = new URL(ref);
      if (url.hostname === 'fonts.googleapis.com') continue; // Google Fonts はスタイルのみ
      if (!ALLOWED_HOSTS.includes(url.hostname)) err(`許可されていない外部ホスト: ${ref}`, 'external-host');
      else if (url.hostname === 'cdn.jsdelivr.net' && !/\/npm\/(@[^/]+\/)?[^/@]+@\d[^/]*\//.test(url.pathname)) {
        err(`CDN のバージョンが固定されていません: ${ref}`, 'cdn-version');
      }
    } else if (!/^(data:|#|\/\/)/.test(ref)) {
      const path = decodeURI(ref.split(/[?#]/)[0]).replace(/^\.\//, '');
      if (path && !path.startsWith('/') && !exists(path)) err(`参照先のファイルがありません: ${ref}`, 'local-ref');
    }
  }
}

function main() {
  const files = readdirSync(ROOT).filter((f) => f.endsWith('.html') && !SKIP.test(f));
  if (files.length === 0) {
    console.error('HTML ファイルが見つかりません');
    process.exit(1);
  }
  let ignore = [];
  if (existsSync(join(ROOT, 'package.json'))) {
    ignore = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).checkStatic?.ignore ?? [];
  }
  for (const f of files) checkHtml(f, readFileSync(join(ROOT, f), 'utf8'), { ignore });
  for (const w of warnings) console.warn(`警告: ${w}`);
  for (const e of errors) console.error(`エラー: ${e}`);
  console.log(`check-static: ${files.length} ファイル、エラー ${errors.length} 件、警告 ${warnings.length} 件`);
  process.exit(errors.length ? 1 : 0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
