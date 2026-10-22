import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import rateLimit from 'express-rate-limit';
import { config, iceServers } from './config';
import { requireAuth, type AuthedRequest } from './middleware/auth';
import { errorMiddleware, notFound } from './middleware/error';
import { authRouter } from './routes/auth';
import { usersRouter } from './routes/users';
import { conversationsRouter } from './routes/conversations';
import { callsRouter } from './routes/calls';
import { livekitRouter } from './routes/calls';
import { devicesRouter } from './routes/devices';
import { filesRouter } from './routes/files';

export function createApp(): express.Express {
  const app = express();
  app.set('trust proxy', 1); // behind Caddy/nginx on the VPS — needed for rate-limit IPs
  app.use(helmet());
  app.use(
    cors({
      origin(origin, cb) {
        // Native Android clients send no Origin; browsers are allow-list only.
        if (!origin || config.corsOrigins.includes(origin) || config.corsOrigins.includes('*')) cb(null, true);
        else cb(null, false);
      },
      credentials: true,
    }),
  );
  app.use(express.json({ limit: '1mb' }));
  app.use(morgan(config.nodeEnv === 'production' ? 'combined' : 'dev'));
  app.use(
    rateLimit({
      windowMs: 60 * 1000,
      limit: 300,
      standardHeaders: 'draft-7',
      legacyHeaders: false,
      message: { error: 'Too many requests' },
    }),
  );

  app.get('/health', (_req, res) => res.json({ ok: true, service: 'malik-team-connect-backend' }));

  app.use('/api/auth', authRouter());
  // Registration is disabled everywhere, not just under /auth.
  app.all('/api/register', (_req, res) => res.status(404).json({ error: 'Registration is disabled. This is a private team app.' }));
  app.use('/api/users', usersRouter());
  app.use('/api/conversations', conversationsRouter());
  app.use('/api/calls', callsRouter());
  app.use('/api/livekit', livekitRouter());
  app.use('/api/devices', devicesRouter());
  app.use('/api', filesRouter()); // POST /api/upload, GET /api/files/:name

  // Alias from the original spec: GET /api/config/calls
  app.get('/api/config/calls', requireAuth, (_req: AuthedRequest, res) => {
    res.json({ iceServers: iceServers(), ice_servers: iceServers(), livekitUrl: config.livekit.url || null });
  });

  app.use(notFound);
  app.use(errorMiddleware);
  return app;
}
