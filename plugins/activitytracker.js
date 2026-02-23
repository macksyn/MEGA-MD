// plugins/activitytracker.js
// Extends the bot's built-in message counting with activity type tracking.
// Uses createStore (pluginStore) — same pattern as attendance.js & birthday.js.
//
// KEY FIX: tracking uses onMessage (like attendance.js auto-detection),
//          NOT handler/isPrefixless — handler only fires for bot commands,
//          not for regular group messages.

const moment = require('moment-timezone');
const { createStore } = require('../lib/pluginStore');

// lightweight_store is optional — only used for getMessageCount fallback.
// Wrapped in try/catch so a missing / incompatible version never breaks tracking.
let lwStore = null;
try { lwStore = require('../lib/lightweight_store'); } catch {}

moment.tz.setDefault('Africa/Lagos');

// ===== STORAGE =====
const db              = createStore('activitytracker');
const dbStats         = db.table('stats');    // key: userId__groupId__YYYY-MM
const dbGroupSettings = db.table('groups');   // key: groupId
const dbSettings      = db.table('settings'); // key: 'config'

// ===== DEFAULTS =====
const defaultSettings = {
  pointsPerMessage:    1,
  pointsPerSticker:    2,
  pointsPerVideo:      5,
  pointsPerVoiceNote:  3,
  pointsPerPoll:       5,
  pointsPerPhoto:      3,
  pointsPerAttendance: 10
};

// ===== IN-MEMORY CACHES =====
const enabledGroupsCache = new Set();
const settingsCache = { data: null, timestamp: 0 };
const CACHE_TTL = 60_000;

// ===== KEY / DATE HELPERS =====

function statKey(userId, groupId, month) {
  return `${userId}__${groupId}__${month}`;
}

function currentMonth() {
  return moment.tz('Africa/Lagos').format('YYYY-MM');
}

function blankStats() {
  return { messages: 0, stickers: 0, videos: 0, voiceNotes: 0, polls: 0, photos: 0, attendance: 0 };
}

// ===== TYPE MAPS =====

const STATS_TYPE_MAP = {
  messages:   'message',
  stickers:   'sticker',
  videos:     'video',
  voiceNotes: 'voiceNote',
  polls:      'poll',
  photos:     'photo',
  attendance: 'attendance'
};

const MESSAGE_STATS_KEY_MAP = {
  message:   'messages',
  sticker:   'stickers',
  video:     'videos',
  voiceNote: 'voiceNotes',
  poll:      'polls',
  photo:     'photos'
};

// ===== GROUP TRACKING ENABLE / DISABLE =====

async function isGroupEnabled(groupId) {
  if (enabledGroupsCache.has(groupId)) return true;
  try {
    const rec = await dbGroupSettings.get(groupId);
    if (rec?.enabled) { enabledGroupsCache.add(groupId); return true; }
    return false;
  } catch { return false; }
}

async function enableGroupTracking(groupId, groupName = '') {
  try {
    await dbGroupSettings.set(groupId, {
      groupId, groupName, enabled: true,
      enabledAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    });
    enabledGroupsCache.add(groupId);
    console.log(`[ACTIVITY] ✅ Tracking enabled for group: ${groupId}`);
    return { success: true };
  } catch (error) {
    console.error('[ACTIVITY] enableGroupTracking error:', error);
    return { success: false, error: error.message };
  }
}

async function disableGroupTracking(groupId) {
  try {
    const existing = await dbGroupSettings.get(groupId) || {};
    await dbGroupSettings.set(groupId, {
      ...existing, enabled: false,
      disabledAt: new Date().toISOString(),
      updatedAt:  new Date().toISOString()
    });
    enabledGroupsCache.delete(groupId);
    console.log(`[ACTIVITY] ❌ Tracking disabled for group: ${groupId}`);
    return { success: true };
  } catch (error) {
    console.error('[ACTIVITY] disableGroupTracking error:', error);
    return { success: false, error: error.message };
  }
}

async function getEnabledGroups() {
  try {
    const all = await dbGroupSettings.getAll();
    return Object.values(all).filter(g => g.enabled === true);
  } catch { return []; }
}

// ===== SETTINGS =====

async function getSettings() {
  const now = Date.now();
  if (settingsCache.data && now - settingsCache.timestamp < CACHE_TTL) return settingsCache.data;
  try {
    const saved  = await dbSettings.get('config') || {};
    const merged = { ...defaultSettings, ...saved };
    settingsCache.data = merged; settingsCache.timestamp = now;
    return merged;
  } catch { return { ...defaultSettings }; }
}

async function saveSettings(settings) {
  try {
    await dbSettings.set('config', settings);
    settingsCache.data = null; settingsCache.timestamp = 0;
  } catch (error) { console.error('[ACTIVITY] saveSettings error:', error.message); }
}

// ===== POINTS =====

function calculatePoints(activityType, settings) {
  const map = {
    message:    settings.pointsPerMessage,
    sticker:    settings.pointsPerSticker,
    video:      settings.pointsPerVideo,
    voiceNote:  settings.pointsPerVoiceNote,
    poll:       settings.pointsPerPoll,
    photo:      settings.pointsPerPhoto,
    attendance: settings.pointsPerAttendance
  };
  return map[activityType] || 0;
}

// ===== CORE STAT CRUD =====

/**
 * Read one user+group+month record.
 * On first access, creates and persists a fully-populated blank record
 * (so groupId / month fields are always present for leaderboard filtering).
 */
async function getActivityStats(userId, groupId, month = null) {
  const mon = month || currentMonth();
  const key = statKey(userId, groupId, mon);
  try {
    let record = await dbStats.get(key);
    if (!record) {
      record = {
        userId, groupId, month: mon,
        stats:     blankStats(),
        points:    0,
        lastSeen:  new Date().toISOString(),
        firstSeen: new Date().toISOString()
      };
      await dbStats.set(key, record);
    }
    return record;
  } catch (error) {
    console.error('[ACTIVITY] getActivityStats error:', error.message);
    return null;
  }
}

/**
 * Write updated stats back.
 * We do a full set (not patch) so the record always has every field intact.
 * This is safer than patch when `updates` contains nested objects like `stats`.
 */
async function updateActivityStats(userId, groupId, updates, month = null) {
  const mon = month || currentMonth();
  const key = statKey(userId, groupId, mon);
  try {
    // Read current record (already exists — getActivityStats was called first)
    const existing = await dbStats.get(key) || {
      userId, groupId, month: mon,
      stats: blankStats(), points: 0,
      lastSeen: new Date().toISOString(),
      firstSeen: new Date().toISOString()
    };
    await dbStats.set(key, {
      ...existing,
      ...updates,
      lastSeen: new Date().toISOString()
    });
  } catch (error) {
    console.error('[ACTIVITY] updateActivityStats error:', error.message);
  }
}

// ===== MESSAGE TYPE DETECTION =====

function detectMessageType(message) {
  try {
    if (!message) return null;
    if (message.imageMessage)                                return 'photo';
    if (message.videoMessage)                                return 'video';
    if (message.stickerMessage)                              return 'sticker';
    if (message.audioMessage?.ptt)                           return 'voiceNote';
    if (
      message.pollCreationMessage   ||
      message.pollCreationMessageV2 ||
      message.pollCreationMessageV3
    )                                                        return 'poll';
    if (message.conversation || message.extendedTextMessage) return 'message';
    return null;
  } catch { return null; }
}

// ===== SAFE MESSAGE COUNT (lightweight_store optional) =====

async function safeGetMessageCount(groupId, userId) {
  try {
    if (typeof lwStore?.getMessageCount === 'function') {
      const count = await lwStore.getMessageCount(groupId, userId);
      return count || 0;
    }
  } catch {}
  return 0;
}

// ===== USER ACTIVITY (consumed by activity.js) =====

async function getUserActivity(userId, groupId, month = null) {
  const mon = month || currentMonth();
  try {
    const [totalMessages, activity, settings] = await Promise.all([
      safeGetMessageCount(groupId, userId),
      getActivityStats(userId, groupId, mon),
      getSettings()
    ]);

    if (!activity) return null;

    // Always recalculate points from stored stat counts so the
    // display is consistent even if point values changed.
    let points = 0;
    for (const [statKey, activityType] of Object.entries(STATS_TYPE_MAP)) {
      points += calculatePoints(activityType, settings) * (activity.stats[statKey] || 0);
    }

    return {
      userId, groupId, month: mon,
      totalMessages,
      stats:     activity.stats,
      points,
      lastSeen:  activity.lastSeen,
      firstSeen: activity.firstSeen
    };
  } catch (error) {
    console.error('[ACTIVITY] getUserActivity error:', error.message);
    return null;
  }
}

// ===== LEADERBOARD / RANKS =====

async function getMonthlyLeaderboard(groupId, month = null, limit = 10) {
  const mon = month || currentMonth();
  try {
    const [all, settings] = await Promise.all([dbStats.getAll(), getSettings()]);

    const groupRecords = Object.values(all).filter(
      r => r.groupId === groupId && r.month === mon
    );

    const enriched = await Promise.all(groupRecords.map(async rec => {
      const totalMessages = await safeGetMessageCount(groupId, rec.userId);
      let points = 0;
      for (const [key, type] of Object.entries(STATS_TYPE_MAP)) {
        points += calculatePoints(type, settings) * (rec.stats?.[key] || 0);
      }
      return { ...rec, totalMessages, points };
    }));

    return enriched.sort((a, b) => b.points - a.points).slice(0, limit);
  } catch (error) {
    console.error('[ACTIVITY] getMonthlyLeaderboard error:', error.message);
    return [];
  }
}

async function getUserRank(userId, groupId) {
  try {
    const leaderboard = await getMonthlyLeaderboard(groupId, null, 1000);
    const idx = leaderboard.findIndex(u => u.userId === userId);
    if (idx === -1) return null;
    return { rank: idx + 1, totalUsers: leaderboard.length, activity: leaderboard[idx] };
  } catch (error) {
    console.error('[ACTIVITY] getUserRank error:', error.message);
    return null;
  }
}

async function getInactiveMembers(groupId, limit = 10) {
  try {
    const [all, settings] = await Promise.all([dbStats.getAll(), getSettings()]);
    const mon = currentMonth();

    const groupRecords = Object.values(all).filter(
      r => r.groupId === groupId && r.month === mon
    );

    const enriched = await Promise.all(groupRecords.map(async rec => {
      const totalMessages = await safeGetMessageCount(groupId, rec.userId);
      let points = 0;
      for (const [key, type] of Object.entries(STATS_TYPE_MAP)) {
        points += calculatePoints(type, settings) * (rec.stats?.[key] || 0);
      }
      return { ...rec, totalMessages, points };
    }));

    return enriched.sort((a, b) => a.points - b.points).slice(0, limit);
  } catch (error) {
    console.error('[ACTIVITY] getInactiveMembers error:', error.message);
    return [];
  }
}

// ===== CORE TRACKING =====

async function trackActivity(message) {
  try {
    const chatId = message.key?.remoteJid;
    if (!chatId?.endsWith('@g.us')) return;

    // Gate: only track in groups that have explicitly been enabled
    if (!await isGroupEnabled(chatId)) return;

    const senderId = message.key.participant || message.key.remoteJid;
    if (!senderId) return;
    if (message.key.fromMe) return;

    const settings = await getSettings();

    // ── Attendance event injected by attendance.js ──
    if (message._attendanceEvent) {
      const activity = await getActivityStats(senderId, chatId);
      if (!activity) return;
      const stats = { ...activity.stats };
      stats.attendance = (stats.attendance || 0) + 1;
      const newPoints = (activity.points || 0) + calculatePoints('attendance', settings);
      await updateActivityStats(senderId, chatId, { stats, points: newPoints });
      console.log(`[ACTIVITY] ✅ Attendance +${calculatePoints('attendance', settings)}pts → ${senderId.split('@')[0]}`);
      return;
    }

    const messageType = detectMessageType(message.message);
    if (!messageType) return;

    const activity = await getActivityStats(senderId, chatId);
    if (!activity) return;

    const stats    = { ...activity.stats };
    const statsKey = MESSAGE_STATS_KEY_MAP[messageType];
    if (statsKey) stats[statsKey] = (stats[statsKey] || 0) + 1;

    const pts       = calculatePoints(messageType, settings);
    const newPoints = (activity.points || 0) + pts;

    await updateActivityStats(senderId, chatId, { stats, points: newPoints });

  } catch (error) {
    console.error('[ACTIVITY] trackActivity error:', error.message);
  }
}

// ===== ATTENDANCE INTEGRATION (direct call from attendance.js) =====

async function recordAttendance(userId, groupId) {
  try {
    if (!await isGroupEnabled(groupId)) return;
    const settings = await getSettings();
    const activity  = await getActivityStats(userId, groupId);
    if (!activity) return;

    const stats = { ...activity.stats };
    stats.attendance = (stats.attendance || 0) + 1;
    const pts       = calculatePoints('attendance', settings);
    const newPoints = (activity.points || 0) + pts;
    await updateActivityStats(userId, groupId, { stats, points: newPoints });
    console.log(`[ACTIVITY] ✅ Attendance tracked for ${userId.split('@')[0]} (+${pts} pts)`);
  } catch (error) {
    console.error('[ACTIVITY] recordAttendance error:', error.message);
  }
}

// ===== PLUGIN EXPORT =====

module.exports = {
  command: '_activitytracker',
  category: 'utility',
  description: 'Tracks per-type activity (messages, stickers, photos …) in enabled groups',

  // ── Exported API for activity.js ──
  isGroupEnabled,
  enableGroupTracking,
  disableGroupTracking,
  getEnabledGroups,
  getSettings,
  saveSettings,
  getUserActivity,
  getUserRank,
  getMonthlyLeaderboard,
  getInactiveMembers,
  recordAttendance,
  trackActivity
};
