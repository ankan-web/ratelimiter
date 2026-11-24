import { MongoClient } from 'mongodb';
import { config } from './config.js';

let client;
let db;
let collection;

export async function connectMongo(uri = config.mongoUri, dbName = config.dbName) {
  if (collection) return collection;

  client = new MongoClient(uri, { serverSelectionTimeoutMS: 3000 });
  await client.connect();
  db = client.db(dbName);
  collection = db.collection(config.collectionName);

  await collection.createIndex({ uid: 1, windowStart: 1 }, { unique: true });
  await collection.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });

  return collection;
}

export function getCollection() {
  return collection;
}

export function getDb() {
  return db;
}

export async function pingMongo() {
  await db.command({ ping: 1 });
}

export async function closeMongo() {
  if (client) await client.close();
  client = undefined;
  db = undefined;
  collection = undefined;
}
