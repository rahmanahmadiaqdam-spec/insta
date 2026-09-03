/**
 * fetch-daily-prices.js  (نسخهٔ ۲ — بر پایهٔ WooCommerce Store API عمومی)
 * ----------------------------------------------------------------
 * این نسخه به‌جای REST API مدیریتی ووکامرس (wc/v3 که نیاز به
 * Consumer Key/Secret دارد)، از Store API عمومی خودِ ووکامرس
 * استفاده می‌کند (wc/store/v1) که برای خواندن کاتالوگ منتشرشده
 * نیازی به هیچ احراز هویتی ندارد. این API دقیقاً همان داده‌ای را
 * برمی‌گرداند که در صفحهٔ فروشگاه دیده می‌شود.
 *
 * دو Attribute کلیدی که در پیشخوان سایت شما پیدا کردیم:
 *   - وضعیت ریجستر → taxonomy: pa_registry   (سطح محصول، نه واریشن)
 *   - رنگ          → taxonomy: pa_color      (می‌تواند سطح واریشن باشد)
 *
 * نحوهٔ اجرا:
 *   WC_BASE_URL=http://localhost node fetch-daily-prices.js
 *   (برای سایت اصلی: WC_BASE_URL=https://nolix.ir node fetch-daily-prices.js)
 * ----------------------------------------------------------------
 */

const fs = require("fs");
const path = require("path");

const BASE_URL = (process.env.WC_BASE_URL || "http://localhost").replace(/\/+$/, "");
const OUTPUT_PATH = process.env.OUTPUT_PATH || path.join(__dirname, "data", "daily-prices.json");
const PER_PAGE = 100;

const TAX_REGISTER = "pa_registry";
const TAX_COLOR = "pa_color";

async function storeApiFetch(pathAndQuery) {
  const url = `${BASE_URL}/wp-json/wc/store/v1${pathAndQuery}`;
  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`درخواست به ${url} با خطا مواجه شد: ${res.status}\n${body}`);
  }
  return res.json();
}

// ---------- گرفتن همهٔ محصولات (صفحه‌بندی‌شده) ----------
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

// ---------- گرفتن گروهی جزئیات چند محصول/واریشن با include=id1,id2,... ----------
async function fetchByIds(ids) {
  const results = [];
  const chunkSize = 100;
  for (let i = 0; i < ids.length; i += chunkSize) {
    const chunk = ids.slice(i, i + chunkSize);
    const batch = await storeApiFetch(`/products?include=${chunk.join(",")}&per_page=${chunkSize}`);
    results.push(...batch);
  }
  return results;
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

function toRecord(product, { registerStatus, color, variationId = null } = {}) {
  return {
    id: product.id,
    variationId,
    name: product.name,
    permalink: product.permalink,
    image: product.images && product.images[0] ? product.images[0].src : null,
    categories: (product.categories || []).map((c) => c.name),
    color: color || "نامشخص",
    price: product.prices && product.prices.price ? Number(product.prices.price) : null,
    stockStatus: product.is_in_stock ? "instock" : "outofstock",
    registerStatus,
  };
}

async function main() {
  console.log(`در حال خواندن کاتالوگ از ${BASE_URL} (Store API عمومی) ...`);
  const products = await fetchAllProducts();
  console.log(`تعداد کل محصولات دریافت‌شده: ${products.length}`);

  const simpleRecords = [];
  const variationIdToParent = new Map(); // variationId -> { parentProduct, colorFromParentVariationList }

  for (const product of products) {
    const registerStatus = normalizeRegisterStatus(getAttributeTerms(product, TAX_REGISTER));

    if (product.type === "variable" && Array.isArray(product.variations) && product.variations.length) {
      for (const v of product.variations) {
        variationIdToParent.set(v.id, { parent: product, registerStatus });
      }
      continue;
    }

    // محصول ساده: فقط اگر موجود است نگه می‌داریم
    if (!product.is_in_stock) continue;
    const colorTerms = getAttributeTerms(product, TAX_COLOR);
    simpleRecords.push(
      toRecord(product, { registerStatus, color: colorTerms.join(" / ") })
    );
  }

  // گرفتن جزئیات (قیمت/موجودی) همهٔ واریشن‌ها به‌صورت گروهی
  const variationIds = Array.from(variationIdToParent.keys());
  console.log(`تعداد واریشن‌هایی که باید جزئیاتشان خوانده شود: ${variationIds.length}`);
  const variationDetails = variationIds.length ? await fetchByIds(variationIds) : [];

  const variationRecords = [];
  for (const v of variationDetails) {
    if (!v.is_in_stock) continue;
    const { parent, registerStatus } = variationIdToParent.get(v.id) || {};
    // رنگ را از رشتهٔ توصیفی variation (مثلاً "گارانتی: ..., رنگ: مشکی") استخراج می‌کنیم
    let color = "نامشخص";
    if (typeof v.variation === "string") {
      const match = v.variation.match(/رنگ:\s*([^,،]+)/);
      if (match) color = match[1].trim();
    }
    variationRecords.push(
      toRecord(v, { registerStatus, color, variationId: v.id })
    );
    // نام و تصویر را از محصول والد بگیریم تا خواناتر باشد
    const last = variationRecords[variationRecords.length - 1];
    if (parent) {
      last.name = parent.name;
      last.permalink = parent.permalink;
      last.categories = (parent.categories || []).map((c) => c.name);
    }
  }

  const allRecords = [...simpleRecords, ...variationRecords];

  const grouped = {
    generatedAt: new Date().toISOString(),
    sourceBaseUrl: BASE_URL,
    totalItems: allRecords.length,
    registered: allRecords.filter((r) => r.registerStatus === "رجیستر شده"),
    unregistered: allRecords.filter((r) => r.registerStatus !== "رجیستر شده"),
  };

  fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(grouped, null, 2), "utf-8");
  console.log(`خروجی ذخیره شد در: ${OUTPUT_PATH}`);
  console.log(
    `تعداد رجیستر شده: ${grouped.registered.length} | تعداد بدون رجیستر: ${grouped.unregistered.length}`
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
