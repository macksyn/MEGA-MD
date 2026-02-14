// plugins/activitytracker.js
// Extends the bot's built-in message counting with activity type tracking
// Leverages existing store.incrementMessageCount() infrastructure

const moment = require('moment-timezone');
const store = require('../lib/lightweight_store');

moment.tz.setDefault('Africa/Lagos');

// ===== DEFAULT SETTINGS =====
const defaultSettings = {
    pointsPerMessage: 1,
    pointsPerSticker: 2,
    pointsPerVideo: 5,
    pointsPerVoiceNote: 3,
    pointsPerPoll: 5,
    pointsPerPhoto: 3,
    pointsPerAttendance: 10
};

// ===== CACHES =====
const enabledGroupsCache = new Set();
const settingsCache = { data: null, timestamp: 0 };
const cacheTimeout = 60 * 1000; // 1 minute

// ===== GROUP ENABLE/DISABLE =====
async function isGroupEnabled(groupId) {
    if (enabledGroupsCache.has(groupId)) {
        return true;
    }

    try {
        const enabledGroups = await store.getSetting('global', 'activity_enabled_groups') || {};
        const isEnabled = enabledGroups[groupId]?.enabled === true;
        
        if (isEnabled) {
            enabledGroupsCache.add(groupId);
        }
        
        return isEnabled;
    } catch (error) {
        return false;
    }
}

async function enableGroupTracking(groupId, groupName = '') {
    try {
        const enabledGroups = await store.getSetting('global', 'activity_enabled_groups') || {};
        
        enabledGroups[groupId] = {
            groupId,
            groupName,
            enabled: true,
            enabledAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
        };
        
        await store.saveSetting('global', 'activity_enabled_groups', enabledGroups);
        enabledGroupsCache.add(groupId);
        
        console.log(`✅ Activity tracking enabled for group: ${groupId}`);
        return { success: true };
    } catch (error) {
        console.error('Error enabling group tracking:', error);
        return { success: false, error: error.message };
    }
}

async function disableGroupTracking(groupId) {
    try {
        const enabledGroups = await store.getSetting('global', 'activity_enabled_groups') || {};
        
        if (enabledGroups[groupId]) {
            enabledGroups[groupId].enabled = false;
            enabledGroups[groupId].disabledAt = new Date().toISOString();
            enabledGroups[groupId].updatedAt = new Date().toISOString();
        }
        
        await store.saveSetting('global', 'activity_enabled_groups', enabledGroups);
        enabledGroupsCache.delete(groupId);
        
        console.log(`❌ Activity tracking disabled for group: ${groupId}`);
        return { success: true };
    } catch (error) {
        console.error('Error disabling group tracking:', error);
        return { success: false, error: error.message };
    }
}

async function getEnabledGroups() {
    try {
        const enabledGroups = await store.getSetting('global', 'activity_enabled_groups') || {};
        return Object.values(enabledGroups).filter(g => g.enabled === true);
    } catch (error) {
        return [];
    }
}

// ===== SETTINGS MANAGEMENT =====
async function getSettings() {
    const now = Date.now();
    if (settingsCache.data && now - settingsCache.timestamp < cacheTimeout) {
        return settingsCache.data;
    }

    try {
        const settings = await store.getSetting('global', 'activity_settings') || {};
        const finalSettings = { ...defaultSettings, ...settings };
        
        settingsCache.data = finalSettings;
        settingsCache.timestamp = now;
        
        return finalSettings;
    } catch (error) {
        return { ...defaultSettings };
    }
}

async function saveSettings(settings) {
    try {
        await store.saveSetting('global', 'activity_settings', settings);
        settingsCache.data = null;
        settingsCache.timestamp = 0;
    } catch (error) {
        console.error('Error saving activity settings:', error);
    }
}

// ===== ACTIVITY TYPE TRACKING (extends message count) =====
async function getActivityStats(userId, groupId, month = null) {
    const targetMonth = month || moment.tz('Africa/Lagos').format('YYYY-MM');
    const statsKey = `activity_stats_${targetMonth}`;
    
    try {
        const groupStats = await store.getSetting(groupId, statsKey) || {};
        
        if (!groupStats[userId]) {
            // Initialize with default stats
            groupStats[userId] = {
                userId,
                groupId,
                month: targetMonth,
                types: {
                    messages: 0,
                    stickers: 0,
                    videos: 0,
                    voiceNotes: 0,
                    polls: 0,
                    photos: 0,
                    attendance: 0
                },
                lastSeen: new Date().toISOString(),
                firstSeen: new Date().toISOString()
            };
        }
        
        return groupStats[userId];
    } catch (error) {
        return null;
    }
}

async function updateActivityStats(userId, groupId, activityType) {
    const currentMonth = moment.tz('Africa/Lagos').format('YYYY-MM');
    const statsKey = `activity_stats_${currentMonth}`;

    try {
        const groupStats = await store.getSetting(groupId, statsKey) || {};
        
        if (!groupStats[userId]) {
            groupStats[userId] = {
                userId,
                groupId,
                month: currentMonth,
                types: {
                    messages: 0,
                    stickers: 0,
                    videos: 0,
                    voiceNotes: 0,
                    polls: 0,
                    photos: 0,
                    attendance: 0
                },
                lastSeen: new Date().toISOString(),
                firstSeen: new Date().toISOString()
            };
        }
        
        // Update activity type count
        const typeMap = {
            'message': 'messages',
            'sticker': 'stickers',
            'video': 'videos',
            'voiceNote': 'voiceNotes',
            'poll': 'polls',
            'photo': 'photos',
            'attendance': 'attendance'
        };
        
        const statsField = typeMap[activityType];
        if (statsField) {
            groupStats[userId].types[statsField] = (groupStats[userId].types[statsField] || 0) + 1;
        }
        
        // Update last seen
        groupStats[userId].lastSeen = new Date().toISOString();
        
        await store.saveSetting(groupId, statsKey, groupStats);
    } catch (error) {
        console.error('Error updating activity stats:', error);
    }
}

// ===== MESSAGE TYPE DETECTION =====
function detectMessageType(message) {
    try {
        if (!message) return null;

        if (message.imageMessage) return 'photo';
        if (message.videoMessage) return 'video';
        if (message.stickerMessage) return 'sticker';
        if (message.audioMessage && message.audioMessage.ptt) return 'voiceNote';
        if (message.pollCreationMessage || message.pollCreationMessageV2 || message.pollCreationMessageV3) return 'poll';
        if (message.conversation || message.extendedTextMessage) return 'message';

        return null;
    } catch (error) {
        return null;
    }
}

// ===== POINTS CALCULATION =====
function calculatePoints(activityType, settings) {
    switch (activityType) {
        case 'message': return settings.pointsPerMessage;
        case 'sticker': return settings.pointsPerSticker;
        case 'video': return settings.pointsPerVideo;
        case 'voiceNote': return settings.pointsPerVoiceNote;
        case 'poll': return settings.pointsPerPoll;
        case 'photo': return settings.pointsPerPhoto;
        case 'attendance': return settings.pointsPerAttendance;
        default: return 0;
    }
}

// ===== COMBINED USER ACTIVITY (message count + activity types + points) =====
async function getUserActivity(userId, groupId, month = null) {
    const targetMonth = month || moment.tz('Africa/Lagos').format('YYYY-MM');
    
    try {
        // Get total message count from bot's built-in system
        const totalMessages = await store.getMessageCount(groupId, userId);
        
        // Get activity type breakdown from our extension
        const stats = await getActivityStats(userId, groupId, month);
        
        if (!stats) {
            return null;
        }
        
        // Calculate points
        const settings = await getSettings();
        let points = 0;
        
        for (const [type, count] of Object.entries(stats.types)) {
            const activityType = {
                'messages': 'message',
                'stickers': 'sticker',
                'videos': 'video',
                'voiceNotes': 'voiceNote',
                'polls': 'poll',
                'photos': 'photo',
                'attendance': 'attendance'
            }[type];
            
            points += calculatePoints(activityType, settings) * count;
        }
        
        return {
            userId,
            groupId,
            month: targetMonth,
            totalMessages: totalMessages || 0, // From bot's built-in counter
            stats: stats.types,                // Activity type breakdown
            points,                            // Calculated points
            lastSeen: stats.lastSeen,
            firstSeen: stats.firstSeen
        };
    } catch (error) {
        console.error('Error getting user activity:', error);
        return null;
    }
}

// ===== MAIN TRACKING LOGIC =====
async function trackActivity(message) {
    try {
        const chatId = message.key.remoteJid;
        
        // Only track in groups
        if (!chatId.endsWith('@g.us')) return;

        // Only track in enabled groups
        const enabled = await isGroupEnabled(chatId);
        if (!enabled) return;

        const senderId = message.key.participant || message.key.remoteJid;
        
        // Don't track bot messages (already handled by messageHandler)
        if (message.key.fromMe) return;

        const messageType = detectMessageType(message.message);
        if (!messageType) return;

        // The bot already incremented the message count in messageHandler.js
        // We just need to track the activity TYPE
        await updateActivityStats(senderId, chatId, messageType);

    } catch (error) {
        // Silent fail
    }
}

// ===== ATTENDANCE INTEGRATION =====
async function recordAttendance(userId, groupId) {
    try {
        const enabled = await isGroupEnabled(groupId);
        if (!enabled) return;

        await updateActivityStats(userId, groupId, 'attendance');
        console.log(`✅ Attendance tracked for ${userId.split('@')[0]}`);
    } catch (error) {
        console.error('Error recording attendance:', error);
    }
}

// ===== LEADERBOARD FUNCTIONS =====
async function getMonthlyLeaderboard(groupId, month = null, limit = 10) {
    const targetMonth = month || moment.tz('Africa/Lagos').format('YYYY-MM');
    const statsKey = `activity_stats_${targetMonth}`;

    try {
        // Get all message counts from bot's built-in system
        const allCounts = await store.getAllMessageCounts();
        const groupCounts = allCounts.messageCount?.[groupId] || {};
        
        // Get activity stats
        const groupStats = await store.getSetting(groupId, statsKey) || {};
        
        // Combine data
        const users = [];
        const settings = await getSettings();
        
        for (const [userId, messageCount] of Object.entries(groupCounts)) {
            const stats = groupStats[userId];
            
            if (!stats) continue;
            
            // Calculate points
            let points = 0;
            for (const [type, count] of Object.entries(stats.types)) {
                const activityType = {
                    'messages': 'message',
                    'stickers': 'sticker',
                    'videos': 'video',
                    'voiceNotes': 'voiceNote',
                    'polls': 'poll',
                    'photos': 'photo',
                    'attendance': 'attendance'
                }[type];
                
                points += calculatePoints(activityType, settings) * count;
            }
            
            users.push({
                userId,
                totalMessages: messageCount,
                stats: stats.types,
                points,
                lastSeen: stats.lastSeen,
                firstSeen: stats.firstSeen
            });
        }
        
        // Sort by points
        users.sort((a, b) => b.points - a.points);
        
        return users.slice(0, limit);
    } catch (error) {
        console.error('Error getting leaderboard:', error);
        return [];
    }
}

async function getUserRank(userId, groupId) {
    try {
        const leaderboard = await getMonthlyLeaderboard(groupId, null, 1000);
        const userIndex = leaderboard.findIndex(u => u.userId === userId);
        
        if (userIndex === -1) {
            return null;
        }
        
        return {
            rank: userIndex + 1,
            totalUsers: leaderboard.length,
            activity: leaderboard[userIndex]
        };
    } catch (error) {
        console.error('Error getting user rank:', error);
        return null;
    }
}

async function getInactiveMembers(groupId, limit = 10) {
    try {
        const leaderboard = await getMonthlyLeaderboard(groupId, null, 1000);
        
        // Sort by points ascending (least active first)
        leaderboard.sort((a, b) => a.points - b.points);
        
        return leaderboard.slice(0, limit);
    } catch (error) {
        console.error('Error getting inactive members:', error);
        return [];
    }
}

// ===== PLUGIN EXPORT =====
module.exports = {
    command: '_activitytracker',
    category: 'utility',
    description: 'Extends built-in message counter with activity type tracking',
    isPrefixless: true,
    
    async handler(sock, message, args, context) {
        // Runs on EVERY message (after messageHandler already counted it)
        // We just track the activity TYPE
        await trackActivity(message);
    },
    
    // Export functions for activity.js
    isGroupEnabled,
    enableGroupTracking,
    disableGroupTracking,
    getEnabledGroups,
    getSettings,
    saveSettings,
    getUserActivity,
    getUserRank,
    getMonthlyLeaderboard,
    getInactiveMembers,
    recordAttendance
};
