/***
 * lib/pluginBus.js
 *
 * A lightweight event bus that lets plugins talk to each other
 * without direct require() coupling.
 *
 * PUBLISHING (e.g. attendance.js):
 *   const bus = require('../lib/pluginBus');
 *   bus.emit('attendance:submitted', { userId, name, dob });
 *
 * SUBSCRIBING (e.g. birthday.js):
 *   const bus = require('../lib/pluginBus');
 *   bus.on('attendance:submitted', async ({ userId, name, dob }) => { ... });
 *
 * That's it. No index.js changes, no messageHandler.js changes.
 */

'use strict';

const { EventEmitter } = require('events');

class PluginBus extends EventEmitter {
  constructor() {
    super();
    // Raise the default listener limit — plugins can have many subscriptions
    this.setMaxListeners(50);
  }

  /**
   * Same as .on() but automatically wraps the handler in try/catch so a
   * crashing subscriber never kills the publisher's flow.
   */
  on(event, handler) {
    return super.on(event, async (...args) => {
      try {
        await handler(...args);
      } catch (err) {
        console.error(`[PluginBus] Error in listener for "${event}": ${err.message}`);
      }
    });
  }
}

module.exports = new PluginBus();
