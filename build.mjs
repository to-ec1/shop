/**
 * ============================================================
 * build.mjs — テイクオンストア AI-SEO静的ビルドスクリプト
 * ============================================================
 *
 * 【役割】
 *   GAS API(PRODUCTS_API_URL)から商品データを取得し、index.html の
 *   商品グリッドを「実テキストとして描画済みの静的HTML」に焼き込む。
 *   あわせてJSON-LD(schema.org Product/Offer)、robots.txt、
 *   sitemap.xml、llms.txt を生成する。
 *
 *   目的: JavaScriptを実行しないAIクローラー(ChatGPT/Perplexity/Claude等の
 *   ブラウジング機能を含む)に対しても、商品名・価格・在庫状況が
 *   最初からHTMLの可視テキストとして読める状態にすること。
 *
 * 【設計方針(2026-07-15時点で決定・README.md参照)】
 *   - ユーザー体験は変えない: このスクリプトが焼き込むのはあくまで
 *     「初期表示・クローラー向け」の静的HTML。表示後は従来通りJSが
 *     PRODUCTS_API_URLを叩いて最新在庫に更新する。
 *   - フェイルセーフ: ライブfetchが失敗した場合、クライアント側JSは
 *     このスクリプトが焼き込んだ静的HTMLを上書きしない(index.html側の
 *     init()ロジック参照)。
 *   - 非表示<script>タグへのJSON埋め込みだけでは不十分(多くのAI
 *     クローラー/テキスト抽出ツールはscript/styleの中身を除去するため)。
 *     商品名・価格などの本文は可視HTML要素(div/h3/p)として書き出す。
 *   - JSON-LD(<script type="application/ld+json">)は例外として扱われる
 *     標準形式なので、そのまま使用する。
 *
 * 【9列スキーマ移行(2026-07-15)に伴う変更点・重要】
 *   - GAS(Code.gs)側で画像列(Driveファイル ID / Drive共有URL / 直接URLの
 *     いずれか)を正規化し、doGetのレスポンスの `image` フィールドに
 *     「そのまま<img src>に使える直接URL」を入れて返すよう変更された。
 *   - そのため、このファイルが独自に持っていた driveImageUrl()
 *     (fileId→URL変換関数)は廃止。build.mjs側では変換ロジックを持たず、
 *     API が返す product.image をそのまま使う(ロジックの重複・二重実装に
 *     よるズレを防ぐため。変換ルールを変えたい場合はCode.gs側のみ直せば
 *     良い設計にしてある)。
 *   - product.jan は Code.gs 側で JAN1優先・無ければJAN2で解決済みの
 *     値がそのまま入っている(jan1 / jan2 個別フィールドも参考情報として
 *     渡ってくるが、表示・リンクにはjanを使う)。
 *   - product.description(概要列)が新規追加。JSON-LDのdescriptionと
 *     llms.txtに反映する。商品カード自体には現状表示しない(2列グリッドの
 *     省スペース性を優先。カードクリックで詳細を見る導線は未実装)。
 *
 * 【実行方法】
 *   PRODUCTS_API_URL=https://script.google.com/macros/s/XXXX/exec node build.mjs
 *
 * 【前提】
 *   - GAS doGet() のレスポンス形式:
 *     { ok: true, products: [{ jan, jan1, jan2, name, description, price, stock, image, category }] }
 *   - index.html に以下のマーカーが存在すること(手動で消さないこと):
 *     <!-- SSR:JSONLD:START --> ... <!-- SSR:JSONLD:END -->
 *     <!-- SSR:PRODUCTS:START --> ... <!-- SSR:PRODUCTS:END -->
 *     // SSR:FALLBACK:START ... // SSR:FALLBACK:END
 *
 * 【エラー時の挙動(重要)】
 *   PRODUCTS_API_URL未設定、fetch失敗、レスポンス不正のいずれの場合も、
 *   index.html等は一切書き換えずに exit(1) する。
 *   「取得できなかったので空にする」という上書きは絶対に行わない
 *   (既存の静的コンテンツを壊さないため)。
 * ============================================================
 */

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const SITE_ORIGIN = "https://shop.takeon.cc";
const INDEX_PATH = path.resolve("index.html");
const ROBOTS_PATH = path.resolve("robots.txt");
const SITEMAP_PATH = path.resolve("sitemap.xml");
const LLMS_PATH = path.resolve("llms.txt");

// APIがimageを返さなかった場合のフォールバック(通常はCode.gs側で
// 常にプレースホルダURLまで含めて返すため使われない想定だが、念のため用意)
const IMAGE_PLACEHOLDER_FALLBACK = "https://placehold.co/500x500/e3dbc9/2d3a24?text=No+Image";

function log(msg) {
  console.log(`[build.mjs] ${msg}`);
}

function logError(msg) {
  console.error(`[build.mjs] ❌ ${msg}`);
}

function escapeHtml(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapeJsSingleQuote(str) {
  // onclick="addToCart('...')" の中に安全に埋め込むため
  return String(str ?? "").replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

async function fetchProducts(apiUrl) {
  log(`商品データ取得開始: ${apiUrl}`);
  let res;
  try {
    res = await fetch(apiUrl);
  } catch (e) {
    throw new Error(`fetch自体が失敗しました: ${e.message}`);
  }
  log(`HTTPステータス: ${res.status}`);
  if (!res.ok) {
    throw new Error(`HTTPエラー: ${res.status} ${res.statusText}`);
  }
  let data;
  try {
    data = await res.json();
  } catch (e) {
    throw new Error(`レスポンスのJSONパースに失敗しました: ${e.message}`);
  }
  if (!data || data.ok !== true || !Array.isArray(data.products)) {
    throw new Error(`レスポンス形式が不正です: ${JSON.stringify(data).slice(0, 300)}`);
  }
  log(`取得成功: 商品件数 ${data.products.length}件`);
  return data.products;
}

// ============================================================
// 1商品分のカードHTML(クライアント側 renderProductGrid() の
// テンプレートと見た目・onclickハンドラを一致させる)
// ============================================================
function renderProductCardHtml(p) {
  const soldOut = Number(p.stock) <= 0;
  const jan = escapeHtml(p.jan);
  const janJs = escapeJsSingleQuote(p.jan);
  const name = escapeHtml(p.name);
  const description = escapeHtml(p.description);
  const price = Number(p.price) || 0;
  // Code.gs側で正規化済みの直接URL。念のため空の場合のみフォールバック。
  const imgUrl = escapeHtml(p.image || IMAGE_PLACEHOLDER_FALLBACK);

  return `
          <div class="bg-white rounded-[16px] border border-[#e3dbc9] overflow-hidden shadow-sm flex flex-col">
            <div class="relative aspect-square bg-[#f4efe6]">
              <img src="${imgUrl}" alt="${name}"
                class="w-full h-full object-cover"
                onerror="this.src='https://placehold.co/500x500/e3dbc9/2d3a24?text=No+Image'">
              ${soldOut ? `<div class="absolute inset-0 bg-black/50 flex items-center justify-center">
                <span class="text-white text-xs font-black tracking-wider border border-white px-3 py-1 rounded-full">SOLD OUT</span>
              </div>` : ""}
            </div>
            <div class="p-3 md:p-4 flex flex-col flex-1">
              <p class="text-[10px] text-[#6b7c5c] mb-1">JAN: ${jan}</p>
              <h3 class="text-xs md:text-sm font-bold text-[#2d3a24] leading-snug mb-2 flex-1">${name}</h3>
              ${description ? `<details class="details-desc mb-2 text-[10px] text-[#6b7c5c]">
                <summary class="cursor-pointer select-none font-bold text-[#2d3a24] flex items-center gap-1">
                  商品説明
                  <svg class="w-3 h-3 details-arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 9l6 6 6-6"/></svg>
                </summary>
                <p class="mt-1 leading-relaxed whitespace-pre-line">${description}</p>
              </details>` : ""}
              <p class="text-base md:text-lg font-black text-[#2d3a24] mb-3">¥${price.toLocaleString("ja-JP")}</p>
              <button
                onclick="addToCart('${janJs}')"
                ${soldOut ? "disabled" : ""}
                class="w-full text-xs font-bold py-2.5 rounded-[12px] transition ${soldOut ? "bg-[#e3dbc9] text-[#6b7c5c] cursor-not-allowed" : "bg-[#2d3a24] text-[#fbf9f5] hover:opacity-90"}"
              >
                ${soldOut ? "在庫切れ" : "カートに入れる"}
              </button>
            </div>
          </div>`;
}

function renderProductGridBlock(products) {
  const cards = products.map(renderProductCardHtml).join("\n");
  return `<div id="product-grid" class="grid grid-cols-2 gap-4 md:gap-6">
${cards}
        </div>`;
}

// ============================================================
// JSON-LD (schema.org ItemList / Product / Offer)
// ============================================================
function buildJsonLd(products) {
  const itemListElement = products.map((p, i) => ({
    "@type": "ListItem",
    position: i + 1,
    item: {
      "@type": "Product",
      sku: String(p.jan),
      name: String(p.name || ""),
      description: String(p.description || ""),
      category: String(p.category || "その他"),
      image: p.image || IMAGE_PLACEHOLDER_FALLBACK,
      offers: {
        "@type": "Offer",
        priceCurrency: "JPY",
        price: Number(p.price) || 0,
        availability: Number(p.stock) > 0 ? "https://schema.org/InStock" : "https://schema.org/OutOfStock",
        url: `${SITE_ORIGIN}/#jan=${encodeURIComponent(p.jan)}`,
      },
    },
  }));

  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "ItemList",
    name: "テイクオンストア 商品一覧",
    itemListElement,
  };

  // <script>タグ内に埋め込むため、商品名等に "</script>" のような文字列が
  // 含まれていてもタグが早期終了しないようエスケープする(JSON.stringifyは
  // "</" を自動エスケープしないため、ここで手動対応する)。
  const jsonLdString = JSON.stringify(jsonLd, null, 2).replace(/<\/script/gi, "<\\/script");

  return `<script type="application/ld+json">\n${jsonLdString}\n    </script>`;
}

// ============================================================
// マーカー間のブロック差し替え(該当マーカーが無ければ例外)
// ============================================================
function replaceBetweenMarkers(html, startMarker, endMarker, newContent) {
  const startIdx = html.indexOf(startMarker);
  const endIdx = html.indexOf(endMarker);
  if (startIdx === -1 || endIdx === -1 || endIdx < startIdx) {
    throw new Error(`マーカーが見つかりません: ${startMarker} ... ${endMarker}`);
  }
  const before = html.slice(0, startIdx + startMarker.length);
  const after = html.slice(endIdx);
  return `${before}\n${newContent}\n    ${after}`;
}

function buildRobotsTxt() {
  return [
    "User-agent: *",
    "Allow: /",
    "",
    `Sitemap: ${SITE_ORIGIN}/sitemap.xml`,
    "",
  ].join("\n");
}

function buildSitemapXml() {
  const today = new Date().toISOString().slice(0, 10);
  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<urlset xmlns="http://www.w3.org/1999/sitemaps/0.9">`,
    `  <url>`,
    `    <loc>${SITE_ORIGIN}/</loc>`,
    `    <lastmod>${today}</lastmod>`,
    `    <changefreq>hourly</changefreq>`,
    `  </url>`,
    `</urlset>`,
    "",
  ].join("\n");
}

function buildLlmsTxt(products) {
  const categories = [...new Set(products.map((p) => p.category || "その他"))];
  const lines = [
    "# テイクオンストア (TAKE ON Co., Ltd.)",
    "",
    "> テイクオン株式会社の直販ECサイト。雑貨・コスメ・サプリ・食品などを取り扱っています。",
    "> お支払いは銀行振込のみです。",
    "",
    `- サイトURL: ${SITE_ORIGIN}/`,
    `- 取扱カテゴリ: ${categories.join(" / ")}`,
    `- 商品点数(公開中): ${products.length}件`,
    `- 最終更新: ${new Date().toISOString()}`,
    "",
    "## 商品一覧",
    "",
    ...products.map((p) => {
      const base = `- ${p.name} (JAN: ${p.jan}) — ¥${(Number(p.price) || 0).toLocaleString("ja-JP")} — ${Number(p.stock) > 0 ? "在庫あり" : "在庫切れ"} — カテゴリ: ${p.category || "その他"}`;
      const desc = String(p.description || "").trim();
      return desc ? `${base}\n  概要: ${desc}` : base;
    }),
    "",
  ];
  return lines.join("\n");
}

// ============================================================
// メイン処理
// ============================================================
async function main() {
  log("=== ビルド開始 ===");

  const apiUrl = process.env.PRODUCTS_API_URL;
  if (!apiUrl) {
    logError("PRODUCTS_API_URL が未設定です。既存ファイルは一切変更せず終了します。");
    process.exit(1);
  }

  let products;
  try {
    products = await fetchProducts(apiUrl);
  } catch (e) {
    logError(`商品データ取得に失敗しました: ${e.message}`);
    logError("既存の index.html / robots.txt / sitemap.xml / llms.txt は変更せず終了します。");
    process.exit(1);
  }

  log("index.html 読み込み中...");
  let html;
  try {
    html = await readFile(INDEX_PATH, "utf8");
  } catch (e) {
    logError(`index.html の読み込みに失敗しました: ${e.message}`);
    process.exit(1);
  }
  log(`index.html サイズ: ${html.length} 文字`);

  try {
    const productGridBlock = renderProductGridBlock(products);
    html = replaceBetweenMarkers(html, "<!-- SSR:PRODUCTS:START", "<!-- SSR:PRODUCTS:END -->", productGridBlock);
    log("商品グリッドの静的HTML焼き込み完了");

    const jsonLdBlock = buildJsonLd(products);
    html = replaceBetweenMarkers(html, "<!-- SSR:JSONLD:START", "<!-- SSR:JSONLD:END -->", jsonLdBlock);
    log("JSON-LD焼き込み完了");

    const fallbackJson = JSON.stringify(products).replace(/<\/script/gi, "<\\/script");
    const fallbackLine = `const SSR_FALLBACK_PRODUCTS = ${fallbackJson};`;
    html = replaceBetweenMarkers(html, "// SSR:FALLBACK:START", "// SSR:FALLBACK:END", fallbackLine);
    log("フォールバック用商品データ(SSR_FALLBACK_PRODUCTS)焼き込み完了");
  } catch (e) {
    logError(`index.html への焼き込みに失敗しました: ${e.message}`);
    logError("マーカーが破損・削除されている可能性があります。index.htmlは変更せず終了します。");
    process.exit(1);
  }

  try {
    await writeFile(INDEX_PATH, html, "utf8");
    log(`index.html 書き込み完了 (${html.length} 文字)`);

    await writeFile(ROBOTS_PATH, buildRobotsTxt(), "utf8");
    log("robots.txt 書き込み完了");

    await writeFile(SITEMAP_PATH, buildSitemapXml(), "utf8");
    log("sitemap.xml 書き込み完了");

    await writeFile(LLMS_PATH, buildLlmsTxt(products), "utf8");
    log("llms.txt 書き込み完了");
  } catch (e) {
    logError(`ファイル書き込みに失敗しました: ${e.message}`);
    process.exit(1);
  }

  log(`=== ビルド正常終了(商品${products.length}件を焼き込み) ===`);
}

main().catch((e) => {
  logError(`予期しないエラー: ${e.stack || e.message}`);
  process.exit(1);
});
