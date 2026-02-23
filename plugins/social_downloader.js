// plugins/social_downloader_v3.js
import axios from 'axios';
import chalk from 'chalk';
import { PluginHelpers, safeOperation } from '../lib/pluginIntegration.js';

// --- Constants (Copied from original) ---
const SETTINGS_COLLECTION = 'downloader_settings';
const USAGE_COLLECTION = 'downloader_usage';

const DEFAULT_SETTINGS = {
  premiumEnabled: false,
  downloadCost: 50,
  rateLimitFree: 10,
  rateLimitCooldown: 24 * 60 * 60 * 1000, // 24 hours
  enabledPlatforms: ['facebook', 'tiktok', 'twitter', 'instagram', 'spotify', 'youtube'],
  maxFileSize: 100, // MB
  allowGroups: true,
  allowPrivate: true,
  updatedAt: new Date(),
  updatedBy: 'system'
};

const PLATFORMS = {
  FACEBOOK: {
    name: 'Facebook',
    key: 'facebook',
    patterns: [
      /(?:https?:\/\/)?(?:www\.|m\.|web\.|mbasic\.)?facebook\.com\/(?:watch\/?\?v=|[\w-]+\/videos?\/|reel\/|share\/r\/|groups\/[\w-]+\/permalink\/|[\w-]+\/posts\/|story\.php\?story_fbid=|permalink\.php\?story_fbid=)[\w\d-]+/gi,
      /(?:https?:\/\/)?fb\.watch\/[\w-]+/gi
    ],
    icon: '𝐟'
  },
  TIKTOK: {
    name: 'TikTok',
    key: 'tiktok',
    patterns: [
      /(?:https?:\/\/)?(?:www\.|vm\.|vt\.)?tiktok\.com\/(?:@[\w.-]+\/video\/|v\/|t\/)?\w+/gi,
      /(?:https?:\/\/)?(?:www\.)?tiktok\.com\/@[\w.-]+\/video\/\d+/gi
    ],
    icon: '🎵'
  },
  TWITTER: {
    name: 'Twitter/X',
    key: 'twitter',
    patterns: [
      /(?:https?:\/\/)?(?:www\.|mobile\.)?(?:twitter|x)\.com\/[\w]+\/status\/\d+/gi,
      /(?:https?:\/\/)?t\.co\/[\w]+/gi
    ],
    icon: '𝕏'
  },
  INSTAGRAM: {
    name: 'Instagram',
    key: 'instagram',
    patterns: [
      /(?:https?:\/\/)?(?:www\.)?instagram\.com\/(?:p|reel|tv)\/[\w-]+/gi,
      /(?:https?:\/\/)?(?:www\.)?instagram\.com\/stories\/[\w.-]+\/\d+/gi
    ],
    icon: '🅾'
  },
  SPOTIFY: {
    name: 'Spotify',
    key: 'spotify',
    patterns: [
      /(?:https?:\/\/)?open\.spotify\.com\/track\/[\w]+/gi,
      /(?:https?:\/\/)?open\.spotify\.com\/album\/[\w]+/gi
    ],
    icon: '🎵'
  },
  YOUTUBE: {
    name: 'YouTube',
    key: 'youtube',
    patterns: [
      /(?:https?:\/\/)?(?:www\.|m\.)?youtube\.com\/watch\?v=[\w-]+/gi,
      /(?:https?:\/\/)?(?:www\.)?youtu\.be\/[\w-]+/gi,
      /(?:https?:\/\/)?(?:www\.|m\.)?youtube\.com\/shorts\/[\w-]+/gi,
      /(?:https?:\/\/)?(?:www\.|m\.)?youtube\.com\/embed\/[\w-]+/gi,
      /(?:https?:\/\/)?(?:www\.|m\.)?youtube\.com\/v\/[\w-]+/gi
    ],
    icon: '📺'
  }
};

const PLATFORM_APIS = {
  tiktok: {
    endpoint: 'https://jawad-tech.vercel.app/download/tiktok',
    buildUrl: (url) => `https://jawad-tech.vercel.app/download/tiktok?url=${encodeURIComponent(url)}`,
    extractData: (response) => {
      const data = response.data;

      // Check if API returned success
      if (!data || data.status === false) {
        throw new Error(data?.message || 'TikTok API returned error');
      }

      // Check if result (video URL) exists
      if (!data.result) {
        throw new Error('No video URL found in TikTok response');
      }

      return {
        url: data.result,
        thumbnail: data.metadata?.thumbnail || null,
        title: data.metadata?.title || 'TikTok Video',
        duration: null,
        author: data.metadata?.author || data.metadata?.username || 'Unknown'
      };
    }
  },
  instagram: {
    endpoint: 'https://jawad-tech.vercel.app/igdl',
    buildUrl: (url) => `https://jawad-tech.vercel.app/igdl?url=${encodeURIComponent(url)}`,
    extractData: (response) => {
      const data = response.data;

      // Check if API returned success
      if (!data || data.status === false) {
        throw new Error(data?.message || 'Instagram API returned error');
      }

      // Check if result array exists and has items
      if (!data.result || !Array.isArray(data.result) || data.result.length === 0) {
        throw new Error('No media found in Instagram response');
      }

      const media = data.result[0];

      // Validate media URL
      if (!media.url) {
        throw new Error('No valid media URL found in Instagram response');
      }

      return {
        url: media.url,
        thumbnail: null,
        title: 'Instagram Media',
        duration: null,
        type: media.contentType?.includes('video') ? 'video' : 'image',
        format: media.format || null,
        size: media.size || null
      };
    }
  },
  facebook: {
    endpoint: 'https://jawad-tech.vercel.app/downloader',
    buildUrl: (url) => `https://jawad-tech.vercel.app/downloader?url=${encodeURIComponent(url)}`,
  extractData: (response) => {
      const data = response.data;

      // Check if API returned success
      if (!data.status || data.status === false) {
        throw new Error(data.message || 'Facebook API returned error');
      }

      // Check if result array exists and has items
      if (!data.result || !Array.isArray(data.result) || data.result.length === 0) {
        throw new Error('No video URLs found in Facebook response');
      }

      // Try to get HD quality first, fallback to SD or first available
      const hdVideo = data.result.find(v => v.quality === 'HD');
      const sdVideo = data.result.find(v => v.quality === 'SD');
      const videoData = hdVideo || sdVideo || data.result[0];

      if (!videoData || !videoData.url) {
        throw new Error('No valid video URL found in Facebook response');
      }

      return {
        url: videoData.url,
        thumbnail: data.metadata?.thumbnail || null,
        title: data.metadata?.title || 'Facebook Video',
        duration: data.metadata?.duration || null,
        isHd: videoData.quality === 'HD'
      };
    }
  },
  spotify: {
    endpoint: 'https://delirius-apiofc.vercel.app/download/spotifydlv2',
    buildUrl: (url) => `https://delirius-apiofc.vercel.app/download/spotifydlv2?url=${encodeURIComponent(url)}`,
    extractData: (response) => {
      const data = response.data?.data;
      if (!data || !data.url) {
        throw new Error('Invalid Spotify response format');
      }

      return {
        url: data.url,
        thumbnail: data.image || null,
        title: data.title || 'Spotify Track',
        duration: data.duration || null,
        artist: data.artist || 'Unknown Artist',
        album: data.album || null
      };
    }
  },
  twitter: {
    buildUrl: (url) => `https://twitsave.com/info?url=${encodeURIComponent(url)}`,
    extractData: (response) => {
      const videoMatch = response.data.match(/https?:\/\/[^\s<>"]+\.mp4/);
      if (!videoMatch) {
        throw new Error('No video URL found in Twitter response');
      }

      return {
        url: videoMatch[0],
        thumbnail: null,
        title: 'Twitter Video',
        duration: null
      };
    }
  },
  youtube: {
    endpoint: 'https://jawad-tech.vercel.app/download/ytdl',
    buildUrl: (url) => `https://jawad-tech.vercel.app/download/ytdl?url=${encodeURIComponent(url)}`,
    extractData: (response) => {
      const data = response.data;

      // Check if API returned success
      if (!data.status || data.status === false) {
        throw new Error(data.message || 'YouTube API returned error');
      }

      // Check if result exists
      if (!data.result) {
        throw new Error('No result found in YouTube response');
      }

      return {
        url: data.result.mp4 || data.result.mp3,
        mp3Url: data.result.mp3,
        mp4Url: data.result.mp4,
        thumbnail: null,
        title: data.result.title || 'YouTube Video',
        duration: null,
        hasAudio: !!data.result.mp3,
        hasVideo: !!data.result.mp4
      };
    }
  }
};

// --- Downloader Class (Copied from original) ---
class SocialMediaDownloader {
  constructor() {
    this.settings = null;
    this.activeDownloads = new Map();
    this.statsCache = null;
    this.statsCacheTime = 0;
    this.statsCacheDuration = 5 * 60 * 1000; // 5 minutes
  }

  async initialize() {
    try {
      this.settings = await this.loadSettings();
      console.log(chalk.green('✅ Downloader settings loaded from database'));
      return true;
    } catch (error) {
      console.error(chalk.red('❌ Failed to load downloader settings:'), error.message);
      this.settings = { ...DEFAULT_SETTINGS };
      return false;
    }
  }

  async loadSettings() {
    try {
      return await safeOperation(async (db, collection) => {
        let settings = await collection.findOne({ _id: 'main_settings' });

        if (!settings) {
          settings = { _id: 'main_settings', ...DEFAULT_SETTINGS };
          await collection.insertOne(settings);
          console.log(chalk.cyan('📝 Created default downloader settings'));
        }

        return settings;
      }, SETTINGS_COLLECTION);
    } catch (error) {
      console.error(chalk.red('Error loading settings:'), error.message);
      return { ...DEFAULT_SETTINGS };
    }
  }

  async saveSettings(updates, updatedBy = 'system') {
    try {
      return await safeOperation(async (db, collection) => {
        const updateData = {
          ...updates,
          updatedAt: new Date(),
          updatedBy
        };

        const result = await collection.updateOne(
          { _id: 'main_settings' },
          { $set: updateData },
          { upsert: true }
        );

        this.settings = await this.loadSettings();

        console.log(chalk.green('✅ Downloader settings updated'));
        return result;
      }, SETTINGS_COLLECTION);
    } catch (error) {
      console.error(chalk.red('Error saving settings:'), error.message);
      throw error;
    }
  }

  getSettings() {
    return this.settings || { ...DEFAULT_SETTINGS };
  }

  isAdmin(userId) {
    const adminNumber = process.env.OWNER_NUMBER || process.env.ADMIN_NUMBER;
    if (!adminNumber) return false;

    const userNumber = userId.split('@')[0];
    return adminNumber === userNumber || adminNumber.includes(userNumber);
  }

  detectPlatform(url) {
    for (const [platform, config] of Object.entries(PLATFORMS)) {
      for (const pattern of config.patterns) {
        pattern.lastIndex = 0;
        if (pattern.test(url)) {
          return { platform, config };
        }
      }
    }
    return null;
  }

  isPlatformEnabled(platformKey) {
    const settings = this.getSettings();
    return settings.enabledPlatforms?.includes(platformKey) ?? true;
  }

  async getUserUsage(userId) {
    try {
      return await safeOperation(async (db, collection) => {
        const now = Date.now();
        let usage = await collection.findOne({ userId });

        if (!usage) {
          usage = {
            userId,
            count: 0,
            resetTime: now + this.getSettings().rateLimitCooldown,
            totalDownloads: 0,
            lastDownload: null,
            createdAt: new Date()
          };
          await collection.insertOne(usage);
        }

        if (now > usage.resetTime) {
          await collection.updateOne(
            { userId },
            { 
              $set: { 
                count: 0, 
                resetTime: now + this.getSettings().rateLimitCooldown 
              } 
            }
          );
          usage.count = 0;
          usage.resetTime = now + this.getSettings().rateLimitCooldown;
        }

        return usage;
      }, USAGE_COLLECTION);
    } catch (error) {
      console.error(chalk.red('Error getting user usage:'), error.message);
      return { count: 0, resetTime: Date.now() + this.getSettings().rateLimitCooldown };
    }
  }

  async checkRateLimit(userId) {
    const settings = this.getSettings();
    if (settings.premiumEnabled) return true;

    const usage = await this.getUserUsage(userId);
    const now = Date.now();

    if (usage.count >= settings.rateLimitFree) {
      const hoursLeft = Math.ceil((usage.resetTime - now) / (60 * 60 * 1000));
      return { limited: true, hoursLeft, current: usage.count, limit: settings.rateLimitFree };
    }

    return true;
  }

  async incrementUsage(userId, platform, url) {
    try {
      return await safeOperation(async (db, collection) => {
        await collection.updateOne(
          { userId },
          { 
            $inc: { count: 1, totalDownloads: 1 },
            $set: { lastDownload: new Date() },
            $push: { 
              downloads: { 
                $each: [{ platform, url, timestamp: new Date() }],
                $slice: -50 // Keep only last 50 downloads
              }
            }
          },
          { upsert: true }
        );
      }, USAGE_COLLECTION);
    } catch (error) {
      console.error(chalk.red('Error incrementing usage:'), error.message);
    }
  }

  async downloadWithPlatformAPI(url, platformKey) {
    try {
      const apiConfig = PLATFORM_APIS[platformKey];
      if (!apiConfig) {
        throw new Error(`No API configuration found for platform: ${platformKey}`);
      }

      console.log(chalk.cyan(`🔄 Downloading from ${platformKey} API: ${url}`));

      const apiUrl = apiConfig.buildUrl(url);
      console.log(chalk.cyan(`API URL: ${apiUrl}`));

      const response = await axios.get(apiUrl, {
        timeout: 30000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        }
      });

      console.log(chalk.green(`✅ ${platformKey} API response received`));

      if (response.data.status === false) {
        throw new Error(response.data.message || 'API returned error status');
      }

      const extractedData = apiConfig.extractData(response);

      return {
        ...extractedData,
        source: platformKey
      };
    } catch (error) {
      console.error(chalk.red(`${platformKey} API error:`), error.message);

      if (error.response) {
        console.error(chalk.red('Response status:'), error.response.status);
        console.error(chalk.red('Response data:'), JSON.stringify(error.response.data, null, 2));
      }

      throw error;
    }
  }

  async download(url, userId, isGroup) {
    const downloadId = `${userId}_${Date.now()}`;
    const settings = this.getSettings();

    if (isGroup && !settings.allowGroups) {
      return { error: '⚠️ Group downloads are currently disabled by admin.' };
    }
    if (!isGroup && !settings.allowPrivate) {
      return { error: '⚠️ Private downloads are currently disabled by admin.' };
    }

    if (this.activeDownloads.has(userId)) {
      return { error: 'You already have a download in progress. Please wait.' };
    }

    try {
      this.activeDownloads.set(userId, downloadId);

      const detection = this.detectPlatform(url);
      if (!detection) {
        return { error: 'Unsupported URL. Please provide a valid social media link.' };
      }

      const { platform, config } = detection;

      if (!this.isPlatformEnabled(config.key)) {
        return { error: `${config.name} downloads are currently disabled by admin.` };
      }

      const rateLimitCheck = await this.checkRateLimit(userId);
      if (rateLimitCheck.limited) {
        return { 
          error: `📊 *Daily Limit Reached!*\n\n` +
                 `Current: ${rateLimitCheck.current}/${rateLimitCheck.limit}\n` +
                 `Reset in: ${rateLimitCheck.hoursLeft} hours\n\n` +
                 `_Contact admin to upgrade to premium_`,
          limited: true
        };
      }

      if (settings.premiumEnabled) {
        const balance = await PluginHelpers.getBalance(userId);
        if (balance.wallet < settings.downloadCost) {
          return { 
            error: `💳 *Insufficient Balance!*\n\n` +
                   `Required: ₦${settings.downloadCost}\n` +
                   `Your balance: ₦${balance.wallet}\n\n` +
                   `_Use economy commands to earn money_`,
            insufficientBalance: true
          };
        }
      }

      let result;

      try {
        result = await this.downloadWithPlatformAPI(url, config.key);
      } catch (error) {
        console.error(chalk.red(`❌ ${config.name} download failed`));

        return { 
          error: `❌ *Download Failed*\n\n` +
                 `The ${config.name} content couldn't be downloaded. Possible reasons:\n` +
                 `• The link is invalid or expired\n` +
                 `• The content is private/protected\n` +
                 `• The API is temporarily unavailable\n\n` +
                 `*Error:* ${error.message}\n\n` +
                 `_Try a different link or contact admin_`
        };
      }

      if (settings.premiumEnabled) {
        await PluginHelpers.removeMoney(userId, settings.downloadCost, `${config.name} download`);
      } else {
        await this.incrementUsage(userId, config.name, url);
      }

      await this.logDownload(userId, config.name, settings.premiumEnabled);

      return {
        success: true,
        platform: config.name,
        icon: config.icon,
        ...result
      };

    } catch (error) {
      console.error(chalk.red('Download error:'), error.message);
      return { error: `An unexpected error occurred: ${error.message}` };
    } finally {
      this.activeDownloads.delete(userId);
    }
  }

  async logDownload(userId, platform, isPremium) {
    try {
      await safeOperation(async (db, collection) => {
        await collection.updateOne(
          { _id: 'stats' },
          { 
            $inc: { 
              totalDownloads: 1,
              [`platforms.${platform}`]: 1,
              [isPremium ? 'premiumDownloads' : 'freeDownloads']: 1
            },
            $set: { lastDownload: new Date() }
          },
          { upsert: true }
        );
      }, SETTINGS_COLLECTION);
    } catch (error) {
      console.error(chalk.red('Error logging download:'), error.message);
    }
  }

  async getRemainingDownloads(userId) {
    const settings = this.getSettings();
    if (settings.premiumEnabled) return 'Unlimited (Premium)';

    const usage = await this.getUserUsage(userId);
    return Math.max(0, settings.rateLimitFree - usage.count);
  }

  async getStats() {
    const now = Date.now();

    if (this.statsCache && (now - this.statsCacheTime < this.statsCacheDuration)) {
      return this.statsCache;
    }

    try {
      const stats = await safeOperation(async (db, collection) => {
        const globalStats = await collection.findOne({ _id: 'stats' }) || {
          totalDownloads: 0,
          freeDownloads: 0,
          premiumDownloads: 0,
          platforms: {}
        };

        return globalStats;
      }, SETTINGS_COLLECTION);

      const usageStats = await safeOperation(async (db, collection) => {
        const totalUsers = await collection.countDocuments();
        const activeUsers = await collection.countDocuments({ 
          lastDownload: { $gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) } 
        });

        return { totalUsers, activeUsers };
      }, USAGE_COLLECTION);

      const settings = this.getSettings();

      const result = {
        ...stats,
        ...usageStats,
        activeDownloads: this.activeDownloads.size,
        settings: {
          premiumEnabled: settings.premiumEnabled,
          downloadCost: settings.downloadCost,
          rateLimitFree: settings.rateLimitFree,
          enabledPlatforms: settings.enabledPlatforms,
          allowGroups: settings.allowGroups,
          allowPrivate: settings.allowPrivate
        },
        lastUpdated: new Date()
      };

      this.statsCache = result;
      this.statsCacheTime = now;

      return result;
    } catch (error) {
      console.error(chalk.red('Error getting stats:'), error.message);
      return {
        totalDownloads: 0,
        activeDownloads: this.activeDownloads.size,
        error: error.message
      };
    }
  }

  async getUserHistory(userId, limit = 10) {
    try {
      return await safeOperation(async (db, collection) => {
        const usage = await collection.findOne({ userId });
        return usage?.downloads?.slice(-limit).reverse() || [];
      }, USAGE_COLLECTION);
    } catch (error) {
      console.error(chalk.red('Error getting user history:'), error.message);
      return [];
    }
  }
}

// --- Create Singleton Instance (Copied from original) ---
const downloader = new SocialMediaDownloader();

// --- Command Handlers (Copied from original, modified to accept downloader instance) ---

async function handleDlSettings(reply, downloaderInstance, config, sender, settingArgs) {
  const settings = downloaderInstance.getSettings();

  if (settingArgs.length === 0) {
    const adminNum = process.env.OWNER_NUMBER || process.env.ADMIN_NUMBERS || 'Not configured';
    await reply(
      `*⚙️ Downloader Settings*\n\n` +
      `*Admin Number:* ${adminNum}\n\n` +
      `*Premium Mode:* ${settings.premiumEnabled ? '✅ Enabled' : '❌ Disabled'}\n` +
      `*Download Cost:* ₦${settings.downloadCost}\n` +
      `*Free Limit:* ${settings.rateLimitFree} per day\n` +
      `*Cooldown:* ${settings.rateLimitCooldown / (60 * 60 * 1000)}h\n\n` +
      `*Enabled Platforms:*\n${settings.enabledPlatforms.map(p => `• ${p}`).join('\n')}\n\n` +
      `*Allow Groups:* ${settings.allowGroups ? '✅' : '❌'}\n` +
      `*Allow Private:* ${settings.allowPrivate ? '✅' : '❌'}\n\n` +
      `*Last Updated:* ${new Date(settings.updatedAt).toLocaleString()}\n` +
      `*Updated By:* ${settings.updatedBy}\n\n` +
      `*Commands:*\n` +
      `${config.PREFIX}dlsettings premium on/off\n` +
      `${config.PREFIX}dlsettings cost <amount>\n` +
      `${config.PREFIX}dlsettings limit <number>\n` +
      `${config.PREFIX}dlsettings platform <name> on/off\n` +
      `${config.PREFIX}dlsettings groups on/off\n` +
      `${config.PREFIX}dlsettings private on/off`
    );
    return;
  }

  const action = settingArgs[0];
  const value = settingArgs[1];
  const updates = {};

  try {
    switch (action) {
      case 'premium':
        if (value === 'on' || value === 'off') {
          updates.premiumEnabled = value === 'on';
          await downloaderInstance.saveSettings(updates, sender);
          await reply(`✅ Premium mode ${value === 'on' ? 'enabled' : 'disabled'}`);
        } else {
          await reply('❌ Usage: .dlsettings premium on/off');
        }
        break;
      case 'cost':
        const cost = parseInt(value);
        if (!isNaN(cost) && cost >= 0) {
          updates.downloadCost = cost;
          await downloaderInstance.saveSettings(updates, sender);
          await reply(`✅ Download cost set to ₦${cost}`);
        } else {
          await reply('❌ Invalid cost. Usage: .dlsettings cost <number>');
        }
        break;
      case 'limit':
        const limit = parseInt(value);
        if (!isNaN(limit) && limit > 0) {
          updates.rateLimitFree = limit;
          await downloaderInstance.saveSettings(updates, sender);
          await reply(`✅ Free download limit set to ${limit} per day`);
        } else {
          await reply('❌ Invalid limit. Usage: .dlsettings limit <number>');
        }
        break;
      case 'platform':
        const platform = value?.toLowerCase();
        const state = settingArgs[2];
        if (platform && (state === 'on' || state === 'off')) {
          const settings = downloaderInstance.getSettings();
          const platforms = [...settings.enabledPlatforms] || [];

          if (state === 'on' && !platforms.includes(platform)) {
            platforms.push(platform);
          } else if (state === 'off') {
            const index = platforms.indexOf(platform);
            if (index > -1) platforms.splice(index, 1);
          }

          updates.enabledPlatforms = platforms;
          await downloaderInstance.saveSettings(updates, sender);
          await reply(`✅ ${platform} ${state === 'on' ? 'enabled' : 'disabled'}`);
        } else {
          await reply('❌ Usage: .dlsettings platform <facebook|tiktok|twitter|instagram|spotify|youtube> on/off');
        }
        break;
      case 'groups':
        if (value === 'on' || value === 'off') {
          updates.allowGroups = value === 'on';
          await downloaderInstance.saveSettings(updates, sender);
          await reply(`✅ Group downloads ${value === 'on' ? 'enabled' : 'disabled'}`);
        } else {
          await reply('❌ Usage: .dlsettings groups on/off');
        }
        break;
      case 'private':
        if (value === 'on' || value === 'off') {
          updates.allowPrivate = value === 'on';
          await downloaderInstance.saveSettings(updates, sender);
          await reply(`✅ Private downloads ${value === 'on' ? 'enabled' : 'disabled'}`);
        } else {
          await reply('❌ Usage: .dlsettings private on/off');
        }
        break;
      default:
        await reply(`❌ Unknown setting: ${action}\n\nUse ${config.PREFIX}dlsettings to see available commands`);
    }
  } catch (error) {
     console.error(chalk.red('Error updating setting:'), error.message);
     await reply(`❌ Error updating setting: ${error.message}`);
  }
}

async function handleDownload(reply, downloaderInstance, config, sock, m, sender, isGroup, bot, url) {
  if (!url) {
    const remaining = await downloaderInstance.getRemainingDownloads(sender);
    const settings = downloaderInstance.getSettings();

    let replyText = `*📥 Social Media Downloader*\n\n`;
    replyText += `*Supported Platforms:*\n`;
    replyText += `${settings.enabledPlatforms.map(p => {
      const plat = Object.values(PLATFORMS).find(pl => pl.key === p);
      return plat ? `${plat.icon} ${plat.name}` : '';
    }).filter(Boolean).join('\n')}\n\n`;
    replyText += `*Your Status:*\n`;
    if (settings.premiumEnabled) {
      replyText += `💎 Premium: ₦${settings.downloadCost} per download\n\n`;
    } else {
      replyText += `🆓 Free: ${remaining}/${settings.rateLimitFree} remaining today\n\n`;
    }
    replyText += `*Usage:* ${config.PREFIX}dl <url>\n`;
    replyText += `*Example:* ${config.PREFIX}dl https://tiktok.com/@user/video/123`;

    await reply(replyText);
    return;
  }

  await sock.sendMessage(m.from, { react: { text: '⏳', key: m.key } });
  const result = await downloaderInstance.download(url, sender, isGroup);
  await sock.sendMessage(m.from, { react: { text: '', key: m.key } }); // Remove reaction

  if (result.error) {
    await sock.sendMessage(m.from, { react: { text: '❌', key: m.key } });
    await reply(result.error);
    return;
  }

  if (result.success) {
    const settings = downloaderInstance.getSettings();
    const remaining = await downloaderInstance.getRemainingDownloads(sender);

    let caption = `${result.icon} *${result.platform} Download*\n\n`;

    if (result.artist) {
      caption += `🎤 *Artist:* ${result.artist}\n`;
    }
    if (result.title && result.title !== 'media') {
      caption += `📝 *Title:* ${result.title}\n`;
    }
    if (result.album) {
      caption += `💿 *Album:* ${result.album}\n`;
    }
    if (result.author) {
      caption += `👤 *Creator:* ${result.author}\n`;
    }

    if (settings.premiumEnabled) {
      caption += `💳 Charged: ₦${settings.downloadCost}\n`;
    } else {
      caption += `🆓 Remaining: ${remaining}/${settings.rateLimitFree}\n`;
    }
    caption += `\n⚡ Powered by ${bot?.name || 'Groq'}`;

    try {
      const isAudio = result.platform === 'Spotify';
      const isImage = result.type === 'image';
      const isYouTube = result.platform === 'YouTube';

      if (isAudio) {
        await sock.sendMessage(m.from, {
          audio: { url: result.url },
          mimetype: 'audio/mpeg',
          ptt: false,
          fileName: `${result.title}.mp3`
        }, { quoted: m });

        await sock.sendMessage(m.from, { text: caption }, { quoted: m });
      } else if (isImage) {
        await sock.sendMessage(m.from, {
          image: { url: result.url },
          caption: caption
        }, { quoted: m });
      } else if (isYouTube) {
        // Send video first
        if (result.mp4Url) {
          await sock.sendMessage(m.from, {
            video: { url: result.mp4Url },
            caption: caption,
            mimetype: 'video/mp4'
          }, { quoted: m });
        }

        // Send audio if available
        if (result.mp3Url) {
          await sock.sendMessage(m.from, {
            audio: { url: result.mp3Url },
            mimetype: 'audio/mpeg',
            ptt: false,
            fileName: `${result.title}.mp3`
          }, { quoted: m });
        }
      } else {
        await sock.sendMessage(m.from, {
          video: { url: result.url },
          caption: caption,
          mimetype: 'video/mp4'
        }, { quoted: m });
      }

      await sock.sendMessage(m.from, {
        react: { text: '✅', key: m.key }
      });
    } catch (sendError) {
      console.error(chalk.red('Error sending media:'), sendError.message);

      await sock.sendMessage(m.from, {
        react: { text: '❌', key: m.key }
      });

      await reply(
        `❌ *Send Failed*\n\nThe media was downloaded but couldn't be sent. This might be due to:\n• File size too large\n• Network issues\n• WhatsApp restrictions\n\nDirect link: ${result.url}`
      );
    }
  }
}

async function handleDlStats(reply, downloaderInstance) {
  const stats = await downloaderInstance.getStats();

  await reply(
    `*📊 Downloader Statistics*\n\n` +
    `*Total Downloads:* ${stats.totalDownloads || 0}\n` +
    `*Free Downloads:* ${stats.freeDownloads || 0}\n` +
    `*Premium Downloads:* ${stats.premiumDownloads || 0}\n` +
    `*Active Downloads:* ${stats.activeDownloads}\n\n` +
    `*Users:*\n` +
    `• Total: ${stats.totalUsers || 0}\n` +
    `• Active (7d): ${stats.activeUsers || 0}\n\n` +
    `*Platforms:*\n` +
    `${Object.entries(stats.platforms || {}).map(([p, count]) => `• ${p}: ${count}`).join('\n') || 'No data'}\n\n` +
    `*Settings:*\n` +
    `• Mode: ${stats.settings?.premiumEnabled ? '💎 Premium' : '🆓 Free'}\n` +
    `• Cost: ₦${stats.settings?.downloadCost || 0}\n` +
    `• Daily Limit: ${stats.settings?.rateLimitFree || 0}\n\n` +
    `*Last Updated:* ${new Date(stats.lastUpdated).toLocaleString()}`
  );
}

async function handleDlHistory(reply, downloaderInstance, sender) {
  const history = await downloaderInstance.getUserHistory(sender, 10);

  if (history.length === 0) {
    await reply(`📜 *Your Download History*\n\nNo downloads yet!`);
    return;
  }

  const historyText = history.map((item, i) => 
    `${i + 1}. ${item.platform}\n   ${new Date(item.timestamp).toLocaleString()}`
  ).join('\n\n');

  await reply(`📜 *Your Download History*\n\n${historyText}\n\n_Showing last ${history.length} downloads_`);
}

// ===================================
// ===== V3 PLUGIN EXPORT OBJECT =====
// ===================================

export default {
  // Metadata from original 'info' object
  name: 'Social Media Downloader',
  version: '3.1.0',
  author: 'Alex Macksyn',
  description: 'Download videos/audio from social media (Facebook, TikTok, Twitter, Instagram, Spotify, YouTube)',
  category: 'media',

  // Commands from original 'info' object
  commands: ['dl', 'download', 'dlsettings', 'dlstats', 'dlhistory'],
  aliases: [], // Original 'info' object didn't have aliases array

  /**
   * (Optional) V3 init function.
   * Called by PluginManager when loading the plugin.
   */
  async init(context) {
    const { logger } = context;
    await downloader.initialize();

    const settings = downloader.getSettings();
    logger.info('✅ Social Media Downloader V3 initialized');
    logger.info(`Mode: ${settings.premiumEnabled ? '💎 Premium' : '🆓 Free'}`);
    logger.info(`Supported: TikTok, Instagram, Facebook, Twitter, Spotify, YouTube`);
  },

  /**
   * V3 Main run function.
   * Called by PluginManager for every matching command.
   */
  async run(context) {
    const { msg: m, sock, config, bot, logger, helpers, command, args, text } = context;

    try {
      // Ensure initialization (safe fallback if init failed)
      if (!downloader.settings) {
        await downloader.initialize();
      }

      // V3 context already provides sender, from, isGroup
      const sender = m.sender;
      const from = m.from;
      const isGroup = m.isGroup;

      if (!sender) {
        logger.warn('⚠️ No sender found in message (from V3 context)');
        return;
      }

      const isAdmin = downloader.isAdmin(sender);

      // Reply helper using context
      const reply = async (text) => {
        // Use m.reply helper if available, otherwise fallback
        if (typeof m.reply === 'function') {
            await m.reply(text);
        } else {
            await sock.sendMessage(from, { text }, { quoted: m });
        }
      };

      // --- Command Routing ---

      // Admin Settings Command: .dlsettings
      if (command === 'dlsettings') {
        if (!isAdmin) {
          await reply('⛔ *Access Denied*\n\nThis command is only available to administrators.');
          return;
        }
        await handleDlSettings(reply, downloader, config, sender, args); // args from context
        return;
      }

      // Download Command: .dl <url> or .download <url>
      if (command === 'dl' || command === 'download') {
        const url = text; // 'text' from context is the full string after the command
        await handleDownload(reply, downloader, config, sock, m, sender, isGroup, bot, url);
        return;
      }

      // Statistics Command: .dlstats
      if (command === 'dlstats') {
        if (!isAdmin) {
          await reply('⛔ *Access Denied*\n\nThis command is only available to administrators.');
          return;
        }
        await handleDlStats(reply, downloader);
        return;
      }

      // User History Command: .dlhistory
      if (command === 'dlhistory') {
        await handleDlHistory(reply, downloader, sender);
        return;
      }

    } catch (error) {
      logger.error(error, `❌ ${this.name} plugin error`);
      try {
        const reply = (msg) => sock.sendMessage(m.from, { text: msg }, { quoted: m });
        await reply(`❌ *Plugin Error*\n\nAn unexpected error occurred in the downloader. Please try again or contact admin.\n\n_Error: ${error.message}_`);
      } catch (replyError) {
        logger.error(replyError, 'Failed to send error message');
      }
    }
  }
};