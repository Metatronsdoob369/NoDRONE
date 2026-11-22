import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { handleApiRequest } from './server/apiRouter.js';
import { attachCopilotLiveWebSocket } from './server/copilotLive.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PORT = 3000;
const DIST_DIR = path.join(__dirname, 'dist');

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.mjs': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

const server = http.createServer(async (req, res) => {
  const url = req.url || '/';

  // Delegate API requests
  if (url.startsWith('/api/')) {
    try {
      const handled = await handleApiRequest(req, res);
      if (handled) return;
    } catch (err) {
      console.error('API Error:', err);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Internal Server Error' }));
      return;
    }
  }

  // Serve static files from dist
  let filePath = path.join(DIST_DIR, url.split('?')[0]);
  if (filePath.endsWith(path.sep) || !path.extname(filePath)) {
    if (fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) {
      filePath = path.join(filePath, 'index.html');
    } else {
      filePath = path.join(DIST_DIR, 'index.html');
    }
  }

  fs.stat(filePath, (err, stats) => {
    if (err || !stats.isFile()) {
      // Fallback to index.html for SPA routing
      const indexPath = path.join(DIST_DIR, 'index.html');
      if (fs.existsSync(indexPath)) {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        fs.createReadStream(indexPath).pipe(res);
      } else {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not Found');
      }
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': contentType });
    fs.createReadStream(filePath).pipe(res);
  });
});

attachCopilotLiveWebSocket(server);

server.listen(PORT, '0.0.0.0', () => {
  console.log(`NoDRONE Full-Stack Server listening on http://0.0.0.0:${PORT}`);
});
