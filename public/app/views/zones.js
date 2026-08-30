/** Zonas de entrega: raio, taxa e entregador preferencial — arraste no mapa. */
import { api } from '../api.js';
import { can, refreshReference, state } from '../store.js';
import { confirmDialog, emptyState, modal, notifyError, toast } from '../ui.js';
import { esc, fromCents, money, toCents } from '../util.js';

let map = null;
let layers = [];

export async function render(container) {
  container.innerHTML = `
    <div class="grid cols-2" style="grid-template-columns:minmax(0,420px) minmax(0,1fr)">
      <div class="card">
        <header><h3>Zonas</h3>${can('zones:create') ? '<button class="btn-sm" id="new" style="margin-left:auto">+ Nova zona</button>' : ''}</header>
        <div class="table-wrap" id="list"></div>
        <div class="body"><div class="hint">A taxa da zona é aplicada quando a política de taxa está em "por zona".
          Se o endereço cair em mais de uma zona, vale a de menor raio.</div></div>
      </div>
      <div class="card">
        <header><h3>Mapa das zonas</h3><span class="muted small">arraste o pino para reposicionar</span></header>
        <div class="body"><div id="map" class="map"></div></div>
      </div>
    </div>`;
  container.querySelector('#new')?.addEventListener('click', () => dialog(container, null));
  await draw(container);
}

export function destroy() { if (map) { map.remove(); map = null; } layers = []; }

async function draw(container) {
  const [zones, drivers] = await Promise.all([api.zones(), api.drivers().catch(() => [])]);
  container.querySelector('#list').innerHTML = zones.length ? `<table>
    <thead><tr><th>Zona</th><th class="num">Raio</th><th class="num">Taxa</th><th>Entregador</th><th></th></tr></thead>
    <tbody>${zones.map((z) => `<tr>
      <td><span class="dot" style="background:${esc(z.color)}"></span> <b>${esc(z.name)}</b>
        ${z.active ? '' : '<span class="badge gray">inativa</span>'}
        ${z.lat == null ? '<div class="small badge orange">sem posição no mapa</div>' : ''}</td>
      <td class="num">${z.radius_km} km</td>
      <td class="num strong">${money(z.fee_cents)}</td>
      <td class="small">${esc(drivers.find((d) => d.id === z.driver_id)?.name || '—')}</td>
      <td class="right nowrap">
        ${can('zones:update') ? `<button class="btn-ghost btn-sm" data-edit="${z.id}">Editar</button>` : ''}
        ${can('zones:delete') ? `<button class="btn-danger btn-sm" data-del="${z.id}">Excluir</button>` : ''}</td>
    </tr>`).join('')}</tbody></table>` : emptyState('🗺️', 'Nenhuma zona cadastrada', 'Crie zonas para cobrar taxas diferentes por região.');

  container.querySelectorAll('[data-edit]').forEach((b) => {
    b.onclick = () => dialog(container, zones.find((z) => z.id === Number(b.dataset.edit)), drivers);
  });
  container.querySelectorAll('[data-del]').forEach((b) => {
    b.onclick = async () => {
      if (!await confirmDialog('Excluir esta zona?')) return;
      try { await api.del(`/api/zones/${b.dataset.del}`); await refreshReference(); draw(container); } catch (err) { notifyError(err); }
    };
  });
  drawMap(container, zones);
}

function drawMap(container, zones) {
  if (typeof L === 'undefined') return;
  const element = container.querySelector('#map');
  if (!element) return;
  const store = state.settings.store_lat != null ? { lat: Number(state.settings.store_lat), lon: Number(state.settings.store_lon) } : null;
  if (!map) {
    map = L.map(element).setView(store ? [store.lat, store.lon] : [-22.83, -43.4], 12);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { attribution: '&copy; OpenStreetMap' }).addTo(map);
  }
  layers.forEach((l) => l.remove());
  layers = [];
  if (store) {
    layers.push(L.marker([store.lat, store.lon], {
      icon: L.divIcon({ className: '', html: '<div class="pin-store">🏪</div>', iconSize: [30, 30], iconAnchor: [15, 15] }),
    }).addTo(map).bindPopup('Loja'));
  }
  for (const zone of zones) {
    if (zone.lat == null) continue;
    const circle = L.circle([zone.lat, zone.lon], {
      radius: Number(zone.radius_km) * 1000, color: zone.color, fillColor: zone.color, fillOpacity: .1, weight: 2,
    }).addTo(map).bindPopup(`<b>${esc(zone.name)}</b><br>${zone.radius_km} km · ${money(zone.fee_cents)}`);
    const canDrag = can('zones:update');
    const marker = L.marker([zone.lat, zone.lon], {
      draggable: canDrag, title: canDrag ? 'Arraste para mover a zona' : undefined,
    }).addTo(map);
    marker.on('drag', (event) => circle.setLatLng(event.target.getLatLng()));
    marker.on('dragend', async (event) => {
      const point = event.target.getLatLng();
      try {
        await api.patch(`/api/zones/${zone.id}`, { lat: point.lat, lon: point.lng });
        toast(`Zona ${zone.name} reposicionada`, 'ok');
        await refreshReference();
      } catch (err) { notifyError(err); }
    });
    layers.push(circle, marker);
  }
  setTimeout(() => map.invalidateSize(), 60);
}

async function dialog(container, zone, drivers = []) {
  const store = state.settings;
  const form = document.createElement('div');
  form.innerHTML = `
    <div class="grid cols-2">
      <div class="field"><label>Nome</label><input id="name" value="${esc(zone?.name || '')}" placeholder="Centro"></div>
      <div class="field"><label>Cor</label><input type="color" id="color" value="${esc(zone?.color || '#2E7D32')}"></div>
      <div class="field"><label>Raio (km)</label><input type="number" step="0.5" id="radius_km" value="${zone?.radius_km ?? 3}"></div>
      <div class="field"><label>Taxa de entrega (R$)</label><input id="fee" value="${zone ? fromCents(zone.fee_cents) : ''}" placeholder="5,00"></div>
      <div class="field"><label>Latitude</label><input id="lat" value="${zone?.lat ?? store.store_lat ?? ''}"></div>
      <div class="field"><label>Longitude</label><input id="lon" value="${zone?.lon ?? store.store_lon ?? ''}"></div>
      <div class="field"><label>Entregador preferencial</label><select id="driver_id"><option value="">Nenhum</option>
        ${drivers.map((d) => `<option value="${d.id}" ${zone?.driver_id === d.id ? 'selected' : ''}>${esc(d.name)}</option>`).join('')}</select></div>
      <div class="field"><label class="checkbox"><input type="checkbox" id="active" ${zone?.active !== false ? 'checked' : ''}> Zona ativa</label></div>
    </div>
    <div class="hint">Dica: salve com a posição da loja e depois arraste o pino no mapa para ajustar.</div>`;

  const saved = await modal({
    title: zone ? `Editar ${zone.name}` : 'Nova zona',
    body: form,
    actions: [
      { label: 'Cancelar', className: 'btn-ghost', value: false },
      {
        label: 'Salvar',
        onClick: async ({ body }) => {
          const payload = {
            name: body.querySelector('#name').value.trim(),
            color: body.querySelector('#color').value,
            radius_km: Number(body.querySelector('#radius_km').value),
            fee_cents: toCents(body.querySelector('#fee').value),
            lat: body.querySelector('#lat').value ? Number(body.querySelector('#lat').value) : null,
            lon: body.querySelector('#lon').value ? Number(body.querySelector('#lon').value) : null,
            driver_id: body.querySelector('#driver_id').value || null,
            active: body.querySelector('#active').checked,
          };
          if (!payload.name) { toast('Informe o nome da zona', 'warn'); return false; }
          if (zone) await api.patch(`/api/zones/${zone.id}`, payload);
          else await api.post('/api/zones', payload);
          return true;
        },
      },
    ],
  });
  if (saved) { toast('Zona salva', 'ok'); await refreshReference(); draw(container); }
}
