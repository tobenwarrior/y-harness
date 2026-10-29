const http = require('http');
const PORT = process.env.PORT || 4512;

const server = http.createServer((req, res) => {
  const url = new URL(req.url || '', 'http://localhost');
  if (req.method === 'POST' && url.pathname === '/v1/images/generations') {
    return setTimeout(() => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: [{ b64_json: 'AQIDBA==' }] }));
    }, 1500);
  }
  res.writeHead(501, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Endpoint not modeled by avatar timeout stand-in' }));
});

server.listen(PORT);
