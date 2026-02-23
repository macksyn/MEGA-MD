require('dotenv').config();

const settings = {
  // Array fallback: splits string by comma, or uses default array
  prefixes: process.env.PREFIXES ? process.env.PREFIXES.split(',') : ['.', '!', '/', '#'],

  packname: process.env.PACKNAME || 'GROQ-AI',
  author: process.env.AUTHOR || 'Macksyn Inc',
  timeZone: process.env.TIMEZONE || 'Africa/Lagos',
  botName: process.env.BOT_NAME || "GROQ-AI",
  botOwner: process.env.BOT_OWNER || 'Alex Macksyn',
  ownerNumber: process.env.OWNER_NUMBER || '2348089782988',
  giphyApiKey: process.env.GIPHY_API_KEY || 'qnl7ssQChTdPjsKta2Ax2LMaGXz303tq',
  commandMode: process.env.COMMAND_MODE || "private",

  maxStoreMessages: Number(process.env.MAX_STORE_MESSAGES) || 20,
  tempCleanupInterval: Number(process.env.CLEANUP_INTERVAL) || 1 * 60 * 60 * 1000,
  storeWriteInterval: Number(process.env.STORE_WRITE_INTERVAL) || 10000,

  description: process.env.DESCRIPTION || "This is a bot for managing group commands and automating tasks.",
  version: "5.2.0",
  updateZipUrl: process.env.UPDATE_URL || "https://github.com/macksyn/MEGA-MD/archive/refs/heads/main.zip",
  channelLink: process.env.CHANNEL_LINK || "https://whatsapp.com/channel/0029Vad8fY6HwXbB83yLIx2n",
  ytch: process.env.YT_CHANNEL || "Macksyn"
};

module.exports = settings;