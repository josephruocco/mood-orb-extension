// Mood Orb (MV3) — local-only heuristic mood scoring.
// Computes mood every minute and broadcasts to all tabs.

const DEFAULT_STATE = {
  mood: "Neutral",
  confidence: 0.5,
  color: "#888888",
  summary: "Waiting for a little more browsing context.",
  signals: [],
  updatedAt: Date.now()
};

const MOOD_COLORS = {
  Focused: "#2E86FF",
  Calm: "#2ECC71",
  Restless: "#F1C40F",
  Anxious: "#E74C3C",
  Avoidant: "#9B59B6",
  Neutral: "#888888"
};

chrome.runtime.onInstalled.addListener(async () => {
  await chrome.storage.local.set({ moodState: DEFAULT_STATE });
  chrome.alarms.create("mood_tick", { periodInMinutes: 1 });
  // Run once immediately.
  computeAndBroadcastMood().catch(() => {});
});

chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create("mood_tick", { periodInMinutes: 1 });
  computeAndBroadcastMood().catch(() => {});
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "mood_tick") computeAndBroadcastMood().catch(() => {});
});

// Also refresh on tab activation (helps responsiveness)
chrome.tabs.onActivated.addListener(() => {
  computeAndBroadcastMood().catch(() => {});
});

// --- Core: compute mood ---
async function computeAndBroadcastMood() {
  const now = Date.now();
  const windowMinutes = 30;
  const sinceMs = now - windowMinutes * 60 * 1000;
  const { moodState: previousState } = await chrome.storage.local.get(["moodState"]);

  // 1) Tabs snapshot
  const tabs = await chrome.tabs.query({});
  const openSnapshot = summarizeOpenTabs(tabs);

  // 2) History (last 30 min, cap 200)
  const historyItems = await chrome.history.search({
    text: "",
    startTime: sinceMs,
    maxResults: 200
  });

  const historySnapshot = extractHistorySignals(historyItems);

  // 3) Simple heuristic features
  const features = {
    windowMinutes,
    openTabCount: openSnapshot.openTabCount,
    openDomainCount: openSnapshot.openDomainCount,
    activeCategory: openSnapshot.activeCategory,
    visitCount: historySnapshot.visitCount,
    uniqueDomainVisitedCount: historySnapshot.uniqueDomainVisitedCount,
    searchCount: historySnapshot.searchQueries.length,
    topDomain: historySnapshot.topDomain,
    categoryCounts: historySnapshot.categoryCounts,
    openCategoryCounts: openSnapshot.openCategoryCounts,
    focusSearchCount: countSearches(historySnapshot.searchQueries, FOCUS_SEARCH_TERMS),
    anxiousSearchCount: countSearches(historySnapshot.searchQueries, ANXIOUS_SEARCH_TERMS),
    escapeSearchCount: countSearches(historySnapshot.searchQueries, ESCAPE_SEARCH_TERMS),
    shoppingSearchCount: countSearches(historySnapshot.searchQueries, SHOPPING_SEARCH_TERMS)
  };

  // 4) Score moods
  const scored = scoreMoods(features, previousState);

  // 5) Persist + broadcast
  const moodState = {
    mood: scored.mood,
    confidence: scored.confidence,
    color: MOOD_COLORS[scored.mood] || MOOD_COLORS.Neutral,
    summary: scored.summary,
    signals: scored.signals,
    updatedAt: now
  };

  await chrome.storage.local.set({ moodState });
  await broadcastToAllTabs({ type: "MOOD_UPDATE", payload: moodState });
}

async function broadcastToAllTabs(message) {
  const tabs = await chrome.tabs.query({});
  for (const t of tabs) {
    if (!t.id) continue;
    // Avoid errors on chrome:// pages etc.
    try {
      await chrome.tabs.sendMessage(t.id, message);
    } catch (_) {}
  }
}

// --- Helpers: tabs/domains ---
function summarizeOpenTabs(tabs) {
  const openDomains = {};
  const openCategoryCounts = {};
  let openTabCount = 0;
  let activeCategory = "other";

  for (const t of tabs) {
    if (!t.url || !t.url.startsWith("http")) continue;
    const d = safeDomain(t.url);
    if (!d) continue;
    openTabCount += 1;
    openDomains[d] = (openDomains[d] || 0) + 1;

    const category = classifyDomain(d);
    openCategoryCounts[category] = (openCategoryCounts[category] || 0) + 1;
    if (t.active) activeCategory = category;
  }

  return {
    openTabCount,
    openDomainCount: Object.keys(openDomains).length,
    openCategoryCounts,
    activeCategory
  };
}

function extractHistorySignals(items) {
  const domainsVisited = {};
  const categoryCounts = {};
  const searchQueries = [];
  let visitCount = 0;

  for (const it of items) {
    if (!it.url || !it.url.startsWith("http")) continue;
    visitCount += 1;

    const d = safeDomain(it.url);
    if (d) {
      domainsVisited[d] = (domainsVisited[d] || 0) + 1;
      const category = classifyDomain(d);
      categoryCounts[category] = (categoryCounts[category] || 0) + 1;
    }

    const q = extractSearchQuery(it.url);
    if (q) searchQueries.push(q);
  }

  const topDomainEntry = Object.entries(domainsVisited).sort((a, b) => b[1] - a[1])[0];

  return {
    domainsVisited,
    categoryCounts,
    searchQueries,
    visitCount,
    uniqueDomainVisitedCount: Object.keys(domainsVisited).length,
    topDomain: topDomainEntry ? topDomainEntry[0] : null
  };
}

function safeDomain(url) {
  try {
    const u = new URL(url);
    return u.hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

// Naive search query extraction from common engines.
function extractSearchQuery(url) {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./, "");
    const params = u.searchParams;

    // Google / DuckDuckGo / Bing-ish
    const q = params.get("q") || params.get("p"); // p is Yahoo
    if (!q) return null;

    // Only treat as "search query" if it looks like a search engine.
    const isSearchHost =
      host.includes("google.") ||
      host.includes("duckduckgo.") ||
      host.includes("bing.com") ||
      host.includes("search.yahoo.") ||
      host.includes("ecosia.") ||
      host.includes("brave.com");

    if (!isSearchHost) return null;

    const cleaned = decodeURIComponent(q).trim();
    if (!cleaned) return null;
    return cleaned.slice(0, 200);
  } catch {
    return null;
  }
}

// --- Categorization (starter mapping) ---
function classifyDomain(domain) {
  const d = domain;

  if (
    d.includes("nytimes.com") || d.includes("wsj.com") || d.includes("bbc.") ||
    d.includes("cnn.com") || d.includes("reuters.com") || d.includes("bloomberg.")
  ) return "news";

  if (
    d.includes("twitter.com") || d.includes("x.com") || d.includes("instagram.com") ||
    d.includes("tiktok.com") || d.includes("reddit.com") || d.includes("facebook.com")
  ) return "social";

  if (
    d.includes("youtube.com") || d.includes("netflix.com") || d.includes("twitch.tv") ||
    d.includes("hulu.com") || d.includes("disneyplus.com") || d.includes("max.com")
  ) return "video";

  if (
    d.includes("docs.google.com") || d.includes("notion.so") || d.includes("github.com") ||
    d.includes("stackoverflow.com") || d.includes("developer.") || d.includes("readthedocs.") ||
    d.includes("npmjs.com") || d.includes("mdn")
  ) return "docsdev";

  if (
    d.includes("amazon.") || d.includes("ebay.") || d.includes("etsy.com") ||
    d.includes("walmart.") || d.includes("shopify.") || d.includes("target.com")
  ) return "shopping";

  if (
    d.includes("figma.com") || d.includes("linear.app") || d.includes("jira.") ||
    d.includes("trello.com") || d.includes("asana.com") || d.includes("airtable.com") ||
    d.includes("calendar.google.com") || d.includes("drive.google.com")
  ) return "productivity";

  if (
    d.includes("mail.google.com") || d.includes("slack.com") || d.includes("discord.com") ||
    d.includes("teams.microsoft.com") || d.includes("zoom.us") || d.includes("meet.google.com")
  ) return "communication";

  if (
    d.includes("mayoclinic.org") || d.includes("webmd.com") || d.includes("healthline.com")
  ) return "wellness";

  return "other";
}

const FOCUS_SEARCH_TERMS = [
  "how to", "documentation", "api", "tutorial", "implement", "debug",
  "fix", "error", "guide", "example", "sdk", "reference"
];
const ANXIOUS_SEARCH_TERMS = [
  "symptom", "panic", "anxiety", "am i", "urgent", "cancer", "heart",
  "why do i", "cant sleep", "can’t sleep", "worried", "scared"
];
const ESCAPE_SEARCH_TERMS = [
  "watch", "stream", "funny", "meme", "game", "celebrity", "drama", "highlights"
];
const SHOPPING_SEARCH_TERMS = [
  "buy", "best", "review", "price", "deal", "coupon", "cheap", "discount"
];

function countSearches(queries, needles) {
  return queries.reduce((acc, q) => {
    const s = q.toLowerCase();
    return acc + (needles.some((w) => s.includes(w)) ? 1 : 0);
  }, 0);
}

// --- Mood scoring ---
function scoreMoods(f, previousState) {
  const category = (name) => f.categoryCounts[name] || 0;
  const openCategory = (name) => f.openCategoryCounts[name] || 0;

  const workMix = category("docsdev") + category("productivity") + category("communication") * 0.7;
  const stimulationMix = category("social") + category("video") + category("news");
  const escapeMix = category("social") + category("video") + category("shopping") + f.escapeSearchCount * 1.5;
  const worryMix = category("news") + category("wellness") + f.anxiousSearchCount * 1.8;
  const activityLevel = clamp01((f.visitCount + f.openTabCount * 2) / 70);
  const switchingLoad = clamp01((f.uniqueDomainVisitedCount + f.openDomainCount) / 18);
  const focusIntent = clamp01((workMix + f.focusSearchCount * 2 + openCategory("docsdev")) / 16);
  const worryIntent = clamp01(worryMix / 12);
  const escapeIntent = clamp01((escapeMix + openCategory("video") + openCategory("social")) / 16);
  const calmReserve = clamp01(1 - activityLevel * 0.55 - switchingLoad * 0.35 - worryIntent * 0.4);
  const categorySpread = clamp01(Object.values(f.categoryCounts).filter(Boolean).length / 6);

  const scores = {
    Focused:
      focusIntent * 0.5 +
      clamp01(1 - escapeIntent) * 0.18 +
      clamp01(1 - switchingLoad) * 0.16 +
      (f.activeCategory === "docsdev" || f.activeCategory === "productivity" ? 0.12 : 0),
    Calm:
      calmReserve * 0.5 +
      clamp01(1 - stimulationMix / 14) * 0.2 +
      clamp01(1 - worryIntent) * 0.2 +
      clamp01(1 - categorySpread) * 0.1,
    Restless:
      switchingLoad * 0.38 +
      activityLevel * 0.2 +
      categorySpread * 0.22 +
      clamp01(stimulationMix / 14) * 0.2,
    Anxious:
      worryIntent * 0.5 +
      clamp01(category("news") / 8) * 0.16 +
      clamp01(f.anxiousSearchCount / 4) * 0.16 +
      activityLevel * 0.1 +
      (f.activeCategory === "wellness" || f.activeCategory === "news" ? 0.08 : 0),
    Avoidant:
      escapeIntent * 0.48 +
      clamp01(category("shopping") / 6) * 0.12 +
      activityLevel * 0.14 +
      clamp01(1 - focusIntent) * 0.16 +
      (f.activeCategory === "video" || f.activeCategory === "social" ? 0.1 : 0)
  };

  if (previousState?.mood && scores[previousState.mood] != null) {
    const freshnessBoost = Date.now() - (previousState.updatedAt || 0) < 90 * 60 * 1000 ? 0.08 : 0.04;
    scores[previousState.mood] = clamp01(
      scores[previousState.mood] + freshnessBoost * clamp01(previousState.confidence || 0.5)
    );
  }

  const candidates = Object.entries(scores)
    .map(([mood, score]) => ({ mood, score: clamp01(score) }))
    .sort((a, b) => b.score - a.score);

  const top = candidates[0];
  const second = candidates[1];
  const evidenceStrength = clamp01((activityLevel + focusIntent + worryIntent + escapeIntent + switchingLoad) / 3);
  const confidence = clamp01(top.score * 0.55 + (top.score - second.score) * 0.75 + evidenceStrength * 0.15);

  let mood = top.mood;
  if (top.score < 0.34 || confidence < 0.3) mood = "Neutral";
  if (
    previousState?.mood &&
    previousState.mood !== "Neutral" &&
    mood !== previousState.mood &&
    top.score - (scores[previousState.mood] || 0) < 0.08
  ) {
    mood = previousState.mood;
  }

  const summary = buildSummary(mood, {
    focusIntent,
    worryIntent,
    escapeIntent,
    switchingLoad,
    calmReserve,
    activeCategory: f.activeCategory
  });
  const signals = buildSignals(mood, f);

  return { mood, confidence, summary, signals };
}

function buildSignals(mood, f) {
  const sig = [
    `Last ${f.windowMinutes} min: ~${Math.round(f.visitCount)} visits across ${f.uniqueDomainVisitedCount} domains`,
    `Open now: ${f.openTabCount} tabs across ${f.openDomainCount} domains`
  ];

  if (f.activeCategory && f.activeCategory !== "other") {
    sig.push(`Active tab leans ${labelForCategory(f.activeCategory)}`);
  }
  if (f.topDomain) sig.push(`Most revisited: ${f.topDomain}`);
  if ((f.categoryCounts.docsdev || 0) + (f.categoryCounts.productivity || 0)) {
    sig.push(`Work-ish pages: ${(f.categoryCounts.docsdev || 0) + (f.categoryCounts.productivity || 0)}`);
  }
  if ((f.categoryCounts.news || 0) + (f.categoryCounts.wellness || 0)) {
    sig.push(`High-alert browsing: ${(f.categoryCounts.news || 0) + (f.categoryCounts.wellness || 0)}`);
  }
  if ((f.categoryCounts.social || 0) + (f.categoryCounts.video || 0)) {
    sig.push(`Social/video pull: ${(f.categoryCounts.social || 0) + (f.categoryCounts.video || 0)}`);
  }
  if (f.focusSearchCount) sig.push(`Intentional searches: ${f.focusSearchCount}`);
  if (f.anxiousSearchCount) sig.push(`Uncertainty searches: ${f.anxiousSearchCount}`);
  if (f.escapeSearchCount || f.shoppingSearchCount) {
    sig.push(`Escape/shopping searches: ${f.escapeSearchCount + f.shoppingSearchCount}`);
  }

  return sig.slice(0, mood === "Neutral" ? 4 : 5);
}

function buildSummary(mood, context) {
  switch (mood) {
    case "Focused":
      return context.activeCategory === "docsdev" || context.activeCategory === "productivity"
        ? "Your browsing looks task-oriented and steady right now."
        : "There are more work signals than distraction signals right now.";
    case "Calm":
      return "Activity looks light and relatively settled.";
    case "Restless":
      return "There are lots of quick context shifts and mixed inputs right now.";
    case "Anxious":
      return "The recent pattern leans toward uncertainty-seeking or high-alert browsing.";
    case "Avoidant":
      return "Entertainment and low-friction browsing are outweighing deliberate work signals.";
    default:
      return "Not enough strong evidence yet, so the orb is staying neutral.";
  }
}

function labelForCategory(category) {
  const labels = {
    docsdev: "technical work",
    productivity: "planning",
    communication: "communication",
    news: "news",
    wellness: "health/info",
    social: "social",
    video: "video",
    shopping: "shopping"
  };
  return labels[category] || category;
}

function clamp01(x) {
  return Math.max(0, Math.min(1, x));
}
