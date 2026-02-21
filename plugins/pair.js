const axios = require('axios');

module.exports = {
  command: 'pair',
  aliases: ['paircode', 'session', 'getsession', 'sessionid'],
  category: 'general',
  description: 'Get session id for GROQ',
  usage: '.pair 234801234XXXX',
  
  async handler(sock, message, args, context = {}) {
    const { chatId } = context;

    const forwardInfo = {
      forwardingScore: 1,
      isForwarded: true,
      forwardedNewsletterMessageInfo: {
        newsletterJid: '120363272892637632@newsletter',
        newsletterName: 'GROQ',
        serverMessageId: -1
      }
    };

    let query = args.join('').trim();
    if (!query) {
      return await sock.sendMessage(chatId, {
        text: "❌ *Missing Number*\nExample: .pair 234801234XXXX",
        contextInfo: forwardInfo
      }, { quoted: message });
    }

    const number = query.replace(/[^0-9]/g, '');

    if (number.length < 10 || number.length > 15) {
      return await sock.sendMessage(chatId, {
        text: "❌ *Invalid Format*\nPlease provide the number with country code but without + or spaces.",
        contextInfo: forwardInfo
      }, { quoted: message });
    }

    await sock.sendMessage(chatId, {
      text: "⚡ *Requesting code from server...*",
      contextInfo: forwardInfo
    }, { quoted: message });

    try {
      const response = await axios.get(`https://megapair-yttf.onrender.com/botcode?number=${number}`, {
        timeout: 60000
      });

      // Server returns plain text like "853F-XWTE", not a JSON object
      const pairingCode = (response.data || '').toString().trim();

      if (!pairingCode || pairingCode.toLowerCase().includes('unavailable') || pairingCode.toLowerCase().includes('error')) {
        throw new Error("Server is busy or returned an invalid code");
      }

      const successText = `✅ *GROQ PAIRING CODE*\n\n` +
                          `Code: *${pairingCode}*\n\n` +
                          `*How to use:*\n` +
                          `1. Open WhatsApp Settings\n` +
                          `2. Tap 'Linked Devices'\n` +
                          `3. Tap 'Link a Device'\n` +
                          `4. Select 'Link with phone number instead'\n` +
                          `5. Enter the code above.`;

      await sock.sendMessage(chatId, {
        text: successText,
        contextInfo: forwardInfo
      }, { quoted: message });

    } catch (error) {
      console.error('Pairing Plugin Error:', error.message);
      
      let errorMsg = "❌ *Pairing Failed*\nReason: ";
      if (error.code === 'ECONNABORTED') {
        errorMsg += "Server timeout. Please try again in 1 minute.";
      } else if (error.response?.status === 400) {
        errorMsg += "Invalid phone number format.";
      } else {
        errorMsg += error.message || "The server is currently offline or busy. Try again later.";
      }

      await sock.sendMessage(chatId, {
        text: errorMsg,
        contextInfo: forwardInfo
      }, { quoted: message });
    }
  }
};