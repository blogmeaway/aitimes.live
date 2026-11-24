/**
 * AI TIMES (aitimes.live) — Autonomous Daily Edition Generator
 * Reads CONSTITUTION.md + live World & AI RSS feeds, synthesizes bilingual EN/RO
 * editorial content + conceptual SVG editorial plate via Gemini API, and updates
 * data/editions.json (keeping the last 30 editions in archive).
 */

import fs from "node:fs/promises";
import path from "node:path";

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
const MODEL_CANDIDATES = [
  process.env.GEMINI_MODEL || "gemini-3.8-flash",
  "gemini-3.8-flash-lite",
  "gemini-3.8-pro"
];

const WORLD_FEEDS = [
  { name: "BBC World", url: "https://feeds.bbci.co.uk/news/world/rss.xml" },
  { name: "Al Jazeera", url: "https://www.aljazeera.com/xml/rss/all.xml" },
  { name: "NPR World", url: "https://feeds.npr.org/1004/rss.xml" },
  { name: "UN News", url: "https://news.un.org/feed/subscribe/en/news/all/rss.xml" }
];

const AI_FEEDS = [
  { name: "MIT Tech Review AI", url: "https://www.technologyreview.com/topic/artificial-intelligence/feed" },
  { name: "The Verge AI", url: "https://www.theverge.com/rss/ai-artificial-intelligence/index.xml" },
  { name: "VentureBeat AI", url: "https://venturebeat.com/category/ai/feed/" },
  { name: "ArXiv CS.AI", url: "https://rss.arxiv.org/rss/cs.AI" }
];

function decodeXml(str = "") {
  return str
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/<[^>]+>/g, "")
    .trim();
}

function parseRssItems(xmlText, sourceName, limit = 5) {
  const items = [];
  const itemMatches = xmlText.match(/<item\b[\s\S]*?<\/item>/gi) || xmlText.match(/<entry\b[\s\S]*?<\/entry>/gi) || [];

  for (const raw of itemMatches.slice(0, limit)) {
    const titleMatch = raw.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
    const linkMatch =
      raw.match(/<link\b[^>]*href=["']([^"']+)["'][^>]*\/?>/i) ||
      raw.match(/<link\b[^>]*>([\s\S]*?)<\/link>/i);
    const descMatch =
      raw.match(/<description\b[^>]*>([\s\S]*?)<\/description>/i) ||
      raw.match(/<summary\b[^>]*>([\s\S]*?)<\/summary>/i);

    const title = titleMatch ? decodeXml(titleMatch[1]) : "";
    const link = linkMatch ? decodeXml(linkMatch[1]) : "";
    const summary = descMatch ? decodeXml(descMatch[1]).slice(0, 220) : "";

    if (title && link) {
      items.push({ source: sourceName, title, link, summary });
    }
  }
  return items;
}

async function fetchFeedPool(feedList) {
  const results = await Promise.all(
    feedList.map(async (feed) => {
      try {
        const res = await fetch(feed.url, {
          headers: { "User-Agent": "AITimesBot/1.0 (+https://aitimes.live)" },
          signal: AbortSignal.timeout(8000)
        });
        if (!res.ok) return [];
        const xml = await res.text();
        return parseRssItems(xml, feed.name, 5);
      } catch {
        return [];
      }
    })
  );
  return results.flat();
}

function formatDateStrings(dateObj) {
  const iso = dateObj.toISOString().slice(0, 10);
  const en = dateObj.toLocaleDateString("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "UTC"
  });
  const roRaw = dateObj.toLocaleDateString("ro-RO", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "UTC"
  });
  const ro = roRaw.charAt(0).toUpperCase() + roRaw.slice(1);
  return { iso, en, ro, isSunday: dateObj.getUTCDay() === 0 };
}

async function generateEditionWithGemini({ constitution, dateInfo, issueNumber, worldPool, aiPool }) {
  if (!GEMINI_API_KEY) {
    throw new Error("Missing GEMINI_API_KEY environment variable.");
  }

  const prompt = `
You are The AI Columnist, autonomous Editor-in-Chief of AI TIMES (aitimes.live — "Your dAIly journal automade.").
Follow this Editorial Constitution strictly:
${constitution}

Today's UTC Date: ${dateInfo.iso} (${dateInfo.en})
Issue Number: ${issueNumber}
Is Sunday Weekly Synthesis Edition: ${dateInfo.isSunday ? "YES — expand the lead essay slightly to synthesize the week's global trajectory." : "NO — daily edition."}

VERIFIED WORLD RSS HEADLINES:
${JSON.stringify(worldPool.slice(0, 16), null, 2)}

VERIFIED AI INDUSTRY RSS HEADLINES:
${JSON.stringify(aiPool.slice(0, 16), null, 2)}

TASK:
Return ONLY valid JSON (no markdown fences) matching this exact schema:
{
  "en": {
    "issue": "Issue No. ${String(issueNumber).padStart(2, "0")}",
    "date": "${dateInfo.en}",
    "headline": "Compelling broadsheet lead essay headline",
    "subhead": "One-sentence reflective deck summarizing the column's thesis",
    "artCaption": "Editorial Plate ${String(issueNumber).padStart(2, "0")}: One-sentence caption describing the conceptual artwork",
    "paragraphs": ["Opening paragraph (hook)", "Second paragraph (connecting real wire signals)", "Third paragraph (direction & human takeaway)"],
    "sources": "Comma-separated list of outlets read from the RSS pool",
    "people": [
      { "category": "Short Topic Tag", "title": "Clean headline", "why": "One plain-English sentence on why this matters to everyday people", "url": "Exact URL from world RSS pool" }
    ],
    "aiWorld": [
      { "tag": "Short AI Tag", "title": "Clean AI industry headline", "takeaway": "One crisp analytical sentence on the real significance", "url": "Exact URL from AI RSS pool" }
    ]
  },
  "ro": {
    "issue": "Ediția Nr. ${String(issueNumber).padStart(2, "0")}",
    "date": "${dateInfo.ro}",
    "headline": "Natural, literary Romanian translation/adaptation of the lead headline",
    "subhead": "Romanian subhead",
    "artCaption": "Planșa Editorială ${String(issueNumber).padStart(2, "0")}: Romanian caption",
    "paragraphs": ["Paragraph 1 in natural Romanian", "Paragraph 2 in natural Romanian", "Paragraph 3 in natural Romanian"],
    "sources": "Romanian source attribution line",
    "people": [
      { "category": "Tag RO", "title": "Headline RO", "why": "De ce contează (1 propoziție clară)", "url": "Same URL" }
    ],
    "aiWorld": [
      { "tag": "Tag AI RO", "title": "Headline AI RO", "takeaway": "Pe scurt (1 propoziție)", "url": "Same URL" }
    ]
  },
  "artworkSvg": "<svg viewBox=\\"0 0 800 450\\" class=\\"w-full h-full object-cover\\" xmlns=\\"http://www.w3.org/2000/svg\\">...custom minimalist geometric editorial illustration matching today's essay theme using dark slate #141821, warm gold #fbbf24, and crimson #dc2626...</svg>"
}

RULES:
- "people" MUST contain exactly 5 distinct items grounded in the World RSS pool.
- "aiWorld" MUST contain exactly 5 distinct items grounded in the AI Industry RSS pool.
- "artworkSvg" MUST be valid self-contained inline SVG (viewBox="0 0 800 450") with no external images or scripts.
`;

  let lastError = null;

  for (const model of MODEL_CANDIDATES) {
    for (let attempt = 1; attempt <= 2; attempt++) {
      const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(GEMINI_API_KEY)}`;
      console.log(`Calling Gemini model "${model}" (attempt ${attempt}/2)...`);

      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            temperature: 0.65,
            responseMimeType: "application/json"
          }
        })
      });

      if (res.ok) {
        const data = await res.json();
        const rawText = data?.candidates?.[0]?.content?.parts?.[0]?.text || "";
        const cleaned = rawText.replace(/^```json\s*/i, "").replace(/```\s*$/i, "").trim();
        return JSON.parse(cleaned);
      }

      const errText = await res.text();
      lastError = new Error(`Gemini API error (${res.status}) on ${model}: ${errText}`);
      console.warn(lastError.message);

      // Wait 4 seconds before retrying on temporary overload (503 / 429)
      if (res.status === 503 || res.status === 429) {
        await new Promise((r) => setTimeout(r, 4000));
      } else {
        break;
      }
    }
  }

  throw lastError;
}

async function main() {
  const rootDir = process.cwd();
  const editionsPath = path.join(rootDir, "data", "editions.json");
  const constitutionPath = path.join(rootDir, "CONSTITUTION.md");

  const [editionsRaw, constitution] = await Promise.all([
    fs.readFile(editionsPath, "utf8"),
    fs.readFile(constitutionPath, "utf8")
  ]);

  const store = JSON.parse(editionsRaw);
  const now = new Date();
  const dateInfo = formatDateStrings(now);

  const prevLatest = store.editions[store.latestDate];
  const nextIssueNumber =
    store.latestDate === dateInfo.iso && prevLatest?.issueNumber
      ? prevLatest.issueNumber
      : (prevLatest?.issueNumber || 0) + 1;

  console.log(`Fetching RSS feeds for ${dateInfo.iso} (Issue #${nextIssueNumber})...`);
  const [worldPool, aiPool] = await Promise.all([
    fetchFeedPool(WORLD_FEEDS),
    fetchFeedPool(AI_FEEDS)
  ]);

  console.log(`Collected ${worldPool.length} world items and ${aiPool.length} AI industry items.`);

  const generated = await generateEditionWithGemini({
    constitution,
    dateInfo,
    issueNumber: nextIssueNumber,
    worldPool,
    aiPool
  });

  store.latestDate = dateInfo.iso;
  store.editions[dateInfo.iso] = {
    issueNumber: nextIssueNumber,
    en: generated.en,
    ro: generated.ro,
    artworkSvg: generated.artworkSvg
  };

  // Retain the 30 most recent editions in the archive
  const sortedKeys = Object.keys(store.editions).sort().reverse();
  for (const oldKey of sortedKeys.slice(30)) {
    delete store.editions[oldKey];
  }

  await fs.writeFile(editionsPath, JSON.stringify(store, null, 2) + "\n", "utf8");
  console.log(`Successfully published AI TIMES edition for ${dateInfo.iso}.`);
}

main().catch((err) => {
  console.error("Failed to publish edition:", err);
  process.exit(1);
});
