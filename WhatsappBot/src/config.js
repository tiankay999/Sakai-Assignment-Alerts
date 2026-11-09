/**
 * Environment configuration.
 *
 * Every secret and every phone number comes from the environment - nothing is
 * hardcoded, and `redacted()` is the only shape of this object that is ever
 * allowed near a log line or a WhatsApp reply.
 */
import 'dotenv/config';
import path from 'node:path';

function str(name, fallback = '') {
  const v = process.env[name];
  return v === undefined || v === '' ? fallback : v;
}

function num(name, fallback) {
  const v = Number.parseFloat(process.env[name] ?? '');
  return Number.isFinite(v) ? v : fallback;
}

function int(name, fallback) {
  const v = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(v) ? v : fallback;
}

/** Keep digits only so "+233 20 000 0000" and "233200000000" compare equal. */
export function normalizeNumber(value) {
  return String(value ?? '').replace(/\D/g, '');
}

function numberList(name) {
  return str(name)
    .split(/[,\s;]+/)
    .map(normalizeNumber)
    .filter(Boolean);
}

const dataDir = str('DATA_DIR', '/data');

export const config = {
  dataDir,
  authDir: path.join(dataDir, 'baileys_auth'),

  // Files produced by the Python scraper (read-only from here).
  outboxFile: path.join(dataDir, 'outbox.jsonl'),
  seenFile: path.join(dataDir, 'seen.json'),
  scraperStatusFile: path.join(dataDir, 'scraper_status.json'),

  // Files owned by this service.
  groupsFile: path.join(dataDir, 'groups.json'),
  sponsorsFile: path.join(dataDir, 'sponsors.json'),
  moderationFile: path.join(dataDir, 'moderation.json'),
  usageFile: path.join(dataDir, 'llm_usage.json'),
  stateFile: path.join(dataDir, 'bot_state.json'),
  cursorFile: path.join(dataDir, 'outbox_cursor.json'),

  adminNumbers: numberList('ADMIN_NUMBERS'),

  // How to link the bot's WhatsApp account on first run:
  //   'qr'      - scan a QR code shown in the logs (default)
  //   'pairing' - enter an 8-character code on the bot's phone. Requires
  //               BOT_NUMBER, the bot's own number in international format.
  loginMethod: str('LOGIN_METHOD', 'qr').toLowerCase() === 'pairing' ? 'pairing' : 'qr',
  botNumber: normalizeNumber(str('BOT_NUMBER')),
  // Optional: ask WhatsApp for a specific 8-char code instead of a random one.
  customPairingCode: str('PAIRING_CODE').trim().toUpperCase(),

  gemini: {
    apiKey: str('GROQ_API_KEY') || str('GEMINI_API_KEY'),
    model: str('LLM_MODEL') || str('GEMINI_MODEL', str('GROQ_API_KEY') ? 'llama-3.3-70b-versatile' : 'gemini-1.5-flash'),
    rateLimit: int('LLM_RATE_LIMIT', 5),
    rateWindowMs: int('LLM_RATE_WINDOW_MINUTES', 60) * 60 * 1000,
    monthlyTokenCap: int('LLM_MONTHLY_CAP', 1000000),
    monthlyCostCap: num('LLM_MONTHLY_COST_CAP', 0),
    inputPricePerMTok: num('LLM_INPUT_PRICE_PER_MTOK', 0.3),
    outputPricePerMTok: num('LLM_OUTPUT_PRICE_PER_MTOK', 2.5),
    contextTurns: int('LLM_CONTEXT_TURNS', 6),
    maxReplyChars: int('LLM_MAX_REPLY_CHARS', 1200),
  },

  commandPrefix: str('COMMAND_PREFIX', '/'),
  sendMinDelayMs: Math.max(500, int('SEND_MIN_DELAY_MS', 3500)),
  sendMaxDelayMs: Math.max(1000, int('SEND_MAX_DELAY_MS', 9000)),
  outboxPollMs: Math.max(1000, int('OUTBOX_POLL_MS', 5000)),

  questionsDeyUrl: str('QUESTIONSDEY_URL', 'https://questionsdey.com'),
  botName: str('BOT_NAME', 'AssignmentDey'),
  logLevel: str('LOG_LEVEL', 'info'),

  sakaiBase: str('SAKAI_BASE', 'https://sakai.ug.edu.gh'),
};

if (config.sendMaxDelayMs < config.sendMinDelayMs) {
  config.sendMaxDelayMs = config.sendMinDelayMs;
}

/** Safe-to-log view: no key material, no phone numbers. */
export function redacted() {
  return {
    dataDir: config.dataDir,
    adminCount: config.adminNumbers.length,
    loginMethod: config.loginMethod,
    botNumberSet: Boolean(config.botNumber),
    geminiConfigured: Boolean(config.gemini.apiKey),
    geminiModel: config.gemini.model,
    rateLimit: `${config.gemini.rateLimit}/${config.gemini.rateWindowMs / 60000}min`,
    monthlyTokenCap: config.gemini.monthlyTokenCap || 'none',
    monthlyCostCap: config.gemini.monthlyCostCap || 'none',
    sendDelayMs: `${config.sendMinDelayMs}-${config.sendMaxDelayMs}`,
    commandPrefix: config.commandPrefix,
  };
}

/** Non-fatal misconfiguration checks. Returns human-readable problems. */
export function configProblems() {
  const problems = [];
  if (config.adminNumbers.length === 0) {
    problems.push('ADMIN_NUMBERS is empty - no one will be able to run commands.');
  }
  if (!config.gemini.apiKey) {
    problems.push('GEMINI_API_KEY is not set - the assistant will stay silent.');
  }
  if (config.loginMethod === 'pairing' && !config.botNumber) {
    problems.push(
      'LOGIN_METHOD=pairing needs BOT_NUMBER (digits, with country code) - falling back to QR.',
    );
  }
  if (config.customPairingCode && config.customPairingCode.length !== 8) {
    problems.push('PAIRING_CODE must be exactly 8 characters - ignoring it.');
  }
  return problems;
}
