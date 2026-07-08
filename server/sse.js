const clients = new Map(); // res -> employeeId

export function sseHandler(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(':connected\n\n');
  clients.set(res, req.user.id);
  const ping = setInterval(() => res.write(':ping\n\n'), 25_000);
  req.on('close', () => { clearInterval(ping); clients.delete(res); });
}

export function broadcast(event, data, onlyEmployeeId = null) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const [res, empId] of clients) {
    if (onlyEmployeeId && empId !== onlyEmployeeId) continue;
    try { res.write(payload); } catch { clients.delete(res); }
  }
}

/** يرسل الحدث لمجموعة موظفين محددة بممر واحد على السجل. */
export function sendToSet(event, data, idSet) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const [res, empId] of clients) {
    if (!idSet.has(empId)) continue;
    try { res.write(payload); } catch { clients.delete(res); }
  }
}

/** Ends every open stream so the HTTP server can close during graceful shutdown. */
export function closeAllStreams() {
  for (const [res] of clients) {
    try { res.end(); } catch { /* already gone */ }
  }
  clients.clear();
}
