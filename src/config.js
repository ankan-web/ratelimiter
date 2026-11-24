function positiveInteger(value, fallback, name) {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

export const config = {
  port: positiveInteger(process.env.PORT, 3000, 'PORT'),
  mongoUri: process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017',
  dbName: process.env.MONGODB_DB || 'ratelimiter',
  collectionName: process.env.MONGODB_COLLECTION || 'rate_limit_counters',
  limit: positiveInteger(process.env.RATE_LIMIT, 10, 'RATE_LIMIT'),
  windowMs: positiveInteger(process.env.WINDOW_MS, 60_000, 'WINDOW_MS')
};
