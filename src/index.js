/**
 * Cloudflare Worker for Harnosands HF
 * Endpoints:
 *   GET /api/events          -> JSON upcoming events from ICAL_URL
 *   GET /api/events/raw      -> raw ICS (cached)
 *   GET /api/news            -> JSON latest news from NEWS_RSS_URL (HTML stripped)
 *   GET /api/news/raw        -> raw RSS XML (cached)
 *
 * ENV VARS (Worker → Settings → Variables):
 *   ICAL_URL       (required for /api/events) e.g. https://cal.laget.se/HarnosandsHF.ics
 *   NEWS_RSS_URL   (required for /api/news)   e.g. https://www.laget.se/HarnosandsHF/Home/NewsRss
 *   CORS_ORIGIN    (optional) e.g. https://harnosandshf.se (defaults to "*")
 */

const CACHE_TTL_SECONDS = 600;   // 10 minutes
const DEFAULT_DAYS_AHEAD = 365;  // events look-ahead
const MAX_LIMIT = 500;

export default {
  async fetch(request, env, ctx) {
    const url  = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "");
    const cors = corsHeaders(env);

    // Health check
    if (path === "/") return new Response("OK", { headers: { ...cors, "content-type":"text/plain" } });

    // Raw passthroughs (cached)
    if (path.endsWith("/api/events/raw")) return rawICS(env, request, ctx, cors);
    if (path.endsWith("/api/news/raw"))   return rawRSS(env, request, ctx, cors);

    // JSON endpoints
    if (path.endsWith("/api/events")) return eventsJSON(env, url, request, ctx, cors);
    if (path.endsWith("/api/news"))   return newsJSON(env, url, request, ctx, cors);

    return new Response("Not found", { status: 404, headers: cors });
  },
};

/* ===================== /api/events ===================== */

async function eventsJSON(env, url, request, ctx, cors) {
  if (!env.ICAL_URL) return badRequest("Missing ICAL_URL env", cors);

  const cached = await fromEdgeCache(request);
  if (cached) return withCORS(cached, cors);

  const icsRes = await fetch(env.ICAL_URL, { cf: { cacheTtl: CACHE_TTL_SECONDS, cacheEverything: true } });
  if (!icsRes.ok) return new Response("Failed to fetch ICS", { status: 502, headers: cors });

  const icsText = await icsRes.text();
  const events  = parseICS(icsText);

  const now   = new Date();
  const days  = clamp(int(url.searchParams.get("days")) ?? DEFAULT_DAYS_AHEAD, 1, 3650);
  const until = new Date(now.getTime() + days * 24 * 3600 * 1000);

  const upcoming = events
    .filter(ev => {
      const start = new Date(ev.start);
      return start >= startOfDayUTC(now) && start <= until;
    })
    .sort((a, b) => new Date(a.start) - new Date(b.start));

  const limit   = clamp(int(url.searchParams.get("limit")) ?? upcoming.length, 1, MAX_LIMIT);
  const payload = {
    updatedAt: new Date().toISOString(),
    count: Math.min(limit, upcoming.length),
    events: upcoming.slice(0, limit),
  };

  const res = jsonResponse(payload, cors);
  res.headers.set("cache-control", `public, max-age=${CACHE_TTL_SECONDS}, stale-while-revalidate=86400`);
  await saveToEdgeCache(request, res.clone());
  return res;
}

async function rawICS(env, request, ctx, cors) {
  if (!env.ICAL_URL) return badRequest("Missing ICAL_URL env", cors);

  const cached = await fromEdgeCache(request);
  if (cached) return withCORS(cached, cors);

  const icsRes = await fetch(env.ICAL_URL, { cf: { cacheTtl: CACHE_TTL_SECONDS, cacheEverything: true } });
  if (!icsRes.ok) return new Response("Failed to fetch ICS", { status: 502, headers: cors });

  const icsText = await icsRes.text();
  const res = new Response(icsText, {
    headers: {
      ...cors,
      "content-type": "text/calendar; charset=utf-8",
      "cache-control": `public, max-age=${CACHE_TTL_SECONDS}, stale-while-revalidate=86400`,
    },
  });
  await saveToEdgeCache(request, res.clone());
  return res;
}

/* ===================== /api/news ===================== */

async function newsJSON(env, url, request, ctx, cors) {
  if (!env.NEWS_RSS_URL) return badRequest("Missing NEWS_RSS_URL env", cors);

  const cached = await fromEdgeCache(request);
  if (cached) return withCORS(cached, cors);

  const rssRes = await fetch(env.NEWS_RSS_URL, {
    headers: { "user-agent": "HHF-API/1.0 (+https://harnosandshf.se)" },
    cf: { cacheTtl: CACHE_TTL_SECONDS, cacheEverything: true },
  });
  if (!rssRes.ok) return new Response("Failed to fetch RSS", { status: 502, headers: cors });

  const xml   = await rssRes.text();
  const items = parseRSS(xml); // strips HTML tags

  const limit   = clamp(int(url.searchParams.get("limit")) ?? items.length, 1, MAX_LIMIT);
  const payload = {
    updatedAt: new Date().toISOString(),
    count: Math.min(limit, items.length),
    items: items.slice(0, limit),
  };

  const res = jsonResponse(payload, cors);
  res.headers.set("cache-control", `public, max-age=${CACHE_TTL_SECONDS}, stale-while-revalidate=86400`);
  await saveToEdgeCache(request, res.clone());
  return res;
}

async function rawRSS(env, request, ctx, cors) {
  if (!env.NEWS_RSS_URL) return badRequest("Missing NEWS_RSS_URL env", cors);

  const cached = await fromEdgeCache(request);
  if (cached) return withCORS(cached, cors);

  const rssRes = await fetch(env.NEWS_RSS_URL, {
    headers: { "user-agent": "HHF-API/1.0 (+https://harnosandshf.se)" },
    cf: { cacheTtl: CACHE_TTL_SECONDS, cacheEverything: true },
  });
  if (!rssRes.ok) return new Response("Failed to fetch RSS", { status: 502, headers: cors });

  const xml = await rssRes.text();
  const res = new Response(xml, {
    headers: {
      ...cors,
      "content-type": "application/rss+xml; charset=utf-8",
      "cache-control": `public, max-age=${CACHE_TTL_SECONDS}, stale-while-revalidate=86400`,
    },
  });
  await saveToEdgeCache(request, res.clone());
  return res;
}

/* ===================== Common helpers ===================== */

function corsHeaders(env) {
  const allow = env?.CORS_ORIGIN || "*";
  return {
    "access-control-allow-origin": allow,
    "access-control-allow-methods": "GET, HEAD, OPTIONS",
    "access-control-allow-headers": "Content-Type, Cache-Control",
  };
}
function withCORS(res, cors) {
  const r = new Response(res.body, res);
  for (const [k, v] of Object.entries(cors)) r.headers.set(k, v);
  return r;
}
function jsonResponse(obj, cors, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...cors, "content-type": "application/json; charset=utf-8" },
  });
}
function badRequest(msg, cors) { return jsonResponse({ error: msg }, cors, 400); }
function int(v) { if (v == null) return null; const n = Number(v); return Number.isFinite(n) ? n : null; }
function clamp(n, min, max) { return Math.max(min, Math.min(max, n)); }
function startOfDayUTC(d) { return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 0, 0, 0)); }

async function fromEdgeCache(request) { return caches.default.match(request); }
async function saveToEdgeCache(request, response) { await caches.default.put(request, response); }

/* ===================== ICS parsing ===================== */

function parseICS(ics) {
  const unfolded = ics.replace(/\r?\n[ \t]/g, "");              // unfold soft-wrapped lines
  const lines = unfolded.split(/\r?\n/);

  const events = [];
  let cur = null;

  for (const line of lines) {
    if (line === "BEGIN:VEVENT") { cur = {}; continue; }
    if (line === "END:VEVENT") {
      if (cur) {
        const { start, end, isAllDay } = normalizeDates(cur.DTSTART, cur.DTEND);
        events.push({
          start, end, isAllDay,
          summary:  cur.SUMMARY  || "",
          location: cur.LOCATION || "",
          url:      cur.URL      || "",
          uid:      cur.UID      || "",
          calendar: "Laget.se",
        });
      }
      cur = null; continue;
    }
    if (!cur) continue;

    const idx = line.indexOf(":"); if (idx === -1) continue;
    const left = line.slice(0, idx);
    const value = line.slice(idx + 1);
    const key = left.split(";")[0].toUpperCase();
    cur[key] = value;
  }
  return events;
}

function normalizeDates(dtstart, dtend) {
  const dateOnly      = /^\d{8}$/;
  const dateTimeZ     = /^\d{8}T\d{6}Z$/;
  const dateTimeLocal = /^\d{8}T\d{6}$/;

  let isAllDay = false, start, end;

  if (dtstart && dateOnly.test(dtstart)) {
    isAllDay = true;
    start = toUTCStringFromLocalParts(dtstart, "000000");
    if (dtend && dateOnly.test(dtend)) {
      end = toUTCStringFromLocalParts(dtend, "000000");
    } else {
      const s = new Date(start);
      end = new Date(s.getTime() + 24 * 3600 * 1000).toISOString();
    }
  } else if (dtstart && dateTimeZ.test(dtstart)) {
    start = isoFromICSUTC(dtstart);
    end = dtend
      ? (dateTimeZ.test(dtend) ? isoFromICSUTC(dtend)
        : dateTimeLocal.test(dtend) ? toUTCStringFromLocalDateTime(dtend)
        : isoFromICSUTC(dtstart))
      : start;
  } else if (dtstart && dateTimeLocal.test(dtstart)) {
    start = toUTCStringFromLocalDateTime(dtstart);
    end = dtend
      ? (dateTimeLocal.test(dtend) ? toUTCStringFromLocalDateTime(dtend)
        : dateTimeZ.test(dtend) ? isoFromICSUTC(dtend)
        : start)
      : start;
  } else {
    const now = new Date().toISOString(); start = now; end = now;
  }
  return { start, end, isAllDay };
}

function isoFromICSUTC(icsDT) {
  const y = icsDT.slice(0,4), m = icsDT.slice(4,6), d = icsDT.slice(6,8);
  const hh = icsDT.slice(9,11), mm = icsDT.slice(11,13), ss = icsDT.slice(13,15);
  return new Date(`${y}-${m}-${d}T${hh}:${mm}:${ss}Z`).toISOString();
}
function toUTCStringFromLocalDateTime(icsLocal) {
  const y = icsLocal.slice(0,4), m = icsLocal.slice(4,6), d = icsLocal.slice(6,8);
  const hh = icsLocal.slice(9,11), mm = icsLocal.slice(11,13), ss = icsLocal.slice(13,15);
  const dt = new Date(`${y}-${m}-${d}T${hh}:${mm}:${ss}`);
  return new Date(dt.getTime() - dt.getTimezoneOffset()*60000).toISOString();
}
function toUTCStringFromLocalParts(yyyymmdd, hhmmss) {
  const y = yyyymmdd.slice(0,4), m = yyyymmdd.slice(4,6), d = yyyymmdd.slice(6,8);
  const hh = hhmmss.slice(0,2),   mm = hhmmss.slice(2,4),   ss = hhmmss.slice(4,6);
  const dt = new Date(`${y}-${m}-${d}T${hh}:${mm}:${ss}`);
  return new Date(dt.getTime() - dt.getTimezoneOffset()*60000).toISOString();
}

/* ===================== RSS parsing (HTML stripped) ===================== */

function parseRSS(xml) {
  const items = [];
  const itemRegex = /<item\b[\s\S]*?<\/item>/gi;
  let m;
  while ((m = itemRegex.exec(xml)) !== null) {
    const block = m[0];
    items.push({
      title:       decodeHTML(stripTags(pickTag(block, "title") || "")),
      link:        (pickTag(block, "link") || "").trim(),
      guid:        (pickTag(block, "guid") || "").trim(),
      pubDate:     (pickTag(block, "pubDate") || "").trim(),
      description: decodeHTML(stripTags(pickTag(block, "description") || "")),
      enclosure:   pickAttr(block, "enclosure", "url"),
      categories:  pickAll(block, "category").map(x => decodeHTML(stripTags(x))),
    });
  }
  return items.sort((a,b) => Date.parse(b.pubDate||0) - Date.parse(a.pubDate||0));
}
function pickTag(xml, tag) {
  const re = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i");
  const m = xml.match(re);
  if (!m) return null;
  return stripCDATA(m[1]).trim();
}
function pickAll(xml, tag) {
  const out = [];
  const re = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, "gi");
  let m;
  while ((m = re.exec(xml)) !== null) out.push(stripCDATA(m[1]).trim());
  return out;
}
function pickAttr(xml, tag, attr) {
  const re = new RegExp(`<${tag}\\b([^>]*)\\/?>`, "i");
  const m = xml.match(re);
  if (!m) return null;
  const attrs = m[1];
  const a = new RegExp(`${attr}="([^"]+)"`, "i").exec(attrs) || new RegExp(`${attr}='([^']+)'`, "i").exec(attrs);
  return a ? a[1] : null;
}
function stripCDATA(s) { return s.replace(/<!\[CDATA\[(.*?)\]\]>/gs, "$1"); }
function stripTags(s)  { return s.replace(/<\/?[^>]+>/g, "").replace(/\r?\n|\r/g, " ").replace(/\s+/g, " ").trim(); }
function decodeHTML(s) {
  const map = { "&amp;":"&", "&lt;":"<", "&gt;":">", "&quot;":'"', "&#39;":"'","&apos;":"'" };
  return s.replace(/&(amp|lt|gt|quot|#39|apos);/g, m => map[m]);
}
