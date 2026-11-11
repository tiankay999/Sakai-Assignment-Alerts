/**
 * Entry point.
 *
 * Wires the four pieces together:
 *   outbox.jsonl (written by monitor.py)  ->  broadcaster  ->  WhatsApp groups
 *   incoming group message  ->  command parser or Gemini assistant
 *
 * The Python scraper remains the source of truth for everything Sakai. This
 * service never logs into Sakai, never asks anyone for credentials, and holds
 * no student identity beyond the WhatsApp numbers on the admin and mute lists.
 */
import { config, configProblems, redacted } from './config.js';
import { logger } from './logger.js';
import { createWhatsApp } from './whatsapp.js';
import { createBroadcaster } from './broadcaster.js';
import { createAssistant } from './assistant.js';
import { createCommands } from './commands.js';
import { startOutboxWatcher } from './outbox.js';
import { timetableManager } from './timetable.js';
import { botState, isMuted } from './store.js';
import {
  contextInfoOf,
  hasImageInMessage,
  isGroupJid,
  jidDigits,
  messageText,
  quotedInfoOf,
  senderIdentifiers,
  senderJid,
} from './util.js';

// Chats that are never worth handling.
const IGNORED_CHATS = ['status@broadcast'];

function isIgnoredChat(jid) {
  return !jid || IGNORED_CHATS.includes(jid) || jid.endsWith('@newsletter');
}

/** Was the bot @mentioned in this message? */
function mentionsBot(msg, botNumbers) {
  const ctx = contextInfoOf(msg);
  const mentioned = ctx?.mentionedJid ?? [];
  return mentioned.some((jid) => botNumbers.includes(jidDigits(jid)));
}

/** Is this a reply to one of the bot's own messages? */
function repliesToBot(msg, botNumbers) {
  const ctx = contextInfoOf(msg);
  if (!ctx?.quotedMessage) return false;
  const candidates = [ctx.participant, ctx.remoteJid].filter(Boolean);
  return candidates.some((jid) => botNumbers.includes(jidDigits(jid)));
}

/** Remove "@2332..." mention tokens so the model sees a clean question. */
function stripMentions(text, botNumbers) {
  let out = text;
  for (const number of botNumbers) {
    out = out.split(`@${number}`).join(' ');
  }
  return out.replace(/\s{2,}/g, ' ').trim();
}

async function main() {
  logger.info(redacted(), 'starting whatsapp bot');
  for (const problem of configProblems()) logger.warn(problem);

  botState.data.startedAt = new Date().toISOString();
  botState.save();

  const assistant = createAssistant();

  const whatsapp = createWhatsApp({
    onMessage: async (msg) => {
      const chatJid = msg.key?.remoteJid;
      if (isIgnoredChat(chatJid)) return;

      const text = messageText(msg);
      const quoted = quotedInfoOf(msg);
      const hasImage = hasImageInMessage(msg) || Boolean(quoted?.hasImage);
      if (!text && !hasImage) return;

      const botNumbers = whatsapp.botNumbers();
      const identifiers = senderIdentifiers(msg);
      const isAdmin = identifiers.some((d) => config.adminNumbers.includes(d));
      const muted = isMuted(identifiers);

      // --- Commands -------------------------------------------------------
      if (text.startsWith(config.commandPrefix)) {
        const result = await commands.handle({ msg, chatJid, text, isAdmin });
        if (result === null || result === undefined) return;

        // /ask is routed through the same assistant path as an @mention.
        if (typeof result === 'object' && 'assistantQuestion' in result) {
          const images = hasImage ? await whatsapp.extractImages(msg) : [];
          await answer({
            chatJid,
            msg,
            question: result.assistantQuestion,
            quotedText: quoted?.text || '',
            images,
            identifiers,
            muted,
            isAdmin,
          });
          return;
        }

        await whatsapp.sendNow(chatJid, result, { quoted: msg });
        return;
      }

      // --- Assistant triggers ---------------------------------------------
      // In groups: only reply on @mention or reply to bot. In DMs: reply directly.
      const triggered = !isGroupJid(chatJid) || mentionsBot(msg, botNumbers) || repliesToBot(msg, botNumbers);
      if (!triggered) return;

      const images = hasImage ? await whatsapp.extractImages(msg) : [];
      await answer({
        chatJid,
        msg,
        question: stripMentions(text, botNumbers),
        quotedText: quoted?.text || '',
        images,
        identifiers,
        muted,
        isAdmin,
      });
    },
  });

  const broadcaster = createBroadcaster({ whatsapp });
  const commands = createCommands({ whatsapp, broadcaster, assistant });

  /** Shared assistant path for /ask, @mentions, DMs, and replies. */
  async function answer({
    chatJid,
    msg,
    question,
    quotedText = '',
    images = [],
    identifiers,
    muted,
    isAdmin = false,
  }) {
    // Muted users get silence, not an explanation.
    if (muted) {
      logger.debug({ chatJid }, 'muted user triggered the assistant, ignoring');
      return;
    }

    const userKey = identifiers[0] ?? senderJid(msg) ?? 'unknown';
    await whatsapp.showTyping(chatJid);

    const result = await assistant.ask({
      chatJid,
      userKey,
      question,
      quotedText,
      images,
      isAdmin,
    });

    if (result.ok) {
      await whatsapp.sendNow(chatJid, result.text, { quoted: msg });
      logger.info({ chatJid, group: isGroupJid(chatJid) }, 'assistant replied');
      return;
    }
    if (result.silent) return;
    if (result.notice) await whatsapp.sendNow(chatJid, result.notice, { quoted: msg });
  }

  const stopWatcher = startOutboxWatcher({
    onEvent: (record) => broadcaster.handleEvent(record),
  });

  await whatsapp.connect();

  // Load or sync timetable on startup
  if (!timetableManager.getEntries().length) {
    try {
      await timetableManager.sync();
    } catch (e) {
      logger.warn({ err: e.message }, 'initial timetable sync failed');
    }
  }

  // Periodic class reminder loop (checks every 60 seconds)
  const reminderTimer = setInterval(() => {
    timetableManager.checkAndDispatchAlerts({ whatsapp, broadcaster }).catch((err) => {
      logger.error({ err: err.message }, 'error in class reminder tick');
    });
  }, 60_000);

  const shutdown = (signal) => {
    logger.info({ signal }, 'shutting down');
    clearInterval(reminderTimer);
    stopWatcher();
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  logger.error({ err: err.message, stack: err.stack }, 'fatal startup error');
  process.exit(1);
});
