/**
 * fetch-daily-prices.js  (نسخهٔ ۳ — روش دقیق: قیمت/موجودی هر رنگ جداگانه)
 * ----------------------------------------------------------------
 * منطق:
 *   ۱) فهرست کامل محصولات را از Store API عمومی می‌گیریم
 *      (نام، تصویر، وضعیت رجیستر، نوع محصول). بدون احراز هویت.
 *   ۲) برای هر محصولِ «متغیر»، جزئیات واریشن‌ها (قیمت و موجودیِ
 *      هر رنگ) را از REST API مدیریتی wc/v3 با کلید Read می‌خوانیم.
 *   ۳) فقط رنگ‌های «موجود» را نگه می‌داریم و بر اساس وضعیت رجیستر
 *      (رجیستر/بدون رجیستر) دسته‌بندی می‌کنیم.
 *
 * متغیرهای محیطی موردنیاز (به‌صورت GitHub Secrets):
 *   WC_BASE_URL         مثلاً https://nolix.ir
 *   WC_CONSUMER_KEY     کلید Read که ساختید (ck_...)
 *   WC_CONSUMER_SECRET  رمز Read که ساختید (cs_...)
 * ----------------------------------------------------------------
 */

const fs = require("fs");
const path = require("path");

const BASE_URL = (process.env.WC_BASE_URL || "http://localhost").replace(/\/+$/, "");
const CONSUMER_KEY = process.env.WC_CONSUMER_KEY;
const CONSUMER_SECRET = process.env.WC_CONSUMER_SECRET;
const OUTPUT_PATH = process.env.OUTPUT_PATH || path.join(__dirname, "data", "daily-prices.json");
const PER_PAGE = 100;

const TAX_REGISTER = "pa_registry";
const TAX_COLOR = "pa_color";

if (!CONSUMER_KEY || !CONSUMER_SECRET) {
  console.error("خطا: WC_CONSUMER_KEY و WC_CONSUMER_SECRET باید تنظیم شده باشند.");
  process.exit(1);
}

// ---------- Store API عمومی (بدون احراز هویت) ----------
async function storeApiFetch(pathAndQuery) {
  const url = `${BASE_URL}/wp-json/wc/store/v1${pathAndQuery}`;
  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Store API خطا در ${pathAndQuery}: ${res.status}\n${body}`);
  }
  return res.json();
}

// ---------- REST API مدیریتی (با کلید Read) ----------
function adminAuthHeader() {
  const token = Buffer.from(`${CONSUMER_KEY}:${CONSUMER_SECRET}`).toString("base64");
  return { Authorization: `Basic ${token}` };
}

async function adminApiFetch(pathAndQuery) {
  const url = `${BASE_URL}/wp-json/wc/v3${pathAndQuery}`;
  const res = await fetch(url, { headers: adminAuthHeader() });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Admin API خطا در ${pathAndQuery}: ${res.status}\n${body}`);
  }
  return res.json();
}

async function fetchAllProducts() {
  let page = 1;
  const all = [];
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const batch = await storeApiFetch(`/products?per_page=${PER_PAGE}&page=${page}`);
    if (!Array.isArray(batch) || batch.length === 0) break;
    all.push(...batch);
    if (batch.length < PER_PAGE) break;
    page += 1;
  }
  return all;
}

// خواندن واریشن‌های یک محصول متغیر از REST مدیریتی (قیمت و موجودی هر رنگ)
async function fetchVariations(productId) {
  let page = 1;
  const all = [];
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const batch = await adminApiFetch(
      `/products/${productId}/variations?per_page=${PER_PAGE}&page=${page}`
    );
    if (!Array.isArray(batch) || batch.length === 0) break;
    all.push(...batch);
    if (batch.length < PER_PAGE) break;
    page += 1;
  }
  return all;
}

function getAttributeTerms(product, taxonomy) {
  if (!Array.isArray(product.attributes)) return [];
  const attr = product.attributes.find((a) => a.taxonomy === taxonomy);
  if (!attr || !Array.isArray(attr.terms)) return [];
  return attr.terms.map((t) => t.name);
}

function normalizeRegisterStatus(names) {
  const joined = names.join(" ");
  if (!joined) return "نامشخص";
  if (joined.includes("بدون")) return "بدون رجیستر";
  if (joined.includes("رجیستر")) return "رجیستر شده";
  return joined;
}

// از آرایهٔ attributes یک واریشنِ REST مدیریتی، مقدار رنگرا می‌گیریم
function colorFromVariation(variation) {
  if (!Array.isArray(variation.attributes)) return "نامشخص";
  const colorAttr = variation.attributes.find(
    (a) => (a.name && a.name.includes("رنگ")) || a.slug === TAX_COLOR
  );
  return colorAttr && colorAttr.option ? colorAttr.option : "نامشخص";
}

function baseInfo(product) {
  return {
    id: product.id,
    name: product.name,
    permalink: product.permalink,
    image: product.images && product.images[0] ? product.images[0].src : null,
    categories: (product.categories || []).map((c) => c.name),
  };
}

async function main() {
  console.log(`در حال خواندن کاتالوگ از ${BASE_URL} ...`);
  const products = await fetchAllProducts();
  console.log(`تعداد کل محصولات دریافت‌شده: ${products.length}`);

  const records = [];
  let variableCount = 0;

  for (const product of products) {
    const registerStatus = normalizeRegisterStatus(getAttributeTerms(product, TAX_REGISTER));
    const info = baseInfo(product);

    if (product.type === "variable") {
      // فقط اگر محصولِ والد اصلاً موجود است، سراغ واریشن‌ها می‌رویم
      if (!product.is_in_stock) continue;
      variableCount += 1;
      const variations = await fetchVariations(product.id);
      for (const v of variations) {
        // فقط رنگ‌های موجود
        if (v.stock_status !== "instock") continue;
        records.push({
          ...info,
          variationId: v.id,
          color: colorFromVariation(v),
          price: v.price ? Number(v.price) : null,
          stockStatus: v.stock_status,
          registerStatus,
        });
      }
    } else {
      // محصول ساده
      if (!product.is_in_stock) continue;
      const colorTerms = getAttributeTerms(product, TAX_COLOR);
      records.push({
        ...info,
        variationId: null,
        color: colorTerms.length ? colorTerms.join(" / ") : "نامشخص",
        price: product.prices && product.prices.price ? Number(product.prices.price) : null,
        stockStatus: "instock",
        registerStatus,
      });
    }
  }

  console.log(`تعداد محصولات متعیرِ موجود که واریشن‌هایشان خوانده شد: ${variableCount}`);

  const grouped = {
    generatedAt: new Date().toISOString(),
    sourceBaseUrl: BASE_URL,
    totalItems: records.length,
    registered: records.filter((r) => r.registerStatus === "رجیستر شده"),
    unregistered: records.filter((r) => r.registerStatus !== "رجیستر شده"),
  };

  fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(grouped, null, 2), "utf-8");
  console.log(`خروجی ذخیره شد در: ${OUTPUT_PATH}`);
  console.log(
    `کل موارد موجود: ${records.length} | رجیستر شده: ${grouped.registered.length} | بدون رجیستر: ${grouped.unregistered.length}`
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
