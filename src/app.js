import express from 'express';
import { pingMongo } from './db.js';
import { applyRateLimitHeaders, checkAndConsume } from './rateLimiter.js';

function validUid(uid) {
  return typeof uid === 'string' && uid.trim().length > 0 && uid.trim().length <= 128;
}

export function createApp(collection, options) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json());

  app.get('/health', async (_req, res, next) => {
    try {
      await pingMongo();
      res.json({ status: 'ok', mongo: 'connected' });
    } catch (error) {
      next(error);
    }
  });

  app.post('/v1/rate-limit/check', async (req, res, next) => {
    const uid = req.body?.uid;
    if (!validUid(uid)) {
      res.status(400).json({ error: 'uid must be a non-empty string of at most 128 characters' });
      return;
    }

    try {
      const decision = await checkAndConsume(collection, uid.trim(), options);
      applyRateLimitHeaders(res, decision);
      res.status(decision.allowed ? 200 : 429).json(decision);
    } catch (error) {
      next(error);
    }
  });

  app.get('/v1/demo', async (req, res, next) => {
    const uid = req.get('X-User-Id');
    if (!validUid(uid)) {
      res.status(400).json({ error: 'X-User-Id header must be a non-empty string of at most 128 characters' });
      return;
    }

    try {
      const decision = await checkAndConsume(collection, uid.trim(), options);
      applyRateLimitHeaders(res, decision);
      if (!decision.allowed) {
        res.status(429).json(decision);
        return;
      }
      res.json({ message: 'ok', rateLimit: decision });
    } catch (error) {
      next(error);
    }
  });

  app.use((error, _req, res, _next) => {
    if (error?.type === 'entity.parse.failed') {
      res.status(400).json({ error: 'Malformed JSON body' });
      return;
    }
    console.error(error);
    res.status(503).json({ error: 'Rate limiter storage unavailable' });
  });

  return app;
}
