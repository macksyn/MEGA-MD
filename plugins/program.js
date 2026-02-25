'use strict';

/**
 * plugins/scheduler.js
 *
 * Group Event Scheduler with RSVP & Auto-Reminders
 * ─────────────────────────────────────────────────
 * Features:
 *   • Create / list / cancel / delete group events
 *   • RSVP (+ / − attendance) per user
 *   • Auto-reminders at configurable lead times (default: 60 min & 10 min before)
 *   • Fires an "event started" ping at the exact start time
 *   • Per-group settings (reminder offsets, timezone override)
 *   • Persistence via pluginStore — works with MongoDB, PostgreSQL,
 *     MySQL, SQLite, or plain JSON files — zero config needed
 *
 * Commands:
 *   .event                        — help / menu
 *   .event create <title> | <datetime> | [description]
 *   .event list                   — upcoming events in this group
 *   .event info <id>              — full event details
 *   .event rsvp <id>              — confirm your attendance
 *   .event unrsvp <id>            — withdraw your RSVP
 *   .event attendees <id>         — show who's coming (admin or any member)
 *   .event cancel <id>            — mark event cancelled  [admin]
 *   .event delete <id>            — permanently remove event [admin]
 *   .event reminder <id> <mins>   — change reminder offset  [admin]
 *   .event settings               — show / change group reminder defaults [admin]
 *
 * Date-time formats accepted (bot's configured timezone):
 *   "25/12/2025 18:00"
 *   "2025-12-25 18:00"
 *   "December 25 2025 6pm"
 *   "tomorrow 9am"
 *   "next friday 3pm"
 */

const moment = require('moment-timezone');
const { createStore }    = require('../lib/pluginStore');
const isAdmin            = require('../lib/isAdmin');
const isOwnerOrSudo      = require('../lib/isOwner');
const { printLog }       = require('../lib/print');
const settings           = require('../settings');

// ── Storage ───────────────────────────────────────────────────────────────────
const db         = createStore('scheduler');
const dbEvents   = db.table('events');    // key: eventId   → EventRecord
const dbRsvps    = db.table('rsvps');     // key: eventId   → { userId: timestamp, … }
const dbGrpCfg   = db.table('groupcfg'); // key: groupId   → GroupConfig

// ── Defaults ──────────────────────────────────────────────────────────────────
const DEFAULT_REMINDERS = [60, 10]; // minutes before event
const MAX_EVENTS_PER_GROUP = 20;    // hard ceiling to prevent runaway storage
const ID_LENGTH = 6;                // short hex IDs shown to users

// ── In-memory caches updated on every schedule tick ──────────────────────────
// Avoids hammering the DB on every 1-min tick
const _eventCache   = new Map();  // eventId → EventRecord
const _notifiedMap  = new Map();  // eventId → Set of minutes-offsets already fired
let   _cacheLoadedAt = 0;
const CACHE_TTL_MS = 5 * 60_000;  // reload cache from DB every 5 minutes

// ── Timezone helper ───────────────────────────────────────────────────────────
function tz(groupId) {
    return settings.timeZone || 'Africa/Lagos';
}

function nowMoment(groupId) {
    return moment.tz(tz(groupId));
}

// ── ID generator ──────────────────────────────────────────────────────────────
function makeId() {
    return Math.random().toString(16).slice(2, 2 + ID_LENGTH).toUpperCase();
}

// ── Date parser ───────────────────────────────────────────────────────────────
const DATE_FORMATS = [
    'DD/MM/YYYY HH:mm',
    'DD/MM/YYYY h:mma',
    'YYYY-MM-DD HH:mm',
    'YYYY-MM-DD h:mma',
    'D MMMM YYYY HH:mm',
    'D MMMM YYYY h:mma',
    'MMMM D YYYY HH:mm',
    'MMMM D YYYY h:mma',
    'DD/MM/YYYY',
    'YYYY-MM-DD',
];

function parseDateTime(raw, groupId) {
    const str = raw.trim();
    const zone = tz(groupId);

    // Relative shorthands
    const lc = str.toLowerCase();
    let base = nowMoment(groupId);

    const relMatch = lc.match(
        /^(today|tomorrow|next\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday))\s+(\d{1,2}(?::\d{2})?\s*(?:am|pm)?|\d{2}:\d{2})/i
    );

    if (relMatch) {
        const dayPart  = relMatch[1];
        const timePart = relMatch[3];

        if (dayPart === 'tomorrow') {
            base = base.add(1, 'day');
        } else if (dayPart !== 'today') {
            const target = relMatch[2];
            const days   = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'];
            const targetIdx = days.indexOf(target.trim().toLowerCase());
            const nowIdx    = base.day();
            let diff = (targetIdx - nowIdx + 7) % 7;
            if (diff === 0) diff = 7; // "next X" always means the *next* occurrence
            base = base.add(diff, 'days');
        }

        const parsed = moment.tz(`${base.format('YYYY-MM-DD')} ${timePart.trim()}`, [
            'YYYY-MM-DD HH:mm',
            'YYYY-MM-DD h:mma',
            'YYYY-MM-DD ha',
        ], zone);

        return parsed.isValid() ? parsed : null;
    }

    // Absolute date strings
    for (const fmt of DATE_FORMATS) {
        const m = moment.tz(str, fmt, true, zone);
        if (m.isValid()) return m;
    }

    // Last resort: moment natural parsing
    const fallback = moment.tz(str, zone);
    return fallback.isValid() ? fallback : null;
}

// ── Group config helpers ──────────────────────────────────────────────────────
async function getGroupConfig(groupId) {
    const cfg = await dbGrpCfg.getOrDefault(groupId, {});
    return {
        reminders: cfg.reminders ?? [...DEFAULT_REMINDERS],
        ...cfg
    };
}

// ── Event CRUD ────────────────────────────────────────────────────────────────
async function createEvent({ groupId, creatorId, title, startAt, description }) {
    const allEvents = await dbEvents.getAll();

    // Enforce per-group cap
    const groupEvents = Object.values(allEvents).filter(
        e => e.groupId === groupId && e.status === 'upcoming'
    );
    if (groupEvents.length >= MAX_EVENTS_PER_GROUP) {
        return { ok: false, reason: `Maximum ${MAX_EVENTS_PER_GROUP} upcoming events per group reached.` };
    }

    const cfg = await getGroupConfig(groupId);
    const id  = makeId();

    const event = {
        id,
        groupId,
        creatorId,
        title:       title.trim(),
        description: description?.trim() || '',
        startAt:     startAt.toISOString(),
        status:      'upcoming',    // upcoming | cancelled | done
        createdAt:   new Date().toISOString(),
        reminders:   [...cfg.reminders],  // minutes-before list
    };

    await dbEvents.set(id, event);
    await dbRsvps.set(id, {});          // empty RSVP map
    _eventCache.set(id, event);

    return { ok: true, event };
}

async function getEvent(id) {
    // Cache-first
    if (_eventCache.has(id)) return _eventCache.get(id);
    const ev = await dbEvents.get(id);
    if (ev) _eventCache.set(id, ev);
    return ev;
}

async function listGroupEvents(groupId, status = 'upcoming') {
    const all = await dbEvents.getAll();
    return Object.values(all)
        .filter(e => e.groupId === groupId && e.status === status)
        .sort((a, b) => new Date(a.startAt) - new Date(b.startAt));
}

async function updateEventStatus(id, status) {
    const ev = await getEvent(id);
    if (!ev) return false;
    const updated = { ...ev, status, updatedAt: new Date().toISOString() };
    await dbEvents.set(id, updated);
    _eventCache.set(id, updated);
    return true;
}

// ── RSVP helpers ──────────────────────────────────────────────────────────────
async function getRsvps(eventId) {
    return await dbRsvps.getOrDefault(eventId, {});
}

async function addRsvp(eventId, userId) {
    const rsvps = await getRsvps(eventId);
    rsvps[userId] = new Date().toISOString();
    await dbRsvps.set(eventId, rsvps);
    return Object.keys(rsvps).length;
}

async function removeRsvp(eventId, userId) {
    const rsvps = await getRsvps(eventId);
    if (!rsvps[userId]) return false;
    delete rsvps[userId];
    await dbRsvps.set(eventId, rsvps);
    return true;
}

// ── Formatting helpers ────────────────────────────────────────────────────────
function formatEventShort(ev, groupId) {
    const start = moment.tz(ev.startAt, tz(groupId));
    const diff  = start.diff(moment.tz(tz(groupId)));
    const rel   = diff > 0
        ? `in ${moment.duration(diff).humanize()}`
        : '(past)';

    return `📌 *[${ev.id}]* ${ev.title}\n` +
           `   🗓 ${start.format('ddd, D MMM YYYY [at] HH:mm')} — ${rel}`;
}

function formatEventFull(ev, rsvps, groupId) {
    const zone      = tz(groupId);
    const start     = moment.tz(ev.startAt, zone);
    const diffMs    = start.diff(moment.tz(zone));
    const countDown = diffMs > 0
        ? `in ${moment.duration(diffMs).humanize()}`
        : '(past)';

    const attendeeCount = Object.keys(rsvps).length;
    const statusIco = ev.status === 'upcoming'   ? '🟢'
                    : ev.status === 'cancelled'  ? '🔴'
                    : '✅';

    let text =
        `${statusIco} *EVENT DETAILS*\n\n` +
        `🆔 ID: \`${ev.id}\`\n` +
        `📣 Title: *${ev.title}*\n`;

    if (ev.description)
        text += `📝 Description: ${ev.description}\n`;

    text +=
        `🗓 When: ${start.format('dddd, D MMMM YYYY [at] HH:mm z')}\n` +
        `⏰ Countdown: ${countDown}\n` +
        `📊 Status: ${ev.status.toUpperCase()}\n` +
        `👥 RSVPs: ${attendeeCount}\n` +
        `🔔 Reminders: ${ev.reminders.map(r => `${r} min`).join(', ')}\n` +
        `👤 Created by: @${ev.creatorId.split('@')[0]}\n`;

    return text;
}

// ── Notification sender (used by both command handler & schedule) ─────────────
async function sendReminder(sock, ev, minutesBefore) {
    const groupId   = ev.groupId;
    const zone      = tz(groupId);
    const start     = moment.tz(ev.startAt, zone);
    const rsvps     = await getRsvps(ev.id);
    const mentions  = Object.keys(rsvps);

    let header, body;

    if (minutesBefore === 0) {
        header = `🎉 *EVENT STARTING NOW!*`;
        body   = `Get ready everyone! *${ev.title}* is starting right now!`;
    } else {
        header = `⏰ *EVENT REMINDER — ${minutesBefore} MIN*`;
        body   = `*${ev.title}* starts in ${minutesBefore} minutes!\n🗓 ${start.format('HH:mm')}`;
    }

    let text = `${header}\n\n${body}`;

    if (ev.description)
        text += `\n\n📝 ${ev.description}`;

    if (mentions.length) {
        const tags = mentions.map(id => `@${id.split('@')[0]}`).join(' ');
        text += `\n\n👥 RSVPs: ${tags}`;
    } else {
        text += `\n\n📌 No RSVPs yet — use *.event rsvp ${ev.id}* to join!`;
    }

    try {
        await sock.sendMessage(groupId, {
            text,
            mentions,
        });
        printLog('info', `[Scheduler] Reminder sent for event "${ev.title}" (${minutesBefore}min)`);
    } catch (err) {
        printLog('error', `[Scheduler] Failed to send reminder: ${err.message}`);
    }
}

// ── Schedule tick: runs every minute ─────────────────────────────────────────
async function scheduleTick(sock) {
    try {
        // Reload full cache from DB on TTL expiry
        if (Date.now() - _cacheLoadedAt > CACHE_TTL_MS) {
            const all = await dbEvents.getAll();
            for (const [id, ev] of Object.entries(all)) {
                _eventCache.set(id, ev);
            }
            _cacheLoadedAt = Date.now();
        }

        const nowMs = Date.now();

        for (const [id, ev] of _eventCache) {
            if (ev.status !== 'upcoming') continue;

            const startMs   = new Date(ev.startAt).getTime();
            const diffMins  = (startMs - nowMs) / 60_000;

            if (!_notifiedMap.has(id)) _notifiedMap.set(id, new Set());
            const fired = _notifiedMap.get(id);

            // Fire each configured reminder offset once
            for (const offset of ev.reminders) {
                if (!fired.has(offset) && diffMins <= offset && diffMins > offset - 1.5) {
                    fired.add(offset);
                    await sendReminder(sock, ev, offset);
                }
            }

            // Fire "starting now" once
            if (!fired.has(0) && diffMins <= 0 && diffMins > -1.5) {
                fired.add(0);
                await sendReminder(sock, ev, 0);
                await updateEventStatus(id, 'done');
                _eventCache.delete(id);
                _notifiedMap.delete(id);
            }

            // Auto-expire events more than 24 h in the past
            if (diffMins < -24 * 60) {
                await updateEventStatus(id, 'done');
                _eventCache.delete(id);
                _notifiedMap.delete(id);
            }
        }
    } catch (err) {
        printLog('error', `[Scheduler] Tick error: ${err.message}`);
    }
}

// ── Menu text ─────────────────────────────────────────────────────────────────
function menuText(prefix) {
    return (
        `📅 *GROUP EVENT SCHEDULER*\n\n` +
        `*Create & Manage Events:*\n` +
        `• *${prefix}event create <title> | <date time> | [description]*\n` +
        `• *${prefix}event list* — upcoming events\n` +
        `• *${prefix}event info <id>* — event details\n` +
        `• *${prefix}event cancel <id>* — cancel event _(admin)_\n` +
        `• *${prefix}event delete <id>* — delete event _(admin)_\n\n` +
        `*RSVP:*\n` +
        `• *${prefix}event rsvp <id>* — confirm attendance\n` +
        `• *${prefix}event unrsvp <id>* — withdraw attendance\n` +
        `• *${prefix}event attendees <id>* — see who's coming\n\n` +
        `*Settings _(admin)_:*\n` +
        `• *${prefix}event reminder <id> <mins>* — change reminder time\n` +
        `• *${prefix}event settings* — view/change group defaults\n\n` +
        `*Date formats:*\n` +
        `  25/12/2025 18:00 — DD/MM/YYYY HH:MM\n` +
        `  tomorrow 9am — relative\n` +
        `  next friday 3pm — relative\n`
    );
}

// ── Sub-command handlers ──────────────────────────────────────────────────────

async function cmdCreate(sock, message, args, context) {
    const { chatId, senderId, isSenderAdmin, senderIsOwnerOrSudo } = context;

    if (!isSenderAdmin && !senderIsOwnerOrSudo) {
        return sock.sendMessage(chatId, {
            text: '🚫 Only group admins can create events.',
        }, { quoted: message });
    }

    // Join args back and split on | separator
    const raw   = args.join(' ');
    const parts = raw.split('|').map(p => p.trim());

    if (parts.length < 2) {
        return sock.sendMessage(chatId, {
            text: `⚠️ Usage:\n*.event create <title> | <date & time> | [description]*\n\nExample:\n*.event create Town Hall | 25/12/2025 18:00 | Monthly meeting*`,
        }, { quoted: message });
    }

    const [title, dateRaw, description] = parts;

    const startAt = parseDateTime(dateRaw, chatId);
    if (!startAt) {
        return sock.sendMessage(chatId, {
            text: `❌ Could not parse date/time: *${dateRaw}*\n\nTry formats like:\n• 25/12/2025 18:00\n• tomorrow 9am\n• next friday 3pm`,
        }, { quoted: message });
    }

    if (startAt.isBefore(moment.tz(tz(chatId)))) {
        return sock.sendMessage(chatId, {
            text: '❌ The event date/time is in the past. Please pick a future date.',
        }, { quoted: message });
    }

    const result = await createEvent({
        groupId:     chatId,
        creatorId:   senderId,
        title,
        startAt,
        description,
    });

    if (!result.ok) {
        return sock.sendMessage(chatId, {
            text: `❌ ${result.reason}`,
        }, { quoted: message });
    }

    const ev     = result.event;
    const prefix = settings.prefixes[0];
    const zone   = tz(chatId);

    return sock.sendMessage(chatId, {
        text:
            `✅ *Event Created!*\n\n` +
            `📌 *${ev.title}*\n` +
            `🆔 ID: \`${ev.id}\`\n` +
            `🗓 ${startAt.format('dddd, D MMMM YYYY [at] HH:mm z')}\n` +
            `🔔 Reminders: ${ev.reminders.map(r => `${r} min before`).join(', ')}\n` +
            (ev.description ? `📝 ${ev.description}\n` : '') +
            `\n💡 Members can RSVP with *${prefix}event rsvp ${ev.id}*`,
        mentions: [senderId],
    }, { quoted: message });
}

async function cmdList(sock, message, args, context) {
    const { chatId } = context;
    const events = await listGroupEvents(chatId, 'upcoming');

    if (!events.length) {
        return sock.sendMessage(chatId, {
            text: `📭 No upcoming events in this group.\n\n💡 Admins can create one with *.event create*`,
        }, { quoted: message });
    }

    const lines = events.map(ev => formatEventShort(ev, chatId)).join('\n\n');

    return sock.sendMessage(chatId, {
        text: `📅 *UPCOMING EVENTS* (${events.length})\n\n${lines}\n\n💡 Use *.event info <id>* for full details`,
    }, { quoted: message });
}

async function cmdInfo(sock, message, args, context) {
    const { chatId } = context;
    const id = (args[0] || '').toUpperCase().trim();

    if (!id) {
        return sock.sendMessage(chatId, { text: '⚠️ Usage: *.event info <id>*' }, { quoted: message });
    }

    const ev = await getEvent(id);
    if (!ev || ev.groupId !== chatId) {
        return sock.sendMessage(chatId, { text: `❌ Event *${id}* not found in this group.` }, { quoted: message });
    }

    const rsvps = await getRsvps(id);
    const text  = formatEventFull(ev, rsvps, chatId);

    return sock.sendMessage(chatId, {
        text,
        mentions: [ev.creatorId],
    }, { quoted: message });
}

async function cmdRsvp(sock, message, args, context) {
    const { chatId, senderId } = context;
    const id = (args[0] || '').toUpperCase().trim();

    if (!id) {
        return sock.sendMessage(chatId, { text: '⚠️ Usage: *.event rsvp <id>*' }, { quoted: message });
    }

    const ev = await getEvent(id);
    if (!ev || ev.groupId !== chatId) {
        return sock.sendMessage(chatId, { text: `❌ Event *${id}* not found in this group.` }, { quoted: message });
    }

    if (ev.status !== 'upcoming') {
        return sock.sendMessage(chatId, { text: `❌ Cannot RSVP to a *${ev.status}* event.` }, { quoted: message });
    }

    const rsvps = await getRsvps(id);
    if (rsvps[senderId]) {
        return sock.sendMessage(chatId, {
            text: `ℹ️ You're already on the RSVP list for *${ev.title}*.`,
        }, { quoted: message });
    }

    const total = await addRsvp(id, senderId);
    const start = moment.tz(ev.startAt, tz(chatId));

    return sock.sendMessage(chatId, {
        text:
            `✅ *RSVP Confirmed!*\n\n` +
            `📌 ${ev.title}\n` +
            `🗓 ${start.format('D MMM YYYY [at] HH:mm')}\n` +
            `👥 Total attendees: ${total}`,
        mentions: [senderId],
    }, { quoted: message });
}

async function cmdUnrsvp(sock, message, args, context) {
    const { chatId, senderId } = context;
    const id = (args[0] || '').toUpperCase().trim();

    if (!id) {
        return sock.sendMessage(chatId, { text: '⚠️ Usage: *.event unrsvp <id>*' }, { quoted: message });
    }

    const ev = await getEvent(id);
    if (!ev || ev.groupId !== chatId) {
        return sock.sendMessage(chatId, { text: `❌ Event *${id}* not found in this group.` }, { quoted: message });
    }

    const removed = await removeRsvp(id, senderId);
    if (!removed) {
        return sock.sendMessage(chatId, {
            text: `ℹ️ You were not on the RSVP list for *${ev.title}*.`,
        }, { quoted: message });
    }

    return sock.sendMessage(chatId, {
        text: `❎ RSVP removed — you've been removed from *${ev.title}*.`,
        mentions: [senderId],
    }, { quoted: message });
}

async function cmdAttendees(sock, message, args, context) {
    const { chatId } = context;
    const id = (args[0] || '').toUpperCase().trim();

    if (!id) {
        return sock.sendMessage(chatId, { text: '⚠️ Usage: *.event attendees <id>*' }, { quoted: message });
    }

    const ev = await getEvent(id);
    if (!ev || ev.groupId !== chatId) {
        return sock.sendMessage(chatId, { text: `❌ Event *${id}* not found in this group.` }, { quoted: message });
    }

    const rsvps    = await getRsvps(id);
    const mentions = Object.keys(rsvps);

    if (!mentions.length) {
        return sock.sendMessage(chatId, {
            text: `👥 No RSVPs yet for *${ev.title}*.\n\nBe the first! Use *.event rsvp ${id}*`,
        }, { quoted: message });
    }

    const lines = mentions.map((uid, i) => {
        const ts = moment.tz(rsvps[uid], tz(chatId)).format('D MMM, HH:mm');
        return `${i + 1}. @${uid.split('@')[0]} _(${ts})_`;
    }).join('\n');

    return sock.sendMessage(chatId, {
        text:
            `👥 *ATTENDEES — ${ev.title}*\n` +
            `🆔 ${id} | Total: ${mentions.length}\n\n` +
            `${lines}`,
        mentions,
    }, { quoted: message });
}

async function cmdCancel(sock, message, args, context) {
    const { chatId, senderId, isSenderAdmin, senderIsOwnerOrSudo } = context;

    if (!isSenderAdmin && !senderIsOwnerOrSudo) {
        return sock.sendMessage(chatId, { text: '🚫 Only admins can cancel events.' }, { quoted: message });
    }

    const id = (args[0] || '').toUpperCase().trim();

    if (!id) {
        return sock.sendMessage(chatId, { text: '⚠️ Usage: *.event cancel <id>*' }, { quoted: message });
    }

    const ev = await getEvent(id);
    if (!ev || ev.groupId !== chatId) {
        return sock.sendMessage(chatId, { text: `❌ Event *${id}* not found in this group.` }, { quoted: message });
    }

    if (ev.status === 'cancelled') {
        return sock.sendMessage(chatId, { text: `ℹ️ Event *${ev.title}* is already cancelled.` }, { quoted: message });
    }

    await updateEventStatus(id, 'cancelled');

    // Notify RSVPs
    const rsvps    = await getRsvps(id);
    const mentions = Object.keys(rsvps);

    const text =
        `🔴 *EVENT CANCELLED*\n\n` +
        `📌 *${ev.title}* has been cancelled.\n` +
        `🆔 ID: ${id}` +
        (mentions.length ? `\n\n👥 ${mentions.map(u => `@${u.split('@')[0]}`).join(' ')} — heads up!` : '');

    return sock.sendMessage(chatId, { text, mentions }, { quoted: message });
}

async function cmdDelete(sock, message, args, context) {
    const { chatId, isSenderAdmin, senderIsOwnerOrSudo } = context;

    if (!isSenderAdmin && !senderIsOwnerOrSudo) {
        return sock.sendMessage(chatId, { text: '🚫 Only admins can delete events.' }, { quoted: message });
    }

    const id = (args[0] || '').toUpperCase().trim();

    if (!id) {
        return sock.sendMessage(chatId, { text: '⚠️ Usage: *.event delete <id>*' }, { quoted: message });
    }

    const ev = await getEvent(id);
    if (!ev || ev.groupId !== chatId) {
        return sock.sendMessage(chatId, { text: `❌ Event *${id}* not found.` }, { quoted: message });
    }

    await dbEvents.del(id);
    await dbRsvps.del(id);
    _eventCache.delete(id);
    _notifiedMap.delete(id);

    return sock.sendMessage(chatId, {
        text: `🗑 Event *${ev.title}* (ID: ${id}) has been permanently deleted.`,
    }, { quoted: message });
}

async function cmdReminder(sock, message, args, context) {
    const { chatId, isSenderAdmin, senderIsOwnerOrSudo } = context;

    if (!isSenderAdmin && !senderIsOwnerOrSudo) {
        return sock.sendMessage(chatId, { text: '🚫 Only admins can change reminder times.' }, { quoted: message });
    }

    const id   = (args[0] || '').toUpperCase().trim();
    const mins = parseInt(args[1]);

    if (!id || isNaN(mins) || mins < 1) {
        return sock.sendMessage(chatId, {
            text: '⚠️ Usage: *.event reminder <id> <minutes>*\nExample: *.event reminder ABC123 30*',
        }, { quoted: message });
    }

    const ev = await getEvent(id);
    if (!ev || ev.groupId !== chatId) {
        return sock.sendMessage(chatId, { text: `❌ Event *${id}* not found.` }, { quoted: message });
    }

    // Add to reminder list (avoid duplicates, max 5 offsets)
    const existing = ev.reminders || [];
    if (!existing.includes(mins)) {
        existing.push(mins);
        existing.sort((a, b) => b - a);
        if (existing.length > 5) existing.length = 5;
    }

    const updated = { ...ev, reminders: existing };
    await dbEvents.set(id, updated);
    _eventCache.set(id, updated);

    return sock.sendMessage(chatId, {
        text:
            `✅ Reminder updated for *${ev.title}*\n` +
            `🔔 Active reminders: ${existing.map(r => `${r} min`).join(', ')}`,
    }, { quoted: message });
}

async function cmdSettings(sock, message, args, context) {
    const { chatId, isSenderAdmin, senderIsOwnerOrSudo } = context;

    const cfg = await getGroupConfig(chatId);

    // No args → show current settings
    if (!args.length) {
        return sock.sendMessage(chatId, {
            text:
                `⚙️ *SCHEDULER SETTINGS*\n\n` +
                `🔔 Default reminders: ${cfg.reminders.map(r => `${r} min`).join(', ')}\n\n` +
                `_Admins can change defaults:_\n` +
                `*.event settings reminders 30,10* — set defaults for new events`,
        }, { quoted: message });
    }

    if (!isSenderAdmin && !senderIsOwnerOrSudo) {
        return sock.sendMessage(chatId, { text: '🚫 Only admins can change settings.' }, { quoted: message });
    }

    const sub   = (args[0] || '').toLowerCase();
    const value = args.slice(1).join(' ');

    if (sub === 'reminders') {
        const parsed = value.split(',').map(v => parseInt(v.trim())).filter(v => !isNaN(v) && v > 0);
        if (!parsed.length) {
            return sock.sendMessage(chatId, {
                text: '⚠️ Usage: *.event settings reminders 60,30,10* (comma-separated minutes)',
            }, { quoted: message });
        }

        parsed.sort((a, b) => b - a);
        const newCfg = { ...cfg, reminders: parsed.slice(0, 5) };
        await dbGrpCfg.set(chatId, newCfg);

        return sock.sendMessage(chatId, {
            text: `✅ Default reminders updated: ${newCfg.reminders.map(r => `${r} min`).join(', ')}`,
        }, { quoted: message });
    }

    return sock.sendMessage(chatId, {
        text: `❓ Unknown setting: *${sub}*\n\nAvailable: *reminders*`,
    }, { quoted: message });
}

// ── Plugin export ─────────────────────────────────────────────────────────────
module.exports = {
    command:     'event',
    aliases:     ['schedule', 'sched', 'reminder'],
    category:    'utility',
    description: 'Group event scheduler with RSVP and auto-reminders',
    groupOnly:   true,

    // ── Lifecycle hooks ───────────────────────────────────────────────────────

    async onLoad(sock) {
        try {
            // Warm the event cache on startup
            const all = await dbEvents.getAll();
            let count = 0;
            for (const [id, ev] of Object.entries(all)) {
                if (ev.status === 'upcoming') {
                    _eventCache.set(id, ev);
                    count++;
                }
            }
            _cacheLoadedAt = Date.now();
            printLog('success', `[Scheduler] Loaded ${count} upcoming event(s) into cache`);
        } catch (err) {
            printLog('error', `[Scheduler] onLoad error: ${err.message}`);
        }
    },

    // ── Cron schedule: runs every 60 s ───────────────────────────────────────
    schedules: [
        {
            every:   60_000,   // 1 minute
            handler: async (sock) => {
                await scheduleTick(sock);
            }
        }
    ],

    // ── Command dispatcher ────────────────────────────────────────────────────
    async handler(sock, message, args, context) {
        const chatId   = context?.chatId || message.key.remoteJid;
        const senderId = context?.senderId || message.key.participant || message.key.remoteJid;
        const prefix   = settings.prefixes[0];

        // Always resolve admin status for this command (needed by sub-commands)
        const { isSenderAdmin, isBotAdmin } = await isAdmin(sock, chatId, senderId);
        const senderIsOwnerOrSudo = await isOwnerOrSudo(senderId, sock, chatId);

        // Enrich context with resolved admin info
        const ctx = {
            ...context,
            chatId,
            senderId,
            isSenderAdmin,
            isBotAdmin,
            senderIsOwnerOrSudo,
        };

        if (!args.length) {
            return sock.sendMessage(chatId, { text: menuText(prefix) }, { quoted: message });
        }

        const sub     = args[0].toLowerCase();
        const subArgs = args.slice(1);

        switch (sub) {
            case 'create':
            case 'add':
            case 'new':
                return cmdCreate(sock, message, subArgs, ctx);

            case 'list':
            case 'ls':
            case 'upcoming':
                return cmdList(sock, message, subArgs, ctx);

            case 'info':
            case 'view':
            case 'show':
                return cmdInfo(sock, message, subArgs, ctx);

            case 'rsvp':
            case 'join':
            case 'attend':
                return cmdRsvp(sock, message, subArgs, ctx);

            case 'unrsvp':
            case 'leave':
            case 'decline':
                return cmdUnrsvp(sock, message, subArgs, ctx);

            case 'attendees':
            case 'who':
            case 'going':
                return cmdAttendees(sock, message, subArgs, ctx);

            case 'cancel':
                return cmdCancel(sock, message, subArgs, ctx);

            case 'delete':
            case 'remove':
            case 'del':
                return cmdDelete(sock, message, subArgs, ctx);

            case 'reminder':
            case 'remind':
                return cmdReminder(sock, message, subArgs, ctx);

            case 'settings':
            case 'config':
            case 'set':
                return cmdSettings(sock, message, subArgs, ctx);

            case 'help':
            case 'menu':
                return sock.sendMessage(chatId, { text: menuText(prefix) }, { quoted: message });

            default:
                return sock.sendMessage(chatId, {
                    text: `❓ Unknown sub-command: *${sub}*\nUse *${prefix}event* to see all options.`,
                }, { quoted: message });
        }
    }
};