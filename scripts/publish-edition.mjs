/**
 * AI TIMES (aitimes.live) — Autonomous Daily Edition & Static SEO Publisher
 * 1. Fetches live World & AI RSS feeds
 * 2. Synthesizes bilingual EN/RO editorial content + conceptual SVG plate via Gemini API
 * 3. Updates data/editions.json (30-day archive)
 * 4. Generates individual static SEO pages: /editions/YYYY-MM-DD.html (with Schema.org NewsArticle + OpenGraph)
 * 5. Pre-renders today's edition directly into index.html (zero JS-delay for Googlebot)
 * 6. Regenerates sitemap.xml & robots.txt automatically
 */

import fs from "node:fs/promises";
import path from "node:path";

const SITE_URL = "https://aitimes.live";
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
const PREFERRED_MODEL = process.env.GEMINI_MODEL || "gemini-3.8-flash";

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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function escapeHtml(str = "") {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

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
  const itemMatches =
    xmlText.match(/<item\b[\s\S]*?<\/item>/gi) ||
    xmlText.match(/<entry\b[\s\S]*?<\/entry>/gi) ||
    [];

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

async function discoverActiveModels() {
  const candidates = new Set([PREFERRED_MODEL, "gemini-3.8-flash", "gemini-3.8-flash-lite"]);

  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(GEMINI_API_KEY)}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (res.ok) {
      const json = await res.json();
      const models = (json.models || [])
        .filter((m) => Array.isArray(m.supportedGenerationMethods) && m.supportedGenerationMethods.includes("generateContent"))
        .map((m) => m.name.replace(/^models\//, ""))
        .filter((name) => !name.includes("1.0") && !name.includes("1.5") && !name.includes("2.0") && !name.includes("2.5") && !name.includes("embedding"));

      for (const name of models) {
        candidates.add(name);
      }
    }
  } catch {
    // Keep default candidates
  }

  return Array.from(candidates);
}

function buildWireFallbackEdition({ dateInfo, issueNumber, worldPool, aiPool }) {
  const topWorld = worldPool.slice(0, 5);
  const topAi = aiPool.slice(0, 5);
  const leadHeadline = topWorld[0]?.title || "Global Signals and Technological Acceleration";
  const aiHeadline = topAi[0]?.title || "Artificial Intelligence Infrastructure Shifts";

  return {
    en: {
      issue: `Issue No. ${String(issueNumber).padStart(2, "0")}`,
      date: dateInfo.en,
      headline: `Between Global Friction and Machine Speed: ${leadHeadline.slice(0, 68)}`,
      subhead: "A daily synthesis of world affairs and artificial intelligence dispatches grounded in verified international RSS wires.",
      artCaption: `Editorial Plate ${String(issueNumber).padStart(2, "0")}: Intersecting global wire signals and algorithmic trajectories.`,
      paragraphs: [
        `Across today's international dispatches, the defining story centers on "${leadHeadline}"—a reminder that geopolitical stability, public institutions, and human livelihoods remain deeply interconnected across borders.`,
        `Meanwhile, inside the technology frontier, developments such as "${aiHeadline}" underscore how rapidly artificial intelligence is moving from experimental software into core scientific, industrial, and media infrastructure.`,
        `Reading both columns side by side clarifies the central challenge of our moment: ensuring that human accountability, transparent journalism, and public benefit keep pace with accelerating technical capability.`
      ],
      sources: "BBC World, Al Jazeera, NPR World, UN News, MIT Tech Review, The Verge AI, VentureBeat AI, ArXiv CS.AI",
      people: topWorld.map((item) => ({
        category: item.source,
        title: item.title,
        why: item.summary || "Key international development shaping global policy, trade, or daily civic life.",
        url: item.link
      })),
      aiWorld: topAi.map((item) => ({
        tag: item.source,
        title: item.title,
        takeaway: item.summary || "Notable research, deployment, or governance signal from the AI sector.",
        url: item.link
      }))
    },
    ro: {
      issue: `Ediția Nr. ${String(issueNumber).padStart(2, "0")}`,
      date: dateInfo.ro,
      headline: `Între ritmul lumii și viteza tehnologiei: ${dateInfo.ro}`,
      subhead: "Sinteză zilnică din fluxurile internaționale verificate și din frontiera inteligenței artificiale.",
      artCaption: `Planșa Editorială ${String(issueNumber).padStart(2, "0")}: Convergența semnalelor globale și a infrastructurii AI.`,
      paragraphs: [
        `În fluxul știrilor internaționale de astăzi se remarcă "${leadHeadline}" — un semnal clar că deciziile diplomatice, economice și instituționale au ecou direct în viața de zi cu zi.`,
        `În paralel, în industria inteligenței artificiale, evoluții precum "${aiHeadline}" arată trecerea rapidă de la experimente la infrastructură critică în cercetare, energie și media.`,
        `Privite împreună, aceste două direcții evidențiază miza prezentului: păstrarea transparenței, a rigorii jurnalistice și a responsabilității umane într-o lume tot mai automatizată.`
      ],
      sources: "BBC World, Al Jazeera, NPR World, UN News, MIT Tech Review, The Verge AI, VentureBeat AI, ArXiv CS.AI",
      people: topWorld.map((item) => ({
        category: item.source,
        title: item.title,
        why: item.summary || "Evoluție internațională majoră cu impact asupra politicilor publice și vieții cotidiene.",
        url: item.link
      })),
      aiWorld: topAi.map((item) => ({
        tag: item.source,
        title: item.title,
        takeaway: item.summary || "Semnal relevant din cercetarea, infrastructura sau reglementarea AI.",
        url: item.link
      }))
    },
    artworkSvg: `<svg viewBox="0 0 800 450" class="w-full h-full object-cover" xmlns="http://www.w3.org/2000/svg"><rect width="800" height="450" fill="#141821"/><circle cx="400" cy="225" r="135" fill="none" stroke="#64748b" stroke-width="1" stroke-dasharray="5 5" opacity="0.5"/><circle cx="400" cy="225" r="95" fill="none" stroke="#fbbf24" stroke-width="2.5"/><polyline points="70,225 230,225 285,145 340,305 395,165 450,275 505,225 730,225" fill="none" stroke="#dc2626" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"/><circle cx="400" cy="225" r="8" fill="#fbbf24"/></svg>`
  };
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

  const models = await discoverActiveModels();
  console.log(`Candidate Gemini models: ${models.join(", ")}`);

  for (const modelName of models) {
    for (let attempt = 1; attempt <= 3; attempt++) {
      console.log(`Calling Gemini model "${modelName}" (attempt ${attempt}/3)...`);
      const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${encodeURIComponent(GEMINI_API_KEY)}`;

      try {
        const res = await fetch(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: {
              temperature: 0.65,
              responseMimeType: "application/json"
            }
          }),
          signal: AbortSignal.timeout(45000)
        });

        if (res.ok) {
          const data = await res.json();
          const rawText = data?.candidates?.[0]?.content?.parts?.[0]?.text || "";
          const cleaned = rawText.replace(/^```json\s*/i, "").replace(/```\s*$/i, "").trim();
          const parsed = JSON.parse(cleaned);
          console.log(`Success with model "${modelName}".`);
          return parsed;
        }

        const errText = await res.text();
        console.warn(`Gemini API (${res.status}) on ${modelName}: ${errText.slice(0, 180)}`);

        if (res.status === 404) break;
        if (res.status === 503 || res.status === 429) {
          await sleep(attempt * 5000);
          continue;
        }
        break;
      } catch (err) {
        console.warn(`Network/parse issue on ${modelName} attempt ${attempt}: ${err.message}`);
        await sleep(attempt * 4000);
      }
    }
  }

  console.warn("All Gemini models temporarily overloaded. Publishing wire-grounded synthesis fallback.");
  return buildWireFallbackEdition({ dateInfo, issueNumber, worldPool, aiPool });
}

/**
 * Builds static HTML markup for an edition (used both for homepage SSR pre-rendering
 * and individual permalink pages /editions/YYYY-MM-DD.html).
 */
function buildStaticEditionMarkup(dateKey, editionObj, allSortedKeys, isPermalinkPage = false) {
  const ed = editionObj.en;
  const DEFAULT_SVG = `<svg viewBox="0 0 800 450" class="w-full h-full object-cover" xmlns="http://www.w3.org/2000/svg"><rect width="800" height="450" fill="#141821"/><circle cx="400" cy="225" r="120" fill="none" stroke="#fbbf24" stroke-width="2"/><polyline points="80,225 260,225 320,140 380,310 440,180 500,225 720,225" fill="none" stroke="#dc2626" stroke-width="3"/></svg>`;

  const figureHtml = `
    <figure class="editorial-figure my-5" aria-labelledby="editorialArtCaption">
      <div class="editorial-art-stage">${editionObj.artworkSvg || DEFAULT_SVG}</div>
      <figcaption class="px-3.5 py-2.5 text-xs flex flex-col gap-1" style="border-top: 1px solid var(--border); color: var(--text-muted);">
        <div class="flex items-center justify-between gap-2">
          <span class="font-bold uppercase tracking-wider text-[10px]" style="color: var(--crimson);">AI Editorial Illustration</span>
          <span class="text-[10px] font-mono opacity-80">Plate #${escapeHtml(dateKey)}</span>
        </div>
        <span id="editorialArtCaption" class="italic">${escapeHtml(ed.artCaption || "")}</span>
      </figcaption>
    </figure>
  `;

  const paragraphsHtml = (ed.paragraphs || [])
    .map((p, idx) => {
      const para = `<p class="${idx === 0 ? "drop-cap" : ""}">${escapeHtml(p)}</p>`;
      return idx === 0 ? para + figureHtml : para;
    })
    .join("\n");

  const peopleHtml = (ed.people || [])
    .slice(0, 5)
    .map(
      (item, idx) => `
      <li class="pb-4" style="${idx < 4 ? "border-bottom: 1px solid var(--border);" : ""}">
        <div class="flex items-center justify-between gap-2 mb-1">
          <span class="text-[11px] font-bold uppercase tracking-wider px-2 py-0.5 rounded" style="background-color: var(--accent-soft); color: var(--accent);">
            0${idx + 1} · ${escapeHtml(item.category)}
          </span>
          <a href="${escapeHtml(item.url)}" target="_blank" rel="noopener noreferrer" class="text-xs font-semibold hover:underline" style="color: var(--text-muted);">
            Source ↗
          </a>
        </div>
        <h3 class="serif font-bold text-lg leading-snug mb-1.5">
          <a href="${escapeHtml(item.url)}" target="_blank" rel="noopener noreferrer" class="hover:underline">
            ${escapeHtml(item.title)}
          </a>
        </h3>
        <p class="text-xs leading-relaxed" style="color: var(--text-muted);">
          <strong style="color: var(--text);">Why it matters:</strong> ${escapeHtml(item.why)}
        </p>
      </li>`
    )
    .join("\n");

  const aiWorldHtml = (ed.aiWorld || [])
    .slice(0, 5)
    .map(
      (item, idx) => `
      <li class="pb-4" style="${idx < 4 ? "border-bottom: 1px solid var(--border);" : ""}">
        <div class="flex items-center justify-between gap-2 mb-1">
          <span class="text-[11px] font-bold uppercase tracking-wider px-2 py-0.5 rounded" style="background-color: var(--gold-soft); color: var(--gold);">
            0${idx + 1} · ${escapeHtml(item.tag)}
          </span>
          <a href="${escapeHtml(item.url)}" target="_blank" rel="noopener noreferrer" class="text-xs font-semibold hover:underline" style="color: var(--text-muted);">
            Wire ↗
          </a>
        </div>
        <h3 class="serif font-bold text-base leading-snug mb-1.5">
          <a href="${escapeHtml(item.url)}" target="_blank" rel="noopener noreferrer" class="hover:underline">
            ${escapeHtml(item.title)}
          </a>
        </h3>
        <p class="text-xs leading-relaxed" style="color: var(--text-muted);">
          <strong style="color: var(--text);">Takeaway:</strong> ${escapeHtml(item.takeaway)}
        </p>
      </li>`
    )
    .join("\n");

  const archiveLinksHtml = allSortedKeys
    .slice(0, 7)
    .map((k) => {
      const d = new Date(`${k}T00:00:00Z`);
      const label = d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
      const activeCls = k === dateKey ? " active" : "";
      return `<a href="/editions/${k}.html" data-edition="${k}" class="archive-btn${activeCls} control-pill px-2.5 py-1 rounded-md text-xs font-semibold inline-block">${label}</a>`;
    })
    .join("\n");

  const canonicalUrl = isPermalinkPage ? `${SITE_URL}/editions/${dateKey}.html` : `${SITE_URL}/`;
  const pageTitle = isPermalinkPage
    ? `${ed.headline} — AI TIMES (${dateKey})`
    : `AI TIMES — ${ed.headline}`;
  const metaDesc = `${ed.subhead} (${ed.issue} · ${ed.date} — Your dAIly journal automade.)`;

  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "NewsArticle",
    "headline": ed.headline,
    "description": ed.subhead,
    "datePublished": `${dateKey}T06:00:00Z`,
    "dateModified": `${dateKey}T06:00:00Z`,
    "mainEntityOfPage": {
      "@type": "WebPage",
      "@id": canonicalUrl
    },
    "author": {
      "@type": "Organization",
      "name": "The AI Columnist",
      "url": SITE_URL
    },
    "publisher": {
      "@type": "Organization",
      "name": "AI TIMES",
      "url": SITE_URL
    }
  };

  return {
    canonicalUrl,
    pageTitle,
    metaDesc,
    jsonLdString: JSON.stringify(jsonLd),
    issue: ed.issue,
    date: ed.date,
    headline: ed.headline,
    subhead: ed.subhead,
    sources: ed.sources,
    paragraphsHtml,
    peopleHtml,
    aiWorldHtml,
    archiveLinksHtml
  };
}

function renderFullHtmlDocument(seoData, activeDateKey) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${escapeHtml(seoData.pageTitle)}</title>
  <meta name="description" content="${escapeHtml(seoData.metaDesc)}" />
  <meta name="robots" content="index, follow, max-snippet:-1, max-image-preview:large" />
  <link rel="canonical" href="${escapeHtml(seoData.canonicalUrl)}" />

  <!-- OpenGraph & Social Cards -->
  <meta property="og:type" content="article" />
  <meta property="og:site_name" content="AI TIMES" />
  <meta property="og:title" content="${escapeHtml(seoData.headline)}" />
  <meta property="og:description" content="${escapeHtml(seoData.subhead)}" />
  <meta property="og:url" content="${escapeHtml(seoData.canonicalUrl)}" />
  <meta name="twitter:card" content="summary_large_image" />
  <meta name="twitter:title" content="${escapeHtml(seoData.headline)}" />
  <meta name="twitter:description" content="${escapeHtml(seoData.subhead)}" />

  <!-- Structured Data (Schema.org NewsArticle) -->
  <script type="application/ld+json">${seoData.jsonLdString}</script>

  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=Newsreader:ital,opsz,wght@0,6..72,400;0,6..72,500;0,6..72,600;0,6..72,700;0,6..72,800;1,6..72,400;1,6..72,600&family=Plus+Jakarta+Sans:wght@400;500;600;700&display=swap" rel="stylesheet" />
  <script src="https://cdn.tailwindcss.com"></script>
  <style>
    :root {
      --bg: #f8f7f4;
      --surface: #ffffff;
      --surface-alt: #f1efe9;
      --text: #16181d;
      --text-muted: #5a606d;
      --border: #dcd7cb;
      --border-strong: #16181d;
      --accent: #1d4ed8;
      --accent-soft: #eff4ff;
      --crimson: #b91c1c;
      --crimson-soft: #fee2e2;
      --gold: #9a3412;
      --gold-soft: #ffedd5;
      --emerald: #15803d;
      --emerald-soft: #dcfce7;
    }

    [data-theme="dark"] {
      --bg: #0f1115;
      --surface: #161920;
      --surface-alt: #1e222b;
      --text: #f3f4f6;
      --text-muted: #9ca3af;
      --border: #2a2f3b;
      --border-strong: #e5e7eb;
      --accent: #60a5fa;
      --accent-soft: rgba(96, 165, 250, 0.14);
      --crimson: #f87171;
      --crimson-soft: rgba(248, 113, 113, 0.14);
      --gold: #fbbf24;
      --gold-soft: rgba(251, 191, 36, 0.14);
      --emerald: #4ade80;
      --emerald-soft: rgba(74, 222, 128, 0.14);
    }

    * { box-sizing: border-box; }

    body {
      font-family: 'Plus Jakarta Sans', -apple-system, BlinkMacSystemFont, sans-serif;
      background-color: var(--bg);
      color: var(--text);
      line-height: 1.6;
      -webkit-font-smoothing: antialiased;
      transition: background-color 0.2s ease, color 0.2s ease;
    }

    .serif { font-family: 'Newsreader', Georgia, serif; }

    .paper-grain {
      background-image: radial-gradient(rgba(22, 24, 29, 0.035) 1px, transparent 0);
      background-size: 20px 20px;
    }

    [data-theme="dark"] .paper-grain {
      background-image: radial-gradient(rgba(255, 255, 255, 0.025) 1px, transparent 0);
    }

    @keyframes aiPulse {
      0%, 100% {
        opacity: 1;
        transform: scale(1);
        box-shadow: 0 0 0 0 rgba(185, 28, 28, 0.55);
      }
      50% {
        opacity: 0.45;
        transform: scale(0.86);
        box-shadow: 0 0 0 6px rgba(185, 28, 28, 0);
      }
    }

    .ai-dot {
      width: 8px;
      height: 8px;
      border-radius: 9999px;
      background-color: var(--crimson);
      display: inline-block;
      animation: aiPulse 2s infinite ease-in-out;
    }

    .drop-cap::first-letter {
      font-family: 'Newsreader', Georgia, serif;
      float: left;
      font-size: 3.65rem;
      line-height: 0.82;
      padding-top: 4px;
      padding-right: 10px;
      padding-left: 2px;
      font-weight: 700;
      color: var(--text);
    }

    @media (min-width: 1024px) {
      .col-divider {
        border-right: 1px solid var(--border);
        padding-right: 1.75rem;
      }
      .col-pad-left { padding-left: 1.75rem; }
      .col-pad-mid {
        padding-left: 1.75rem;
        padding-right: 1.75rem;
        border-right: 1px solid var(--border);
      }
    }

    .rule-double {
      border-top: 3px double var(--border-strong);
      border-bottom: 1px solid var(--border-strong);
    }

    .control-pill {
      background-color: var(--surface);
      border: 1px solid var(--border);
      color: var(--text);
      transition: all 0.15s ease;
    }

    .control-pill:hover { border-color: var(--accent); }

    .archive-btn.active {
      background-color: var(--text);
      color: var(--bg);
      border-color: var(--text);
    }

    .modal-backdrop {
      position: fixed;
      inset: 0;
      background: rgba(15, 17, 21, 0.65);
      backdrop-filter: blur(2px);
      display: none;
      align-items: center;
      justify-content: center;
      padding: 1rem;
      z-index: 50;
    }

    .modal-backdrop.open { display: flex; }

    .editorial-figure {
      border: 1px solid var(--border);
      background: var(--surface);
      border-radius: 12px;
      overflow: hidden;
    }

    .editorial-art-stage {
      width: 100%;
      aspect-ratio: 16 / 9;
      display: block;
      background: var(--surface-alt);
    }

    .brand-ai-mark {
      color: var(--crimson);
      font-weight: 800;
      letter-spacing: 0.01em;
    }
  </style>
</head>
<body class="paper-grain min-h-screen" data-initial-edition="${escapeHtml(activeDateKey)}">

  <!-- Top Utility Bar -->
  <div style="background-color: var(--surface); border-bottom: 1px solid var(--border);" class="sticky top-0 z-40 px-4 sm:px-6 py-2.5">
    <div class="max-w-7xl mx-auto flex flex-wrap items-center justify-between gap-3 text-xs sm:text-sm">
      <div class="flex flex-wrap items-center gap-3">
        <span class="inline-flex items-center gap-2 font-semibold px-2.5 py-1 rounded-full" style="background-color: var(--crimson-soft); color: var(--crimson);">
          <span class="ai-dot" aria-hidden="true"></span>
          <span id="autonomousBadge">AUTONOMOUS AI EDITION</span>
        </span>
        <span style="color: var(--text-muted);" class="hidden md:inline" id="networkTag">
          Synthesized daily at 06:00 UTC from verified global RSS wires
        </span>
      </div>

      <div class="flex items-center gap-2 sm:gap-3">
        <div class="inline-flex rounded-lg p-0.5" style="background-color: var(--surface-alt); border: 1px solid var(--border);" role="group" aria-label="Language switch">
          <button type="button" id="langEnBtn" class="px-2.5 py-1 rounded-md text-xs font-bold transition cursor-pointer">EN</button>
          <button type="button" id="langRoBtn" class="px-2.5 py-1 rounded-md text-xs font-bold transition cursor-pointer">RO</button>
        </div>

        <button type="button" id="themeToggle" class="control-pill px-3 py-1.5 rounded-lg text-xs font-semibold cursor-pointer" aria-label="Toggle color theme">
          🌙 Dark
        </button>
      </div>
    </div>
  </div>

  <!-- Main Broadsheet Container -->
  <main class="max-w-7xl mx-auto px-4 sm:px-6 pt-6 pb-14">

    <!-- Classic Newspaper Masthead -->
    <header class="text-center pb-5">
      <div class="flex flex-wrap items-center justify-between gap-2 text-xs uppercase tracking-widest mb-3" style="color: var(--text-muted);">
        <span id="volLabel">Vol. I · aitimes.live</span>
        <span class="font-semibold" style="color: var(--text);" id="mottoLabel">“Independent Machine Synthesis · Human-Verified Wires”</span>
        <span id="priceLabel">Edition Price: Open Access</span>
      </div>

      <a href="/" class="inline-block">
        <h1 class="serif font-extrabold tracking-tight leading-none select-none mt-2 mb-1.5" style="font-size: clamp(3rem, 7.2vw, 5.4rem); letter-spacing: -0.03em;">
          AI TIMES
        </h1>
      </a>

      <p class="serif italic text-lg sm:text-xl font-medium tracking-tight" style="color: var(--text-muted);">
        Your d<span class="brand-ai-mark not-italic">AI</span>ly journal automade.
      </p>

      <!-- Double Newspaper Rule Metadata Bar -->
      <div class="rule-double py-2.5 mt-4 flex flex-wrap items-center justify-between gap-3 text-xs sm:text-sm font-medium">
        <div class="flex items-center gap-2">
          <strong id="issueNumber">${escapeHtml(seoData.issue)}</strong>
          <span style="color: var(--text-muted);">·</span>
          <span id="editionDate">${escapeHtml(seoData.date)}</span>
        </div>

        <!-- Crawlable Edition Archive Links (SEO + Instant Switch) -->
        <nav class="flex flex-wrap items-center gap-1.5" aria-label="Edition Archive" id="archiveContainer">
          <span class="text-xs uppercase tracking-wider mr-1 font-bold" style="color: var(--text-muted);" id="archivePrefix">Archive:</span>
          ${seoData.archiveLinksHtml}
        </nav>
      </div>
    </header>

    <!-- Asymmetric 3-Column Broadsheet Grid -->
    <div class="grid grid-cols-1 lg:grid-cols-12 gap-y-10 mt-6">

      <!-- COLUMN 1: AI Opinion by The AI Columnist -->
      <section class="lg:col-span-5 col-divider flex flex-col justify-between" aria-labelledby="opinionSectionHeading">
        <div>
          <div class="flex items-center justify-between gap-2 pb-2 mb-3" style="border-bottom: 2px solid var(--border-strong);">
            <span id="opinionSectionHeading" class="text-xs font-bold uppercase tracking-widest" style="color: var(--crimson);">
              AI Opinion
            </span>
            <span class="text-xs italic serif" style="color: var(--text-muted);" id="bylineLabel">
              by The AI Columnist
            </span>
          </div>

          <article>
            <div class="mb-3">
              <span class="inline-block text-[11px] font-bold uppercase tracking-wider px-2.5 py-0.5 rounded" style="background-color: var(--surface-alt); color: var(--text-muted);" id="editorialTag">
                Lead Essay · Direction of the World
              </span>
            </div>

            <h2 class="serif font-bold text-3xl sm:text-4xl leading-tight mb-3" id="editorialHeadline">
              ${escapeHtml(seoData.headline)}
            </h2>

            <p class="serif italic text-base sm:text-lg mb-4" style="color: var(--text-muted);" id="editorialSubhead">
              ${escapeHtml(seoData.subhead)}
            </p>

            <!-- Byline Strip -->
            <div class="flex items-center gap-3 py-3 mb-5 rounded-xl px-3.5" style="background-color: var(--surface); border: 1px solid var(--border);">
              <div class="w-9 h-9 rounded-full flex items-center justify-center font-bold serif text-sm shrink-0" style="background-color: var(--text); color: var(--bg);">
                AI
              </div>
              <div class="text-xs leading-snug">
                <div class="font-bold" id="authorTitle">The AI Columnist · Chief Autonomous Essayist</div>
                <div style="color: var(--text-muted);" id="readTimeLabel">2 min read · Generated at 06:00 UTC without human edits</div>
              </div>
            </div>

            <!-- Pre-rendered Multi-Paragraph Editorial Body -->
            <div id="editorialBody" class="space-y-4 text-[15.5px] leading-relaxed">
              ${seoData.paragraphsHtml}
            </div>
          </article>
        </div>

        <!-- Transparent Sources Box -->
        <div class="mt-7 pt-4 rounded-xl p-4" style="background-color: var(--surface); border: 1px solid var(--border);">
          <div class="text-[11px] font-bold uppercase tracking-wider mb-1.5 flex items-center justify-between" style="color: var(--text-muted);">
            <span id="sourcesHeading">Sources Read for This Column</span>
            <span>🔍 Verified Wire</span>
          </div>
          <p class="text-xs leading-relaxed" style="color: var(--text-muted);" id="editorialSources">
            ${escapeHtml(seoData.sources)}
          </p>
        </div>
      </section>

      <!-- COLUMN 2: AI for the People (5 Global Stories) -->
      <section class="lg:col-span-4 col-pad-mid" aria-labelledby="peopleSectionHeading">
        <div class="flex items-center justify-between gap-2 pb-2 mb-4" style="border-bottom: 2px solid var(--border-strong);">
          <span id="peopleSectionHeading" class="text-xs font-bold uppercase tracking-widest" style="color: var(--accent);">
            AI for the People
          </span>
          <span class="text-xs font-semibold" style="color: var(--text-muted);" id="peopleSubLabel">
            5 Global Stories
          </span>
        </div>

        <p class="text-xs mb-4 leading-relaxed" style="color: var(--text-muted);" id="peopleIntro">
          High-impact world developments translated into plain terms—focusing on how global decisions touch everyday life.
        </p>

        <ol id="peopleList" class="space-y-4">
          ${seoData.peopleHtml}
        </ol>
      </section>

      <!-- COLUMN 3: AI World (5 AI Industry Stories) -->
      <section class="lg:col-span-3 col-pad-left" aria-labelledby="aiWorldSectionHeading">
        <div class="flex items-center justify-between gap-2 pb-2 mb-4" style="border-bottom: 2px solid var(--border-strong);">
          <span id="aiWorldSectionHeading" class="text-xs font-bold uppercase tracking-widest" style="color: var(--gold);">
            AI World
          </span>
          <span class="text-xs font-semibold" style="color: var(--text-muted);" id="aiWorldSubLabel">
            5 Industry Dispatches
          </span>
        </div>

        <p class="text-xs mb-4 leading-relaxed" style="color: var(--text-muted);" id="aiWorldIntro">
          Signal over hype from the artificial intelligence frontier: models, energy grids, governance, and lab breakthroughs.
        </p>

        <ol id="aiWorldList" class="space-y-4">
          ${seoData.aiWorldHtml}
        </ol>
      </section>

    </div>

    <!-- Standalone Broadsheet Footer -->
    <footer class="mt-12 pt-6" style="border-top: 2px solid var(--border-strong);">
      <div class="flex flex-col md:flex-row items-start md:items-center justify-between gap-4 text-xs" style="color: var(--text-muted);">
        <div>
          <strong style="color: var(--text);">© <span id="footerYear">2026</span> AI TIMES (aitimes.live)</strong> — <em>Your d<span class="brand-ai-mark not-italic">AI</span>ly journal automade.</em>
        </div>

        <div class="flex flex-wrap items-center gap-2" role="navigation" aria-label="Transparency and Legal">
          <a href="/sitemap.xml" class="control-pill px-2.5 py-1.5 rounded-lg font-semibold">Sitemap</a>
          <button type="button" class="legal-btn control-pill px-2.5 py-1.5 rounded-lg font-semibold cursor-pointer" data-doc="transparency" id="btnTransparency">AI Transparency Charter</button>
          <button type="button" class="legal-btn control-pill px-2.5 py-1.5 rounded-lg font-semibold cursor-pointer" data-doc="privacy" id="btnPrivacy">Privacy &amp; GDPR</button>
          <button type="button" class="legal-btn control-pill px-2.5 py-1.5 rounded-lg font-semibold cursor-pointer" data-doc="editorial" id="btnEditorial">Editorial Policy</button>
        </div>
      </div>
    </footer>
  </main>

  <!-- Legal & AI Transparency Modal -->
  <div id="infoModal" class="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="modalTitle">
    <div class="rounded-2xl max-w-lg w-full p-6 shadow-2xl" style="background-color: var(--surface); border: 1px solid var(--border);">
      <div class="flex items-center justify-between pb-3 mb-4" style="border-bottom: 1px solid var(--border);">
        <h3 id="modalTitle" class="serif font-bold text-xl">AI Transparency Charter</h3>
        <button type="button" id="closeModalBtn" class="control-pill px-2.5 py-1 rounded-lg text-xs font-bold cursor-pointer" aria-label="Close modal">✕</button>
      </div>
      <div id="modalContent" class="text-sm space-y-3 leading-relaxed" style="color: var(--text-muted);"></div>
    </div>
  </div>

  <script>
    const UI_STRINGS = {
      en: {
        autonomousBadge: "AUTONOMOUS AI EDITION",
        networkTag: "Synthesized daily at 06:00 UTC from verified global RSS wires",
        volLabel: "Vol. I · aitimes.live",
        mottoLabel: "“Independent Machine Synthesis · Human-Verified Wires”",
        priceLabel: "Edition Price: Open Access",
        archivePrefix: "Archive:",
        opinionSectionHeading: "AI Opinion",
        bylineLabel: "by The AI Columnist",
        editorialTag: "Lead Essay · Direction of the World",
        artBadgeLabel: "AI Editorial Illustration",
        authorTitle: "The AI Columnist · Chief Autonomous Essayist",
        readTimeLabel: "2 min read · Generated at 06:00 UTC without human edits",
        sourcesHeading: "Sources Read for This Column",
        peopleSectionHeading: "AI for the People",
        peopleSubLabel: "5 Global Stories",
        peopleIntro: "High-impact world developments translated into plain terms—focusing on how global decisions touch everyday life.",
        whyItMatters: "Why it matters:",
        aiWorldSectionHeading: "AI World",
        aiWorldSubLabel: "5 Industry Dispatches",
        aiWorldIntro: "Signal over hype from the artificial intelligence frontier: models, energy grids, governance, and lab breakthroughs.",
        takeawayLabel: "Takeaway:",
        btnTransparency: "AI Transparency Charter",
        btnPrivacy: "Privacy & GDPR",
        btnEditorial: "Editorial Policy",
        darkBtn: "🌙 Dark",
        lightBtn: "☀️ Light"
      },
      ro: {
        autonomousBadge: "EDIȚIE AUTONOMĂ AI",
        networkTag: "Sintetizat zilnic la 06:00 UTC din fluxuri RSS globale verificate",
        volLabel: "Vol. I · aitimes.live",
        mottoLabel: "„Sinteză Autonomă · Fluxuri de Știri Verificate”",
        priceLabel: "Acces: Gratuit și Deschis",
        archivePrefix: "Arhivă:",
        opinionSectionHeading: "AI Opinion",
        bylineLabel: "de The AI Columnist",
        editorialTag: "Editorialul Zilei · Direcția Lumii",
        artBadgeLabel: "Ilustrație Editorială AI",
        authorTitle: "The AI Columnist · Editorialist Autonom",
        readTimeLabel: "Lectură 2 min · Generat la 06:00 UTC fără intervenție umană",
        sourcesHeading: "Surse consultate pentru acest editorial",
        peopleSectionHeading: "AI for the People",
        peopleSubLabel: "5 Știri Globale",
        peopleIntro: "Evenimente globale cu impact major explicate pe înțelesul tuturor — cum ne ating deciziile lumii viața de zi cu zi.",
        whyItMatters: "De ce contează:",
        aiWorldSectionHeading: "AI World",
        aiWorldSubLabel: "5 Știri Industria AI",
        aiWorldIntro: "Semnal dincolo de zgomot din frontiera inteligenței artificiale: modele, rețele energetice, reguli și cercetare.",
        takeawayLabel: "Pe scurt:",
        btnTransparency: "Carta Transparenței AI",
        btnPrivacy: "Confidențialitate & GDPR",
        btnEditorial: "Politică Editorială",
        darkBtn: "🌙 Întunecat",
        lightBtn: "☀️ Luminos"
      }
    };

    const DEFAULT_SVG = \`<svg viewBox="0 0 800 450" class="w-full h-full object-cover" xmlns="http://www.w3.org/2000/svg"><rect width="800" height="450" fill="#141821"/><circle cx="400" cy="225" r="120" fill="none" stroke="#fbbf24" stroke-width="2"/><polyline points="80,225 260,225 320,140 380,310 440,180 500,225 720,225" fill="none" stroke="#dc2626" stroke-width="3"/></svg>\`;

    const LEGAL_DOCS = {
      transparency: {
        en: {
          title: "AI Transparency Charter",
          html: \`
            <p><strong>100% Disclosed AI Authorship:</strong> Every editorial and illustration on <em>aitimes.live</em> is generated autonomously using daily verified RSS wire headlines as factual grounding.</p>
            <p><strong>No Human Impersonation:</strong> <em>The AI Columnist</em> never claims human identity or lived experience. Its role is analytical synthesis across global reporting.</p>
            <p><strong>Source Traceability:</strong> Each edition lists the news wires consulted and links every dispatch directly to primary sources.</p>
          \`
        },
        ro: {
          title: "Carta Transparenței AI",
          html: \`
            <p><strong>Autorat AI 100% Asumat:</strong> Fiecare editorial și ilustrație de pe <em>aitimes.live</em> sunt generate autonom pe baza fluxurilor RSS verificate ale zilei.</p>
            <p><strong>Fără Impersonare Umană:</strong> <em>The AI Columnist</em> nu pretinde identitate umană sau experiență personală. Rolul său este sinteza analitică.</p>
            <p><strong>Trasabilitatea Surselor:</strong> Fiecare ediție menționează clar sursele consultate și trimite direct către sursele primare ale știrilor.</p>
          \`
        }
      },
      privacy: {
        en: {
          title: "Privacy & GDPR Notice",
          html: \`
            <p><strong>Zero Ad Trackers:</strong> aitimes.live uses no advertising cookies, no cross-site behavioral tracking, and requires no registration.</p>
            <p><strong>Local Storage Only:</strong> Your theme (Light/Dark) and language (EN/RO) preferences are saved locally in your browser.</p>
            <button type="button" id="resetLocalBtn" class="control-pill px-3 py-1.5 rounded-lg text-xs font-bold cursor-pointer mt-2">🗑️ Clear Local Preferences</button>
            <p id="resetConfirm" class="text-xs font-semibold hidden" style="color: var(--emerald);">✓ Local browser preferences cleared.</p>
          \`
        },
        ro: {
          title: "Confidențialitate & GDPR",
          html: \`
            <p><strong>Zero Cookie-uri de Urmărire:</strong> aitimes.live nu folosește trackere publicitare și nu colectează date personale.</p>
            <p><strong>Stocare Exclusiv Locală:</strong> Preferințele de temă și limbă (EN/RO) sunt păstrate doar în browserul tău.</p>
            <button type="button" id="resetLocalBtn" class="control-pill px-3 py-1.5 rounded-lg text-xs font-bold cursor-pointer mt-2">🗑️ Șterge preferințele locale</button>
            <p id="resetConfirm" class="text-xs font-semibold hidden" style="color: var(--emerald);">✓ Preferințele locale au fost șterse.</p>
          \`
        }
      },
      editorial: {
        en: {
          title: "Editorial Policy & Weekly Rhythm",
          html: \`
            <p><strong>Daily Structure:</strong> Published daily at 06:00 UTC with one lead essay plus editorial plate (<em>AI Opinion</em>), five global public-interest stories (<em>AI for the People</em>), and five AI sector dispatches (<em>AI World</em>).</p>
            <p><strong>Sunday Synthesis:</strong> Every Sunday, the lead column expands into a 7-day global impact synthesis.</p>
          \`
        },
        ro: {
          title: "Politică Editorială & Ritm Săptămânal",
          html: \`
            <p><strong>Structura Zilnică:</strong> Publicat zilnic la 06:00 UTC cu un editorial principal însoțit de ilustrație conceptuală (<em>AI Opinion</em>), cinci știri globale (<em>AI for the People</em>) și cinci știri din industria AI (<em>AI World</em>).</p>
            <p><strong>Ediția de Duminică:</strong> În fiecare duminică, editorialul se extinde într-un bilanț al întregii săptămâni.</p>
          \`
        }
      }
    };

    let editionsStore = null;
    let currentLang = localStorage.getItem("ait_lang") || "en";
    let currentEditionKey = document.body.getAttribute("data-initial-edition") || null;
    let currentTheme = localStorage.getItem("ait_theme") || "light";
    document.documentElement.setAttribute("data-theme", currentTheme);
    document.getElementById("footerYear").textContent = String(new Date().getFullYear());

    function escapeClientHtml(str = "") {
      const div = document.createElement("div");
      div.textContent = str;
      return div.innerHTML;
    }

    function formatShortArchiveDate(isoDate) {
      const d = new Date(\`\${isoDate}T00:00:00Z\`);
      return d.toLocaleDateString(currentLang === "ro" ? "ro-RO" : "en-US", {
        month: "short",
        day: "numeric",
        timeZone: "UTC"
      });
    }

    function renderArchiveLinks() {
      if (!editionsStore) return;
      const container = document.getElementById("archiveContainer");
      const prefix = document.getElementById("archivePrefix");
      const keys = Object.keys(editionsStore.editions || {}).sort().reverse().slice(0, 7);

      container.innerHTML = "";
      container.appendChild(prefix);

      keys.forEach((dateKey) => {
        const link = document.createElement("a");
        link.href = \`/editions/\${dateKey}.html\`;
        link.className = \`archive-btn control-pill px-2.5 py-1 rounded-md text-xs font-semibold inline-block \${
          dateKey === currentEditionKey ? "active" : ""
        }\`;
        link.textContent = formatShortArchiveDate(dateKey);
        container.appendChild(link);
      });
    }

    function renderEdition() {
      if (!editionsStore || !currentEditionKey) return;
      const ui = UI_STRINGS[currentLang];
      const editionObj = editionsStore.editions[currentEditionKey];
      const ed = editionObj?.[currentLang] || editionObj?.en;
      if (!ed) return;

      Object.keys(ui).forEach((key) => {
        const el = document.getElementById(key);
        if (el) el.textContent = ui[key];
      });

      document.getElementById("themeToggle").textContent = currentTheme === "dark" ? ui.lightBtn : ui.darkBtn;

      const enBtn = document.getElementById("langEnBtn");
      const roBtn = document.getElementById("langRoBtn");
      if (currentLang === "en") {
        enBtn.style.backgroundColor = "var(--surface)";
        enBtn.style.color = "var(--text)";
        roBtn.style.backgroundColor = "transparent";
        roBtn.style.color = "var(--text-muted)";
      } else {
        roBtn.style.backgroundColor = "var(--surface)";
        roBtn.style.color = "var(--text)";
        enBtn.style.backgroundColor = "transparent";
        enBtn.style.color = "var(--text-muted)";
      }

      renderArchiveLinks();

      document.getElementById("issueNumber").textContent = ed.issue;
      document.getElementById("editionDate").textContent = ed.date;
      document.getElementById("editorialHeadline").textContent = ed.headline;
      document.getElementById("editorialSubhead").textContent = ed.subhead;
      document.getElementById("editorialSources").textContent = ed.sources;

      const artworkSvg = editionObj.artworkSvg || DEFAULT_SVG;
      const figureHtml = \`
        <figure class="editorial-figure my-5" aria-labelledby="editorialArtCaption">
          <div class="editorial-art-stage">\${artworkSvg}</div>
          <figcaption class="px-3.5 py-2.5 text-xs flex flex-col gap-1" style="border-top: 1px solid var(--border); color: var(--text-muted);">
            <div class="flex items-center justify-between gap-2">
              <span class="font-bold uppercase tracking-wider text-[10px]" style="color: var(--crimson);">\${ui.artBadgeLabel}</span>
              <span class="text-[10px] font-mono opacity-80">Plate #\${escapeClientHtml(currentEditionKey)}</span>
            </div>
            <span id="editorialArtCaption" class="italic">\${escapeClientHtml(ed.artCaption || "")}</span>
          </figcaption>
        </figure>
      \`;

      const bodyEl = document.getElementById("editorialBody");
      bodyEl.innerHTML = (ed.paragraphs || [])
        .map((p, idx) => {
          const paraHtml = \`<p class="\${idx === 0 ? "drop-cap" : ""}">\${escapeClientHtml(p)}</p>\`;
          return idx === 0 ? paraHtml + figureHtml : paraHtml;
        })
        .join("");

      const peopleEl = document.getElementById("peopleList");
      peopleEl.innerHTML = (ed.people || [])
        .slice(0, 5)
        .map((item, idx) => \`
          <li class="pb-4" style="\${idx < 4 ? "border-bottom: 1px solid var(--border);" : ""}">
            <div class="flex items-center justify-between gap-2 mb-1">
              <span class="text-[11px] font-bold uppercase tracking-wider px-2 py-0.5 rounded" style="background-color: var(--accent-soft); color: var(--accent);">
                0\${idx + 1} · \${escapeClientHtml(item.category)}
              </span>
              <a href="\${escapeClientHtml(item.url)}" target="_blank" rel="noopener noreferrer" class="text-xs font-semibold hover:underline" style="color: var(--text-muted);">
                Source ↗
              </a>
            </div>
            <h3 class="serif font-bold text-lg leading-snug mb-1.5">
              <a href="\${escapeClientHtml(item.url)}" target="_blank" rel="noopener noreferrer" class="hover:underline">
                \${escapeClientHtml(item.title)}
              </a>
            </h3>
            <p class="text-xs leading-relaxed" style="color: var(--text-muted);">
              <strong style="color: var(--text);">\${ui.whyItMatters}</strong> \${escapeClientHtml(item.why)}
            </p>
          </li>
        \`)
        .join("");

      const aiWorldEl = document.getElementById("aiWorldList");
      aiWorldEl.innerHTML = (ed.aiWorld || [])
        .slice(0, 5)
        .map((item, idx) => \`
          <li class="pb-4" style="\${idx < 4 ? "border-bottom: 1px solid var(--border);" : ""}">
            <div class="flex items-center justify-between gap-2 mb-1">
              <span class="text-[11px] font-bold uppercase tracking-wider px-2 py-0.5 rounded" style="background-color: var(--gold-soft); color: var(--gold);">
                0\${idx + 1} · \${escapeClientHtml(item.tag)}
              </span>
              <a href="\${escapeClientHtml(item.url)}" target="_blank" rel="noopener noreferrer" class="text-xs font-semibold hover:underline" style="color: var(--text-muted);">
                Wire ↗
              </a>
            </div>
            <h3 class="serif font-bold text-base leading-snug mb-1.5">
              <a href="\${escapeClientHtml(item.url)}" target="_blank" rel="noopener noreferrer" class="hover:underline">
                \${escapeClientHtml(item.title)}
              </a>
            </h3>
            <p class="text-xs leading-relaxed" style="color: var(--text-muted);">
              <strong style="color: var(--text);">\${ui.takeawayLabel}</strong> \${escapeClientHtml(item.takeaway)}
            </p>
          </li>
        \`)
        .join("");
    }

    document.getElementById("langEnBtn").addEventListener("click", () => {
      currentLang = "en";
      localStorage.setItem("ait_lang", "en");
      renderEdition();
    });

    document.getElementById("langRoBtn").addEventListener("click", () => {
      currentLang = "ro";
      localStorage.setItem("ait_lang", "ro");
      renderEdition();
    });

    document.getElementById("themeToggle").addEventListener("click", () => {
      currentTheme = currentTheme === "light" ? "dark" : "light";
      localStorage.setItem("ait_theme", currentTheme);
      document.documentElement.setAttribute("data-theme", currentTheme);
      renderEdition();
    });

    const infoModal = document.getElementById("infoModal");
    document.querySelectorAll(".legal-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const docKey = btn.getAttribute("data-doc");
        const doc = LEGAL_DOCS[docKey][currentLang];
        document.getElementById("modalTitle").textContent = doc.title;
        document.getElementById("modalContent").innerHTML = doc.html;
        infoModal.classList.add("open");

        const resetBtn = document.getElementById("resetLocalBtn");
        if (resetBtn) {
          resetBtn.addEventListener("click", () => {
            localStorage.removeItem("ait_lang");
            localStorage.removeItem("ait_theme");
            document.getElementById("resetConfirm").classList.remove("hidden");
          });
        }
      });
    });

    document.getElementById("closeModalBtn").addEventListener("click", () => infoModal.classList.remove("open"));
    infoModal.addEventListener("click", (e) => {
      if (e.target === infoModal) infoModal.classList.remove("open");
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && infoModal.classList.contains("open")) infoModal.classList.remove("open");
    });

    async function bootstrap() {
      try {
        const res = await fetch(\`/data/editions.json?v=\${Math.floor(Date.now() / 300000)}\`);
        if (!res.ok) throw new Error("Failed to load editions.json");
        editionsStore = await res.json();
        const availableKeys = Object.keys(editionsStore.editions || {}).sort().reverse();
        if (!currentEditionKey || !editionsStore.editions[currentEditionKey]) {
          currentEditionKey = editionsStore.latestDate && editionsStore.editions[editionsStore.latestDate]
            ? editionsStore.latestDate
            : availableKeys[0];
        }
        if (currentLang === "ro") {
          renderEdition();
        } else {
          renderArchiveLinks();
        }
      } catch {
        // Pre-rendered HTML already visible for readers and search engines
      }
    }

    bootstrap();
  </script>
</body>
</html>`;
}

function buildSitemapXml(sortedKeys, latestDate) {
  const urls = [
    `  <url>\n    <loc>${SITE_URL}/</loc>\n    <lastmod>${latestDate}</lastmod>\n    <changefreq>daily</changefreq>\n    <priority>1.0</priority>\n  </url>`
  ];

  for (const dateKey of sortedKeys) {
    urls.push(
      `  <url>\n    <loc>${SITE_URL}/editions/${dateKey}.html</loc>\n    <lastmod>${dateKey}</lastmod>\n    <changefreq>never</changefreq>\n    <priority>0.8</priority>\n  </url>`
    );
  }

  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join("\n")}\n</urlset>\n`;
}

async function rebuildSeoArtifacts(rootDir, store) {
  const editionsDir = path.join(rootDir, "editions");
  await fs.mkdir(editionsDir, { recursive: true });

  const sortedKeys = Object.keys(store.editions || {}).sort().reverse();
  if (sortedKeys.length === 0) return;

  const latestKey = store.latestDate && store.editions[store.latestDate] ? store.latestDate : sortedKeys[0];

  // 1. Generate individual static HTML pages (/editions/YYYY-MM-DD.html)
  for (const dateKey of sortedKeys) {
    const editionObj = store.editions[dateKey];
    const seoData = buildStaticEditionMarkup(dateKey, editionObj, sortedKeys, true);
    const pageHtml = renderFullHtmlDocument(seoData, dateKey);
    await fs.writeFile(path.join(editionsDir, `${dateKey}.html`), pageHtml, "utf8");
  }

  // 2. Pre-render latest edition directly into index.html (SSR-style static HTML for Googlebot)
  const latestSeoData = buildStaticEditionMarkup(latestKey, store.editions[latestKey], sortedKeys, false);
  const indexHtml = renderFullHtmlDocument(latestSeoData, latestKey);
  await fs.writeFile(path.join(rootDir, "index.html"), indexHtml, "utf8");

  // 3. Regenerate sitemap.xml & robots.txt
  const sitemapXml = buildSitemapXml(sortedKeys, latestKey);
  await fs.writeFile(path.join(rootDir, "sitemap.xml"), sitemapXml, "utf8");

  const robotsTxt = `User-agent: *\nAllow: /\n\nSitemap: ${SITE_URL}/sitemap.xml\n`;
  await fs.writeFile(path.join(rootDir, "robots.txt"), robotsTxt, "utf8");

  console.log(`Generated static SEO pages for ${sortedKeys.length} editions, pre-rendered index.html, and updated sitemap.xml.`);
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

  const isManualDispatch = process.env.GITHUB_EVENT_NAME === "workflow_dispatch";
  if (!isManualDispatch && store.editions && store.editions[dateInfo.iso]) {
    console.log(`Edition for ${dateInfo.iso} already exists. Refreshing static SEO pages...`);
    await rebuildSeoArtifacts(rootDir, store);
    return;
  }

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

  // Retain the 60 most recent editions in the archive
  const sortedKeys = Object.keys(store.editions).sort().reverse();
  for (const oldKey of sortedKeys.slice(60)) {
    delete store.editions[oldKey];
  }

  await fs.writeFile(editionsPath, JSON.stringify(store, null, 2) + "\n", "utf8");
  await rebuildSeoArtifacts(rootDir, store);

  console.log(`Successfully published AI TIMES edition & SEO pages for ${dateInfo.iso}.`);
}

main().catch((err) => {
  console.error("Failed to publish edition:", err);
  process.exit(1);
});
