/***
 * lib/pluginStore.js
 *
 * A thin, namespaced wrapper around lightweight_store.
 * Plugins use this instead of calling store.getSetting / store.saveSetting
 * directly, which means lightweight_store.js NEVER needs new methods or
 * schema changes when a new plugin is added.
 *
 * USAGE (inside any plugin):
 *
 *   const { createStore } = require('../lib/pluginStore');
 *   const db = createStore('attendance');   // ← your plugin's namespace
 *
 *   await db.get('user:' + userId);              // returns value or null
 *   await db.set('user:' + userId, data);        // saves value
 *   await db.del('user:' + userId);              // deletes key
 *   await db.getAll();                           // returns { key: value, ... }
 *
 * Keys are stored in lightweight_store as:
 *   chatId  = '_plugin'
 *   key     = '<namespace>:<yourKey>'
 *
 * This keeps every plugin's data in its own lane with zero schema work.
 */

'use strict';

const store = require('./lightweight_store');

const PLUGIN_SCOPE = '_plugin';  // The "chatId" used for all plugin storage

/**
 * Create a namespaced store for a plugin.
 * @param {string} namespace  e.g. 'attendance', 'birthday', 'myPlugin'
 */
function createStore(namespace) {
  if (!namespace || typeof namespace !== 'string') {
    throw new Error('[pluginStore] namespace must be a non-empty string');
  }

  const prefix = `${namespace}:`;

  return {
    /**
     * Get a value.
     * @param {string} key
     * @returns {Promise<any|null>}
     */
    async get(key) {
      try {
        const bucket = await store.getSetting(PLUGIN_SCOPE, prefix + key);
        return bucket ?? null;
      } catch (err) {
        console.error(`[pluginStore:${namespace}] get(${key}) error:`, err.message);
        return null;
      }
    },

    /**
     * Save a value.
     * @param {string} key
     * @param {any} value   Must be JSON-serialisable.
     */
    async set(key, value) {
      try {
        await store.saveSetting(PLUGIN_SCOPE, prefix + key, value);
      } catch (err) {
        console.error(`[pluginStore:${namespace}] set(${key}) error:`, err.message);
      }
    },

    /**
     * Delete a key by setting it to null.
     * (lightweight_store has no delete, so we store null as the sentinel.)
     * @param {string} key
     */
    async del(key) {
      try {
        await store.saveSetting(PLUGIN_SCOPE, prefix + key, null);
      } catch (err) {
        console.error(`[pluginStore:${namespace}] del(${key}) error:`, err.message);
      }
    },

    /**
     * Read the entire namespace as a flat key→value map.
     * Works in memory/file mode (reads data/<namespace>:*.json).
     * In DB mode, falls back to lightweight_store.getAllSettings.
     * @returns {Promise<Object>}
     */
    async getAll() {
      try {
        const all = await store.getAllSettings(PLUGIN_SCOPE);
        const result = {};
        for (const [storeKey, value] of Object.entries(all || {})) {
          if (storeKey.startsWith(prefix)) {
            result[storeKey.slice(prefix.length)] = value;
          }
        }
        return result;
      } catch (err) {
        console.error(`[pluginStore:${namespace}] getAll() error:`, err.message);
        return {};
      }
    },

    // ── Convenience helpers ───────────────────────────────────────────────

    /**
     * Get a value, returning `defaultValue` if the key is missing or null.
     */
    async getOrDefault(key, defaultValue) {
      const value = await this.get(key);
      return value !== null ? value : defaultValue;
    },

    /**
     * Read → merge → write in one call, useful for updating records.
     * @param {string} key
     * @param {Object} patch  Plain object to merge into the existing value.
     */
    async patch(key, patch) {
      const existing = await this.get(key) || {};
      await this.set(key, { ...existing, ...patch });
    },
  };
}

module.exports = { createStore };
