// plugins/birthday.js

"use strict";

const cron = require('node-cron');
const { printLog } = require("../lib/print");
const moment = require("moment-timezone");
const isOwnerOrSudo = require("../lib/isOwner");
const isAdmin = require("../lib/isAdmin");
const { createStore } = require('../lib/pluginStore');
const bus = require('../lib/pluginBus');

const TIMEZONE = "Africa/Lagos";

const DEFAULT_SETTINGS = {
  enableReminders: true,
  enableAutoWishes: true,
  reminderDays: [7, 3, 1],
  reminderTime: "09:00",
  wishTime: "00:01",
  enableGroupReminders: true,
  enablePrivateReminders: true,
  reminderGroups: [],
  adminNumbers: [],
};

const MONTH_NAMES = [
  "",
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

const MONTH_MAP = {
  january: 1,
  february: 2,
  march: 3,
  april: 4,
  may: 5,
  june: 6,
  july: 7,
  august: 8,
  september: 9,
  october: 10,
  november: 11,
  december: 12,
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  oct: 10,
  nov: 11,
  dec: 12,
};

// ==================== NEW STORAGE (identical pattern as attendance.js) ====================
const db = createStore('birthdays');
const dbSettings     = db.table('settings');
const dbBirthdays    = db.table('birthdays');
const dbWishesLog    = db.table('wishes_log');
const dbRemindersLog = db.table('reminders_log');

let birthdaySettings = { ...DEFAULT_SETTINGS, loaded: false };
let schedulerStarted = false;
let cronJobs = new Map();
let lastSchedulerRun = {};

// ==================== STORAGE FUNCTIONS ====================
async function loadSettings() {
  try {
    const saved = await dbSettings.get('config');
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
    await dbSettings.set('config', toSave);
  } catch (e) {
    printLog('error', `[BIRTHDAY] saveSettings error: ${e.message}`);
  }
}

async function getAllBirthdays() {
  try {
    return await dbBirthdays.get('all') || {};
  } catch (e) {
    printLog('error', `[BIRTHDAY] getAllBirthdays error: ${e.message}`);
    return {};
  }
}

async function saveBirthdayData(userId, name, dobStringOrParsed) {
  try {
    let parsed;
    if (typeof dobStringOrParsed === 'string') {
      parsed = parseDOB(dobStringOrParsed);
    } else {
      parsed = dobStringOrParsed;   // already parsed from attendance bus
    }
    if (!parsed) {
      printLog('warning', `[BIRTHDAY] Could not parse DOB for ${name}`);
      return false;
    }
    const birthdays = await getAllBirthdays();
    birthdays[userId] = { userId, name, birthday: parsed, lastUpdated: new Date().toISOString() };
    await dbBirthdays.set('all', birthdays);
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
    return null;
  }
}

async function getTodaysBirthdays() { /* unchanged – uses getAllBirthdays */ 
  try {
    const now = moment.tz(TIMEZONE);
    const searchKey = `${String(now.month() + 1).padStart(2, '0')}-${String(now.date()).padStart(2, '0')}`;
    const birthdays = await getAllBirthdays();
    return Object.values(birthdays).filter(b => b.birthday?.searchKey === searchKey);
  } catch (e) { return []; }
}

async function getUpcomingBirthdays(daysAhead) { /* unchanged */ 
  try {
    const target = moment.tz(TIMEZONE).add(daysAhead, 'days');
    const searchKey = `${String(target.month() + 1).padStart(2, '0')}-${String(target.date()).padStart(2, '0')}`;
    const birthdays = await getAllBirthdays();
    return Object.values(birthdays).filter(b => b.birthday?.searchKey === searchKey);
  } catch (e) { return []; }
}

async function hasWishedToday(userId) {
  try {
    const today = moment.tz(TIMEZONE).format('YYYY-MM-DD');
    const log = await dbWishesLog.get('log') || {};
    return !!(log[today]?.[userId]);
  } catch (e) { return false; }
}

async function markWishedToday(userId, name, successfulSends) {
  try {
    const today = moment.tz(TIMEZONE).format('YYYY-MM-DD');
    const log = await dbWishesLog.get('log') || {};
    if (!log[today]) log[today] = {};
    log[today][userId] = { name, timestamp: new Date().toISOString(), successfulSends };
    await dbWishesLog.set('log', log);
  } catch (e) {}
}

async function hasReminderSent(reminderKey) {
  try {
    const log = await dbRemindersLog.get('log') || {};
    return !!log[reminderKey];
  } catch (e) { return false; }
}

async function markReminderSent(reminderKey, userId, daysAhead) {
  try {
    const log = await dbRemindersLog.get('log') || {};
    log[reminderKey] = { userId, daysAhead, timestamp: new Date().toISOString() };
    await dbRemindersLog.set('log', log);
  } catch (e) {}
}

async function runCleanup() {
  try {
    const cutoff = moment.tz(TIMEZONE).subtract(365, 'days');
    const wishLog = await dbWishesLog.get('log') || {};
    let wishCleaned = 0;
    for (const date of Object.keys(wishLog)) {
      if (moment.tz(date, TIMEZONE).isBefore(cutoff)) { delete wishLog[date]; wishCleaned++; }
    }
    if (wishCleaned > 0) await dbWishesLog.set('log', wishLog);

    const remLog = await dbRemindersLog.get('log') || {};
    let remCleaned = 0;
    for (const key of Object.keys(remLog)) {
      const dateMatch = key.match(/^(\d{4}-\d{2}-\d{2})/);
      if (dateMatch && moment.tz(dateMatch[1], TIMEZONE).isBefore(cutoff)) { delete remLog[key]; remCleaned++; }
    }
    if (remCleaned > 0) await dbRemindersLog.set('log', remLog);
  } catch (e) {
    printLog('error', `[BIRTHDAY] Cleanup error: ${e.message}`);
  }
}


// ==================== AUTH — mirrors antilink.js exactly ====================
/**
 * Always uses message.key for senderId, never trusts context properties.
 * @returns {{ isOwner: boolean, isSenderAdmin: boolean }}
 */
async function resolveAuth(senderId, sock, chatId) {
  const isOwner = await isOwnerOrSudo(senderId, sock, chatId);

  let isSenderAdmin = false;
  if (chatId && chatId.endsWith("@g.us")) {
    try {
      const result = await isAdmin(sock, chatId, senderId);
      isSenderAdmin = result.isSenderAdmin;
    } catch (e) {
      printLog("error", `[BIRTHDAY] isAdmin error: ${e.message}`);
    }
  }

  return { isOwner, isSenderAdmin };
}

// ==================== DATE PARSING ====================

function parseDOB(dobString) {
  if (!dobString || typeof dobString !== "string") return null;
  const clean = dobString.replace(/\*/g, "").replace(/\s+/g, " ").trim();
  let day, month, year;

  const verboseMatch = clean.match(/([a-zA-Z]+)\s+(\d{1,2})(?:[,\s]+(\d{4}))?/);
  if (verboseMatch) {
    const monthKey = verboseMatch[1].toLowerCase();
    month = MONTH_MAP[monthKey];
    day = parseInt(verboseMatch[2]);
    year = verboseMatch[3] ? parseInt(verboseMatch[3]) : null;
  }

  if (!month) {
    const numericMatch = clean.match(
      /(\d{1,4})[\/\-\.](\d{1,2})(?:[\/\-\.](\d{1,4}))?/,
    );
    if (numericMatch) {
      const a = parseInt(numericMatch[1]);
      const b = parseInt(numericMatch[2]);
      const c = numericMatch[3] ? parseInt(numericMatch[3]) : null;
      if (a > 31) {
        year = a;
        month = b;
        day = c;
      } else if (c && c > 31) {
        day = a;
        month = b;
        year = c;
      } else if (!c) {
        day = a;
        month = b;
        year = null;
      } else {
        day = a;
        month = b;
        year = c < 100 ? 2000 + c : c;
      }
    }
  }

  if (!month || !day || month < 1 || month > 12 || day < 1 || day > 31)
    return null;

  const searchKey = `${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  const displayDate = `${MONTH_NAMES[month]} ${day}${year ? ", " + year : ""}`;

  let age = null;
  if (year) {
    const now = moment.tz(TIMEZONE);
    age = now.year() - year;
    if (
      now.month() + 1 < month ||
      (now.month() + 1 === month && now.date() < day)
    )
      age--;
  }

  return {
    day,
    month,
    year: year || null,
    monthName: MONTH_NAMES[month],
    displayDate,
    searchKey,
    age,
  };
}

// ==================== MESSAGE TEMPLATES ====================

function getBirthdayWishMessage(person) {
  const tag = `@${person.userId.split("@")[0]}`;
  const wishes = [
    `🎉🎂 HAPPY BIRTHDAY ${tag}! 🎂🎉\n\nWishing you a day filled with happiness and a year filled with joy! 🎈✨`,
    `🎊 Happy Birthday to our amazing friend ${tag}! 🎊\n\nMay your special day be surrounded with happiness, filled with laughter! 🎨🎁`,
    `🌟 It's ${tag}'s Birthday! 🌟\n\n🎂 Another year older, another year wiser, another year more awesome!\nMay all your dreams come true! ✨🎉`,
    `🎈 BIRTHDAY ALERT! 🎈\n\nIt's ${tag}'s special day! 🎂\nLet's celebrate this wonderful person who brings joy to our group! 🎊🎉`,
    `🎵 Happy Birthday to you! 🎵\n🎵 Happy Birthday dear ${tag}! 🎵\n\n🎂 Hope your day is as special as you are! 🌟`,
  ];
  let msg = wishes[Math.floor(Math.random() * wishes.length)];
  if (person.birthday?.age != null)
    msg += `\n\n🎈 Celebrating ${person.birthday.age + 1} wonderful years! 🎈`;
  msg += `\n\n👏 From all of us at GIST HQ! 👏`;
  return msg;
}

function getReminderMessage(person, daysUntil) {
  const tag = `@${person.userId.split("@")[0]}`;
  let msg =
    daysUntil === 1
      ? `🎂 *BIRTHDAY REMINDER* 🎂\n\n📅 Tomorrow is ${tag}'s birthday!\n\n🎁 Don't forget to wish them well! 🎉`
      : `🎂 *BIRTHDAY REMINDER* 🎂\n\n📅 ${tag}'s birthday is in *${daysUntil} days!*\n\n🗓️ Date: ${person.birthday.displayDate} 🎉`;
  if (person.birthday?.age != null)
    msg += `\n\n🎈 They'll be turning *${person.birthday.age + 1}*! 🎈`;
  return msg;
}

// ==================== HELPERS ====================

async function safeSend(sock, jid, msgObj) {
  try {
    await sock.sendMessage(jid, msgObj);
    return true;
  } catch (e) {
    printLog(
      "error",
      `[BIRTHDAY] safeSend to ${jid.split("@")[0]} failed: ${e.message}`,
    );
    return false;
  }
}

async function getGroupParticipants(sock, groupId) {
  try {
    const meta = await sock.groupMetadata(groupId);
    if (!meta?.participants) return [];
    const botJid = sock.user.id.split(":")[0] + "@s.whatsapp.net";
    return meta.participants.map((p) => p.id).filter((id) => id !== botJid);
  } catch (e) {
    return [];
  }
}

// ==================== SCHEDULER ====================

async function runBirthdayWishes(sock) {
  if (!birthdaySettings.enableAutoWishes) return;
  const todaysBirthdays = await getTodaysBirthdays();
  if (todaysBirthdays.length === 0) return;

  for (const person of todaysBirthdays) {
    try {
      if (await hasWishedToday(person.userId)) continue;
      let sent = 0;

      if (birthdaySettings.enablePrivateReminders) {
        const ok = await safeSend(sock, person.userId, {
          text: `🎉 *HAPPY BIRTHDAY ${person.name}!* 🎉\n\nToday is your special day! 🎂\n\nWishing you all the happiness in the world! ✨🎈\n\n👏 From all of us at GIST HQ!`,
        });
        if (ok) sent++;
        await new Promise((r) => setTimeout(r, 3000));
      }

      if (
        birthdaySettings.enableGroupReminders &&
        birthdaySettings.reminderGroups.length > 0
      ) {
        const wishMsg = getBirthdayWishMessage(person);
        for (const groupId of birthdaySettings.reminderGroups) {
          const participants = await getGroupParticipants(sock, groupId);
          const mentions = [...new Set([person.userId, ...participants])];
          const ok = await safeSend(sock, groupId, { text: wishMsg, mentions });
          if (ok) sent++;
          await new Promise((r) => setTimeout(r, 5000));
        }
      }

      if (sent > 0) await markWishedToday(person.userId, person.name, sent);
      await new Promise((r) => setTimeout(r, 8000));
    } catch (e) {
      printLog(
        "error",
        `[BIRTHDAY] Error processing birthday for ${person.name}: ${e.message}`,
      );
    }
  }
}

async function runBirthdayReminders(sock, daysAhead) {
  if (!birthdaySettings.enableReminders) return;
  if (!birthdaySettings.reminderDays.includes(daysAhead)) return;
  const upcoming = await getUpcomingBirthdays(daysAhead);
  if (upcoming.length === 0) return;
  const today = moment.tz(TIMEZONE).format("YYYY-MM-DD");

  for (const person of upcoming) {
    const reminderKey = `${today}-${person.userId}-${daysAhead}`;
    try {
      if (await hasReminderSent(reminderKey)) continue;
      const reminderMsg = getReminderMessage(person, daysAhead);
      if (
        birthdaySettings.enableGroupReminders &&
        birthdaySettings.reminderGroups.length > 0
      ) {
        for (const groupId of birthdaySettings.reminderGroups) {
          const participants = await getGroupParticipants(sock, groupId);
          const mentions = [...new Set([person.userId, ...participants])];
          await safeSend(sock, groupId, { text: reminderMsg, mentions });
          await new Promise((r) => setTimeout(r, 3000));
        }
      }
      await markReminderSent(reminderKey, person.userId, daysAhead);
    } catch (e) {
      printLog(
        "error",
        `[BIRTHDAY] Error sending reminder for ${person.name}: ${e.message}`,
      );
    }
  }
}

// ==================== NODE-CRON SCHEDULER ====================
function startScheduler(sock) {
  if (schedulerStarted) return;
  schedulerStarted = true;

  const [wishH, wishM] = birthdaySettings.wishTime.split(':').map(Number);
  const wishCron = `${wishM} ${wishH} * * *`;

  const [remH, remM] = birthdaySettings.reminderTime.split(':').map(Number);
  const remCron = `${remM} ${remH} * * *`;

  cronJobs.set('wishes', cron.schedule(wishCron, () => runBirthdayWishes(sock), { timezone: TIMEZONE }));
  cronJobs.set('reminders', cron.schedule(remCron, async () => {
    for (const days of birthdaySettings.reminderDays) await runBirthdayReminders(sock, days);
  }, { timezone: TIMEZONE }));
  cronJobs.set('cleanup', cron.schedule('0 2 * * 0', runCleanup, { timezone: TIMEZONE }));

  printLog('info', '[BIRTHDAY] node-cron scheduler started (exact timing)');
}

async function runMissedTasks(sock) {
  const today = moment.tz(TIMEZONE).format('YYYY-MM-DD');
  const now = moment.tz(TIMEZONE);
  const currentTime = now.format('HH:mm');

  if (currentTime >= birthdaySettings.wishTime && !lastSchedulerRun[`wishes_${today}`]) {
    lastSchedulerRun[`wishes_${today}`] = true;
    printLog('info', '[BIRTHDAY] Running missed wishes after restart');
    await runBirthdayWishes(sock);
  }

  for (const days of birthdaySettings.reminderDays) {
    const runKey = `reminder_${days}_${today}`;
    if (currentTime >= birthdaySettings.reminderTime && !lastSchedulerRun[runKey]) {
      lastSchedulerRun[runKey] = true; // ← add this line
      printLog('info', `[BIRTHDAY] Running missed ${days}-day reminders after restart`);
      await runBirthdayReminders(sock, days);
    }
  }
}

// ==================== EVENT LISTENER (Attendance Integration) ====================

async function onLoad(sock) {
  await loadSettings();
  startScheduler(sock);
  await runMissedTasks(sock);
  bus.on('attendance:birthday', async (payload) => {
    try {
      const { userId, name, birthdayData } = payload;

      if (!birthdayData?.displayDate) {
        printLog('warning', `[BIRTHDAY] Invalid birthday data received from attendance`);
        return;
      }

      // Reuse the already-parsed displayDate — our parseDOB handles it perfectly
      const success = await saveBirthdayData(userId, name, birthdayData.displayDate);

      if (success) {
        printLog('success', `[BIRTHDAY] 🎂 Auto-saved from attendance → ${name} (${birthdayData.displayDate})`);
      } else {
        printLog('warning', `[BIRTHDAY] Failed to save birthday from attendance for ${name}`);
      }
    } catch (err) {
      printLog('error', `[BIRTHDAY] Event handler error: ${err.message}`);
    }
  });

  printLog('info', '[BIRTHDAY] ✅ Now listening for attendance:birthday events');
}

// ==================== COMMAND HANDLER ====================

async function handleBirthdayCommand(sock, message, args, context) {
  const chatId = context.chatId || message.key.remoteJid;
  // ── Always pull senderId from message.key directly (antilink pattern) ──
  const senderId = message.key.participant || message.key.remoteJid;
  const isGroup = chatId.endsWith("@g.us");

  if (!birthdaySettings.loaded) await loadSettings();
  startScheduler(sock); 

  const channelInfo = context.channelInfo || {};

  // Alias detection
  const invokedCmd = (context.userMessage || "")
    .trim()
    .split(/\s+/)[0]
    .replace(/^[.!#\/]/, "");
  if (["mybirthday", "mybday"].includes(invokedCmd)) {
    return await handleMyBirthday(sock, message, senderId, chatId, channelInfo);
  }

  if (args.length === 0)
    return await showBirthdayMenu(sock, message, chatId, channelInfo);

  const sub = args[0].toLowerCase();
  const subArgs = args.slice(1);

  switch (sub) {
    case "today":
      return await handleToday(sock, message, chatId, channelInfo);

    case "upcoming":
      return await handleUpcoming(sock, message, chatId, subArgs, channelInfo);

    case "thismonth":
      return await handleThisMonth(sock, message, chatId, channelInfo);

    case "status":
      return await handleStatus(sock, message, chatId, channelInfo);

    // ── Admin-gated: pass senderId so sub-handler checks auth itself ──
    case "all":
      return await handleAll(sock, message, chatId, senderId, channelInfo);

    case "test":
      return await handleTest(
        sock,
        message,
        chatId,
        senderId,
        isGroup,
        channelInfo,
      );

    case "settings":
      return await handleSettings(
        sock,
        message,
        chatId,
        senderId,
        subArgs,
        channelInfo,
      );

    case "groups":
      return await handleGroups(
        sock,
        message,
        chatId,
        senderId,
        isGroup,
        subArgs,
        channelInfo,
      );

    case "force":
      return await handleForce(
        sock,
        message,
        chatId,
        senderId,
        subArgs,
        channelInfo,
      );

    case "help":
      return await showBirthdayMenu(sock, message, chatId, channelInfo);

    default:
      return sock.sendMessage(
        chatId,
        {
          text: `❓ Unknown birthday command: *${sub}*\n\nUse *.birthday help* to see available commands.`,
          //...channelInfo,
        },
        { quoted: message },
      );
  }
}

// ==================== SUB-HANDLERS ====================

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
    `• Advance reminders 7, 3 & 1 day(s) before\n\n` +
    `🌍 Timezone: Africa/Lagos (WAT)`;
  await sock.sendMessage(
    chatId,
    { text: menu, ...channelInfo },
    { quoted: message },
  );
}

async function handleMyBirthday(sock, message, senderId, chatId, channelInfo) {
  const data = await getBirthdayData(senderId);
  if (!data) {
    return sock.sendMessage(
      chatId,
      {
        text: `🎂 *No Birthday Recorded*\n\nYour birthday hasn't been saved yet.\n\n💡 It is saved automatically when you submit an attendance form with your D.O.B.`,
        //...channelInfo,
      },
      { quoted: message },
    );
  }
  const b = data.birthday;
  const now = moment.tz(TIMEZONE);
  const nextBday = moment.tz(
    { year: now.year(), month: b.month - 1, date: b.day },
    TIMEZONE,
  );
  if (nextBday.isBefore(now, "day")) nextBday.add(1, "year");
  const daysUntil = nextBday.diff(now, "days");

  let msg = `🎂 *Your Birthday Information* 🎂\n\n`;
  msg += `👤 Name: ${data.name}\n`;
  msg += `📅 Birthday: ${b.displayDate}\n`;
  if (b.year) msg += `📊 Year: ${b.year}\n`;
  if (b.age != null) msg += `🎈 Current Age: ${b.age} years old\n`;
  msg += `💾 Last Updated: ${new Date(data.lastUpdated).toLocaleString("en-NG", { timeZone: TIMEZONE })}\n\n`;

  if (daysUntil === 0)
    msg += `🎉 *IT'S YOUR BIRTHDAY TODAY!* 🎉\n🎊 *HAPPY BIRTHDAY!* 🎊`;
  else if (daysUntil === 1) msg += `🎂 *Your birthday is TOMORROW!* 🎂`;
  else if (daysUntil <= 7) msg += `🗓 *Your birthday is in ${daysUntil} days!*`;
  else msg += `📅 Days until next birthday: *${daysUntil}*`;

  await sock.sendMessage(
    chatId,
    { text: msg, ...channelInfo },
    { quoted: message },
  );
}

async function handleToday(sock, message, chatId, channelInfo) {
  const list = await getTodaysBirthdays();
  if (list.length === 0) {
    return sock.sendMessage(
      chatId,
      {
        text: `🎂 *No birthdays today*\n\n📅 Check upcoming: *.birthday upcoming*`,
        //...channelInfo,
      },
      { quoted: message },
    );
  }
  let msg = `🎉 *TODAY'S BIRTHDAYS* 🎉\n\n`;
  const mentions = [];
  list.forEach((p) => {
    mentions.push(p.userId);
    msg += `🎂 @${p.userId.split("@")[0]}`;
    if (p.birthday.age != null) msg += ` *(Turning ${p.birthday.age + 1}!)*`;
    msg += "\n";
  });
  msg += `\n🎊 *Let's wish them a happy birthday!* 🎊`;
  await sock.sendMessage(
    chatId,
    { text: msg, mentions, ...channelInfo },
    { quoted: message },
  );
}

async function handleUpcoming(sock, message, chatId, args, channelInfo) {
  const days = args[0] ? parseInt(args[0]) : 7;
  if (isNaN(days) || days < 1 || days > 365) {
    return sock.sendMessage(
      chatId,
      {
        text: "⚠️ Please provide a valid number of days (1-365)",
        //...channelInfo,
      },
      { quoted: message },
    );
  }
  const birthdays = await getAllBirthdays();
  const now = moment.tz(TIMEZONE);
  const upcomingList = [];
  Object.values(birthdays).forEach((entry) => {
    const b = entry.birthday;
    const nextBday = moment.tz(
      { year: now.year(), month: b.month - 1, date: b.day },
      TIMEZONE,
    );
    if (nextBday.isBefore(now, "day")) nextBday.add(1, "year");
    const daysUntil = nextBday.diff(now, "days");
    if (daysUntil >= 0 && daysUntil <= days)
      upcomingList.push({ ...entry, daysUntil });
  });
  if (upcomingList.length === 0) {
    return sock.sendMessage(
      chatId,
      { text: `📅 *No birthdays in the next ${days} days*`, ...channelInfo },
      { quoted: message },
    );
  }
  upcomingList.sort((a, b) => a.daysUntil - b.daysUntil);
  let msg = `📅 *UPCOMING BIRTHDAYS (Next ${days} days)* 📅\n\n`;
  const mentions = [];
  upcomingList.forEach((u) => {
    mentions.push(u.userId);
    if (u.daysUntil === 0)
      msg += `🎊 @${u.userId.split("@")[0]} — *TODAY!* 🎊\n`;
    else if (u.daysUntil === 1)
      msg += `🎂 @${u.userId.split("@")[0]} — Tomorrow\n`;
    else
      msg += `📌 @${u.userId.split("@")[0]} — in ${u.daysUntil} days (${u.birthday.monthName} ${u.birthday.day})\n`;
    if (u.birthday.age != null) {
      const age = u.daysUntil === 0 ? u.birthday.age : u.birthday.age + 1;
      msg += `   🎈 ${u.daysUntil === 0 ? "Turned" : "Turning"} ${age}\n`;
    }
  });
  await sock.sendMessage(
    chatId,
    { text: msg, mentions, ...channelInfo },
    { quoted: message },
  );
}

async function handleThisMonth(sock, message, chatId, channelInfo) {
  const now = moment.tz(TIMEZONE);
  const currentMonth = now.month() + 1;
  const birthdays = await getAllBirthdays();
  const list = Object.values(birthdays)
    .filter((b) => b.birthday.month === currentMonth)
    .sort((a, b) => a.birthday.day - b.birthday.day);
  const monthName = now.format("MMMM YYYY");
  if (list.length === 0) {
    return sock.sendMessage(
      chatId,
      { text: `📅 *No birthdays in ${monthName}*`, ...channelInfo },
      { quoted: message },
    );
  }
  let msg = `📅 *${monthName.toUpperCase()} BIRTHDAYS* 📅\n\n`;
  const mentions = [];
  list.forEach((p) => {
    mentions.push(p.userId);
    msg += `🎂 @${p.userId.split("@")[0]} — ${p.birthday.monthName} ${p.birthday.day}`;
    if (p.birthday.age != null) msg += ` (${p.birthday.age} yrs)`;
    if (p.birthday.day === now.date()) msg += ` 🎊 TODAY!`;
    else if (p.birthday.day < now.date()) msg += ` ✅ Celebrated`;
    else msg += ` (${p.birthday.day - now.date()} days away)`;
    msg += "\n";
  });
  await sock.sendMessage(
    chatId,
    { text: msg, mentions, ...channelInfo },
    { quoted: message },
  );
}

async function handleAll(sock, message, chatId, senderId, channelInfo) {
  const isOwner = await isOwnerOrSudo(senderId, sock, chatId);
  let isSenderAdmin = false;
  if (chatId.endsWith("@g.us")) {
    try {
      const r = await isAdmin(sock, chatId, senderId);
      isSenderAdmin = r.isSenderAdmin;
    } catch (e) {}
  }
  if (!isOwner && !isSenderAdmin) {
    return sock.sendMessage(
      chatId,
      { text: "🚫 Only admins can view all birthdays.", ...channelInfo },
      { quoted: message },
    );
  }
  const birthdays = await getAllBirthdays();
  const list = Object.values(birthdays).sort((a, b) => {
    if (a.birthday.month !== b.birthday.month)
      return a.birthday.month - b.birthday.month;
    return a.birthday.day - b.birthday.day;
  });
  if (list.length === 0) {
    return sock.sendMessage(
      chatId,
      { text: `🎂 *No birthdays recorded yet*`, ...channelInfo },
      { quoted: message },
    );
  }
  let msg = `🎂 *ALL BIRTHDAYS* 🎂\n\n📊 Total: *${list.length} members*\n`;
  const mentions = [];
  let currentMonth = null;
  list.forEach((p) => {
    mentions.push(p.userId);
    if (currentMonth !== p.birthday.month) {
      currentMonth = p.birthday.month;
      msg += `\n📅 *${p.birthday.monthName.toUpperCase()}*\n`;
    }
    msg += `🎂 @${p.userId.split("@")[0]} — ${p.birthday.day}`;
    if (p.birthday.age != null) msg += ` (${p.birthday.age} yrs)`;
    msg += "\n";
  });
  await sock.sendMessage(
    chatId,
    { text: msg, mentions, ...channelInfo },
    { quoted: message },
  );
}

async function handleStatus(sock, message, chatId, channelInfo) {
  await loadSettings();
  const [todayList, upcoming1, upcoming3, upcoming7, allBdays] =
    await Promise.all([
      getTodaysBirthdays(),
      getUpcomingBirthdays(1),
      getUpcomingBirthdays(3),
      getUpcomingBirthdays(7),
      getAllBirthdays(),
    ]);
  const now = moment.tz(TIMEZONE);
  let msg = `📊 *BIRTHDAY SYSTEM STATUS* 📊\n\n`;
  msg += `⏰ Time (WAT): ${now.format("YYYY-MM-DD HH:mm:ss")}\n`;
  msg += `🤖 Scheduler: ${schedulerStarted ? "✅ Running" : "⚠️ Not started"}\n\n`;
  msg += `📊 *Registered:* ${Object.keys(allBdays).length}\n`;
  msg += `• Today: ${todayList.length}\n• Tomorrow: ${upcoming1.length}\n• Next 3 days: ${upcoming3.length}\n• Next 7 days: ${upcoming7.length}\n\n`;
  msg += `⚙️ *Settings:*\n`;
  msg += `• Auto Wishes: ${birthdaySettings.enableAutoWishes ? "✅" : "❌"} at ${birthdaySettings.wishTime}\n`;
  msg += `• Reminders: ${birthdaySettings.enableReminders ? "✅" : "❌"} at ${birthdaySettings.reminderTime}\n`;
  msg += `• Group Reminders: ${birthdaySettings.enableGroupReminders ? "✅" : "❌"}\n`;
  msg += `• Private Wishes: ${birthdaySettings.enablePrivateReminders ? "✅" : "❌"}\n`;
  msg += `• Reminder Days: ${birthdaySettings.reminderDays.join(", ")}\n`;
  msg += `• Groups: ${birthdaySettings.reminderGroups.length}`;
  await sock.sendMessage(
    chatId,
    { text: msg, ...channelInfo },
    { quoted: message },
  );
}

async function handleTest(
  sock,
  message,
  chatId,
  senderId,
  isGroup,
  channelInfo,
) {
  const isOwner = await isOwnerOrSudo(senderId, sock, chatId);
  let isSenderAdmin = false;
  if (chatId.endsWith("@g.us")) {
    try {
      const r = await isAdmin(sock, chatId, senderId);
      isSenderAdmin = r.isSenderAdmin;
    } catch (e) {}
  }
  if (!isOwner && !isSenderAdmin) {
    return sock.sendMessage(
      chatId,
      { text: "🚫 Only admins can test birthday wishes.", ...channelInfo },
      { quoted: message },
    );
  }
  if (!isGroup) {
    return sock.sendMessage(
      chatId,
      { text: "⚠️ This command must be used in a group.", ...channelInfo },
      { quoted: message },
    );
  }
  const mentionedJid =
    message.message?.extendedTextMessage?.contextInfo?.mentionedJid;
  let targetUserId = message.key.participant || message.key.remoteJid;
  let targetName = targetUserId.split("@")[0];
  if (mentionedJid?.length > 0) {
    targetUserId = mentionedJid[0];
    const data = await getBirthdayData(targetUserId);
    targetName = data ? data.name : targetUserId.split("@")[0];
  } else {
    const data = await getBirthdayData(targetUserId);
    if (data) targetName = data.name;
  }
  await sock.sendMessage(
    chatId,
    {
      text: `🧪 Testing birthday wish for *${targetName}*...\n\nSending in 3 seconds...`,
      //...channelInfo,
    },
    { quoted: message },
  );
  await new Promise((r) => setTimeout(r, 3000));
  const testPerson = {
    userId: targetUserId,
    name: targetName,
    birthday: { age: null, displayDate: moment.tz(TIMEZONE).format("MMMM DD") },
  };
  const wishMessage = getBirthdayWishMessage(testPerson);
  const participants = await getGroupParticipants(sock, chatId);
  const mentions = [...new Set([targetUserId, ...participants])];
  await safeSend(sock, chatId, {
    text: `🧪 *TEST MODE* 🧪\n\n${wishMessage}\n\n_This is a test. No actual birthday today._`,
    mentions,
  });
}

  async function handleForce(sock, message, chatId, senderId, args, channelInfo) {
    // ── Full admin check ──
    const isOwner = await isOwnerOrSudo(senderId, sock, chatId);
    let isSenderAdmin = false;
    if (chatId.endsWith("@g.us")) {
      try {
        const r = await isAdmin(sock, chatId, senderId);
        isSenderAdmin = r.isSenderAdmin;
      } catch (e) {}
    }
    if (!isOwner && !isSenderAdmin) {
      return sock.sendMessage(
        chatId,
        { text: "🚫 Only admins (or owner/sudo) can force birthday tasks.", ...channelInfo },
        { quoted: message },
      );
    }

    if (!args[0]) {
      return sock.sendMessage(
        chatId,
        {
          text:
            `🔧 *FORCE COMMANDS*\n\n` +
            `• *wishes* - Force today's birthday wishes\n` +
            `• *reminders [days]* - Force reminders for specific days\n` +
            `• *cleanup* - Force cleanup\n\n` +
            `Usage: *.birthday force [command]*`,
          //...channelInfo,
        },
        { quoted: message },
      );
    }
  const type = args[0].toLowerCase();
  const today = moment.tz(TIMEZONE).format("YYYY-MM-DD");

  if (type === "wishes") {
    await sock.sendMessage(
      chatId,
      { text: "🔧 Forcing birthday wishes...", ...channelInfo },
      { quoted: message },
    );
    delete lastSchedulerRun[`wishes_${today}`];
    await runBirthdayWishes(sock);
    return sock.sendMessage(
      chatId,
      { text: "✅ Forced birthday wishes completed!", ...channelInfo },
      { quoted: message },
    );
  }
  if (type === "reminders") {
    const days = args[1] ? parseInt(args[1]) : 7;
    if (isNaN(days))
      return sock.sendMessage(
        chatId,
        { text: "❌ Invalid days parameter", ...channelInfo },
        { quoted: message },
      );
    await sock.sendMessage(
      chatId,
      { text: `🔧 Forcing ${days}-day reminders...`, ...channelInfo },
      { quoted: message },
    );
    delete lastSchedulerRun[`reminder_${days}_${today}`];
    await runBirthdayReminders(sock, days);
    return sock.sendMessage(
      chatId,
      { text: `✅ Forced ${days}-day reminders completed!`, ...channelInfo },
      { quoted: message },
    );
  }
  if (type === "cleanup") {
    await sock.sendMessage(
      chatId,
      { text: "🔧 Running cleanup...", ...channelInfo },
      { quoted: message },
    );
    await runCleanup();
    return sock.sendMessage(
      chatId,
      { text: "✅ Cleanup completed!", ...channelInfo },
      { quoted: message },
    );
  }
  return sock.sendMessage(
    chatId,
    { text: `❓ Unknown force command: *${type}*`, ...channelInfo },
    { quoted: message },
  );
}

async function handleSettings(
  sock,
  message,
  chatId,
  senderId,
  args,
  channelInfo,
) {
  // ── Use the same full auth check as attendance plugin ──
  const isOwner = await isOwnerOrSudo(senderId, sock, chatId);
  let isSenderAdmin = false;
  if (chatId.endsWith("@g.us")) {
    try {
      const r = await isAdmin(sock, chatId, senderId);
      isSenderAdmin = r.isSenderAdmin;
    } catch (e) {
      printLog("error", `[BIRTHDAY] isAdmin error: ${e.message}`);
    }
  }

  if (!isOwner && !isSenderAdmin) {
    return sock.sendMessage(
      chatId,
      {
        text: "🚫 Only admins (or owner/sudo) can modify birthday settings.",
        //...channelInfo,
      },
      { quoted: message },
    );
  }
  if (args.length === 0)
    return await showSettingsMenu(sock, message, chatId, channelInfo);
  const setting = args[0].toLowerCase();
  const value = args.slice(1).join(" ").trim();

  switch (setting) {
    case "reminders":
      birthdaySettings.enableReminders = value === "on";
      await saveSettings();
      return sock.sendMessage(
        chatId,
        {
          text: `✅ Reminders *${birthdaySettings.enableReminders ? "enabled" : "disabled"}*!`,
          //...channelInfo,
        },
        { quoted: message },
      );
    case "wishes":
      birthdaySettings.enableAutoWishes = value === "on";
      await saveSettings();
      return sock.sendMessage(
        chatId,
        {
          text: `✅ Auto wishes *${birthdaySettings.enableAutoWishes ? "enabled" : "disabled"}*!`,
          //...channelInfo,
        },
        { quoted: message },
      );
    case "groupreminders":
      birthdaySettings.enableGroupReminders = value === "on";
      await saveSettings();
      return sock.sendMessage(
        chatId,
        {
          text: `✅ Group reminders *${birthdaySettings.enableGroupReminders ? "enabled" : "disabled"}*!`,
          //...channelInfo,
        },
        { quoted: message },
      );
    case "privatereminders":
      birthdaySettings.enablePrivateReminders = value === "on";
      await saveSettings();
      return sock.sendMessage(
        chatId,
        {
          text: `✅ Private reminders *${birthdaySettings.enablePrivateReminders ? "enabled" : "disabled"}*!`,
          //...channelInfo,
        },
        { quoted: message },
      );
    case "wishtime":
      if (!/^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/.test(value)) {
        return sock.sendMessage(
          chatId,
          { text: "⚠️ Invalid time format. Use HH:MM", ...channelInfo },
          { quoted: message },
        );
      }
      birthdaySettings.wishTime = value;
      await saveSettings();
      return sock.sendMessage(
        chatId,
        { text: `✅ Wish time set to *${value}*!`, ...channelInfo },
        { quoted: message },
      );
    case "remindertime":
      if (!/^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/.test(value)) {
        return sock.sendMessage(
          chatId,
          { text: "⚠️ Invalid time format. Use HH:MM", ...channelInfo },
          { quoted: message },
        );
      }
      birthdaySettings.reminderTime = value;
      await saveSettings();
      return sock.sendMessage(
        chatId,
        { text: `✅ Reminder time set to *${value}*!`, ...channelInfo },
        { quoted: message },
      );
    case "reminderdays": {
      const days = value
        .split(",")
        .map((d) => parseInt(d.trim()))
        .filter((d) => !isNaN(d) && d >= 1 && d <= 365);
      if (days.length === 0) {
        return sock.sendMessage(
          chatId,
          {
            text: "⚠️ Invalid days. Use comma-separated numbers, e.g. *7,3,1*",
            //...channelInfo,
          },
          { quoted: message },
        );
      }
      birthdaySettings.reminderDays = days.sort((a, b) => b - a);
      await saveSettings();
      return sock.sendMessage(
        chatId,
        {
          text: `✅ Reminder days set to *${days.join(", ")}*!`,
          //...channelInfo,
        },
        { quoted: message },
      );
    }
    case "reload":
      await loadSettings();
      return sock.sendMessage(
        chatId,
        { text: "✅ Birthday settings reloaded!", ...channelInfo },
        { quoted: message },
      );
    default:
      return sock.sendMessage(
        chatId,
        { text: `❓ Unknown setting: *${setting}*`, ...channelInfo },
        { quoted: message },
      );
  }
}

async function showSettingsMenu(sock, message, chatId, channelInfo) {
  const s = birthdaySettings;
  let msg = `⚙️ *BIRTHDAY SETTINGS* ⚙️\n\n`;
  msg += `🔔 Reminders: ${s.enableReminders ? "✅ ON" : "❌ OFF"}\n`;
  msg += `🎉 Auto Wishes: ${s.enableAutoWishes ? "✅ ON" : "❌ OFF"}\n`;
  msg += `👥 Group Reminders: ${s.enableGroupReminders ? "✅ ON" : "❌ OFF"}\n`;
  msg += `💬 Private Reminders: ${s.enablePrivateReminders ? "✅ ON" : "❌ OFF"}\n`;
  msg += `⏰ Wish Time (WAT): ${s.wishTime}\n`;
  msg += `🔔 Reminder Time (WAT): ${s.reminderTime}\n`;
  msg += `📅 Reminder Days: ${s.reminderDays.join(", ")} days before\n`;
  msg += `👥 Groups: ${s.reminderGroups.length}\n\n`;
  msg += `🔧 *Change Settings:*\n`;
  msg += `• *.birthday settings reminders on/off*\n• *.birthday settings wishes on/off*\n`;
  msg += `• *.birthday settings groupreminders on/off*\n• *.birthday settings privatereminders on/off*\n`;
  msg += `• *.birthday settings wishtime HH:MM*\n• *.birthday settings remindertime HH:MM*\n`;
  msg += `• *.birthday settings reminderdays 7,3,1*\n• *.birthday settings reload*`;
  await sock.sendMessage(
    chatId,
    { text: msg, ...channelInfo },
    { quoted: message },
  );
}

async function handleGroups(
  sock,
  message,
  chatId,
  senderId,
  isGroup,
  args,
  channelInfo,
) {
  // ── Full admin check ──
  const isOwner = await isOwnerOrSudo(senderId, sock, chatId);
  let isSenderAdmin = false;
  if (chatId.endsWith("@g.us")) {
    try {
      const r = await isAdmin(sock, chatId, senderId);
      isSenderAdmin = r.isSenderAdmin;
    } catch (e) {}
  }
  if (!isOwner && !isSenderAdmin) {
    return sock.sendMessage(
      chatId,
      {
        text: "🚫 Only admins (or owner/sudo) can manage birthday groups.",
        //...channelInfo,
      },
      { quoted: message },
    );
  }
  if (args.length === 0)
    return await showGroups(sock, message, chatId, channelInfo);
  const action = args[0].toLowerCase();

  if (action === "add") {
    if (!isGroup)
      return sock.sendMessage(
        chatId,
        {
          text: "⚠️ Run this command *inside the group* you want to add.",
          //...channelInfo,
        },
        { quoted: message },
      );
    if (birthdaySettings.reminderGroups.includes(chatId))
      return sock.sendMessage(
        chatId,
        { text: "⚠️ This group is already added.", ...channelInfo },
        { quoted: message },
      );
    birthdaySettings.reminderGroups.push(chatId);
    await saveSettings();
    return sock.sendMessage(
      chatId,
      { text: `✅ Group added for birthday reminders!`, ...channelInfo },
      { quoted: message },
    );
  }
  if (action === "remove") {
    const groupArg = args[1];
    if (!groupArg)
      return sock.sendMessage(
        chatId,
        { text: "⚠️ Specify a group ID to remove.", ...channelInfo },
        { quoted: message },
      );
    const idx = birthdaySettings.reminderGroups.findIndex((g) =>
      g.includes(groupArg),
    );
    if (idx === -1)
      return sock.sendMessage(
        chatId,
        { text: `⚠️ Group not found: *${groupArg}*`, ...channelInfo },
        { quoted: message },
      );
    birthdaySettings.reminderGroups.splice(idx, 1);
    await saveSettings();
    return sock.sendMessage(
      chatId,
      { text: `✅ Group removed from birthday reminders!`, ...channelInfo },
      { quoted: message },
    );
  }
  if (action === "clear") {
    const count = birthdaySettings.reminderGroups.length;
    if (count === 0)
      return sock.sendMessage(
        chatId,
        { text: "📝 No groups are currently configured.", ...channelInfo },
        { quoted: message },
      );
    birthdaySettings.reminderGroups = [];
    await saveSettings();
    return sock.sendMessage(
      chatId,
      { text: `✅ Cleared all *${count}* group(s)!`, ...channelInfo },
      { quoted: message },
    );
  }
  return await showGroups(sock, message, chatId, channelInfo);
}

async function showGroups(sock, message, chatId, channelInfo) {
  const groups = birthdaySettings.reminderGroups;
  let msg = `👥 *BIRTHDAY REMINDER GROUPS* 👥\n\n`;
  if (groups.length === 0) msg += `📝 No groups configured.\n\n`;
  else {
    msg += `📊 Total: ${groups.length}\n\n`;
    groups.forEach((g, i) => {
      msg += `${i + 1}. ${g.split("@")[0]}\n`;
    });
    msg += "\n";
  }
  msg += `🔧 *Commands:*\n• *.birthday groups add* — Add current group\n• *.birthday groups remove [groupId]* — Remove\n• *.birthday groups clear* — Remove all`;
  await sock.sendMessage(
    chatId,
    { text: msg, ...channelInfo },
    { quoted: message },
  );
}

// ==================== EXPORTS ====================

module.exports = {
  command: "birthday",
  aliases: ["bday", "birthdays", "mybirthday", "mybday"],
  description: "Birthday system — auto wishes, reminders, and tracking",
  category: "social",
  handler: handleBirthdayCommand,
  onLoad,
  saveBirthdayData,
  getBirthdayData,
  getAllBirthdays,
  getTodaysBirthdays,
  getUpcomingBirthdays,
  parseDOB,
  startScheduler,
};
