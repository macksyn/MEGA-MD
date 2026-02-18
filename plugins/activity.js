// plugins/activity.js
// Command interface for activity tracking system

const moment = require('moment-timezone');
const isAdmin = require('../lib/isAdmin');
const isOwnerOrSudo = require('../lib/isOwner');

// Import functions from activitytracker.js
const {
    isGroupEnabled,
    enableGroupTracking,
    disableGroupTracking,
    getEnabledGroups,
    getSettings,
    saveSettings,
    getUserActivity,
    getUserRank,
    getMonthlyLeaderboard,
    getInactiveMembers
} = require('./activitytracker');

moment.tz.setDefault('Africa/Lagos');

// ===== HELPER FUNCTIONS =====
function formatDuration(ms) {
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);

    if (days > 0) return `${days}d ${hours % 24}h`;
    if (hours > 0) return `${hours}h ${minutes % 60}m`;
    if (minutes > 0) return `${minutes}m`;
    return `${seconds}s`;
}

// ===== COMMAND HANDLERS =====
async function showActivityMenu(sock, chatId, message, prefix) {
    const menuText = 
        `📊 *ACTIVITY TRACKER* 📊\n\n` +
        `👤 *User Commands:*\n` +
        `• *${prefix}activity stats* - View your activity stats\n` +
        `• *${prefix}activity rank* - Check your current rank\n` +
        `• *${prefix}activity leaderboard* - View top 10 members\n` +
        `• *${prefix}activity inactives* - View least active members\n` +
        `• *${prefix}activity points* - View point values\n\n` +
        `👑 *Admin Commands:*\n` +
        `• *${prefix}activity enable* - Enable tracking in this group\n` +
        `• *${prefix}activity disable* - Disable tracking in this group\n` +
        `• *${prefix}activity status* - Check if tracking is enabled\n` +
        `• *${prefix}activity settings* - Configure point values\n` +
        `• *${prefix}activity groups* - List all enabled groups (owner only)\n\n` +
        `🤖 *Auto-Tracking:*\n` +
        `All activities tracked automatically in enabled groups!\n\n` +
        `💡 *Usage:* ${prefix}activity [command]`;

    await sock.sendMessage(chatId, { text: menuText }, { quoted: message });
}

async function handleStats(sock, message, context) {
    const { chatId, channelInfo } = context;
    let targetUserId = message.key.participant || message.key.remoteJid;

    if (!chatId.endsWith('@g.us')) {
        return sock.sendMessage(chatId, { 
            text: '❌ This command only works in groups.',
            //...channelInfo 
        }, { quoted: message });
    }

    const enabled = await isGroupEnabled(chatId);
    if (!enabled) {
        return sock.sendMessage(chatId, { 
            text: '❌ Activity tracking is not enabled in this group.\n\n💡 Admins can enable it with: .activity enable',
            //...channelInfo 
        }, { quoted: message });
    }

    try {
        // Check for mentioned user
        if (message.message?.extendedTextMessage?.contextInfo?.mentionedJid?.length > 0) {
            targetUserId = message.message.extendedTextMessage.contextInfo.mentionedJid[0];
        }
        // Check for quoted message
        else if (message.message?.extendedTextMessage?.contextInfo?.quotedMessage) {
            targetUserId = message.message.extendedTextMessage.contextInfo.participant || message.key.participant;
        }

        const activity = await getUserActivity(targetUserId, chatId);
        
        if (!activity) {
            const phone = targetUserId.split('@')[0];
            return sock.sendMessage(chatId, { 
                text: `❌ No activity data found for @${phone}. They haven't participated yet.`,
                mentions: [targetUserId],
                //...channelInfo 
            }, { quoted: message });
        }

        const currentMonth = moment.tz('Africa/Lagos').format('MMMM YYYY');
        const stats = activity.stats; // This is now activity.stats (the types object)
        const phone = targetUserId.split('@')[0];
        const isSelf = targetUserId === (message.key.participant || message.key.remoteJid);

        // Use totalMessages from built-in counter
        const totalMessages = activity.totalMessages || 0;

        let lastSeenText = 'N/A';
        try {
            if (activity.lastSeen) {
                const lastSeenDate = new Date(activity.lastSeen);
                const diffMs = Date.now() - lastSeenDate.getTime();
                const TEN_MINUTES = 10 * 60 * 1000;
                if (diffMs <= TEN_MINUTES) {
                    lastSeenText = '🟢 Online';
                } else {
                    lastSeenText = `${formatDuration(diffMs)} ago`;
                }
            }
        } catch (e) {
            lastSeenText = 'N/A';
        }

        const header = isSelf ? `📊 *YOUR ACTIVITY STATS* 📊` : `📊 *ACTIVITY STATS - @${phone}* 📊`;
        
        const statsMessage = `${header}\n\n` +
                            `📅 Month: ${currentMonth}\n` +
                            `⭐ Total Points: ${activity.points || 0}\n` +
                            `📝 Total Messages: ${totalMessages}\n\n` +
                            `   💬 Text: ${stats.messages || 0}\n` +
                            `   🎨 Stickers: ${stats.stickers || 0}\n` +
                            `   🎥 Videos: ${stats.videos || 0}\n` +
                            `   🎤 Voice Notes: ${stats.voiceNotes || 0}\n` +
                            `   📊 Polls: ${stats.polls || 0}\n` +
                            `   📸 Photos: ${stats.photos || 0}\n` +
                            `   ✅ Attendance: ${stats.attendance || 0}\n\n` +
                            `👁️ Last Seen: ${lastSeenText}\n` +
                            `📅 First Seen: ${moment(activity.firstSeen).tz('Africa/Lagos').format('DD/MM/YYYY')}`;

        await sock.sendMessage(chatId, { 
            text: statsMessage, 
            mentions: [targetUserId],
            //...channelInfo 
        }, { quoted: message });
    } catch (error) {
        console.error('Stats error:', error);
        await sock.sendMessage(chatId, { 
            text: '❌ Error loading stats. Please try again.',
            //...channelInfo 
        }, { quoted: message });
    }
}

async function handleRank(sock, message, context) {
    const { chatId, senderId, channelInfo } = context;

    if (!chatId.endsWith('@g.us')) {
        return sock.sendMessage(chatId, { 
            text: '❌ This command only works in groups.',
            //...channelInfo 
        }, { quoted: message });
    }

    const enabled = await isGroupEnabled(chatId);
    if (!enabled) {
        return sock.sendMessage(chatId, { 
            text: '❌ Activity tracking is not enabled in this group.\n\n💡 Admins can enable it with: .activity enable',
            //...channelInfo 
        }, { quoted: message });
    }

    try {
        let allGroupMembers = [];
        try {
            const groupMetadata = await sock.groupMetadata(chatId);
            allGroupMembers = groupMetadata.participants.map(p => p.id);
        } catch (error) {
            console.error('Error fetching group metadata:', error);
            return sock.sendMessage(chatId, { 
                text: '❌ Unable to fetch group members. Please try again.',
                //...channelInfo 
            }, { quoted: message });
        }

        const rankData = await getUserRank(senderId, chatId);
        
        if (!rankData || !rankData.activity) {
            return sock.sendMessage(chatId, { 
                text: '❌ No ranking data available yet.',
                //...channelInfo 
            }, { quoted: message });
        }

        const currentMonth = moment.tz('Africa/Lagos').format('MMMM YYYY');
        const totalGroupMembers = allGroupMembers.length;

        let rankMessage = `🏆 *YOUR RANK* 🏆\n\n` +
                         `📅 Month: ${currentMonth}\n` +
                         `🥇 Rank: #${rankData.rank} out of ${totalGroupMembers}\n` +
                         `⭐ Points: ${rankData.activity.points || 0}\n\n`;

        if (rankData.rank === 1) {
            rankMessage += `🎉 *You're #1! Keep it up!*`;
        } else if (rankData.rank <= 3) {
            rankMessage += `🔥 *You're in top 3! Great job!*`;
        } else if (rankData.rank <= 10) {
            rankMessage += `💪 *You're in top 10! Keep climbing!*`;
        } else {
            rankMessage += `📈 *Keep participating to climb the ranks!*`;
        }

        await sock.sendMessage(chatId, { 
            text: rankMessage,
            //...channelInfo 
        }, { quoted: message });
    } catch (error) {
        console.error('Rank error:', error);
        await sock.sendMessage(chatId, { 
            text: '❌ Error loading rank. Please try again.',
            //...channelInfo 
        }, { quoted: message });
    }
}

async function handleLeaderboard(sock, message, context) {
    const { chatId, channelInfo } = context;

    if (!chatId.endsWith('@g.us')) {
        return sock.sendMessage(chatId, { 
            text: '❌ This command only works in groups.',
            //...channelInfo 
        }, { quoted: message });
    }

    const enabled = await isGroupEnabled(chatId);
    if (!enabled) {
        return sock.sendMessage(chatId, { 
            text: '❌ Activity tracking is not enabled in this group.\n\n💡 Admins can enable it with: .activity enable',
            //...channelInfo 
        }, { quoted: message });
    }

    try {
        const leaderboard = await getMonthlyLeaderboard(chatId);
        
        if (!leaderboard || leaderboard.length === 0) {
            return sock.sendMessage(chatId, { 
                text: '❌ No leaderboard data available yet.',
                //...channelInfo 
            }, { quoted: message });
        }

        const currentMonth = moment.tz('Africa/Lagos').format('MMMM YYYY');

        let leaderboardMessage = `🏆 *MONTHLY LEADERBOARD* 🏆\n\n` +
                                `📅 Month: ${currentMonth}\n\n`;

        const mentions = leaderboard.map(u => u.userId);

        leaderboard.forEach((user, index) => {
            const medal = index === 0 ? '🥇' : index === 1 ? '🥈' : index === 2 ? '🥉' : `${index + 1}.`;
            const phone = user.userId.split('@')[0];
            
            // Use totalMessages from built-in counter and stats.attendance
            const totalMessages = user.totalMessages || 0;
            const attendance = user.stats.attendance || 0;
            
            leaderboardMessage += `${medal} @${phone}\n` +
                                 `   ⭐ ${user.points} pts | 📝 ${totalMessages} total | ✅ ${attendance} att\n\n`;
        });

        leaderboardMessage += `💡 *Use .activity stats to see your detailed stats*`;

        await sock.sendMessage(chatId, { 
            text: leaderboardMessage, 
            mentions,
            //...channelInfo 
        }, { quoted: message });
    } catch (error) {
        console.error('Leaderboard error:', error);
        await sock.sendMessage(chatId, { 
            text: '❌ Error loading leaderboard. Please try again.',
            //...channelInfo 
        }, { quoted: message });
    }
}

async function handleInactives(sock, message, args, context) {
    const { chatId, channelInfo } = context;

    if (!chatId.endsWith('@g.us')) {
        return sock.sendMessage(chatId, { 
            text: '❌ This command only works in groups.',
            //...channelInfo 
        }, { quoted: message });
    }

    const enabled = await isGroupEnabled(chatId);
    if (!enabled) {
        return sock.sendMessage(chatId, { 
            text: '❌ Activity tracking is not enabled in this group.\n\n💡 Admins can enable it with: .activity enable',
            //...channelInfo 
        }, { quoted: message });
    }

    try {
        let limit = 10;
        if (args && args[0]) {
            const parsedLimit = parseInt(args[0]);
            if (!isNaN(parsedLimit) && parsedLimit > 0) {
                limit = Math.min(parsedLimit, 50);
            }
        }

        let allGroupMembers = [];
        try {
            const groupMetadata = await sock.groupMetadata(chatId);
            allGroupMembers = groupMetadata.participants.map(p => p.id);
        } catch (error) {
            console.error('Error fetching group metadata:', error);
            return sock.sendMessage(chatId, { 
                text: '❌ Unable to fetch group members. Please try again.',
                //...channelInfo 
            }, { quoted: message });
        }

        const allActivityMembers = await getInactiveMembers(chatId, 1000);
        const ONE_WEEK = 7 * 24 * 60 * 60 * 1000;

        const inactivityData = [];

        allActivityMembers.forEach(member => {
            if (!member.lastSeen) return;
            
            const lastSeenDate = new Date(member.lastSeen);
            const daysInactive = (Date.now() - lastSeenDate.getTime()) / (24 * 60 * 60 * 1000);

            if (daysInactive >= 7) {
                inactivityData.push({
                    ...member,
                    daysInactive,
                    isSilent: false
                });
            }
        });

        const activeMemberIds = new Set(allActivityMembers.map(m => m.userId));
        const silentMembers = allGroupMembers.filter(memberId => !activeMemberIds.has(memberId));
        
        silentMembers.forEach(userId => {
            inactivityData.push({
                userId,
                points: 0,
                stats: { messages: 0, stickers: 0, videos: 0, voiceNotes: 0, polls: 0, photos: 0, attendance: 0 },
                daysInactive: Infinity,
                isSilent: true,
                lastSeen: null
            });
        });

        inactivityData.sort((a, b) => b.daysInactive - a.daysInactive);

        const inactives = inactivityData.slice(0, limit);

        if (inactives.length === 0) {
            return sock.sendMessage(chatId, { 
                text: '✅ Great! All members have been active.',
                //...channelInfo 
            }, { quoted: message });
        }

        const currentMonth = moment.tz('Africa/Lagos').format('MMMM YYYY');

        let inactivesMessage = `😴 *INACTIVE MEMBERS* 😴\n\n` +
                              `📅 Month: ${currentMonth}\n` +
                              `📊 Showing ${inactives.length} members\n\n`;

        const mentions = inactives.map(u => u.userId);

        inactives.forEach((user, index) => {
            let badge, durationText;
            
            if (user.isSilent) {
                badge = '⚫';
                durationText = '(Never chatted)';
            } else {
                const days = Math.floor(user.daysInactive);
                if (days >= 30) {
                    badge = '⚫';
                    durationText = `(${days} days ago)`;
                } else if (days >= 21) {
                    badge = '🔴';
                    durationText = `(${days} days ago)`;
                } else if (days >= 14) {
                    badge = '🟠';
                    durationText = `(${days} days ago)`;
                } else {
                    badge = '🟡';
                    durationText = `(${days} days ago)`;
                }
            }
            
            const phone = user.userId.split('@')[0];
            
            // Use totalMessages from built-in counter
            const totalMessages = user.totalMessages || 0;
            
            inactivesMessage += `${badge} @${phone} ${durationText}\n` +
                               `   📝 ${totalMessages} total | ⭐ ${user.points} pts\n\n`;
        });

        inactivesMessage += `\n📌 *Legend:* 🟡 7-14 days | 🟠 2-3 weeks | 🔴 3-4 weeks | ⚫ 1+ month or never chatted\n` +
                           `💡 *Use .activity stats to see full details*`;

        await sock.sendMessage(chatId, { 
            text: inactivesMessage, 
            mentions,
            //...channelInfo 
        }, { quoted: message });
    } catch (error) {
        console.error('Inactives error:', error);
        await sock.sendMessage(chatId, { 
            text: '❌ Error loading inactives. Please try again.',
            //...channelInfo 
        }, { quoted: message });
    }
}

async function handlePoints(sock, message, context) {
    const { chatId, channelInfo } = context;

    const settings = await getSettings();

    const pointsMessage = `⭐ *POINT VALUES* ⭐\n\n` +
                         `📝 Message: ${settings.pointsPerMessage} pt\n` +
                         `🎨 Sticker: ${settings.pointsPerSticker} pts\n` +
                         `🎥 Video: ${settings.pointsPerVideo} pts\n` +
                         `🎤 Voice Note: ${settings.pointsPerVoiceNote} pts\n` +
                         `📊 Poll: ${settings.pointsPerPoll} pts\n` +
                         `📸 Photo: ${settings.pointsPerPhoto} pts\n` +
                         `✅ Attendance: ${settings.pointsPerAttendance} pts\n\n` +
                         `💡 *Admins can modify these values with .activity settings*`;

    await sock.sendMessage(chatId, { 
        text: pointsMessage,
        //...channelInfo 
    }, { quoted: message });
}

async function handleEnable(sock, message, context) {
    const { chatId, senderId, isBotAdmin, channelInfo } = context;

    if (!chatId.endsWith('@g.us')) {
        return sock.sendMessage(chatId, { 
            text: '❌ This command only works in groups.',
            //...channelInfo 
        }, { quoted: message });
    }

    const { isSenderAdmin } = await isAdmin(sock, chatId, senderId);
    const senderIsOwnerOrSudo = await isOwnerOrSudo(senderId, sock, chatId);

    if (!isSenderAdmin && !senderIsOwnerOrSudo) {
        return sock.sendMessage(chatId, { 
            text: '🚫 Only admins can use this command.',
            //...channelInfo 
        }, { quoted: message });
    }

    try {
        const enabled = await isGroupEnabled(chatId);
        if (enabled) {
            return sock.sendMessage(chatId, { 
                text: '✅ Activity tracking is already enabled in this group.',
                //...channelInfo 
            }, { quoted: message });
        }

        let groupName = 'Unknown Group';
        try {
            const groupMetadata = await sock.groupMetadata(chatId);
            groupName = groupMetadata.subject;
        } catch (error) {
            console.error('Error getting group name:', error);
        }

        const result = await enableGroupTracking(chatId, groupName);

        if (result.success) {
            await sock.sendMessage(chatId, { 
                text: `✅ *Activity tracking enabled!*\n\n` +
                      `📊 From now on, all group activities will be tracked:\n` +
                      `• Messages, stickers, photos\n` +
                      `• Videos, voice notes, polls\n` +
                      `• Attendance records\n\n` +
                      `💡 Use *.activity stats* to view your progress!`,
                ...channelInfo 
            }, { quoted: message });
        } else {
            await sock.sendMessage(chatId, { 
                text: `❌ Failed to enable tracking: ${result.error}`,
                //...channelInfo 
            }, { quoted: message });
        }
    } catch (error) {
        console.error('Enable error:', error);
        await sock.sendMessage(chatId, { 
            text: '❌ An error occurred while enabling tracking.',
            //...channelInfo 
        }, { quoted: message });
    }
}

async function handleDisable(sock, message, context) {
    const { chatId, senderId, channelInfo } = context;

    if (!chatId.endsWith('@g.us')) {
        return sock.sendMessage(chatId, { 
            text: '❌ This command only works in groups.',
            //...channelInfo 
        }, { quoted: message });
    }

    const { isSenderAdmin } = await isAdmin(sock, chatId, senderId);
    const senderIsOwnerOrSudo = await isOwnerOrSudo(senderId, sock, chatId);

    if (!isSenderAdmin && !senderIsOwnerOrSudo) {
        return sock.sendMessage(chatId, { 
            text: '🚫 Only admins can use this command.',
            //...channelInfo 
        }, { quoted: message });
    }

    try {
        const enabled = await isGroupEnabled(chatId);
        if (!enabled) {
            return sock.sendMessage(chatId, { 
                text: '❌ Activity tracking is already disabled in this group.',
                //...channelInfo 
            }, { quoted: message });
        }

        const result = await disableGroupTracking(chatId);

        if (result.success) {
            await sock.sendMessage(chatId, { 
                text: `❌ *Activity tracking disabled.*\n\n` +
                      `📊 Tracking has stopped. Existing data is preserved.\n\n` +
                      `💡 Re-enable anytime with *.activity enable*`,
                //...channelInfo 
            }, { quoted: message });
        } else {
            await sock.sendMessage(chatId, { 
                text: `❌ Failed to disable tracking: ${result.error}`,
                //...channelInfo 
            }, { quoted: message });
        }
    } catch (error) {
        console.error('Disable error:', error);
        await sock.sendMessage(chatId, { 
            text: '❌ An error occurred while disabling tracking.',
            //...channelInfo 
        }, { quoted: message });
    }
}

async function handleStatus(sock, message, context) {
    const { chatId, channelInfo } = context;

    if (!chatId.endsWith('@g.us')) {
        return sock.sendMessage(chatId, { 
            text: '❌ This command only works in groups.',
            //...channelInfo 
        }, { quoted: message });
    }

    try {
        const enabled = await isGroupEnabled(chatId);

        if (enabled) {
            await sock.sendMessage(chatId, { 
                text: `✅ *Activity tracking is ENABLED*\n\n` +
                      `📊 All activities are being tracked.\n\n` +
                      `💡 Use *.activity stats* to view your progress!`,
                //...channelInfo 
            }, { quoted: message });
        } else {
            await sock.sendMessage(chatId, { 
                text: `❌ *Activity tracking is DISABLED*\n\n` +
                      `📊 No activities are being tracked.\n\n` +
                      `💡 Admins can enable with *.activity enable*`,
                //...channelInfo 
            }, { quoted: message });
        }
    } catch (error) {
        console.error('Status error:', error);
        await sock.sendMessage(chatId, { 
            text: '❌ An error occurred while checking status.',
            //...channelInfo 
        }, { quoted: message });
    }
}

async function handleGroups(sock, message, context) {
    const { chatId, senderId, channelInfo } = context;

    const { isOwnerOnly } = require('../lib/isOwner');
    
    if (!isOwnerOnly(senderId)) {
        return sock.sendMessage(chatId, { 
            text: '🚫 This command is for the bot owner only.',
            //...channelInfo 
        }, { quoted: message });
    }

    try {
        const enabledGroups = await getEnabledGroups();

        if (!enabledGroups || enabledGroups.length === 0) {
            return sock.sendMessage(chatId, { 
                text: '❌ No groups have activity tracking enabled yet.',
                //...channelInfo 
            }, { quoted: message });
        }

        let groupList = `📊 *ACTIVITY TRACKING ENABLED GROUPS* 📊\n\n`;
        groupList += `Total: ${enabledGroups.length} groups\n\n`;

        enabledGroups.forEach((group, index) => {
            groupList += `${index + 1}. ${group.groupName || 'Unknown'}\n`;
            groupList += `   ID: ${group.groupId}\n`;
            groupList += `   Enabled: ${moment(group.enabledAt).tz('Africa/Lagos').format('DD/MM/YYYY')}\n\n`;
        });

        await sock.sendMessage(chatId, { 
            text: groupList,
            //...channelInfo 
        }, { quoted: message });
    } catch (error) {
        console.error('Groups error:', error);
        await sock.sendMessage(chatId, { 
            text: '❌ An error occurred while fetching groups.',
            //...channelInfo 
        }, { quoted: message });
    }
}

async function handleSettings(sock, message, args, context) {
    const { chatId, senderId, channelInfo } = context;

    const { isSenderAdmin } = await isAdmin(sock, chatId, senderId);
    const senderIsOwnerOrSudo = await isOwnerOrSudo(senderId, sock, chatId);

    if (!isSenderAdmin && !senderIsOwnerOrSudo) {
        return sock.sendMessage(chatId, { 
            text: '🚫 Only admins can use this command.',
            //...channelInfo 
        }, { quoted: message });
    }

    const settings = await getSettings();

    if (args.length === 0) {
        const settingsMessage = `⚙️ *ACTIVITY SETTINGS* ⚙️\n\n` +
                               `📝 Message: ${settings.pointsPerMessage} pt\n` +
                               `🎨 Sticker: ${settings.pointsPerSticker} pts\n` +
                               `🎥 Video: ${settings.pointsPerVideo} pts\n` +
                               `🎤 Voice Note: ${settings.pointsPerVoiceNote} pts\n` +
                               `📊 Poll: ${settings.pointsPerPoll} pts\n` +
                               `📸 Photo: ${settings.pointsPerPhoto} pts\n` +
                               `✅ Attendance: ${settings.pointsPerAttendance} pts\n\n` +
                               `🔧 *Change Settings:*\n` +
                               `• *message [points]*\n• *sticker [points]*\n` +
                               `• *video [points]*\n• *voicenote [points]*\n` +
                               `• *poll [points]*\n• *photo [points]*\n• *attendance [points]*`;
        return sock.sendMessage(chatId, { 
            text: settingsMessage,
            //...channelInfo 
        }, { quoted: message });
    }

    const setting = args[0].toLowerCase();
    const value = parseInt(args[1]);

    if (isNaN(value) || value < 0) {
        return sock.sendMessage(chatId, { 
            text: '⚠️ Please specify a valid point value (0 or higher).',
            //...channelInfo 
        }, { quoted: message });
    }

    const settingMap = {
        'message': 'pointsPerMessage',
        'sticker': 'pointsPerSticker',
        'video': 'pointsPerVideo',
        'voicenote': 'pointsPerVoiceNote',
        'poll': 'pointsPerPoll',
        'photo': 'pointsPerPhoto',
        'attendance': 'pointsPerAttendance'
    };

    if (settingMap[setting]) {
        settings[settingMap[setting]] = value;
        await saveSettings(settings);
        await sock.sendMessage(chatId, { 
            text: `✅ ${setting} points set to ${value}`,
            //...channelInfo 
        }, { quoted: message });
    } else {
        await sock.sendMessage(chatId, { 
            text: `❓ Unknown setting: *${setting}*`,
            //...channelInfo 
        }, { quoted: message });
    }
}

// ===== PLUGIN EXPORT =====
module.exports = {
    command: 'activity',
    aliases: ['act', 'leaderboard', 'rank'],
    category: 'utility',
    description: 'Activity tracking system for groups',
    groupOnly: true,
    
    async handler(sock, message, args, context) {
        const { chatId } = context;
        const settings = require('../settings');
        
        if (args.length === 0) {
            return showActivityMenu(sock, chatId, message, settings.prefixes[0]);
        }

        const subCommand = args[0].toLowerCase();
        const subArgs = args.slice(1);

        switch (subCommand) {
            case 'stats':
                await handleStats(sock, message, context);
                break;
            case 'rank':
                await handleRank(sock, message, context);
                break;
            case 'leaderboard':
            case 'top':
                await handleLeaderboard(sock, message, context);
                break;
            case 'inactives':
            case 'inactive':
                await handleInactives(sock, message, subArgs, context);
                break;
            case 'points':
                await handlePoints(sock, message, context);
                break;
            case 'enable':
                await handleEnable(sock, message, context);
                break;
            case 'disable':
                await handleDisable(sock, message, context);
                break;
            case 'status':
                await handleStatus(sock, message, context);
                break;
            case 'groups':
                await handleGroups(sock, message, context);
                break;
            case 'settings':
                await handleSettings(sock, message, subArgs, context);
                break;
            case 'help':
                await showActivityMenu(sock, chatId, message, settings.prefixes[0]);
                break;
            default:
                await sock.sendMessage(chatId, { 
                    text: `❓ Unknown activity command: *${subCommand}*\n\nUse *${settings.prefixes[0]}activity help* to see available commands.`,
                    //...context.channelInfo 
                }, { quoted: message });
        }
    }
};
