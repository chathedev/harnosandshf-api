/**
 * Cloudflare Worker: Laget.se iCal → JSON
 * Routes:
 *   GET /api/events         -> JSON of upcoming events
 *   GET /api/events?limit=50&days=180
 *   GET /api/events/raw     -> raw ICS (cached)
 *
 * ENV VARS:
 *   ICAL_URL     (required)  e.g. https://www.laget.se/<team>/Event/ExportIcal?...
 *   CORS_ORIGIN  (optional)  e.g. https://harnosandshf.se  (or "*" if omitted)
 */

const CACHE_TTL_SECONDS = 600;      // 10 minutes
const DEFAULT_DAYS_AHEAD = 365;
const MAX_LIMIT = 500;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "");
    const cors = corsHeaders(env);

    if (path === "/") {
      return new Response("OK", { headers: { ...cors, "content-type": "text/plain" } });
    }

    if (path.endsWith("/api/events/raw")) {
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
      ctx.waitUntil(saveToEdgeCache(request, res.clone()));
      return res;
    }

    if (path.endsWith("/api/events")) {
      if (!env.ICAL_URL) return badRequest("Missing ICAL_URL env", cors);

      const cached = await fromEdgeCache(request);
      if (cached) return withCORS(cached, cors);

      const icsRes = await fetch(env.ICAL_URL, { cf: { cacheTtl: CACHE_TTL_SECONDS, cacheEverything: true } });
      if (!icsRes.ok) return new Response("Failed to fetch ICS", { status: 502, headers: cors });

      const icsText = await icsRes.text();
      const events = parseICS(icsText);

      const now = new Date();
      const days = clamp(int(url.searchParams.get("days")) ?? DEFAULT_DAYS_AHEAD, 1, 3650);
      const until = new Date(now.getTime() + days * 24 * 3600 * 1000);

      const upcoming = events
        .filter(ev => {
          const start = new Date(ev.start);
          return start >= startOfDayUTC(now) && start <= until;
        })
        .sort((a, b) => new Date(a.start) - new Date(b.start));

      const limit = clamp(int(url.searchParams.get("limit")) ?? upcoming.length, 1, MAX_LIMIT);
      const payload = {
        updatedAt: new Date().toISOString(),
        count: Math.min(limit, upcoming.length),
        events: upcoming.slice(0, limit),
      };

      const res = jsonResponse(payload, cors);
      res.headers.set("cache-control", `public, max-age=${CACHE_TTL_SECONDS}, stale-while-revalidate=86400`);
      ctx.waitUntil(saveToEdgeCache(request, res.clone()));
      return res;
    }

    return new Response("Not found", { status: 404, headers: cors });
  },
};

/* -------------------- Helpers -------------------- */

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
function badRequest(msg, cors) {
  return jsonResponse({ error: msg }, cors, 400);
}
function int(v) {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}
function startOfDayUTC(d) {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 0, 0, 0));
}

// Edge cache via caches.default (keyed by URL incl. query)
async function fromEdgeCache(request) {
  return await caches.default.match(request);
}
async function saveToEdgeCache(request, response) {
  await caches.default.put(request, response);
}

/* -------------------- ICS Parsing -------------------- */

function parseICS(ics) {
  // Unfold lines per RFC 5545 (CRLF + space/tab = continuation)
  const unfolded = ics.replace(/\r?\n[ \t]/g, "");
  const lines = unfolded.split(/\r?\n/);

  const events = [];
  let cur = null;

  for (const line of lines) {
    if (line === "BEGIN:VEVENT") {
      cur = {};
      continue;
    }
    if (line === "END:VEVENT") {
      if (cur) {
        const { start, end, isAllDay } = normalizeDates(cur.DTSTART, cur.DTEND);
        events.push({
          start,
          end,
          isAllDay,
          summary: cur.SUMMARY || "",
          location: cur.LOCATION || "",
          url: cur.URL || "",
          uid: cur.UID || "",
          calendar: "Laget.se",
        });
      }
      cur = null;
      continue;
    }
    if (!cur) continue;

    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const left = line.slice(0, idx);
    const value = line.slice(idx + 1);

    const key = left.split(";")[0].toUpperCase(); // e.g., DTSTART;VALUE=DATE
    cur[key] = value;
  }

  return events;
}

function normalizeDates(dtstart, dtend) {
  // All-day format: YYYYMMDD
  const dateOnly = /^\d{8}$/;
  const dateTimeZ = /^\d{8}T\d{6}Z$/;         // UTC
  const dateTimeLocal = /^\d{8}T\d{6}$/;      // no 'Z' (floating local)

  let isAllDay = false;
  let start, end;

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
    const now = new Date().toISOString();
    start = now; end = now;
  }

  return { start, end, isAllDay };
}

function isoFromICSUTC(icsDT) {
  const y = icsDT.slice(0, 4);
  const m = icsDT.slice(4, 6);
  const d = icsDT.slice(6, 8);
  const hh = icsDT.slice(9, 11);
  const mm = icsDT.slice(11, 13);
  const ss = icsDT.slice(13, 15);
  return new Date(`${y}-${m}-${d}T${hh}:${mm}:${ss}Z`).toISOString();
}

function toUTCStringFromLocalDateTime(icsLocal) {
  const y = icsLocal.slice(0, 4);
  const m = icsLocal.slice(4, 6);
  const d = icsLocal.slice(6, 8);
  const hh = icsLocal.slice(9, 11);
  const mm = icsLocal.slice(11, 13);
  const ss = icsLocal.slice(13, 15);
  const dt = new Date(`${y}-${m}-${d}T${hh}:${mm}:${ss}`);
  return new Date(dt.getTime() - dt.getTimezoneOffset() * 60000).toISOString();
}

function toUTCStringFromLocalParts(yyyymmdd, hhmmss) {
  const y = yyyymmdd.slice(0, 4);
  const m = yyyymmdd.slice(4, 6);
  const d = yyyymmdd.slice(6, 8);
  const hh = hhmmss.slice(0, 2);
  const mm = hhmmss.slice(2, 4);
  const ss = hhmmss.slice(4, 6);
  const dt = new Date(`${y}-${m}-${d}T${hh}:${mm}:${ss}`);
  return new Date(dt.getTime() - dt.getTimezoneOffset() * 60000).toISOString();
}
