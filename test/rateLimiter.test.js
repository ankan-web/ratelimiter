import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { MongoClient } from 'mongodb';
import { createApp } from '../src/app.js';
import { closeMongo, connectMongo, getCollection } from '../src/db.js';

const dbPath = mkdtempSync(join(tmpdir(), 'ratelimiter-mongo-'));
const mongoPort = 27991;
const mongoUri = `mongodb://127.0.0.1:${mongoPort}`;
const dbName = 'ratelimiter_test';

let mongod;
let client;
let collection;
let server;
let baseUrl;

async function listen(app) {
  return new Promise((resolve) => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
}

function url(path) {
  return `${baseUrl}${path}`;
}

async function check(uid) {
  const response = await fetch(url('/v1/rate-limit/check'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ uid })
  });
  return { response, body: await response.json() };
}

before(async () => {
  mongod = spawn('mongod', [
    '--dbpath', dbPath,
    '--port', String(mongoPort),
    '--bind_ip', '127.0.0.1',
    '--quiet'
  ], { stdio: 'ignore' });

  let connected = false;
  for (let attempt = 0; attempt < 60 && !connected; attempt += 1) {
    try {
      client = new MongoClient(mongoUri, { serverSelectionTimeoutMS: 250 });
      await client.connect();
      await client.db('admin').command({ ping: 1 });
      connected = true;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  assert.ok(connected, 'mongod did not start');

  await client.db(dbName).dropDatabase();
  await connectMongo(mongoUri, dbName);
  collection = getCollection();
  server = await listen(createApp(collection, { limit: 3, windowMs: 60_000 }));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  await closeMongo();
  if (client) await client.close();
  if (mongod) mongod.kill('SIGTERM');
  rmSync(dbPath, { recursive: true, force: true });
});

test('allows up to the limit, then blocks without incrementing', async () => {
  for (let expected = 1; expected <= 3; expected += 1) {
    const { response, body } = await check('User101');
    assert.equal(response.status, 200);
    assert.equal(body.allowed, true);
    assert.equal(body.count, expected);
    assert.equal(body.remaining, 3 - expected);
    assert.equal(body.retryAfter, null);
  }

  const denied = await check('User101');
  assert.equal(denied.response.status, 429);
  assert.equal(denied.body.allowed, false);
  assert.equal(denied.body.count, 3);
  assert.equal(denied.body.remaining, 0);
  assert.ok(denied.response.headers.get('retry-after'));
  assert.equal(denied.response.headers.get('x-ratelimit-limit'), '3');
  assert.equal(denied.response.headers.get('x-ratelimit-remaining'), '0');

  const stillDenied = await check('User101');
  assert.equal(stillDenied.body.count, 3);
});

test('stores uid, count and time metadata as a keyed document', async () => {
  const doc = await collection.findOne({ uid: 'User101' });
  assert.ok(doc);
  assert.equal(doc.count, 3);
  assert.ok(doc.windowStart instanceof Date);
  assert.ok(doc.expiresAt instanceof Date);
  assert.equal(doc.expiresAt.getTime() - doc.windowStart.getTime(), 60_000);

  const indexes = await collection.indexes();
  assert.ok(indexes.some((index) => index.unique && index.key.uid === 1 && index.key.windowStart === 1));
  assert.ok(indexes.some((index) => index.expireAfterSeconds === 0 && index.key.expiresAt === 1));
});

test('keeps separate counters per uid', async () => {
  const { response, body } = await check('User102');
  assert.equal(response.status, 200);
  assert.equal(body.uid, 'User102');
  assert.equal(body.count, 1);
});

test('resets the counter when the window expires', async () => {
  const shortApp = createApp(collection, { limit: 2, windowMs: 120 });
  const shortServer = await listen(shortApp);
  const shortUrl = `http://127.0.0.1:${shortServer.address().port}/v1/rate-limit/check`;
  const request = () => fetch(shortUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ uid: 'User103' })
  }).then((response) => response.json());

  assert.equal((await request()).count, 1);
  assert.equal((await request()).count, 2);
  assert.equal((await request()).allowed, false);

  await new Promise((resolve) => setTimeout(resolve, 150));
  const afterReset = await request();
  assert.equal(afterReset.allowed, true);
  assert.equal(afterReset.count, 1);
  await new Promise((resolve) => shortServer.close(resolve));
});

test('enforces the limit under concurrent requests', async () => {
  const responses = await Promise.all(Array.from({ length: 12 }, () => check('User104')));
  assert.equal(responses.filter(({ response }) => response.status === 200).length, 3);
  assert.equal(responses.filter(({ response }) => response.status === 429).length, 9);
  assert.equal((await collection.findOne({ uid: 'User104' })).count, 3);
});

test('protects the demo route with middleware', async () => {
  for (let expected = 1; expected <= 3; expected += 1) {
    const response = await fetch(url('/v1/demo'), { headers: { 'X-User-Id': 'User105' } });
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.message, 'ok');
    assert.equal(body.rateLimit.count, expected);
  }
  const denied = await fetch(url('/v1/demo'), { headers: { 'X-User-Id': 'User105' } });
  assert.equal(denied.status, 429);

  const missing = await fetch(url('/v1/demo'));
  assert.equal(missing.status, 400);
});

test('rejects invalid input and reports health', async () => {
  const invalid = await fetch(url('/v1/rate-limit/check'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ uid: '' })
  });
  assert.equal(invalid.status, 400);

  const health = await fetch(url('/health'));
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { status: 'ok', mongo: 'connected' });
});
