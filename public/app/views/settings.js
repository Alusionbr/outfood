/** Configurações da loja: endereço, política de taxa, tempos e impressão. */
import { api } from '../api.js';
import { can, refreshReference } from '../store.js';
import { notifyError, toast } from '../ui.js';
import { esc, fromCents, toCents } from '../util.js';

export async function render(container) {
  const s = await api.settings();
  const editable = can('settings:update');
  container.innerHTML = `
    <div class="grid cols-2">
      <div class="card">
        <header><h3>Loja</h3></header>
        <div class="body">
          <div class="field"><label>Nome da loja</label><input id="store_name" value="${esc(s.store_name || '')}"></div>
          <div class="field"><label>Endereço (ponto de partida das rotas)</label>
            <div class="row tight"><input id="store_address" class="grow" value="${esc(s.store_address || '')}" placeholder="Rua, nº, bairro, cidade">
              <button class="btn-2" id="locate">📍 Localizar</button></div>
            <div class="hint" id="coords">${s.store_lat != null ? `lat ${s.store_lat}, lon ${s.store_lon}` : 'sem coordenada — as rotas não serão otimizadas'}</div></div>
          <div class="grid cols-2">
            <div class="field"><label>Telefone</label><input id="store_phone" value="${esc(s.store_phone || '')}"></div>
            <div class="field"><label>Cidade / UF padrão</label><input id="city" value="${esc(s.city || '')}"></div>
            <div class="field"><label>Horário de atendimento</label><input id="service_hours" value="${esc(s.service_hours || '')}"></div>
            <div class="field"><label>Chave PIX</label><input id="pix_key" value="${esc(s.pix_key || '')}"></div>
          </div>
        </div>
      </div>

      <div class="card">
        <header><h3>Entrega e taxas</h3></header>
        <div class="body">
          <div class="grid cols-2">
            <div class="field"><label>Política da taxa</label><select id="fee_mode">
              <option value="zona" ${s.fee_mode === 'zona' ? 'selected' : ''}>Por zona de entrega</option>
              <option value="km" ${s.fee_mode === 'km' ? 'selected' : ''}>Por distância (km)</option>
              <option value="fixo" ${s.fee_mode === 'fixo' ? 'selected' : ''}>Valor fixo</option>
            </select></div>
            <div class="field"><label>Taxa padrão (R$)</label><input id="default_fee_cents" value="${fromCents(s.default_fee_cents)}"></div>
            <div class="field"><label>Valor por km (R$)</label><input id="fee_per_km_cents" value="${fromCents(s.fee_per_km_cents)}"></div>
            <div class="field"><label>Frete grátis acima de (R$)</label><input id="free_delivery_above_cents" value="${fromCents(s.free_delivery_above_cents)}"></div>
            <div class="field"><label>Pedido mínimo (R$)</label><input id="min_order_cents" value="${fromCents(s.min_order_cents)}"></div>
            <div class="field"><label>Raio de atendimento (km)</label><input type="number" id="delivery_radius_km" value="${s.delivery_radius_km}"></div>
          </div>
        </div>
      </div>

      <div class="card">
        <header><h3>Tempos e rotas</h3></header>
        <div class="body"><div class="grid cols-2">
          <div class="field"><label>Tempo de preparo padrão (min)</label><input type="number" id="default_prep_minutes" value="${s.default_prep_minutes}"></div>
          <div class="field"><label>Velocidade média (km/h)</label><input type="number" id="avg_speed_kmh" value="${s.avg_speed_kmh}"></div>
          <div class="field"><label>Minutos por parada</label><input type="number" id="stop_minutes" value="${s.stop_minutes}"></div>
          <div class="field"><label>Comissão padrão por entrega (R$)</label><input id="driver_commission_default_cents" value="${fromCents(s.driver_commission_default_cents)}"></div>
        </div>
        <div class="hint">Esses números alimentam a estimativa de tempo das rotas e a promessa de entrega ao cliente.</div></div>
      </div>

      <div class="card">
        <header><h3>Impressão e canais</h3></header>
        <div class="body">
          <div class="field"><label>Largura da impressora térmica</label><select id="printer_width">
            <option value="80" ${String(s.printer_width) === '80' ? 'selected' : ''}>80 mm (padrão)</option>
            <option value="58" ${String(s.printer_width) === '58' ? 'selected' : ''}>58 mm</option>
          </select></div>
          <label class="checkbox mb"><input type="checkbox" id="online_orders" ${s.online_orders ? 'checked' : ''}> Aceitar pedidos pela vitrine online (<a href="/loja" target="_blank" rel="noopener">/loja</a>)</label>
          <label class="checkbox mb"><input type="checkbox" id="auto_confirm" ${s.auto_confirm ? 'checked' : ''}> Confirmar pedidos automaticamente ao registrar</label>
          <label class="checkbox"><input type="checkbox" id="road_routing" ${s.road_routing ? 'checked' : ''}> Desenhar rotas seguindo as ruas no mapa</label>
        </div>
      </div>
    </div>

    ${editable ? '<button class="btn-lg" id="save">Salvar configurações</button>' : '<div class="muted">Somente leitura para o seu perfil.</div>'}`;

  if (!editable) container.querySelectorAll('input,select').forEach((el) => { el.disabled = true; });

  container.querySelector('#locate')?.addEventListener('click', async (event) => {
    const address = container.querySelector('#store_address').value.trim();
    if (!address) return toast('Escreva o endereço primeiro', 'warn');
    event.target.disabled = true;
    event.target.textContent = 'Localizando...';
    try {
      const result = await api.get(`/api/geo/search?q=${encodeURIComponent(address)}`);
      if (!result.found) { toast('Não localizei este endereço', 'warn'); return; }
      await api.saveSettings({ store_lat: result.lat, store_lon: result.lon, store_address: address });
      container.querySelector('#coords').textContent = `lat ${result.lat}, lon ${result.lon}`;
      await refreshReference();
      toast('Loja posicionada no mapa', 'ok');
    } catch (err) { notifyError(err); } finally {
      event.target.disabled = false;
      event.target.textContent = '📍 Localizar';
    }
  });

  container.querySelector('#save')?.addEventListener('click', async (event) => {
    const q = (id) => container.querySelector(`#${id}`);
    const patch = {
      store_name: q('store_name').value.trim(),
      store_address: q('store_address').value.trim(),
      store_phone: q('store_phone').value.trim(),
      city: q('city').value.trim(),
      service_hours: q('service_hours').value.trim(),
      pix_key: q('pix_key').value.trim(),
      fee_mode: q('fee_mode').value,
      default_fee_cents: toCents(q('default_fee_cents').value),
      fee_per_km_cents: toCents(q('fee_per_km_cents').value),
      free_delivery_above_cents: toCents(q('free_delivery_above_cents').value),
      min_order_cents: toCents(q('min_order_cents').value),
      delivery_radius_km: Number(q('delivery_radius_km').value) || 10,
      default_prep_minutes: Number(q('default_prep_minutes').value) || 25,
      avg_speed_kmh: Number(q('avg_speed_kmh').value) || 22,
      stop_minutes: Number(q('stop_minutes').value) || 4,
      driver_commission_default_cents: toCents(q('driver_commission_default_cents').value),
      printer_width: q('printer_width').value,
      online_orders: q('online_orders').checked ? 1 : 0,
      auto_confirm: q('auto_confirm').checked ? 1 : 0,
      road_routing: q('road_routing').checked ? 1 : 0,
    };
    event.target.disabled = true;
    try {
      await api.saveSettings(patch);
      await refreshReference();
      toast('Configurações salvas', 'ok');
    } catch (err) { notifyError(err); } finally { event.target.disabled = false; }
  });
}
