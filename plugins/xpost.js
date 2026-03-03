'use strict';

/**
 * plugins/xpost.js
 *
 * Monitors X (Twitter) accounts and auto-posts new tweets to WhatsApp chats.
 *
 * ── Infrastructure used (zero extra wiring required) ──────────────────────────
 *   Storage  → lib/pluginStore  (createStore)        isolated physical table
 *   Schedule → lib/pluginLoader (schedules[])         15-min interval, auto-registered
 *   HTTP     → lib/myfunc2      (fetchJson)           returns Error obj on failure
 *   Logging  → lib/print        (printLog)            consistent with rest of bot
 *
 * ── Setup ─────────────────────────────────────────────────────────────────────
 *   Add to your .env file:
 *     TWITTER_BEARER_TOKEN=your_twitter_bearer_token_here
 *
 *   Commands (owner / sudo / group-admin only):
 *     .xpost add <username> [chatId]     – start tracking an account
 *     .xpost remove <username>           – stop tracking
 *     .xpost list                        – show all tracked accounts
 *     .xpost test <username>             – force-check right now
 *     .xpost enable <username>           – resume a paused account
 *     .xpost disable <username>          – pause without removing
 *     .xpost setlimit <username> <1-10>  – max tweets per check
 *     .xpost setinterval <username> <15-1440>  – minutes between checks
 */

const { fetchJson }    = require('../lib/myfunc2');
const { createStore }  = require('../lib/pluginStore');
const { printLog }     = require('../lib/print');

// ── Storage ────────────────────────────────────────────────────────────────────
// Physical table name: plugin_xpost  (or data/plugin_xpost.json in file-mode)
//
// Keys stored:
//   '__list__'   → string[]      ordered list of tracked usernames
//   '<username>' → AccountObject full config for that account
//
const db = createStore('xpost');

// ── Bearer token ───────────────────────────────────────────────────────────────
// MUST be in .env as TWITTER_BEARER_TOKEN.
// No hardcoded fallback — a wrong token causes silent failures that are very
// hard to debug, so we fail loudly and early instead.
function getBearerToken() {
    const token = process.env.TWITTER_BEARER_TOKEN;
    if (!token) {
        printLog('warning', '[xpost] TWITTER_BEARER_TOKEN not set in .env — auto-posting disabled.');
    }
    return token || null;
}

// ── Twitter API helpers ────────────────────────────────────────────────────────
//
// myfunc2.fetchJson RETURNS the caught Error object instead of throwing it.
// Every call through twitterGet() handles that contract in one place.

async function twitterGet(path) {
    const token = getBearerToken();
    if (!token) return null;

    const data = await fetchJson(`https://api.twitter.com/2/${path}`, {
        headers: { Authorization: `Bearer ${token}` }
    });

    if (data instanceof Error) {
        // Provide actionable feedback for the most common Twitter errors
        const status  = data.response?.status;
        const title   = data.response?.data?.title || data.message || String(data);

        if (status === 401) {
            printLog('error', '[xpost] Twitter 401 — TWITTER_BEARER_TOKEN is invalid or expired');
        } else if (status === 403) {
            printLog('error', '[xpost] Twitter 403 — app may lack required API permissions');
        } else if (status === 429) {
            printLog('warning', '[xpost] Twitter rate-limited (429) — will retry next cycle');
        } else {
            printLog('error', `[xpost] Twitter API error (${status || '?'}): ${title}`);
        }
        return null;
    }

    return data;
}

async function resolveUserId(username) {
    const data = await twitterGet(
        `users/by/username/${encodeURIComponent(username)}`
    );
    return data?.data?.id || null;
}

async function fetchRecentTweets(userId, sinceId) {
    const params = new URLSearchParams({
        expansions:      'attachments.media_keys,author_id',
        'media.fields':  'url,preview_image_url,type',
        'tweet.fields':  'created_at,public_metrics',
        max_results:     '10'
    });
    if (sinceId) params.set('since_id', sinceId);

    const data = await twitterGet(`users/${userId}/tweets?${params}`);
    return data || {};
}

// ── Media download ─────────────────────────────────────────────────────────────

const MAX_MEDIA_BYTES = 15 * 1024 * 1024; // 15 MB — WhatsApp hard limit

async function downloadMedia(url) {
    try {
        const response = await fetch(url);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);

        // Honour Content-Length header before buffering to avoid RAM spike
        const clHeader = response.headers.get('content-length');
        if (clHeader && parseInt(clHeader, 10) > MAX_MEDIA_BYTES) {
            printLog('warning', `[xpost] Skipping oversized media (${clHeader} bytes declared)`);
            return null;
        }

        const arrayBuf = await response.arrayBuffer();
        if (arrayBuf.byteLength > MAX_MEDIA_BYTES) {
            printLog('warning', `[xpost] Skipping oversized media (${arrayBuf.byteLength} bytes after download)`);
            return null;
        }

        return {
            buffer:      Buffer.from(arrayBuf),
            contentType: response.headers.get('content-type') || 'application/octet-stream'
        };
    } catch (err) {
        printLog('error', `[xpost] downloadMedia failed for ${url}: ${err.message}`);
        return null;
    }
}

// ── Message formatter ──────────────────────────────────────────────────────────

function formatTweetMessage(tweet, username) {
    const text      = tweet.text || '';
    const createdAt = tweet.created_at
        ? new Date(tweet.created_at).toLocaleString()
        : 'Unknown time';

    const {
        like_count:    likes    = 0,
        retweet_count: retweets = 0,
        reply_count:   replies  = 0
    } = tweet.public_metrics || {};

    return (
        `🔁 *New tweet from @${username}*\n\n` +
        `${text}\n\n` +
        `📅 ${createdAt}\n` +
        `👍 ${likes}  🔄 ${retweets}  💬 ${replies}\n` +
        `🔗 https://x.com/${username}/status/${tweet.id}`
    );
}

// ── Storage helpers ────────────────────────────────────────────────────────────

async function getAccountList() {
    return db.getOrDefault('__list__', []);
}

async function getAccount(username) {
    return db.get(username);
}

async function saveAccount(account) {
    await db.set(account.username, account);

    // Keep the index in sync
    const list = await getAccountList();
    if (!list.includes(account.username)) {
        list.push(account.username);
        await db.set('__list__', list);
    }
}

async function deleteAccount(username) {
    await db.del(username);

    const list = await getAccountList();
    const idx  = list.indexOf(username);
    if (idx !== -1) {
        list.splice(idx, 1);
        await db.set('__list__', list);
    }
}

async function getAllAccounts() {
    const list     = await getAccountList();
    const accounts = [];
    for (const username of list) {
        const acc = await getAccount(username);
        if (acc) accounts.push(acc);
    }
    return accounts;
}

// ── Core posting logic ─────────────────────────────────────────────────────────

async function postNewTweets(sock, account) {
    const username = account.username;

    // Lazy-resolve Twitter userId on first run, then persist it so we don't
    // burn rate-limit budget on lookups every 15 minutes.
    if (!account.userId) {
        printLog('info', `[xpost] Resolving userId for @${username}…`);
        const userId = await resolveUserId(username);
        if (!userId) {
            printLog('error', `[xpost] Could not resolve userId for @${username} — skipping`);
            return;
        }
        account.userId = userId;
        await saveAccount(account);
        printLog('success', `[xpost] @${username} userId = ${userId}`);
    }

    const response = await fetchRecentTweets(account.userId, account.lastPostedId || null);
    const tweets   = response.data || [];

    if (tweets.length === 0) {
        printLog('info', `[xpost] No new tweets for @${username}`);
        return;
    }

    // Build media key → object map from Twitter's "expansions" block
    const mediaMap = {};
    for (const media of (response.includes?.media || [])) {
        if (media.media_key) mediaMap[media.media_key] = media;
    }

    // Sort oldest-first so WhatsApp chat shows chronological order
    tweets.sort((a, b) => {
        try {
            const aId = BigInt(a.id);
            const bId = BigInt(b.id);
            return aId < bId ? -1 : aId > bId ? 1 : 0;
        } catch {
            return 0;
        }
    });

    const tweetsToPost = tweets.slice(0, account.tweetLimit || 5);
    printLog('info', `[xpost] @${username}: ${tweetsToPost.length} tweet(s) to send`);

    for (const tweet of tweetsToPost) {
        const text       = formatTweetMessage(tweet, username);
        const mediaItems = [];

        for (const key of (tweet.attachments?.media_keys || [])) {
            const media = mediaMap[key];
            if (!media) continue;
            if (!['photo', 'video', 'animated_gif'].includes(media.type)) continue;

            const mediaUrl = media.url || media.preview_image_url;
            if (!mediaUrl) continue;

            const downloaded = await downloadMedia(mediaUrl);
            if (downloaded) mediaItems.push({ ...downloaded, type: media.type });
        }

        try {
            if (mediaItems.length === 0) {
                // Text-only tweet
                await sock.sendMessage(account.targetChatId, { text });
            } else {
                // First item carries the caption
                const first = mediaItems[0];
                const isVideo = first.type === 'video';
                await sock.sendMessage(
                    account.targetChatId,
                    isVideo
                        ? { video: first.buffer, caption: text }
                        : { image: first.buffer, caption: text }
                );

                // Any additional media items — no caption (WhatsApp thread)
                for (let i = 1; i < mediaItems.length; i++) {
                    const m = mediaItems[i];
                    await sock.sendMessage(
                        account.targetChatId,
                        m.type === 'video' ? { video: m.buffer } : { image: m.buffer }
                    );
                }
            }

            // ── Advance the cursor ONLY after a confirmed successful send ──────
            // If we advanced before the send and the send failed, that tweet
            // would be silently skipped forever.
            account.lastPostedId = tweet.id;
            await saveAccount(account);
            printLog('success', `[xpost] ✓ @${username} tweet ${tweet.id} sent`);

        } catch (err) {
            printLog('error', `[xpost] Failed to send tweet ${tweet.id} for @${username}: ${err.message}`);
            // Do NOT advance lastPostedId — retry this tweet on the next cycle
            break; // Stop this account's batch; the failing tweet will be retried
        }
    }
}

// ── Scheduled check ────────────────────────────────────────────────────────────
// Called automatically by pluginLoader every 15 minutes (see `schedules` below).
// Each account has its own `intervalMinutes` setting; we honour that here so
// a high-volume account can check every 15 min while a low-volume one checks
// every few hours — without needing separate timers.

async function runScheduledCheck(sock) {
    if (!sock) {
        printLog('warning', '[xpost] Schedule fired but sock not ready — skipping');
        return;
    }
    if (!getBearerToken()) return;

    const accounts = await getAllAccounts();
    if (accounts.length === 0) return;

    const now = Date.now();
    printLog('info', `[xpost] Scheduled check — ${accounts.length} account(s)`);

    for (const account of accounts) {
        if (!account.enabled) continue;

        const intervalMs  = (account.intervalMinutes || 60) * 60_000;
        const lastCheckMs = account.lastCheckAt ? new Date(account.lastCheckAt).getTime() : 0;

        if (now - lastCheckMs < intervalMs) {
            const minsLeft = Math.ceil((intervalMs - (now - lastCheckMs)) / 60_000);
            printLog('info', `[xpost] @${account.username} — next check in ${minsLeft} min`);
            continue;
        }

        try {
            await postNewTweets(sock, account);

            // Re-read from DB after postNewTweets (it may have mutated lastPostedId)
            const refreshed = await getAccount(account.username);
            if (refreshed) {
                refreshed.lastCheckAt = new Date().toISOString();
                await saveAccount(refreshed);
            }
        } catch (err) {
            printLog('error', `[xpost] Unhandled error for @${account.username}: ${err.message}`);
        }
    }
}

// ── Plugin export ──────────────────────────────────────────────────────────────

module.exports = {
    command:      'xpost',
    aliases:      ['twitterpost', 'tweetpost'],
    category:     'automation',
    description:  'Monitor X (Twitter) accounts and auto-post new tweets to WhatsApp chats',
    usage:        '.xpost <add|remove|list|test|enable|disable|setlimit|setinterval>',
    ownerOnly:    false, // permission check is inside handler (owner/sudo/admin)

    // ── onLoad ─────────────────────────────────────────────────────────────────
    // pluginLoader calls this once when the bot connects.
    // We run an immediate first check (with a short delay so the socket is
    // fully ready) so users don't have to wait up to 15 minutes after a restart.
    async onLoad(sock) {
        const accounts = await getAllAccounts();
        const enabled  = accounts.filter(a => a.enabled).length;
        printLog('success', `[xpost] Loaded — ${accounts.length} account(s), ${enabled} enabled`);

        if (!getBearerToken()) {
            printLog('warning', '[xpost] Add TWITTER_BEARER_TOKEN to .env to enable auto-posting');
            return;
        }

        if (enabled > 0) {
            // 10 s grace period so the bot finishes its startup sequence first
            setTimeout(() => runScheduledCheck(sock), 10_000);
        }
    },

    // ── schedules ──────────────────────────────────────────────────────────────
    // pluginLoader registers this automatically — no manual setInterval needed.
    // Fires every 15 min; per-account intervalMinutes is enforced inside
    // runScheduledCheck(), so this is just the polling heartbeat.
    schedules: [
        {
            every:   15 * 60_000, // 15 minutes
            handler: runScheduledCheck
        }
    ],

    // ── Command handler ────────────────────────────────────────────────────────
    async handler(sock, message, args, context = {}) {
        const chatId  = context.chatId  || message.key.remoteJid;
        const isOwner = context.senderIsOwnerOrSudo || false;
        const isAdmin = context.isSenderAdmin        || false;

        if (!isOwner && !isAdmin) {
            return sock.sendMessage(chatId, {
                text: '❌ Only the bot owner, sudo users, or group admins can manage X auto-poster.'
            }, { quoted: message });
        }

        const action = (args[0] || '').toLowerCase();

        // ── Help ──────────────────────────────────────────────────────────────
        if (!action) {
            return sock.sendMessage(chatId, {
                text:
                    `*📢 X Auto-Poster — Commands*\n\n` +
                    `*.xpost add* <user> [chatId] — Track an account\n` +
                    `*.xpost remove* <user> — Stop tracking\n` +
                    `*.xpost list* — Show all tracked accounts\n` +
                    `*.xpost test* <user> — Force-check right now\n` +
                    `*.xpost enable* <user> — Resume auto-posting\n` +
                    `*.xpost disable* <user> — Pause auto-posting\n` +
                    `*.xpost setlimit* <user> <1-10> — Tweets per check\n` +
                    `*.xpost setinterval* <user> <15-1440> — Minutes between checks\n\n` +
                    `_Set TWITTER_BEARER_TOKEN in .env to activate. ` +
                    `Scheduler polls every 15 min and respects each account's own interval._`
            }, { quoted: message });
        }

        // Warn early about missing token for everything except list/remove
        // (those don't need the API and should still work for housekeeping)
        if (!getBearerToken() && !['list', 'remove'].includes(action)) {
            return sock.sendMessage(chatId, {
                text: '❌ *TWITTER_BEARER_TOKEN* is not set in .env\n\nAdd it and restart the bot.'
            }, { quoted: message });
        }

        switch (action) {

            // ── add ───────────────────────────────────────────────────────────
            case 'add': {
                const username     = args[1]?.replace(/^@/, '').toLowerCase();
                const targetChatId = args[2] || chatId;

                if (!username) {
                    return sock.sendMessage(chatId, {
                        text: 'Usage: .xpost add <username> [targetChatId]'
                    }, { quoted: message });
                }

                if (await getAccount(username)) {
                    return sock.sendMessage(chatId, {
                        text: `❌ @${username} is already configured.\nUse *.xpost list* to see it.`
                    }, { quoted: message });
                }

                await saveAccount({
                    username,
                    targetChatId,
                    enabled:         true,
                    userId:          null,   // resolved on first check
                    lastPostedId:    null,   // null = only new tweets from now on
                    tweetLimit:      5,
                    intervalMinutes: 60,
                    lastCheckAt:     null,
                    createdAt:       new Date().toISOString()
                });

                return sock.sendMessage(chatId, {
                    text:
                        `✅ *@${username}* added!\n\n` +
                        `📨 Posts to: ${targetChatId}\n` +
                        `⏱ Limit: 5 tweets/check · Interval: 60 min\n\n` +
                        `_Use .xpost test ${username} to post immediately._`
                }, { quoted: message });
            }

            // ── remove ────────────────────────────────────────────────────────
            case 'remove': {
                const username = args[1]?.replace(/^@/, '').toLowerCase();
                if (!username) {
                    return sock.sendMessage(chatId, { text: 'Usage: .xpost remove <username>' }, { quoted: message });
                }
                if (!await getAccount(username)) {
                    return sock.sendMessage(chatId, { text: `❌ @${username} is not configured.` }, { quoted: message });
                }
                await deleteAccount(username);
                return sock.sendMessage(chatId, { text: `✅ @${username} removed.` }, { quoted: message });
            }

            // ── list ──────────────────────────────────────────────────────────
            case 'list': {
                const accounts = await getAllAccounts();
                if (accounts.length === 0) {
                    return sock.sendMessage(chatId, {
                        text: 'No X accounts configured.\nUse *.xpost add <username>* to start.'
                    }, { quoted: message });
                }

                let text = `*📋 Tracked X Accounts (${accounts.length})*\n\n`;
                for (const acc of accounts) {
                    const last = acc.lastCheckAt
                        ? new Date(acc.lastCheckAt).toLocaleString()
                        : 'Never';
                    text += `• *@${acc.username}*  ${acc.enabled ? '✅' : '⏸ paused'}\n`;
                    text += `  → ${acc.targetChatId}\n`;
                    text += `  Limit: ${acc.tweetLimit || 5}/check · Interval: ${acc.intervalMinutes || 60} min\n`;
                    text += `  Last check: ${last}\n\n`;
                }
                return sock.sendMessage(chatId, { text }, { quoted: message });
            }

            // ── test ──────────────────────────────────────────────────────────
            case 'test': {
                const username = args[1]?.replace(/^@/, '').toLowerCase();
                if (!username) {
                    return sock.sendMessage(chatId, { text: 'Usage: .xpost test <username>' }, { quoted: message });
                }

                const account = await getAccount(username);
                if (!account) {
                    return sock.sendMessage(chatId, {
                        text: `❌ @${username} not configured.\nAdd it first: .xpost add ${username}`
                    }, { quoted: message });
                }

                await sock.sendMessage(chatId, { text: `🔍 Checking @${username}…` }, { quoted: message });
                await postNewTweets(sock, account);

                // Update lastCheckAt for the manual test too
                const refreshed = await getAccount(username);
                if (refreshed) {
                    refreshed.lastCheckAt = new Date().toISOString();
                    await saveAccount(refreshed);
                }

                return sock.sendMessage(chatId, {
                    text: `✅ Done. Any new tweets were sent to:\n${account.targetChatId}`
                }, { quoted: message });
            }

            // ── enable / disable ──────────────────────────────────────────────
            case 'enable':
            case 'disable': {
                const username = args[1]?.replace(/^@/, '').toLowerCase();
                if (!username) {
                    return sock.sendMessage(chatId, { text: `Usage: .xpost ${action} <username>` }, { quoted: message });
                }
                const account = await getAccount(username);
                if (!account) {
                    return sock.sendMessage(chatId, { text: `❌ @${username} not configured.` }, { quoted: message });
                }
                account.enabled = (action === 'enable');
                await saveAccount(account);
                return sock.sendMessage(chatId, {
                    text: `✅ @${username} auto-posting ${account.enabled ? '*enabled*' : '*paused*'}.`
                }, { quoted: message });
            }

            // ── setlimit ──────────────────────────────────────────────────────
            case 'setlimit': {
                const username = args[1]?.replace(/^@/, '').toLowerCase();
                const limit    = parseInt(args[2], 10);

                if (!username || isNaN(limit) || limit < 1 || limit > 10) {
                    return sock.sendMessage(chatId, {
                        text: 'Usage: .xpost setlimit <username> <1-10>'
                    }, { quoted: message });
                }
                const account = await getAccount(username);
                if (!account) {
                    return sock.sendMessage(chatId, { text: `❌ @${username} not configured.` }, { quoted: message });
                }
                account.tweetLimit = limit;
                await saveAccount(account);
                return sock.sendMessage(chatId, {
                    text: `✅ @${username} tweet limit → *${limit}* per check.`
                }, { quoted: message });
            }

            // ── setinterval ───────────────────────────────────────────────────
            case 'setinterval': {
                const username = args[1]?.replace(/^@/, '').toLowerCase();
                const minutes  = parseInt(args[2], 10);

                if (!username || isNaN(minutes) || minutes < 15 || minutes > 1440) {
                    return sock.sendMessage(chatId, {
                        text: 'Usage: .xpost setinterval <username> <15-1440>\n(min 15 min, max 24 h)'
                    }, { quoted: message });
                }
                const account = await getAccount(username);
                if (!account) {
                    return sock.sendMessage(chatId, { text: `❌ @${username} not configured.` }, { quoted: message });
                }
                account.intervalMinutes = minutes;
                await saveAccount(account);
                return sock.sendMessage(chatId, {
                    text: `✅ @${username} check interval → every *${minutes} min*.`
                }, { quoted: message });
            }

            // ── unknown ───────────────────────────────────────────────────────
            default:
                return sock.sendMessage(chatId, {
                    text: `❓ Unknown action "*${action}*".\nSend *.xpost* for a list of commands.`
                }, { quoted: message });
        }
    }
};