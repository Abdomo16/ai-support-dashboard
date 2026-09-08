import { createReadStream, existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize } from 'node:path';

const root = process.cwd();
const environment = Object.fromEntries(
  readFileSync(join(root, '.env'), 'utf8')
    .split(/\r?\n/)
    .filter((line) => line && !line.trimStart().startsWith('#'))
    .map((line) => {
      const index = line.indexOf('=');
      return [line.slice(0, index).trim(), line.slice(index + 1).trim()];
    }),
);

const mimeTypes = { '.css': 'text/css', '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.svg': 'image/svg+xml' };
const server = createServer((request, response) => {
  const requestPath = new URL(request.url, 'http://localhost').pathname;
  if (requestPath === '/runtime-config.js') {
    const config = { url: environment.VITE_SUPABASE_URL, publishableKey: environment.VITE_SUPABASE_PUBLISHABLE_KEY };
    response.writeHead(200, { 'Content-Type': 'text/javascript', 'Cache-Control': 'no-store' });
    response.end(`export const supabaseConfig = ${JSON.stringify(config)};`);
    return;
  }
  const relativePath = requestPath === '/' ? 'index.html' : requestPath.replace(/^\/+/, '');
  const filePath = normalize(join(root, relativePath));
  if (!filePath.startsWith(root) || !existsSync(filePath)) { response.writeHead(404); response.end('Not found'); return; }
  response.writeHead(200, { 'Content-Type': mimeTypes[extname(filePath)] || 'application/octet-stream' });
  createReadStream(filePath).pipe(response);
});

server.listen(4173, '127.0.0.1', () => console.log('Autexa running at http://127.0.0.1:4173'));
