const fs = require('fs');
const path = require('path');
const { fetchJson } = require('../lib/myfunc2');
const store = require('../lib/lightweight_store');

const MONGO_URL = process.env.MONGO_URL;
const POSTGRES_URL = process.env.POSTGRES_URL;
const MYSQL_URL = process.env.MYSQL_URL;
const SQLITE_URL = process.env.DB_URL;
const HAS_DB = !!(MONGO_URL || POSTGRES_URL || MYSQL_URL || SQLITE_URL);

const configPath = path.join(__dirname, '..', 'data', 'x_autoposter.json');

// Twitter API credentials
const TWITTER_BEARER_TOKEN = process.env.TWITTER_BEARER_TOKEN || 'AAAAAAAAAAAAAAAAAAAAAAeD3gEAAAAAk5PzVVAkdvEdC8ZoVYKqkLurJ30%3D9c8uLrn1nT7FiwaTAmdjZNU2uhF8rR1n1Xgufs4lU81kWbN2xk';

async function initConfig() {
    if (HAS_DB) {
        const config = await store.getSetting('global', 'x_autoposter');
        return config || { accounts: [] };
    } else {
        if (!fs.existsSync(configPath)) {
            const dataDir = path.dirname(configPath);
            if (!fs.existsSync(dataDir)) {
                fs.mkdirSync(dataDir, { recursive: true });
            }
            fs.writeFileSync(configPath, JSON.stringify({ accounts: [] }, null, 2));
        }
        return JSON.parse(fs.readFileSync(configPath));
    }
}

async function saveConfig(config) {
    if (HAS_DB) {
        await store.saveSetting('global', 'x_autoposter', config);
    } else {
        fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
    }
}

// Get user ID by username using X API v2
async function getUserIdByUsername(username) {
    const url = `https://api.twitter.com/2/users/by/username/${encodeURIComponent(username)}`;
    try {
        const data = await fetchJson(url, { headers: { 'Authorization': `Bearer ${TWITTER_BEARER_TOKEN}` } });
        return data?.data?.id;
    } catch (error) {
        console.error('Error getting user ID:', error);
        return null;
    }
}

// Fetch recent tweets from a user
async function fetchRecentTweets(userId, sinceId = null) {
    const expansions = ['attachments.media_keys', 'author_id'];
    const mediaFields = ['url', 'preview_image_url', 'type'];
    let url = `https://api.twitter.com/2/users/${userId}/tweets?expansions=${expansions.join(',')}&media.fields=${mediaFields.join(',')}&tweet.fields=created_at,public_metrics&max_results=5`;
    
    if (sinceId) {
        url += `&since_id=${sinceId}`;
    }

    try {
        const data = await fetchJson(url, { headers: { 'Authorization': `Bearer ${TWITTER_BEARER_TOKEN}` } });
        return data || {};
    } catch (error) {
        console.error('Error fetching tweets:', error);
        return {};
    }
}

// Download media from URL
async function downloadMedia(url) {
    try {
        const response = await fetch(url);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        
        const buffer = await response.arrayBuffer();
        const contentType = response.headers.get('content-type') || 'application/octet-stream';
        
        return {
            buffer: Buffer.from(buffer),
            contentType
        };
    } catch (error) {
        console.error('Error downloading media:', error);
        return null;
    }
}

async function formatTweetMessage(tweet, username) {
    const text = tweet.text || '';
    const createdAt = tweet.created_at ? new Date(tweet.created_at).toLocaleString() : 'Unknown time';
    const likes = tweet.public_metrics?.like_count || 0;
    const retweets = tweet.public_metrics?.retweet_count || 0;
    const replies = tweet.public_metrics?.reply_count || 0;
    const url = `https://x.com/${username}/status/${tweet.id}`;

    return `🔁 *New tweet from @${username}*\n\n${text}\n\n📅 ${createdAt}\n👍 ${likes} 🔄 ${retweets} 💬 ${replies}\n🔗 ${url}`;
}

async function postLatestTweet(sock, account) {
    try {
        // Ensure we have user ID
        if (!account.userId) {
            const userId = await getUserIdByUsername(account.username);
            if (!userId) {
                console.error(`Could not get user ID for @${account.username}`);
                return;
            }
            account.userId = userId;
            const config = await initConfig();
            const accIndex = config.accounts.findIndex(a => a.username === account.username);
            if (accIndex !== -1) {
                config.accounts[accIndex] = account;
                await saveConfig(config);
            }
        }

        // Fetch tweets since last posted
        const response = await fetchRecentTweets(account.userId, account.lastPostedId);
        const tweets = response.data || [];
        const mediaMap = {};

        // Build media map
        if (response.includes && response.includes.media) {
            for (const media of response.includes.media) {
                if (media.media_key) {
                    mediaMap[media.media_key] = media;
                }
            }
        }

        if (tweets.length === 0) {
            return; // No new tweets
        }

        // Sort by ID (oldest first)
        tweets.sort((a, b) => {
            const aId = BigInt(a.id);
            const bId = BigInt(b.id);
            return aId < bId ? -1 : aId > bId ? 1 : 0;
        });

        // Post up to the limit
        const limit = account.tweetLimit || 5;
        const tweetsToPost = tweets.slice(0, limit);

        for (const tweet of tweetsToPost) {
            const message = await formatTweetMessage(tweet, account.username);
            
            // Get media attachments
            const mediaKeys = tweet?.attachments?.media_keys || [];
            const mediaItems = [];

            for (const key of mediaKeys) {
                const media = mediaMap[key];
                if (media && (media.type === 'photo' || media.type === 'video' || media.type === 'animated_gif')) {
                    const mediaUrl = media.url || media.preview_image_url;
                    if (mediaUrl) {
                        const downloaded = await downloadMedia(mediaUrl);
                        if (downloaded) {
                            mediaItems.push({
                                buffer: downloaded.buffer,
                                contentType: downloaded.contentType,
                                type: media.type
                            });
                        }
                    }
                }
            }

            try {
                if (mediaItems.length === 0) {
                    // No media, send text only
                    await sock.sendMessage(account.targetChatId, { text: message });
                } else {
                    // Send first media item with caption
                    const firstMedia = mediaItems[0];
                    if (firstMedia.type === 'photo' || firstMedia.type === 'animated_gif') {
                        await sock.sendMessage(account.targetChatId, {
                            image: firstMedia.buffer,
                            caption: message
                        });
                    } else if (firstMedia.type === 'video') {
                        await sock.sendMessage(account.targetChatId, {
                            video: firstMedia.buffer,
                            caption: message
                        });
                    }

                    // Send additional media without caption
                    for (let i = 1; i < mediaItems.length; i++) {
                        const media = mediaItems[i];
                        if (media.type === 'photo' || media.type === 'animated_gif') {
                            await sock.sendMessage(account.targetChatId, { image: media.buffer });
                        } else if (media.type === 'video') {
                            await sock.sendMessage(account.targetChatId, { video: media.buffer });
                        }
                    }
                }

                account.lastPostedId = tweet.id; // Update last posted
            } catch (error) {
                console.error(`Error posting tweet ${tweet.id}:`, error);
            }
        }

        // Save updated account
        const config = await initConfig();
        const accIndex = config.accounts.findIndex(a => a.username === account.username);
        if (accIndex !== -1) {
            config.accounts[accIndex] = account;
            await saveConfig(config);
        }

    } catch (error) {
        console.error(`Error posting latest tweet for @${account.username}:`, error);
    }
}

module.exports = {
    command: 'xpost',
    aliases: ['twitterpost', 'tweetpost'],
    category: 'automation',
    description: 'Manage automatic posting of tweets from X (Twitter) accounts',
    usage: '.xpost <add/remove/list> [username] [chatId]',
    isPrefixless: false,

    async handler(sock, message, args, context = {}) {
        const chatId = context.chatId || message.key.remoteJid;
        const isOwner = context.senderIsOwnerOrSudo || false;
        const isAdmin = context.isSenderAdmin || false;

        if (!isOwner && !isAdmin) {
            return await sock.sendMessage(chatId, { text: '❌ Only bot owner, sudo, or admins can manage X auto-poster.' });
        }

        const action = args[0]?.toLowerCase();
        const config = await initConfig();

        if (!action) {
            return await sock.sendMessage(chatId, {
                text: `*X Auto-Poster Commands*\n\n.xpost add <username> [chatId] - Add account for auto-posting\n.xpost remove <username> - Remove account\n.xpost list - List configured accounts\n.xpost test <username> - Test by posting latest tweets\n.xpost setlimit <username> <1-10> - Set tweets per check\n.xpost setinterval <username> <15-1440> - Set check interval (minutes)`
            });
        }

        switch (action) {
            case 'add': {
                const username = args[1]?.replace(/^@/, '');
                const targetChatId = args[2] || chatId;

                if (!username) {
                    return await sock.sendMessage(chatId, { text: 'Please provide a Twitter username.\nUsage: .xpost add <username> [chatId]' });
                }

                // Check if already exists
                if (config.accounts.some(acc => acc.username === username)) {
                    return await sock.sendMessage(chatId, { text: `❌ @${username} is already configured.` });
                }

                config.accounts.push({
                    username,
                    targetChatId,
                    enabled: true,
                    lastPostedId: null,
                    tweetLimit: 5, // Default: post up to 5 tweets per check
                    intervalMinutes: 60, // Default: check every 60 minutes
                    lastCheckAt: null, // Track last check time
                    createdAt: new Date().toISOString()
                });

                await saveConfig(config);
                await sock.sendMessage(chatId, { text: `✅ Added @${username} for auto-posting to ${targetChatId}` });
                break;
            }

            case 'remove': {
                const username = args[1]?.replace(/^@/, '');

                if (!username) {
                    return await sock.sendMessage(chatId, { text: 'Please provide a Twitter username.\nUsage: .xpost remove <username>' });
                }

                const index = config.accounts.findIndex(acc => acc.username === username);
                if (index === -1) {
                    return await sock.sendMessage(chatId, { text: `❌ @${username} is not configured.` });
                }

                config.accounts.splice(index, 1);
                await saveConfig(config);
                await sock.sendMessage(chatId, { text: `✅ Removed @${username} from auto-posting.` });
                break;
            }

            case 'list': {
                if (config.accounts.length === 0) {
                    return await sock.sendMessage(chatId, { text: 'No accounts configured for auto-posting.' });
                }

                let text = '*Configured X Accounts:*\n\n';
                config.accounts.forEach(acc => {
                    text += `• @${acc.username} → ${acc.targetChatId}\n`;
                    text += `  Status: ${acc.enabled ? 'Enabled' : 'Disabled'}\n`;
                    text += `  Limit: ${acc.tweetLimit || 5} tweets/check\n`;
                    text += `  Interval: ${acc.intervalMinutes || 60} minutes\n`;
                    if (acc.lastCheckAt) {
                        const lastCheck = new Date(acc.lastCheckAt).toLocaleString();
                        text += `  Last Check: ${lastCheck}\n`;
                    }
                    text += '\n';
                });

                await sock.sendMessage(chatId, { text });
                break;
            }

            case 'test': {
                const username = args[1]?.replace(/^@/, '');

                if (!username) {
                    return await sock.sendMessage(chatId, { text: 'Please provide a Twitter username.\nUsage: .xpost test <username>' });
                }

                const account = config.accounts.find(acc => acc.username === username);
                if (!account) {
                    return await sock.sendMessage(chatId, { text: `❌ @${username} is not configured. Add it first with .xpost add ${username}` });
                }

                await sock.sendMessage(chatId, { text: `🧪 Testing @${username}...` });

                await postLatestTweet(sock, account);
                await sock.sendMessage(chatId, { text: `✅ Test completed. Check ${account.targetChatId} for posted tweets.` });
                break;
            }

            case 'setlimit': {
                const username = args[1]?.replace(/^@/, '');
                const limit = parseInt(args[2]);

                if (!username || !limit || limit < 1 || limit > 10) {
                    return await sock.sendMessage(chatId, { text: 'Usage: .xpost setlimit <username> <1-10>\nSets how many tweets to post per check (max 10).' });
                }

                const account = config.accounts.find(acc => acc.username === username);
                if (!account) {
                    return await sock.sendMessage(chatId, { text: `❌ @${username} is not configured.` });
                }

                account.tweetLimit = limit;
                await saveConfig(config);
                await sock.sendMessage(chatId, { text: `✅ Set @${username} tweet limit to ${limit} per check.` });
                break;
            }

            case 'setinterval': {
                const username = args[1]?.replace(/^@/, '');
                const minutes = parseInt(args[2]);

                if (!username || !minutes || minutes < 15 || minutes > 1440) {
                    return await sock.sendMessage(chatId, { text: 'Usage: .xpost setinterval <username> <15-1440>\nSets check interval in minutes (15 min to 24 hours).' });
                }

                const account = config.accounts.find(acc => acc.username === username);
                if (!account) {
                    return await sock.sendMessage(chatId, { text: `❌ @${username} is not configured.` });
                }

                account.intervalMinutes = minutes;
                await saveConfig(config);
                await sock.sendMessage(chatId, { text: `✅ Set @${username} check interval to ${minutes} minutes.` });
                break;
            }

            default:
                await sock.sendMessage(chatId, { text: 'Invalid action. Use .xpost for help.' });
        }
    },

    schedules: [
        {
            every: 15 * 60 * 1000, // Check every 15 minutes
            handler: async (sock) => {
                const config = await initConfig();
                const now = Date.now();

                for (const account of config.accounts) {
                    if (!account.enabled) continue;

                    const intervalMs = (account.intervalMinutes || 60) * 60 * 1000;
                    const lastCheck = account.lastCheckAt || 0;

                    if (now - lastCheck >= intervalMs) {
                        try {
                            await postLatestTweet(sock, account);
                            account.lastCheckAt = now; // Update last check time
                            const updatedConfig = await initConfig();
                            const accIndex = updatedConfig.accounts.findIndex(a => a.username === account.username);
                            if (accIndex !== -1) {
                                updatedConfig.accounts[accIndex] = account;
                                await saveConfig(updatedConfig);
                            }
                        } catch (error) {
                            console.error(`Error auto-posting for @${account.username}:`, error);
                        }
                    }
                }
            }
        }
    ]
};