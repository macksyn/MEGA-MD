const fs = require('fs');
const path = require('path');
const axios = require('axios');
const cron = require('node-cron');
const isAdmin = require('../lib/isAdmin');
const isOwner = require('../lib/isOwner');

const settingsFile = path.join(__dirname, '../data/trending.json');

let trendingSettings = {
  time: '09:00',
  enabledGroups: [],
  count: 10
};

function loadSettings() {
  try {
    if (fs.existsSync(settingsFile)) {
      trendingSettings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
    }
  } catch (err) {
    console.error('Error loading trending settings:', err);
  }
}

function saveSettings() {
  try {
    fs.writeFileSync(settingsFile, JSON.stringify(trendingSettings, null, 2));
  } catch (err) {
    console.error('Error saving trending settings:', err);
  }
}

async function fetchTrends() {
  try {
    const response = await axios.get('https://discardapi.dpdns.org/api/info/trends?country=Nigeria&apikey=guru');
    if (response.data && response.data.status && response.data.result && response.data.result.result) {
      return response.data.result.result.slice(0, trendingSettings.count);
    }
  } catch (err) {
    console.error('Error fetching trends:', err);
  }
  return [];
}

function formatTrends(trends) {
  let text = `*🌟 Top Trending Topics on X (Twitter) - Today*\n\n`;
  trends.forEach((trend, index) => {
    text += `${index + 1}. *${trend.hastag}*\n   _Rank: ${trend.rank} | ${trend.tweet}_\n\n`;
  });
  text += `*Stay updated with the latest trends!* 🚀\n`;
  text += `*Posted at ${new Date().toLocaleString()}*\n`;
  return text;
}

async function postTrends(sock) {
  const trends = await fetchTrends();
  if (trends.length === 0) return;

  const text = formatTrends(trends);

  for (const groupId of trendingSettings.enabledGroups) {
    try {
      await sock.sendMessage(groupId, { text });
    } catch (err) {
      console.error(`Error posting to ${groupId}:`, err);
    }
  }
}

module.exports = {
  command: 'trending',
  aliases: ['trendingsettings'],
  category: 'admin',
  description: 'Configure trending topics posting',
  usage: '.trending [settime|enable|disable|count|status]',
  isPrefixless: false,

  async handler(sock, message, args, context = {}) {
    const chatId = context.chatId || message.key.remoteJid;
    const senderId = message.key.participant || message.key.remoteJid;

    // Check if admin or owner
    const admin = await isAdmin(sock, chatId, senderId);
    const owner = await isOwner(senderId);
    if (!admin && !owner) {
      return await sock.sendMessage(chatId, { text: '❌ Only admins can use this command.' });
    }

    const subcommand = args[0]?.toLowerCase();

    if (!subcommand) {
      // Show menu
      let menu = `*🌟 Trending Settings Menu*\n\n`;
      menu += `*Current Time:* ${trendingSettings.time}\n`;
      menu += `*Enabled Groups:* ${trendingSettings.enabledGroups.length}\n`;
      menu += `*Trends Count:* ${trendingSettings.count}\n\n`;
      menu += `*Commands:*\n`;
      menu += `.trending settime <HH:MM> - Set posting time\n`;
      menu += `.trending enable - Enable for this group\n`;
      menu += `.trending disable - Disable for this group\n`;
      menu += `.trending count <number> - Set number of trends (1-50)\n`;
      menu += `.trending status - Show current settings\n`;
      menu += `.trending test - Test posting now\n`;
      return await sock.sendMessage(chatId, { text: menu });
    }

    switch (subcommand) {
      case 'settime':
        const time = args[1];
        if (!time || !/^([01]?[0-9]|2[0-3]):[0-5][0-9]$/.test(time)) {
          return await sock.sendMessage(chatId, { text: '❌ Invalid time format. Use HH:MM (24-hour).' });
        }
        trendingSettings.time = time;
        saveSettings();
        return await sock.sendMessage(chatId, { text: `✅ Posting time set to ${time}.` });

      case 'enable':
        if (!chatId.endsWith('@g.us')) {
          return await sock.sendMessage(chatId, { text: '❌ This command can only be used in groups.' });
        }
        if (!trendingSettings.enabledGroups.includes(chatId)) {
          trendingSettings.enabledGroups.push(chatId);
          saveSettings();
          return await sock.sendMessage(chatId, { text: '✅ Trending posts enabled for this group.' });
        } else {
          return await sock.sendMessage(chatId, { text: 'ℹ️ Trending posts are already enabled for this group.' });
        }

      case 'disable':
        if (!chatId.endsWith('@g.us')) {
          return await sock.sendMessage(chatId, { text: '❌ This command can only be used in groups.' });
        }
        const index = trendingSettings.enabledGroups.indexOf(chatId);
        if (index > -1) {
          trendingSettings.enabledGroups.splice(index, 1);
          saveSettings();
          return await sock.sendMessage(chatId, { text: '✅ Trending posts disabled for this group.' });
        } else {
          return await sock.sendMessage(chatId, { text: 'ℹ️ Trending posts are already disabled for this group.' });
        }

      case 'count':
        const count = parseInt(args[1]);
        if (isNaN(count) || count < 1 || count > 50) {
          return await sock.sendMessage(chatId, { text: '❌ Invalid count. Use a number between 1 and 50.' });
        }
        trendingSettings.count = count;
        saveSettings();
        return await sock.sendMessage(chatId, { text: `✅ Number of trends set to ${count}.` });

      case 'status':
        let status = `*🌟 Trending Settings*\n\n`;
        status += `*Time:* ${trendingSettings.time}\n`;
        status += `*Count:* ${trendingSettings.count}\n`;
        status += `*Enabled Groups:*\n`;
        if (trendingSettings.enabledGroups.length === 0) {
          status += 'None\n';
        } else {
          for (const gid of trendingSettings.enabledGroups) {
            try {
              const metadata = await sock.groupMetadata(gid);
              status += `- ${metadata.subject}\n`;
            } catch {
              status += `- ${gid}\n`;
            }
          }
        }
        return await sock.sendMessage(chatId, { text: status });

      case 'test':
        await postTrends(sock);
        return await sock.sendMessage(chatId, { text: '✅ Test post sent to enabled groups.' });

      default:
        return await sock.sendMessage(chatId, { text: '❌ Unknown subcommand. Use .trending for menu.' });
    }
  },

  onLoad: async (sock) => {
    loadSettings();

    // Schedule posting using cron
    const [hours, minutes] = trendingSettings.time.split(':');
    const cronExpression = `${minutes} ${hours} * * *`; // Daily at specified time

    cron.schedule(cronExpression, () => {
      postTrends(sock);
    }, {
      timezone: "Africa/Lagos" // Assuming Nigeria timezone
    });
  }
};