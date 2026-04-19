const express = require('express');

const app  = express();
const PORT = process.env.PORT || 7777;

// ── helpers ───────────────────────────────────────────────────────────────────

const FRC_ROAD_TYPES = {
  'FRC0': 'highway', 'FRC1': 'highway',
  'FRC2': 'urban',   'FRC3': 'urban',
  'FRC4': 'rural',   'FRC5': 'rural',
  'FRC6': 'mountain','FRC7': 'mountain',
};

/** Traffic congestion factor 0 (free flow) → 1 (gridlock), driven by time of day */
function getTrafficFactor() {
  if (process.env.FORCE_CONGESTION === 'true') return 0.90; // Demo mode: always HEAVY traffic
  const now = new Date();
  const h   = now.getHours() + now.getMinutes() / 60;
  const morningRush = Math.exp(-((h - 8.0) ** 2) / 1.5);
  const eveningRush = Math.exp(-((h - 18.0) ** 2) / 1.5);
  const base        = (h >= 22 || h < 5) ? 0.05 : 0.15;
  return Math.min(0.95, base + morningRush * 0.75 + eveningRush * 0.75);
}

/** Season-aware base temperature for Sivas, Turkey (continental climate) */
function getBaseTemperature() {
  const month = new Date().getMonth(); // 0 = Jan
  return 12 + 13 * Math.sin(((month - 3) * Math.PI) / 6);
}

/** Weighted random selection from [{value, weight}] */
function weightedRandom(items) {
  const total = items.reduce((s, i) => s + i.weight, 0);
  let r = Math.random() * total;
  for (const item of items) {
    r -= item.weight;
    if (r <= 0) return item.value;
  }
  return items[items.length - 1].value;
}

/** Map numeric speed → DB traffic_level label */
function speedToLevel(kmh) {
  if (kmh > 50) return 'LIGHT';
  if (kmh >= 30) return 'MODERATE';
  if (kmh >= 10) return 'HEAVY';
  return 'GRIDLOCK';
}

// ── Traffic Flow Segment Data ─────────────────────────────────────────────────
// Mirrors: GET /traffic/services/4/flowSegmentData/{style}/{zoom}/json?point=lat,lon&key=...
app.get('/traffic/services/4/flowSegmentData/:style/:zoom/json', (req, res) => {
  const factor       = getTrafficFactor();
  const freeFlowSpeed = 60;
  const noise        = (Math.random() - 0.5) * 10;
  const currentSpeed = Math.max(3, Math.round(freeFlowSpeed * (1 - factor * 0.85) + noise));
  const roadClosure  = Math.random() < 0.03 * factor;

  res.json({
    flowSegmentData: {
      frc:                'FRC3',
      currentSpeed,
      freeFlowSpeed,
      currentTravelTime:  Math.round(3600 / currentSpeed),
      freeFlowTravelTime: Math.round(3600 / freeFlowSpeed),
      confidence:         parseFloat((0.82 + Math.random() * 0.18).toFixed(2)),
      roadClosure,
      trafficLevel:       speedToLevel(currentSpeed),
      road_type:          FRC_ROAD_TYPES['FRC3'],
    },
  });
});

// ── Current Weather Conditions ────────────────────────────────────────────────
// Mirrors: GET /weather/1/currentConditions/json?q=lat,lon&key=...
app.get('/weather/1/currentConditions/json', (req, res) => {
  const baseTemp      = getBaseTemperature();
  const temperature_c = Math.round(baseTemp + (Math.random() - 0.5) * 6);

  const weather_condition = weightedRandom([
    { value: 'clear',         weight: 0.35 },
    { value: 'partly_cloudy', weight: 0.25 },
    { value: 'cloudy',        weight: 0.15 },
    { value: 'rainy',         weight: 0.12 },
    { value: 'foggy',         weight: 0.05 },
    { value: 'snowy',         weight: temperature_c < 2  ? 0.12 : 0.005 },
    { value: 'icy',           weight: temperature_c < -2 ? 0.08 : 0.0   },
  ]);

  const hasPrecip = ['rainy', 'snowy', 'icy'].includes(weather_condition);

  res.json({
    currentConditions: {
      temperature_c,
      weather_condition,
      precipitation_mm: hasPrecip ? parseFloat((Math.random() * 15).toFixed(1)) : 0,
      wind_speed_kmh:   Math.round(5 + Math.random() * 30),
    },
  });
});

app.get('/health', (_req, res) =>
  res.json({ status: 'ok', service: 'TomTom Mock API', port: PORT })
);

app.listen(PORT, () => {
  console.log(`[TomTom Mock] API server running on port ${PORT}`);
});
