let urlRegex = null;
try {
  urlRegex = require('url-regex-safe');
} catch (e) {
  urlRegex = null; // fallback to simple regex below
}

module.exports = {
  command: 'download',
  aliases: ['dl'],
  category: 'download',
  description: 'Universal downloader: auto-detects service and downloads media',
  usage: '.download <url>',

  async handler(sock, message, args = [], context = {}) {
    const chatId = context.chatId || message.key.remoteJid;
    const senderId = context.senderId || message.key.participant || message.key.remoteJid;

    let url = args[0];
    if (!url) {
      // Try to extract URL from message text
      const text = (message?.message?.conversation || message?.message?.extendedTextMessage?.text || '').trim();
      const found = (urlRegex ? text.match(urlRegex()) : text.match(/https?:\/\/\S+/i)) || [];
      url = found[0];
    }

    if (!url) {
      return await sock.sendMessage(chatId, { text: '❌ Provide a link to download. Example: .download <url>' }, { quoted: message });
    }

    const normalized = url.trim();

    // simple detection map
    const detectors = [
      { regex: /(?:vm\.)?tiktok\.com/i, plugin: './tiktok' },
      { regex: /(?:x\.com|twitter\.com)/i, plugin: './twitter' },
      { regex: /facebook\.com|fb\.watch/i, plugin: './facebook' },
      { regex: /instagram\.com|instagr\.am/i, plugin: './instagram' },
      { regex: /(?:youtube\.com|youtu\.be)/i, plugin: './song' },
      { regex: /mega\.nz/i, plugin: './mega' },
      { regex: /terabox\.com|1024terabox\.com/i, plugin: './terabox' },
      { regex: /snapchat\.com|snap\.chat/i, plugin: './snapchat' },
      { regex: /spotify\.com/i, plugin: './spotify' }
    ];

    try {
      await sock.sendMessage(chatId, { text: '⏳ Detecting service and downloading...' }, { quoted: message });

      for (const d of detectors) {
        if (d.regex.test(normalized)) {
          try {
            const plugin = require(d.plugin);
            // call handler with the URL as first arg
            return await plugin.handler(sock, message, [normalized], { chatId, senderId });
          } catch (e) {
            console.error('[DOWNLOAD] Delegate error:', e.message);
            return await sock.sendMessage(chatId, { text: `❌ Error delegating to ${d.plugin}: ${e.message}` }, { quoted: message });
          }
        }
      }

      // Fallback: if link looks like direct media or unknown host, use fetch plugin
      const fetchPlugin = require('./fetch');
      return await fetchPlugin.handler(sock, message, [normalized], { chatId, senderId });

    } catch (error) {
      console.error('[DOWNLOAD] error:', error.message);
      await sock.sendMessage(chatId, { text: `❌ Download failed: ${error.message}` }, { quoted: message });
    }
  }
};
