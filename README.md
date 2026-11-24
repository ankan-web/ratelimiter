# Rate Limiter API

A small Express API that limits how many requests a user (`uid`) may make in a fixed time window. Counters are stored in MongoDB as key-value style documents.

## How it works

1. On startup the server connects to MongoDB and creates a unique index on `(uid, windowStart)` and a TTL index on `expiresAt` (`src/db.js`).
2. Each request supplies a `uid`. The current window is aligned to the clock: `windowStart = floor(now / WINDOW_MS) * WINDOW_MS`.
3. A single atomic `findOneAndUpdate` with an aggregation pipeline (`src/rateLimiter.js`):
   - sets `allowed = stored count < limit`;
   - increments `count` only when allowed;
   - writes `expiresAt = windowStart + WINDOW_MS` and `updatedAt`;
   - upserts a document on the first request of a window.
4. MongoDB serializes updates to the same document, so concurrent requests cannot push the count above the limit.
5. Allowed requests get `200`; blocked requests get `429` with `Retry-After`. Every decision includes `X-RateLimit-Limit`, `X-RateLimit-Remaining` and `X-RateLimit-Reset` headers.
6. When the next window begins, a new `(uid, windowStart)` key is used and the count starts at 1. Old documents are removed by the TTL index.

## Data model

Collection `rate_limit_counters`, one document per user per window:

| Field | Meaning |
| --- | --- |
| `uid` | User identifier (key) |
| `windowStart` | Start of the fixed window (key) |
| `count` | Requests consumed in this window |
| `expiresAt` | Window end; TTL index deletes expired docs |
| `updatedAt` | Time of the last decision |
| `allowed` | Internal flag from the last decision |

Indexes: unique `{ uid: 1, windowStart: 1 }` for O(1) keyed upserts, and `{ expiresAt: 1 }` with `expireAfterSeconds: 0` for cleanup.

## Requirements

- Node.js 18 or newer (ES modules and top-level `await`)
- MongoDB 4.2 or newer (aggregation-pipeline updates)
- npm

## Quick start (default localhost settings)

Defaults: `mongodb://127.0.0.1:27017`, database `ratelimiter`, collection `rate_limit_counters`, port `3000`, 10 requests per 60-second window.

Make sure MongoDB is running locally:

```bash
mongosh --quiet --eval 'db.runCommand({ping:1}).ok'
```

If it is not, start one:

```bash
mkdir -p ~/.ratelimiter-mongo
mongod --dbpath ~/.ratelimiter-mongo --bind_ip 127.0.0.1 --port 27017
```

Then start the API:

```bash
cd /home/ankan/ratelimiter
npm install
npm start
```

Expected output: `Rate limiter listening on http://localhost:3000`.

## Configuration

All settings are optional environment variables:

| Variable | Default | Description |
| --- | --- | --- |
| `PORT` | `3000` | HTTP port |
| `MONGODB_URI` | `mongodb://127.0.0.1:27017` | MongoDB connection string |
| `MONGODB_DB` | `ratelimiter` | Database name |
| `MONGODB_COLLECTION` | `rate_limit_counters` | Collection name |
| `RATE_LIMIT` | `10` | Maximum requests per window |
| `WINDOW_MS` | `60000` | Window length in milliseconds |

Example with a smaller limit for experiments:

```bash
RATE_LIMIT=3 WINDOW_MS=10000 npm start
```

## API

The machine-readable contract is in `openapi.yaml`.

### `GET /health`

```json
{ "status": "ok", "mongo": "connected" }
```

Returns `503` with `{ "error": "Rate limiter storage unavailable" }` if MongoDB is unreachable.

### `POST /v1/rate-limit/check`

Request:

```json
{ "uid": "User101" }
```

Response (`200` when allowed, `429` when blocked):

```json
{
  "allowed": true,
  "uid": "User101",
  "limit": 10,
  "count": 1,
  "remaining": 9,
  "resetAt": "2026-11-24T14:32:00.000Z",
  "retryAfter": null
}
```

On `429`, `count` stays at the limit and `retryAfter` is the number of seconds until reset. An empty or non-string `uid` returns `400`; malformed JSON returns `400`.

### `GET /v1/demo`

Same limit enforcement via middleware, with the user taken from the `X-User-Id` header.

```bash
curl -i -H 'X-User-Id: User101' http://localhost:3000/v1/demo
```

Success returns `{ "message": "ok", "rateLimit": { ... } }`; a missing header returns `400`; an exhausted allowance returns `429`.

## Manual verification

With the default settings and the server running:

```bash
curl -i http://localhost:3000/health

for i in $(seq 1 11); do
  curl -s -w ' status=%{http_code}\n' -X POST http://localhost:3000/v1/rate-limit/check \
    -H 'Content-Type: application/json' -d '{"uid":"User101"}'
done
```

The first ten calls return `200` with `count` 1 through 10; the eleventh returns `429` with `count: 10`, `remaining: 0` and a `Retry-After` header of roughly 60 seconds.

Inspect what was stored:

```bash
mongosh mongodb://127.0.0.1:27017/ratelimiter \
  --eval 'db.rate_limit_counters.find({uid:"User101"}).forEach(printjson)'

mongosh mongodb://127.0.0.1:27017/ratelimiter \
  --eval 'db.rate_limit_counters.getIndexes()'
```

Then check that `User102` starts at `count: 1`, and that after the window resets `User101` is allowed again with `count: 1`. A burst check is also useful:

```bash
seq 1 20 | xargs -P20 -I{} curl -s -o /dev/null -w '%{http_code}\n' \
  -X POST http://localhost:3000/v1/rate-limit/check \
  -H 'Content-Type: application/json' -d '{"uid":"Burst"}' | sort | uniq -c
```

With the default limit this produces `10` responses of `200` and `10` of `429` (as long as the burst does not cross a window boundary).

## Tests

```bash
npm test
```

`test/rateLimiter.test.js` starts its own temporary `mongod` on port 27991, so it does not need or modify your local MongoDB instance. It covers the limit, per-user isolation, window reset, concurrent requests, middleware, input validation and health endpoint.

## Notes and tradeoffs

- Fixed windows are simple and O(1), but a caller can send the limit at the end of one window and again at the start of the next. A sliding-window or token-bucket algorithm avoids that burst at the cost of more state and computation.
- TTL deletion is performed by MongoDB's background monitor (roughly every 60 seconds), so expired documents can linger briefly. They never affect decisions because each window has its own key.
- The `allowed` field is internal decision state and is not part of the public response beyond the `allowed` field in the returned decision.
