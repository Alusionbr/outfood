/** Cliente HTTP do painel: sempre JSON, sempre com cookie de sessão. */

class ApiError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

async function request(method, path, body) {
  const options = { method, credentials: 'same-origin', headers: {} };
  if (body !== undefined) {
    options.headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(body);
  }
  const response = await fetch(path, options);
  if (response.status === 204) return null;
  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
  if (!response.ok) {
    throw new ApiError(response.status, data?.error || `Falha na requisição (${response.status})`, data?.details);
  }
  return data;
}

export const api = {
  get: (path) => request('GET', path),
  post: (path, body) => request('POST', path, body ?? {}),
  patch: (path, body) => request('PATCH', path, body ?? {}),
  put: (path, body) => request('PUT', path, body ?? {}),
  del: (path) => request('DELETE', path),

  // Atalhos de domínio, para as views não montarem URLs à mão.
  me: () => request('GET', '/api/auth/me'),
  login: (email, password) => request('POST', '/api/auth/login', { email, password }),
  logout: () => request('POST', '/api/auth/logout', {}),
  settings: () => request('GET', '/api/settings'),
  saveSettings: (patch) => request('PUT', '/api/settings', patch),
  menu: () => request('GET', '/api/menu'),
  orders: (query = '') => request('GET', `/api/orders${query ? '?' + query : ''}`),
  order: (id) => request('GET', `/api/orders/${id}`),
  createOrder: (body) => request('POST', '/api/orders', body),
  updateOrder: (id, body) => request('PATCH', `/api/orders/${id}`, body),
  setStatus: (id, status, reason) => request('POST', `/api/orders/${id}/status`, { status, reason }),
  pay: (id, body) => request('POST', `/api/orders/${id}/payments`, body),
  kitchen: () => request('GET', '/api/kitchen'),
  dispatchQueue: () => request('GET', '/api/dispatch/queue'),
  autoDispatch: (body) => request('POST', '/api/dispatch/auto', body),
  routes: (query = '') => request('GET', `/api/routes${query ? '?' + query : ''}`),
  route: (id) => request('GET', `/api/routes/${id}`),
  drivers: () => request('GET', '/api/drivers'),
  zones: () => request('GET', '/api/zones'),
  customers: (query = '') => request('GET', `/api/customers${query ? '?' + query : ''}`),
  dashboard: (day) => request('GET', `/api/reports/dashboard${day ? '?day=' + day : ''}`),
  print: (path) => request('GET', path),
};

export { ApiError };
