// plugins/inactivetracker.js
// Tracks user activity per group and sends DMs to inactive members.
//
// Architecture:
//   - createStore (lib/pluginStore)  → same pattern as activitytracker.js
//   - onMessage hook                 → passive tracking on every group message
//   - schedules[].every              → daily automated DM check
//   - lib/isAdmin + lib/isOwner      → admin / owner-only guards
//   - Subcommand routing             → same pattern as activity.js

'use strict';

const { createStore }  = require('../lib/pluginStore');
const isAdmin          = require('../lib/isAdmin');
const isOwnerOrSudo    = require('../lib/isOwner');

// ─── STORAGE ──────────────────────────────────────────────────────────────────
// Physical tables created automatically by pluginStore on first access.
//   plugin_inactivetracker_activity  → per-user activity records
//   plugin_inactivetracker_settings  → per-group configuration

const db          = createStore('inactivetracker');
const dbActivity  = db.table('activity');   // key: `groupId__userId`
const dbSettings  = db.table('settings');   // key: groupId

// ─── DEFAULTS ─────────────────────────────────────────────────────────────────

const defaultGroupSettings = {
    enabled:          false,
    inactiveDays:     7,
    dmMessage:        'Hi {user}! 👋\n\nWe noticed you haven\'t been active in *{groupName}* for *{days} days*. We miss you! 💙\n\nFeel free to jump back in anytime!',
    maxReminders:     3,
    reminderInterval: 7,      // days between reminders for the same user
    excludeAdmins:    false
};

// ─── IN-MEMORY CACHES ─────────────────────────────────────────────────────────

const enabledGroupsCache = new Set();        // fast gate in onMessage
const settingsCache      = new Map();        // groupId → { data, ts }
const CACHE_TTL          = 60_000;           // 1 minute

// ─── SETTINGS HELPERS ─────────────────────────────────────────────────────────

async function getGroupSettings(groupId) {
    const now    = Date.now();
    const cached = settingsCache.get(groupId);
    if (cached && now - cached.ts < CACHE_TTL) return cached.data;

    try {
        const saved  = await dbSettings.get(groupId) || {};
        const merged = { ...defaultGroupSettings, ...saved };
        settingsCache.set(groupId, { data: merged, ts: now });
        return merged;
    } catch {
        return { ...defaultGroupSettings };
    }
}

async function saveGroupSettings(groupId, settings) {
    try {
        await dbSettings.set(groupId, settings);
        settingsCache.delete(groupId);   // invalidate so next read is fresh
        // Sync the fast-lookup cache too
        if (settings.enabled) {
            enabledGroupsCache.add(groupId);
        } else {
            enabledGroupsCache.delete(groupId);
        }
        return true;
    } catch (error) {
        console.error('[INACTIVE] saveGroupSettings error:', error.message);
        return false;
    }
}

async function isGroupEnabled(groupId) {
    if (enabledGroupsCache.has(groupId)) return true;
    try {
        const s = await getGroupSettings(groupId);
        if (s?.enabled) {
            enabledGroupsCache.add(groupId);
            return true;
        }
        return false;
    } catch { return false; }
}

// ─── ACTIVITY RECORD HELPERS ──────────────────────────────────────────────────

function activityKey(groupId, userId) {
    return `${groupId}__${userId}`;
}

async function updateUserActivity(groupId, userId) {
    try {
        const key      = activityKey(groupId, userId);
        const existing = await dbActivity.get(key) || {
            groupId,
            userId,
            firstSeen:        new Date().toISOString(),
            remindersSent:    0,
            lastReminderSent: null
        };

        await dbActivity.set(key, {
            ...existing,
            lastActivity: new Date().toISOString(),
            updatedAt:    new Date().toISOString()
        });
    } catch (error) {
        console.error('[INACTIVE] updateUserActivity error:', error.message);
    }
}

async function getUserActivity(groupId, userId) {
    try {
        return await dbActivity.get(activityKey(groupId, userId)) || null;
    } catch { return null; }
}

async function getInactiveUsers(groupId, inactiveDays) {
    try {
        const all    = await dbActivity.getAll();
        const cutoff = Date.now() - inactiveDays * 24 * 60 * 60 * 1000;

        return Object.values(all).filter(r =>
            r.groupId === groupId &&
            r.lastActivity &&
            new Date(r.lastActivity).getTime() < cutoff
        );
    } catch { return []; }
}

async function updateReminderSent(groupId, userId) {
    try {
        const key      = activityKey(groupId, userId);
        const existing = await dbActivity.get(key) || {};

        await dbActivity.set(key, {
            ...existing,
            remindersSent:    (existing.remindersSent || 0) + 1,
            lastReminderSent: new Date().toISOString(),
            updatedAt:        new Date().toISOString()
        });
    } catch (error) {
        console.error('[INACTIVE] updateReminderSent error:', error.message);
    }
}

async function resetUserActivity(groupId, userId) {
    try {
        const key      = activityKey(groupId, userId);
        const existing = await dbActivity.get(key) || {};

        await dbActivity.set(key, {
            ...existing,
            groupId,
            userId,
            lastActivity:     new Date().toISOString(),
            remindersSent:    0,
            lastReminderSent: null,
            updatedAt:        new Date().toISOString()
        });
    } catch (error) {
        console.error('[INACTIVE] resetUserActivity error:', error.message);
    }
}


// ─── NAME RESOLUTION ──────────────────────────────────────────────────────────────
// Tries sock.getName (reads store.contacts set up in index.js),
// then a direct store lookup, then falls back to the bare phone number.

async function getUserName(sock, userId) {
    try {
        // sock.getName is attached in index.js — synchronous for non-group JIDs
        const name = sock.getName(userId);
        const resolved = (name instanceof Promise) ? await name : name;
        if (resolved && resolved.trim()) return resolved.trim();
    } catch {}

    try {
        const store   = require('../lib/lightweight_store');
        const contact = store.contacts?.[userId];
        if (contact?.name)   return contact.name;
        if (contact?.notify) return contact.notify;
    } catch {}

    // Last resort — bare phone number
    return userId.split('@')[0];
}

// ─── MESSAGE FORMATTING ───────────────────────────────────────────────────────

// ─── FRIENDLY DURATION ───────────────────────────────────────────────────────
// Converts a raw day count into natural language.
// 7 → "a week", 14 → "2 weeks", 1 → "1 day", etc.

function friendlyDays(days) {
    if (days === 1)                      return '1 day';
    if (days < 7)                        return `${days} days`;
    if (days === 7)                      return 'a week';
    if (days < 14)                       return `${days} days`;
    if (days === 14)                     return '2 weeks';
    if (days < 21)                       return `${days} days`;
    if (days === 21)                     return '3 weeks';
    if (days < 30)                       return `${days} days`;
    if (days >= 30 && days < 60)         return 'about a month';
    if (days >= 60 && days < 90)         return 'about 2 months';
    return `${Math.floor(days / 30)} months`;
}

function formatDMMessage(template, replacements) {
    let msg = template;
    for (const [key, value] of Object.entries(replacements)) {
        msg = msg.replace(new RegExp(`\\{${key}\\}`, 'gi'), String(value));
    }
    return msg;
}

// ─── CORE INACTIVITY CHECK ────────────────────────────────────────────────────
// Called by the scheduler and by the manual `.inactive check` command.

async function checkInactiveUsers(sock) {
    console.log('[INACTIVE] 🔍 Starting inactivity check...');
    try {
        const allSettings = await dbSettings.getAll();
        const enabledGroups = Object.entries(allSettings).filter(([, s]) => s.enabled);

        if (!enabledGroups.length) {
            console.log('[INACTIVE] No groups with inactivity tracking enabled.');
            return;
        }

        let totalDMsSent = 0;

        for (const [groupId, settings] of enabledGroups) {
            try {
                let groupMetadata;
                try {
                    groupMetadata = await sock.groupMetadata(groupId);
                } catch {
                    console.warn(`[INACTIVE] Could not fetch metadata for ${groupId}, skipping.`);
                    continue;
                }

                const groupName     = groupMetadata.subject;
                const inactiveUsers = await getInactiveUsers(groupId, settings.inactiveDays);
                console.log(`[INACTIVE] ${inactiveUsers.length} inactive user(s) in "${groupName}"`);

                for (const activity of inactiveUsers) {
                    const { userId, remindersSent = 0, lastReminderSent, lastActivity } = activity;

                    // Max reminders guard
                    if (remindersSent >= settings.maxReminders) continue;

                    // Cooldown guard
                    if (lastReminderSent) {
                        const daysSince = Math.floor(
                            (Date.now() - new Date(lastReminderSent).getTime()) / (1000 * 60 * 60 * 24)
                        );
                        if (daysSince < settings.reminderInterval) continue;
                    }

                    // Admin exclusion guard
                    if (settings.excludeAdmins) {
                        const participant = groupMetadata.participants.find(p => p.id === userId);
                        if (participant?.admin === 'admin' || participant?.admin === 'superadmin') continue;
                    }

                    const daysInactive = Math.floor(
                        (Date.now() - new Date(lastActivity).getTime()) / (1000 * 60 * 60 * 24)
                    );
                    const userName = await getUserName(sock, userId);

                    const dmText = formatDMMessage(settings.dmMessage, {
                        user:      userName,
                        groupName,
                        days:      friendlyDays(daysInactive)
                    });

                    try {
                        await sock.sendMessage(userId, { text: dmText });
                        await updateReminderSent(groupId, userId);
                        totalDMsSent++;
                        console.log(`[INACTIVE] ✅ DM sent → ${userName} (${daysInactive}d inactive in "${groupName}")`);
                        // Rate-limit: 2 s between DMs
                        await new Promise(r => setTimeout(r, 2000));
                    } catch (dmErr) {
                        console.error(`[INACTIVE] Failed DM to ${userName}: ${dmErr.message}`);
                    }
                }
            } catch (groupErr) {
                console.error(`[INACTIVE] Error processing group ${groupId}: ${groupErr.message}`);
            }
        }

        console.log(`[INACTIVE] ✅ Check complete — ${totalDMsSent} DM(s) sent.`);
    } catch (error) {
        console.error('[INACTIVE] checkInactiveUsers error:', error.message);
    }
}

// ─── AUTH HELPERS ─────────────────────────────────────────────────────────────

async function userIsAdmin(sock, chatId, senderId) {
    const { isSenderAdmin } = await isAdmin(sock, chatId, senderId);
    const ownerOrSudo       = await isOwnerOrSudo(senderId, sock, chatId);
    return isSenderAdmin || ownerOrSudo;
}

// ─── COMMAND HANDLERS ─────────────────────────────────────────────────────────

async function showMenu(sock, chatId, message, prefix) {
    const text =
        `💤 *INACTIVITY TRACKER*\n\n` +
        `📊 *Admin Commands:*\n` +
        `• *${prefix}inactive on/off* — Toggle tracking\n` +
        `• *${prefix}inactive days [n]* — Set inactive threshold in days\n` +
        `• *${prefix}inactive msg [text]* — Set the DM message\n` +
        `• *${prefix}inactive maxreminders [n]* — Max DMs per user\n` +
        `• *${prefix}inactive interval [days]* — Days between DMs\n` +
        `• *${prefix}inactive excludeadmins on/off* — Skip admins\n` +
        `• *${prefix}inactive stats* — List inactive users\n` +
        `• *${prefix}inactive status* — View current settings\n` +
        `• *${prefix}inactive reset @user* — Reset a user's activity\n` +
        `• *${prefix}inactive check* — Trigger a manual check now\n\n` +
        `💡 *DM Message Variables:*\n` +
        `• {user} — User's number\n` +
        `• {groupName} — Group name\n` +
        `• {days} — Days since last activity\n\n` +
        `📝 *Example:*\n` +
        `${prefix}inactive msg Hi {user}! We miss you in {groupName}! 💙`;

    await sock.sendMessage(chatId, { text }, { quoted: message });
}

// .inactive on | .inactive off
async function cmdToggle(sock, chatId, message, senderId, state) {
    if (!chatId.endsWith('@g.us'))
        return sock.sendMessage(chatId, { text: '❌ This command only works in groups.' }, { quoted: message });
    if (!await userIsAdmin(sock, chatId, senderId))
        return sock.sendMessage(chatId, { text: '🔒 Only group admins can use this command.' }, { quoted: message });

    const settings    = await getGroupSettings(chatId);
    const wantEnabled = (state === 'on');

    // Already in the requested state — tell the user instead of silently no-oping
    if (settings.enabled === wantEnabled) {
        return sock.sendMessage(chatId, {
            text: wantEnabled
                ? '⚠️ Inactivity tracking is *already enabled* in this group.'
                : '⚠️ Inactivity tracking is *already disabled* in this group.'
        }, { quoted: message });
    }

    settings.enabled = wantEnabled;
    await saveGroupSettings(chatId, settings);

    await sock.sendMessage(chatId, {
        text: wantEnabled
            ? '✅ Inactivity tracking has been *enabled*.\n\n💡 Members who go quiet will receive a DM reminder after the configured threshold.'
            : '❌ Inactivity tracking has been *disabled*.\n\n💡 No more DMs will be sent. Existing data is preserved.'
    }, { quoted: message });
}

// .inactive days [n]
async function cmdDays(sock, chatId, message, senderId, args) {
    if (!chatId.endsWith('@g.us'))
        return sock.sendMessage(chatId, { text: '❌ This command only works in groups.' }, { quoted: message });
    if (!await userIsAdmin(sock, chatId, senderId))
        return sock.sendMessage(chatId, { text: '🔒 Only admins can use this command.' }, { quoted: message });

    const days = parseInt(args[0]);
    if (isNaN(days) || days < 1)
        return sock.sendMessage(chatId, { text: '⚠️ Provide a valid number of days (minimum 1).' }, { quoted: message });

    const settings         = await getGroupSettings(chatId);
    settings.inactiveDays  = days;
    await saveGroupSettings(chatId, settings);
    await sock.sendMessage(chatId, { text: `✅ Inactive threshold set to *${days} day(s)*` }, { quoted: message });
}

// .inactive msg [text...]
async function cmdMsg(sock, chatId, message, senderId, args) {
    if (!chatId.endsWith('@g.us'))
        return sock.sendMessage(chatId, { text: '❌ This command only works in groups.' }, { quoted: message });
    if (!await userIsAdmin(sock, chatId, senderId))
        return sock.sendMessage(chatId, { text: '🔒 Only admins can use this command.' }, { quoted: message });

    const newMsg = args.join(' ').trim();
    if (!newMsg)
        return sock.sendMessage(chatId, {
            text: '⚠️ Provide a message text.\n\nExample: Hi {user}! We miss you in {groupName}!'
        }, { quoted: message });

    const settings       = await getGroupSettings(chatId);
    settings.dmMessage   = newMsg;
    await saveGroupSettings(chatId, settings);
    await sock.sendMessage(chatId, {
        text: `✅ DM message updated!\n\n_Preview:_\n${newMsg}`
    }, { quoted: message });
}

// .inactive maxreminders [n]
async function cmdMaxReminders(sock, chatId, message, senderId, args) {
    if (!chatId.endsWith('@g.us'))
        return sock.sendMessage(chatId, { text: '❌ This command only works in groups.' }, { quoted: message });
    if (!await userIsAdmin(sock, chatId, senderId))
        return sock.sendMessage(chatId, { text: '🔒 Only admins can use this command.' }, { quoted: message });

    const max = parseInt(args[0]);
    if (isNaN(max) || max < 1)
        return sock.sendMessage(chatId, { text: '⚠️ Provide a valid number (minimum 1).' }, { quoted: message });

    const settings         = await getGroupSettings(chatId);
    settings.maxReminders  = max;
    await saveGroupSettings(chatId, settings);
    await sock.sendMessage(chatId, { text: `✅ Max reminders set to *${max}* per user` }, { quoted: message });
}

// .inactive interval [days]
async function cmdInterval(sock, chatId, message, senderId, args) {
    if (!chatId.endsWith('@g.us'))
        return sock.sendMessage(chatId, { text: '❌ This command only works in groups.' }, { quoted: message });
    if (!await userIsAdmin(sock, chatId, senderId))
        return sock.sendMessage(chatId, { text: '🔒 Only admins can use this command.' }, { quoted: message });

    const days = parseInt(args[0]);
    if (isNaN(days) || days < 1)
        return sock.sendMessage(chatId, { text: '⚠️ Provide a valid number of days (minimum 1).' }, { quoted: message });

    const settings             = await getGroupSettings(chatId);
    settings.reminderInterval  = days;
    await saveGroupSettings(chatId, settings);
    await sock.sendMessage(chatId, { text: `✅ Reminder interval set to *${days} day(s)*` }, { quoted: message });
}

// .inactive excludeadmins on|off
async function cmdExcludeAdmins(sock, chatId, message, senderId, state) {
    if (!chatId.endsWith('@g.us'))
        return sock.sendMessage(chatId, { text: '❌ This command only works in groups.' }, { quoted: message });
    if (!await userIsAdmin(sock, chatId, senderId))
        return sock.sendMessage(chatId, { text: '🔒 Only admins can use this command.' }, { quoted: message });

    const settings           = await getGroupSettings(chatId);
    settings.excludeAdmins   = (state === 'on');
    await saveGroupSettings(chatId, settings);
    await sock.sendMessage(chatId, {
        text: `✅ Exclude admins from tracking: ${settings.excludeAdmins ? '✅ Yes' : '❌ No'}`
    }, { quoted: message });
}

// .inactive stats
async function cmdStats(sock, chatId, message, senderId) {
    if (!chatId.endsWith('@g.us'))
        return sock.sendMessage(chatId, { text: '❌ This command only works in groups.' }, { quoted: message });
    if (!await userIsAdmin(sock, chatId, senderId))
        return sock.sendMessage(chatId, { text: '🔒 Only admins can use this command.' }, { quoted: message });

    const settings      = await getGroupSettings(chatId);

    if (!settings.enabled) {
        return sock.sendMessage(chatId, {
            text: '❌ Inactivity tracking is not enabled.\n\nEnable it with: .inactive on'
        }, { quoted: message });
    }

    const inactiveUsers = await getInactiveUsers(chatId, settings.inactiveDays);

    if (!inactiveUsers.length) {
        return sock.sendMessage(chatId, {
            text: `✅ No inactive users found!\n\nAll tracked members have been active within the last *${settings.inactiveDays} day(s)*.`
        }, { quoted: message });
    }

    const display  = inactiveUsers.slice(0, 20);
    const mentions = display.map(a => a.userId);

    let text = `💤 *INACTIVE USERS REPORT*\n`;
    text += `📊 Found *${inactiveUsers.length}* inactive user(s):\n\n`;

    display.forEach((activity, i) => {
        const phone        = activity.userId.split('@')[0];
        const daysInactive = Math.floor(
            (Date.now() - new Date(activity.lastActivity).getTime()) / (1000 * 60 * 60 * 24)
        );
        const reminders = activity.remindersSent || 0;

        text += `${i + 1}. @${phone}\n`;
        text += `   📅 Last active: *${daysInactive} day(s) ago*\n`;
        text += `   📧 Reminders sent: ${reminders}/${settings.maxReminders}\n\n`;
    });

    if (inactiveUsers.length > 20) {
        text += `_...and ${inactiveUsers.length - 20} more_`;
    }

    await sock.sendMessage(chatId, { text, mentions }, { quoted: message });
}

// .inactive status
async function cmdStatus(sock, chatId, message, senderId) {
    if (!chatId.endsWith('@g.us'))
        return sock.sendMessage(chatId, { text: '❌ This command only works in groups.' }, { quoted: message });
    if (!await userIsAdmin(sock, chatId, senderId))
        return sock.sendMessage(chatId, { text: '🔒 Only admins can use this command.' }, { quoted: message });

    const settings = await getGroupSettings(chatId);

    let groupName = chatId;
    try {
        const meta = await sock.groupMetadata(chatId);
        groupName  = meta.subject;
    } catch {}

    const text =
        `📊 *INACTIVITY TRACKER STATUS*\n\n` +
        `🏷️ Group: *${groupName}*\n\n` +
        `💤 Tracking: ${settings.enabled ? '✅ Enabled' : '❌ Disabled'}\n` +
        `📅 Inactive threshold: *${settings.inactiveDays} day(s)*\n` +
        `📧 Max reminders: *${settings.maxReminders}* per user\n` +
        `⏰ Reminder interval: *${settings.reminderInterval} day(s)*\n` +
        `👑 Exclude admins: ${settings.excludeAdmins ? '✅ Yes' : '❌ No'}\n\n` +
        `💬 *DM Message:*\n${settings.dmMessage}`;

    await sock.sendMessage(chatId, { text }, { quoted: message });
}

// .inactive reset @user
async function cmdReset(sock, chatId, message, senderId) {
    if (!chatId.endsWith('@g.us'))
        return sock.sendMessage(chatId, { text: '❌ This command only works in groups.' }, { quoted: message });
    if (!await userIsAdmin(sock, chatId, senderId))
        return sock.sendMessage(chatId, { text: '🔒 Only admins can use this command.' }, { quoted: message });

    const mentionedJid = message.message?.extendedTextMessage?.contextInfo?.mentionedJid?.[0];
    if (!mentionedJid) {
        return sock.sendMessage(chatId, {
            text: '⚠️ Please mention a user to reset.\n\nExample: .inactive reset @user'
        }, { quoted: message });
    }

    await resetUserActivity(chatId, mentionedJid);
    const phone = mentionedJid.split('@')[0];

    await sock.sendMessage(chatId, {
        text:     `✅ Activity reset for @${phone}`,
        mentions: [mentionedJid]
    }, { quoted: message });
}

// .inactive check
async function cmdCheck(sock, chatId, message, senderId) {
    if (!chatId.endsWith('@g.us'))
        return sock.sendMessage(chatId, { text: '❌ This command only works in groups.' }, { quoted: message });
    if (!await userIsAdmin(sock, chatId, senderId))
        return sock.sendMessage(chatId, { text: '🔒 Only admins can use this command.' }, { quoted: message });

    await sock.sendMessage(chatId, { text: '🔍 Running manual inactivity check...' }, { quoted: message });
    await checkInactiveUsers(sock);
    await sock.sendMessage(chatId, { text: '✅ Manual check complete!' }, { quoted: message });
}

// ─── PLUGIN EXPORT ────────────────────────────────────────────────────────────

module.exports = {
    command:     'inactive',
    aliases:     ['inact', 'inactivity'],
    category:    'group',
    description: 'Tracks user activity and sends DMs to inactive group members',
    groupOnly:   false,   // group guard handled per-command to give proper error messages

    // ── Passive tracking: fires on every message via pluginLoader.dispatchMessage ──
    async onMessage(sock, message, context) {
        try {
            const { chatId, senderId, isGroup } = context;

            // Only group messages from other users matter
            if (!isGroup)                return;
            if (message.key.fromMe)      return;
            if (!senderId)               return;

            // Fast-path gate — avoids a DB read for every message in disabled groups
            if (!await isGroupEnabled(chatId)) return;

            await updateUserActivity(chatId, senderId);
        } catch (error) {
            console.error('[INACTIVE] onMessage error:', error.message);
        }
    },

    // ── Scheduled DM check — runs every 24 hours via pluginLoader ──
    schedules: [
        {
            every: 24 * 60 * 60 * 1000,   // 24 hours in ms
            async handler(sock) {
                console.log('[INACTIVE] ⏰ Running scheduled inactivity check...');
                await checkInactiveUsers(sock);
            }
        }
    ],

    // ── Command handler: routes subcommands ──
    async handler(sock, message, args, context) {
        const { chatId, senderId } = context;
        const { prefixes }         = require('../settings');
        const prefix               = prefixes[0];

        // No args → show menu
        if (!args.length) {
            return showMenu(sock, chatId, message, prefix);
        }

        const sub     = args[0].toLowerCase();
        const subArgs = args.slice(1);

        switch (sub) {
            // Toggle on / off
            case 'on':
            case 'off':
                await cmdToggle(sock, chatId, message, senderId, sub);
                break;

            // Inactive threshold
            case 'days':
                await cmdDays(sock, chatId, message, senderId, subArgs);
                break;

            // DM message
            case 'msg':
            case 'message':
                await cmdMsg(sock, chatId, message, senderId, subArgs);
                break;

            // Max reminders
            case 'maxreminders':
            case 'max':
                await cmdMaxReminders(sock, chatId, message, senderId, subArgs);
                break;

            // Reminder interval
            case 'interval':
                await cmdInterval(sock, chatId, message, senderId, subArgs);
                break;

            // Exclude admins
            case 'excludeadmins': {
                const state = subArgs[0]?.toLowerCase();
                if (!['on', 'off'].includes(state)) {
                    return sock.sendMessage(chatId,
                        { text: '⚠️ Usage: .inactive excludeadmins on/off' },
                        { quoted: message }
                    );
                }
                await cmdExcludeAdmins(sock, chatId, message, senderId, state);
                break;
            }

            // Inactive users list
            case 'stats':
                await cmdStats(sock, chatId, message, senderId);
                break;

            // Current config
            case 'status':
                await cmdStatus(sock, chatId, message, senderId);
                break;

            // Reset a user's record
            case 'reset':
                await cmdReset(sock, chatId, message, senderId);
                break;

            // Manual DM trigger
            case 'check':
                await cmdCheck(sock, chatId, message, senderId);
                break;

            // Help
            case 'help':
                await showMenu(sock, chatId, message, prefix);
                break;

            default:
                await sock.sendMessage(chatId, {
                    text: `❓ Unknown subcommand: *${sub}*\n\nUse *${prefix}inactive* to see all available commands.`
                }, { quoted: message });
        }
    }
};