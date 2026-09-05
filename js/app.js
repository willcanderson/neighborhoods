// Wires the locator, the map and the DOM together.
(function () {
  "use strict";

  const data = window.CHICAGO_BOUNDARIES;
  const answerEl = document.getElementById("answer");
  const locateBtn = document.getElementById("locate");
  const followBtn = document.getElementById("follow");
  const searchEl = document.getElementById("search");
  const resultsEl = document.getElementById("results");
  const canvas = document.getElementById("map");

  if (!data) {
    answerEl.className = "answer error";
    answerEl.innerHTML =
      "<h2 class='headline small'>Boundary data didn't load</h2>" +
      "<p class='detail'>Run <code>python3 tools/build_data.py</code> to regenerate " +
      "<code>data/boundaries.js</code>.</p>";
    return;
  }

  const locator = Locator.create(data, window.LOCAL_NAMES);
  let layerKey = "neighborhood";
  let watchId = null;
  let lastFix = null;    // the most recent GPS position
  let lastResult = null; // whatever the card is currently describing

  const map = NeighborhoodMap.create(canvas, { onTap: onMapTap });
  map.setFeatures(data.layers[layerKey].features);
  map.setBorders(data.layers[layerKey].borders, data.streets);
  fitWholeCity();

  // --- rendering ---------------------------------------------------------

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function fmt(meters) {
    return Geo.formatDistance(meters);
  }

  function renderCard(parts) {
    answerEl.className = "answer" + (parts.error ? " error" : "");
    answerEl.replaceChildren();
    answerEl.appendChild(el("p", "eyebrow", parts.eyebrow));
    answerEl.appendChild(
      el("h2", "headline" + (parts.small ? " small" : ""), parts.headline)
    );
    if (parts.subhead) {
      const p = el("p", "subhead");
      p.appendChild(el("b", null, parts.subhead));
      if (parts.subheadTail) p.appendChild(document.createTextNode(parts.subheadTail));
      answerEl.appendChild(p);
    }
    for (const line of parts.details || []) {
      if (line) answerEl.appendChild(el("p", "detail", line));
    }
    if (parts.chips && parts.chips.length) {
      const list = el("ul", "chips");
      for (const chip of parts.chips) list.appendChild(el("li", null, chip));
      answerEl.appendChild(list);
    }
    if (parts.meta) answerEl.appendChild(el("p", "meta", parts.meta));
  }

  // Turns a locator result into the sentences on the card. `person` switches
  // between "to your north" for a real fix and "to the north" for a point the
  // user tapped or looked up.
  function describeLines(result, person, accuracy) {
    const lines = [];
    const border = result.nearBorders[0];
    const whose = person ? "to your " : "to the ";
    if (border) {
      lines.push(
        `The ${border.feature.n} border is ${fmt(border.meters)} ` +
          whose + border.direction + "."
      );
    } else if (result.depth) {
      lines.push(
        `${fmt(result.depth.meters)} from the nearest edge of ` +
          `${result.neighborhood.n} \u2014 well inside it.`
      );
    }
    const others = result.nearBorders.slice(1, 4);
    if (others.length) {
      lines.push(
        "Also within a short walk: " +
          others
            .map((b) => `${b.feature.n} (${fmt(b.meters)} ${b.direction})`)
            .join(", ") +
          "."
      );
    }
    // Don't let a confident sentence outrun a fuzzy GPS fix.
    if (person && accuracy && border && accuracy > border.meters) {
      lines.push(
        `Your fix is only accurate to about ${fmt(accuracy)}, which is further ` +
          `than that border \u2014 you could be on either side of it.`
      );
    }
    return lines;
  }

  function communityLine(result) {
    if (!result.community) return null;
    if (result.neighborhood && result.neighborhood.n === result.community.n) {
      return {
        head: result.community.n,
        tail: " \u2014 both a neighborhood and one of the 77 official community areas.",
      };
    }
    return { head: result.community.n, tail: " community area" };
  }

  function showResult(result, context) {
    lastResult = result;

    if (!result.inCity) {
      const near = result.nearest;
      renderCard({
        eyebrow: context.person ? "Your location" : "That point",
        headline: "Outside Chicago",
        small: true,
        details: [
          near
            ? `Nearest Chicago neighborhood: ${near.feature.n}, about ` +
              `${fmt(near.meters)} to the ${near.direction}.`
            : "No Chicago neighborhood within 15 miles.",
          "This map only covers the City of Chicago, so suburbs come back blank.",
        ],
        meta: context.meta,
      });
      map.setActive(near ? near.feature.n : null);
      return;
    }

    const community = communityLine(result);
    renderCard({
      eyebrow: context.eyebrow,
      headline: result.neighborhood ? result.neighborhood.n : result.community.n,
      subhead: community ? community.head : null,
      subheadTail: community ? community.tail : null,
      details: describeLines(result, context.person, context.accuracy),
      chips: result.localNames.length
        ? ["Also known around here as: " + result.localNames.join(", ")]
        : null,
      meta: context.meta,
    });

    const active = layerKey === "community" ? result.community : result.neighborhood;
    map.setActive(active ? active.n : null);
  }

  function positionMeta(position) {
    const c = position.coords;
    const time = new Date(position.timestamp || Date.now());
    const accuracy = c.accuracy ? `±${Math.round(c.accuracy)} m` : "accuracy unknown";
    return (
      `${accuracy} \u00b7 ${c.latitude.toFixed(5)}, ${c.longitude.toFixed(5)} \u00b7 ` +
      time.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
    );
  }

  // --- geolocation -------------------------------------------------------

  function onPosition(position, options) {
    lastFix = position;
    const c = position.coords;
    map.setProbe(null);
    map.setMarker({ lon: c.longitude, lat: c.latitude, accuracy: c.accuracy });
    const result = locator.describe(c.longitude, c.latitude);
    showResult(result, {
      eyebrow: "You are in",
      meta: positionMeta(position),
      person: true,
      accuracy: c.accuracy,
    });
    if (options && options.recenter) {
      const feature =
        layerKey === "community" ? result.community : result.neighborhood;
      if (feature) map.fitBbox(feature.b, 0.25);
      else map.centerOn(c.longitude, c.latitude, 40000);
    }
    locateBtn.disabled = false;
    locateBtn.textContent = "Locate me";
  }

  function onGeolocationError(error) {
    locateBtn.disabled = false;
    locateBtn.textContent = "Locate me";
    setFollowing(false);
    const messages = {
      1: "Location permission was denied. Allow it in your browser's site settings and try again.",
      2: "Your device couldn't get a fix. Try again outdoors or near a window.",
      3: "Finding you took too long. Try again.",
    };
    renderCard({
      error: true,
      eyebrow: "Location unavailable",
      headline: "Couldn't find you",
      small: true,
      details: [
        messages[error.code] || error.message || "Unknown geolocation error.",
        "You can still tap anywhere on the map to check that spot.",
      ],
    });
  }

  function locateOnce() {
    if (!navigator.geolocation) {
      onGeolocationError({ code: 2, message: "This browser has no geolocation API." });
      return;
    }
    locateBtn.disabled = true;
    locateBtn.textContent = "Locating…";
    navigator.geolocation.getCurrentPosition(
      (position) => onPosition(position, { recenter: true }),
      onGeolocationError,
      { enableHighAccuracy: true, timeout: 20000, maximumAge: 15000 }
    );
  }

  function setFollowing(on) {
    if (on && watchId === null) {
      if (!navigator.geolocation) return;
      watchId = navigator.geolocation.watchPosition(
        (position) => onPosition(position, { recenter: false }),
        onGeolocationError,
        { enableHighAccuracy: true, timeout: 25000, maximumAge: 5000 }
      );
    } else if (!on && watchId !== null) {
      navigator.geolocation.clearWatch(watchId);
      watchId = null;
    }
    followBtn.setAttribute("aria-pressed", watchId !== null ? "true" : "false");
    followBtn.textContent = watchId !== null ? "Following" : "Follow me";
  }

  // --- map interaction ---------------------------------------------------

  function onMapTap(lon, lat) {
    map.setProbe({ lon: lon, lat: lat });
    const result = locator.describe(lon, lat);
    showResult(result, {
      eyebrow: "That spot is in",
      meta: `${lat.toFixed(5)}, ${lon.toFixed(5)} \u00b7 tapped on the map`,
    });
  }

  function fitWholeCity() {
    const features = data.layers[layerKey].features;
    const bbox = [Infinity, Infinity, -Infinity, -Infinity];
    for (const feature of features) {
      bbox[0] = Math.min(bbox[0], feature.b[0]);
      bbox[1] = Math.min(bbox[1], feature.b[1]);
      bbox[2] = Math.max(bbox[2], feature.b[2]);
      bbox[3] = Math.max(bbox[3], feature.b[3]);
    }
    map.fitBbox(bbox, 0.04);
  }

  function setLayer(key) {
    if (key === layerKey) return;
    layerKey = key;
    map.setFeatures(data.layers[key].features);
    map.setBorders(data.layers[key].borders, data.streets);
    for (const button of document.querySelectorAll(".segmented button")) {
      button.setAttribute(
        "aria-pressed",
        button.dataset.layer === key ? "true" : "false"
      );
    }
    if (lastResult) {
      const feature =
        key === "community" ? lastResult.community : lastResult.neighborhood;
      map.setActive(feature ? feature.n : null);
    }
  }

  // --- search ------------------------------------------------------------

  function renderResults(entries) {
    resultsEl.replaceChildren();
    for (const entry of entries) {
      const item = document.createElement("li");
      const button = document.createElement("button");
      button.type = "button";
      button.appendChild(el("span", null, entry.matchedAlias || entry.name));
      button.appendChild(
        el(
          "span",
          "kind",
          entry.matchedAlias
            ? "in " + entry.name
            : data.layers[entry.layer].label.toLowerCase()
        )
      );
      button.addEventListener("click", () => {
        setLayer(entry.layer);
        map.setActive(entry.feature.n);
        map.fitBbox(entry.feature.b, 0.2);
        const centre = locator.describe(entry.feature.c[0], entry.feature.c[1]);
        map.setProbe(null);
        showResult(centre, {
          eyebrow: "Looking at",
          meta: "Middle of " + entry.feature.n,
        });
        canvas.scrollIntoView({ behavior: "smooth", block: "nearest" });
      });
      item.appendChild(button);
      resultsEl.appendChild(item);
    }
  }

  searchEl.addEventListener("input", () => {
    renderResults(locator.search(searchEl.value, 10));
  });

  // --- buttons -----------------------------------------------------------

  locateBtn.addEventListener("click", locateOnce);
  followBtn.addEventListener("click", () =>
    setFollowing(followBtn.getAttribute("aria-pressed") !== "true")
  );
  document.getElementById("zoom-in").addEventListener("click", () => map.zoomBy(1.6));
  document.getElementById("zoom-out").addEventListener("click", () => map.zoomBy(1 / 1.6));
  document.getElementById("whole-city").addEventListener("click", fitWholeCity);
  document.getElementById("recenter").addEventListener("click", () => {
    if (lastFix) {
      map.centerOn(lastFix.coords.longitude, lastFix.coords.latitude, 60000);
    } else {
      locateOnce();
    }
  });

  for (const button of document.querySelectorAll(".segmented button")) {
    button.addEventListener("click", () => setLayer(button.dataset.layer));
  }

  if (window.matchMedia) {
    const scheme = window.matchMedia("(prefers-color-scheme: dark)");
    const onSchemeChange = () => map.refreshTheme();
    if (scheme.addEventListener) scheme.addEventListener("change", onSchemeChange);
  }

  // Offline support only makes sense when the page is actually served; opened
  // from the filesystem there is nothing to intercept.
  if ("serviceWorker" in navigator && location.protocol.startsWith("http")) {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("sw.js").catch(() => {});
    });
  }
})();
