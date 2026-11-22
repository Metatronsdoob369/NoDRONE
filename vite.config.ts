import path from 'path';
import { defineConfig, loadEnv } from 'vite';
import tailwindcss from '@tailwindcss/vite';
import { handleApiRequest } from './server/apiRouter';
import { attachCopilotLiveWebSocket } from './server/copilotLive';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, '.', '');
  if (env.GEMINI_API_KEY) {
    process.env.GEMINI_API_KEY = env.GEMINI_API_KEY;
  }
  if (env.API_KEY) {
    process.env.API_KEY = env.API_KEY;
  }
  if (env.OPENWEATHERMAP_API_KEY) {
    process.env.OPENWEATHERMAP_API_KEY = env.OPENWEATHERMAP_API_KEY;
  }

  return {
    server: {
      port: 3000,
      host: '0.0.0.0',
    },
    plugins: [
      tailwindcss(),
      {
        name: 'nodrone-api-middleware',
        configureServer(server) {
          attachCopilotLiveWebSocket(server.httpServer as any);
          server.middlewares.use(async (req, res, next) => {
            if (req.url && req.url.startsWith('/api/')) {
              try {
                const handled = await handleApiRequest(req, res);
                if (handled) return;
              } catch (err) {
                console.error('API middleware error:', err);
              }
            }
            next();
          });
        },
        configurePreviewServer(server) {
          attachCopilotLiveWebSocket(server.httpServer as any);
          server.middlewares.use(async (req, res, next) => {
            if (req.url && req.url.startsWith('/api/')) {
              try {
                const handled = await handleApiRequest(req, res);
                if (handled) return;
              } catch (err) {
                console.error('Preview API middleware error:', err);
              }
            }
            next();
          });
        },
      },
    ],
    define: {
      'process.env.NODE_ENV': JSON.stringify(mode),
    },
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
  };
});
