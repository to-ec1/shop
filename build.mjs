/**
 * ============================================================
 * build.mjs — テイクオンストア AI-SEO静的ビルドスクリプト
 * ============================================================
 */

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const SITE_ORIGIN = "https://shop.takeon.cc";
const INDEX_PATH = path.resolve("index.html");
const ROBOTS_PATH = path.resolve("robots.txt");
const SITEMAP_PATH = path.resolve("sitemap.xml");
const LLMS_PATH = path.resolve("llms.txt");

const IMAGE_PLACEHOLDER_FALLBACK = "https://placehold.co/500x500/e3dbc9/2d3a24?text=No+Image";
const CARD_IMAGE_WIDTH = 400; // 商品カード表示用の画像幅(px)。w1000のような大きすぎるサムネイルの転送量を削減する

// Google Driveのサムネイル画像URLのみ、sz=wNNNパラメータをカード表示に必要な幅へ縮小する。
// drive.google.com/thumbnail以外のURL(placehold.co等)はそのまま通す。
function resizeDriveImage(url, width = CARD_IMAGE_WIDTH) {
  if (!url) return url;
  if (!/drive\.google\.com\/thumbnail/.test(url)) return url;
  if (/[?&]sz=/.test(url)) {
    return url.replace(/([?&]sz=)w?\d+/, `$1w${width}`);
  }
  const sep = url.includes("?") ? "&" : "?";
  return `${url}${sep}sz=w${width}`;
}

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
  return String(str ?? "").replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

// 同一JANの商品(通常品/アウトレット等のバリエーション)を1グループに束ねる。
// 各商品はcord_ne単位で独立したSKUだが、フロントでは1つのカードにまとめて選択肢として表示する。
function groupProductsByJan(products) {
  const map = new Map();
  for (const p of products) {
    const key = p.jan || p.cordNe;
    if (!map.has(key)) {
      map.set(key, { jan: p.jan, variants: [] });
    }
    map.get(key).variants.push(p);
  }
  return Array.from(map.values());
}

// グループ内の代表バリエーションを選ぶ(在庫がある最初の1件、無ければ先頭)
function pickDefaultVariant(variants) {
  return variants.find((v) => Number(v.stock) > 0) || variants[0];
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

function renderProductCardHtml(group) {
  const variants = group.variants;
  const variant = pickDefaultVariant(variants);
  const multiVariant = variants.length > 1;

  const soldOut = Number(variant.stock) <= 0;
  const jan = escapeHtml(variant.jan);
  const cordNeJs = escapeJsSingleQuote(variant.cordNe);
  const name = escapeHtml(variant.name);
  const description = escapeHtml(variant.description);
  const category = escapeHtml(variant.category || "その他");
  const price = Number(variant.price) || 0;
  const stock = Number(variant.stock) || 0;
  const imgUrl = escapeHtml(resizeDriveImage(variant.image) || IMAGE_PLACEHOLDER_FALLBACK);

  const maxPrice = Math.max(...variants.map((v) => Number(v.price) || 0));
  const discount = multiVariant && maxPrice > price ? Math.round((1 - price / maxPrice) * 100) : 0;
  const variantLabel = escapeHtml(variant.variantLabel || "通常品");

  return `
          <div class="bg-white rounded-[16px] border border-[#e3dbc9] overflow-hidden shadow-sm flex flex-col">
            <div class="relative aspect-square bg-[#f4efe6]">
              <img src="${imgUrl}" alt="${name}"
                class="w-full h-full object-cover"
                loading="lazy" decoding="async"
                onerror="this.src='https://placehold.co/500x500/e3dbc9/2d3a24?text=No+Image'">
              <span class="absolute top-1.5 right-1.5 bg-white/90 text-[#2d3a24] text-[9px] font-bold px-2 py-0.5 rounded-full shadow-sm">${category}</span>
              ${soldOut ? `<div class="absolute inset-0 bg-black/50 flex items-center justify-center">
                <span class="text-white text-xs font-black tracking-wider border border-white px-3 py-1 rounded-full">SOLD OUT</span>
              </div>` : ""}
            </div>
            <div class="p-3 md:p-4 flex flex-col flex-1">
              <p class="text-[10px] text-[#6b7c5c] mb-1">JAN: ${jan}</p>
              <h3 class="text-xs md:text-sm font-bold text-[#2d3a24] leading-snug mb-2 flex-1">${name}</h3>
              ${description ? `<details class="details-desc mb-2 text-[11px] text-[#6b7c5c]">
                <summary class="cursor-pointer select-none font-bold text-[#2d3a24] text-xs flex items-center justify-center gap-1 border border-[#e3dbc9] rounded-[10px] py-2 px-3 bg-[#f4efe6] hover:bg-[#e3dbc9] transition">
                  商品説明を見る
                  <svg class="w-3.5 h-3.5 details-arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 9l6 6 6-6"/></svg>
                </summary>
                <p class="mt-2 leading-relaxed whitespace-pre-line">${description}</p>
              </details>` : ""}
              <p class="text-base md:text-lg font-black text-[#2d3a24] mb-1">
                ${price.toLocaleString("ja-JP")}円（税込）
                ${discount > 0 ? `<span class="text-[#b5502f] text-xs font-bold ml-1">${discount}%OFF</span>` : ""}
              </p>
              <p class="text-[10px] text-[#6b7c5c] mb-3">
                ${multiVariant ? `${variantLabel} / ` : ""}${soldOut ? "在庫切れ" : `残り${stock}点`}
                ${multiVariant ? `<br>他${variants.length - 1}種類の選択肢あり` : ""}
              </p>
              <button
                onclick="addToCart('${cordNeJs}')"
                ${soldOut ? "disabled" : ""}
                class="w-full text-xs font-bold py-2.5 rounded-[12px] transition ${soldOut ? "bg-[#e3dbc9] text-[#6b7c5c] cursor-not-allowed" : "bg-[#2d3a24] text-[#fbf9f5] hover:opacity-90"}"
              >
                ${soldOut ? "在庫切れ" : "カートに入れる"}
              </button>
            </div>
          </div>`;
}

function renderProductGridBlock(products) {
  const groups = groupProductsByJan(products);
  const cards = groups.map(renderProductCardHtml).join("\n");
  return `<div id="product-grid" class="grid grid-cols-2 gap-4 md:gap-6">
${cards}
        </div>`;
}

function buildJsonLd(products) {
  const groups = groupProductsByJan(products);

  const itemListElement = groups.map((g, i) => {
    const variant = pickDefaultVariant(g.variants);
    const prices = g.variants.map((v) => Number(v.price) || 0);
    const inStock = g.variants.some((v) => Number(v.stock) > 0);

    const offers = g.variants.length > 1
      ? {
          "@type": "AggregateOffer",
          priceCurrency: "JPY",
          lowPrice: Math.min(...prices),
          highPrice: Math.max(...prices),
          offerCount: g.variants.length,
          availability: inStock ? "https://schema.org/InStock" : "https://schema.org/OutOfStock",
        }
      : {
          "@type": "Offer",
          priceCurrency: "JPY",
          price: prices[0] || 0,
          availability: Number(variant.stock) > 0 ? "https://schema.org/InStock" : "https://schema.org/OutOfStock",
          url: `${SITE_ORIGIN}/#jan=${encodeURIComponent(g.jan)}`,
        };

    return {
      "@type": "ListItem",
      position: i + 1,
      item: {
        "@type": "Product",
        sku: String(g.jan),
        name: String(variant.name || ""),
        description: String(variant.description || ""),
        category: String(variant.category || "その他"),
        image: variant.image || IMAGE_PLACEHOLDER_FALLBACK,
        offers,
      },
    };
  });

  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "ItemList",
    name: "テイクオンストア 商品一覧",
    itemListElement,
  };

  const jsonLdString = JSON.stringify(jsonLd, null, 2).replace(/<\/script/gi, "<\\/script");

  return `<script type="application/ld+json">\n${jsonLdString}\n    </script>`;
}

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
  const groups = groupProductsByJan(products);
  const categories = [...new Set(products.map((p) => p.category || "その他"))];
  const lines = [
    "# テイクオンストア (TAKE ON Co., Ltd.)",
    "",
    "> テイクオン株式会社の直販ECサイト。雑貨・コスメ・サプリ・食品などを取り扱っています。",
    "> お支払いは銀行振込のみです。",
    "",
    `- サイトURL: ${SITE_ORIGIN}/`,
    `- 取扱カテゴリ: ${categories.join(" / ")}`,
    `- 商品点数(公開中): ${groups.length}件 (バリエーション含むSKU数: ${products.length})`,
    `- 最終更新: ${new Date().toISOString()}`,
    "",
    "## 配送・お支払いについて",
    "",
    "- お支払い方法: 銀行振込のみ",
    "- 送料: 税込合計33,000円以上で送料無料。それ未満は北海道・沖縄県1,100円、それ以外の都道府県770円。",
    "- 離島への発送は対応していません。",
    "- 出荷時期: ご入金確認後3〜5営業日以内に発送。",
    "- インボイス登録番号: T2010001069107",
    "- 領収書: ご希望の方は注文時に宛名をご記入いただければ、発送後にPDFをメールでお送りします。",
    "- 表示価格はすべて税込です。",
    "",
    "## 商品一覧",
    "",
    ...groups.map((g) => {
      const variant = pickDefaultVariant(g.variants);
      const lines2 = [`- ${variant.name} (JAN: ${g.jan}) — カテゴリ: ${variant.category || "その他"}`];
      for (const v of g.variants) {
        const label = v.variantLabel || (g.variants.length > 1 ? "バリエーション" : "通常品");
        lines2.push(`  - ${label}: ¥${(Number(v.price) || 0).toLocaleString("ja-JP")} — ${Number(v.stock) > 0 ? "在庫あり" : "在庫切れ"}`);
      }
      const desc = String(variant.description || "").trim();
      if (desc) lines2.push(`  概要: ${desc}`);
      return lines2.join("\n");
    }),
    "",
  ];
  return lines.join("\n");
}

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
    // ⚠️ マーカーの「閉じタグ」まで完全に一致させて安全に置換するよう修正
    html = replaceBetweenMarkers(html, "<!-- SSR:PRODUCTS:START -->", "<!-- SSR:PRODUCTS:END -->", productGridBlock);
    log("商品グリッドの静的HTML焼き込み完了");

    const jsonLdBlock = buildJsonLd(products);
    // ⚠️ 同様にJSON-LDも閉じタグを安全に扱う
    html = replaceBetweenMarkers(html, "<!-- SSR:JSONLD:START -->", "<!-- SSR:JSONLD:END -->", jsonLdBlock);
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
