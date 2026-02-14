# HEDRA-AI WhatsApp Bot

## Overview
A multi-device WhatsApp bot built with Node.js using the Baileys library. It provides group management, social media downloading, sticker creation, text-to-speech, games, and many more features.

## Project Architecture
- **Runtime**: Node.js 20+
- **Main Entry**: `index.js`
- **Config**: `config.js` (API keys), `settings.js` (bot settings), `.env` (environment variables)
- **Plugins**: `plugins/` directory - each file is a command/feature module
- **Libraries**: `lib/` directory - utility and helper functions
- **Data**: `data/` directory - data files and storage
- **Assets**: `assets/` directory - images and media

## Key Dependencies
- `@whiskeysockets/baileys` - WhatsApp Web API
- `sharp` / `jimp` - Image processing
- `fluent-ffmpeg` - Media processing
- `express` - Web server (port 5000)
- `mongoose` / `pg` / `mysql2` - Database options
- `dotenv` - Environment variable management

## Environment Variables
- `SESSION_ID` - WhatsApp session ID (required for connection)
- `PAIRING_NUMBER` - Alternative: phone number for pairing code
- `REMOVEBG_KEY` - Remove.bg API key (optional)
- `MONGO_URL` / `POSTGRES_URL` / `MYSQL_URL` / `DB_URL` - Database connection (optional)
- `PORT` - Server port (default: 5000)

## Running
- Workflow: `node index.js` (Start WhatsApp Bot)
- The bot starts a web server on port 5000 and connects to WhatsApp

## Recent Changes
- 2026-02-14: Initial Replit setup, installed system deps (ffmpeg, libwebp), npm dependencies installed
