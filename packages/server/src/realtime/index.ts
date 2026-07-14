import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { config } from '../config.js';

interface ChangeEvent {
  schema: string;
  table: string;
  type: 'INSERT' | 'UPDATE' | 'DELETE';
  record: any;
  old: any;
  ts: number;
}

// One WebSocket connection's subscription state.
interface Subscriber {
  send: (data: string) => void;
  // table name -> set of event types ('*' means all)
  subs: Map<string, Set<string>>;
}

const subscribers = new Set<Subscriber>();

/** Start the dedicated LISTEN connection that receives NOTIFY payloads from Postgres. */
async function startListener(app: FastifyInstance) {
  const client = new pg.Client({ connectionString: config.databaseUrl });
  await client.connect();
  await client.query('LISTEN kobedb_realtime');
  app.log.info('realtime: listening on channel kobedb_realtime');

  client.on('notification', (msg) => {
    if (!msg.payload) return;
    let event: ChangeEvent;
    try {
      event = JSON.parse(msg.payload);
    } catch {
      return;
    }
    const frame = JSON.stringify({ event: 'change', payload: event });
    for (const sub of subscribers) {
      const types = sub.subs.get(event.table) ?? sub.subs.get('*');
      if (types && (types.has('*') || types.has(event.type))) {
        try {
          sub.send(frame);
        } catch {
          /* client gone; cleaned up on close */
        }
      }
    }
  });

  client.on('error', (err) => {
    app.log.error({ err }, 'realtime listener error; reconnecting in 2s');
    setTimeout(() => startListener(app).catch(() => {}), 2000);
  });
}

export async function realtimePlugin(app: FastifyInstance) {
  await startListener(app);

  // WebSocket endpoint. Clients send JSON control frames:
  //   { "action": "subscribe",   "table": "todos", "events": ["INSERT","UPDATE"] }
  //   { "action": "unsubscribe", "table": "todos" }
  // and receive: { "event": "change", "payload": { ... } }
  app.get('/realtime/v1', { websocket: true }, (socket /* WebSocket */) => {
    const sub: Subscriber = {
      send: (data) => socket.send(data),
      subs: new Map(),
    };
    subscribers.add(sub);
    socket.send(JSON.stringify({ event: 'connected', payload: { ts: Date.now() } }));

    socket.on('message', (raw: Buffer) => {
      let msg: any;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return socket.send(JSON.stringify({ event: 'error', payload: 'invalid JSON' }));
      }
      if (msg.action === 'subscribe') {
        const table = String(msg.table ?? '*');
        const events: string[] = Array.isArray(msg.events) && msg.events.length ? msg.events : ['*'];
        sub.subs.set(table, new Set(events));
        socket.send(JSON.stringify({ event: 'subscribed', payload: { table, events } }));
      } else if (msg.action === 'unsubscribe') {
        sub.subs.delete(String(msg.table ?? '*'));
        socket.send(JSON.stringify({ event: 'unsubscribed', payload: { table: msg.table } }));
      } else if (msg.action === 'ping') {
        socket.send(JSON.stringify({ event: 'pong', payload: { ts: Date.now() } }));
      }
    });

    socket.on('close', () => {
      subscribers.delete(sub);
    });
  });
}
