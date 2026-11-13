// Tiny static server for the screenshot pages: serves the repo, and injects a stub of the `browser` API into every HTML
// page so the real extension pages and content script run outside Firefox. Usage: node tools/screenshots/serve.mjs [port]
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(fileURLToPath(import.meta.url), '..', '..', '..');
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml' };
createServer(async (req, res) => {
  const path = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^(\.\.[/\\])+/, '');
  try {
    let body = await readFile(join(root, path === '/' ? 'index.html' : path));
    if (extname(path) === '.html') body = Buffer.from(body.toString().replace('<head>', '<head><script src="/tools/screenshots/stub.js"></script>'));
    res.writeHead(200, { 'content-type': types[extname(path)] || 'application/octet-stream' }).end(body);
  } catch { res.writeHead(404).end('not found'); }
}).listen(Number(process.argv[2]) || 8099, '127.0.0.1');
