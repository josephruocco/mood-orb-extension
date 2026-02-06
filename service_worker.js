// Mood Orb (MV3) — local-only heuristic mood scoring.
// Computes mood every minute and broadcasts to all tabs.

const DEFAULT_STATE = {
  mood: "Neutral",
  confidence: 0.5,
  color: "#888888",
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

  // 1) Tabs snapshot
  const tabs = await chrome.tabs.query({});

  // Active tab switching proxy: count distinct active tab URLs in recent history
  // (We also look at history below; tabs alone doesn't give switch count.)
  const openDomains = countDomainsFromTabs(tabs);

  // 2) History (last 30 min, cap 200)
  const historyItems = await chrome.history.search({
    text: "",
    startTime: sinceMs,
    maxResults: 200
  });

  const { domainsVisited, searchQueries, visitCount } = extractHistorySignals(historyItems);

  // 3) Simple heuristic features
  const features = {
    windowMinutes,
    openDomainCount: Object.keys(openDomains).length,
    visitCount,
    uniqueDomainVisitedCount: Object.keys(domainsVisited).length,
    newsCount: countCategory(domainsVisited, "news"),
    socialCount: countCategory(domainsVisited, "social"),
    videoCount: countCategory(domainsVisited, "video"),
    docsDevCount: countCategory(domainsVisited, "docsdev"),
    shoppingCount: countCategory(domainsVisited, "shopping"),
    searchCount: searchQueries.length,
    anxiousSearchCount: countAnxiousSearches(searchQueries),
    focusSearchCount: countFocusSearches(searchQueries)
  };

  // 4) Score moods
  const scored = scoreMoods(features);

  // 5) Persist + broadcast
  const moodState = {
    mood: scored.mood,
    confidence: scored.confidence,
    color: MOOD_COLORS[scored.mood] || MOOD_COLORS.Neutral,
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
      chrome.tabs.sendMessage(t.id, message);
    } catch (_) {}
  }
}

// --- Helpers: tabs/domains ---
function countDomainsFromTabs(tabs) {
  const counts = {};
  for (const t of tabs) {
    if (!t.url || !t.url.startsWith("http")) continue;
    const d = safeDomain(t.url);
    if (!d) continue;
    counts[d] = (counts[d] || 0) + 1;
  }
  return counts;
}

function extractHistorySignals(items) {
  const domainsVisited = {};
  const searchQueries = [];
  let visitCount = 0;

  for (const it of items) {
    if (!it.url || !it.url.startsWith("http")) continue;
    visitCount += it.visitCount || 1;

    const d = safeDomain(it.url);
    if (d) domainsVisited[d] = (domainsVisited[d] || 0) + 1;

    const q = extractSearchQuery(it.url);
    if (q) searchQueries.push(q);
  }

  return { domainsVisited, searchQueries, visitCount };
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
  // Very rough buckets. You’ll expand this.
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
    d.includes("hulu.com")
  ) return "video";

  if (
    d.includes("docs.google.com") || d.includes("notion.so") || d.includes("github.com") ||
    d.includes("stackoverflow.com") || d.includes("developer.") || d.includes("readthedocs.")
  ) return "docsdev";

  if (
    d.includes("amazon.") || d.includes("ebay.") || d.includes("etsy.com") ||
    d.includes("walmart.") || d.includes("shopify.")
  ) return "shopping";

  return "other";
}

function countCategory(domainCounts, category) {
  let c = 0;
  for (const [d, n] of Object.entries(domainCounts)) {
    if (classifyDomain(d) === category) c += n;
  }
  return c;
}

// --- Search keyword heuristics ---
function countAnxiousSearches(queries) {
  const needles = ["symptom", "panic", "anxiety", "am i", "urgent", "cancer", "heart", "why do i", "can’t sleep"];
  return queries.reduce((acc, q) => {
    const s = q.toLowerCase();
    return acc + (needles.some((w) => s.includes(w)) ? 1 : 0);
  }, 0);
}

function countFocusSearches(queries) {
  const needles = ["how to", "documentation", "api", "tutorial", "proof", "derivation", "implement", "debug"];
  return queries.reduce((acc, q) => {
    const s = q.toLowerCase();
    return acc + (needles.some((w) => s.includes(w)) ? 1 : 0);
  }, 0);
}

// --- Mood scoring ---
function scoreMoods(f) {
  // “Restless”: high unique domains + many visits
  const restlessScore =
    clamp01((f.uniqueDomainVisitedCount - 8) / 20) * 0.6 +
    clamp01((f.visitCount - 30) / 120) * 0.4;

  // “Anxious”: news loops + anxious queries
  const anxiousScore =
    clamp01(f.newsCount / 15) * 0.5 +
    clamp01(f.anxiousSearchCount / 6) * 0.5;

  // “Focused”: docs/dev + focus queries, lower social/video
  const focusedScore =
    clamp01(f.docsDevCount / 20) * 0.6 +
    clamp01(f.focusSearchCount / 8) * 0.3 +
    (1 - clamp01((f.socialCount + f.videoCount) / 25)) * 0.1;

  // “Calm”: fewer visits, fewer domains, more steady usage
  const calmScore =
    (1 - clamp01(f.visitCount / 120)) * 0.5 +
    (1 - clamp01(f.uniqueDomainVisitedCount / 25)) * 0.5;

  // “Avoidant”: high video/social + many visits, low docsdev
  const avoidantScore =
    clamp01((f.socialCount + f.videoCount) / 25) * 0.6 +
    clamp01(f.visitCount / 120) * 0.3 +
    (1 - clamp01(f.docsDevCount / 20)) * 0.1;

  const candidates = [
    { mood: "Focused", score: focusedScore },
    { mood: "Calm", score: calmScore },
    { mood: "Restless", score: restlessScore },
    { mood: "Anxious", score: anxiousScore },
    { mood: "Avoidant", score: avoidantScore }
  ].sort((a, b) => b.score - a.score);

  const top = candidates[0];
  const second = candidates[1];

  const confidence = clamp01(top.score * 0.75 + (top.score - second.score) * 0.5);

  const mood = top.score < 0.25 ? "Neutral" : top.mood;

  const signals = buildSignals(mood, f);

  return { mood, confidence, signals };
}

function buildSignals(mood, f) {
  const sig = [];
  sig.push(`Window: last ${f.windowMinutes} min`);
  sig.push(`Visits: ~${Math.round(f.visitCount)} · Unique domains: ${f.uniqueDomainVisitedCount}`);
  sig.push(`Open domains now: ${f.openDomainCount}`);

  if (f.newsCount) sig.push(`News loops: ${f.newsCount}`);
  if (f.socialCount) sig.push(`Social: ${f.socialCount}`);
  if (f.videoCount) sig.push(`Video: ${f.videoCount}`);
  if (f.docsDevCount) sig.push(`Docs/Dev: ${f.docsDevCount}`);
  if (f.searchCount) sig.push(`Searches detected: ${f.searchCount}`);
  if (f.anxiousSearchCount) sig.push(`Anxious-ish searches: ${f.anxiousSearchCount}`);
  if (f.focusSearchCount) sig.push(`Focus-ish searches: ${f.focusSearchCount}`);

  // Keep it short
  return sig.slice(0, 6);
}

function clamp01(x) {
  return Math.max(0, Math.min(1, x));
}