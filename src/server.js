import { createApp } from './app.js';
import { config } from './config.js';
import { closeMongo, connectMongo, getCollection } from './db.js';

const collection = await connectMongo();
const app = createApp(collection, { limit: config.limit, windowMs: config.windowMs });

const server = app.listen(config.port, () => {
  console.log(`Rate limiter listening on http://localhost:${config.port}`);
});

async function shutdown() {
  server.close();
  await closeMongo();
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
