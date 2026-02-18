// plugins/attendance.js - MEGA-MD Attendance System
const moment = require('moment-timezone');
const store = require('../lib/lightweight_store');
const isAdmin = require('../lib/isAdmin');
const { isOwnerOrSudo } = require('../lib/isOwner');
const { saveBirthdayData } = require('./birthday');

// Try to import activity tracker (optional dependency)
let activityTracker;
try {
  activityTracker = require('./activitytracker');
} catch (e) {
  console.log('[ATTENDANCE] Activity tracker not available (optional)');
}

// ===== TIMEZONE =====
moment.tz.setDefault('Africa/Lagos');

// ===== DEFAULT SETTINGS =====
const defaultSettings = {
  rewardAmount: 500,
  requireImage: false,
  imageRewardBonus: 200,
  minFieldLength: 2,
  enableStreakBonus: true,
  streakBonusMultiplier: 1.5,
  adminNumbers: [],
  autoDetection: true,
  preferredDateFormat: 'DD/MM'
};

// ===== IN-MEMORY CACHE =====
const userCache = new Map();
const cacheTimeout = 5 * 60 * 1000; // 5 minutes

// Cache cleanup
function startCacheCleanup() {
  setInterval(() => {
    const now = Date.now();
    for (const [userId, data] of userCache.entries()) {
      if (now - data.timestamp > cacheTimeout) {
        userCache.delete(userId);
      }
    }
  }, 60000);
}

startCacheCleanup();

// ===== SETTINGS MANAGEMENT =====
let attendanceSettings = { ...defaultSettings };

async function loadSettings() {
  try {
    const settings = await store.getSetting('global', 'attendance_config');
    if (settings) {
      attendanceSettings = { ...defaultSettings, ...settings };
    }
  } catch (error) {
    console.error('[ATTENDANCE] Error loading settings:', error);
  }
}

async function saveSettings() {
  try {
    await store.saveSetting('global', 'attendance_config', attendanceSettings);
  } catch (error) {
    console.error('[ATTENDANCE] Error saving settings:', error);
  }
}

// ===== USER MANAGEMENT =====
async function initUser(userId) {
  let userData = await store.getAttendanceUserStats(userId);
  if (!userData) {
    userData = {
      userId,
      lastAttendance: null,
      totalAttendances: 0,
      streak: 0,
      longestStreak: 0,
      displayName: '',
      createdAt: new Date(),
      updatedAt: new Date()
    };
    await store.updateAttendanceUserStats(userId, userData);
  }
  return userData;
}

async function getUserData(userId) {
  return await store.getAttendanceUserStats(userId);
}

async function updateUserData(userId, data) {
  return await store.updateAttendanceUserStats(userId, data);
}

// ===== MONTH NAMES MAPPING =====
const MONTH_NAMES = {
  'january': 1, 'february': 2, 'march': 3, 'april': 4, 'may': 5, 'june': 6,
  'july': 7, 'august': 8, 'september': 9, 'october': 10, 'november': 11, 'december': 12,
  'jan': 1, 'feb': 2, 'mar': 3, 'apr': 4, 'jun': 6, 'jul': 7,
  'aug': 8, 'sep': 9, 'sept': 9, 'oct': 10, 'nov': 11, 'dec': 12
};

// ===== DATE PARSING UTILITIES =====
function isLeapYear(year) {
  return year ? (year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)) : false;
}

function parseBirthday(dobText) {
  if (!dobText || typeof dobText !== 'string') return null;

  const cleaned = dobText.toLowerCase().trim()
    .replace(/^(dob|d\.o\.b|date of birth|birthday|born)[:=\s]*/i, '')
    .replace(/[,\s]+$/, '')
    .trim();
  if (!cleaned) return null;

  let day, month, year;

  const norm = cleaned
    .replace(/(\d+)(st|nd|rd|th)\b/g, '$1')
    .replace(/\bof\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  // Pattern 1: Month Day, Year
  let match = norm.match(/([a-z]+)\s+(\d{1,2}),?\s*(\d{4})?/i);
  if (match) {
    month = MONTH_NAMES[match[1]] || MONTH_NAMES[match[1].substring(0, 3)];
    day = parseInt(match[2]);
    year = match[3] ? parseInt(match[3]) : null;
    if (month && day >= 1 && day <= 31) {
      return formatBirthday(day, month, year, cleaned);
    }
  }

  // Pattern 2: Day Month Year
  match = norm.match(/(\d{1,2})\s+([a-z]+)\s*(\d{4})?/i);
  if (match) {
    day = parseInt(match[1]);
    month = MONTH_NAMES[match[2]] || MONTH_NAMES[match[2].substring(0, 3)];
    year = match[3] ? parseInt(match[3]) : null;
    if (month && day >= 1 && day <= 31) {
      return formatBirthday(day, month, year, cleaned);
    }
  }

  // Pattern 3: MM/DD/YYYY or DD/MM/YYYY
  match = norm.match(/(\d{1,2})[\/\-](\d{1,2})(?:[\/\-](\d{2,4}))?/);
  if (match) {
    const num1 = parseInt(match[1]);
    const num2 = parseInt(match[2]);
    year = match[3] ? (match[3].length === 2 ? 2000 + parseInt(match[3]) : parseInt(match[3])) : null;

    if (attendanceSettings.preferredDateFormat === 'DD/MM') {
      day = num1;
      month = num2;
    } else if (attendanceSettings.preferredDateFormat === 'MM/DD') {
      month = num1;
      day = num2;
    } else {
      if (num1 > 12 && num2 <= 12) {
        day = num1;
        month = num2;
      } else if (num2 > 12 && num1 <= 12) {
        month = num1;
        day = num2;
      } else {
        day = num1;
        month = num2;
      }
    }

    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      return formatBirthday(day, month, year, cleaned);
    }
  }

  // Pattern 4: YYYY-MM-DD
  match = norm.match(/(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})/);
  if (match) {
    year = parseInt(match[1]);
    month = parseInt(match[2]);
    day = parseInt(match[3]);
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      return formatBirthday(day, month, year, cleaned);
    }
  }

  // Pattern 5: Just month and day
  match = norm.match(/([a-z]+)\s+(\d{1,2})/i);
  if (match) {
    month = MONTH_NAMES[match[1]] || MONTH_NAMES[match[1].substring(0, 3)];
    day = parseInt(match[2]);
    if (month && day >= 1 && day <= 31) {
      return formatBirthday(day, month, null, cleaned);
    }
  }

  return null;
}

function formatBirthday(day, month, year, originalText) {
  const monthNames = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'
  ];
  const daysInMonth = [31, year && isLeapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (day > daysInMonth[month - 1]) return null;

  return {
    day,
    month,
    year,
    monthName: monthNames[month - 1],
    displayDate: year ? `${monthNames[month - 1]} ${day}, ${year}` : `${monthNames[month - 1]} ${day}`,
    searchKey: `${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
    originalText,
    parsedAt: new Date().toISOString()
  };
}

// ===== ATTENDANCE RECORD MANAGEMENT =====
async function saveAttendanceRecord(userId, attendanceData) {
  try {
    const record = {
      userId,
      date: attendanceData.date,
      extractedData: attendanceData.extractedData,
      hasImage: attendanceData.hasImage,
      reward: attendanceData.reward,
      streak: attendanceData.streak,
      timestamp: new Date()
    };
    await store.saveAttendanceRecord(record);
    return true;
  } catch (error) {
    console.error('[ATTENDANCE] Error saving record:', error);
    return false;
  }
}

async function cleanupRecords() {
  try {
    const cutoffDate = moment.tz('Africa/Lagos').subtract(90, 'days').toDate();
    const deletedCount = await store.deleteOldAttendanceRecords(cutoffDate);
    console.log(`✅ Attendance records cleanup completed (${deletedCount} records deleted)`);
    return deletedCount;
  } catch (error) {
    console.error('[ATTENDANCE] Error cleaning up records:', error);
    return 0;
  }
}

// ===== IMAGE DETECTION =====
function hasImage(message) {
  try {
    return !!(message.message?.imageMessage || message.message?.stickerMessage ||
              message.message?.extendedTextMessage?.contextInfo?.quotedMessage?.imageMessage ||
              message.message?.extendedTextMessage?.contextInfo?.quotedMessage?.stickerMessage);
  } catch (error) {
    console.error('[ATTENDANCE] Error checking for image:', error);
    return false;
  }
}

function getImageStatus(hasImg, isRequired) {
  return isRequired && !hasImg ? "❌ Image required but not found" : hasImg ? "📸 Image detected ✅" : "📸 No image (optional)";
}

// ===== FORM VALIDATION =====
const attendanceFormRegex = /GIST\s+HQ.*?\*?Name\*?[:].*?\*?Relationship\*?[:]/is;

function validateAttendanceForm(body, hasImg = false) {
  const validation = {
    isValidForm: false,
    missingFields: [],
    hasWakeUpMembers: false,
    hasImage: hasImg,
    imageRequired: attendanceSettings.requireImage,
    errors: [],
    extractedData: {}
  };

  if (!/GIST\s+HQ/i.test(body) || !/\*?Name\*?[:]/i.test(body) || !/\*?Relationship\*?[:]/i.test(body)) {
    validation.errors.push("❌ Invalid attendance form format");
    return validation;
  }

  if (attendanceSettings.requireImage && !hasImg) {
    validation.missingFields.push("📸 Image (required)");
  }

  const requiredFields = [
    { name: "Name", pattern: /\*?Name\*?[:]\s*([^\n]+)/i, fieldName: "👤 Name", extract: true },
    { name: "Location", pattern: /\*?Location\*?[:]\s*([^\n]+)/i, fieldName: "🌍 Location", extract: true },
    { name: "Time", pattern: /\*?Time\*?[:]\s*([^\n]+)/i, fieldName: "⌚ Time", extract: true },
    { name: "Weather", pattern: /\*?Weather\*?[:]\s*([^\n]+)/i, fieldName: "🌥 Weather", extract: true },
    { name: "Mood", pattern: /\*?Mood\*?[:]\s*([^\n]+)/i, fieldName: "❤️‍🔥 Mood", extract: true },
    { name: "DOB", pattern: /\*?D\.?O\.?B\.?\*?[:]\s*([^\n]+)/i, fieldName: "🗓 D.O.B", extract: true, isBirthday: true },
    { name: "Relationship", pattern: /\*?Relationship\*?[:]\s*([^\n]+)/i, fieldName: "👩‍❤️‍👨 Relationship", extract: true }
  ];

  requiredFields.forEach(field => {
    const match = body.match(field.pattern);
    if (!match || !match[1] || match[1].trim().length < attendanceSettings.minFieldLength) {
      validation.missingFields.push(field.fieldName);
    } else if (field.extract) {
      validation.extractedData[field.name.toLowerCase()] = match[1].trim();
      if (field.isBirthday) {
        validation.extractedData.parsedBirthday = parseBirthday(match[1].trim());
        if (!validation.extractedData.parsedBirthday) {
          validation.missingFields.push(field.fieldName + " (invalid format)");
        }
      }
    }
  });

  const wakeUpPattern1 = /1[:]\s*([^\n]+)/i;
  const wakeUpPattern2 = /2[:]\s*([^\n]+)/i;
  const wakeUpPattern3 = /3[:]\s*([^\n]+)/i;
  const wakeUp1 = body.match(wakeUpPattern1);
  const wakeUp2 = body.match(wakeUpPattern2);
  const wakeUp3 = body.match(wakeUpPattern3);
  let missingWakeUps = [];
  if (!wakeUp1 || !wakeUp1[1] || wakeUp1[1].trim().length < attendanceSettings.minFieldLength) missingWakeUps.push("1:");
  if (!wakeUp2 || !wakeUp2[1] || wakeUp2[1].trim().length < attendanceSettings.minFieldLength) missingWakeUps.push("2:");
  if (!wakeUp3 || !wakeUp3[1] || wakeUp3[1].trim().length < attendanceSettings.minFieldLength) missingWakeUps.push("3:");

  if (missingWakeUps.length > 0) {
    validation.missingFields.push(`🔔 Wake up members (${missingWakeUps.join(", ")})`);
  } else {
    validation.hasWakeUpMembers = true;
    validation.extractedData.wakeUpMembers = [wakeUp1[1].trim(), wakeUp2[1].trim(), wakeUp3[1].trim()];
  }

  validation.isValidForm = validation.missingFields.length === 0;
  return validation;
}

// ===== STREAK MANAGEMENT =====
function updateStreak(userId, userData, today) {
  const yesterday = moment.tz('Africa/Lagos').subtract(1, 'day').format('DD-MM-YYYY');
  if (userData.lastAttendance === yesterday) {
    userData.streak = (userData.streak || 0) + 1;
  } else if (userData.lastAttendance !== today) {
    userData.streak = 1;
  }
  if (userData.streak > (userData.longestStreak || 0)) {
    userData.longestStreak = userData.streak;
  }
  return userData.streak;
}

// ===== DATE UTILITIES =====
function getNigeriaTime() {
  return moment.tz('Africa/Lagos');
}

function getCurrentDate() {
  return getNigeriaTime().format('DD-MM-YYYY');
}

// ===== AUTHORIZATION =====
async function isAuthorized(sock, chatId, senderId) {
  const bareNumber = senderId.split('@')[0];

  // Check custom admin numbers
  if (attendanceSettings.adminNumbers.includes(bareNumber)) return true;

  // Check owner/sudo
  if (await isOwnerOrSudo(senderId, sock, chatId)) return true;

  // Check group admin
  if (chatId.endsWith('@g.us')) {
    return await isAdmin(sock, chatId, senderId);
  }

  return false;
}

// ===== AUTO ATTENDANCE HANDLER =====
async function handleAutoAttendance(message, sock) {
  try {
    // Extract the message text properly to preserve newlines
    const messageText = message.message?.conversation ||
                       message.message?.extendedTextMessage?.text ||
                       message.message?.imageMessage?.caption ||
                       message.message?.videoMessage?.caption ||
                       message.body ||
                       '';
    const senderId = message.key.participant || message.key.remoteJid;
    const chatId = message.key.remoteJid;

    if (!attendanceFormRegex.test(messageText)) return false;

    const today = getCurrentDate();
    await initUser(senderId);
    const userData = await getUserData(senderId);

    if (userData.lastAttendance === today) {
      await sock.sendMessage(chatId, { 
        text: `📝 You've already marked your attendance today! Come back tomorrow.` 
      }, { quoted: message });
      return true;
    }

    const messageHasImage = hasImage(message);
    const validation = validateAttendanceForm(messageText, messageHasImage);

    if (!validation.isValidForm) {
      let errorMessage = `❌ *INCOMPLETE ATTENDANCE FORM* \n\n📄 Please complete the following fields:\n\n${validation.missingFields.map((f, i) => `${i + 1}. ${f}`).join('\n')}\n\n💡 *Please fill out all required fields and try again.*`;
      await sock.sendMessage(chatId, { text: errorMessage }, { quoted: message });
      return true;
    }

    const currentStreak = updateStreak(senderId, userData, today);
    await updateUserData(senderId, {
      lastAttendance: today,
      totalAttendances: (userData.totalAttendances || 0) + 1,
      streak: currentStreak,
      longestStreak: userData.longestStreak
    });

    let birthdayMessage = '';
    if (validation.extractedData.dob && validation.extractedData.name) {
      const saved = await saveBirthdayData(senderId, validation.extractedData.name, validation.extractedData.dob);
      if (saved) {
        birthdayMessage = `\n🎂 Birthday saved: ${validation.extractedData.dob}`;
      }
    }

    // Economy is disabled - save reward as 0
    const finalReward = 0;
    await saveAttendanceRecord(senderId, {
      date: today,
      extractedData: validation.extractedData,
      hasImage: messageHasImage,
      reward: finalReward,
      streak: currentStreak
    });

    // Notify activity tracker if available
    if (activityTracker && activityTracker.trackActivity) {
      try {
        // Create a modified message for attendance tracking
        const attendanceMessage = {
          ...message,
          _attendanceEvent: true
        };
        await activityTracker.trackActivity(attendanceMessage);
      } catch (err) {
        console.error('[ATTENDANCE] Error notifying activity tracker:', err);
      }
    }

    let successMessage = `✅ *ATTENDANCE APPROVED!* ✅\n\n🔥 Current streak: ${currentStreak} days${birthdayMessage ? `\n${birthdayMessage}` : ''}\n\n🎉 *Thank you for your participation!*`;
    await sock.sendMessage(chatId, { text: successMessage }, { quoted: message });

    return true;
  } catch (error) {
    console.error('[ATTENDANCE] Error in auto attendance handler:', error);
    return false;
  }
}

// ===== COMMAND HANDLERS =====
async function showAttendanceMenu(sock, chatId, message) {
  await sock.sendMessage(chatId, {
    text: `📋 *ATTENDANCE SYSTEM* 📋\n\n` +
          `📊 *User Commands:*\n` +
          `• *stats* - View your attendance stats\n` +
          `• *test [form]* - Test attendance form\n` +
          `• *testbirthday [date]* - Test birthday parsing\n` +
          `• *records* - View your attendance history\n\n` +
          `👑 *Admin Commands:*\n` +
          `• *settings* - View/modify settings\n` +
          `• *cleanup* - Clean old records (90+ days)\n\n` +
          `🤖 *Auto-Detection:*\n` +
          `Just send your GIST HQ attendance form!\n\n` +
          `💡 *Usage:* .attendance [command]`
  }, { quoted: message });
}

async function handleStats(sock, chatId, senderId, message) {
  try {
    await initUser(senderId);
    const userData = await getUserData(senderId);
    const today = getCurrentDate();

    let statsMessage = `📊 *YOUR ATTENDANCE STATS* 📊\n\n` +
                      `📅 Last attendance: ${userData.lastAttendance || 'Never'}\n` +
                      `📋 Total attendances: ${userData.totalAttendances || 0}\n` +
                      `🔥 Current streak: ${userData.streak || 0} days\n` +
                      `🏆 Longest streak: ${userData.longestStreak || 0} days\n` +
                      `✅ Today's status: ${userData.lastAttendance === today ? 'Marked ✅' : 'Not marked ❌'}\n` +
                      `📸 Image required: ${attendanceSettings.requireImage ? 'Yes' : 'No'}\n` +
                      `📅 Date format: ${attendanceSettings.preferredDateFormat}`;

    const streak = userData.streak || 0;
    statsMessage += streak >= 7 ? `\n🌟 *Amazing! You're on fire with a ${streak}-day streak!*` :
                    streak >= 3 ? `\n🔥 *Great job! Keep the streak going!*` :
                    `\n💪 *Mark your attendance daily to build a streak!*`;

    await sock.sendMessage(chatId, { text: statsMessage }, { quoted: message });
  } catch (error) {
    await sock.sendMessage(chatId, { 
      text: '❌ *Error loading stats. Please try again.*' 
    }, { quoted: message });
    console.error('[ATTENDANCE] Stats error:', error);
  }
}

async function handleSettings(sock, chatId, senderId, message, args) {
  if (!(await isAuthorized(sock, chatId, senderId))) {
    await sock.sendMessage(chatId, { 
      text: '🚫 Only admins can use this command.' 
    }, { quoted: message });
    return;
  }

  if (args.length === 0) {
    let settingsMessage = `⚙️ *ATTENDANCE SETTINGS* ⚙️\n\n` +
                         `💰 Reward Amount: ₦${attendanceSettings.rewardAmount.toLocaleString()}\n` +
                         `📸 Require Image: ${attendanceSettings.requireImage ? 'Yes ✅' : 'No ❌'}\n` +
                         `💎 Image Bonus: ₦${attendanceSettings.imageRewardBonus.toLocaleString()}\n` +
                         `📅 Date Format: ${attendanceSettings.preferredDateFormat}\n` +
                         `🔧 *Change Settings:*\n` +
                         `• *reward [amount]*\n• *requireimage on/off*\n• *imagebonus [amount]*\n• *dateformat MM/DD|DD/MM*`;
    await sock.sendMessage(chatId, { text: settingsMessage }, { quoted: message });
    return;
  }

  const setting = args[0].toLowerCase();
  const value = args.slice(1).join(' ');

  switch (setting) {
    case 'reward':
      const amount = parseInt(value);
      if (isNaN(amount) || amount < 0) {
        await sock.sendMessage(chatId, { 
          text: '⚠️ Please specify a valid reward amount.' 
        }, { quoted: message });
        return;
      }
      attendanceSettings.rewardAmount = amount;
      await saveSettings();
      await sock.sendMessage(chatId, { 
        text: `✅ Reward amount set to ₦${amount.toLocaleString()}` 
      }, { quoted: message });
      break;

    case 'requireimage':
      if (!['on', 'off'].includes(value.toLowerCase())) {
        await sock.sendMessage(chatId, { 
          text: '⚠️ Please specify: *on* or *off*' 
        }, { quoted: message });
        return;
      }
      attendanceSettings.requireImage = value.toLowerCase() === 'on';
      await saveSettings();
      await sock.sendMessage(chatId, { 
        text: `✅ Image requirement ${attendanceSettings.requireImage ? 'enabled' : 'disabled'}` 
      }, { quoted: message });
      break;

    case 'imagebonus':
      const bonus = parseInt(value);
      if (isNaN(bonus) || bonus < 0) {
        await sock.sendMessage(chatId, { 
          text: '⚠️ Please specify a valid bonus amount.' 
        }, { quoted: message });
        return;
      }
      attendanceSettings.imageRewardBonus = bonus;
      await saveSettings();
      await sock.sendMessage(chatId, { 
        text: `✅ Image bonus set to ₦${bonus.toLocaleString()}` 
        }, { quoted: message });
      break;

    case 'dateformat':
      if (!['MM/DD', 'DD/MM'].includes(value)) {
        await sock.sendMessage(chatId, { 
          text: '⚠️ Please specify: *MM/DD* or *DD/MM*' 
        }, { quoted: message });
        return;
      }
      attendanceSettings.preferredDateFormat = value;
      await saveSettings();
      await sock.sendMessage(chatId, { 
        text: `✅ Date format set to ${value}` 
      }, { quoted: message });
      break;

    default:
      await sock.sendMessage(chatId, { 
        text: `❓ Unknown setting: *${setting}*` 
      }, { quoted: message });
  }
}

async function handleTest(sock, chatId, message, args) {
  // Extract the original text from the message to preserve newlines
  const fullText = message.message?.conversation ||
                   message.message?.extendedTextMessage?.text ||
                   message.message?.imageMessage?.caption ||
                   message.message?.videoMessage?.caption ||
                   '';

  // Remove the command prefix (.attendance test)
  const testText = fullText.replace(/^[.!#]attendance\s+test\s*/i, '').trim();

  if (!testText) {
    await sock.sendMessage(chatId, { 
      text: `🔍 *Attendance Form Test*\n\nUsage: .attendance test [paste your attendance form]` 
    }, { quoted: message });
    return;
  }

  const validation = validateAttendanceForm(testText, hasImage(message));
  let result = `🔍 *Form Detection Results:*\n\n` +
               `📋 Valid Form: ${validation.isValidForm ? '✅ Yes' : '❌ No'}\n` +
               `📸 Image: ${getImageStatus(validation.hasImage, validation.imageRequired)}\n` +
               `🔔 Wake-up Members: ${validation.hasWakeUpMembers ? '✅ Present' : '❌ Missing'}\n` +
               `🚫 Missing/Invalid Fields: ${validation.missingFields.length > 0 ? validation.missingFields.join(', ') : 'None'}\n`;

  // Add extracted data if any
  if (Object.keys(validation.extractedData).length > 0) {
    result += `\n📝 Extracted Data:\n`;
    for (const [k, v] of Object.entries(validation.extractedData)) {
      if (k === 'parsedBirthday') {
        result += v ? `🎂 DOB: ${v.displayDate}\n` : `🎂 DOB: Invalid format\n`;
      } else if (k !== 'wakeUpMembers' && v) {
        result += `${k}: ${v}\n`;
      }
    }
  }

  await sock.sendMessage(chatId, { text: result }, { quoted: message });
}

async function handleAttendanceRecords(sock, chatId, senderId, message, args) {
  try {
    const limit = args[0] ? Math.min(Math.max(parseInt(args[0]), 1), 50) : 10;
    const records = await store.getAttendanceRecords(senderId, limit);

    if (records.length === 0) {
      await sock.sendMessage(chatId, { 
        text: `📋 *No Attendance Records*\n\nYou haven't marked any attendance yet. Submit your GIST HQ attendance form to get started!` 
      }, { quoted: message });
      return;
    }

    let recordsText = `📋 *YOUR ATTENDANCE HISTORY* 📋\n\n📊 Showing last ${records.length} records:\n\n`;
    records.forEach((record, index) => {
      recordsText += `${index + 1}. 📅 ${record.date}\n` +
                     `   💰 Reward: ₦${record.reward.toLocaleString()}\n` +
                     `   🔥 Streak: ${record.streak} days\n` +
                     `   📸 Image: ${record.hasImage ? 'Yes' : 'No'}\n` +
                     (record.extractedData?.name ? `   👤 Name: ${record.extractedData.name}\n` : '') +
                     `   ⏰ ${moment(record.timestamp).tz('Africa/Lagos').format('DD/MM/YYYY HH:mm')}\n\n`;
    });
    recordsText += `💡 *Use: .attendance records [number]* to show more/less records (max 50)`;

    await sock.sendMessage(chatId, { text: recordsText }, { quoted: message });
  } catch (error) {
    await sock.sendMessage(chatId, { 
      text: '❌ *Error loading attendance records. Please try again.*' 
    }, { quoted: message });
    console.error('[ATTENDANCE] Records error:', error);
  }
}

async function handleCleanup(sock, chatId, senderId, message) {
  if (!(await isAuthorized(sock, chatId, senderId))) {
    await sock.sendMessage(chatId, { 
      text: '🚫 Only admins can use this command.' 
    }, { quoted: message });
    return;
  }

  try {
    await sock.sendMessage(chatId, { 
      text: '🧹 Starting cleanup of old attendance records (90+ days)...' 
    }, { quoted: message });

    const deletedCount = await cleanupRecords();

    await sock.sendMessage(chatId, { 
      text: `✅ Cleanup completed! Deleted ${deletedCount} old records.` 
    }, { quoted: message });
  } catch (error) {
    await sock.sendMessage(chatId, { 
      text: '❌ *Error during cleanup. Please try again.*' 
    }, { quoted: message });
    console.error('[ATTENDANCE] Cleanup error:', error);
  }
}

  // ===== MAIN PLUGIN HANDLER =====
  module.exports = {
    command: 'attendance',
    aliases: ['att', 'attendstats', 'mystats'],
    category: 'utility',
    description: 'Advanced attendance system with form validation and streaks',
    usage: '.attendance [stats|settings|test|records|help]',

    async handler(sock, message, args, context) {
      const { chatId, senderId } = context;
      const channelInfo = context.channelInfo || {};

      console.log('[ATTENDANCE] Handler called!', { args, chatId, senderId });

      // Load settings on first run
      if (!attendanceSettings.loaded) {
        await loadSettings();
        attendanceSettings.loaded = true;
      }

      // Route to appropriate command handler
      const subCommand = args[0]?.toLowerCase();

      if (!subCommand) {
        await showAttendanceMenu(sock, chatId, message);
        return;
      }

      switch (subCommand) {
        case 'stats':
          await handleStats(sock, chatId, senderId, message);
          break;

        case 'settings':
          await handleSettings(sock, chatId, senderId, message, args.slice(1));
          break;

        case 'test':
          await handleTest(sock, chatId, message, args.slice(1));
          break;

        case 'testbirthday':
          await handleTestBirthday(sock, chatId, message, args.slice(1));
          break;

        case 'records':
          await handleAttendanceRecords(sock, chatId, senderId, message, args.slice(1));
          break;

        case 'cleanup':
          await handleCleanup(sock, chatId, senderId, message);
          break;

        case 'help':
          await showAttendanceMenu(sock, chatId, message);
          break;

        default:
          await sock.sendMessage(chatId, { 
            text: `❓ Unknown attendance command: *${subCommand}*\n\nUse *.attendance help* to see available commands.`,
            ...channelInfo
          }, { quoted: message });
      }
    }
  };

// Export utility functions (same pattern as ban.js)
module.exports.parseBirthday = parseBirthday;
module.exports.saveBirthdayData = saveBirthdayData;
module.exports.validateAttendanceForm = validateAttendanceForm;
module.exports.hasImage = hasImage;
module.exports.getCurrentDate = getCurrentDate;
module.exports.getNigeriaTime = getNigeriaTime;
module.exports.handleAutoAttendance = handleAutoAttendance;