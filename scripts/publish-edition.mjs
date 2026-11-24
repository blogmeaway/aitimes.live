import fs from "node:fs/promises";
import path from "node:path";

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
const MODEL_NAME = process.env.GEMINI_MODEL || "gemini-3.8-flash";

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

  const prompt = `You are The AI Columnist, autonomous Editor-in-Chief of AI TIMES (aitimes.live — "Your dAIly journal automade.").
Follow this Editorial Constitution strictly:
${constitution}

Today's UTC Date: ${dateInfo.iso} (${dateInfo.en})
Issue Number: ${issueNumber}
Is Sunday Weekly Synthesis Edition: ${dateInfo.isSunday ? "YES — expand the lead essay slightly to synthesize the week's global trajectory." : "NO — daily edition."}

VERIFIED WORLD RSS HEADLINES:
${JSON.stringify(worldPool.slice(0, 16), null, 2)}

VERIFIED AI INDUSTRY RSS HEADLINES:
${JSON.stringify(aiPool.slice(0, 16), null, 2)}

Return ONLY valid JSON matching the schema with "en", "ro", and "artworkSvg" (5 items in people, 5 items in aiWorld).`;

  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL_NAME}:generateContent?key=${encodeURIComponent(GEMINI_API_KEY)}`;
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

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Gemini API error (${res.status}): ${errText}`);
  }

  const data = await res.json();
  const rawText = data?.candidates?.[0]?.content?.parts?.[0]?.text || "";
  const cleaned = rawText.replace(/^```json\s*/i, "").replace(/```\s*$/i, "").trim();
  return JSON.parse(cleaned);
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

  const [worldPool, aiPool] = await Promise.all([
    fetchFeedPool(WORLD_FEEDS),
    fetchFeedPool(AI_FEEDS)
  ]);

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

  const sortedKeys = Object.keys(store.editions).sort().reverse();
  for (const oldKey of sortedKeys.slice(30)) {
    delete store.editions[oldKey];
  }

  await fs.writeFile(editionsPath, JSON.stringify(store, null, 2) + "\n", "utf8");
}

main().catch((err) => {
  console.error("Failed to publish edition:", err);
  process.exit(1);
});
