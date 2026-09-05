/**
 * fetch-daily-prices.js  (نسخهٔ ۴ — نهایی: جفت رجیستر/بدون‌رجیستر از پلاگین Nolix)
 * ----------------------------------------------------------------
 * منطق نهایی:
 *   ۱) همهٔ محصولات را از REST API مدیریتی (wc/v3) با meta می‌خوانیم.
 *   ۲) «گوشی بودن» را از روی دسته‌بندی تشخیص می‌دهیم (آیفون/سامسونگ/گلکسی).
 *      فقط برای گوشی‌ها بحث رجیستر مطرح است.
 *   ۳) «رجیستر شده» را از انتهای نام محصول می‌خوانیم؛ محصولاتی که در
 *      نامشان «رجیستر شده» ندارند، نسخهٔ بدون‌رجیستر (محور) هستند.
 *   ۴) محور هر کارت = محصول بدون‌رجیستر. اگر meta آن کلید
 *      _nolix_reg_pair را داشته باشد، شناسهٔ محصول رجیسترِ متناظر است؛
 *      قیمت رجیستر هر رنگ را از همان رنگ در آن محصول می‌خوانیم.
 *   ۵) قیمت و موجودی هر رنگ از واریشن‌ها می‌آید. رنگِ خالص را از بخش
 *      بعد از «/» در نام واریشن استخراج می‌کنیم (چون گارانتی هم در
 *      نام واریشن هست: «گارانتی...NotActive/White»).
 *   ۶) فقط رنگ‌های موجود (instock) نگه داشته می‌شوند.
 * ----------------------------------------------------------------
 */

const fs = require("fs");
const path = require("path");

const BASE_URL = (process.env.WC_BASE_URL || "http://localhost").replace(/\/+$/, "");
const CONSUMER_KEY = process.env.WC_CONSUMER_KEY;
const CONSUMER_SECRET = process.env.WC_CONSUMER_SECRET;
const OUTPUT_PATH = process.env.OUTPUT_PATH || path.join(__dirname, "data", "daily-prices.json");
const PER_PAGE = 100;

if (!CONSUMER_KEY || !CONSUMER_SECRET) {
  console.error("خطا: WC_CONSUMER_KEY و WC_CONSUMER_SECRET باید تنظیم شده باشند.");
  process.exit(1);
}

function authHeader() {
  const token = Buffer.from(`${CONSUMER_KEY}:${CONSUMER_SECRET}`).toString("base64");
    return { Authorization: `Basic ${token}`, "User-Agent": "nolix-price-bot/1.0 (+github-actions)", Accept: "application/json" };
}

async function api(pathAndQuery, attempt = 1) {
  const MAX_ATTEMPTS = 4;
  const url = `${BASE_URL}/wp-json/wc/v3${pathAndQuery}`;
  try {
  const res = await fetch(url, { headers: authHeader() });
  if (!res.ok) {
  const body = await res.text().catch(() => "");
  const retryable = res.status === 403 || res.status === 429 || res.status >= 500;
  if (retryable && attempt < MAX_ATTEMPTS) {
  const waitMs = 2000 * attempt;
  console.warn(`hoshdar: ${res.status} dar ${pathAndQuery} (talash ${attempt}/${MAX_ATTEMPTS}) - entezar ${waitMs}ms`);
  await new Promise((r) => setTimeout(r, waitMs));
  return api(pathAndQuery, attempt + 1);
  }
  throw new Error(`API khata dar ${pathAndQuery}: ${res.status}\n${body.slice(0, 300)}`);
  }
  return res.json();
  } catch (err) {
  if (attempt < MAX_ATTEMPTS) {
  const waitMs = 2000 * attempt;
  console.warn(`hoshdar: khata-ye shabake dar ${pathAndQuery} (talash ${attempt}/${MAX_ATTEMPTS}) - entezar ${waitMs}ms`);
  await new Promise((r) => setTimeout(r, waitMs));
  return api(pathAndQuery, attempt + 1);
  }
  throw err;
  }
  }
}

async function fetchAllProducts() {
  let page = 1;
  const all = [];
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const batch = await api(`/products?status=publish&per_page=${PER_PAGE}&page=${page}`);
    if (!Array.isArray(batch) || batch.length === 0) break;
    all.push(...batch);
    if (batch.length < PER_PAGE) break;
    page += 1;
  }
  return all;
}

async function fetchVariations(productId) {
  let page = 1;
  const all = [];
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const batch = await api(`/products/${productId}/variations?per_page=${PER_PAGE}&page=${page}`);
    if (!Array.isArray(batch) || batch.length === 0) break;
    all.push(...batch);
    if (batch.length < PER_PAGE) break;
    page += 1;
  }
  return all;
}

function getMeta(product, key) {
  if (!Array.isArray(product.meta_data)) return null;
  const m = product.meta_data.find((x) => x.key === key);
  return m ? m.value : null;
}

// آیا این محصول «گوشی» است؟ (فقط گوشی‌ها بحث رجیستر دارند)
function isPhone(product) {
  const cats = (product.categories || []).map((c) => c.name).join(" ");
  const name = product.name || "";
  return /آیفون|سامسونگ|گلکسی|iphone|galaxy|samsung/i.test(cats + " " + name);
}

// خواندن وضعیت رجیستر از attribute مخفی pa_registry (منبع دقیق)
function getRegistryStatus(product) {
  if (!Array.isArray(product.attributes)) return null;
  const attr = product.attributes.find((a) => a.slug === "pa_registry" || a.name === "رجیستری");
  if (!attr) return null;
  const opts = Array.isArray(attr.options) ? attr.options.join(" ") : String(attr.options || "");
  if (!opts) return null;
  if (opts.includes("بدون")) return "بدون رجیستر";
  if (opts.includes("رجیستر")) return "رجیستر شده";
  return opts;
}

// استخراج رنگ خالص از نام واریشنِ REST مدیریتی
// نام واریشن رنگ به‌صورت attribute جداست؛اما گاهی گارانتی و رنگ با هم می‌آیند.
function colorFromVariation(variation) {
  if (!Array.isArray(variation.attributes)) return "نامشخص";
  const colorAttr = variation.attributes.find(
    (a) => (a.name && a.name.includes("رنگ")) || (a.slug && a.slug === "pa_color")
  );
  if (colorAttr && colorAttr.option) return colorAttr.option;
  const joined = variation.attributes.map((a) => a.option).filter(Boolean).join("/");
  if (joined.includes("/")) return joined.split("/").pop().trim();
  return joined || "نامشخص";
}

function normColor(c) {
  return (c || "").toLowerCase().replace(/\s+/g, "").trim();
}

function num(v) {
  const n = Number(v);
  return v && !Number.isNaN(n) ? n : null;
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
  console.log(`در حال خواندن کاتالوگ (با meta) از ${BASE_URL} ...`);
  const products = await fetchAllProducts();
  console.log(`تعداد کل محصولات: ${products.length}`);

  const byId = new Map(products.map((p) => [p.id, p]));

  const variationsCache = new Map();
  async function getVars(id) {
    if (variationsCache.has(id)) return variationsCache.get(id);
    const v = await fetchVariations(id);
    variationsCache.set(id, v);
    return v;
  }

  const records = [];

  for (const product of products) {
    const phone = isPhone(product);
    const registryStatus = getRegistryStatus(product);
    const isRegistered = registryStatus === "رجیستر شده";

            // [interp-A] removed: registered phones are no longer skipped, so each registered color becomes its own item.

    const info = baseInfo(product);
    const regPairId = phone ? num(getMeta(product, "_nolix_reg_pair")) : null;

    let ownVariations = [];
    if (product.type === "variable") {
      if (product.stock_status !== "instock") continue;
      ownVariations = await getVars(product.id);
    }

    let regVariations = [];
    if (regPairId && byId.has(regPairId)) {
      regVariations = await getVars(regPairId);
    }
    const regPriceByColor = new Map();
    for (const rv of regVariations) {
      if (rv.stock_status !== "instock") continue;
      const c = normColor(colorFromVariation(rv));
      if (c && !regPriceByColor.has(c)) regPriceByColor.set(c, num(rv.price));
    }

    if (product.type === "variable") {
      for (const v of ownVariations) {
        if (v.stock_status !== "instock") continue;
        const color = colorFromVariation(v);
        const regPrice = regPriceByColor.get(normColor(color)) || null;
        records.push({
          ...info,
          variationId: v.id,
          color,
          priceUnregistered: num(v.price),
          priceRegistered: regPrice,
          isPhone: phone,
          registryStatus: registryStatus || null,
        });
      }
    } else {
      if (product.stock_status !== "instock") continue;
      records.push({
        ...info,
        variationId: null,
        color: "—",
        priceUnregistered: num(product.price),
        priceRegistered: null,
        isPhone: phone,
        registryStatus: registryStatus || null,
      });
    }
  }

  const withDual = records.filter((r) => r.priceRegistered != null).length;

  const grouped = {
    generatedAt: new Date().toISOString(),
    sourceBaseUrl: BASE_URL,
    totalItems: records.length,
    itemsWithDualPrice: withDual,
    items: records,
  };

  fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(grouped, null, 2), "utf-8");
  console.log(`خروجی ذخیره شد در: ${OUTPUT_PATH}`);
  console.log(`کل موارد موجود: ${records.length} | دارای دو قیمت (رجیستر+بدون): ${withDual}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
