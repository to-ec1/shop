/**
 * ============================================================
 * テイクオンストア EC API (GAS Web App)
 * ============================================================
 *
 * 【役割】
 *   doGet  : 商品一覧をJSONで返す(公開フラグがONの商品のみ)
 *   doPost : 注文を受け付ける(在庫チェック→在庫減算→注文シート書き込み→Chat通知)
 *
 * 【前提となるスプレッドシート構成】
 *
 *  ■「商品」シート (1行目はヘッダー)
 *    A: JAN            例) 4901234567890
 *    B: 商品名          例) サンプル商品A
 *    C: 価格            例) 1200
 *    D: 在庫数          例) 12
 *    E: DriveImageID    例) 1AbCdEfGhIjKlMnOpQrSt (Google DriveファイルID)
 *    F: 公開フラグ       例) TRUE / FALSE (チェックボックス推奨)
 *    G: カテゴリ         例) 雑貨 / コスメ / サプリ / 食品 / その他
 *                       ※ タブの表示順は「カテゴリ一覧」に最初に登場した順で自動生成される。
 *                          並び順を固定したい場合はシート側で先頭に出したいカテゴリの商品行を上に置く。
 *
 *  ■「注文」シート (1行目はヘッダー、なければ自動作成)
 *    A: タイムスタンプ
 *    B: 注文番号
 *    C: 氏名
 *    D: フリガナ
 *    E: 郵便番号
 *    F: 電話番号
 *    G: 住所
 *    H: メール
 *    I: 備考
 *    J: 商品明細(JSON文字列)
 *    K: 合計金額
 *    L: ステータス (初期値: 振込待ち)
 *
 * 【Script Properties(プロジェクトの設定 > スクリプト プロパティ)】
 *    CHAT_SPACE_ID  : (任意) Google Chat通知先スペースID。未設定なら通知はスキップされるだけで注文処理は継続する。
 *
 * 【デプロイ方法】
 *    1. このスクリプトをスプレッドシートのGASエディタに貼り付け(このスプレッドシート自体が「商品」「注文」シートを持つ)
 *    2. デプロイ > 新しいデプロイ > 種類:ウェブアプリ
 *    3. 実行するユーザー: 自分 / アクセスできるユーザー: 全員
 *    4. デプロイ後のURLを index.html の PRODUCTS_API_URL / ORDER_API_URL に設定
 *       (URLは同じもので、GETなら商品取得、POSTなら注文受付として動作する)
 * ============================================================
 */

const SHEET_PRODUCTS = "商品";
const SHEET_ORDERS = "注文";
const ORDER_HEADERS = ["タイムスタンプ", "注文番号", "氏名", "フリガナ", "郵便番号", "電話番号", "住所", "メール", "備考", "商品明細", "合計金額", "ステータス"];

/**
 * 商品一覧取得 (GET)
 */
function doGet(e) {
  Logger.log("=== doGet 開始 ===");
  try {
    const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_PRODUCTS);
    if (!sheet) {
      Logger.log("エラー: 「商品」シートが見つかりません");
      return jsonResponse({ ok: false, message: "「商品」シートが見つかりません" });
    }

    const values = sheet.getDataRange().getValues();
    Logger.log("商品シート読み込み: " + (values.length - 1) + "行");

    const products = [];
    for (let i = 1; i < values.length; i++) {
      const row = values[i];
      const jan = row[0], name = row[1], price = row[2], stock = row[3], driveImageId = row[4], isPublic = row[5], category = row[6];
      if (!jan) continue; // JAN未入力の空行はスキップ
      if (isPublic !== true) continue; // 公開フラグOFFはスキップ

      products.push({
        jan: String(jan),
        name: String(name || ""),
        price: Number(price) || 0,
        stock: Number(stock) || 0,
        driveImageId: String(driveImageId || ""),
        category: String(category || "その他"),
      });
    }

    Logger.log("公開商品件数: " + products.length);
    Logger.log("=== doGet 正常終了 ===");
    return jsonResponse({ ok: true, products: products });

  } catch (err) {
    Logger.log("doGet 例外エラー: " + err);
    return jsonResponse({ ok: false, message: "サーバーエラーが発生しました" });
  }
}

/**
 * 注文受付 (POST)
 */
function doPost(e) {
  Logger.log("=== doPost 開始(注文受付) ===");
  const lock = LockService.getScriptLock();

  try {
    // 在庫の同時更新を防ぐため排他ロックを取得(最大10秒待機)
    lock.waitLock(10000);
    Logger.log("スクリプトロック取得成功");

    const payload = JSON.parse(e.postData.contents);
    Logger.log("受信した注文データ: " + JSON.stringify(payload));

    const orderNumber = payload.orderNumber;
    const customer = payload.customer || {};
    const items = payload.items || [];
    const total = payload.total || 0;

    if (!orderNumber || items.length === 0) {
      Logger.log("エラー: 必須項目が不足しています");
      return jsonResponse({ ok: false, message: "注文データが不正です" });
    }

    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const productSheet = ss.getSheetByName(SHEET_PRODUCTS);
    const productValues = productSheet.getDataRange().getValues();

    // --- 在庫チェック(全商品分を先にチェックしてから減算する) ---
    Logger.log("在庫チェック開始...");
    const rowMap = {}; // jan -> 行番号(1始まり)
    for (let i = 1; i < productValues.length; i++) {
      rowMap[String(productValues[i][0])] = i + 1;
    }

    for (const item of items) {
      const rowIndex = rowMap[item.jan];
      if (!rowIndex) {
        Logger.log("エラー: JAN " + item.jan + " が商品シートに見つかりません");
        return jsonResponse({ ok: false, message: "商品(JAN:" + item.jan + ")が見つかりません" });
      }
      const currentStock = Number(productValues[rowIndex - 1][3]) || 0;
      if (currentStock < item.qty) {
        Logger.log("在庫不足: JAN " + item.jan + " 現在庫" + currentStock + " < 注文数" + item.qty);
        return jsonResponse({ ok: false, message: "「" + item.name + "」は在庫が不足しています(残り" + currentStock + "点)" });
      }
    }
    Logger.log("在庫チェックOK。在庫を減算します。");

    // --- 在庫減算 ---
    for (const item of items) {
      const rowIndex = rowMap[item.jan];
      const stockCell = productSheet.getRange(rowIndex, 4); // D列:在庫数
      const newStock = Number(stockCell.getValue()) - item.qty;
      stockCell.setValue(newStock);
      Logger.log("在庫更新: JAN " + item.jan + " → 残り" + newStock);
    }

    // --- 注文シートへ書き込み ---
    const orderSheet = getOrCreateOrderSheet(ss);
    orderSheet.appendRow([
      new Date(),
      orderNumber,
      customer.name || "",
      customer.kana || "",
      customer.zip || "",
      customer.phone || "",
      customer.address || "",
      customer.email || "",
      customer.note || "",
      JSON.stringify(items),
      total,
      "振込待ち",
    ]);
    Logger.log("注文シートへ書き込み完了: 注文番号 " + orderNumber);

    // --- Chat通知(失敗しても注文処理自体は成功として扱う) ---
    notifyChat(orderNumber, customer, items, total);

    Logger.log("=== doPost 正常終了 ===");
    return jsonResponse({ ok: true, orderNumber: orderNumber });

  } catch (err) {
    Logger.log("doPost 例外エラー: " + err);
    return jsonResponse({ ok: false, message: "サーバーエラーが発生しました" });

  } finally {
    lock.releaseLock();
    Logger.log("スクリプトロック解放");
  }
}

/**
 * 「注文」シートを取得。存在しなければヘッダー付きで新規作成
 */
function getOrCreateOrderSheet(ss) {
  let sheet = ss.getSheetByName(SHEET_ORDERS);
  if (!sheet) {
    Logger.log("「注文」シートが存在しないため新規作成します");
    sheet = ss.insertSheet(SHEET_ORDERS);
    sheet.appendRow(ORDER_HEADERS);
  }
  return sheet;
}

/**
 * Google Chatへ注文通知を送信(Teffyの通知パターンを流用)
 * CHAT_SPACE_ID が未設定の場合は何もせずスキップする
 */
function notifyChat(orderNumber, customer, items, total) {
  const spaceId = PropertiesService.getScriptProperties().getProperty("CHAT_SPACE_ID");
  if (!spaceId) {
    Logger.log("CHAT_SPACE_ID未設定のため、Chat通知をスキップします");
    return;
  }

  try {
    const itemLines = items.map(function(i) {
      return "・" + i.name + " × " + i.qty + " (¥" + i.price.toLocaleString() + ")";
    }).join("\n");

    const message = {
      text: "🛒 新規注文が入りました\n" +
        "注文番号: " + orderNumber + "\n" +
        "お名前: " + customer.name + " 様\n" +
        "--------------------\n" + itemLines + "\n" +
        "--------------------\n" +
        "合計: ¥" + Number(total).toLocaleString(),
    };

    Chat.Spaces.Messages.create(message, spaceId);
    Logger.log("Chat通知送信完了: " + spaceId);
  } catch (err) {
    Logger.log("Chat通知エラー(注文処理には影響なし): " + err);
  }
}

/**
 * JSON形式でレスポンスを返す共通関数
 */
function jsonResponse(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
