/** Toda a aritmética financeira do sistema é feita em centavos (inteiros). */

export function toCents(value) {
  if (value === null || value === undefined || value === '') return 0;
  if (typeof value === 'number') return Math.round(value * 100);
  const normalized = String(value).trim().replace(/[R$\s]/g, '').replace(/\.(?=\d{3}\b)/g, '').replace(',', '.');
  const n = Number(normalized);
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
}

export function fromCents(cents) {
  return (Number(cents) || 0) / 100;
}

const BRL = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });

export function formatBRL(cents) {
  return BRL.format(fromCents(cents));
}

export function sumCents(values) {
  return values.reduce((acc, v) => acc + (Number(v) || 0), 0);
}

/** Aplica percentual sobre centavos com arredondamento bancário simples. */
export function percentOf(cents, percent) {
  return Math.round((Number(cents) || 0) * (Number(percent) || 0) / 100);
}
