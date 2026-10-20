# Weather History and Probability

GeezerGeek Pilot app — odds of favorable flying conditions from historical observations.
Live: https://weather-history-probability.netlify.app/

- `site/` — what Netlify publishes (index.html, airports.json)
- `netlify/functions/` — fetch-station.js (historical obs), tzlookup.js (used by fetch-station), hit-counter.js (Netlify Blobs store `weather-history-probability-meta`); all dependency-free
- `netlify.toml` — publish dir and functions dir; no build step

Every push to `main` redeploys the site.
