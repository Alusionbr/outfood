/**
 * Hub de eventos em tempo real (Server-Sent Events).
 * Todo mutação relevante publica um evento; o painel, a cozinha e o app do
 * entregador se atualizam sozinhos, sem polling.
 */
const clients = new Set();
let nextId = 1;

export function addClient(res, user) {
  const client = { id: nextId++, res, user, alive: true };
  clients.add(client);
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(`retry: 3000\n\n`);
  write(client, 'hello', { userId: user?.id ?? null, at: new Date().toISOString() });
  return client;
}

export function removeClient(client) {
  clients.delete(client);
  try { client.res.end(); } catch { /* já fechado */ }
}

function write(client, event, data) {
  try {
    client.res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  } catch {
    clients.delete(client);
  }
}

/** Publica um evento para todos os painéis conectados. */
export function publish(event, data = {}) {
  const payload = { ...data, at: new Date().toISOString() };
  for (const client of clients) write(client, event, payload);
  return payload;
}

export function heartbeat() {
  for (const client of clients) {
    try { client.res.write(': ping\n\n'); } catch { clients.delete(client); }
  }
}

export function clientCount() {
  return clients.size;
}

export function closeAll() {
  for (const client of clients) removeClient(client);
}
