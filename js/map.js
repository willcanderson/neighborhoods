// A tiny vector map drawn on a canvas from the same boundary data the locator
// uses. No tile server and no map library, so the map keeps working on a bad
// connection, on a plane, or straight off the filesystem.
window.NeighborhoodMap = (function () {
  "use strict";

  const MIN_SCALE = 700;     // pixels per degree of latitude (whole city, zoomed out)
  const MAX_SCALE = 400000;  // roughly a city block across

  function hash(text) {
    let h = 0;
    for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) | 0;
    return Math.abs(h);
  }

  function create(canvas, options) {
    const opts = options || {};
    const ctx = canvas.getContext("2d");
    const view = { lon: -87.6298, lat: 41.8781, scale: 9000 };
    let features = [];
    let activeName = null;
    let marker = null; // {lon, lat, accuracy}
    let probe = null;  // {lon, lat}
    let width = 0;
    let height = 0;
    let theme = readTheme();

    function readTheme() {
      const css = getComputedStyle(document.documentElement);
      const get = (name, fallback) =>
        (css.getPropertyValue(name) || fallback).trim();
      return {
        water: get("--map-water", "#0f1720"),
        land: get("--map-land", "#1b2530"),
        line: get("--map-line", "#33475c"),
        activeFill: get("--map-active-fill", "#2f6f8f"),
        activeLine: get("--map-active-line", "#7fd3ff"),
        label: get("--map-label", "#dce6f0"),
        labelHalo: get("--map-label-halo", "#0b1219"),
        marker: get("--map-marker", "#ffd166"),
        markerFill: get("--map-marker-fill", "rgba(255, 209, 102, 0.16)"),
        markerRing: get("--map-marker-ring", "rgba(255, 209, 102, 0.5)"),
        // A short list of muted fills, cycled by name hash so neighbouring
        // shapes are told apart without the map turning into a quilt.
        palette: get("--map-palette", "#1b2530").split("|").map((c) => c.trim()),
      };
    }

    function lonScale() {
      return Math.cos((view.lat * Math.PI) / 180);
    }

    function project(lon, lat) {
      return [
        (lon - view.lon) * lonScale() * view.scale + width / 2,
        (view.lat - lat) * view.scale + height / 2,
      ];
    }

    function unproject(px, py) {
      return [
        (px - width / 2) / (view.scale * lonScale()) + view.lon,
        view.lat - (py - height / 2) / view.scale,
      ];
    }

    function resize() {
      const ratio = window.devicePixelRatio || 1;
      const rect = canvas.getBoundingClientRect();
      width = rect.width;
      height = rect.height;
      canvas.width = Math.max(1, Math.round(width * ratio));
      canvas.height = Math.max(1, Math.round(height * ratio));
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
      draw();
    }

    function tracePolygon(polygon) {
      for (const ring of polygon) {
        const n = ring.length / 2;
        for (let i = 0; i < n; i++) {
          const p = project(ring[2 * i], ring[2 * i + 1]);
          if (i === 0) ctx.moveTo(p[0], p[1]);
          else ctx.lineTo(p[0], p[1]);
        }
        ctx.closePath();
      }
    }

    function visible(feature) {
      const a = project(feature.b[0], feature.b[3]);
      const b = project(feature.b[2], feature.b[1]);
      return !(b[0] < -40 || a[0] > width + 40 || b[1] < -40 || a[1] > height + 40);
    }

    function fillFor(feature) {
      if (feature.n === activeName) return theme.activeFill;
      return theme.palette[hash(feature.n) % theme.palette.length];
    }

    function draw() {
      if (!width || !height) return;
      ctx.save();
      ctx.fillStyle = theme.water;
      ctx.fillRect(0, 0, width, height);

      const shown = features.filter(visible);
      let active = null;

      for (const feature of shown) {
        if (feature.n === activeName) {
          active = feature;
          continue;
        }
        ctx.beginPath();
        for (const polygon of feature.p) tracePolygon(polygon);
        ctx.fillStyle = fillFor(feature);
        ctx.fill("evenodd");
        ctx.strokeStyle = theme.line;
        ctx.lineWidth = 1;
        ctx.stroke();
      }

      if (active) {
        ctx.beginPath();
        for (const polygon of active.p) tracePolygon(polygon);
        ctx.fillStyle = theme.activeFill;
        ctx.fill("evenodd");
        ctx.strokeStyle = theme.activeLine;
        ctx.lineWidth = 2.5;
        ctx.stroke();
      }

      drawLabels(shown);
      if (probe) drawProbe(probe);
      if (marker) drawMarker(marker);
      ctx.restore();
    }

    function drawLabels(shown) {
      // Seed the collision list with the on-screen controls so no label ends up
      // hidden behind the zoom buttons.
      const placed = [[width - 58, 0, width, 210]];
      // Biggest shapes first, so a large neighborhood keeps its label when a
      // sliver next to it would otherwise crowd it out.
      const ordered = shown.slice().sort((a, b) => {
        const areaOf = (f) => (f.b[2] - f.b[0]) * (f.b[3] - f.b[1]);
        return areaOf(b) - areaOf(a);
      });
      for (const feature of ordered) {
        const widthPx = (feature.b[2] - feature.b[0]) * lonScale() * view.scale;
        if (widthPx < 46) continue;
        const anchor = project(feature.c[0], feature.c[1]);
        const isActive = feature.n === activeName;
        const size = isActive ? 15 : 12;
        ctx.font = `${isActive ? 700 : 500} ${size}px system-ui, sans-serif`;
        const w = ctx.measureText(feature.n).width;
        // Nudge a label that runs off the edge back into view, but never so far
        // that it drifts away from the shape it names.
        const slack = Math.min(widthPx * 0.3, 70);
        let x = Math.min(Math.max(anchor[0], w / 2 + 6), width - w / 2 - 6);
        x = Math.min(Math.max(x, anchor[0] - slack), anchor[0] + slack);
        const p = [x, anchor[1]];
        if (p[0] - w / 2 < 2 || p[0] + w / 2 > width - 2) continue;
        if (p[1] < 12 || p[1] > height - 6) continue;
        const box = [p[0] - w / 2, p[1] - size, p[0] + w / 2, p[1] + 4];
        const clash = placed.some(
          (q) => !(box[2] < q[0] || box[0] > q[2] || box[3] < q[1] || box[1] > q[3])
        );
        if (clash && !isActive) continue;
        placed.push(box);
        ctx.textAlign = "center";
        ctx.lineJoin = "round";
        ctx.strokeStyle = theme.labelHalo;
        ctx.lineWidth = 3.5;
        ctx.strokeText(feature.n, p[0], p[1]);
        ctx.fillStyle = isActive ? theme.activeLine : theme.label;
        ctx.fillText(feature.n, p[0], p[1]);
      }
    }

    function drawMarker(m) {
      const p = project(m.lon, m.lat);
      if (m.accuracy) {
        const r = (m.accuracy / Geo.M_PER_DEG_LAT) * view.scale;
        if (r > 3) {
          ctx.beginPath();
          ctx.arc(p[0], p[1], r, 0, Math.PI * 2);
          ctx.fillStyle = theme.markerFill;
          ctx.fill();
          ctx.strokeStyle = theme.markerRing;
          ctx.lineWidth = 1;
          ctx.stroke();
        }
      }
      ctx.beginPath();
      ctx.arc(p[0], p[1], 7, 0, Math.PI * 2);
      ctx.fillStyle = theme.marker;
      ctx.fill();
      ctx.strokeStyle = theme.labelHalo;
      ctx.lineWidth = 2.5;
      ctx.stroke();
    }

    function drawProbe(p0) {
      const p = project(p0.lon, p0.lat);
      ctx.beginPath();
      ctx.moveTo(p[0] - 9, p[1]);
      ctx.lineTo(p[0] + 9, p[1]);
      ctx.moveTo(p[0], p[1] - 9);
      ctx.lineTo(p[0], p[1] + 9);
      ctx.strokeStyle = theme.activeLine;
      ctx.lineWidth = 2;
      ctx.stroke();
    }

    function setFeatures(list) {
      features = list;
      draw();
    }

    function setActive(name) {
      activeName = name;
      draw();
    }

    function setMarker(next) {
      marker = next;
      draw();
    }

    function setProbe(next) {
      probe = next;
      draw();
    }

    function centerOn(lon, lat, scale) {
      view.lon = lon;
      view.lat = lat;
      if (scale) view.scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));
      draw();
    }

    // Fit a bounding box with a little breathing room around it.
    function fitBbox(bbox, padding) {
      const pad = padding == null ? 0.15 : padding;
      const lat = (bbox[1] + bbox[3]) / 2;
      const lon = (bbox[0] + bbox[2]) / 2;
      const spanLat = Math.max(1e-4, bbox[3] - bbox[1]);
      const spanLon = Math.max(1e-4, (bbox[2] - bbox[0]) * Math.cos((lat * Math.PI) / 180));
      const scale = Math.min(
        height / (spanLat * (1 + pad * 2)),
        width / (spanLon * (1 + pad * 2))
      );
      view.lon = lon;
      view.lat = lat;
      view.scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));
      draw();
    }

    function zoomBy(factor, anchorX, anchorY) {
      const ax = anchorX == null ? width / 2 : anchorX;
      const ay = anchorY == null ? height / 2 : anchorY;
      const before = unproject(ax, ay);
      view.scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, view.scale * factor));
      const after = unproject(ax, ay);
      view.lon += before[0] - after[0];
      view.lat += before[1] - after[1];
      draw();
    }

    function refreshTheme() {
      theme = readTheme();
      draw();
    }

    // --- interaction -------------------------------------------------------
    const pointers = new Map();
    let dragged = 0;
    let pinchStart = null;

    canvas.addEventListener("pointerdown", (event) => {
      canvas.setPointerCapture(event.pointerId);
      pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      dragged = 0;
      if (pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        pinchStart = { dist: Math.hypot(a.x - b.x, a.y - b.y), scale: view.scale };
      }
    });

    canvas.addEventListener("pointermove", (event) => {
      const previous = pointers.get(event.pointerId);
      if (!previous) return;
      const next = { x: event.clientX, y: event.clientY };
      pointers.set(event.pointerId, next);

      if (pointers.size === 2 && pinchStart) {
        const [a, b] = [...pointers.values()];
        const dist = Math.hypot(a.x - b.x, a.y - b.y);
        if (pinchStart.dist > 0) {
          view.scale = Math.min(
            MAX_SCALE,
            Math.max(MIN_SCALE, pinchStart.scale * (dist / pinchStart.dist))
          );
          draw();
        }
        return;
      }

      const dx = next.x - previous.x;
      const dy = next.y - previous.y;
      dragged += Math.abs(dx) + Math.abs(dy);
      view.lon -= dx / (view.scale * lonScale());
      view.lat += dy / view.scale;
      draw();
    });

    function endPointer(event) {
      const wasDrag = dragged > 6;
      pointers.delete(event.pointerId);
      if (pointers.size < 2) pinchStart = null;
      if (!wasDrag && pointers.size === 0 && opts.onTap) {
        const rect = canvas.getBoundingClientRect();
        const at = unproject(event.clientX - rect.left, event.clientY - rect.top);
        opts.onTap(at[0], at[1]);
      }
    }

    canvas.addEventListener("pointerup", endPointer);
    canvas.addEventListener("pointercancel", (event) => {
      pointers.delete(event.pointerId);
      pinchStart = null;
    });

    canvas.addEventListener(
      "wheel",
      (event) => {
        event.preventDefault();
        const rect = canvas.getBoundingClientRect();
        zoomBy(
          Math.exp(-event.deltaY * 0.002),
          event.clientX - rect.left,
          event.clientY - rect.top
        );
      },
      { passive: false }
    );

    window.addEventListener("resize", resize);
    resize();

    return {
      resize: resize,
      draw: draw,
      setFeatures: setFeatures,
      setActive: setActive,
      setMarker: setMarker,
      setProbe: setProbe,
      centerOn: centerOn,
      fitBbox: fitBbox,
      zoomBy: zoomBy,
      refreshTheme: refreshTheme,
      view: view,
    };
  }

  return { create: create, MIN_SCALE: MIN_SCALE, MAX_SCALE: MAX_SCALE };
})();
