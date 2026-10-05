import http from 'node:http';

export function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(body === undefined ? '' : JSON.stringify(body));
}

export function startServer(handler, port = 0, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const srv = http.createServer(handler);
    srv.listen(port, host, () => {
      const p = srv.address().port;
      resolve({
        srv,
        port: p,
        url: `http://${host}:${p}`,
        close: () => new Promise((r) => { srv.closeAllConnections(); srv.close(r); }),
      });
    });
  });
}

export function readBody(req) {
  return new Promise((resolve) => {
    let d = '';
    req.on('data', (c) => { d += c; });
    req.on('end', () => { try { resolve(d ? JSON.parse(d) : {}); } catch { resolve({}); } });
  });
}
