import test from 'node:test';
import assert from 'node:assert/strict';
import {
  estimateRouteMinutes, findZone, haversine, legDistances, mapsLink,
  optimizeStops, routeDistanceKm, splitAmongDrivers, formatMinutes,
} from '../server/lib/geo.js';

const STORE = { lat: -22.8233, lon: -43.3988 };

test('haversine mede a distância entre dois pontos conhecidos', () => {
  // Loja -> ~1 km ao norte
  const km = haversine(STORE, { lat: -22.8143, lon: -43.3988 });
  assert.ok(km > 0.9 && km < 1.2, `esperava ~1 km, veio ${km}`);
  assert.equal(haversine(STORE, { lat: null, lon: null }), null);
  assert.equal(haversine(null, STORE), null);
});

test('optimizeStops encurta o percurso em relação à ordem de chegada', () => {
  const stops = [
    { id: 1, lat: -22.8600, lon: -43.3600 },
    { id: 2, lat: -22.8250, lon: -43.4010 },
    { id: 3, lat: -22.8700, lon: -43.3500 },
    { id: 4, lat: -22.8200, lon: -43.3950 },
  ];
  const naive = routeDistanceKm(STORE, stops);
  const optimized = routeDistanceKm(STORE, optimizeStops(STORE, stops));
  assert.ok(optimized <= naive, `otimizada ${optimized} deveria ser <= ingênua ${naive}`);
  assert.ok(optimized < naive, 'nesta configuração a otimização precisa render ganho real');
});

test('paradas sem coordenada vão para o fim, sem quebrar o cálculo', () => {
  const stops = [
    { id: 1 },
    { id: 2, lat: -22.8250, lon: -43.4010 },
    { id: 3, lat: -22.8200, lon: -43.3950 },
  ];
  const ordered = optimizeStops(STORE, stops);
  assert.equal(ordered.length, 3);
  assert.equal(ordered[ordered.length - 1].id, 1);
  assert.ok(Number.isFinite(routeDistanceKm(STORE, ordered)));
});

test('estimateRouteMinutes soma deslocamento e tempo de parada', () => {
  const stops = [{ lat: -22.8143, lon: -43.3988 }, { lat: -22.8053, lon: -43.3988 }];
  const fast = estimateRouteMinutes(STORE, stops, { avgSpeedKmh: 60, stopMinutes: 0 });
  const slow = estimateRouteMinutes(STORE, stops, { avgSpeedKmh: 20, stopMinutes: 5 });
  assert.ok(slow > fast, 'mais devagar e com parada precisa demorar mais');
  assert.equal(estimateRouteMinutes(STORE, [], {}), 0);
  // Sem opções, usa os padrões (22 km/h, 4 min por parada) e não devolve NaN.
  assert.ok(Number.isFinite(estimateRouteMinutes(STORE, stops)));
});

test('splitAmongDrivers divide as paradas entre os entregadores', () => {
  const stops = Array.from({ length: 6 }, (_, i) => ({ id: i, lat: -22.82 - i * 0.01, lon: -43.39 - i * 0.01 }));
  const buckets = splitAmongDrivers(STORE, stops, 3);
  assert.equal(buckets.length, 3);
  assert.equal(buckets.flat().length, 6, 'nenhuma parada pode se perder na divisão');
  const ids = new Set(buckets.flat().map((s) => s.id));
  assert.equal(ids.size, 6, 'nenhuma parada pode ser duplicada');
});

test('splitAmongDrivers com um entregador devolve a rota inteira otimizada', () => {
  const stops = [{ id: 1, lat: -22.86, lon: -43.36 }, { id: 2, lat: -22.825, lon: -43.401 }];
  const [only] = splitAmongDrivers(STORE, stops, 1);
  assert.equal(only.length, 2);
  assert.equal(only[0].id, 2, 'a parada mais próxima da loja vem primeiro');
});

test('findZone escolhe a zona de menor raio que contém o ponto', () => {
  const zones = [
    { id: 1, name: 'Ampla', lat: -22.8233, lon: -43.3988, radius_km: 10, active: 1 },
    { id: 2, name: 'Perto', lat: -22.8233, lon: -43.3988, radius_km: 2, active: 1 },
    { id: 3, name: 'Inativa', lat: -22.8233, lon: -43.3988, radius_km: 1, active: 0 },
  ];
  assert.equal(findZone({ lat: -22.8243, lon: -43.3998 }, zones).id, 2);
  assert.equal(findZone({ lat: -23.5, lon: -46.6 }, zones), null);
  assert.equal(findZone(null, zones), null);
});

test('legDistances devolve uma distância por parada, na ordem', () => {
  const stops = [{ lat: -22.8143, lon: -43.3988 }, { lat: -22.8053, lon: -43.3988 }];
  const legs = legDistances(STORE, stops);
  assert.equal(legs.length, 2);
  assert.ok(legs.every((l) => l > 0));
});

test('mapsLink monta a rota com origem, destino e paradas intermediárias', () => {
  const link = mapsLink([STORE, { lat: -22.81, lon: -43.39 }, { lat: -22.80, lon: -43.38 }]);
  assert.match(link, /origin=-22\.8233,-43\.3988/);
  assert.match(link, /destination=-22\.8,-43\.38/);
  assert.match(link, /waypoints=-22\.81,-43\.39/);
  assert.equal(mapsLink([STORE]), '', 'com um ponto só não há rota');
});

test('formatMinutes escreve durações legíveis', () => {
  assert.equal(formatMinutes(45), '45 min');
  assert.equal(formatMinutes(60), '1h');
  assert.equal(formatMinutes(95), '1h35');
});
