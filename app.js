// Live surf and sailing briefing. Numbers come only from NWS and NOAA responses.
// Browser fetches do not set User-Agent: api.weather.gov rejects that header on CORS preflight.

const FALLBACK = { lat: 32.99, lon: -117.27 };
const TIDE_KM = 60;
const MARINE_RE = /^(PZZ|PKZ|PHZ|PMZ|PNZ|AMZ|ANZ|GMZ|LHZ|LMZ|LOZ|LEZ|LSZ|LCZ|SLZ)/;
const DIRS = [
  { bearing: 0, y: 1, x: 0 },
  { bearing: 45, y: 0.7071, x: 0.7071 },
  { bearing: 90, y: 0, x: 1 },
  { bearing: 135, y: -0.7071, x: 0.7071 },
  { bearing: 180, y: -1, x: 0 },
  { bearing: 225, y: -0.7071, x: -0.7071 },
  { bearing: 270, y: 0, x: -1 },
  { bearing: 315, y: 0.7071, x: -0.7071 },
];
const DIR_DEG = {
  N: 0, NNE: 22.5, NE: 45, ENE: 67.5, E: 90, ESE: 112.5, SE: 135, SSE: 157.5,
  S: 180, SSW: 202.5, SW: 225, WSW: 247.5, W: 270, WNW: 292.5, NW: 315, NNW: 337.5,
};

async function fetchJson(url) {
  let last;
  for (let i = 0; i < 2; i++) {
    const res = await fetch(url, { cache: "no-store" });
    if (res.status === 429 || res.status >= 500) {
      last = new Error("HTTP " + res.status);
      last.status = res.status;
      await new Promise((r) => setTimeout(r, 600 * (i + 1)));
      continue;
    }
    if (!res.ok) {
      const err = new Error("HTTP " + res.status);
      err.status = res.status;
      throw err;
    }
    return res.json();
  }
  throw last;
}

function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const p1 = (lat1 * Math.PI) / 180;
  const p2 = (lat2 * Math.PI) / 180;
  const dp = ((lat2 - lat1) * Math.PI) / 180;
  const dl = ((lon2 - lon1) * Math.PI) / 180;
  const a = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

function zoneId(url) {
  if (!url) return "";
  const parts = String(url).split("/");
  return parts[parts.length - 1] || "";
}

function isMarine(id) {
  return MARINE_RE.test(id || "");
}

function addDuration(start, dur) {
  const m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(dur || "");
  const t = start.getTime();
  if (!m) return new Date(t);
  const days = Number(m[1] || 0);
  const hours = Number(m[2] || 0);
  const mins = Number(m[3] || 0);
  const secs = Number(m[4] || 0);
  return new Date(t + ((days * 24 + hours) * 60 + mins) * 60000 + secs * 1000);
}

function parseInterval(validTime) {
  const bits = String(validTime || "").split("/");
  if (bits.length !== 2) return null;
  const start = new Date(bits[0]);
  if (Number.isNaN(start.getTime())) return null;
  return { start, end: addDuration(start, bits[1]) };
}

function intervalValue(series, when) {
  const values = series && series.values;
  if (!values) return null;
  for (const v of values) {
    const iv = parseInterval(v.validTime);
    if (!iv) continue;
    if (when >= iv.start && when < iv.end) {
      return { value: v.value, start: iv.start, end: iv.end };
    }
  }
  return null;
}

export function cardinal(deg) {
  if (deg == null || Number.isNaN(Number(deg))) return "";
  const dirs = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];
  const n = ((Number(deg) % 360) + 360) % 360;
  return dirs[Math.round(n / 22.5) % 16];
}

function angDiff(a, b) {
  const d = Math.abs(((((a - b) % 360) + 360) % 360));
  return d > 180 ? 360 - d : d;
}

function localDateKey(date, timeZone) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit",
  }).format(date);
}

function formatWhen(date, timeZone) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone, hour: "numeric", minute: "2-digit", hour12: true,
  }).format(date);
}

function formatFull(date, timeZone) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
  }).format(date);
}

function zoneAbbrev(date, timeZone) {
  try {
    const parts = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "short" }).formatToParts(date);
    return parts.find((p) => p.type === "timeZoneName")?.value || timeZone;
  } catch {
    return timeZone;
  }
}

function ymdCompact(d) {
  return d.toISOString().slice(0, 10).replace(/-/g, "");
}

function lengthText(value, uom) {
  if (value == null || Number.isNaN(Number(value))) return null;
  const n = Number(value);
  const unit = uom || "";
  if (unit.includes(":m") || unit.endsWith("/m")) {
    const ft = n * 3.280839895;
    return ft.toFixed(1) + " ft (" + n.toFixed(2) + " m)";
  }
  if (unit.includes("ft")) return n.toFixed(1) + " ft";
  if (unit) return n + " (" + unit + ")";
  return String(n);
}

function periodText(value, uom) {
  if (value == null || Number.isNaN(Number(value))) return null;
  const n = Number(value);
  if (!uom || uom.includes(":s") || /second/i.test(uom)) return n + " s";
  return n + (uom ? " (" + uom + ")" : "");
}

function directionText(value) {
  if (value == null || Number.isNaN(Number(value))) return null;
  const n = Number(value);
  return cardinal(n) + " (" + Math.round(n) + "°)";
}

function seawardFrom(bearings) {
  if (!bearings.length) return null;
  let x = 0;
  let y = 0;
  for (const b of bearings) {
    const r = (b * Math.PI) / 180;
    x += Math.cos(r);
    y += Math.sin(r);
  }
  const strength = Math.sqrt(x * x + y * y) / bearings.length;
  // Spread-out hits (a point surrounded by water, or opposite shores) stay unlabeled.
  if (strength < 0.5) return null;
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

async function probeMarine(lat, lon) {
  const rings = [0.05, 0.1, 0.18];
  for (const ring of rings) {
    const hits = [];
    await Promise.all(DIRS.map(async (dir) => {
      const cos = Math.cos((lat * Math.PI) / 180) || 1;
      const plat = Math.round((lat + ring * dir.y) * 10000) / 10000;
      const plon = Math.round((lon + (ring * dir.x) / cos) * 10000) / 10000;
      try {
        const pt = await fetchJson("https://api.weather.gov/points/" + plat + "," + plon);
        const props = pt.properties || {};
        const id = zoneId(props.forecastZone);
        if (!isMarine(id)) return;
        hits.push({
          bearing: dir.bearing,
          km: haversine(lat, lon, plat, plon),
          target: {
            gridUrl: props.forecastGridData,
            gridId: props.gridId,
            gridX: props.gridX,
            gridY: props.gridY,
            zoneId: id,
          },
        });
      } catch {
        // That offset has no NWS grid.
      }
    }));
    if (!hits.length) continue;
    const bearings = hits.map((h) => h.bearing);
    const seaward = seawardFrom(bearings);
    let chosen = hits.slice().sort((a, b) => a.km - b.km)[0];
    if (seaward != null) {
      chosen = hits.slice().sort((a, b) => angDiff(a.bearing, seaward) - angDiff(b.bearing, seaward) || a.km - b.km)[0];
    }
    let how = "Wave numbers are from marine zone " + chosen.target.zoneId + ", about " + chosen.km.toFixed(0) + " km from this spot.";
    if (seaward != null) how += " Open water is toward " + cardinal(seaward) + ".";
    else how += " Water is not in one clear direction, so wind is not labeled onshore or offshore.";
    return { target: chosen.target, seaward, how };
  }
  return null;
}

async function loadMarine(lat, lon, props, now) {
  try {
    const ownZone = zoneId(props.forecastZone);
    let target = null;
    let seaward = null;
    let how = "";
    if (isMarine(ownZone)) {
      target = {
        gridUrl: props.forecastGridData,
        gridId: props.gridId,
        gridX: props.gridX,
        gridY: props.gridY,
        zoneId: ownZone,
      };
      how = "This point is on marine zone " + ownZone + ". Wind is not labeled onshore or offshore.";
    } else {
      const found = await probeMarine(lat, lon);
      if (!found) {
        return { ok: false, reason: "No coastal marine grid within about 20 km, so wave height is unavailable.", seaward: null };
      }
      target = found.target;
      seaward = found.seaward;
      how = found.how;
    }
    const grid = await fetchJson(target.gridUrl);
    const gprops = grid.properties || {};
    const spec = [
      ["waveHeight", "Wave height", "length"],
      ["primarySwellHeight", "Primary swell", "length"],
      ["primarySwellDirection", "Swell direction", "dir"],
      ["secondarySwellHeight", "Secondary swell", "length"],
      ["secondarySwellDirection", "Secondary direction", "dir"],
      ["wavePeriod", "Wave period", "period"],
      ["windWaveHeight", "Wind wave", "length"],
    ];
    const rows = [];
    for (const [key, label, kind] of spec) {
      const series = gprops[key];
      const hit = intervalValue(series, now);
      if (!hit || hit.value == null) continue;
      const uom = series.uom;
      let text = null;
      if (kind === "length") text = lengthText(hit.value, uom);
      else if (kind === "dir") text = directionText(hit.value);
      else text = periodText(hit.value, uom);
      if (!text) continue;
      rows.push({ label, text, until: hit.end });
    }
    if (!rows.some((r) => r.label === "Wave height" || r.label === "Primary swell")) {
      return { ok: false, reason: "The marine grid has no wave height for the current time.", seaward, how, zoneId: target.zoneId };
    }
    return {
      ok: true,
      rows,
      seaward,
      how,
      gridId: target.gridId,
      gridX: target.gridX,
      gridY: target.gridY,
      zoneId: target.zoneId,
      updateTime: gprops.updateTime || null,
    };
  } catch (e) {
    return { ok: false, reason: "Wave forecast didn't load (" + e.message + ").", seaward: null };
  }
}

async function loadTides(lat, lon, timeZone, now) {
  let stations;
  try {
    const data = await fetchJson("https://api.tidesandcurrents.noaa.gov/mdapi/prod/webapi/stations.json?type=tidepredictions");
    stations = data.stations || [];
  } catch (e) {
    return { ok: false, reason: "Tide station list didn't load (" + e.message + ")." };
  }
  const ranked = stations
    .filter((s) => s && s.id && s.lat != null && s.lng != null && !Number.isNaN(Number(s.lat)) && !Number.isNaN(Number(s.lng)))
    .map((s) => ({
      id: s.id,
      name: s.name || s.id,
      state: s.state || "",
      km: haversine(lat, lon, Number(s.lat), Number(s.lng)),
    }))
    .sort((a, b) => a.km - b.km);
  const nearby = ranked.filter((s) => s.km <= TIDE_KM).slice(0, 6);
  if (!nearby.length) {
    const n = ranked[0];
    const far = n ? " Nearest is " + n.name + (n.state ? ", " + n.state : "") + ", " + n.km.toFixed(0) + " km away." : "";
    return { ok: false, reason: "No NOAA tide station within " + TIDE_KM + " km." + far };
  }
  const begin = ymdCompact(new Date(now.getTime() - 36 * 3600000));
  const end = ymdCompact(new Date(now.getTime() + 48 * 3600000));
  let lastErr = "";
  for (const s of nearby) {
    const url = "https://api.tidesandcurrents.noaa.gov/api/prod/datagetter?begin_date=" + begin
      + "&end_date=" + end
      + "&station=" + encodeURIComponent(s.id)
      + "&product=predictions&datum=MLLW&time_zone=gmt&interval=hilo&units=english&format=json&application=SBSurf";
    try {
      const body = await fetchJson(url);
      if (!body || body.error || !Array.isArray(body.predictions)) {
        lastErr = (body && body.error && body.error.message) || "no predictions";
        continue;
      }
      const events = body.predictions.map((p) => {
        const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})$/.exec(p.t || "");
        if (!m) return null;
        const feet = Number(p.v);
        if (Number.isNaN(feet)) return null;
        const type = p.type === "H" ? "High" : p.type === "L" ? "Low" : null;
        if (!type) return null;
        return {
          time: new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5])),
          type,
          feet,
        };
      }).filter(Boolean).sort((a, b) => a.time - b.time);
      if (!events.length) {
        lastErr = "empty predictions";
        continue;
      }
      return { ok: true, station: s, events };
    } catch (e) {
      lastErr = e.message;
    }
  }
  return { ok: false, reason: "Nearby NOAA stations didn't return tide predictions" + (lastErr ? " (" + lastErr + ")." : ".") };
}

function windUpper(speed) {
  const nums = String(speed || "").match(/\d+(\.\d+)?/g);
  if (!nums) return null;
  return Math.max(...nums.map(Number));
}

function classifyWind(dir, seaward) {
  if (seaward == null) return null;
  const from = DIR_DEG[String(dir || "").trim().toUpperCase()];
  if (from == null) return null;
  const offshoreFrom = (seaward + 180) % 360;
  if (angDiff(from, offshoreFrom) <= 50) return "offshore";
  if (angDiff(from, seaward) <= 50) return "onshore";
  return "cross-shore";
}

function buildBestWindow({ hourly, tides, sunrise, sunset, seaward, timeZone, now }) {
  if (!hourly || !hourly.length) {
    return { text: null, reason: "Wind forecast didn't load, so there is no paddle window." };
  }
  if (!sunrise || !sunset || Number.isNaN(sunrise.getTime()) || Number.isNaN(sunset.getTime())) {
    return { text: null, reason: "Sunrise or sunset didn't load, so the daylight window isn't set." };
  }
  const tz = timeZone || "UTC";
  const z = zoneAbbrev(now, tz);
  if (now >= sunset) {
    return { text: "The sun is already down, so today's daylight paddle window has passed.", reason: null };
  }
  const dayStart = now > sunrise ? now : sunrise;
  const dayEnd = sunset;
  const hours = hourly.map((p) => ({
    start: new Date(p.startTime),
    end: new Date(p.endTime),
    wind: p.windSpeed,
    dir: p.windDirection,
    upper: windUpper(p.windSpeed),
  })).filter((h) => h.end > dayStart && h.start < dayEnd && h.upper != null);
  if (!hours.length) {
    return { text: null, reason: "No hourly wind overlapped today's remaining daylight." };
  }

  let windowStart = dayStart;
  let windowEnd = dayEnd;
  let tideSentence = "Tide isn't available for this spot, so this note is wind only.";
  let usedRising = false;

  if (tides && tides.ok && tides.events.length) {
    const rising = [];
    const ev = tides.events;
    for (let i = 0; i < ev.length - 1; i++) {
      if (ev[i].type === "Low" && ev[i + 1].type === "High") rising.push([ev[i], ev[i + 1]]);
    }
    const overlapHours = (a, b) => hours.filter((h) => h.end > a && h.start < b);
    const candidates = rising.map(([lo, hi]) => {
      const a = new Date(Math.max(lo.time.getTime(), dayStart.getTime()));
      const b = new Date(Math.min(hi.time.getTime(), dayEnd.getTime()));
      if (!(b > a)) return null;
      const hs = overlapHours(a, b);
      if (!hs.length) return null;
      const score = hs.reduce((sum, h) => sum + h.upper, 0) / hs.length;
      return { lo, hi, a, b, score };
    }).filter(Boolean).sort((a, b) => a.score - b.score || a.a - b.a);

    if (candidates.length) {
      const c = candidates[0];
      windowStart = c.a;
      windowEnd = c.b;
      usedRising = true;
      tideSentence = "Tide is rising from " + c.lo.feet.toFixed(2) + " ft at " + formatWhen(c.lo.time, tz)
        + " to " + c.hi.feet.toFixed(2) + " ft at " + formatWhen(c.hi.time, tz)
        + " MLLW at " + tides.station.name + ".";
      if (c.hi.time > dayEnd) tideSentence += " Sunset cuts the paddle stretch off before that high.";
    } else {
      const inDay = ev.filter((e) => e.time >= dayStart && e.time <= dayEnd);
      tideSentence = inDay.length
        ? "No rising tide overlaps the rest of today's daylight. In that stretch: " + inDay.map((e) => e.type + " " + e.feet.toFixed(2) + " ft at " + formatWhen(e.time, tz)).join("; ") + "."
        : "No high or low falls in the rest of today's daylight.";
    }
  }

  const use = hours.filter((h) => h.end > windowStart && h.start < windowEnd);
  const pool = use.length ? use : hours;
  const light = pool.slice().sort((a, b) => a.upper - b.upper || a.start - b.start)[0];
  const strong = pool.slice().sort((a, b) => b.upper - a.upper || a.start - b.start)[0];
  const label = light.upper <= 12 ? "Easier paddle" : "Least-windy stretch";
  const lead = usedRising
    ? label + " " + formatWhen(windowStart, tz) + "–" + formatWhen(windowEnd, tz) + " " + z + ": daylight that still overlaps today's rising tide."
    : label + " " + formatWhen(windowStart, tz) + "–" + formatWhen(windowEnd, tz) + " " + z + ": remaining daylight. No rising-tide overlap was used.";
  let windSentence = "Lightest hour is " + formatWhen(light.start, tz) + " (" + light.wind + " " + (light.dir || "") + ").";
  if (strong.upper > light.upper) {
    windSentence += " Highest in that stretch is " + formatWhen(strong.start, tz) + " (" + strong.wind + " " + (strong.dir || "") + ").";
  }
  const classes = [...new Set(pool.map((h) => classifyWind(h.dir, seaward)).filter(Boolean))];
  let facing;
  if (seaward == null) {
    facing = "Shoreline facing wasn't clear, so wind is not labeled onshore or offshore.";
  } else if (classes.length === 1) {
    facing = "That wind is " + classes[0] + " with the sea toward " + cardinal(seaward) + ".";
  } else if (classes.length > 1) {
    const listed = classes.length === 2
      ? classes[0] + " and " + classes[1]
      : classes.slice(0, -1).join(", ") + ", and " + classes[classes.length - 1];
    facing = "Wind shifts between " + listed + " in that stretch. Sea is toward " + cardinal(seaward) + ".";
  } else {
    facing = "Wind direction wasn't clear enough to call it onshore or offshore.";
  }
  return {
    text: [lead, tideSentence, windSentence.trim(), facing, "Rule: lighter wind during a rising tide in daylight. Not a wave-quality rating."].join(" "),
    reason: null,
  };
}


function gridSpeed(value, uom) {
  if (value == null || Number.isNaN(Number(value))) return null;
  const n = Number(value);
  const unit = uom || "";
  if (unit.includes("km_h")) {
    const mph = n * 0.621371192;
    return Math.round(mph) + " mph (" + Math.round(n) + " km/h)";
  }
  if (unit.includes("m_s")) {
    const mph = n * 2.2369362921;
    return Math.round(mph) + " mph (" + n.toFixed(1) + " m/s)";
  }
  return String(n) + (unit ? " (" + unit + ")" : "");
}

function windBand(upper) {
  if (upper == null) return null;
  if (upper < 10) return "light";
  if (upper < 20) return "moderate";
  return "strong";
}


const WINTER_RE = /snow|flurr|blizzard|winter|sleet|freezing rain|ice storm|wintry|frost|freeze/i;
const MARINE_ALERT_RE = /small craft|gale|special marine|marine weather|coastal flood|rip current|high surf|hazardous seas|beach hazard|tsunami|storm surge|hurricane force|freezing spray|brisk wind|low water|seiche|lakeshore/i;

function isMarineAlert(item) {
  return MARINE_ALERT_RE.test([item && item.event, item && item.headline].join(" "));
}

function mapAlertFeature(f) {
  const props = (f && f.properties) || {};
  return {
    event: props.event || "Alert",
    severity: props.severity || "",
    headline: props.headline || props.event || "Alert",
    ends: props.ends || null,
  };
}
const LOW_ELEVATION_M = 1500;

function metersAndFeet(m) {
  const ft = Number(m) * 3.280839895;
  return Math.round(ft) + " ft (" + Math.round(Number(m)) + " m)";
}

function mmAndInches(mm) {
  const inches = Number(mm) / 25.4;
  const mmText = Number.isInteger(Number(mm)) ? String(mm) : Number(mm).toFixed(1);
  return inches.toFixed(2) + " in (" + mmText + " mm)";
}

function snowOutlook(series, now) {
  const values = (series && series.values) || [];
  const upcoming = [];
  for (const v of values) {
    if (v.value == null || Number.isNaN(Number(v.value))) continue;
    const iv = parseInterval(v.validTime);
    if (!iv || iv.end <= now) continue;
    upcoming.push({ value: Number(v.value), start: iv.start, end: iv.end });
  }
  if (!upcoming.length) return { status: "missing" };
  const positive = upcoming.filter((row) => row.value > 0);
  if (positive.length) return { status: "snow", rows: positive.slice(0, 6) };
  return { status: "none", until: upcoming[upcoming.length - 1].end };
}

function buildSkiing({ current, daily, periods, weatherOk, alerts, gridProps, gridOk, gridReason, timeZone, now }) {
  if (!weatherOk && !gridOk) {
    return { ok: false, reason: "NWS forecast and grid didn't load" + (gridReason ? " (" + gridReason + ")" : "") + "." };
  }
  const tz = timeZone || "UTC";
  const elevation = gridOk && gridProps && gridProps.elevation && gridProps.elevation.value != null
    ? Number(gridProps.elevation.value)
    : null;
  const elevationText = elevation == null || Number.isNaN(elevation) ? null : metersAndFeet(elevation);
  const snow = gridOk && gridProps ? snowOutlook(gridProps.snowfallAmount, now) : { status: "missing" };
  const winterPeriods = (daily || []).filter((period) => WINTER_RE.test([period.name, period.shortForecast, period.detailedForecast].join(" "))).slice(0, 4);
  const winterHours = (periods || []).filter((period) => new Date(period.endTime) > now && WINTER_RE.test(period.shortForecast || "")).slice(0, 6);
  const winterAlerts = alerts && alerts.ok
    ? alerts.items.filter((item) => WINTER_RE.test([item.event, item.headline].join(" ")))
    : [];
  const hasSnow = snow.status === "snow" || winterPeriods.length > 0 || winterHours.length > 0 || winterAlerts.length > 0;
  const low = elevation != null && !Number.isNaN(elevation) && elevation < LOW_ELEVATION_M;
  return {
    ok: true,
    notMountain: Boolean(low && !hasSnow),
    elevationText,
    elevationKnown: elevation != null && !Number.isNaN(elevation),
    snow,
    winterPeriods,
    winterHours,
    winterAlerts,
    alertsOk: Boolean(alerts && alerts.ok),
    alertsReason: alerts && alerts.ok ? null : (alerts && alerts.reason) || "Alerts didn't load.",
    current: current || null,
    today: (daily && daily[0]) || null,
    gridOk,
  };
}

function buildSailing({ periods, gridProps, gridOk, gridReason, marine, seaward, timeZone, now }) {
  const tz = timeZone || "UTC";
  const todayKey = localDateKey(now, tz);
  const gustSeries = gridOk && gridProps ? gridProps.windGust : null;
  const gustUom = gustSeries && gustSeries.uom;
  if (!periods.length) {
    return {
      ok: false,
      reason: "Hourly wind didn't load" + (gridReason ? " (" + gridReason + ")" : "") + ".",
      hours: [],
      sea: marine && marine.ok ? marine : marine,
    };
  }
  const hours = periods.filter((p) => {
    const start = new Date(p.startTime);
    const end = new Date(p.endTime);
    if (!(end > now)) return false;
    return localDateKey(start, tz) === todayKey || (start <= now && now < end);
  }).slice(0, 18).map((p) => {
    const start = new Date(p.startTime);
    const end = new Date(p.endTime);
    const when = start <= now && now < end ? now : start;
    const gustHit = gustSeries ? intervalValue(gustSeries, when) : null;
    const gust = gustHit && gustHit.value != null ? gridSpeed(gustHit.value, gustUom) : null;
    return {
      start,
      wind: p.windSpeed || "",
      dir: p.windDirection || "",
      upper: windUpper(p.windSpeed),
      gust,
    };
  });
  const current = hours[0] || null;
  let note = null;
  let noteReason = null;
  if (!current || current.upper == null) {
    noteReason = "The hourly forecast had no wind speed to base a sailing note on.";
  } else {
    const band = windBand(current.upper);
    const bits = ["Now the wind is " + band + ": " + current.wind + (current.dir ? " " + current.dir : "") + "."];
    if (current.gust) bits.push("Grid gust for this hour is " + current.gust + ".");
    else if (!gustSeries) bits.push("Gusts are unavailable for this point.");
    const facing = classifyWind(current.dir, seaward);
    if (facing && seaward != null) {
      bits.push("That wind is " + facing + ", sea toward " + cardinal(seaward) + ".");
    }
    const later = hours.slice(1);
    const light = hours.slice().sort((a, b) => a.upper - b.upper || a.start - b.start)[0];
    const strong = hours.slice().sort((a, b) => b.upper - a.upper || a.start - b.start)[0];
    if (strong && light && strong.upper > light.upper) {
      bits.push("Lightest remaining hour is " + formatWhen(light.start, tz) + " (" + light.wind + (light.dir ? " " + light.dir : "") + "). Strongest is " + formatWhen(strong.start, tz) + " (" + strong.wind + (strong.dir ? " " + strong.dir : "") + ").");
    }
    if (seaward != null) {
      const other = [];
      for (const h of later) {
        const cls = classifyWind(h.dir, seaward);
        if (cls && cls !== facing && !other.some((o) => o.cls === cls)) other.push({ cls, h });
      }
      if (other.length) {
        bits.push("Later, wind is " + other.map((o) => o.cls + " at " + formatWhen(o.h.start, tz) + " (" + o.h.wind + " " + o.h.dir + ")").join("; ") + ".");
      }
    }
    const wave = marine && marine.ok && marine.rows && marine.rows.find((r) => r.label === "Wave height");
    if (wave) bits.push("Sea height on the marine grid is " + wave.text + ".");
    bits.push("Light is under 10 mph, moderate is 10–19, strong is 20 or more, using the higher number when NWS gives a range.");
    note = bits.join(" ");
  }
  let sea = null;
  let seaReason = null;
  if (marine && marine.ok) {
    const wave = marine.rows.find((r) => r.label === "Wave height");
    const windWave = marine.rows.find((r) => r.label === "Wind wave");
    const period = marine.rows.find((r) => r.label === "Wave period");
    sea = { wave, windWave, period, how: marine.how, gridId: marine.gridId, gridX: marine.gridX, gridY: marine.gridY };
  } else {
    seaReason = (marine && marine.reason) || "Sea height didn't load.";
  }
  return {
    ok: true,
    hours,
    current,
    note,
    noteReason,
    gustsOk: Boolean(gustSeries),
    gustReason: gustSeries ? null : (gridOk ? "NWS grid has no gust field for this point." : "Gusts didn't load (" + (gridReason || "no grid") + ")."),
    sea,
    seaReason,
  };
}

async function fetchSection(url) {
  if (!url) return { ok: false, reason: "No link from NWS." };
  try {
    return { ok: true, data: await fetchJson(url) };
  } catch (e) {
    return { ok: false, reason: e.message };
  }
}

export async function loadBriefing(lat, lon, now = new Date()) {
  const latR = Math.round(lat * 10000) / 10000;
  const lonR = Math.round(lon * 10000) / 10000;
  let point;
  try {
    point = await fetchJson("https://api.weather.gov/points/" + latR + "," + lonR);
  } catch (e) {
    throw new Error(e.status === 404
      ? "NWS has no forecast grid for this location."
      : "NWS forecast didn't load (" + e.message + ").");
  }
  const props = point.properties || {};
  const timeZone = props.timeZone || "UTC";
  const rel = (props.relativeLocation && props.relativeLocation.properties) || {};
  const place = [rel.city, rel.state].filter(Boolean).join(", ") || (latR + ", " + lonR);
  const astro = props.astronomicalData || {};
  const sunrise = astro.sunrise ? new Date(astro.sunrise) : null;
  const sunset = astro.sunset ? new Date(astro.sunset) : null;
  const civilBegin = astro.civilTwilightBegin ? new Date(astro.civilTwilightBegin) : null;
  const civilEnd = astro.civilTwilightEnd ? new Date(astro.civilTwilightEnd) : null;

  const [forecastR, hourlyR, alertsR, marine, tides, gridR] = await Promise.all([
    fetchSection(props.forecast),
    fetchSection(props.forecastHourly),
    fetchSection("https://api.weather.gov/alerts/active?point=" + latR + "," + lonR),
    loadMarine(latR, lonR, props, now),
    loadTides(latR, lonR, timeZone, now),
    fetchSection(props.forecastGridData),
  ]);

  const periods = hourlyR.ok ? ((hourlyR.data.properties && hourlyR.data.properties.periods) || []) : [];
  const daily = forecastR.ok ? ((forecastR.data.properties && forecastR.data.properties.periods) || []) : [];
  const weather = {
    ok: hourlyR.ok || forecastR.ok,
    current: periods.find((p) => new Date(p.startTime) <= now && now < new Date(p.endTime)) || null,
    upcoming: periods.filter((p) => new Date(p.endTime) > now).slice(0, 8),
    today: daily[0] || null,
    reason: !hourlyR.ok && !forecastR.ok ? (hourlyR.reason || forecastR.reason) : null,
    hourlyMissing: hourlyR.ok ? null : hourlyR.reason,
    updateTime: (hourlyR.ok && hourlyR.data.properties && hourlyR.data.properties.updateTime)
      || (forecastR.ok && forecastR.data.properties && forecastR.data.properties.updateTime)
      || null,
  };

  let alerts;
  if (!alertsR.ok) {
    alerts = { ok: false, reason: "Hazards didn't load (" + alertsR.reason + ")." };
  } else {
    const features = alertsR.data.features || [];
    alerts = {
      ok: true,
      items: features.slice(0, 8).map(mapAlertFeature),
    };
  }

  const seaward = marine.seaward != null ? marine.seaward : null;
  const best = buildBestWindow({
    hourly: periods,
    tides,
    sunrise,
    sunset,
    seaward,
    timeZone,
    now,
  });
  const gridProps = gridR.ok ? (gridR.data.properties || {}) : null;
  let zoneAlerts = { ok: true, items: [], skipped: !marine.zoneId };
  if (marine.zoneId) {
    const zoneR = await fetchSection("https://api.weather.gov/alerts/active?zone=" + encodeURIComponent(marine.zoneId));
    if (!zoneR.ok) zoneAlerts = { ok: false, items: [], reason: zoneR.reason, zoneId: marine.zoneId };
    else zoneAlerts = { ok: true, items: ((zoneR.data && zoneR.data.features) || []).slice(0, 8).map(mapAlertFeature), zoneId: marine.zoneId };
  }
  const seenMarine = new Set();
  const marineAdvisories = [];
  const pointMarine = alerts.ok ? alerts.items.filter(isMarineAlert) : [];
  const zoneMarine = zoneAlerts.ok ? zoneAlerts.items : [];
  for (const item of zoneMarine.concat(pointMarine)) {
    const key = item.event + "|" + item.headline;
    if (seenMarine.has(key)) continue;
    seenMarine.add(key);
    marineAdvisories.push(item);
  }
  const marineAdvisoryReport = {
    ok: alerts.ok || zoneAlerts.ok,
    items: marineAdvisories,
    zoneId: marine.zoneId || null,
    pointFailed: !alerts.ok,
    zoneFailed: Boolean(marine.zoneId) && !zoneAlerts.ok,
    pointReason: alerts.ok ? null : alerts.reason,
    zoneReason: zoneAlerts.ok ? null : zoneAlerts.reason,
  };

  const sailing = buildSailing({
    periods,
    gridProps,
    gridOk: gridR.ok,
    gridReason: gridR.ok ? null : gridR.reason,
    marine,
    seaward,
    timeZone,
    now,
  });
  const skiing = buildSkiing({
    current: weather.current,
    daily,
    periods,
    weatherOk: weather.ok,
    alerts,
    gridProps,
    gridOk: gridR.ok,
    gridReason: gridR.ok ? null : gridR.reason,
    timeZone,
    now,
  });

  return {
    place, timeZone, lat: latR, lon: lonR, now,
    sunrise, sunset, civilBegin, civilEnd,
    weather, marine, tides, alerts, best, sailing, skiing, marineAdvisoryReport,
    pointsUrl: "https://api.weather.gov/points/" + latR + "," + lonR,
    office: props.gridId || "",
  };
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function showLoading(text) {
  const cards = document.getElementById("panel-surf");
  cards.replaceChildren();
  const sail = document.getElementById("panel-sailing");
  if (sail) sail.replaceChildren();
  const skiClear = document.getElementById("panel-ski");
  if (skiClear) skiClear.replaceChildren();
  const c = el("section", "card");
  c.appendChild(el("h2", null, "Loading"));
  c.appendChild(el("p", "lead", text));
  cards.appendChild(c);
}

function render(model, loc) {
  const place = document.getElementById("place");
  place.textContent = model.place;
  const z = zoneAbbrev(model.now, model.timeZone);
  const note = document.getElementById("loc-note");
  if (loc.fallback) {
    note.textContent = loc.reason + " Showing the Solana Beach fallback (" + FALLBACK.lat + ", " + FALLBACK.lon + "). Place name below is from NWS. Uses your location for today's surf, sailing, and skiing when you allow it.";
  } else {
    const acc = loc.accuracy != null ? " Phone accuracy about " + Math.round(loc.accuracy) + " m." : "";
    note.textContent = "Uses your location for today's surf, sailing, and skiing (" + model.lat + ", " + model.lon + ")." + acc;
  }

  const cards = document.getElementById("panel-surf");
  cards.replaceChildren();
  const tz = model.timeZone;

  const weather = el("section", "card");
  weather.appendChild(el("h2", null, "Wind and weather"));
  if (!model.weather.ok) {
    weather.appendChild(el("p", "reason", "Unavailable. " + (model.weather.reason || "")));
  } else {
    const cur = model.weather.current;
    const today = model.weather.today;
    if (cur) {
      weather.appendChild(el("p", "big", cur.temperature + "°" + cur.temperatureUnit));
      weather.appendChild(el("p", "lead", (cur.windSpeed || "Wind unavailable") + " " + (cur.windDirection || "") + " · " + (cur.shortForecast || "")));
    } else if (model.weather.hourlyMissing) {
      weather.appendChild(el("p", "reason", "Hourly wind unavailable (" + model.weather.hourlyMissing + ")."));
    }
    if (today) {
      weather.appendChild(el("p", "sub", (today.name || "Forecast") + ": " + (today.temperature != null ? today.temperature + "°" + (today.temperatureUnit || "") + ". " : "") + (today.shortForecast || "") + (today.windSpeed ? " Wind " + today.windSpeed + " " + (today.windDirection || "") + "." : "")));
    }
    if (model.weather.upcoming.length) {
      const strip = el("div", "hours");
      for (const p of model.weather.upcoming) {
        const chip = el("div", "hour");
        chip.appendChild(el("b", null, formatWhen(new Date(p.startTime), tz)));
        chip.appendChild(el("span", null, (p.windSpeed || "—") + " " + (p.windDirection || "")));
        chip.appendChild(el("span", null, (p.temperature != null ? p.temperature + "°" : "") + (p.shortForecast ? " " + p.shortForecast : "")));
        strip.appendChild(chip);
      }
      weather.appendChild(strip);
    }
  }
  cards.appendChild(weather);

  const waves = el("section", "card");
  waves.appendChild(el("h2", null, "Waves"));
  if (!model.marine.ok) {
    waves.appendChild(el("p", "reason", "Unavailable. " + (model.marine.reason || "")));
  } else {
    const height = model.marine.rows.find((r) => r.label === "Wave height");
    if (height) waves.appendChild(el("p", "big", height.text));
    const list = el("ul");
    for (const row of model.marine.rows) {
      const li = el("li");
      li.appendChild(el("span", null, row.label));
      const right = el("span");
      right.appendChild(document.createTextNode(row.text));
      right.appendChild(el("span", "sub", " " + formatFull(row.until, tz)));
      li.appendChild(right);
      list.appendChild(li);
    }
    waves.appendChild(list);
    waves.appendChild(el("p", "sub", model.marine.how + " NWS grid " + model.marine.gridId + " " + model.marine.gridX + "," + model.marine.gridY + ". This is a forecast grid, not a buoy."));
  }
  cards.appendChild(waves);

  const best = el("section", "card");
  best.appendChild(el("h2", null, "Best paddle-out"));
  if (model.best.text) best.appendChild(el("p", "lead", model.best.text));
  else best.appendChild(el("p", "reason", "Unavailable. " + (model.best.reason || "")));
  cards.appendChild(best);

  const tides = el("section", "card");
  tides.appendChild(el("h2", null, "Tides"));
  if (!model.tides.ok) {
    tides.appendChild(el("p", "reason", "Unavailable. " + model.tides.reason));
  } else {
    const st = model.tides.station;
    tides.appendChild(el("p", "lead", st.name + (st.state ? ", " + st.state : "") + " · " + st.km.toFixed(0) + " km away · MLLW"));
    const todayKey = localDateKey(model.now, tz);
    const todayEvents = model.tides.events.filter((e) => localDateKey(e.time, tz) === todayKey);
    const list = el("ul");
    const shown = todayEvents.length ? todayEvents : model.tides.events.filter((e) => e.time >= model.now).slice(0, 4);
    if (!shown.length) {
      tides.appendChild(el("p", "reason", "No tide predictions came back for today."));
    } else {
      for (const e of shown) {
        const li = el("li", e.time < model.now ? "past" : "");
        li.appendChild(el("span", null, e.type + " " + formatWhen(e.time, tz) + " " + z));
        li.appendChild(el("span", null, e.feet.toFixed(2) + " ft"));
        list.appendChild(li);
      }
      tides.appendChild(list);
      if (!todayEvents.length) tides.appendChild(el("p", "sub", "Nothing dated today in local time. Showing the next predictions."));
    }
    tides.appendChild(el("p", "sub", "NOAA station " + st.id + ". Times shown in " + tz + "."));
  }
  cards.appendChild(tides);

  const sun = el("section", "card");
  sun.appendChild(el("h2", null, "Sun"));
  if (!model.sunrise || !model.sunset) {
    sun.appendChild(el("p", "reason", "Unavailable. NWS didn't include sunrise and sunset for this point."));
  } else {
    const list = el("ul");
    const rows = [
      ["First light", model.civilBegin],
      ["Sunrise", model.sunrise],
      ["Sunset", model.sunset],
      ["Last light", model.civilEnd],
    ];
    for (const [label, when] of rows) {
      if (!when || Number.isNaN(when.getTime())) continue;
      const li = el("li");
      li.appendChild(el("span", null, label));
      li.appendChild(el("span", null, formatWhen(when, tz) + " " + z));
      list.appendChild(li);
    }
    sun.appendChild(list);
    sun.appendChild(el("p", "sub", "From the NWS point response for this location."));
  }
  cards.appendChild(sun);

  const hazards = el("section", model.alerts.ok && model.alerts.items.length ? "card bad" : "card");
  hazards.appendChild(el("h2", null, "Hazards"));
  if (!model.alerts.ok) {
    hazards.appendChild(el("p", "reason", "Unavailable. " + model.alerts.reason));
  } else if (!model.alerts.items.length) {
    hazards.appendChild(el("p", "lead", "No active NWS alerts for this point."));
  } else {
    for (const item of model.alerts.items) {
      const wrap = el("div", "alert-item");
      wrap.appendChild(el("strong", null, item.event + (item.severity ? " · " + item.severity : "")));
      wrap.appendChild(el("p", "sub", item.headline));
      if (item.ends) {
        const ends = new Date(item.ends);
        if (!Number.isNaN(ends.getTime())) wrap.appendChild(el("p", "sub", "Until " + formatFull(ends, tz)));
      }
      hazards.appendChild(wrap);
    }
  }
  cards.appendChild(hazards);

  const sailPanel = document.getElementById("panel-sailing");
  sailPanel.replaceChildren();
  const sailingCard = el("section", "card");
  sailingCard.appendChild(el("h2", null, "Sailing"));
  if (!model.sailing || !model.sailing.ok) {
    sailingCard.appendChild(el("p", "reason", "Unavailable. " + ((model.sailing && model.sailing.reason) || "Sailing data didn't load.")));
  } else {
    if (model.sailing.note) sailingCard.appendChild(el("p", "lead", model.sailing.note));
    else sailingCard.appendChild(el("p", "reason", "Sailing note unavailable. " + (model.sailing.noteReason || "")));
    const curS = model.sailing.current;
    if (curS) {
      sailingCard.appendChild(el("p", "big", (curS.wind || "Wind unavailable") + (curS.dir ? " " + curS.dir : "")));
      if (curS.gust) sailingCard.appendChild(el("p", "sub", "Gust " + curS.gust));
      else sailingCard.appendChild(el("p", "reason", model.sailing.gustReason || "Gust unavailable for this hour."));
    }
    if (model.sailing.hours.length) {
      const list = el("ul");
      for (const h of model.sailing.hours) {
        const li = el("li");
        li.appendChild(el("span", null, formatWhen(h.start, tz)));
        const right = (h.wind || "—") + (h.dir ? " " + h.dir : "") + (h.gust ? " · gust " + h.gust : " · gust unavailable");
        li.appendChild(el("span", null, right));
        list.appendChild(li);
      }
      sailingCard.appendChild(list);
    }
    if (!model.sailing.gustsOk) {
      sailingCard.appendChild(el("p", "sub", model.sailing.gustReason || "Gusts unavailable."));
    } else {
      sailingCard.appendChild(el("p", "sub", "Gusts are the NWS grid at this point. Speeds in mph are converted from the grid unit and the grid value is shown beside them."));
    }
  }
  sailPanel.appendChild(sailingCard);

  const seaCard = el("section", "card");
  seaCard.appendChild(el("h2", null, "Sea"));
  if (!model.sailing || !model.sailing.sea) {
    seaCard.appendChild(el("p", "reason", "Unavailable. " + ((model.sailing && model.sailing.seaReason) || "Sea height didn't load.")));
  } else {
    const sea = model.sailing.sea;
    if (sea.wave) seaCard.appendChild(el("p", "big", sea.wave.text));
    else seaCard.appendChild(el("p", "reason", "Wave height unavailable on this marine grid."));
    const seaList = el("ul");
    for (const row of [sea.wave, sea.windWave, sea.period]) {
      if (!row) continue;
      const li = el("li");
      li.appendChild(el("span", null, row.label));
      li.appendChild(el("span", null, row.text));
      seaList.appendChild(li);
    }
    seaCard.appendChild(seaList);
    seaCard.appendChild(el("p", "sub", (sea.how || "") + " NWS grid " + sea.gridId + " " + sea.gridX + "," + sea.gridY + ". Forecast grid, not a buoy."));
  }
  sailPanel.appendChild(seaCard);

  const tideCard = el("section", "card");
  tideCard.appendChild(el("h2", null, "Tides"));
  if (!model.tides || !model.tides.ok) {
    tideCard.appendChild(el("p", "reason", "Tides aren't available. " + ((model.tides && model.tides.reason) || "")));
  } else {
    const st = model.tides.station;
    tideCard.appendChild(el("p", "lead", st.name + (st.state ? ", " + st.state : "") + " · " + st.km.toFixed(0) + " km · MLLW"));
    const todayKey = localDateKey(model.now, tz);
    const todayEvents = model.tides.events.filter((e) => localDateKey(e.time, tz) === todayKey);
    if (!todayEvents.length) {
      tideCard.appendChild(el("p", "reason", "No high or low is dated today at this station."));
    } else {
      const list = el("ul");
      for (const e of todayEvents) {
        const li = el("li", e.time < model.now ? "past" : "");
        li.appendChild(el("span", null, e.type + " " + formatWhen(e.time, tz) + " " + z));
        li.appendChild(el("span", null, e.feet.toFixed(2) + " ft"));
        list.appendChild(li);
      }
      tideCard.appendChild(list);
    }
    tideCard.appendChild(el("p", "sub", "NOAA station " + st.id + ". Times in " + tz + "."));
  }
  sailPanel.appendChild(tideCard);

  const adv = model.marineAdvisoryReport;
  const advCard = el("section", adv && adv.ok && adv.items.length ? "card bad" : "card");
  advCard.appendChild(el("h2", null, "Marine advisories"));
  if (!adv || !adv.ok) {
    advCard.appendChild(el("p", "reason", "Unavailable. " + ((adv && (adv.pointReason || adv.zoneReason)) || "Marine alerts didn't load.")));
  } else if (!adv.items.length) {
    const where = adv.zoneId ? "this point or marine zone " + adv.zoneId : "this point";
    let line = "No marine advisories for " + where + ".";
    if (adv.pointFailed) line += " Alerts for the exact point didn't load (" + (adv.pointReason || "failed") + ").";
    if (adv.zoneFailed) line += " Coastal zone alerts didn't load (" + (adv.zoneReason || "failed") + ").";
    advCard.appendChild(el("p", "lead", line));
  } else {
    for (const item of adv.items) {
      const wrap = el("div", "alert-item");
      wrap.appendChild(el("strong", null, item.event + (item.severity ? " · " + item.severity : "")));
      wrap.appendChild(el("p", "sub", item.headline));
      if (item.ends) {
        const ends = new Date(item.ends);
        if (!Number.isNaN(ends.getTime())) wrap.appendChild(el("p", "sub", "Until " + formatFull(ends, tz)));
      }
      advCard.appendChild(wrap);
    }
    if (adv.zoneId) advCard.appendChild(el("p", "sub", "Includes active alerts for marine zone " + adv.zoneId + " and marine alerts at this point."));
  }
  sailPanel.appendChild(advCard);



  const skiPanel = document.getElementById("panel-ski");
  skiPanel.replaceChildren();
  const skiCard = el("section", "card");
  skiCard.appendChild(el("h2", null, "Skiing"));
  if (!model.skiing || !model.skiing.ok) {
    skiCard.appendChild(el("p", "reason", "Unavailable. " + ((model.skiing && model.skiing.reason) || "Skiing data didn't load.")));
  } else {
    const ski = model.skiing;
    if (ski.notMountain) {
      skiCard.appendChild(el("p", "lead", "Skiing conditions aren't available here. NWS elevation is " + ski.elevationText + ", under 1,500 m, and there is no snow or winter weather in the forecast or active alerts."));
    } else if (ski.snow.status !== "snow" && !ski.winterPeriods.length && !ski.winterHours.length && !ski.winterAlerts.length) {
      skiCard.appendChild(el("p", "lead", "No snow or winter weather is in the NWS forecast" + (ski.alertsOk ? " or active alerts" : "") + "."));
    }
    const cur = ski.current;
    const today = ski.today;
    if (cur && cur.temperature != null) {
      skiCard.appendChild(el("p", "big", cur.temperature + "°" + (cur.temperatureUnit || "")));
      skiCard.appendChild(el("p", "lead", (cur.windSpeed || "Wind unavailable") + (cur.windDirection ? " " + cur.windDirection : "") + (cur.shortForecast ? " · " + cur.shortForecast : "")));
    } else if (today) {
      skiCard.appendChild(el("p", "big", today.temperature != null ? today.temperature + "°" + (today.temperatureUnit || "") : "Temperature unavailable"));
      skiCard.appendChild(el("p", "lead", (today.windSpeed || "Wind unavailable") + (today.windDirection ? " " + today.windDirection : "") + (today.shortForecast ? " · " + today.shortForecast : "")));
    } else {
      skiCard.appendChild(el("p", "reason", "Temperature and wind unavailable."));
    }
    if (cur && today && today.shortForecast && today.shortForecast !== cur.shortForecast) {
      skiCard.appendChild(el("p", "sub", (today.name || "Forecast") + ": " + today.shortForecast + (today.temperature != null ? ". " + today.temperature + "°" + (today.temperatureUnit || "") : "") + (today.windSpeed ? ". Wind " + today.windSpeed + (today.windDirection ? " " + today.windDirection : "") : "")));
    }
    if (ski.elevationText) skiCard.appendChild(el("p", "sub", "NWS grid elevation " + ski.elevationText + "."));
    else skiCard.appendChild(el("p", "reason", "Elevation unavailable" + (ski.gridOk ? "." : " (grid didn't load).")));
    if (ski.snow.status === "none") {
      skiCard.appendChild(el("p", "sub", "NWS snowfall amount is 0 mm through " + formatFull(ski.snow.until, tz) + "."));
    } else if (ski.snow.status === "snow") {
      const list = el("ul");
      for (const row of ski.snow.rows) {
        const li = el("li");
        li.appendChild(el("span", null, formatFull(row.start, tz)));
        li.appendChild(el("span", null, mmAndInches(row.value)));
        list.appendChild(li);
      }
      skiCard.appendChild(el("p", "sub", "NWS snowfall amount, converted from millimeters."));
      skiCard.appendChild(list);
    } else {
      skiCard.appendChild(el("p", "reason", "Snowfall amount unavailable."));
    }
    if (ski.winterPeriods.length || ski.winterHours.length) {
      const list = el("ul");
      for (const period of ski.winterPeriods) {
        const li = el("li");
        li.appendChild(el("span", null, period.name || "Forecast"));
        li.appendChild(el("span", null, period.shortForecast || period.detailedForecast || ""));
        list.appendChild(li);
      }
      for (const period of ski.winterHours) {
        const li = el("li");
        li.appendChild(el("span", null, formatWhen(new Date(period.startTime), tz)));
        li.appendChild(el("span", null, period.shortForecast || ""));
        list.appendChild(li);
      }
      skiCard.appendChild(list);
    }
    if (!ski.alertsOk) {
      skiCard.appendChild(el("p", "reason", "Winter alerts unavailable. " + (ski.alertsReason || "")));
    } else if (!ski.winterAlerts.length) {
      skiCard.appendChild(el("p", "sub", "No snow or winter alerts for this point."));
    } else {
      for (const item of ski.winterAlerts) {
        const wrap = el("div", "alert-item");
        wrap.appendChild(el("strong", null, item.event));
        wrap.appendChild(el("p", "sub", item.headline));
        skiCard.appendChild(wrap);
      }
    }
    skiCard.appendChild(el("p", "sub", "No resort snow report. Public resort feeds checked need a key or a known resort name, so none is shown."));
  }
  skiPanel.appendChild(skiCard);

  const sources = document.getElementById("sources");
  sources.replaceChildren();
  const loaded = el("span", null, "Loaded " + formatFull(model.now, tz) + " " + z + ". ");
  sources.appendChild(loaded);
  const a = el("a", null, "NWS point");
  a.href = model.pointsUrl;
  a.rel = "noreferrer";
  sources.appendChild(a);
  if (model.tides.ok) {
    sources.appendChild(document.createTextNode(" · "));
    const t = el("a", null, "NOAA tides " + model.tides.station.id);
    t.href = "https://tidesandcurrents.noaa.gov/stationhome.html?id=" + encodeURIComponent(model.tides.station.id);
    t.rel = "noreferrer";
    sources.appendChild(t);
  }
}

function requestLocation() {
  return new Promise((resolve) => {
    if (!navigator.geolocation) {
      resolve({ ...FALLBACK, fallback: true, reason: "This browser has no location service." });
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({
        lat: pos.coords.latitude,
        lon: pos.coords.longitude,
        accuracy: pos.coords.accuracy,
        fallback: false,
      }),
      (err) => {
        const reason = err && err.code === 1
          ? "Location permission denied."
          : err && err.code === 3
            ? "Location timed out."
            : "Location unavailable.";
        resolve({ ...FALLBACK, fallback: true, reason });
      },
      { enableHighAccuracy: true, timeout: 12000, maximumAge: 0 }
    );
  });
}

async function run() {
  const button = document.getElementById("refresh");
  button.disabled = true;
  showLoading("Asking for your location…");
  const loc = await requestLocation();
  showLoading(loc.fallback
    ? loc.reason + " Loading Solana Beach instead…"
    : "Loading live NWS and NOAA data for your spot…");
  try {
    const model = await loadBriefing(loc.lat, loc.lon);
    render(model, loc);
  } catch (e) {
    const cards = document.getElementById("panel-surf");
    cards.replaceChildren();
    const c = el("section", "card");
    c.appendChild(el("h2", null, "Forecast"));
    c.appendChild(el("p", "reason", "Unavailable. " + (e.message || "Could not load.")));
    cards.appendChild(c);
    if (loc.fallback) {
      document.getElementById("loc-note").textContent = loc.reason + " Solana Beach fallback also failed to load.";
    }
  } finally {
    button.disabled = false;
    button.textContent = "Refresh";
  }
}

function showTab(which) {
  for (const name of ["surf", "sailing", "ski"]) {
    document.getElementById("panel-" + name).hidden = name !== which;
    document.getElementById("tab-" + name).setAttribute("aria-selected", name === which ? "true" : "false");
  }
}

if (typeof document !== "undefined") {
  document.getElementById("refresh").addEventListener("click", run);
  document.getElementById("tab-surf").addEventListener("click", () => showTab("surf"));
  document.getElementById("tab-sailing").addEventListener("click", () => showTab("sailing"));
  document.getElementById("tab-ski").addEventListener("click", () => showTab("ski"));
  run();
}
