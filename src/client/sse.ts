type Handler = (data: any) => void;
const handlers = new Map<string, Handler[]>();
let source: EventSource | null = null;
let bound = new Set<string>();

export function onLive(event: string, cb: Handler): void {
  if (!handlers.has(event)) handlers.set(event, []);
  handlers.get(event)!.push(cb);
  connect();
  bind(event);
}

function bind(event: string): void {
  if (!source || bound.has(event)) return;
  bound.add(event);
  source.addEventListener(event, (e) => {
    let data: any = {};
    try { data = JSON.parse((e as MessageEvent).data); } catch { /* noop */ }
    for (const cb of handlers.get(event) || []) cb(data);
  });
}

function connect(): void {
  if (source) return;
  source = new EventSource('/api/stream');
  bound = new Set();
  for (const ev of handlers.keys()) bind(ev);
  source.onerror = () => {
    source?.close();
    source = null;
    setTimeout(connect, 4000);
  };
}
