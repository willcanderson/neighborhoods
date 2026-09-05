# What Chicago neighborhood am I in?

A single-page web app that answers exactly one question: *which Chicago
neighborhood am I standing in right now?* It also tells you which of the 77
official community areas that is, how far the nearest border is, and which
direction it's in — so that over time you build a feel for where Logan Square
stops and Avondale starts.

There is no server. The boundary polygons ship with the page, the lookup is a
point-in-polygon test in your browser, and your location never leaves the
device.

## Using it

Open `index.html` — from a web host, or straight off disk by double-clicking it.
Then:

- **Locate me** — one GPS fix, and the answer.
- **Follow me** — keeps updating as you move, so you can watch the name change
  when you cross a line.
- **Tap the map** — checks any spot you point at, no GPS needed.
- **Search** — jumps to a neighborhood, including local names that aren't on the
  official map ("Pilsen", "Bronzeville", "K-Town", "Back of the Yards").
- **Zoom in** — once a neighborhood roughly fills the view, the boundary lines
  label themselves with the street they follow: Logan Square turns out to be
  Diversey, Western, Bloomingdale and Pulaski. That is the fastest way to learn
  a border, because you already know the streets.
- **Neighborhoods / Community areas** — switches which of the two boundary sets
  the map draws. The answer card always names both.

Browsers only hand out location over a secure context. Served over HTTPS or
opened as a local file it works; served over plain `http://` from another
machine it won't.

### Running it locally

```sh
python3 -m http.server 8000   # then open http://localhost:8000
```

A local server isn't required, but it is what lets the service worker install,
which makes the app work with no signal at all after the first visit.

### Deploying

Everything is static, so any web host works — Netlify, S3, a directory on a box
you already own.

This repository ships a GitHub Pages workflow
(`.github/workflows/pages.yml`): every push to `main` publishes the repository
root as-is. It needs one manual step first, which only a repository admin can
do — **Settings → Pages → Source: "GitHub Actions"**. Until that is set, the
workflow will fail at the deploy step.

Every path in the page is relative, so it works from a project subpath
(`https://<user>.github.io/neighborhoods/`) as well as from a domain root.

## How it works

- `data/boundaries.js` holds both boundary sets as flat coordinate arrays,
  assigned to a global so the page works from `file://` (where `fetch()` of a
  local JSON file is blocked).
- `js/geometry.js` — even-odd ray casting for point-in-polygon, plus
  point-to-segment distance and bearings. Chicago is small enough that treating
  longitude as `x · cos(latitude)` is accurate to well under a metre.
- `js/locator.js` — containment plus the nearest-border ranking. The whole
  dataset is around 12,000 segments, so every query is a linear scan and still
  finishes in a millisecond or two.
- `js/map.js` — the map is drawn on a `<canvas>` from those same polygons. No
  tile server and no map library, which is why it still works offline.
- `js/aliases.js` — a hand-written table of local names that don't have their
  own polygon in the city's files.

Border street names are matched at build time, not in the browser: each
boundary segment is tested against the city's street centerlines, and a segment
that runs within 35 m of a roughly parallel street takes its name. Consecutive
segments on the same street are merged into one stretch, which gets a label at
its midpoint and every 700 m along its length. Only the resulting labels ship —
about 1,800 of them, in place of 87 MB of street geometry. A boundary that
follows no street, like a rail embankment, stays unlabelled rather than being
given a name it doesn't have.

## The data

Both layers come from the [City of Chicago open data
portal](https://data.cityofchicago.org):

| Layer | Count | What it is |
| --- | --- | --- |
| Neighborhoods | 98 | The names people actually use — Wrigleyville, Bucktown, Andersonville. |
| Community areas | 77 | The city's official statistical geography, fixed since the 1920s. |
| Street centerlines | 56,321 | Used at build time only, to name the streets the boundaries follow. |

Polygons are simplified to about two metres, which is finer than a phone's GPS
fix and takes the bundle from 3.3 MB to 230 KB.

To rebuild from source:

```sh
python3 tools/build_data.py
```

It downloads from the data portal, falls back to public mirrors of the same
files, caches the raw downloads in `.cache/`, and rewrites
`data/boundaries.js`. The street centerline file is an 87 MB download; pass
`--no-streets` to skip it and build the boundaries alone.

## Caveats worth knowing

- **The suburbs are blank.** These are the City of Chicago's own boundary files,
  so anywhere outside the city limits gets "Outside Chicago" plus the nearest
  city neighborhood. Oak Park and Evanston are not in the data.
- **Neighborhood names are contested.** The 98-neighborhood file is one
  reasonable answer, not the answer; the boundary between Bucktown and Logan
  Square depends on who you ask. The 77 community areas are the stable,
  official layer, which is why both are shown.
- **GPS is fuzzier than the lines.** When your fix is less accurate than the
  distance to the nearest border, the app says so rather than pretending.
