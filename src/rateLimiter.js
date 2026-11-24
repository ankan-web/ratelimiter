export function windowFor(now, windowMs) {
  const start = Math.floor(now.getTime() / windowMs) * windowMs;
  return {
    windowStart: new Date(start),
    resetAt: new Date(start + windowMs)
  };
}

export async function checkAndConsume(collection, uid, { limit, windowMs }, now = new Date()) {
  const { windowStart, resetAt } = windowFor(now, windowMs);

  const doc = await collection.findOneAndUpdate(
    { uid, windowStart },
    [
      {
        $set: {
          allowed: { $lt: [{ $ifNull: ['$count', 0] }, limit] }
        }
      },
      {
        $set: {
          count: {
            $cond: [
              '$allowed',
              { $add: [{ $ifNull: ['$count', 0] }, 1] },
              { $ifNull: ['$count', 0] }
            ]
          }
        }
      },
      {
        $set: {
          expiresAt: resetAt,
          updatedAt: now
        }
      }
    ],
    { upsert: true, returnDocument: 'after' }
  );

  const count = doc.count;
  const allowed = doc.allowed;

  return {
    allowed,
    uid,
    limit,
    count,
    remaining: Math.max(0, limit - count),
    resetAt: resetAt.toISOString(),
    retryAfter: allowed ? null : Math.max(0, Math.ceil((resetAt.getTime() - now.getTime()) / 1000))
  };
}

export function applyRateLimitHeaders(res, decision) {
  res.set('X-RateLimit-Limit', String(decision.limit));
  res.set('X-RateLimit-Remaining', String(decision.remaining));
  res.set('X-RateLimit-Reset', String(Math.floor(Date.parse(decision.resetAt) / 1000)));
  if (decision.retryAfter !== null) {
    res.set('Retry-After', String(decision.retryAfter));
  }
}
