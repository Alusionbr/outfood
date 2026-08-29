/** Componentes de interface: toasts, modais, confirmações e impressão. */
import { $, esc } from './util.js';

let toastHost = null;

export function toast(message, kind = 'ok', ms = 3600) {
  if (!toastHost) {
    toastHost = document.createElement('div');
    toastHost.className = 'toasts';
    document.body.appendChild(toastHost);
  }
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = message;
  toastHost.appendChild(el);
  setTimeout(() => { el.style.opacity = '0'; setTimeout(() => el.remove(), 250); }, ms);
  return el;
}

export const notifyError = (err) => toast(err?.message || 'Algo deu errado', 'err', 5200);

/**
 * Abre um modal. `render` recebe o elemento do corpo; `actions` define o rodapé.
 * Retorna uma promise resolvida com o valor passado a `close(valor)`.
 */
export function modal({ title, body, actions = [], wide = false, onOpen }) {
  return new Promise((resolve) => {
    const scrim = document.createElement('div');
    scrim.className = 'modal-scrim';
    scrim.innerHTML = `
      <div class="modal${wide ? ' wide' : ''}" role="dialog" aria-modal="true">
        <header><h3>${esc(title)}</h3><button class="icon-btn" data-close aria-label="Fechar">✕</button></header>
        <div class="body"></div>
        ${actions.length ? '<footer></footer>' : ''}
      </div>`;
    const bodyEl = scrim.querySelector('.body');
    if (typeof body === 'string') bodyEl.innerHTML = body;
    else if (body instanceof Node) bodyEl.appendChild(body);

    const close = (value) => { document.removeEventListener('keydown', onKey); scrim.remove(); resolve(value); };
    const onKey = (e) => { if (e.key === 'Escape') close(undefined); };

    const footer = scrim.querySelector('footer');
    for (const action of actions) {
      const button = document.createElement('button');
      button.className = action.className || 'btn-ghost';
      button.textContent = action.label;
      button.onclick = async () => {
        if (!action.onClick) return close(action.value);
        try {
          button.disabled = true;
          const result = await action.onClick({ close, body: bodyEl });
          if (result !== false) close(result === undefined ? action.value : result);
        } catch (err) {
          notifyError(err);
        } finally {
          button.disabled = false;
        }
      };
      footer.appendChild(button);
    }

    scrim.querySelector('[data-close]').onclick = () => close(undefined);
    scrim.addEventListener('mousedown', (e) => { if (e.target === scrim) close(undefined); });
    document.addEventListener('keydown', onKey);
    document.body.appendChild(scrim);
    const focusable = bodyEl.querySelector('input,select,textarea');
    if (focusable) focusable.focus();
    onOpen?.({ body: bodyEl, close });
  });
}

export function confirmDialog(message, { title = 'Confirmar', danger = true, confirmLabel = 'Confirmar' } = {}) {
  return modal({
    title,
    body: `<p>${esc(message)}</p>`,
    actions: [
      { label: 'Cancelar', className: 'btn-ghost', value: false },
      { label: confirmLabel, className: danger ? 'btn-danger' : '', value: true },
    ],
  }).then((v) => v === true);
}

export function promptDialog({ title, label, value = '', placeholder = '', type = 'text', required = true }) {
  const wrapper = document.createElement('div');
  wrapper.innerHTML = `<div class="field"><label>${esc(label)}</label>
    <input type="${type}" id="prompt-input" value="${esc(value)}" placeholder="${esc(placeholder)}"></div>`;
  return modal({
    title,
    body: wrapper,
    actions: [
      { label: 'Cancelar', className: 'btn-ghost', value: null },
      {
        label: 'Confirmar',
        onClick: ({ body }) => {
          const input = body.querySelector('#prompt-input');
          if (required && !input.value.trim()) { input.focus(); return false; }
          return input.value.trim();
        },
      },
    ],
  });
}

function printArea() {
  let area = $('#printArea');
  if (!area) {
    area = document.createElement('div');
    area.id = 'printArea';
    document.body.appendChild(area);
  }
  return area;
}

/** Envia texto puro para a impressora térmica via janela de impressão. */
export function printText(text) {
  const area = printArea();
  area.textContent = text;
  window.print();
}

/**
 * Imprime o mesmo texto monoespaçado, mas com um bloco extra (um QR Code, por
 * exemplo) no topo ou no rodapé do cupom.
 */
export function printWithQr(text, qrHtml, { position = 'bottom' } = {}) {
  if (!qrHtml) return printText(text);
  const area = printArea();
  const body = document.createElement('pre');
  body.textContent = text;
  const qr = document.createElement('div');
  qr.className = 'print-qr';
  qr.innerHTML = qrHtml;
  area.innerHTML = '';
  if (position === 'top') { area.appendChild(qr); area.appendChild(body); }
  else { area.appendChild(body); area.appendChild(qr); }
  window.print();
}

export function loading(container, message = 'Carregando...') {
  container.innerHTML = `<div class="loading">${esc(message)}</div>`;
}

export function emptyState(icon, title, hint = '') {
  return `<div class="empty"><span class="big">${icon}</span><b>${esc(title)}</b>${hint ? `<div class="small mt">${esc(hint)}</div>` : ''}</div>`;
}

/** Lê um formulário em objeto, convertendo números e checkboxes. */
export function formData(root) {
  const out = {};
  for (const field of root.querySelectorAll('[name]')) {
    const key = field.name;
    if (field.type === 'checkbox') out[key] = field.checked;
    else if (field.type === 'number') out[key] = field.value === '' ? null : Number(field.value);
    else out[key] = field.value;
  }
  return out;
}
