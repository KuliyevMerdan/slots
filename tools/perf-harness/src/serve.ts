import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';

/**
 * A static server for the built client — the smallest one that can honestly serve `dist/`.
 *
 * In the harness rather than `vite preview` because the harness measures the game, not Vite: a
 * dependency-free file server has no middleware, no transforms and nothing to explain when a
 * number looks odd. Ephemeral port, so the harness never fights a dev server for 5173.
 */

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
};

export interface StaticServer {
  url: string;
  close(): Promise<void>;
}

export function serveDist(root: string): Promise<StaticServer> {
  const server = createServer((request, reply) => {
    void (async () => {
      const path = (request.url ?? '/').split('?')[0] ?? '/';
      const relative = path === '/' ? 'index.html' : path.slice(1);
      const resolved = normalize(join(root, relative));
      // Stay inside dist — a file server that follows `..` is a file server serving the disk.
      if (!resolved.startsWith(normalize(root) + sep) && resolved !== normalize(root)) {
        reply.writeHead(403).end();
        return;
      }

      try {
        const body = await readFile(resolved);
        reply
          .writeHead(200, {
            'content-type': CONTENT_TYPES[extname(resolved)] ?? 'application/octet-stream',
          })
          .end(body);
      } catch {
        reply.writeHead(404).end('not found');
      }
    })();
  });

  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('the static server has no port'));
        return;
      }
      resolve({
        url: `http://127.0.0.1:${String(address.port)}`,
        close: () =>
          new Promise((done, fail) => {
            server.close((error) => {
              if (error) fail(error);
              else done();
            });
          }),
      });
    });
  });
}
