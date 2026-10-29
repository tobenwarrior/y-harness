const http = require('http');
const PORT = process.env.PORT || 4511;

const server = http.createServer((req, res) => {
  const url = new URL(req.url || '', 'http://localhost');
  if (req.method === 'POST' && url.pathname === '/v1/images/generations') {
    res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '3' });
    return res.end(JSON.stringify({ error: { message: 'stand-in rate limit' } }));
  }
  res.writeHead(501, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Endpoint not modeled by avatar rate-limit stand-in' }));
});

server.listen(PORT);
