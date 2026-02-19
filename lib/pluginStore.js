/***
 * lib/pluginStore.js
 *
 * Gives every plugin its own PHYSICAL table in whichever database backend
 * the bot is running — with zero changes to lightweight_store.js.
 *
 * ─── HOW IT WORKS ────────────────────────────────────────────────────────────
 *
 *  pluginStore opens its own connection to the same database (same env vars),
 *  then creates a dedicated table for each plugin namespace / table name the
 *  first time it is accessed.  lightweight_store.js is never touched.
 *
 *  Table naming convention:
 *    createStore('attendance')          → table  plugin_attendance
 *    db.table('records')                → table  plugin_attendance_records
 *    db.table('settings')               → table  plugin_attendance_settings
 *
 *  Backend mapping:
 *    MONGO_URL    → MongoDB  collection  named  plugin_attendance[_table]
 *    POSTGRES_URL → PostgreSQL table     named  plugin_attendance[_table]
 *    MYSQL_URL    → MySQL table          named  plugin_attendance[_table]
 *    DB_URL       → SQLite table         named  plugin_attendance[_table]
 *    (none)       → ./data/plugin_attendance[_table].json  (one file per table)
 *
 *  Every table has the same minimal schema:
 *    key   TEXT  PRIMARY KEY   — your record key ('user:123', 'config', …)
 *    value TEXT               — JSON-serialised value
 *    ts    INTEGER/BIGINT     — last-write unix timestamp (ms)
 *
 * ─── USAGE ───────────────────────────────────────────────────────────────────
 *
 *  SINGLE TABLE (simple plugins):
 *
 *    const { createStore } = require('../lib/pluginStore');
 *    const db = createStore('myplugin');
 *
 *    await db.set('config', { enabled: true });
 *    const cfg = await db.get('config');         // → { enabled: true }
 *    await db.getAll();                           // → { config: {...}, ... }
 *
 *  MULTIPLE TABLES (mirrors old COLLECTIONS pattern):
 *
 *    const db       = createStore('attendance');
 *    const records  = db.table('records');    // → physical table: plugin_attendance_records
 *    const settings = db.table('settings');   // → physical table: plugin_attendance_settings
 *    const birthday = db.table('birthdays');  // → physical table: plugin_attendance_birthdays
 *
 *    await records.set('user:' + userId, { date, streak });
 *    await settings.getOrDefault('config', defaultSettings);
 *    await birthday.patch('user:' + userId, { dob: '01/01/1990' });
 *
 *  AVAILABLE METHODS (same on root store and every named table):
 *
 *    .get(key)                     → value | null
 *    .set(key, value)              → void
 *    .del(key)                     → void          (hard delete)
 *    .getAll()                     → { key: value, ... }
 *    .has(key)                     → boolean
 *    .getOrDefault(key, fallback)  → value | fallback
 *    .patch(key, partialObject)    → void          (shallow merge)
 *
 *  ROOT STORE ONLY:
 *    .table(tableName)             → isolated store for that physical table
 *
 *  READ-ONLY PROPERTIES:
 *    .namespace   → 'attendance'
 *    .tableName   → 'records' | null
 *    .physicalTable → 'plugin_attendance_records'
 */

'use strict';

const fs   = require('fs');
const path = require('path');

// ── Environment ───────────────────────────────────────────────────────────────

const MONGO_URL    = process.env.MONGO_URL;
const POSTGRES_URL = process.env.POSTGRES_URL;
const MYSQL_URL    = process.env.MYSQL_URL;
const SQLITE_URL   = process.env.DB_URL;

// ── Table name helpers ────────────────────────────────────────────────────────

/**
 * Sanitise a user-supplied name to a safe SQL/collection identifier.
 * Allows only a-z, 0-9, underscore.  Everything else becomes _.
 */
function sanitize(name) {
  return name.replace(/[^a-z0-9_]/gi, '_').toLowerCase();
}

/**
 * Build the physical table / collection name.
 *   namespace='attendance', table=undefined  → 'plugin_attendance'
 *   namespace='attendance', table='records'  → 'plugin_attendance_records'
 */
function physicalName(namespace, tableName) {
  const base = '' + sanitize(namespace);
  return tableName ? `${base}_${sanitize(tableName)}` : base;
}

// ── Backend detection & adapter factory ──────────────────────────────────────
//
//  We detect the same backend lightweight_store.js would use (same env vars,
//  same priority order) and open our own connection.  The two connections share
//  the same database file / server but are completely independent objects.

let _adapter = null;          // resolved once, reused for all stores
let _adapterPromise = null;   // prevents duplicate initialisation

async function getAdapter() {
  if (_adapter) return _adapter;
  if (_adapterPromise) return _adapterPromise;
  _adapterPromise = _initAdapter();
  _adapter = await _adapterPromise;
  return _adapter;
}

async function _initAdapter() {

  // ── MongoDB ────────────────────────────────────────────────────────────────
  if (MONGO_URL) {
    try {
      const mongoose = require('mongoose');

      // Reuse the existing mongoose connection that lightweight_store already
      // opened rather than creating a second TCP connection.
      await new Promise((resolve, reject) => {
        if (mongoose.connection.readyState === 1) return resolve();
        if (mongoose.connection.readyState === 2) {
          mongoose.connection.once('connected', resolve);
          mongoose.connection.once('error', reject);
          return;
        }
        mongoose.connect(MONGO_URL).then(resolve).catch(reject);
      });

      const db = mongoose.connection.db;

      return {
        name: 'mongo',

        // MongoDB collections are created automatically on first write —
        // no explicit CREATE TABLE needed.
        async ensureTable(table) {
          // Optionally create an index on _id (key) — Mongo already has this by default.
          // We just verify the collection exists by listing it.
          const list = await db.listCollections({ name: table }).toArray();
          if (list.length === 0) {
            await db.createCollection(table);
          }
        },

        async get(table, key) {
          const doc = await db.collection(table).findOne({ _id: key });
          return doc ? doc.value : null;
        },

        async set(table, key, value) {
          await db.collection(table).updateOne(
            { _id: key },
            { $set: { value, ts: Date.now() } },
            { upsert: true }
          );
        },

        async del(table, key) {
          await db.collection(table).deleteOne({ _id: key });
        },

        async getAll(table) {
          const docs = await db.collection(table).find({}).toArray();
          const result = {};
          for (const doc of docs) result[doc._id] = doc.value;
          return result;
        }
      };
    } catch (e) {
      console.error('[pluginStore] MongoDB adapter failed, falling back:', e.message);
    }
  }

  // ── PostgreSQL ─────────────────────────────────────────────────────────────
  if (POSTGRES_URL) {
    try {
      const { Pool } = require('pg');
      const pool = new Pool({
        connectionString: POSTGRES_URL,
        ssl: { rejectUnauthorized: false },
        max: 5,
        idleTimeoutMillis: 60000
      });

      // Track which tables we have already created in this process
      const ready = new Set();

      return {
        name: 'postgres',

        async ensureTable(table) {
          if (ready.has(table)) return;
          const client = await pool.connect();
          try {
            await client.query(`
              CREATE TABLE IF NOT EXISTS "${table}" (
                key  TEXT    NOT NULL PRIMARY KEY,
                value TEXT,
                ts   BIGINT  NOT NULL DEFAULT 0
              )
            `);
            ready.add(table);
          } finally {
            client.release();
          }
        },

        async get(table, key) {
          await this.ensureTable(table);
          const client = await pool.connect();
          try {
            const res = await client.query(
              `SELECT value FROM "${table}" WHERE key=$1`, [key]
            );
            return res.rows[0] ? JSON.parse(res.rows[0].value) : null;
          } finally {
            client.release();
          }
        },

        async set(table, key, value) {
          await this.ensureTable(table);
          const client = await pool.connect();
          try {
            await client.query(
              `INSERT INTO "${table}"(key, value, ts) VALUES($1, $2, $3)
               ON CONFLICT (key) DO UPDATE SET value=$2, ts=$3`,
              [key, JSON.stringify(value), Date.now()]
            );
          } finally {
            client.release();
          }
        },

        async del(table, key) {
          await this.ensureTable(table);
          const client = await pool.connect();
          try {
            await client.query(`DELETE FROM "${table}" WHERE key=$1`, [key]);
          } finally {
            client.release();
          }
        },

        async getAll(table) {
          await this.ensureTable(table);
          const client = await pool.connect();
          try {
            const res = await client.query(`SELECT key, value FROM "${table}"`);
            const result = {};
            for (const row of res.rows) result[row.key] = JSON.parse(row.value);
            return result;
          } finally {
            client.release();
          }
        }
      };
    } catch (e) {
      console.error('[pluginStore] PostgreSQL adapter failed, falling back:', e.message);
    }
  }

  // ── MySQL ──────────────────────────────────────────────────────────────────
  if (MYSQL_URL) {
    try {
      const mysql = require('mysql2/promise');
      const conn  = await mysql.createConnection(MYSQL_URL);
      const ready = new Set();

      return {
        name: 'mysql',

        async ensureTable(table) {
          if (ready.has(table)) return;
          await conn.execute(`
            CREATE TABLE IF NOT EXISTS \`${table}\` (
              \`key\`   VARCHAR(512) NOT NULL PRIMARY KEY,
              \`value\` LONGTEXT,
              \`ts\`    BIGINT NOT NULL DEFAULT 0
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
          `);
          ready.add(table);
        },

        async get(table, key) {
          await this.ensureTable(table);
          const [rows] = await conn.execute(
            `SELECT \`value\` FROM \`${table}\` WHERE \`key\`=?`, [key]
          );
          return rows[0] ? JSON.parse(rows[0].value) : null;
        },

        async set(table, key, value) {
          await this.ensureTable(table);
          await conn.execute(
            `INSERT INTO \`${table}\`(\`key\`, \`value\`, \`ts\`) VALUES(?, ?, ?)
             ON DUPLICATE KEY UPDATE \`value\`=VALUES(\`value\`), \`ts\`=VALUES(\`ts\`)`,
            [key, JSON.stringify(value), Date.now()]
          );
        },

        async del(table, key) {
          await this.ensureTable(table);
          await conn.execute(`DELETE FROM \`${table}\` WHERE \`key\`=?`, [key]);
        },

        async getAll(table) {
          await this.ensureTable(table);
          const [rows] = await conn.execute(
            `SELECT \`key\`, \`value\` FROM \`${table}\``
          );
          const result = {};
          for (const row of rows) result[row.key] = JSON.parse(row.value);
          return result;
        }
      };
    } catch (e) {
      console.error('[pluginStore] MySQL adapter failed, falling back:', e.message);
    }
  }

  // ── SQLite ─────────────────────────────────────────────────────────────────
  if (SQLITE_URL) {
    try {
      const Database = require('better-sqlite3');
      // Open a second connection to the same file — perfectly safe with SQLite
      // WAL mode (which better-sqlite3 enables by default).
      const sqlite = new Database(SQLITE_URL);
      sqlite.pragma('journal_mode = WAL');

      const ready = new Set();

      // better-sqlite3 is synchronous, so we wrap in async for a uniform API.
      return {
        name: 'sqlite',

        async ensureTable(table) {
          if (ready.has(table)) return;
          sqlite.prepare(`
            CREATE TABLE IF NOT EXISTS "${table}" (
              key   TEXT NOT NULL PRIMARY KEY,
              value TEXT,
              ts    INTEGER NOT NULL DEFAULT 0
            )
          `).run();
          ready.add(table);
        },

        async get(table, key) {
          await this.ensureTable(table);
          const row = sqlite.prepare(
            `SELECT value FROM "${table}" WHERE key=?`
          ).get(key);
          return row ? JSON.parse(row.value) : null;
        },

        async set(table, key, value) {
          await this.ensureTable(table);
          sqlite.prepare(
            `INSERT OR REPLACE INTO "${table}"(key, value, ts) VALUES(?, ?, ?)`
          ).run(key, JSON.stringify(value), Date.now());
        },

        async del(table, key) {
          await this.ensureTable(table);
          sqlite.prepare(`DELETE FROM "${table}" WHERE key=?`).run(key);
        },

        async getAll(table) {
          await this.ensureTable(table);
          const rows = sqlite.prepare(
            `SELECT key, value FROM "${table}"`
          ).all();
          const result = {};
          for (const row of rows) result[row.key] = JSON.parse(row.value);
          return result;
        }
      };
    } catch (e) {
      console.error('[pluginStore] SQLite adapter failed, falling back:', e.message);
    }
  }

  // ── File / memory (fallback) ───────────────────────────────────────────────
  //
  //  Each plugin table gets its own JSON file:
  //    ./data/plugin_attendance.json
  //    ./data/plugin_attendance_records.json
  //  This is a true physical separation — one file per table.

  const DATA_DIR = path.join(process.cwd(), 'data');
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

  function filePath(table) {
    return path.join(DATA_DIR, `${table}.json`);
  }

  function readFile(table) {
    const fp = filePath(table);
    if (!fs.existsSync(fp)) return {};
    try { return JSON.parse(fs.readFileSync(fp, 'utf-8')); }
    catch { return {}; }
  }

  function writeFile(table, data) {
    fs.writeFileSync(filePath(table), JSON.stringify(data, null, 2));
  }

  return {
    name: 'file',

    async ensureTable(table) {
      // The file is created on first write — nothing to do here.
    },

    async get(table, key) {
      return readFile(table)[key] ?? null;
    },

    async set(table, key, value) {
      const data = readFile(table);
      data[key] = value;
      writeFile(table, data);
    },

    async del(table, key) {
      const data = readFile(table);
      delete data[key];
      writeFile(table, data);
    },

    async getAll(table) {
      return readFile(table);
    }
  };
}

// ── Core store/table object factory ──────────────────────────────────────────

/**
 * Build a store object scoped to one physical table.
 *
 * @param {string}  namespace   Plugin namespace, e.g. 'attendance'
 * @param {string}  [tableName] Optional sub-table, e.g. 'records'
 * @param {boolean} isRoot      True only for the object returned by createStore()
 */
function makeStore(namespace, tableName, isRoot) {
  const physical = physicalName(namespace, tableName);
  const tag      = `[pluginStore:${physical}]`;

  // Lazily ensure the table exists on first operation
  let _tableReady = false;
  async function ready() {
    if (_tableReady) return;
    const adapter = await getAdapter();
    await adapter.ensureTable(physical);
    _tableReady = true;
  }

  async function adapter() {
    await ready();
    return getAdapter();
  }

  return {

    // ── Core CRUD ─────────────────────────────────────────────────────────────

    /**
     * Get a single value by key.
     * @param   {string} key
     * @returns {Promise<any|null>}
     */
    async get(key) {
      try {
        const a = await adapter();
        return await a.get(physical, key);
      } catch (err) {
        console.error(`${tag} get("${key}"):`, err.message);
        return null;
      }
    },

    /**
     * Save a value. Must be JSON-serialisable.
     * @param {string} key
     * @param {any}    value
     */
    async set(key, value) {
      try {
        const a = await adapter();
        await a.set(physical, key, value);
      } catch (err) {
        console.error(`${tag} set("${key}"):`, err.message);
      }
    },

    /**
     * Hard-delete a key (unlike the old approach which stored null as sentinel,
     * this removes the row entirely — true physical deletion).
     * @param {string} key
     */
    async del(key) {
      try {
        const a = await adapter();
        await a.del(physical, key);
      } catch (err) {
        console.error(`${tag} del("${key}"):`, err.message);
      }
    },

    /**
     * Return every key→value pair in this table.
     * @returns {Promise<Object>}
     */
    async getAll() {
      try {
        const a = await adapter();
        return await a.getAll(physical);
      } catch (err) {
        console.error(`${tag} getAll():`, err.message);
        return {};
      }
    },

    // ── Convenience helpers ───────────────────────────────────────────────────

    /** Returns true if the key exists in the table. */
    async has(key) {
      return (await this.get(key)) !== null;
    },

    /** Like get(), but returns defaultValue when the key is missing. */
    async getOrDefault(key, defaultValue) {
      const value = await this.get(key);
      return value !== null ? value : defaultValue;
    },

    /**
     * Read → shallow-merge → write.
     * Safe for updating one field without overwriting the rest of a record.
     * @param {string} key
     * @param {Object} patch
     */
    async patch(key, patch) {
      const existing = (await this.get(key)) || {};
      await this.set(key, { ...existing, ...patch });
    },

    // ── Sub-table factory (root store only) ───────────────────────────────────

    /**
     * Return a new store backed by its own physical table.
     *
     * e.g.  createStore('attendance').table('records')
     *         → physical table: plugin_attendance_records
     *
     * @param  {string} name  Short identifier: 'records', 'settings', 'birthdays', …
     * @returns {PluginStore}
     */
    table(name) {
      if (!isRoot) {
        throw new Error(
          `${tag} Cannot call .table() on an already-scoped table. ` +
          `Call it on the root store instead: createStore('${namespace}').table('${name}')`
        );
      }
      if (!name || typeof name !== 'string' || /[^a-z0-9_]/i.test(name)) {
        throw new Error(
          `${tag} table name must be a non-empty alphanumeric string (got: "${name}")`
        );
      }
      return makeStore(namespace, name, false);
    },

    // ── Read-only metadata ────────────────────────────────────────────────────

    get namespace()     { return namespace; },
    get tableName()     { return tableName || null; },
    get physicalTable() { return physical; },
  };
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Create an isolated, physical-table-backed store for a plugin.
 *
 * @param {string} namespace  Unique plugin name, e.g. 'attendance', 'birthday'.
 *                            Alphanumeric + underscore only. No spaces.
 * @returns {PluginStore}
 *
 * @example  Simple plugin — single table:
 *   const db = createStore('myplugin');
 *   await db.set('config', { enabled: true });
 *
 * @example  Plugin with multiple tables (old COLLECTIONS pattern):
 *   const db       = createStore('attendance');
 *   const records  = db.table('records');    // → plugin_attendance_records
 *   const settings = db.table('settings');   // → plugin_attendance_settings
 *   const birthday = db.table('birthdays');  // → plugin_attendance_birthdays
 *
 *   await records.set(`user:${userId}`, { date, streak });
 *   await settings.getOrDefault('config', defaultSettings);
 *   await birthday.patch(`user:${userId}`, { dob: '01/01' });
 */
function createStore(namespace) {
  if (!namespace || typeof namespace !== 'string') {
    throw new Error('[pluginStore] namespace must be a non-empty string');
  }
  if (/[^a-z0-9_]/i.test(namespace)) {
    throw new Error(
      `[pluginStore] namespace "${namespace}" must contain only letters, digits, or underscores`
    );
  }
  return makeStore(namespace, undefined, true /* isRoot */);
}

module.exports = { createStore };