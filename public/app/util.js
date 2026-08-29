/** Utilidades compartilhadas pelo painel, app do entregador e vitrine. */

export const $ = (selector, root = document) => root.querySelector(selector);
export const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

export function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

/** Template tag que escapa interpolações: html`<b>${nome}</b>`. */
export function html(strings, ...values) {
  return strings.reduce((acc, str, i) => {
    const value = values[i - 1];
    const rendered = Array.isArray(value) ? value.join('') : value;
    return acc + (value?.__raw ? value.value : esc(rendered ?? '')) + str;
  });
}
export const raw = (value) => ({ __raw: true, value: Array.isArray(value) ? value.join('') : String(value ?? '') });

const BRL = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
export const money = (cents) => BRL.format((Number(cents) || 0) / 100);
export const moneyShort = (cents) => BRL.format((Number(cents) || 0) / 100).replace('R$ ', '');

export function toCents(value) {
  if (value === '' || value == null) return 0;
  const normalized = String(value).replace(/[R$\s.]/g, '').replace(',', '.');
  const n = Number(normalized);
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
}

export const fromCents = (cents) => ((Number(cents) || 0) / 100).toFixed(2).replace('.', ',');

/** Datas vindas do SQLite chegam em UTC sem o sufixo Z. */
export function parseDate(value) {
  if (!value) return null;
  const text = String(value);
  const iso = text.includes('T') ? text : text.replace(' ', 'T');
  return new Date(iso.endsWith('Z') || /[+-]\d{2}:\d{2}$/.test(iso) ? iso : iso + 'Z');
}

export function time(value) {
  const date = parseDate(value);
  return date ? date.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) : '--:--';
}

export function dateTime(value) {
  const date = parseDate(value);
  return date ? date.toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '-';
}

export function dayLabel(value) {
  if (!value) return '-';
  const [y, m, d] = String(value).split('-');
  return `${d}/${m}/${y}`;
}

/** "há 12 min" — usado nas comandas para medir atraso. */
export function since(value) {
  const date = parseDate(value);
  if (!date) return '';
  const minutes = Math.floor((Date.now() - date.getTime()) / 60000);
  if (minutes < 1) return 'agora';
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h${String(minutes % 60).padStart(2, '0')}`;
}

export function minutesUntil(value) {
  const date = parseDate(value);
  if (!date) return null;
  return Math.round((date.getTime() - Date.now()) / 60000);
}

export function formatPhone(digits) {
  const d = String(digits || '').replace(/\D/g, '');
  if (d.length === 11) return `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`;
  if (d.length === 10) return `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}`;
  return d;
}

export const STATUS_META = {
  rascunho: { label: 'Rascunho', color: 'gray', icon: '📝' },
  recebido: { label: 'Recebido', color: 'blue', icon: '🔔' },
  em_preparo: { label: 'Em preparo', color: 'orange', icon: '🔥' },
  pronto: { label: 'Pronto', color: 'green', icon: '✅' },
  em_entrega: { label: 'Em entrega', color: 'orange', icon: '🛵' },
  entregue: { label: 'Entregue', color: 'green', icon: '🎉' },
  cancelado: { label: 'Cancelado', color: 'red', icon: '✖' },
};

export const CHANNEL_LABELS = {
  balcao: 'Balcão', telefone: 'Telefone', whatsapp: 'WhatsApp', site: 'Site',
  ifood: 'iFood', rappi: 'Rappi', outra_plataforma: 'Outra plataforma',
};

export const TYPE_LABELS = { entrega: 'Entrega', retirada: 'Retirada', salao: 'Salão' };

export const PAYMENT_LABELS = {
  dinheiro: 'Dinheiro', pix: 'PIX', credito: 'Crédito', debito: 'Débito',
  vale_refeicao: 'Vale-refeição', online: 'Pago online',
};

export const ROUTE_STATUS_LABELS = {
  planejada: 'Planejada', em_rota: 'Em rota', concluida: 'Concluída', cancelada: 'Cancelada',
};

export const STOP_STATUS_LABELS = {
  pendente: 'Pendente', entregue: 'Entregue', falhou: 'Não entregue', cancelada: 'Cancelada',
};

/** "1 adicional" / "2 adicionais" */
export function plural(count, singular, pluralForm) {
  const n = Number(count) || 0;
  return `${n} ${n === 1 ? singular : (pluralForm || singular + 's')}`;
}

export const DRIVER_STATUS_META = {
  offline: { label: 'Fora de turno', dot: 'off' },
  na_loja: { label: 'Na loja', dot: 'on' },
  em_rota: { label: 'Em rota', dot: 'busy' },
};

export function statusBadge(status) {
  const meta = STATUS_META[status] || { label: status, color: 'gray', icon: '' };
  return `<span class="badge ${meta.color}">${meta.icon} ${esc(meta.label)}</span>`;
}

export function debounce(fn, ms = 300) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

export function groupBy(items, key) {
  const map = new Map();
  for (const item of items) {
    const value = typeof key === 'function' ? key(item) : item[key];
    if (!map.has(value)) map.set(value, []);
    map.get(value).push(item);
  }
  return map;
}

export function whatsappLink(phone, message) {
  const digits = String(phone || '').replace(/\D/g, '');
  const full = digits.length <= 11 ? `55${digits}` : digits;
  return `https://wa.me/${full}?text=${encodeURIComponent(message || '')}`;
}

export function todayISO() {
  const now = new Date(Date.now() - 5 * 3600 * 1000);
  return now.toISOString().slice(0, 10);
}
