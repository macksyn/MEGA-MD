// plugins/birthday.js
// Birthday system - converted from V3 ESM plugin to match HEDRA-AI architecture
// Uses: store.getSetting / store.saveSetting, CommonJS, direct sock.sendMessage pattern
// Integrates with: plugins/attendance.js (auto-saves DOB from attendance forms)

'use strict';

const store = require('../lib/lightweight_store');
const { printLog } = require('../lib/print');
const moment = require('moment-timezone');

// ==================== CONSTANTS ====================

const TIMEZONE = 'Africa/Lagos';

const KEYS = {
  BIRTHDAYS: 'birthdays',
  SETTINGS: 'birthday_settings',
  WISHES_LOG: 'birthday_wishes_log',
  REMINDERS_LOG: 'birthday_reminders_log'
};

const DEFAULT_SETTINGS = {
  enableReminders: true,
  enableAutoWishes: true,
  reminderDays: [7, 3, 1],
  reminderTime: '09:00',
  wishTime: '00:01',
  enableGroupReminders: true,
  enablePrivateReminders: true,
  reminderGroups: [],
  adminNumbers: []
};

const MONTH_NAMES = [
  '', 'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'
];

const MONTH_MAP = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
  july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
  jan: 1, feb: 2, mar: 3, apr: 4, jun: 6, jul: 7, aug: 8,
  sep: 9, oct: 10, nov: 11, dec: 12
};

// ==================== MODULE STATE ====================

let birthdaySettings = { ...DEFAULT_SETTINGS, loaded: false };
let schedulerStarted = false;
let lastSchedulerRun = {};  // Tracks what ran today to prevent duplicates

// ==================== STORAGE LAYER ====================

async function loadSettings() {
  try {
    const saved = await store.getSetting('global', KEYS.SETTINGS);
    if (saved) {
      birthdaySettings = { ...DEFAULT_SETTINGS, ...saved, loaded: true };
    } else {
      birthdaySettings = { ...DEFAULT_SETTINGS, loaded: true };
    }
  } catch (e) {
    printLog('error', `[BIRTHDAY] loadSettings error: ${e.message}`);
    birthdaySettings = { ...DEFAULT_SETTINGS, loaded: true };
  }
}

async function saveSettings() {
  try {
    const toSave = { ...birthdaySettings };
    delete toSave.loaded;
    await store.saveSetting('global', KEYS.SETTINGS, toSave);
  } catch (e) {
    printLog('error', `[BIRTHDAY] saveSettings error: ${e.message}`);
  }
}

async function getAllBirthdays() {
  try {
    return await store.getSetting('global', KEYS.BIRTHDAYS) || {};
  } catch (e) {
    printLog('error', `[BIRTHDAY] getAllBirthdays error: ${e.message}`);
    return {};
  }
}

/**
 * Save birthday data for a user.
 * Called externally by attendance.js after processing a form.
 * @param {string} userId - WhatsApp JID
 * @param {string} name - Display name
 * @param {string} dobString - Raw D.O.B string from attendance form
 * @returns {boolean} success
 */
async function saveBirthdayData(userId, name, dobString) {
  try {
    const parsed = parseDOB(dobString);
    if (!parsed) {
      printLog('warning', `[BIRTHDAY] Could not parse DOB for ${name}: "${dobString}"`);
      return false;
    }

    const birthdays = await getAllBirthdays();
    birthdays[userId] = {
      userId,
      name,
      birthday: parsed,
      lastUpdated: new Date().toISOString()
    };

    await store.saveSetting('global', KEYS.BIRTHDAYS, birthdays);
    printLog('success', `[BIRTHDAY] 🎂 Birthday saved for ${name} (${parsed.displayDate})`);
    return true;
  } catch (e) {
    printLog('error', `[BIRTHDAY] saveBirthdayData error: ${e.message}`);
    return false;
  }
}

async function getBirthdayData(userId) {
  try {
    const birthdays = await getAllBirthdays();
    return birthdays[userId] || null;
  } catch (e) {
    printLog('error', `[BIRTHDAY] getBirthdayData error: ${e.message}`);
    return null;
  }
}

async function getTodaysBirthdays() {
  try {
    const now = moment.tz(TIMEZONE);
    const searchKey = `${String(now.month() + 1).padStart(2, '0')}-${String(now.date()).padStart(2, '0')}`;
    const birthdays = await getAllBirthdays();
    return Object.values(birthdays).filter(b => b.birthday?.searchKey === searchKey);
  } catch (e) {
    printLog('error', `[BIRTHDAY] getTodaysBirthdays error: ${e.message}`);
    return [];
  }
}

async function getUpcomingBirthdays(daysAhead) {
  try {
    const target = moment.tz(TIMEZONE).add(daysAhead, 'days');
    const searchKey = `${String(target.month() + 1).padStart(2, '0')}-${String(target.date()).padStart(2, '0')}`;
    const birthdays = await getAllBirthdays();
    return Object.values(birthdays).filter(b => b.birthday?.searchKey === searchKey);
  } catch (e) {
    printLog('error', `[BIRTHDAY] getUpcomingBirthdays error: ${e.message}`);
    return [];
  }
}

async function hasWishedToday(userId) {
  try {
    const today = moment.tz(TIMEZONE).format('YYYY-MM-DD');
    const log = await store.getSetting('global', KEYS.WISHES_LOG) || {};
    return !!(log[today]?.[userId]);
  } catch (e) {
    return false;
  }
}

async function markWishedToday(userId, name, successfulSends) {
  try {
    const today = moment.tz(TIMEZONE).format('YYYY-MM-DD');
    const log = await store.getSetting('global', KEYS.WISHES_LOG) || {};
    if (!log[today]) log[today] = {};
    log[today][userId] = {
      name,
      timestamp: new Date().toISOString(),
      successfulSends
    };
    await store.saveSetting('global', KEYS.WISHES_LOG, log);
  } catch (e) {
    printLog('error', `[BIRTHDAY] markWishedToday error: ${e.message}`);
  }
}

async function hasReminderSent(reminderKey) {
  try {
    const log = await store.getSetting('global', KEYS.REMINDERS_LOG) || {};
    return !!log[reminderKey];
  } catch (e) {
    return false;
  }
}

async function markReminderSent(reminderKey, userId, daysAhead) {
  try {
    const log = await store.getSetting('global', KEYS.REMINDERS_LOG) || {};
    log[reminderKey] = {
      userId,
      daysAhead,
      timestamp: new Date().toISOString()
    };
    await store.saveSetting('global', KEYS.REMINDERS_LOG, log);
  } catch (e) {
    printLog('error', `[BIRTHDAY] markReminderSent error: ${e.message}`);
  }
}

// ==================== DATE PARSING ====================

/**
 * Parse a DOB string into a structured birthday object.
 * Handles formats: "January 15, 1990", "January 15", "15/01/1990", "1990-01-15", etc.
 * @param {string} dobString
 * @returns {object|null}
 */
function parseDOB(dobString) {
  if (!dobString || typeof dobString !== 'string') return null;

  // Clean: remove asterisks, extra spaces, trim
  const clean = dobString.replace(/\*/g, '').replace(/\s+/g, ' ').trim();
  let day, month, year;

  // Format: "Month Day, Year" or "Month Day"  e.g. "January 15, 1990" / "Jan 15"
  const verboseMatch = clean.match(/([a-zA-Z]+)\s+(\d{1,2})(?:[,\s]+(\d{4}))?/);
  if (verboseMatch) {
    const monthKey = verboseMatch[1].toLowerCase();
    month = MONTH_MAP[monthKey];
    day = parseInt(verboseMatch[2]);
    year = verboseMatch[3] ? parseInt(verboseMatch[3]) : null;
  }

  // Format: DD/MM/YYYY, MM/DD/YYYY, YYYY-MM-DD, DD-MM-YYYY
  if (!month) {
    const numericMatch = clean.match(/(\d{1,4})[\/\-\.](\d{1,2})(?:[\/\-\.](\d{1,4}))?/);
    if (numericMatch) {
      const a = parseInt(numericMatch[1]);
      const b = parseInt(numericMatch[2]);
      const c = numericMatch[3] ? parseInt(numericMatch[3]) : null;

      if (a > 31) {
        // YYYY-MM-DD
        year = a; month = b; day = c;
      } else if (c && c > 31) {
        // DD/MM/YYYY (Nigerian convention)
        day = a; month = b; year = c;
      } else if (!c) {
        // DD/MM (no year provided)
        day = a; month = b; year = null;
      } else {
        // Ambiguous — assume DD/MM/YY (treat YY as 20YY)
        day = a; month = b; year = c < 100 ? 2000 + c : c;
      }
    }
  }

  // Validate
  if (!month || !day || month < 1 || month > 12 || day < 1 || day > 31) return null;

  const searchKey = `${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  const displayDate = `${MONTH_NAMES[month]} ${day}${year ? ', ' + year : ''}`;

  let age = null;
  if (year) {
    const now = moment.tz(TIMEZONE);
    age = now.year() - year;
    // Subtract 1 if birthday hasn't happened yet this year
    if (now.month() + 1 < month || (now.month() + 1 === month && now.date() < day)) {
      age--;
    }
  }

  return { day, month, year: year || null, monthName: MONTH_NAMES[month], displayDate, searchKey, age };
}

// ==================== MESSAGE TEMPLATES ====================

function getBirthdayWishMessage(person) {
  const tag = `@${person.userId.split('@')[0]}`;
  const wishes = [
    `🎉🎂 HAPPY BIRTHDAY ${tag}! 🎂🎉\n\nWishing you a day filled with happiness and a year filled with joy! 🎈✨`,
    `🎊 Happy Birthday to our amazing friend ${tag}! 🎊\n\nMay your special day be surrounded with happiness, filled with laughter! 🎨🎁`,
    `🌟 It's ${tag}'s Birthday! 🌟\n\n🎂 Another year older, another year wiser, another year more awesome!\nMay all your dreams come true! ✨🎉`,
    `🎈 BIRTHDAY ALERT! 🎈\n\nIt's ${tag}'s special day! 🎂\nLet's celebrate this wonderful person who brings joy to our group! 🎊🎉`,
    `🎵 Happy Birthday to you! 🎵\n🎵 Happy Birthday dear ${tag}! 🎵\n\n🎂 Hope your day is as special as you are! 🌟`
  ];

  let msg = wishes[Math.floor(Math.random() * wishes.length)];

  if (person.birthday?.age != null) {
    msg += `\n\n🎈 Celebrating ${person.birthday.age + 1} wonderful years! 🎈`;
  }

  msg += `\n\n👏 From all of us at GIST HQ! 👏`;
  return msg;
}

function getReminderMessage(person, daysUntil) {
  const tag = `@${person.userId.split('@')[0]}`;
  let msg;

  if (daysUntil === 1) {
    msg = `🎂 *BIRTHDAY REMINDER* 🎂\n\n📅 Tomorrow is ${tag}'s birthday!\n\n🎁 Don't forget to wish them well! 🎉`;
  } else {
    msg = `🎂 *BIRTHDAY REMINDER* 🎂\n\n📅 ${tag}'s birthday is in *${daysUntil} days!*\n\n🗓️ Date: ${person.birthday.displayDate} 🎉`;
  }

  if (person.birthday?.age != null) {
    msg += `\n\n🎈 They'll be turning *${person.birthday.age + 1}*! 🎈`;
  }

  return msg;
}

// ==================== HELPERS ====================

async function safeSend(sock, jid, msgObj) {
  try {
    await sock.sendMessage(jid, msgObj);
    return true;
  } catch (e) {
    printLog('error', `[BIRTHDAY] safeSend to ${jid.split('@')[0]} failed: ${e.message}`);
    return false;
  }
}

async function getGroupParticipants(sock, groupId) {
  try {
    const meta = await sock.groupMetadata(groupId);
    if (!meta?.participants) return [];
    const botJid = sock.user.id.split(':')[0] + '@s.whatsapp.net';
    return meta.participants.map(p => p.id).filter(id => id !== botJid);
  } catch (e) {
    printLog('error', `[BIRTHDAY] getGroupParticipants error: ${e.message}`);
    return [];
  }
}

// ==================== SCHEDULED TASKS ====================

async function runBirthdayWishes(sock) {
  if (!birthdaySettings.enableAutoWishes) {
    printLog('info', '[BIRTHDAY] Auto wishes disabled, skipping');
    return;
  }

  const todaysBirthdays = await getTodaysBirthdays();
  if (todaysBirthdays.length === 0) {
    printLog('info', '[BIRTHDAY] No birthdays today');
    return;
  }

  printLog('info', `[BIRTHDAY] Processing ${todaysBirthdays.length} birthday(s) today`);

  for (const person of todaysBirthdays) {
    try {
      if (await hasWishedToday(person.userId)) {
        printLog('info', `[BIRTHDAY] Already wished ${person.name} today, skipping`);
        continue;
      }

      let sent = 0;

      // Private wish
      if (birthdaySettings.enablePrivateReminders) {
        const privateMsg = `🎉 *HAPPY BIRTHDAY ${person.name}!* 🎉\n\nToday is your special day! 🎂\n\nWishing you all the happiness in the world! ✨🎈\n\n👏 From all of us at GIST HQ!`;
        const ok = await safeSend(sock, person.userId, { text: privateMsg });
        if (ok) {
          sent++;
          printLog('success', `[BIRTHDAY] ✅ Private wish sent to ${person.name}`);
        }
        await new Promise(r => setTimeout(r, 3000));
      }

      // Group wishes
      if (birthdaySettings.enableGroupReminders && birthdaySettings.reminderGroups.length > 0) {
        const wishMsg = getBirthdayWishMessage(person);

        for (const groupId of birthdaySettings.reminderGroups) {
          const participants = await getGroupParticipants(sock, groupId);
          const mentions = [...new Set([person.userId, ...participants])];

          const ok = await safeSend(sock, groupId, { text: wishMsg, mentions });
          if (ok) {
            sent++;
            printLog('success', `[BIRTHDAY] ✅ Group wish sent to ${groupId.split('@')[0]} for ${person.name}`);
          }
          await new Promise(r => setTimeout(r, 5000));
        }
      }

      if (sent > 0) {
        await markWishedToday(person.userId, person.name, sent);
        printLog('success', `[BIRTHDAY] 🎂 ${person.name} fully processed (${sent} sends)`);
      }

      await new Promise(r => setTimeout(r, 8000));
    } catch (e) {
      printLog('error', `[BIRTHDAY] Error processing birthday for ${person.name}: ${e.message}`);
    }
  }
}

async function runBirthdayReminders(sock, daysAhead) {
  if (!birthdaySettings.enableReminders) return;
  if (!birthdaySettings.reminderDays.includes(daysAhead)) return;

  const upcoming = await getUpcomingBirthdays(daysAhead);
  if (upcoming.length === 0) {
    printLog('info', `[BIRTHDAY] No birthdays in ${daysAhead} day(s)`);
    return;
  }

  printLog('info', `[BIRTHDAY] Processing ${upcoming.length} reminder(s) for ${daysAhead} days ahead`);
  const today = moment.tz(TIMEZONE).format('YYYY-MM-DD');

  for (const person of upcoming) {
    const reminderKey = `${today}-${person.userId}-${daysAhead}`;

    try {
      if (await hasReminderSent(reminderKey)) continue;

      const reminderMsg = getReminderMessage(person, daysAhead);

      if (birthdaySettings.enableGroupReminders && birthdaySettings.reminderGroups.length > 0) {
        for (const groupId of birthdaySettings.reminderGroups) {
          const participants = await getGroupParticipants(sock, groupId);
          const mentions = [...new Set([person.userId, ...participants])];

          const ok = await safeSend(sock, groupId, { text: reminderMsg, mentions });
          if (ok) {
            printLog('success', `[BIRTHDAY] ✅ ${daysAhead}-day reminder sent for ${person.name}`);
          }
          await new Promise(r => setTimeout(r, 3000));
        }
      }

      await markReminderSent(reminderKey, person.userId, daysAhead);
    } catch (e) {
      printLog('error', `[BIRTHDAY] Error sending reminder for ${person.name}: ${e.message}`);
    }
  }
}

async function runCleanup() {
  try {
    const cutoff = moment.tz(TIMEZONE).subtract(365, 'days');

    // Clean wishes log
    const wishLog = await store.getSetting('global', KEYS.WISHES_LOG) || {};
    let wishCleaned = 0;
    for (const date of Object.keys(wishLog)) {
      if (moment.tz(date, TIMEZONE).isBefore(cutoff)) {
        delete wishLog[date];
        wishCleaned++;
      }
    }
    if (wishCleaned > 0) {
      await store.saveSetting('global', KEYS.WISHES_LOG, wishLog);
      printLog('info', `[BIRTHDAY] Cleaned ${wishCleaned} old wish log entries`);
    }

    // Clean reminders log
    const remLog = await store.getSetting('global', KEYS.REMINDERS_LOG) || {};
    let remCleaned = 0;
    for (const key of Object.keys(remLog)) {
      // Key format: "YYYY-MM-DD-userId-daysAhead"
      const dateMatch = key.match(/^(\d{4}-\d{2}-\d{2})/);
      if (dateMatch && moment.tz(dateMatch[1], TIMEZONE).isBefore(cutoff)) {
        delete remLog[key];
        remCleaned++;
      }
    }
    if (remCleaned > 0) {
      await store.saveSetting('global', KEYS.REMINDERS_LOG, remLog);
      printLog('info', `[BIRTHDAY] Cleaned ${remCleaned} old reminder log entries`);
    }
  } catch (e) {
    printLog('error', `[BIRTHDAY] Cleanup error: ${e.message}`);
  }
}

/**
 * Start the birthday scheduler.
 * Must be called with a connected `sock`.
 * Idempotent — safe to call multiple times.
 * @param {object} sock - Baileys socket
 */
function startScheduler(sock) {
  if (schedulerStarted) return;
  schedulerStarted = true;

  printLog('info', '[BIRTHDAY] ⏰ Scheduler started (checking every minute)');

  setInterval(async () => {
    try {
      if (!birthdaySettings.loaded) await loadSettings();

      const now = moment.tz(TIMEZONE);
      const timeStr = now.format('HH:mm');
      const dayOfWeek = now.day(); // 0 = Sunday

      // Birthday wishes at configured wish time (default 00:01)
      if (timeStr === birthdaySettings.wishTime) {
        const runKey = `wishes_${now.format('YYYY-MM-DD')}`;
        if (!lastSchedulerRun[runKey]) {
          lastSchedulerRun[runKey] = true;
          printLog('info', `[BIRTHDAY] 🎂 Running scheduled birthday wishes at ${timeStr}`);
          await runBirthdayWishes(sock);
        }
      }

      // Reminders at configured reminder time (default 09:00)
      if (timeStr === birthdaySettings.reminderTime) {
        for (const days of birthdaySettings.reminderDays) {
          const runKey = `reminder_${days}_${now.format('YYYY-MM-DD')}`;
          if (!lastSchedulerRun[runKey]) {
            lastSchedulerRun[runKey] = true;
            await runBirthdayReminders(sock, days);
          }
        }
      }

      // Cleanup: Sundays at 02:00
      if (dayOfWeek === 0 && timeStr === '02:00') {
        const runKey = `cleanup_${now.format('YYYY-MM-DD')}`;
        if (!lastSchedulerRun[runKey]) {
          lastSchedulerRun[runKey] = true;
          printLog('info', '[BIRTHDAY] 🗑️ Running weekly cleanup');
          await runCleanup();
        }
      }

      // Prune lastSchedulerRun to prevent unbounded growth
      // Keep only entries from the last 2 days
      const twoDaysAgo = moment.tz(TIMEZONE).subtract(2, 'days').format('YYYY-MM-DD');
      for (const key of Object.keys(lastSchedulerRun)) {
        const dateMatch = key.match(/(\d{4}-\d{2}-\d{2})$/);
        if (dateMatch && dateMatch[1] < twoDaysAgo) {
          delete lastSchedulerRun[key];
        }
      }
    } catch (e) {
      printLog('error', `[BIRTHDAY] Scheduler error: ${e.message}`);
    }
  }, 60 * 1000);
}

// ==================== COMMAND HANDLERS ====================

async function handleBirthdayCommand(sock, message, args, context) {
  const { chatId, senderId, isGroup, senderIsOwnerOrSudo, isSenderAdmin, channelInfo } = context;

  // Ensure settings are loaded
  if (!birthdaySettings.loaded) await loadSettings();

  // Start scheduler on first command (idempotent)
  startScheduler(sock);

  // Detect if invoked as .mybirthday / .mybday
  // args will be empty and userMessage will start with the alias
  const invokedCmd = context.userMessage.trim().split(/\s+/)[0].replace(/^[.!#\/]/, '');
  const isMyBirthdayCmd = ['mybirthday', 'mybday'].includes(invokedCmd);

  if (isMyBirthdayCmd) {
    return await handleMyBirthday(sock, message, senderId, chatId, channelInfo);
  }

  // No sub-command → show menu
  if (args.length === 0) {
    return await showBirthdayMenu(sock, message, chatId, channelInfo);
  }

  const sub = args[0].toLowerCase();
  const subArgs = args.slice(1);

  switch (sub) {
    case 'today':
      return await handleToday(sock, message, chatId, channelInfo);

    case 'upcoming':
      return await handleUpcoming(sock, message, chatId, subArgs, channelInfo);

    case 'thismonth':
      return await handleThisMonth(sock, message, chatId, channelInfo);

    case 'all':
      if (!senderIsOwnerOrSudo && !isSenderAdmin) {
        return sock.sendMessage(chatId, {
          text: '🚫 Only admins can view all birthdays.',
          ...channelInfo
        }, { quoted: message });
      }
      return await handleAll(sock, message, chatId, channelInfo);

    case 'settings':
      if (!senderIsOwnerOrSudo) {
        return sock.sendMessage(chatId, {
          text: '🚫 Only the owner/sudo can modify birthday settings.',
          ...channelInfo
        }, { quoted: message });
      }
      return await handleSettings(sock, message, chatId, subArgs, channelInfo);

    case 'groups':
      if (!senderIsOwnerOrSudo) {
        return sock.sendMessage(chatId, {
          text: '🚫 Only the owner/sudo can manage birthday groups.',
          ...channelInfo
        }, { quoted: message });
      }
      return await handleGroups(sock, message, chatId, isGroup, subArgs, channelInfo);

    case 'force':
      if (!senderIsOwnerOrSudo) {
        return sock.sendMessage(chatId, {
          text: '🚫 Only the owner/sudo can force birthday tasks.',
          ...channelInfo
        }, { quoted: message });
      }
      return await handleForce(sock, message, chatId, subArgs, channelInfo);

    case 'status':
      return await handleStatus(sock, message, chatId, channelInfo);

    case 'test':
      if (!senderIsOwnerOrSudo && !isSenderAdmin) {
        return sock.sendMessage(chatId, {
          text: '🚫 Only admins can test birthday wishes.',
          ...channelInfo
        }, { quoted: message });
      }
      return await handleTest(sock, message, chatId, isGroup, channelInfo);

    case 'help':
      return await showBirthdayMenu(sock, message, chatId, channelInfo);

    default:
      return sock.sendMessage(chatId, {
        text: `❓ Unknown birthday command: *${sub}*\n\nUse *.birthday help* to see available commands.`,
        ...channelInfo
      }, { quoted: message });
  }
}

// ---- Sub-handlers ----

async function showBirthdayMenu(sock, message, chatId, channelInfo) {
  const menu =
    `🎂 *BIRTHDAY SYSTEM* 🎂\n\n` +
    `📅 *View Commands:*\n` +
    `• *.birthday today* — Today's birthdays\n` +
    `• *.birthday upcoming [days]* — Upcoming birthdays (default 7)\n` +
    `• *.birthday thismonth* — This month's birthdays\n` +
    `• *.birthday status* — System status\n` +
    `• *.mybirthday* — View your birthday info\n\n` +
    `👑 *Admin Commands:*\n` +
    `• *.birthday all* — View all recorded birthdays\n` +
    `• *.birthday settings* — View/change settings\n` +
    `• *.birthday groups* — Manage reminder groups\n` +
    `• *.birthday force wishes* — Force today's wishes\n` +
    `• *.birthday force reminders [days]* — Force reminders\n` +
    `• *.birthday test [@user]* — Test birthday wish\n\n` +
    `🤖 *Auto Features:*\n` +
    `• Birthdays auto-saved from attendance forms\n` +
    `• Scheduled wishes at midnight (WAT)\n` +
    `• Advance reminders 7, 3 & 1 day(s) before\n` +
    `• Weekly cleanup every Sunday at 02:00\n\n` +
    `🌍 Timezone: Africa/Lagos (WAT)`;

  await sock.sendMessage(chatId, { text: menu, ...channelInfo }, { quoted: message });
}

async function handleMyBirthday(sock, message, senderId, chatId, channelInfo) {
  const data = await getBirthdayData(senderId);

  if (!data) {
    return sock.sendMessage(chatId, {
      text:
        `🎂 *No Birthday Recorded*\n\n` +
        `Your birthday hasn't been saved yet.\n\n` +
        `💡 It is saved automatically when you submit an attendance form with your D.O.B.`,
      ...channelInfo
    }, { quoted: message });
  }

  const b = data.birthday;
  const now = moment.tz(TIMEZONE);
  const nextBday = moment.tz({ year: now.year(), month: b.month - 1, date: b.day }, TIMEZONE);
  if (nextBday.isBefore(now, 'day')) nextBday.add(1, 'year');
  const daysUntil = nextBday.diff(now, 'days');

  let msg = `🎂 *Your Birthday Information* 🎂\n\n`;
  msg += `👤 Name: ${data.name}\n`;
  msg += `📅 Birthday: ${b.displayDate}\n`;
  msg += `📊 Day: ${b.day}\n`;
  msg += `📊 Month: ${b.monthName}\n`;
  if (b.year) msg += `📊 Year: ${b.year}\n`;
  if (b.age != null) msg += `🎈 Current Age: ${b.age} years old\n`;
  msg += `💾 Last Updated: ${new Date(data.lastUpdated).toLocaleString('en-NG', { timeZone: TIMEZONE })}\n\n`;

  if (daysUntil === 0) {
    msg += `🎉 *IT'S YOUR BIRTHDAY TODAY!* 🎉\n🎊 *HAPPY BIRTHDAY!* 🎊`;
  } else if (daysUntil === 1) {
    msg += `🎂 *Your birthday is TOMORROW!* 🎂`;
  } else if (daysUntil <= 7) {
    msg += `🗓 *Your birthday is in ${daysUntil} days!*`;
  } else {
    msg += `📅 Days until next birthday: *${daysUntil}*`;
  }

  await sock.sendMessage(chatId, { text: msg, ...channelInfo }, { quoted: message });
}

async function handleToday(sock, message, chatId, channelInfo) {
  const list = await getTodaysBirthdays();

  if (list.length === 0) {
    return sock.sendMessage(chatId, {
      text: `🎂 *No birthdays today*\n\n📅 Check upcoming: *.birthday upcoming*`,
      ...channelInfo
    }, { quoted: message });
  }

  let msg = `🎉 *TODAY'S BIRTHDAYS* 🎉\n\n`;
  const mentions = [];

  list.forEach(p => {
    mentions.push(p.userId);
    msg += `🎂 @${p.userId.split('@')[0]}`;
    if (p.birthday.age != null) msg += ` *(Turning ${p.birthday.age + 1}!)*`;
    msg += '\n';
  });

  msg += `\n🎊 *Let's wish them a happy birthday!* 🎊`;
  await sock.sendMessage(chatId, { text: msg, mentions, ...channelInfo }, { quoted: message });
}

async function handleUpcoming(sock, message, chatId, args, channelInfo) {
  const days = args[0] ? parseInt(args[0]) : 7;
  if (isNaN(days) || days < 1 || days > 365) {
    return sock.sendMessage(chatId, {
      text: '⚠️ Please provide a valid number of days (1-365)',
      ...channelInfo
    }, { quoted: message });
  }

  const birthdays = await getAllBirthdays();
  const now = moment.tz(TIMEZONE);
  const upcomingList = [];

  Object.values(birthdays).forEach(entry => {
    const b = entry.birthday;
    const nextBday = moment.tz({ year: now.year(), month: b.month - 1, date: b.day }, TIMEZONE);
    if (nextBday.isBefore(now, 'day')) nextBday.add(1, 'year');
    const daysUntil = nextBday.diff(now, 'days');
    if (daysUntil >= 0 && daysUntil <= days) {
      upcomingList.push({ ...entry, daysUntil });
    }
  });

  if (upcomingList.length === 0) {
    return sock.sendMessage(chatId, {
      text: `📅 *No birthdays in the next ${days} days*`,
      ...channelInfo
    }, { quoted: message });
  }

  upcomingList.sort((a, b) => a.daysUntil - b.daysUntil);

  let msg = `📅 *UPCOMING BIRTHDAYS (Next ${days} days)* 📅\n\n`;
  const mentions = [];

  upcomingList.forEach(u => {
    mentions.push(u.userId);
    if (u.daysUntil === 0) {
      msg += `🎊 @${u.userId.split('@')[0]} — *TODAY!* 🎊\n`;
    } else if (u.daysUntil === 1) {
      msg += `🎂 @${u.userId.split('@')[0]} — Tomorrow\n`;
    } else {
      msg += `📌 @${u.userId.split('@')[0]} — in ${u.daysUntil} days (${u.birthday.monthName} ${u.birthday.day})\n`;
    }
    if (u.birthday.age != null) {
      const age = u.daysUntil === 0 ? u.birthday.age : u.birthday.age + 1;
      const verb = u.daysUntil === 0 ? 'Turned' : 'Turning';
      msg += `   🎈 ${verb} ${age}\n`;
    }
  });

  await sock.sendMessage(chatId, { text: msg, mentions, ...channelInfo }, { quoted: message });
}

async function handleThisMonth(sock, message, chatId, channelInfo) {
  const now = moment.tz(TIMEZONE);
  const currentMonth = now.month() + 1;
  const birthdays = await getAllBirthdays();

  const list = Object.values(birthdays)
    .filter(b => b.birthday.month === currentMonth)
    .sort((a, b) => a.birthday.day - b.birthday.day);

  const monthName = now.format('MMMM YYYY');

  if (list.length === 0) {
    return sock.sendMessage(chatId, {
      text: `📅 *No birthdays in ${monthName}*\n\nTry *.birthday upcoming* or *.birthday all*`,
      ...channelInfo
    }, { quoted: message });
  }

  let msg = `📅 *${monthName.toUpperCase()} BIRTHDAYS* 📅\n\n`;
  const mentions = [];

  list.forEach(p => {
    mentions.push(p.userId);
    msg += `🎂 @${p.userId.split('@')[0]} — ${p.birthday.monthName} ${p.birthday.day}`;
    if (p.birthday.age != null) msg += ` (${p.birthday.age} yrs)`;

    if (p.birthday.day === now.date()) {
      msg += ` 🎊 TODAY!`;
    } else if (p.birthday.day < now.date()) {
      msg += ` ✅ Celebrated`;
    } else {
      msg += ` (${p.birthday.day - now.date()} days away)`;
    }
    msg += '\n';
  });

  await sock.sendMessage(chatId, { text: msg, mentions, ...channelInfo }, { quoted: message });
}

async function handleAll(sock, message, chatId, channelInfo) {
  const birthdays = await getAllBirthdays();
  const list = Object.values(birthdays).sort((a, b) => {
    if (a.birthday.month !== b.birthday.month) return a.birthday.month - b.birthday.month;
    return a.birthday.day - b.birthday.day;
  });

  if (list.length === 0) {
    return sock.sendMessage(chatId, {
      text: `🎂 *No birthdays recorded yet*\n\n💡 Birthdays are saved automatically from attendance forms.`,
      ...channelInfo
    }, { quoted: message });
  }

  let msg = `🎂 *ALL BIRTHDAYS* 🎂\n\n📊 Total: *${list.length} members*\n`;
  const mentions = [];
  let currentMonth = null;

  list.forEach(p => {
    mentions.push(p.userId);
    if (currentMonth !== p.birthday.month) {
      currentMonth = p.birthday.month;
      msg += `\n📅 *${p.birthday.monthName.toUpperCase()}*\n`;
    }
    msg += `🎂 @${p.userId.split('@')[0]} — ${p.birthday.day}`;
    if (p.birthday.age != null) msg += ` (${p.birthday.age} yrs)`;
    msg += '\n';
  });

  await sock.sendMessage(chatId, { text: msg, mentions, ...channelInfo }, { quoted: message });
}

async function handleStatus(sock, message, chatId, channelInfo) {
  await loadSettings();

  const [todayList, upcoming1, upcoming3, upcoming7, allBdays] = await Promise.all([
    getTodaysBirthdays(),
    getUpcomingBirthdays(1),
    getUpcomingBirthdays(3),
    getUpcomingBirthdays(7),
    getAllBirthdays()
  ]);

  const now = moment.tz(TIMEZONE);

  let msg = `📊 *BIRTHDAY SYSTEM STATUS* 📊\n\n`;
  msg += `⏰ Time (WAT): ${now.format('YYYY-MM-DD HH:mm:ss')}\n`;
  msg += `🤖 Scheduler: ${schedulerStarted ? '✅ Running' : '⚠️ Not started yet'}\n\n`;
  msg += `📊 *Registered Birthdays:* ${Object.keys(allBdays).length}\n`;
  msg += `• Today: ${todayList.length}\n`;
  msg += `• Tomorrow: ${upcoming1.length}\n`;
  msg += `• Next 3 days: ${upcoming3.length}\n`;
  msg += `• Next 7 days: ${upcoming7.length}\n\n`;
  msg += `⚙️ *Settings:*\n`;
  msg += `• Auto Wishes: ${birthdaySettings.enableAutoWishes ? '✅' : '❌'} at ${birthdaySettings.wishTime}\n`;
  msg += `• Reminders: ${birthdaySettings.enableReminders ? '✅' : '❌'} at ${birthdaySettings.reminderTime}\n`;
  msg += `• Group Reminders: ${birthdaySettings.enableGroupReminders ? '✅' : '❌'}\n`;
  msg += `• Private Wishes: ${birthdaySettings.enablePrivateReminders ? '✅' : '❌'}\n`;
  msg += `• Reminder Days: ${birthdaySettings.reminderDays.join(', ')}\n`;
  msg += `• Groups: ${birthdaySettings.reminderGroups.length}`;

  await sock.sendMessage(chatId, { text: msg, ...channelInfo }, { quoted: message });
}

async function handleTest(sock, message, chatId, isGroup, channelInfo) {
  if (!isGroup) {
    return sock.sendMessage(chatId, {
      text: '⚠️ This command must be used in a group.',
      ...channelInfo
    }, { quoted: message });
  }

  // Get mentioned user or default to sender
  const mentionedJid = message.message?.extendedTextMessage?.contextInfo?.mentionedJid;
  let targetUserId = message.key.participant || message.key.remoteJid;
  let targetName = targetUserId.split('@')[0];

  if (mentionedJid?.length > 0) {
    targetUserId = mentionedJid[0];
    const data = await getBirthdayData(targetUserId);
    targetName = data ? data.name : targetUserId.split('@')[0];
  } else {
    const data = await getBirthdayData(targetUserId);
    if (data) targetName = data.name;
  }

  await sock.sendMessage(chatId, {
    text: `🧪 Testing birthday wish for *${targetName}*...\n\nSending in 3 seconds...`,
    ...channelInfo
  }, { quoted: message });

  await new Promise(r => setTimeout(r, 3000));

  const testPerson = {
    userId: targetUserId,
    name: targetName,
    birthday: { age: null, displayDate: moment.tz(TIMEZONE).format('MMMM DD') }
  };

  const wishMessage = getBirthdayWishMessage(testPerson);
  const participants = await getGroupParticipants(sock, chatId);
  const mentions = [...new Set([targetUserId, ...participants])];

  const ok = await safeSend(sock, chatId, {
    text: `🧪 *TEST MODE* 🧪\n\n${wishMessage}\n\n_This is a test. No actual birthday today._`,
    mentions
  });

  if (ok) {
    printLog('success', `[BIRTHDAY] Test wish sent for ${targetName}`);
  }
}

async function handleForce(sock, message, chatId, args, channelInfo) {
  if (!args[0]) {
    return sock.sendMessage(chatId, {
      text:
        `🔧 *FORCE COMMANDS*\n\n` +
        `• *.birthday force wishes* — Force today's birthday wishes\n` +
        `• *.birthday force reminders [days]* — Force reminders\n` +
        `• *.birthday force cleanup* — Force log cleanup`,
      ...channelInfo
    }, { quoted: message });
  }

  const type = args[0].toLowerCase();

  if (type === 'wishes') {
    await sock.sendMessage(chatId, { text: '🔧 Forcing birthday wishes...', ...channelInfo }, { quoted: message });
    // Clear today's run key so it re-runs
    const today = moment.tz(TIMEZONE).format('YYYY-MM-DD');
    delete lastSchedulerRun[`wishes_${today}`];
    await runBirthdayWishes(sock);
    return sock.sendMessage(chatId, { text: '✅ Forced birthday wishes completed!', ...channelInfo }, { quoted: message });
  }

  if (type === 'reminders') {
    const days = args[1] ? parseInt(args[1]) : 7;
    if (isNaN(days)) {
      return sock.sendMessage(chatId, { text: '❌ Invalid days parameter', ...channelInfo }, { quoted: message });
    }
    await sock.sendMessage(chatId, { text: `🔧 Forcing ${days}-day reminders...`, ...channelInfo }, { quoted: message });
    const today = moment.tz(TIMEZONE).format('YYYY-MM-DD');
    delete lastSchedulerRun[`reminder_${days}_${today}`];
    await runBirthdayReminders(sock, days);
    return sock.sendMessage(chatId, { text: `✅ Forced ${days}-day reminders completed!`, ...channelInfo }, { quoted: message });
  }

  if (type === 'cleanup') {
    await sock.sendMessage(chatId, { text: '🔧 Running cleanup...', ...channelInfo }, { quoted: message });
    await runCleanup();
    return sock.sendMessage(chatId, { text: '✅ Cleanup completed!', ...channelInfo }, { quoted: message });
  }

  return sock.sendMessage(chatId, {
    text: `❓ Unknown force command: *${type}*`,
    ...channelInfo
  }, { quoted: message });
}

async function handleSettings(sock, message, chatId, args, channelInfo) {
  if (args.length === 0) {
    return await showSettingsMenu(sock, message, chatId, channelInfo);
  }

  const setting = args[0].toLowerCase();
  const value = args.slice(1).join(' ').trim();

  switch (setting) {
    case 'reminders':
      birthdaySettings.enableReminders = value === 'on';
      await saveSettings();
      return sock.sendMessage(chatId, {
        text: `✅ Reminders *${birthdaySettings.enableReminders ? 'enabled' : 'disabled'}*!`,
        ...channelInfo
      }, { quoted: message });

    case 'wishes':
      birthdaySettings.enableAutoWishes = value === 'on';
      await saveSettings();
      return sock.sendMessage(chatId, {
        text: `✅ Auto wishes *${birthdaySettings.enableAutoWishes ? 'enabled' : 'disabled'}*!`,
        ...channelInfo
      }, { quoted: message });

    case 'groupreminders':
      birthdaySettings.enableGroupReminders = value === 'on';
      await saveSettings();
      return sock.sendMessage(chatId, {
        text: `✅ Group reminders *${birthdaySettings.enableGroupReminders ? 'enabled' : 'disabled'}*!`,
        ...channelInfo
      }, { quoted: message });

    case 'privatereminders':
      birthdaySettings.enablePrivateReminders = value === 'on';
      await saveSettings();
      return sock.sendMessage(chatId, {
        text: `✅ Private reminders *${birthdaySettings.enablePrivateReminders ? 'enabled' : 'disabled'}*!`,
        ...channelInfo
      }, { quoted: message });

    case 'wishtime':
      if (!/^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/.test(value)) {
        return sock.sendMessage(chatId, {
          text: '⚠️ Invalid time format. Use HH:MM (e.g. 00:01)',
          ...channelInfo
        }, { quoted: message });
      }
      birthdaySettings.wishTime = value;
      await saveSettings();
      return sock.sendMessage(chatId, { text: `✅ Wish time set to *${value}*!`, ...channelInfo }, { quoted: message });

    case 'remindertime':
      if (!/^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/.test(value)) {
        return sock.sendMessage(chatId, {
          text: '⚠️ Invalid time format. Use HH:MM (e.g. 09:00)',
          ...channelInfo
        }, { quoted: message });
      }
      birthdaySettings.reminderTime = value;
      await saveSettings();
      return sock.sendMessage(chatId, { text: `✅ Reminder time set to *${value}*!`, ...channelInfo }, { quoted: message });

    case 'reminderdays': {
      const days = value.split(',')
        .map(d => parseInt(d.trim()))
        .filter(d => !isNaN(d) && d >= 1 && d <= 365);

      if (days.length === 0) {
        return sock.sendMessage(chatId, {
          text: '⚠️ Invalid days. Use comma-separated numbers, e.g. *7,3,1*',
          ...channelInfo
        }, { quoted: message });
      }
      birthdaySettings.reminderDays = days.sort((a, b) => b - a);
      await saveSettings();
      return sock.sendMessage(chatId, {
        text: `✅ Reminder days set to *${days.join(', ')}*!`,
        ...channelInfo
      }, { quoted: message });
    }

    case 'reload':
      await loadSettings();
      return sock.sendMessage(chatId, { text: '✅ Birthday settings reloaded!', ...channelInfo }, { quoted: message });

    default:
      return sock.sendMessage(chatId, {
        text: `❓ Unknown setting: *${setting}*\n\nUse *.birthday settings* to see options.`,
        ...channelInfo
      }, { quoted: message });
  }
}

async function showSettingsMenu(sock, message, chatId, channelInfo) {
  const s = birthdaySettings;
  let msg = `⚙️ *BIRTHDAY SETTINGS* ⚙️\n\n`;
  msg += `🔔 Reminders: ${s.enableReminders ? '✅ ON' : '❌ OFF'}\n`;
  msg += `🎉 Auto Wishes: ${s.enableAutoWishes ? '✅ ON' : '❌ OFF'}\n`;
  msg += `👥 Group Reminders: ${s.enableGroupReminders ? '✅ ON' : '❌ OFF'}\n`;
  msg += `💬 Private Reminders: ${s.enablePrivateReminders ? '✅ ON' : '❌ OFF'}\n`;
  msg += `⏰ Wish Time (WAT): ${s.wishTime}\n`;
  msg += `🔔 Reminder Time (WAT): ${s.reminderTime}\n`;
  msg += `📅 Reminder Days: ${s.reminderDays.join(', ')} days before\n`;
  msg += `👥 Groups: ${s.reminderGroups.length}\n\n`;
  msg += `🔧 *Change Settings:*\n`;
  msg += `• *.birthday settings reminders on/off*\n`;
  msg += `• *.birthday settings wishes on/off*\n`;
  msg += `• *.birthday settings groupreminders on/off*\n`;
  msg += `• *.birthday settings privatereminders on/off*\n`;
  msg += `• *.birthday settings wishtime HH:MM*\n`;
  msg += `• *.birthday settings remindertime HH:MM*\n`;
  msg += `• *.birthday settings reminderdays 7,3,1*\n`;
  msg += `• *.birthday settings reload*`;

  await sock.sendMessage(chatId, { text: msg, ...channelInfo }, { quoted: message });
}

async function handleGroups(sock, message, chatId, isGroup, args, channelInfo) {
  if (args.length === 0) {
    return await showGroups(sock, message, chatId, channelInfo);
  }

  const action = args[0].toLowerCase();

  if (action === 'add') {
    if (!isGroup) {
      return sock.sendMessage(chatId, {
        text: '⚠️ Run this command *inside the group* you want to add.',
        ...channelInfo
      }, { quoted: message });
    }
    if (birthdaySettings.reminderGroups.includes(chatId)) {
      return sock.sendMessage(chatId, { text: '⚠️ This group is already added.', ...channelInfo }, { quoted: message });
    }
    birthdaySettings.reminderGroups.push(chatId);
    await saveSettings();
    return sock.sendMessage(chatId, {
      text: `✅ Group *${chatId.split('@')[0]}* added for birthday reminders!\n\n🎂 This group will now receive birthday wishes and reminders.`,
      ...channelInfo
    }, { quoted: message });
  }

  if (action === 'remove') {
    const groupArg = args[1];
    if (!groupArg) {
      return sock.sendMessage(chatId, {
        text: '⚠️ Specify a group ID to remove.\n\nExample: *.birthday groups remove 1234567890*',
        ...channelInfo
      }, { quoted: message });
    }
    const idx = birthdaySettings.reminderGroups.findIndex(g => g.includes(groupArg));
    if (idx === -1) {
      return sock.sendMessage(chatId, {
        text: `⚠️ Group not found: *${groupArg}*\n\nUse *.birthday groups* to see configured groups.`,
        ...channelInfo
      }, { quoted: message });
    }
    const removed = birthdaySettings.reminderGroups.splice(idx, 1)[0];
    await saveSettings();
    return sock.sendMessage(chatId, {
      text: `✅ Group *${removed.split('@')[0]}* removed from birthday reminders!`,
      ...channelInfo
    }, { quoted: message });
  }

  if (action === 'clear') {
    const count = birthdaySettings.reminderGroups.length;
    if (count === 0) {
      return sock.sendMessage(chatId, { text: '📝 No groups are currently configured.', ...channelInfo }, { quoted: message });
    }
    birthdaySettings.reminderGroups = [];
    await saveSettings();
    return sock.sendMessage(chatId, {
      text: `✅ Cleared all *${count}* group(s) from birthday reminders!`,
      ...channelInfo
    }, { quoted: message });
  }

  return await showGroups(sock, message, chatId, channelInfo);
}

async function showGroups(sock, message, chatId, channelInfo) {
  const groups = birthdaySettings.reminderGroups;
  let msg = `👥 *BIRTHDAY REMINDER GROUPS* 👥\n\n`;

  if (groups.length === 0) {
    msg += `📝 No groups configured for birthday reminders.\n\n`;
  } else {
    msg += `📊 Total: ${groups.length}\n\n`;
    groups.forEach((g, i) => {
      msg += `${i + 1}. ${g.split('@')[0]}\n`;
    });
    msg += '\n';
  }

  msg += `🔧 *Commands:*\n`;
  msg += `• *.birthday groups add* — Add current group\n`;
  msg += `• *.birthday groups remove [groupId]* — Remove a group\n`;
  msg += `• *.birthday groups clear* — Remove all groups\n\n`;
  msg += `💡 Run *.birthday groups add* while inside the group you want to add.`;

  await sock.sendMessage(chatId, { text: msg, ...channelInfo }, { quoted: message });
}

// ==================== EXPORTS ====================

module.exports = {
  // Command registration (picked up by commandHandler.js)
  command: 'birthday',
  aliases: ['bday', 'birthdays', 'mybirthday', 'mybday'],
  description: 'Birthday system — auto wishes, reminders, and tracking',
  category: 'social',
  handler: handleBirthdayCommand,

  // Public API — used by attendance.js to save DOB from forms
  saveBirthdayData,
  getBirthdayData,
  getAllBirthdays,
  getTodaysBirthdays,
  getUpcomingBirthdays,
  parseDOB,

  // Called from index.js after bot connects (to start scheduler early)
  startScheduler
};