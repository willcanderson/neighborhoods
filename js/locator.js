// Turns a longitude/latitude into an answer: which neighborhood, which official
// community area, how far you are from the nearest border and in which
// direction. The whole dataset is only a few thousand segments, so every query
// is a straight linear scan - fast enough to run on every GPS update.
window.Locator = (function () {
  "use strict";

  // Anything closer than this to another neighborhood is worth naming: you are
  // near enough to the line that a local would hedge about which side you're on.
  const NEAR_BORDER_M = 400;

  function create(data, localNames) {
    const layers = data.layers;
    const names = localNames || {};

    // Every name that has its own polygon somewhere in the data. A nickname
    // that is already drawn on the map is not a hidden local name, so it never
    // shows up in the "also known as" list.
    const mapped = new Set();
    for (const key of Object.keys(layers)) {
      for (const feature of layers[key].features) mapped.add(feature.n);
    }

    function containing(layerKey, x, y) {
      const features = layers[layerKey].features;
      for (let i = 0; i < features.length; i++) {
        if (Geo.pointInFeature(x, y, features[i])) return features[i];
      }
      return null;
    }

    // Distance from the point to every feature in a layer except `skip`,
    // nearest first. Bounding boxes let us skip most features outright.
    function ranked(layerKey, x, y, skip, limitM) {
      const out = [];
      const padDeg = limitM ? limitM / 90000 : null;
      for (const feature of layers[layerKey].features) {
        if (feature === skip) continue;
        if (padDeg !== null && !Geo.inBbox(x, y, feature.b, padDeg)) continue;
        const edge = Geo.distanceToEdge(x, y, feature);
        if (limitM && edge.meters > limitM) continue;
        out.push({
          feature: feature,
          meters: edge.meters,
          point: edge.point,
          bearing: Geo.bearing(x, y, edge.point[0], edge.point[1]),
        });
      }
      out.sort((a, b) => a.meters - b.meters);
      for (const item of out) item.direction = Geo.compassName(item.bearing);
      return out;
    }

    // Nicknames for the smallest shape containing the point - a name attached
    // to a whole community area says less about where you actually stand.
    function localNamesFor(feature, community) {
      const key = (feature && feature.n) || (community && community.n);
      const out = [];
      for (const name of (key && names[key]) || []) {
        if (mapped.has(name)) continue;
        if (out.indexOf(name) === -1) out.push(name);
      }
      return out;
    }

    // The full description of a point, ready for the UI to render.
    function describe(x, y) {
      const neighborhood = containing("neighborhood", x, y);
      const community = containing("community", x, y);
      const result = {
        lon: x,
        lat: y,
        inCity: Boolean(neighborhood || community),
        neighborhood: neighborhood,
        community: community,
        localNames: localNamesFor(neighborhood, community),
        depth: null,
        nearBorders: [],
        nearest: null,
      };

      if (neighborhood) {
        const edge = Geo.distanceToEdge(x, y, neighborhood);
        result.depth = {
          meters: edge.meters,
          direction: Geo.compassName(
            Geo.bearing(x, y, edge.point[0], edge.point[1])
          ),
        };
        result.nearBorders = ranked(
          "neighborhood", x, y, neighborhood, NEAR_BORDER_M
        );
      } else {
        // Outside the city (or in a gap in the neighborhood layer) - say what
        // you're closest to instead of shrugging.
        const near = ranked("neighborhood", x, y, null, 25000);
        result.nearest = near.length ? near[0] : null;
      }
      return result;
    }

    // Every feature name plus its local nicknames, for the browse/search list.
    function index() {
      const entries = [];
      for (const key of Object.keys(layers)) {
        for (const feature of layers[key].features) {
          entries.push({
            layer: key,
            feature: feature,
            name: feature.n,
            alt: (names[feature.n] || []).join(" "),
          });
        }
      }
      return entries;
    }

    function search(query, limit) {
      const q = query.trim().toLowerCase();
      if (!q) return [];
      const scored = [];
      for (const entry of index()) {
        const name = entry.name.toLowerCase();
        let score = -1;
        let matchedAlias = null;
        if (name === q) score = 0;
        else if (name.indexOf(q) === 0) score = 1;
        else if (name.indexOf(q) !== -1) score = 2;
        else {
          for (const alias of names[entry.name] || []) {
            // Aliases with polygons of their own already match on their name.
            if (mapped.has(alias)) continue;
            if (alias.toLowerCase().indexOf(q) !== -1) {
              score = alias.toLowerCase().indexOf(q) === 0 ? 3 : 4;
              matchedAlias = alias;
              break;
            }
          }
        }
        if (score < 0) continue;
        scored.push({
          // Prefer the colloquial layer when both layers match equally well.
          score: score * 2 + (entry.layer === "neighborhood" ? 0 : 1),
          entry: Object.assign({ matchedAlias: matchedAlias }, entry),
        });
      }
      scored.sort((a, b) => a.score - b.score || a.entry.name.localeCompare(b.entry.name));

      // The same name often exists in both layers; show it once.
      const out = [];
      const seen = new Set();
      for (const item of scored) {
        const key = item.entry.name + "|" + (item.entry.matchedAlias || "");
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(item.entry);
        if (out.length >= (limit || 12)) break;
      }
      return out;
    }

    return {
      layers: layers,
      describe: describe,
      search: search,
      index: index,
      ranked: ranked,
    };
  }

  return { create: create, NEAR_BORDER_M: NEAR_BORDER_M };
})();
