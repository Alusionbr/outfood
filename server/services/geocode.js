import { get, run } from '../db.js';

const NOMINATIM = 'https://nominatim.openstreetmap.org/search';
const USER_AGENT = 'Outfood/2.0 (sistema de entregas para restaurantes)';
let lastCall = 0;

/**
 * Geocodifica um endereço usando o Nominatim (OpenStreetMap), com cache em
 * banco e limite de 1 requisição por segundo, conforme a política de uso.
 * Falhas de rede não quebram o fluxo: o pedido segue sem coordenada.
 */
export async function geocode(query) {
  const q = String(query || '').trim();
  if (q.length < 5) return null;

  const cached = get('SELECT lat, lon FROM geo_cache WHERE query = ?', q.toLowerCase());
  if (cached) return cached.lat == null ? null : { lat: cached.lat, lon: cached.lon, cached: true };

  const wait = 1100 - (Date.now() - lastCall);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastCall = Date.now();

  try {
    const url = `${NOMINATIM}?format=json&limit=1&countrycodes=br&q=${encodeURIComponent(q)}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    const response = await fetch(url, {
      headers: { Accept: 'application/json', 'User-Agent': USER_AGENT },
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!response.ok) return null;
    const json = await response.json();
    if (Array.isArray(json) && json.length) {
      const point = { lat: Number(json[0].lat), lon: Number(json[0].lon) };
      cache(q, point.lat, point.lon);
      return point;
    }
    cache(q, null, null); // memoriza a ausência para não repetir a chamada
    return null;
  } catch {
    return null;
  }
}

function cache(query, lat, lon) {
  try {
    run('INSERT OR REPLACE INTO geo_cache(query, lat, lon) VALUES (?,?,?)', query.toLowerCase(), lat, lon);
  } catch { /* cache é best-effort */ }
}

/** Monta a string de busca a partir dos campos de endereço. */
export function addressQuery(parts, fallbackCity = '') {
  return [
    [parts.street, parts.number].filter(Boolean).join(', '),
    parts.district,
    parts.city || fallbackCity,
    'Brasil',
  ].filter(Boolean).join(', ');
}
