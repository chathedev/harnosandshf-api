# Harnosands HF API (Cloudflare Worker)

Endpoints:
- `GET https://api.harnosandshf.se/api/events?limit=25&days=365`
- `GET https://api.harnosandshf.se/api/events/raw`
- `GET https://api.harnosandshf.se/api/news?limit=20`
- `GET https://api.harnosandshf.se/api/news/raw`

## Deploy (GitHub → Cloudflare)
1. Push this repo to GitHub.
2. In Cloudflare → Workers & Pages → **Import a repository**, select this repo.
3. Complete the wizard (no build step needed).

### Variables (Worker → Settings → Variables)
- `ICAL_URL` = `https://cal.laget.se/HarnosandsHF.ics`
- `NEWS_RSS_URL` = `https://www.laget.se/HarnosandsHF/Home/NewsRss`
- (optional) `CORS_ORIGIN` = `https://harnosandshf.se`

### Routes (Worker → Triggers → Add Route)
- `api.harnosandshf.se/api/events*`
- `api.harnosandshf.se/api/news*`

DNS: Ensure `api.harnosandshf.se` record is **Proxied** (orange cloud) in Cloudflare DNS.
