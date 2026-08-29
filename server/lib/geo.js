/**
 * Geolocalização e otimização de rotas.
 * A heurística (vizinho mais próximo + 2-opt) veio do painel v1 e foi
 * estendida com balanceamento de carga entre entregadores.
 */

const EARTH_RADIUS_KM = 6371;
const rad = (deg) => (deg * Math.PI) / 180;
const numberOr = (value, fallback) => (Number.isFinite(Number(value)) ? Number(value) : fallback);

export function haversine(a, b) {
  if (!a || !b || a.lat == null || b.lat == null) return null;
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(h));
}

/** Vizinho mais próximo a partir de um ponto de origem. */
export function nearestNeighbour(start, points) {
  const pending = points.slice();
  const ordered = [];
  let current = start;
  while (pending.length) {
    let bestIndex = 0;
    let bestDistance = Infinity;
    for (let i = 0; i < pending.length; i++) {
      const d = haversine(current, pending[i]);
      if (d != null && d < bestDistance) { bestDistance = d; bestIndex = i; }
    }
    current = pending[bestIndex];
    ordered.push(current);
    pending.splice(bestIndex, 1);
  }
  return ordered;
}

/** Refina a ordem trocando trechos que se cruzam (2-opt). */
export function twoOpt(start, ordered) {
  const path = [start, ...ordered];
  let improved = true;
  let guard = 0;
  while (improved && guard++ < 200) {
    improved = false;
    for (let i = 1; i < path.length - 1; i++) {
      for (let k = i + 1; k < path.length; k++) {
        const a = path[i - 1], b = path[i], c = path[k], d = path[k + 1];
        const before = (haversine(a, b) ?? 0) + (d ? haversine(c, d) ?? 0 : 0);
        const after = (haversine(a, c) ?? 0) + (d ? haversine(b, d) ?? 0 : 0);
        if (after + 1e-9 < before) {
          const slice = path.slice(i, k + 1).reverse();
          path.splice(i, slice.length, ...slice);
          improved = true;
        }
      }
    }
  }
  path.shift();
  return path;
}

/**
 * Ordena as paradas de uma rota. Paradas sem coordenada vão para o fim,
 * preservando a ordem de chegada.
 */
export function optimizeStops(start, stops) {
  const geo = stops.filter((s) => s.lat != null && s.lon != null);
  const noGeo = stops.filter((s) => s.lat == null || s.lon == null);
  const ordered = start && geo.length > 1 ? twoOpt(start, nearestNeighbour(start, geo)) : geo;
  return [...ordered, ...noGeo];
}

/** Distância total percorrida saindo da loja e passando por todas as paradas. */
export function routeDistanceKm(start, stops) {
  let km = 0;
  let previous = start;
  for (const stop of stops) {
    const leg = haversine(previous, stop);
    if (leg != null) km += leg;
    if (stop.lat != null) previous = stop;
  }
  return Math.round(km * 100) / 100;
}

/** Distância de cada perna, na ordem das paradas. */
export function legDistances(start, stops) {
  const legs = [];
  let previous = start;
  for (const stop of stops) {
    const leg = haversine(previous, stop);
    legs.push(leg == null ? 0 : Math.round(leg * 100) / 100);
    if (stop.lat != null) previous = stop;
  }
  return legs;
}

/**
 * Tempo estimado da rota em minutos.
 * Paradas sem coordenada entram com uma penalidade fixa (fallbackLegMinutes).
 */
export function estimateRouteMinutes(start, stops, opts = {}) {
  const speed = Math.max(Number(opts.avgSpeedKmh) || 22, 5);
  const stopMinutes = Math.max(numberOr(opts.stopMinutes, 4), 0);
  const fallback = numberOr(opts.fallbackLegMinutes, 10);
  if (!stops.length) return 0;
  let km = 0;
  let unknownLegs = 0;
  let previous = start;
  for (const stop of stops) {
    const leg = haversine(previous, stop);
    if (leg == null) unknownLegs++;
    else km += leg;
    if (stop.lat != null) previous = stop;
  }
  return Math.round((km / speed) * 60 + unknownLegs * fallback + stops.length * stopMinutes);
}

/**
 * Divide as paradas entre N entregadores agrupando por proximidade angular
 * (setores em torno da loja) e equilibrando a quantidade por entregador.
 * Devolve um array de arrays de paradas, já otimizadas.
 */
export function splitAmongDrivers(start, stops, driverCount) {
  const count = Math.max(1, Math.floor(driverCount));
  if (count === 1) return [optimizeStops(start, stops)];

  const geo = stops.filter((s) => s.lat != null && s.lon != null);
  const noGeo = stops.filter((s) => s.lat == null || s.lon == null);

  const withAngle = geo.map((stop) => ({
    stop,
    angle: start ? Math.atan2(stop.lat - start.lat, stop.lon - start.lon) : 0,
  }));
  withAngle.sort((a, b) => a.angle - b.angle);

  const buckets = Array.from({ length: count }, () => []);
  const perBucket = Math.ceil(withAngle.length / count) || 1;
  withAngle.forEach((item, index) => {
    buckets[Math.min(count - 1, Math.floor(index / perBucket))].push(item.stop);
  });
  // Paradas sem coordenada são distribuídas em round-robin.
  noGeo.forEach((stop, index) => buckets[index % count].push(stop));

  return buckets.map((bucket) => optimizeStops(start, bucket));
}

/** Encontra a zona de entrega que contém um ponto (a de menor raio vence). */
export function findZone(point, zones) {
  if (!point || point.lat == null) return null;
  const matches = zones
    .filter((z) => z.lat != null && z.lon != null && z.active !== 0)
    .map((z) => ({ zone: z, km: haversine(point, z) }))
    .filter((z) => z.km != null && z.km <= Number(z.zone.radius_km || 0))
    .sort((a, b) => Number(a.zone.radius_km) - Number(b.zone.radius_km) || a.km - b.km);
  return matches.length ? matches[0].zone : null;
}

/** Link de rota no Google Maps com múltiplas paradas. */
export function mapsLink(points) {
  const usable = points.filter(Boolean);
  if (usable.length < 2) return '';
  const format = (p) =>
    p.lat != null && p.lon != null ? `${p.lat},${p.lon}` : encodeURIComponent(p.address || '');
  const origin = format(usable[0]);
  const destination = format(usable[usable.length - 1]);
  const waypoints = usable.slice(1, -1).map(format).join('|');
  return (
    'https://www.google.com/maps/dir/?api=1&travelmode=driving' +
    `&origin=${origin}&destination=${destination}` +
    (waypoints ? `&waypoints=${waypoints}` : '')
  );
}

export function formatMinutes(minutes) {
  const m = Math.max(0, Math.round(Number(minutes) || 0));
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  const rest = m % 60;
  return `${h}h${rest ? String(rest).padStart(2, '0') : ''}`;
}
