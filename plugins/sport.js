const { fetchJson } = require('../lib/myfunc2');

module.exports = {
  command: 'sport',
  aliases: ['sports', 'sportnews'],
  category: 'news',
  description: 'Get latest sports news from Sky Sports.',
  usage: '.sport [limit]',
  
  async handler(sock, message, args, context = {}) {
    const chatId = context.chatId || message.key.remoteJid;

    try {
      const limit = parseInt(args[0]) || 10; // Default 10, max maybe 20

      const response = await fetchJson(`https://discardapi.dpdns.org/api/news/skysports?sport=football&apikey=guru`);

      if (!response || !response.status || !response.result || !Array.isArray(response.result)) {
        throw new Error('No data received from API');
      }

      const allNews = response.result;
      
      // Remove duplicates based on title
      const seenTitles = new Set();
      const uniqueNews = allNews.filter(item => {
        if (seenTitles.has(item.title)) {
          return false;
        }
        seenTitles.add(item.title);
        return true;
      });

      const news = uniqueNews.slice(0, Math.min(limit, 20)); // Limit to 20 max

      let output = `*🏆 Latest Football News from Sky Sports 🏆*\n\n`;
      
      // Fetch content for top 3 articles
      const topNews = news.slice(0, 3);
      for (let i = 0; i < topNews.length; i++) {
        const item = topNews[i];
        output += `${i + 1}. *${item.title}*\n`;
        
        try {
          const articleResponse = await fetchJson(`https://discardapi.dpdns.org/api/skysports/article?url=${encodeURIComponent(item.url)}&apikey=guru`);
          if (articleResponse && articleResponse.status && articleResponse.result && articleResponse.result.content) {
            let content = articleResponse.result.content;
            
            // Handle different content formats
            if (typeof content === 'string') {
              const paragraphs = content.split('\n\n').filter(p => p.trim().length > 0);
              const summary = paragraphs.slice(0, 2).join('\n\n').substring(0, 300);
              output += `${summary}${summary.length === 300 ? '...' : ''}\n`;
            } else if (Array.isArray(content)) {
              // If content is an array of paragraphs
              const summary = content.slice(0, 2).join('\n\n').substring(0, 300);
              output += `${summary}${summary.length === 300 ? '...' : ''}\n`;
            } else {
              // Fallback: try to convert to string
              const contentStr = String(content).substring(0, 300);
              output += `${contentStr}...\n`;
            }
          }
        } catch (error) {
          console.error(`Error fetching content for ${item.title}:`, error);
        }
        
        output += `🔗 ${item.url}\n\n`;
      }
      
      // Add remaining headlines without content
      if (news.length > 3) {
        output += `*More Headlines:*\n`;
        for (let i = 3; i < news.length; i++) {
          const item = news[i];
          output += `${i + 1}. *${item.title}*\n🔗 ${item.url}\n\n`;
        }
      }
      
      output += '*Stay updated with the latest sports action! ⚽*';

      await sock.sendMessage(chatId, {
        text: output
      }, { quoted: message });

    } catch (error) {
      console.error('Error in sport command:', error);
      await sock.sendMessage(chatId, {
        text: '❌ Failed to fetch sports news. The API might be unavailable.'
      }, { quoted: message });
    }
  }
};