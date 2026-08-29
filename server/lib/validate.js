import { badRequest } from './http.js';

export const isBlank = (v) => v === undefined || v === null || String(v).trim() === '';

export function str(value, field, { required = false, max = 500, min = 0, def = null } = {}) {
  if (isBlank(value)) {
    if (required) throw badRequest(`Campo obrigatório: ${field}`);
    return def;
  }
  const v = String(value).trim();
  if (v.length > max) throw badRequest(`${field} deve ter no máximo ${max} caracteres`);
  if (v.length < min) throw badRequest(`${field} deve ter ao menos ${min} caracteres`);
  return v;
}

export function num(value, field, { required = false, min = -Infinity, max = Infinity, def = null } = {}) {
  if (isBlank(value)) {
    if (required) throw badRequest(`Campo obrigatório: ${field}`);
    return def;
  }
  const v = Number(String(value).replace(',', '.'));
  if (!Number.isFinite(v)) throw badRequest(`${field} deve ser numérico`);
  if (v < min) throw badRequest(`${field} deve ser maior ou igual a ${min}`);
  if (v > max) throw badRequest(`${field} deve ser menor ou igual a ${max}`);
  return v;
}

export function int(value, field, opts = {}) {
  const v = num(value, field, opts);
  return v === null ? null : Math.round(v);
}

export function bool(value, def = false) {
  if (value === undefined || value === null || value === '') return def;
  if (typeof value === 'boolean') return value;
  return ['1', 'true', 'sim', 'yes', 'on'].includes(String(value).toLowerCase());
}

export function oneOf(value, field, options, { required = false, def = null } = {}) {
  if (isBlank(value)) {
    if (required) throw badRequest(`Campo obrigatório: ${field}`);
    return def;
  }
  const v = String(value).trim();
  if (!options.includes(v)) {
    throw badRequest(`${field} deve ser um destes valores: ${options.join(', ')}`);
  }
  return v;
}

export function email(value, field, opts = {}) {
  const v = str(value, field, opts);
  if (v && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v)) throw badRequest(`${field} inválido`);
  return v ? v.toLowerCase() : v;
}

/** Normaliza telefone brasileiro para apenas dígitos (com DDD). */
export function phone(value, field, { required = false } = {}) {
  if (isBlank(value)) {
    if (required) throw badRequest(`Campo obrigatório: ${field}`);
    return null;
  }
  const digits = String(value).replace(/\D/g, '');
  if (digits.length < 8 || digits.length > 13) throw badRequest(`${field} inválido (use DDD + número)`);
  return digits;
}

export function formatPhone(digits) {
  if (!digits) return '';
  const d = String(digits).replace(/\D/g, '');
  if (d.length === 11) return `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`;
  if (d.length === 10) return `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}`;
  return d;
}

export function list(value, field) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw badRequest(`${field} deve ser uma lista`);
  return value;
}
