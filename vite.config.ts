import path from 'path';
import { defineConfig, loadEnv } from 'vite';
import tailwindcss from '@tailwindcss/vite';
import { handleApiRequest } from './server/apiRouter';
import { attachCopilotLiveWebSocket } from './server/copilotLive';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, '.', '');
  const serverEnvKeys = [
    'NOUS_API_KEY',
    'NOUS_BASE_URL',
    'NOUS_MODEL',
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_MODEL',
    'COPILOT_PROVIDER',
    'GEMINI_API_KEY',
    'API_KEY',
    'OPENWEATHERMAP_API_KEY',
  ];
  for (const key of serverEnvKeys) {
    if (!process.env[key] && env[key]) {
      process.env[key] = env[key];
    }
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
