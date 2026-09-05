// Small planar-geometry helpers. Chicago is compact enough (about 40 km tall)
// that treating longitude as x * cos(latitude) and latitude as y is accurate to
// well under a metre, which is finer than both our simplified boundaries and a
// phone's GPS fix.
//
// Plain script, not a module, so the app still runs when index.html is opened
// straight from disk.
window.Geo = (function () {
  "use strict";
  const M_PER_DEG_LAT = 111132.0;

  function metersPerDegreeLon(lat) {
    return 111320.0 * Math.cos((lat * Math.PI) / 180);
  }

  // Squared distance in metres from p to the segment ab, all in lon/lat degrees.
  function segmentDistanceSq(px, py, ax, ay, bx, by, mLon) {
    const dx = (bx - ax) * mLon;
    const dy = (by - ay) * M_PER_DEG_LAT;
    const qx = (px - ax) * mLon;
    const qy = (py - ay) * M_PER_DEG_LAT;
    const den = dx * dx + dy * dy;
    let t = den === 0 ? 0 : (qx * dx + qy * dy) / den;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const ex = qx - t * dx;
    const ey = qy - t * dy;
    return { d2: ex * ex + ey * ey, t, ax, ay, bx, by };
  }

  function inBbox(x, y, bbox, padDeg = 0) {
    return (
      x >= bbox[0] - padDeg &&
      x <= bbox[2] + padDeg &&
      y >= bbox[1] - padDeg &&
      y <= bbox[3] + padDeg
    );
  }

  // Even-odd ray cast against a flat [x0,y0,x1,y1,...] ring.
  function pointInRing(x, y, ring) {
    let inside = false;
    const n = ring.length / 2;
    let j = n - 1;
    for (let i = 0; i < n; i++) {
      const xi = ring[2 * i];
      const yi = ring[2 * i + 1];
      const xj = ring[2 * j];
      const yj = ring[2 * j + 1];
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) {
        inside = !inside;
      }
      j = i;
    }
    return inside;
  }

  // A feature contains the point when it falls inside some polygon's outline and
  // outside every hole punched in that same polygon.
  function pointInFeature(x, y, feature) {
    if (!inBbox(x, y, feature.b)) return false;
    for (const polygon of feature.p) {
      if (!pointInRing(x, y, polygon[0])) continue;
      let inHole = false;
      for (let i = 1; i < polygon.length; i++) {
        if (pointInRing(x, y, polygon[i])) {
          inHole = true;
          break;
        }
      }
      if (!inHole) return true;
    }
    return false;
  }

  // Nearest point on any of the feature's rings, in metres.
  function distanceToEdge(x, y, feature) {
    const mLon = metersPerDegreeLon(y);
    let best = Infinity;
    let bestPoint = null;
    for (const polygon of feature.p) {
      for (const ring of polygon) {
        const n = ring.length / 2;
        for (let i = 0; i < n - 1; i++) {
          const hit = segmentDistanceSq(
            x, y,
            ring[2 * i], ring[2 * i + 1],
            ring[2 * i + 2], ring[2 * i + 3],
            mLon
          );
          if (hit.d2 < best) {
            best = hit.d2;
            bestPoint = [
              hit.ax + (hit.bx - hit.ax) * hit.t,
              hit.ay + (hit.by - hit.ay) * hit.t,
            ];
          }
        }
      }
    }
    return { meters: Math.sqrt(best), point: bestPoint };
  }

  // Compass bearing in degrees clockwise from north.
  function bearing(ax, ay, bx, by) {
    const dx = (bx - ax) * metersPerDegreeLon((ay + by) / 2);
    const dy = (by - ay) * M_PER_DEG_LAT;
    const deg = (Math.atan2(dx, dy) * 180) / Math.PI;
    return (deg + 360) % 360;
  }

  const COMPASS = [
    "north", "northeast", "east", "southeast",
    "south", "southwest", "west", "northwest",
  ];

  function compassName(deg) {
    return COMPASS[Math.round(deg / 45) % 8];
  }

  function formatDistance(meters) {
    const feet = meters * 3.28084;
    if (feet < 1000) return `${Math.round(feet / 10) * 10} ft`;
    const miles = meters / 1609.344;
    if (miles < 10) return `${miles.toFixed(1)} mi`;
    return `${Math.round(miles)} mi`;
  }

  return {
    metersPerDegreeLon: metersPerDegreeLon,
    inBbox: inBbox,
    pointInFeature: pointInFeature,
    distanceToEdge: distanceToEdge,
    bearing: bearing,
    compassName: compassName,
    formatDistance: formatDistance,
    M_PER_DEG_LAT: M_PER_DEG_LAT,
  };
})();
