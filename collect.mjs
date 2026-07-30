import { chromium } from "playwright";

const dashboard = (process.env.DASHBOARD_URL || "").replace(/\/$/, "");
const ingestToken = process.env.COLLECTOR_INGEST_TOKEN || "";
const headers = {
  Authorization: `Bearer ${ingestToken}`,
};
const today = new Date().toISOString().slice(0, 10);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

if (!dashboard || !ingestToken) {\n  throw new Error("DASHBOARD_URL and COLLECTOR_INGEST_TOKEN are required.");\n}

async function dashboardJson(path, options = {}) {
  const response = await fetch(`${dashboard}${path}`, {
    ...options,
    headers: { ...headers, ...(options.headers || {}) },
  });
  if (!response.ok) throw new Error(`${path} returned ${response.status}`);
  return response.json();
}

const config = await dashboardJson("/api/collector/config");
const browser = await chromium.launch({
  headless: true,
  args: ["--disable-dev-shm-usage", "--no-sandbox"],
});
const context = await browser.newContext({
  viewport: { width: 1440, height: 1100 },
  locale: "ko-KR",
  userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131 Safari/537.36",
});
const page = await context.newPage();

function isoDateFromText(text) {
  const match = text.match(/(20\d{2})\.\s*(\d{1,2})\.\s*(\d{1,2})\.(?:에)?\s*(?:게재 시작함|부터 게재|started running)/i);
  return match ? `${match[1]}-${match[2].padStart(2, "0")}-${match[3].padStart(2, "0")}` : null;
}

function daysSince(date) {
  if (!date) return 1;
  return Math.max(1, Math.floor((new Date(`${today}T00:00:00Z`) - new Date(`${date}T00:00:00Z`)) / 86400000) + 1);
}

function cleanUiText(text) {
  return text
    .replace(/(?:라이브러리 ID|Library ID)\s*[:：]\s*\d+/gi, " ")
    .replace(/20\d{2}\.\s*\d{1,2}\.\s*\d{1,2}\.(?:에)?\s*(?:게재 시작함|부터 게재|started running)/gi, " ")
    .replace(/광고\s*\d+개에서\s*이\s*크리에이티브\s*및\s*문구를\s*사용합니다/gi, " ")
    .replace(/\d+\s*ads use this creative and text/gi, " ")
    .replace(/광고 상세 정보 보기|세부 사항 보기|요약|See ad details|Ad details|Active|활성|브랜디드 콘텐츠|Sponsored/gi, " ")
    .replace(/\S.{0,70}?\s*페이지는\s*\S.{0,70}?\s*과\(와\)\s*함께합니다/gi, " ")
    .replace(/Facebook|Instagram|Messenger|Audience Network/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function identityFrom(text, links, fallback) {
  const normalized = text.replace(/\s+/g, " ");
  const partner = normalized.match(/(?:상세 정보 보기\s*)?([^\s]{1,40})\s*페이지는\s*([^\s]{1,40})\s*과\(와\)\s*함께합니다/);
  if (partner) return { brand: partner[1], partner: partner[2] };
  const candidate = links.map((item) => item.text?.trim()).find((value) =>
    value && value.length <= 60 && !/상세|보기|광고|라이브러리|Facebook|Instagram|로그인|가입/i.test(value)
  );
  return { brand: candidate || fallback, partner: null };
}

function categoryFor(copy, term) {
  const haystack = `${copy} ${term}`.toLowerCase();
  for (const [category, words] of Object.entries(config.categories || {})) {
    if (words.some((word) => haystack.includes(String(word).toLowerCase()))) return category;
  }
  return "기타";
}

function score(daysActive, variantCount, copy, imageUrl, landingUrl) {
  const earned = Math.min(daysActive, 60) / 60 * 45
    + Math.min(Math.max(variantCount, 1), 5) / 5 * 25
    + (copy.length >= 12 ? 15 : 6)
    + (imageUrl ? 10 : 0)
    + (landingUrl ? 5 : 0);
  return Math.max(0, Math.min(100, Math.round(earned)));
}

async function visibleCards() {
  return page.evaluate(() => {
    const idRegex = /(?:라이브러리 ID|Library ID)\s*[:：]\s*(\d+)/g;
    const elements = [...document.querySelectorAll("div")];
    const ids = new Set();
    for (const element of elements) {
      for (const match of (element.textContent || "").matchAll(idRegex)) ids.add(match[1]);
    }
    const output = [];
    for (const id of ids) {
      const candidates = elements.filter((element) => {
        const text = element.textContent || "";
        const cardIds = [...text.matchAll(idRegex)].map((match) => match[1]);
        const rect = element.getBoundingClientRect();
        return cardIds.includes(id) && new Set(cardIds).size === 1
          && Boolean(element.querySelector("img,video"))
          && rect.width >= 280 && rect.width <= 950 && rect.height >= 220 && rect.height <= 1900;
      });
      if (!candidates.length) continue;
      candidates.sort((a, b) => {
        const ar = a.getBoundingClientRect(); const br = b.getBoundingClientRect();
        return br.width * br.height - ar.width * ar.height;
      });
      const card = candidates[0];
      const links = [...card.querySelectorAll("a")].map((anchor) => ({
        text: (anchor.innerText || anchor.getAttribute("aria-label") || "").trim(),
        href: anchor.href,
      })).filter((item) => item.href);
      const images = [...card.querySelectorAll("img")].map((img) => ({
        src: img.src, size: img.naturalWidth * img.naturalHeight,
      })).sort((a, b) => b.size - a.size);
      const video = card.querySelector("video");
      output.push({
        id,
        text: (card.innerText || "").slice(0, 10000),
        links,
        imageUrl: video?.poster || images[0]?.src || "",
      });
    }
    return output;
  });
}

function pageUrl(pageId) {
  return `https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=${config.country || "KR"}&view_all_page_id=${pageId}&search_type=page&media_type=all`;
}

function keywordUrl(name) {
  return `https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=${config.country || "KR"}&q=${encodeURIComponent(name)}&search_type=keyword_unordered&media_type=all`;
}

async function collectCompetitor(competitor) {
  const url = competitor.pageId ? pageUrl(competitor.pageId) : keywordUrl(competitor.keyword || competitor.name);
  console.log(`[collect] ${competitor.name} (${competitor.pageId ? "page" : "keyword"})`);
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 90000 });
  await sleep(6000);
  const ads = new Map();
  let emptyRounds = 0;
  for (let round = 0; round < 18 && emptyRounds < 3; round++) {
    const cards = await visibleCards();
    let added = 0;
    for (const card of cards) {
      if (ads.has(card.id)) continue;
      const identity = identityFrom(card.text, card.links, competitor.name);
      let copy = cleanUiText(card.text);
      copy = copy.replace(identity.brand, "").replace(identity.partner || "\u0000", "").trim();
      const startDate = isoDateFromText(card.text);
      const variant = card.text.match(/광고\s*(\d+)개에서|([\d]+)\s*ads use this creative/i);
      const variantCount = Number(variant?.[1] || variant?.[2] || 1);
      const landingUrl = card.links.map((link) => link.href)
        .find((link) => !/facebook\.com|instagram\.com|fb\.com/i.test(link)) || "";
      const daysActive = daysSince(startDate);
      ads.set(card.id, {
        id: card.id,
        brand: identity.brand || competitor.name,
        partner: identity.partner,
        title: copy.slice(0, 72) || `${competitor.name} 광고 소재`,
        copy: copy.slice(0, 1200),
        category: categoryFor(copy, competitor.name),
        startDate,
        firstSeen: today,
        lastSeen: today,
        daysActive,
        variantCount,
        referenceScore: score(daysActive, variantCount, copy, card.imageUrl, landingUrl),
        scoreConfidence: copy && card.imageUrl ? "보통" : "낮음",
        sourceUrl: `https://www.facebook.com/ads/library/?id=${card.id}`,
        landingUrl,
        imageUrl: card.imageUrl,
      });
      added++;
    }
    emptyRounds = added ? 0 : emptyRounds + 1;
    console.log(`  round ${round + 1}: +${added}, total ${ads.size}`);
    await page.mouse.wheel(0, 900);
    await sleep(2200);
  }
  return [...ads.values()];
}

try {
  const merged = new Map();
  for (const competitor of config.competitors || []) {
    const batch = await collectCompetitor(competitor);
    for (const ad of batch) merged.set(ad.id, ad);
    await sleep(3000);
  }
  const ads = [...merged.values()].sort((a, b) => b.referenceScore - a.referenceScore);
  await dashboardJson("/api/collector/results", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ads }),
  });
  console.log(`[done] ${ads.length} ads uploaded`);
} catch (error) {
  console.error(error);
  try {
    await dashboardJson("/api/collector/results", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: error instanceof Error ? error.message : "Unknown collection error" }),
    });
  } catch {}
  process.exitCode = 1;
} finally {
  await browser.close();
}
