/**
 * Navegação do entregador: links do Waze/Google Maps e QR Codes.
 *
 * O Waze navega para um destino por vez (não aceita múltiplas paradas), então
 * usamos Waze para a parada atual e Google Maps para o trajeto completo.
 * O QR Code serve para o entregador apontar a câmera do celular para a tela do
 * painel (ou para o romaneio impresso) e abrir a navegação sem digitar nada.
 */
import { modal } from './ui.js';
import { esc } from './util.js';

/** Link universal do Waze: abre o app no celular e o site no computador. */
export function wazeLink(target) {
  if (target?.lat != null && target?.lon != null) {
    return `https://waze.com/ul?ll=${target.lat}%2C${target.lon}&navigate=yes`;
  }
  const address = typeof target === 'string' ? target : target?.address;
  return address ? `https://waze.com/ul?q=${encodeURIComponent(address)}&navigate=yes` : '';
}

/** Link do Google Maps para um destino único. */
export function mapsPointLink(target) {
  if (target?.lat != null && target?.lon != null) {
    return `https://www.google.com/maps/dir/?api=1&travelmode=driving&destination=${target.lat},${target.lon}`;
  }
  const address = typeof target === 'string' ? target : target?.address;
  return address ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(address)}` : '';
}

/** Prefixo dos QR Codes de pedido, lidos pelo app do entregador. */
export const ORDER_QR_PREFIX = 'OUTFOOD:PEDIDO:';
export const orderQrPayload = (code) => `${ORDER_QR_PREFIX}${code}`;

/** Extrai o código do pedido de um QR lido (aceita também o código puro). */
export function parseOrderQr(text) {
  const value = String(text || '').trim();
  if (!value) return null;
  if (value.toUpperCase().startsWith(ORDER_QR_PREFIX)) return value.slice(ORDER_QR_PREFIX.length).trim();
  if (/^\d{4}-\d{3}$/.test(value)) return value;
  try {
    const url = new URL(value);
    const fromQuery = url.searchParams.get('pedido') || url.searchParams.get('code');
    if (fromQuery) return fromQuery;
  } catch { /* não era URL */ }
  return null;
}

/**
 * Gera o SVG de um QR Code. Depende da biblioteca vendorizada em
 * /vendor/qrcode/qrcode.js, carregada como script clássico nas páginas.
 */
export function qrSvg(text, { cellSize = 5, margin = 2 } = {}) {
  if (typeof window.qrcode !== 'function' || !text) return '';
  try {
    // Correção de erro média: aguenta a impressão térmica borrar um pouco.
    const qr = window.qrcode(0, 'M');
    qr.addData(String(text));
    qr.make();
    return qr.createSvgTag({ cellSize, margin, scalable: true });
  } catch {
    return '';
  }
}

/** Bloco pronto com o QR e uma legenda — usado em telas e na impressão. */
export function qrBlock(text, caption = '', size = 190) {
  const svg = qrSvg(text);
  if (!svg) return '';
  return `<div class="qr-block" style="max-width:${size}px">
    <div class="qr-img">${svg}</div>
    ${caption ? `<div class="qr-caption">${esc(caption)}</div>` : ''}
  </div>`;
}

/**
 * Modal de navegação de uma parada: QR do Waze/Maps + botões diretos.
 * `stop` precisa de { customer_name, address, lat, lon } e opcionalmente code.
 */
export function navigateDialog(stop, { routeMapsUrl = '', title = 'Navegar até a parada' } = {}) {
  const waze = wazeLink(stop);
  const maps = mapsPointLink(stop);
  const body = document.createElement('div');

  const render = (mode) => {
    const url = mode === 'waze' ? waze : (mode === 'rota' ? routeMapsUrl : maps);
    body.innerHTML = `
      <div class="center">
        <div class="pill-group mb">
          <button data-mode="waze" class="${mode === 'waze' ? 'active' : ''}">Waze</button>
          <button data-mode="maps" class="${mode === 'maps' ? 'active' : ''}">Google Maps</button>
          ${routeMapsUrl ? `<button data-mode="rota" class="${mode === 'rota' ? 'active' : ''}">Rota completa</button>` : ''}
        </div>
        <div><b>${esc(stop.customer_name || 'Destino')}</b></div>
        <div class="small muted mb">${esc(stop.address || '')}</div>
        ${qrBlock(url, 'Aponte a câmera do celular para abrir a navegação', 220)}
        ${mode === 'rota' ? '<div class="hint mt">O Waze navega um destino por vez; a rota completa abre no Google Maps.</div>' : ''}
        <a class="btn btn-lg mt" href="${esc(url)}" target="_blank" rel="noopener">Abrir aqui neste aparelho</a>
      </div>`;
    body.querySelectorAll('[data-mode]').forEach((button) => {
      button.onclick = () => render(button.dataset.mode);
    });
  };
  render('waze');

  return modal({ title, body, actions: [{ label: 'Fechar', className: 'btn-ghost' }] });
}

/** Modal com o QR da rota inteira (Google Maps com todas as paradas). */
export function routeQrDialog(route) {
  const body = document.createElement('div');
  body.innerHTML = `
    <div class="center">
      <div><b>Rota #${route.id} — ${esc(route.driver_name || '')}</b></div>
      <div class="small muted mb">${route.stops.length} paradas · ${route.planned_km} km · ~${route.planned_minutes} min</div>
      ${qrBlock(route.maps_url, 'Escaneie com o celular para abrir a rota no Google Maps', 240)}
      <div class="hint mt">O Waze aceita um destino por vez: use o botão "Navegar" de cada parada no app do entregador.</div>
    </div>`;
  return modal({ title: 'QR Code da rota', body, actions: [{ label: 'Fechar', className: 'btn-ghost' }] });
}

/**
 * Leitor de QR/código de barras usando a API nativa do navegador
 * (BarcodeDetector, disponível no Chrome/Android). Onde não existir, o modal
 * cai para a digitação manual do código do pedido.
 */
export async function scanOrderCode() {
  const supported = 'BarcodeDetector' in window && navigator.mediaDevices?.getUserMedia;
  const body = document.createElement('div');
  body.innerHTML = `
    <div class="center">
      ${supported ? `<video id="cam" playsinline muted style="width:100%;max-height:320px;border-radius:10px;background:#000"></video>
        <div class="hint mt" id="scanHint">Aponte para o QR Code impresso na comanda do pedido.</div>`
        : '<div class="hint mb">Este navegador não abre a câmera. Digite o código impresso na comanda.</div>'}
      <div class="field mt"><label>Código do pedido</label>
        <input id="manualCode" placeholder="0829-014" autocomplete="off"></div>
    </div>`;

  let stream = null;
  let stopped = false;

  const result = await modal({
    title: 'Escanear pedido',
    body,
    actions: [
      { label: 'Cancelar', className: 'btn-ghost', value: null },
      {
        label: 'Usar código digitado',
        onClick: ({ body: el }) => parseOrderQr(el.querySelector('#manualCode').value) || el.querySelector('#manualCode').value.trim() || false,
      },
    ],
    onOpen: async ({ body: el, close }) => {
      if (!supported) return;
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
        const video = el.querySelector('#cam');
        video.srcObject = stream;
        await video.play();
        const detector = new window.BarcodeDetector({ formats: ['qr_code', 'code_128', 'ean_13'] });
        const tick = async () => {
          if (stopped) return;
          try {
            const codes = await detector.detect(video);
            const found = codes.map((c) => parseOrderQr(c.rawValue)).find(Boolean);
            if (found) { close(found); return; }
          } catch { /* frame ruim, tenta o próximo */ }
          requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      } catch {
        el.querySelector('#scanHint').textContent = 'Não consegui abrir a câmera. Digite o código da comanda.';
      }
    },
  });

  stopped = true;
  stream?.getTracks().forEach((track) => track.stop());
  return result || null;
}
