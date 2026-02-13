# WhatsApp Bot Personalization Guide

## 🎯 Quick Personalization Checklist

### 1. **Bot Identity** (settings.js)
```javascript
{
  botName: "YOUR_BOT_NAME",           // e.g., "MyAwesomeBot"
  botOwner: "YOUR_NAME",               // e.g., "John Doe"
  ownerNumber: "YOUR_NUMBER",          // e.g., "1234567890" (no + or spaces)
  packname: "YOUR_STICKER_PACK",       // Sticker watermark
  author: "YOUR_NAME"                  // Sticker author
}
```

### 2. **Branding** (Multiple Files)

#### Newsletter/Channel Info:
- File: `lib/messageConfig.js` and `lib/messageHandler.js`
- Search for: `120363319098372999@newsletter`
- Replace with: Your WhatsApp Channel ID (or remove if not using)

#### Welcome Messages:
- File: `lib/index.js` (lines ~274, 296)
- Customize default welcome/goodbye templates

### 3. **Owner Numbers** (data/owner.json, data/premium.json)
```json
["YOUR_NUMBER_HERE"]
```

### 4. **Docker Fix** (Dockerfile)

The current Dockerfile pulls from a private registry. Here's a working public version:

```dockerfile
FROM node:20-slim

# Install system dependencies
RUN apt-get update && apt-get install -y \
    ffmpeg \
    webp \
    git \
    imagemagick \
    curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm install --legacy-peer-deps

# Copy application files
COPY . .

# Expose port
EXPOSE 5000

# Start command
CMD ["npm", "start"]
```

### 5. **Repository Links** (README.md, package.json)

Search and replace:
- `GlobalTechInfo/MEGA-MD` → `YOUR_USERNAME/YOUR_REPO`
- `@GlobalTechInfo` → `@YOUR_USERNAME`
- Channel links → Your own links

---

## 🚀 Deployment Options

### Option A: **Heroku** (Recommended for Beginners)
1. Create new Heroku app
2. Add buildpacks:
   ```
   heroku/nodejs
   https://github.com/jonathanong/heroku-buildpack-ffmpeg-latest
   https://github.com/clhuang/heroku-buildpack-webp-binaries.git
   ```
3. Set environment variables in Heroku dashboard
4. Deploy via GitHub integration

### Option B: **Railway**
1. Connect GitHub repository
2. Railway auto-detects Dockerfile
3. Add environment variables in dashboard
4. Deploy

### Option C: **Local/VPS**
```bash
# Clone your forked repo
git clone https://github.com/YOUR_USERNAME/YOUR_REPO
cd YOUR_REPO

# Install dependencies
npm install --legacy-peer-deps

# Setup environment
cp sample.env .env
nano .env  # Edit with your values

# Run
npm start
```

---

## 🔐 Getting Session ID

### Method 1: Pairing Code (Easiest)
1. Set in `.env`:
   ```
   PAIRING_NUMBER=1234567890
   ```
2. Run bot, it will show pairing code
3. Open WhatsApp → Linked Devices → Link with Phone Number
4. Enter the code

### Method 2: Session from Existing
1. If you have existing session, put `creds.json` in `/session` folder
2. Set `SESSION_ID` to empty in `.env`

---

## 📝 Customization Tips

### Change Command Prefix
File: `settings.js`
```javascript
prefixes: ['.', '!', '/']  // Add or remove prefixes
```

### Add/Remove Commands
- Add: Create new file in `/plugins` folder following the pattern
- Remove: Delete or rename plugin file

### Modify Responses
- Search for text you want to change
- Files to check: `/plugins/*.js`, `/lib/messageHandler.js`

### Database Options (Recommended)
For production, use a database instead of JSON files:

```env
# MongoDB (Best for scalability)
MONGO_URL=mongodb+srv://user:pass@cluster.mongodb.net/dbname

# PostgreSQL (Good for complex queries)
POSTGRES_URL=postgresql://user:pass@host:5432/dbname

# MySQL
MYSQL_URL=mysql://user:pass@host:3306/dbname
```

Free options:
- MongoDB: MongoDB Atlas (512MB free)
- PostgreSQL: Neon, Supabase (free tier)

---

## 🐛 Common Issues

### 1. "Cannot find module"
```bash
npm install --legacy-peer-deps
```

### 2. "Session not found"
- Delete `/session` folder
- Use pairing code method

### 3. "Port already in use"
Change in `.env`:
```
PORT=3000
```

### 4. Docker build fails
Use the fixed Dockerfile above

### 5. Bot not responding
- Check if bot mode is set correctly (public/private)
- Verify owner number format (no + or spaces)
- Check logs for errors

---

## 🎨 Branding Checklist

- [ ] Bot name in settings.js
- [ ] Owner number in settings.js
- [ ] Owner numbers in data/owner.json
- [ ] Newsletter/channel ID (or remove)
- [ ] README with your info
- [ ] Package.json author/repository
- [ ] Remove/change "MEGA MD" references
- [ ] Custom welcome/goodbye messages
- [ ] Your logo/image in assets folder
- [ ] Update .gitignore for your needs

---

## 📚 File Structure Overview

```
├── data/               # JSON data storage (if not using DB)
├── lib/                # Core bot functionality
│   ├── lightweight_store.js  # Database abstraction
│   ├── messageHandler.js     # Message processing
│   └── commandHandler.js     # Command routing
├── plugins/            # Bot commands (add your own here!)
├── session/            # WhatsApp session (auto-generated)
├── temp/               # Temporary files
├── settings.js         # ⭐ Main configuration
├── config.js           # API keys
└── index.js            # Entry point
```

---

## 💡 Pro Tips

1. **Fork First**: Fork the original repo, then personalize your fork
2. **Keep Updated**: Regularly pull updates from upstream
3. **Use Database**: JSON files don't scale well for production
4. **Environment Variables**: Never commit .env to GitHub
5. **Test Locally**: Test all changes locally before deploying
6. **Backup Session**: Keep backup of session folder
7. **Monitor Logs**: Check logs regularly for errors
8. **Rate Limits**: Don't spam - respect WhatsApp's limits

---

## 🆘 Support

If you need help:
1. Check the logs first
2. Search existing GitHub issues
3. Create detailed bug report with:
   - Error message
   - Steps to reproduce
   - Environment (OS, Node version)
   - Relevant code snippets

---

## 📄 License

This bot is MIT licensed. You can:
- ✅ Use commercially
- ✅ Modify
- ✅ Distribute
- ✅ Private use

Must:
- Include original license
- Include copyright notice

---

## 🙏 Credits

Based on MEGA-MD by GlobalTechInfo
- Original: https://github.com/GlobalTechInfo/MEGA-MD
- Built with: Baileys WhatsApp library

---

**Happy Coding! 🚀**
