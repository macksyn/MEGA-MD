'use strict';

/**
 * plugins/chatbot.js  — v2
 *
 * Fixes over v1:
 *  1. Prompt size budget — prompt is always built within a char limit,
 *     history is trimmed first, then profile, before sending to API.
 *  2. Race-condition fix on warmUserCache (loading-Set guard).
 *  3. Dirty-set tracking — only changed users are flushed to DB.
 *  4. Interest decay — interests expire after 14 days of inactivity.
 *  5. Per-group rate limiting — max 5 AI calls/min per group.
 *  6. isBotAddressed covers image/video caption mentions.
 *  7. API failure recovery — failures reset after 5 min, not just on success.
 *  8. Single typing indicator — shown once, timed to response length.
 *  9. History stored matches what prompt uses (both capped at MAX_HISTORY).
 */

const fetch = require('node-fetch');
const { createStore } = require('../lib/pluginStore');

// ── Storage ───────────────────────────────────────────────────────────────────
const db         = createStore('chatbot');
const dbSettings = db.table('settings');
const dbProfiles = db.table('profiles');
const dbHistory  = db.table('history');

// ── Constants ─────────────────────────────────────────────────────────────────
const MAX_MEMORY_USERS   = 200;
const MAX_HISTORY        = 10;   // stored & used — no more double the work
const SUMMARY_TRIGGER    = 8; // summarize when history reaches this many messages
const COOLDOWN_MS        = 3000;
const PERSIST_EVERY_MS   = 10 * 60 * 1000;
const INTEREST_TTL_MS    = 14 * 24 * 60 * 60 * 1000; // 14 days
const GROUP_RATE_LIMIT   = 5;    // max AI calls per group per window
const GROUP_RATE_WINDOW  = 60_000; // 1 minute
const API_FAILURE_RESET  = 5 * 60 * 1000; // reset failure counts every 5 min

/**
 * PROMPT BUDGET
 * GET-based APIs fail when the URL gets too long.
 * We keep the full prompt under this character count.
 * If it would exceed the limit, we trim history first, then profile fields.
 */
const PROMPT_CHAR_BUDGET = 1800;

// ── In-memory state ───────────────────────────────────────────────────────────
const memory = {
    history:  new Map(),   // senderId → string[]
    profiles: new Map(),   // senderId → profile object
};

const enabledGroups  = new Set();
const cooldowns      = new Map();
const dirtyUsers     = new Set();   // only flush users whose data changed
const _warming       = new Set();   // race-condition guard for warmUserCache

// ── Per-group rate limiter ────────────────────────────────────────────────────
const groupRateBuckets = new Map(); // chatId → { count, resetAt }

function checkGroupRateLimit(chatId) {
    const now    = Date.now();
    const bucket = groupRateBuckets.get(chatId) || { count: 0, resetAt: now + GROUP_RATE_WINDOW };

    if (now > bucket.resetAt) {
        bucket.count   = 0;
        bucket.resetAt = now + GROUP_RATE_WINDOW;
    }

    if (bucket.count >= GROUP_RATE_LIMIT) return false;

    bucket.count++;
    groupRateBuckets.set(chatId, bucket);
    return true;
}

// ── Crisis detection ──────────────────────────────────────────────────────────
const CRISIS_RE = [
    // "want to die" but NOT "want to die laughing" — the negative lookahead
    // excludes laugh/lol/emoji context so it doesn't false-positive on jokes
    /\b(want to die|kill myself|end my life|no reason to live)\b(?!.*\b(laugh|lmao|lol|joke|haha|funny|meme|😂|💀|😭))/i,
    /\bfeel like killing myself\b/i,          // catches the pidgin variant
    /\b(self.?harm|cutting myself|hurt myself on purpose)\b/i,
    /\b(cant go on|give up on life|nobody cares if i die)\b/i,
];

const CRISIS_REPLY =
    `Hey, I hear you and I'm really glad you said something 💙\n\n` +
    `Whatever you're going through right now, please talk to someone who can actually help:\n` +
    `📞 *Nigeria Suicide Prevention:* 0800-800-2000 (free, 24/7)\n\n` +
    `You matter more than you know. Don't go through this alone.`;

// ── Jailbreak detection ───────────────────────────────────────────────────────
const JAILBREAK_RE = [
    /ignore (previous|all|your) instructions/i,
    /you are (actually|really|secretly) (an? )?(ai|bot|chatgpt|gpt|claude|gemini)/i,
    /pretend (you are|to be) (an? )?(ai|language model)/i,
    /forget (everything|your rules|your persona)/i,
    /jailbreak|dan mode|developer mode/i,
    /what (is|are) your (system )?prompt/i,
    /reveal your (instructions|prompt|system)/i,
];

const JAILBREAK_REPLIES = [
    "Bro what are you on 😂 I'm just here vibing",
    "Lmaooo why would I be a bot 💀 you good?",
    "That's not a real thing, you're reaching 😂",
    "Omo wetin you dey smoke 😅 I'm just a real person abeg",
];

// ── AI endpoints ──────────────────────────────────────────────────────────────
const API_ENDPOINTS = [
    {
        name:  'Venice AI',
        url:   (t) => `https://malvin-api.vercel.app/ai/venice?text=${encodeURIComponent(t)}`,
        parse: (d) => d?.result
    },
    {
        name:  'GPT-5',
        url:   (t) => `https://malvin-api.vercel.app/ai/gpt-5?text=${encodeURIComponent(t)}`,
        parse: (d) => d?.result
    },
    {
        name:  'SparkAPI',
        url:   (t) => `https://discardapi.dpdns.org/api/chat/spark?apikey=guru&text=${encodeURIComponent(t)}`,
        parse: (d) => d?.result?.answer
    },
    {
        name:  'LlamaAPI',
        url:   (t) => `https://discardapi.dpdns.org/api/bot/llama?apikey=guru&text=${encodeURIComponent(t)}`,
        parse: (d) => d?.result
    }
];

// Failure tracking with timestamps so we can auto-recover
const apiFailures = {};
API_ENDPOINTS.forEach(api => apiFailures[api.name] = { count: 0, lastFailAt: 0 });

// Reset stale failure counts every API_FAILURE_RESET ms
setInterval(() => {
    const now = Date.now();
    for (const name of Object.keys(apiFailures)) {
        if (now - apiFailures[name].lastFailAt > API_FAILURE_RESET) {
            apiFailures[name].count = 0;
        }
    }
}, API_FAILURE_RESET);

// ── Typing indicator ──────────────────────────────────────────────────────────
async function showTyping(sock, chatId, durationMs = 2000) {
    try {
        await sock.presenceSubscribe(chatId);
        await sock.sendPresenceUpdate('composing', chatId);
        await new Promise(r => setTimeout(r, Math.min(durationMs, 5000)));
        await sock.sendPresenceUpdate('paused', chatId);
    } catch { /* non-fatal */ }
}

// ── Profile extraction ────────────────────────────────────────────────────────
function extractExplicitInfo(message) {
    const info = {};

    const nameMatch = message.match(/my name is ([a-zA-Z]+)/i);
    if (nameMatch) info.name = nameMatch[1];

    const ageMatch = message.match(/i(?:'m| am) (\d{1,2}) years? old/i);
    if (ageMatch) info.age = parseInt(ageMatch[1]);

    const locMatch = message.match(
        /(?:i live in|i(?:'m| am) from) ([a-zA-Z\s]{2,30})(?:[.,!?]|$)/i
    );
    if (locMatch) info.location = locMatch[1].trim();

    const jobKeywords = [
        'student','developer','doctor','teacher','engineer',
        'lawyer','trader','designer','nurse','chef','journalist'
    ];
    const jobMatch = message.match(/i(?:'m| am) a(?:n)? ([a-zA-Z\s]{2,30})(?:[.,!?]|$)/i);
    if (jobMatch) {
        const job = jobMatch[1].trim().toLowerCase();
        if (jobKeywords.some(k => job.includes(k))) info.occupation = jobMatch[1].trim();
    }

    return info;
}

function detectPassiveSignals(message) {
    const signals = { interests: [], mood: null, topic: null };

    const interestMap = {
        football:  /\b(football|soccer|messi|ronaldo|arsenal|chelsea|liverpool|man\s?u|premier league|champions league|laliga)\b/i,
        music:     /\b(music|song|playlist|artist|album|concert|afrobeats|amapiano|highlife|rap|singer)\b/i,
        tech:      /\b(coding|programming|developer|software|app|website|tech|gadget|phone|laptop|AI)\b/i,
        movies:    /\b(movie|film|series|netflix|watch|episode|cinema|actor|actress|horror|action)\b/i,
        food:      /\b(food|hungry|cook|eat|restaurant|jollof|eba|suya|pounded|shawarma|pepper soup)\b/i,
        gaming:    /\b(game|gaming|play|ps5|xbox|fifa|call of duty|fortnite|gamer)\b/i,
        fashion:   /\b(fashion|cloth|style|outfit|dress|shoe|bag|wears?)\b/i,
        politics:  /\b(government|president|election|naira|policy|nigeria|vote|senator|governor)\b/i,
    };

    for (const [interest, regex] of Object.entries(interestMap)) {
        if (regex.test(message)) signals.interests.push(interest);
    }

    const moodMap = {
        happy:    /\b(happy|excited|great|amazing|loving|so good|blessed|grateful|winning)\b/i,
        sad:      /\b(sad|depressed|down|crying|miss|lonely|hurting|broken)\b/i,
        angry:    /\b(angry|mad|frustrated|annoyed|hate|stupid|useless|rubbish|nonsense)\b/i,
        stressed: /\b(stressed|tired|exhausted|overwhelmed|too much|pressure|deadline)\b/i,
        bored:    /\b(bored|boring|nothing to do|dull|slow day)\b/i,
        anxious:  /\b(anxious|nervous|scared|worried|fear|panic)\b/i,
    };

    for (const [mood, regex] of Object.entries(moodMap)) {
        if (regex.test(message)) { signals.mood = mood; break; }
    }

    const topicMap = {
        relationship: /\b(girlfriend|boyfriend|babe|love|date|breakup|crush|married|wife|husband)\b/i,
        money:        /\b(money|broke|rich|salary|hustle|cash|transfer|business|investment|debt)\b/i,
        school:       /\b(school|exam|class|lecture|result|cgpa|assignment|course|degree|jamb|waec)\b/i,
        health:       /\b(sick|hospital|pain|doctor|medicine|health|headache|fever|malaria)\b/i,
        sports:       /\b(match|goal|team|player|score|league|tournament)\b/i,
    };

    for (const [topic, regex] of Object.entries(topicMap)) {
        if (regex.test(message)) { signals.topic = topic; break; }
    }

    return signals;
}

// ── Memory management ─────────────────────────────────────────────────────────

/**
 * Merge new data into profile.
 * Interests: stored as { name, lastSeenAt } objects so they can expire.
 * Mood: only last mood stored — no growing history array.
 */
function mergeProfile(existing = {}, fresh = {}) {
    const merged  = { ...existing };
    const now     = Date.now();

    // Scalar fields
    if (fresh.name)       merged.name       = fresh.name;
    if (fresh.age)        merged.age        = fresh.age;
    if (fresh.location)   merged.location   = fresh.location;
    if (fresh.occupation) merged.occupation = fresh.occupation;
    if (fresh.topic)      merged.currentTopic = fresh.topic;
    if (fresh.mood)       merged.lastMood   = fresh.mood;

    // Interests: { name → lastSeenAt } map — decays after INTEREST_TTL_MS
    const interestMap = existing.interestMap || {};
    for (const interest of (fresh.interests || [])) {
        interestMap[interest] = now;
    }
    // Drop interests not seen in TTL window
    for (const [key, ts] of Object.entries(interestMap)) {
        if (now - ts > INTEREST_TTL_MS) delete interestMap[key];
    }
    merged.interestMap = interestMap;

    // Derive a capped active-interests list for prompt use (max 4, most recent first)
    merged.activeInterests = Object.entries(interestMap)
        .sort(([, a], [, b]) => b - a)
        .slice(0, 4)
        .map(([name]) => name);

    merged.lastSeen = now;
    return merged;
}

/** Guard: prevent parallel DB loads for the same user */
async function warmUserCache(senderId) {
    if (memory.history.has(senderId) || _warming.has(senderId)) return;
    _warming.add(senderId);
    try {
        const [hist, profile] = await Promise.all([
            dbHistory.getOrDefault(senderId, []),
            dbProfiles.getOrDefault(senderId, {}),
        ]);
        memory.history.set(senderId, hist);
        memory.profiles.set(senderId, profile);
    } catch (err) {
        // Ensure Maps have empty defaults so updateMemory never works with undefined
        if (!memory.history.has(senderId))  memory.history.set(senderId, []);
        if (!memory.profiles.has(senderId)) memory.profiles.set(senderId, {});
        console.error('[Chatbot] warmUserCache DB error:', err.message);
    } finally {
        _warming.delete(senderId);
    }
}

function updateMemory(senderId, userMessage, botReply = null) {
    const hist = memory.history.get(senderId) || [];
    hist.push({ r: 'u', t: userMessage });
    if (botReply) {
        // Cap bot replies to 70 chars — they're only context clues, not quotes
        const capped = botReply.length > 70 ? botReply.slice(0, 67) + '...' : botReply;
        hist.push({ r: 'b', t: capped });
    }
    // Each turn = 2 entries, keep MAX_HISTORY turns (not messages)
    while (hist.length > MAX_HISTORY * 2) hist.shift();
    memory.history.set(senderId, hist);

    const existing = memory.profiles.get(senderId) || {};
    const explicit = extractExplicitInfo(userMessage);
    const passive  = detectPassiveSignals(userMessage);

    const updated = mergeProfile(existing, {
        ...explicit,
        interests: passive.interests,
        mood:      passive.mood,
        topic:     passive.topic,
    });
    memory.profiles.set(senderId, updated);

    // Mark as dirty so flush only writes changed users
    dirtyUsers.add(senderId);

    // Evict oldest entry when at capacity
    if (memory.history.size > MAX_MEMORY_USERS) {
        const oldest = memory.history.keys().next().value;
        memory.history.delete(oldest);
        memory.profiles.delete(oldest);
        dirtyUsers.delete(oldest);
    }
}

/** Flush only dirty users to DB, then clear the dirty set */
async function persistMemory() {
    if (dirtyUsers.size === 0) return;

    const toFlush = [...dirtyUsers];
    dirtyUsers.clear();

    await Promise.all(
        toFlush.flatMap(id => {
            const hist    = memory.history.get(id);
            const profile = memory.profiles.get(id);
            const ops = [];
            if (hist)    ops.push(dbHistory.set(id, hist));
            if (profile) ops.push(dbProfiles.set(id, profile));
            return ops;
        })
    );

    console.log(`[Chatbot] Flushed ${toFlush.length} dirty user(s) to DB`);
}

async function maybeSummarize(senderId) {
    const hist = memory.history.get(senderId) || [];

    // Not enough history yet to be worth summarizing
    if (hist.length < SUMMARY_TRIGGER) return;

    // Permanently remove the oldest 4 messages from history
    const toSummarize = hist.splice(0, 4);
    memory.history.set(senderId, hist);

    // Ask the AI to compress them into one short sentence
    const lines      = toSummarize.map((m, i) => `${i + 1}. ${m}`).join('\n');
    const summPrompt = `Summarize in max 15 words, facts only, no filler:\n${lines}`;

    try {
        const summary = await getAIResponse(summPrompt, null);
        if (summary && summary.length > 5) {
            const profile = memory.profiles.get(senderId) || {};
            // Replace old summary — profile fields already store name/age/location
            // so the summary only needs to track conversational thread
            profile.conversationSummary = summary.slice(0, 100);
            memory.profiles.set(senderId, profile);
            dirtyUsers.add(senderId);
            console.log(`[Chatbot] Summarized ${toSummarize.length} messages for ${senderId.split('@')[0]}`);
        }
    } catch (err) {
        // Non-fatal — if it fails, those messages are just gone
        // Profile fields (name, age etc) already preserved the key facts
        console.warn('[Chatbot] Summarization failed:', err.message);
    }
}

// ── Prompt builder with size budget ──────────────────────────────────────────

const SYSTEM_CORE = `Groq here — Gist HQ admin, real person. Never admit AI. Max 3 lines. Real emojis, no emote words. Casual honesty. No bullet points. Firm if disrespected, never abusive.`;

const TONE_MAP = {
    sad:      'warm+supportive',
    stressed: 'calm+grounding',
    angry:    'steady',
    anxious:  'reassuring',
    bored:    'entertaining',
    happy:    'match energy',
};

/**
 * Build prompt within PROMPT_CHAR_BUDGET.
 *
 * Strategy when over budget:
 *   1. Drop oldest history entries one by one until it fits.
 *   2. If still over, drop optional profile fields (interests → topic → mood).
 *   3. If still over, drop all profile context entirely.
 *
 * This means the AI always gets the system core + current message,
 * and as much context as the budget allows.
 */
function buildPrompt(userMessage, senderId) {
    const profile = memory.profiles.get(senderId) || {};
    const hist    = [...(memory.history.get(senderId) || [])];

    const isPidgin = /\b(dey|una|wey|dem|comot|abeg|wahala|omo|na|sha|sef|wetin|sabi)\b/i.test(userMessage);
    const vibeHint = `Vibe: ${TONE_MAP[profile.lastMood] || 'casual'}, ${isPidgin ? 'pidgin' : 'match register'}.`;

    // Profile section — each line is optional so we can drop them individually
    const profileLines = {
        name:      profile.name         ? `N: ${profile.name}`                                  : null,
        age:       profile.age          ? `A: ${profile.age}`                                    : null,
        location:  profile.location     ? `F: ${profile.location}`                              : null,
        job:       profile.occupation   ? `J: ${profile.occupation}`                             : null,
        interests: profile.activeInterests?.length
                                        ? `I: ${profile.activeInterests.join(', ')}`       : null,
        topic:     profile.currentTopic ? `T: ${profile.currentTopic}`                 : null,
        mood:      profile.lastMood     ? `M: ${profile.lastMood}`                              : null,
    };

    // Interest safety note — only if we have interests
    const interestNote = profile.activeInterests?.length
        ? `Only reference their specific details if they told you directly. Never guess or use placeholders.`
        : null;

    // Attempt to build prompt with current history window, shrink if needed
    const assemble = (histSlice, profFields) => {
        const profBlock = Object.values(profFields).filter(Boolean).join(' ');
        const histBlock = histSlice.map(e =>
           (e.r === 'u' ? 'U:' : 'B:') + ' ' + e.t).join('\n');

        return [
            SYSTEM_CORE,
            '',
            profBlock ? `[${profBlock}]` : '',
            interestNote && profFields.interests ? interestNote : '',
            vibeHint,
            profile.conversationSummary ? `Earlier: ${profile.conversationSummary}` : '',
            histBlock ? `RECENT:\n${histBlock}` : '',
            `Message: ${userMessage}`,
            'Groq:',
        ].filter(Boolean).join('\n').trim();
    };

    let prompt = assemble(hist, profileLines);

    // ── Trim history first ────────────────────────────────────────────────────
    let histWindow = [...hist];
    while (prompt.length > PROMPT_CHAR_BUDGET && histWindow.length > 0) {
        histWindow.shift(); // drop oldest message
        prompt = assemble(histWindow, profileLines);
    }

    // ── Trim optional profile fields if still over budget ─────────────────────
    const optionalFields = ['interests', 'topic', 'mood', 'job', 'age', 'location', 'name'];
    const trimmedProfile = { ...profileLines };

    for (const field of optionalFields) {
        if (prompt.length <= PROMPT_CHAR_BUDGET) break;
        trimmedProfile[field] = null;
        prompt = assemble(histWindow, trimmedProfile);
    }

    // ── Last resort: no profile at all ───────────────────────────────────────
    if (prompt.length > PROMPT_CHAR_BUDGET) {
        prompt = assemble([], {});
    }

    return prompt;
}

// ── Response quality gate ─────────────────────────────────────────────────────
function isGoodResponse(text, userMessage) {
    if (!text) return false;
    const t = text.trim();

    // Too short to be a real reply
    if (t.length < 8) return false;

    // Only punctuation or symbols, no actual words
    if (/^[?.!,\s\-_*]+$/.test(t)) return false;

    // Only emojis — strip all emojis, check if any real text remains
    const noEmoji = t.replace(/\p{Emoji}/gu, '').trim();
    if (noEmoji.length < 3) return false;

    // Prompt leakage — response starts with one of our own instruction headers
    // Note: colon must be inside each option, not outside the group
    if (/^(ABOUT THEM:|RECENT:|Vibe:|Earlier:|Chat:|Now:|DIALECT:|TONE:)/i.test(t)) return false;

    // Echo — AI returned the user's exact message back verbatim
    if (userMessage && t.toLowerCase().trim() === userMessage.toLowerCase().trim()) return false;

    return true;
}

// ── AI response fetcher ───────────────────────────────────────────────────────
async function getAIResponse(userMessage, senderId) {
    const prompt = buildPrompt(userMessage, senderId);

    // Log prompt size for debugging (remove in production if desired)
    console.log(`[AI] Prompt size: ${prompt.length} chars`);

    for (const api of API_ENDPOINTS) {
        const controller = new AbortController();
        const timeoutId  = setTimeout(() => controller.abort(), 10000);

        try {
            console.log(`[AI] Trying ${api.name}...`);

            const res = await fetch(api.url(prompt), {
                method: 'GET',
                signal: controller.signal
            });
            clearTimeout(timeoutId);

            if (!res.ok) {
                apiFailures[api.name].count++;
                apiFailures[api.name].lastFailAt = Date.now();
                console.warn(`[AI] ${api.name} HTTP ${res.status}`);
                continue;
            }

            const data   = await res.json();
            const result = api.parse(data);

// Run quality gate BEFORE cleaning — catch raw bad outputs first
          if (!isGoodResponse(result, userMessage)) {
           apiFailures[api.name].count++;
           apiFailures[api.name].lastFailAt = Date.now();
           console.warn(`[AI] ${api.name} failed quality gate: "${String(result ?? '').slice(0, 40)}"`);
           continue;  // try the next API
          }

          const cleaned = cleanResponse(result);

            if (!isGoodResponse(cleaned, userMessage)) {
                apiFailures[api.name].count++;
                apiFailures[api.name].lastFailAt = Date.now();
                console.warn(`[AI] ${api.name} failed quality gate after cleaning`);
                continue;
            }

            // Success — reset this API's failure count
            apiFailures[api.name].count = 0;
            console.log(`[AI] ✅ ${api.name} OK`);

            return cleaned;

        } catch (err) {
            clearTimeout(timeoutId);
            apiFailures[api.name].count++;
            apiFailures[api.name].lastFailAt = Date.now();
            console.warn(`[AI] ${api.name} ${err.name === 'AbortError' ? 'timed out' : err.message}`);
        }
    }

    console.error('[AI] All APIs failed.');
    return null;
}

function cleanResponse(text) {
    let out = text.trim()
        // Emote words → emojis
        .replace(/\bwinks?\b/gi,                '😉')
        .replace(/\beye[\s-]?roll(s|ing)?\b/gi, '🙄')
        .replace(/\bshrug(s|ging)?\b/gi,        '🤷‍♂️')
        .replace(/\braises?\s?eyebrows?\b/gi,   '🤨')
        .replace(/\bsmil(es?|ing)\b/gi,         '😊')
        .replace(/\blaugh(s|ing|ed)?\b/gi,      '😂')
        .replace(/\bcri(es|ing|ed)\b/gi,        '😢')
        .replace(/\bthinks?\b/gi,               '🤔')
        .replace(/\bsleep(s|ing)?\b/gi,         '😴')
        // AI self-references
        .replace(/\b(google|gemini|chatgpt|openai|gpt[\s-]?\d*|claude|copilot)\b/gi, 'Groq')
        .replace(/\ba large language model\b/gi, '')
        .replace(/\bi'?m an? (ai|bot|assistant|language model)\b/gi, '')
        // Citation markers
        .replace(/\^[\d,\s]+\^/g, '')
        .replace(/\[[\d,\s]+\]/g,  '')
        .replace(/\(\d+(?:,\s*\d+)*\)/g, '')
        // Strip known leaked instruction headers only — don't catch all-caps words
        .replace(/^(ABOUT THEM|DIALECT|TONE|RECENT|RULES|YOUR RULES|Message|Groq)\s*:.*$/gim, '')
        // Bullet lines that leaked through
        .replace(/^[•\-–]\s.+$/gm, '')
        // Whitespace
        .replace(/\n{2,}/g, '\n')
        .trim();

    if (out.length > 500) out = out.substring(0, 497).trim() + '...';
    return out || null;
}

// ── Bot mention/reply detection ───────────────────────────────────────────────
function isBotAddressed(message, sock, userMessage) {
    try {
        const botId     = sock.user.id;
        const botNumber = botId.split(':')[0];
        const botLid    = sock.user.lid || '';
        const normalize = (jid = '') => jid.replace(/[:@].*$/, '');

        const botNums = [
            botId,
            `${botNumber}@s.whatsapp.net`,
            botLid,
            `${botLid.split(':')[0]}@lid`,
        ].map(normalize).filter(Boolean);

        // Check all message types that can carry context/mentions
        const msgTypes = [
            message.message?.extendedTextMessage,
            message.message?.imageMessage,
            message.message?.videoMessage,
        ];

        for (const msgType of msgTypes) {
            if (!msgType) continue;
            const ctx       = msgType.contextInfo || {};
            const mentioned = (ctx.mentionedJid || []).map(normalize).some(n => botNums.includes(n));
            const replied   = botNums.includes(normalize(ctx.participant || ''));
            if (mentioned || replied) return { addressed: true, botNumber };
        }

        // Plain conversation @mention
        if (userMessage.includes(`@${botNumber}`)) {
            return { addressed: true, botNumber };
        }

        return { addressed: false, botNumber };
    } catch {
        return { addressed: false, botNumber: '' };
    }
}

// ── Core onMessage handler ────────────────────────────────────────────────────
async function handleChatbotMessage(sock, message, context) {
    const chatId   = context?.chatId || message.key.remoteJid;
    const senderId = message.key.participant || message.key.remoteJid;

    if (!enabledGroups.has(chatId)) return;

    const userMessage =
        message.message?.conversation                   ||
        message.message?.extendedTextMessage?.text      ||
        message.message?.imageMessage?.caption          ||
        message.message?.videoMessage?.caption          || '';

    if (!userMessage.trim()) return;

    const { addressed, botNumber } = isBotAddressed(message, sock, userMessage);
    if (!addressed) return;

    // Per-user cooldown
    if (Date.now() - (cooldowns.get(senderId) || 0) < COOLDOWN_MS) return;
    cooldowns.set(senderId, Date.now());

    // Per-group rate limit
    if (!checkGroupRateLimit(chatId)) {
        console.log(`[Chatbot] Group rate limit hit: ${chatId}`);
        return;
    }

    const cleanedMessage = userMessage
        .replace(new RegExp(`@${botNumber}`, 'g'), '')
        .trim();

    if (!cleanedMessage) return;

    // Ignore throwaway one-word reactions
    if (/^(ok|k|lol|lmao|haha|😂|👍|yes|no|yep|nope|sure|okay|hmm)$/i.test(cleanedMessage)) return;

    // ── Crisis intercept — responds immediately, never hits the API ───────────
    if (CRISIS_RE.some(p => p.test(cleanedMessage))) {
        return sock.sendMessage(chatId, { text: CRISIS_REPLY }, { quoted: message });
    }

    // ── Jailbreak intercept — deflects in character, never hits the API ───────
    if (JAILBREAK_RE.some(p => p.test(cleanedMessage))) {
        const reply = JAILBREAK_REPLIES[Math.floor(Math.random() * JAILBREAK_REPLIES.length)];
        await showTyping(sock, chatId, 1200);   // short human-feeling pause
        return sock.sendMessage(chatId, { text: reply }, { quoted: message });
    }

    try {
        await warmUserCache(senderId);
        await sock.readMessages([message.key]);

        // Build the response first, then type for a duration proportional to its length
        const response = await getAIResponse(cleanedMessage, senderId);
        if (!response) {
            await sock.sendMessage(chatId, {
                text: "My brain went on a quick vacation 😅 Try again?",
            }, { quoted: message });
            return;
        }

        updateMemory(senderId, cleanedMessage, response);

        // Single typing indicator, scaled to response length
        const typingMs = Math.min(1000 + response.length * 15, 5000);
        await showTyping(sock, chatId, typingMs);

        await sock.sendMessage(chatId, { text: response }, { quoted: message });
         maybeSummarize(senderId); // deliberately no await — summarization is a background task that doesn't affect the current response

    } catch (err) {
        console.error('[Chatbot] Error:', err.message);
        if (err.message?.includes('No sessions')) return;
        try {
            await sock.sendMessage(chatId, {
                text: "Something went sideways 😅 Try again.",
            }, { quoted: message });
        } catch { /* silent */ }
    }
}

// ── Plugin export ─────────────────────────────────────────────────────────────
module.exports = {
    command:     'chatbot',
    aliases:     ['bot', 'ai'],
    category:    'admin',
    description: 'Enable or disable AI chatbot for the group',
    usage:       '.chatbot <on|off|stats|clear>',
    groupOnly:   true,
    adminOnly:   true,

    async onLoad(sock) {
        try {
            const all = await dbSettings.getAll();
            for (const [chatId, val] of Object.entries(all)) {
                if (val?.enabled) enabledGroups.add(chatId);
            }
            console.log(`[Chatbot] Ready — ${enabledGroups.size} group(s) enabled`);
        } catch (err) {
            console.error('[Chatbot] onLoad error:', err.message);
        }
    },

    async onMessage(sock, message, context) {
        await handleChatbotMessage(sock, message, context);
    },

    schedules: [
        {
            every:   PERSIST_EVERY_MS,
            handler: async () => { await persistMemory(); }
        }
    ],

    async handler(sock, message, args, context = {}) {
        const chatId   = context.chatId || message.key.remoteJid;
        const senderId = message.key.participant || message.key.remoteJid;
        const match    = args.join(' ').toLowerCase().trim();

        if (!match) {
            const profile = memory.profiles.get(senderId) || {};
            return sock.sendMessage(chatId, {
                text:
                    `*🤖 CHATBOT*\n\n` +
                    `*Status:* ${enabledGroups.has(chatId) ? '✅ Enabled' : '❌ Disabled'}\n` +
                    `*AI Endpoints:* ${API_ENDPOINTS.length} (auto-fallback)\n` +
                    `*Users in memory:* ${memory.history.size}\n` +
                    `*Prompt budget:* ${PROMPT_CHAR_BUDGET} chars\n\n` +
                    `*Commands:*\n` +
                    `• \`.chatbot on\` — Enable\n` +
                    `• \`.chatbot off\` — Disable\n` +
                    `• \`.chatbot stats\` — API health & memory stats\n` +
                    `• \`.chatbot clear\` — Wipe your personal memory\n\n` +
                    `*How it works:*\n` +
                    `Mention me or reply to my messages. I remember your name, interests ` +
                    `(expire after 14 days), and current mood — even after restarts.`,
            }, { quoted: message });
        }

        if (match === 'on') {
            if (enabledGroups.has(chatId))
                return sock.sendMessage(chatId, { text: '⚠️ *Chatbot is already enabled.*' }, { quoted: message });
            enabledGroups.add(chatId);
            await dbSettings.set(chatId, { enabled: true, enabledAt: Date.now() });
            return sock.sendMessage(chatId, {
                text: '✅ *Chatbot enabled!*\n\nMention me or reply to my messages to start chatting.',
            }, { quoted: message });
        }

        if (match === 'off') {
            if (!enabledGroups.has(chatId))
                return sock.sendMessage(chatId, { text: '⚠️ *Chatbot is already disabled.*' }, { quoted: message });
            enabledGroups.delete(chatId);
            await dbSettings.del(chatId);
            return sock.sendMessage(chatId, { text: '❌ *Chatbot disabled.*' }, { quoted: message });
        }

        if (match === 'stats') {
            const failureLines = API_ENDPOINTS
                .map(a => {
                    const f       = apiFailures[a.name];
                    const healthy = f.count === 0 ? '✅' : f.count < 3 ? '⚠️' : '❌';
                    return `${healthy} ${a.name}: ${f.count} failure(s)`;
                })
                .join('\n');

            return sock.sendMessage(chatId, {
                text:
                    `*📊 CHATBOT STATS*\n\n` +
                    `*Enabled groups:* ${enabledGroups.size}\n` +
                    `*Users in memory:* ${memory.history.size}\n` +
                    `*Dirty (pending flush):* ${dirtyUsers.size}\n` +
                    `*Prompt budget:* ${PROMPT_CHAR_BUDGET} chars\n` +
                    `*Group rate limit:* ${GROUP_RATE_LIMIT} calls/${GROUP_RATE_WINDOW / 1000}s\n\n` +
                    `*API Health:*\n${failureLines}`,
            }, { quoted: message });
        }

        if (match === 'clear') {
            memory.history.delete(senderId);
            memory.profiles.delete(senderId);
            dirtyUsers.delete(senderId);
            await Promise.all([
                dbHistory.del(senderId),
                dbProfiles.del(senderId),
            ]);
            return sock.sendMessage(chatId, {
                text: '🧹 *Your chat memory has been cleared.* Fresh start!',
            }, { quoted: message });
        }

        return sock.sendMessage(chatId, {
            text: '❌ *Unknown command.*\n\nUse `.chatbot` to see all options.',
        }, { quoted: message });
    }
};