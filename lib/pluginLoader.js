/***
 * lib/pluginLoader.js
 *
 * Central lifecycle manager for all plugins.
 *
 * What it does automatically, with ZERO changes to any plugin:
 *   1. Calls plugin.onLoad(sock)     — once, after the bot connects
 *   2. Calls plugin.onMessage(...)   — on every incoming message
 *   3. Runs plugin.schedules[].handler on the declared cron-style pattern
 *
 * ─── HOW TO USE ──────────────────────────────────────────────────────────
 *
 * In index.js, replace the two scattered lines with ONE call:
 *
 *   const pluginLoader = require('./lib/pluginLoader');
 *
 *   // inside the 'connection.update' → connection === 'open' block:
 *   await pluginLoader.start(QasimDev);
 *
 * In messageHandler.js, add ONE line inside handleMessages():
 *
 *   await pluginLoader.dispatchMessage(sock, message, context);
 *
 * That's the entire integration. No further changes to core files.
 *
 * ─── PLUGIN CONTRACT ─────────────────────────────────────────────────────
 *
 * A plugin CAN (all optional) export any of these:
 *
 *   module.exports = {
 *     command: 'mycommand',           // existing — unchanged
 *     handler: async (...) => {},     // existing — unchanged
 *
 *     // NEW: called once after bot connects
 *     onLoad: async (sock) => {},
 *
 *     // NEW: called on every non-bot message, in every enabled chat
 *     //      Return true to signal "I handled this, stop further onMessage dispatch"
 *     onMessage: async (sock, message, context) => {},
 *
 *     // NEW: time-based tasks — no node-cron dependency needed
 *     schedules: [
 *       {
 *         // 'HH:MM' string checked every minute, or interval in milliseconds
 *         at: '09:00',          // fires daily at 09:00 in the bot's timezone
 *         handler: async (sock) => { ... }
 *       },
 *       {
 *         every: 60 * 60 * 1000,   // fires every 1 hour (ms)
 *         handler: async (sock) => { ... }
 *       }
 *     ]
 *   };
 */

'use strict';

const path = require('path');
const fs   = require('fs');
const { printLog } = require('./print');

// ── Internal state ──────────────────────────────────────────────────────────

let _sock = null;
let _started = false;

/** All plugins that declared onMessage(), in load order */
const _messageHooks = [];

/** All interval/timer handles so we can clear them on shutdown */
const _timers = [];

/** timezone from settings */
const settings = (() => {
  try { return require('../settings'); }
  catch { return { timeZone: 'UTC' }; }
})();

// ── Helpers ─────────────────────────────────────────────────────────────────

function nowInTZ() {
  return new Date().toLocaleString('en-GB', {
    timeZone: settings.timeZone || 'UTC',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }); // returns e.g. "09:00"
}

function pluginsDir() {
  return path.join(__dirname, '../plugins');
}

function loadAllPlugins() {
  const dir = pluginsDir();
  if (!fs.existsSync(dir)) return [];

  return fs.readdirSync(dir)
    .filter(f => f.endsWith('.js'))
    .map(f => {
      try {
        const mod = require(path.join(dir, f));
        return mod;
      } catch (err) {
        printLog('warning', `[pluginLoader] Failed to require ${f}: ${err.message}`);
        return null;
      }
    })
    .filter(Boolean);
}

// ── Schedule engine ──────────────────────────────────────────────────────────

/**
 * Set up a "daily at HH:MM" schedule.
 * Fires once when the wall-clock matches, then waits 24 h.
 */
function scheduleAtTime(timeStr, handler, label) {
  // Check every 60 s
  let lastFiredDate = null;

  const id = setInterval(async () => {
    const now = nowInTZ();
    const today = new Date().toLocaleDateString();

    if (now === timeStr && lastFiredDate !== today) {
      lastFiredDate = today;
      printLog('info', `[pluginLoader] ⏰ Schedule "${label}" firing at ${timeStr}`);
      try {
        await handler(_sock);
      } catch (err) {
        printLog('error', `[pluginLoader] Schedule "${label}" error: ${err.message}`);
      }
    }
  }, 60_000);

  _timers.push(id);
}

/**
 * Set up a repeating interval schedule.
 */
function scheduleEvery(ms, handler, label) {
  const id = setInterval(async () => {
    printLog('info', `[pluginLoader] 🔁 Interval "${label}" firing`);
    try {
      await handler(_sock);
    } catch (err) {
      printLog('error', `[pluginLoader] Interval "${label}" error: ${err.message}`);
    }
  }, ms);

  _timers.push(id);
}

// ── Public API ───────────────────────────────────────────────────────────────

const pluginLoader = {
  /**
   * Call this once inside `connection.update → connection === 'open'`.
   * Runs onLoad() for every plugin that has it, then sets up all schedules.
   * Safe to call multiple times — only runs once.
   *
   * @param {import('@whiskeysockets/baileys').WASocket} sock
   */
  async start(sock) {
    if (_started) return;
    _started = true;
    _sock = sock;

    printLog('info', '[pluginLoader] Starting plugin lifecycle hooks...');

    const plugins = loadAllPlugins();
    let loadCount = 0;
    let scheduleCount = 0;
    let messageHookCount = 0;

    for (const plugin of plugins) {
      const label = plugin.command || plugin.name || '(unnamed)';

      // 1. Register onMessage hooks
      if (typeof plugin.onMessage === 'function') {
        _messageHooks.push({ label, fn: plugin.onMessage });
        messageHookCount++;
      }

      // 2. Run onLoad
      if (typeof plugin.onLoad === 'function') {
        try {
          await plugin.onLoad(sock);
          loadCount++;
          printLog('success', `[pluginLoader] onLoad ✓ ${label}`);
        } catch (err) {
          printLog('error', `[pluginLoader] onLoad failed for ${label}: ${err.message}`);
        }
      }

      // 3. Register schedules
      if (Array.isArray(plugin.schedules)) {
        for (const sched of plugin.schedules) {
          const schedLabel = `${label}/${sched.at || sched.every + 'ms'}`;

          if (sched.at && typeof sched.handler === 'function') {
            scheduleAtTime(sched.at, sched.handler, schedLabel);
            scheduleCount++;
            printLog('info', `[pluginLoader] Schedule registered: ${schedLabel}`);
          } else if (sched.every && typeof sched.handler === 'function') {
            scheduleEvery(sched.every, sched.handler, schedLabel);
            scheduleCount++;
            printLog('info', `[pluginLoader] Interval registered: ${schedLabel}`);
          }
        }
      }
    }

    printLog('success',
      `[pluginLoader] Ready — onLoad: ${loadCount}, schedules: ${scheduleCount}, onMessage hooks: ${messageHookCount}`
    );
  },

  /**
   * Call this once inside handleMessages() in messageHandler.js.
   * Dispatches to every plugin that registered an onMessage hook.
   *
   * @param {object} sock
   * @param {object} message
   * @param {object} context  — the context object you already build in messageHandler
   */
  async dispatchMessage(sock, message, context) {
    for (const { label, fn } of _messageHooks) {
      try {
        const handled = await fn(sock, message, context);
        if (handled === true) break; // plugin signalled "stop dispatch"
      } catch (err) {
        printLog('error', `[pluginLoader] onMessage hook "${label}" error: ${err.message}`);
      }
    }
  },

  /** Graceful shutdown — clears all timers */
  stop() {
    for (const id of _timers) clearInterval(id);
    _timers.length = 0;
    _started = false;
    printLog('info', '[pluginLoader] All plugin timers cleared.');
  },
};

// Attach cleanup to process exit
process.on('SIGINT',  () => pluginLoader.stop());
process.on('SIGTERM', () => pluginLoader.stop());

module.exports = pluginLoader;
