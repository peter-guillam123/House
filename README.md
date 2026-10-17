# House

A search tool for UK parliament. Hansard + written questions + ministerial statements + committee debates, in one place, filterable by date, party, member, House and source.

Live: _add deploy URL once GitHub Pages is wired up_.
About / changelog: [`about.html`](about.html).

## Architecture

- **Frontend**: vanilla JS / HTML / CSS, hosted on GitHub Pages.
- **Proxy**: tiny Cloudflare Worker (`worker/`) that proxies all parliament API calls and adds CORS headers. Hansard and Committees don't return CORS headers at all; Q&S and Members technically do, but routing everything through the worker dodges browser-cache and bot-detection edge cases and gives one consistent error path. Free tier (100k req/day) covers this many times over and the worker sets a 5-minute edge cache.

## Local dev

In one terminal, run the worker:

```sh
cd worker
npm install
npx wrangler dev    # serves on http://localhost:8787
```

In another terminal, serve the static site:

```sh
python3 -m http.server 8000
# open http://localhost:8000
```

`src/api.js` defaults `PROXY` to `http://localhost:8787`, so it'll Just Work locally. For production, edit that one line to point at your deployed Worker URL.

## Deploy

### Worker (one time)

```sh
cd worker
npx wrangler login
npx wrangler deploy
```

You'll get back a URL like `https://house-proxy.<your-account>.workers.dev`. Update `PROXY` in `src/api.js` to that URL and commit.

### Frontend

GitHub Pages from the repo root. In Settings → Pages, set source to "Deploy from a branch", branch `main`, folder `/`. That's it.

## Calendar feeds

`tools/build-calendar.py` turns the next eight weeks of public committee oral evidence into subscribable calendar files under `calendar/`: one for everything, one per select committee, and a `committees.json` manifest the Committees page reads to list them. A GitHub Actions job (`build-calendar.yml`) rebuilds them hourly through the day and commits only when the schedule has changed. Event IDs are stable, so a changed time updates the entry in a subscriber's calendar rather than duplicating it. Stdlib only:

```sh
python3 tools/build-calendar.py
```

## The week ahead

`tools/build-ahead.py` writes `days/ahead.json`: each House's next sitting day with its order of business (from Parliament's What's On feed, fetched a month at a time because it refuses longer windows), recess and non-sitting days, and the week ahead with chamber highlights and public committee sessions. The home page reads it while the search box is empty. It runs hourly through the day in `build-calendar.yml`, alongside the calendar feeds.

## Day summaries

`tools/build-day.py` writes one JSON file per sitting day under `days/`: every debate with who spoke and for how long, divisions with each member's vote and anyone who voted against their party, written statements and answers, committee sessions and reports, and bill stages. "Words that spiked" compares the day's vocabulary with the previous sitting days' files, kept under `days/vocab/`. `day.html` renders the latest day and lets you step back through the archive. A GitHub Actions job (`build-day.yml`) runs twice each morning for the last sitting day of each House.

```sh
python3 tools/build-day.py                # last sitting day of each House
python3 tools/build-day.py --date 2026-10-14
python3 tools/build-day.py --backfill 15  # seed the archive and the spike baseline
```

## Limits worth knowing

- Select committee oral evidence transcripts aren't full-text searchable via parliament's API — you only get metadata (committee, date, witnesses). The committee source instead uses Hansard's committee-debates feed, which covers Public Bill and Westminster Hall debates.
- Multi-word terms are matched as a phrase, not as an AND query. No Boolean syntax.
- Worker has a 100k req/day free-tier ceiling. With a 5-minute edge cache on every response, you'd need a small army of journalists to come close.
