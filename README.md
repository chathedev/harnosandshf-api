# harnosandshf-events (Cloudflare Worker)

Serves Laget.se calendar as JSON at:
`https://api.harnosandshf.se/api/events`

## Deploy via GitHub → Cloudflare

1. Create a **new GitHub repo** with this structure:
wrangler.toml
src/
index.js

markdown
Kopiera
Redigera
2. Push to GitHub.
3. In **Cloudflare → Workers & Pages → Workers → Import a repository**,
select your repo and follow the steps.

### Bind environment variables
In Cloudflare (Worker → Settings → Variables):
- `ICAL_URL` (Text): your Laget.se iCal (.ics) URL
- (Optional) `CORS_ORIGIN` (Text): `https://harnosandshf.se` (or leave unset for `*`)

### Route
Add a route so your Worker runs on your subdomain:
- Worker → **Triggers → Add Route**
- Route: `api.harnosandshf.se/api/events*`

### Test
Open: `https://api.harnosandshf.se/api/events`

Query params:
- `limit` (int) → limit number of events
- `days`  (int) → horizon in days (default 365)
- `/api/events/raw` for the raw ICS (cached)

## Notes
- Edge cache TTL is 10 minutes. Adjust `CACHE_TTL_SECONDS` in `src/index.js` if needed.
- All-day events are flagged `isAllDay: true`.
- Times are returned as ISO 8601 UTC.
