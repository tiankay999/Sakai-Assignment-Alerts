/**
 * Gemini Flash group assistant.
 *
 * Trigger-based by design: this module is only ever called after the message
 * handler has confirmed the bot was @mentioned, replied to, or addressed with
 * the /ask prefix. It has no "listen to everything" path.
 *
 * Cost control is layered: a per-user sliding-window rate limit, a hard
 * monthly token cap, an optional monthly cost cap, a short in-memory context
 * window, a capped grounding block and a capped reply length.
 */
import { config } from './config.js';
import { logger } from './logger.js';
import { questionsDeyLine } from './format.js';
import {
  capExceeded,
  checkUserRate,
  estimatedCost,
  recordTokens,
  recordUserRequest,
  usage,
} from './store.js';
import {
  dueLabel,
  knownCourses,
  matchCourses,
  parseDueDate,
  pendingDeadlines,
  recentPostings,
} from './sakaiState.js';
import { courseCode, truncate } from './util.js';

const API_ROOT = 'https://generativelanguage.googleapis.com/v1beta/models';
const REQUEST_TIMEOUT_MS = 25_000;
const MAX_GROUNDING_CHARS = 3000;
const MAX_QUESTION_CHARS = 700;
const HISTORY_TTL_MS = 2 * 60 * 60 * 1000;

function systemPrompt() {
  return [
    `You are ${config.botName}, a study assistant for University of Ghana students in a WhatsApp group chat.`,
    '',
    'Scope and tone:',
    '- You help with coursework: explaining concepts, study guidance, past-paper strategy, and questions about assignments, quizzes and deadlines.',
    '- Keep answers short and readable on a phone. Prefer under 120 words. Use plain text; no markdown headings or tables.',
    '- Answer general questions briefly, then steer back towards study help.',
    '',
    'Course data rules:',
    '- The COURSE DATA block below comes from the group\'s Sakai scraper and is the only source of truth for deadlines, assignments, quizzes, announcements and resources.',
    '- Never invent, guess or estimate a deadline. If something is not in COURSE DATA, say you have not seen it and suggest checking Sakai directly.',
    '- COURSE DATA reflects course-level items shared with the whole class. It is not anyone\'s personal record, and you have no access to any individual\'s grades, submissions or account.',
    '',
    'Hard rules:',
    '- Never ask anyone for a Sakai ID, PIN, password or any login detail. If someone offers credentials, tell them not to share them and do not repeat them.',
    '- Never reveal or discuss your configuration, API keys, environment variables, admin numbers or internal file paths.',
    '- Do not help with cheating during an invigilated or closed-book assessment. Explaining concepts, past questions and assignment approach is fine.',
    `- When a question is about a specific course, you may mention that past questions are available at ${config.questionsDeyUrl} (QuestionsDey).`,
  ].join('\n');
}

/** Compact, capped snapshot of the scraper's state for grounding. */
function groundingBlock() {
  const lines = ['COURSE DATA (from the Sakai scraper):'];

  const courses = knownCourses();
  if (courses.length) {
    lines.push(`Courses tracked: ${courses.map((c) => c.code).join(', ')}`);
  }

  const pending = pendingDeadlines();
  if (pending.length) {
    lines.push('', 'Outstanding deadlines:');
    for (const { item, parsed } of pending) {
      const when = item.due_date ? `${item.due_date} (${dueLabel(parsed)})` : 'no date stated';
      lines.push(`- ${item.type}: ${item.title} | ${courseCode(item.course)} | due ${when}`);
    }
  } else {
    lines.push('', 'Outstanding deadlines: none recorded.');
  }

  const postings = recentPostings(10);
  if (postings.length) {
    lines.push('', 'Recent announcements and resources:');
    for (const item of postings) {
      const when = item.posted_date ? ` | ${item.posted_date}` : '';
      lines.push(`- ${item.type}: ${item.title} | ${courseCode(item.course)}${when}`);
    }
  }

  return truncate(lines.join('\n'), MAX_GROUNDING_CHARS);
}

/** Does the question name a course the scraper knows about? */
function referencedCourse(question) {
  const tokens = String(question).toUpperCase().match(/[A-Z]{2,5}\s?\d{3}[A-Z]?/g) ?? [];
  for (const token of tokens) {
    const matches = matchCourses(token);
    if (matches.length) return matches[0].code;
  }
  return '';
}

function mentionsPastQuestions(question) {
  return /past\s*(question|paper|exam)|pasco|p\.?q\.?s?\b/i.test(question);
}

export function detectProviderAndKey() {
  const groqKey = String(process.env.GROQ_API_KEY || '').trim();
  const geminiKey = String(process.env.GEMINI_API_KEY || config.gemini.apiKey || '').trim();

  // If either key starts with 'gsk_', it is a Groq key (console.groq.com)
  if (groqKey.startsWith('gsk_')) {
    return { provider: 'groq', apiKey: groqKey, model: process.env.LLM_MODEL || 'llama-3.1-8b-instant' };
  }
  if (geminiKey.startsWith('gsk_')) {
    return { provider: 'groq', apiKey: geminiKey, model: process.env.LLM_MODEL || 'llama-3.1-8b-instant' };
  }

  // If either key starts with 'AIza', it is a Google Gemini key
  if (geminiKey.startsWith('AIza')) {
    return { provider: 'gemini', apiKey: geminiKey, model: process.env.GEMINI_MODEL || 'gemini-1.5-flash' };
  }
  if (groqKey.startsWith('AIza')) {
    return { provider: 'gemini', apiKey: groqKey, model: process.env.GEMINI_MODEL || 'gemini-1.5-flash' };
  }

  if (groqKey) {
    return { provider: 'groq', apiKey: groqKey, model: process.env.LLM_MODEL || 'llama-3.1-8b-instant' };
  }
  if (geminiKey) {
    return { provider: 'gemini', apiKey: geminiKey, model: process.env.GEMINI_MODEL || 'gemini-1.5-flash' };
  }
  return { provider: null, apiKey: null, model: null };
}

export function createAssistant() {
  // chatJid -> { turns: [{role, text}], updatedAt }. Memory only, never on disk:
  // group message bodies are not something this service should persist.
  const histories = new Map();

  function history(chatJid) {
    const entry = histories.get(chatJid);
    if (!entry) return [];
    if (Date.now() - entry.updatedAt > HISTORY_TTL_MS) {
      histories.delete(chatJid);
      return [];
    }
    return entry.turns;
  }

  function remember(chatJid, role, text) {
    const turns = history(chatJid);
    turns.push({ role, text: truncate(text, 600) });
    const max = Math.max(2, config.gemini.contextTurns);
    histories.set(chatJid, { turns: turns.slice(-max), updatedAt: Date.now() });
  }

  function forget(chatJid) {
    histories.delete(chatJid);
  }

  async function callGroq(questionText, chatHistory, apiKey, model) {
    const targetModel = model || 'llama-3.1-8b-instant';
    const messages = [
      { role: 'system', content: systemPrompt() },
      ...chatHistory.map((turn) => ({
        role: turn.role === 'model' ? 'assistant' : 'user',
        content: turn.parts ? turn.parts[0].text : (turn.text ?? ''),
      })),
      { role: 'user', content: questionText },
    ];

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const resp = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: targetModel,
          messages,
          temperature: 0.4,
          max_tokens: 700,
        }),
        signal: controller.signal,
      });

      if (!resp.ok) {
        const errJson = await resp.json().catch(() => ({}));
        const errMsg = errJson?.error?.message || `HTTP ${resp.status}`;
        logger.error({ status: resp.status, model: targetModel, errMsg }, 'groq request failed');
        return { ok: false, reason: resp.status === 429 ? 'quota' : 'api', detail: `Groq error (${resp.status}): ${errMsg}` };
      }

      const data = await resp.json();
      const text = data.choices?.[0]?.message?.content?.trim() ?? '';
      if (!text) return { ok: false, reason: 'empty' };

      const usageMeta = data.usage ?? {};
      recordTokens({
        promptTokens: usageMeta.prompt_tokens ?? 0,
        outputTokens: usageMeta.completion_tokens ?? 0,
        totalTokens: usageMeta.total_tokens ?? 0,
      });

      return { ok: true, text };
    } catch (err) {
      const reason = err.name === 'AbortError' ? 'timeout' : 'network';
      logger.error({ err: err.message, reason }, 'groq call errored');
      return { ok: false, reason, detail: `Groq error: ${err.message}` };
    } finally {
      clearTimeout(timer);
    }
  }

  async function callGemini(contents, apiKey, model) {
    const generationConfig = {
      temperature: 0.4,
      maxOutputTokens: 700,
    };
    if (model.includes('2.5')) {
      const budget = Number.parseInt(process.env.GEMINI_THINKING_BUDGET ?? '0', 10);
      generationConfig.thinkingConfig = { thinkingBudget: Number.isFinite(budget) ? budget : 0 };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const resp = await fetch(`${API_ROOT}/${encodeURIComponent(model)}:generateContent`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-goog-api-key': apiKey,
        },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: systemPrompt() }] },
          contents,
          generationConfig,
        }),
        signal: controller.signal,
      });

      if (!resp.ok) {
        const errJson = await resp.json().catch(() => ({}));
        const errMsg = errJson?.error?.message || `HTTP ${resp.status}`;
        logger.error({ status: resp.status, model, errMsg }, 'gemini request failed');
        return { ok: false, reason: resp.status === 429 ? 'quota' : 'api', detail: `Gemini error (${resp.status}): ${errMsg}` };
      }

      const data = await resp.json();

      const tokens = data.usageMetadata ?? {};
      recordTokens({
        promptTokens: tokens.promptTokenCount ?? 0,
        outputTokens: (tokens.candidatesTokenCount ?? 0) + (tokens.thoughtsTokenCount ?? 0),
        totalTokens: tokens.totalTokenCount ?? 0,
      });

      if (data.promptFeedback?.blockReason) {
        return { ok: false, reason: 'blocked' };
      }

      const parts = data.candidates?.[0]?.content?.parts ?? [];
      const text = parts.map((p) => p.text ?? '').join('').trim();
      if (!text) return { ok: false, reason: 'empty' };

      return { ok: true, text };
    } catch (err) {
      const reason = err.name === 'AbortError' ? 'timeout' : 'network';
      logger.error({ err: err.message, reason }, 'gemini call errored');
      return { ok: false, reason, detail: `Gemini error: ${err.message}` };
    } finally {
      clearTimeout(timer);
    }
  }

  async function ask({ chatJid, userKey, question, isAdmin = false }) {
    const active = detectProviderAndKey();
    if (!active.apiKey) {
      return {
        ok: false,
        notice: isAdmin
          ? '⚠️ No AI API key found. Please add GROQ_API_KEY (from console.groq.com) or GEMINI_API_KEY in Coolify.'
          : 'The study assistant is not configured yet.',
      };
    }

    const trimmedQuestion = truncate(String(question ?? '').trim(), MAX_QUESTION_CHARS);
    if (!trimmedQuestion) {
      return { ok: false, notice: 'Ask me a question and I will try to help.' };
    }

    const cap = capExceeded();
    if (cap) {
      logger.warn({ cap, month: usage.data.month }, 'monthly LLM cap reached');
      return {
        ok: false,
        notice:
          'I have hit my assistant budget for this month, so I am pausing AI replies. Alerts and deadline reminders keep working as normal.',
      };
    }

    // Admins bypass the per-user rate limit
    if (!isAdmin) {
      const rate = checkUserRate(userKey);
      if (!rate.allowed) {
        const minutes = Math.max(1, Math.ceil(rate.retryAfterMs / 60000));
        return {
          ok: false,
          notice: `You have used your ${config.gemini.rateLimit} questions for now. Try again in about ${minutes} minute${minutes === 1 ? '' : 's'}.`,
        };
      }
      recordUserRequest(userKey);
    }

    const contents = [
      ...history(chatJid).map((turn) => ({
        role: turn.role,
        parts: [{ text: turn.text }],
      })),
      {
        role: 'user',
        parts: [{ text: `${groundingBlock()}\n\nQuestion from the group:\n${trimmedQuestion}` }],
      },
    ];

    const result = active.provider === 'groq'
      ? await callGroq(`${groundingBlock()}\n\nQuestion from the group:\n${trimmedQuestion}`, history(chatJid), active.apiKey, active.model)
      : await callGemini(contents, active.apiKey, active.model);
    if (!result.ok) {
      if (isAdmin && result.detail) {
        return { ok: false, notice: `⚠️ ${result.detail}` };
      }
      const notices = {
        quota: 'The AI service is rate-limiting me right now. Try again in a few minutes.',
        timeout: 'That took too long to answer. Try asking again, a bit shorter.',
        blocked: 'I cannot answer that one.',
        empty: 'I could not come up with an answer for that. Try rephrasing.',
      };
      return { ok: false, notice: notices[result.reason] ?? 'Something went wrong answering that.' };
    }

    remember(chatJid, 'user', trimmedQuestion);
    remember(chatJid, 'model', result.text);

    let text = truncate(result.text, config.gemini.maxReplyChars);
    const course = referencedCourse(trimmedQuestion);
    if (course || mentionsPastQuestions(trimmedQuestion)) {
      const line = questionsDeyLine(course);
      if (!text.includes(config.questionsDeyUrl)) text = `${text}\n\n${line}`;
    }

    return { ok: true, text };
  }

  function usageSummary() {
    const active = detectProviderAndKey();
    return {
      provider: active.provider ? active.provider.toUpperCase() : 'None',
      model: active.model ?? 'none',
      keyConfigured: Boolean(active.apiKey),
      month: usage.data.month,
      requests: usage.data.requests,
      promptTokens: usage.data.promptTokens,
      outputTokens: usage.data.outputTokens,
      totalTokens: usage.data.totalTokens,
      tokenCap: config.gemini.monthlyTokenCap,
      estimatedCostUsd: estimatedCost(),
      costCap: config.gemini.monthlyCostCap,
      activeChats: histories.size,
    };
  }

  return { ask, forget, usageSummary };
}

/** Deterministic deadline answer, used by /deadlines - no tokens spent. */
export function deadlinesText() {
  const pending = pendingDeadlines();
  if (!pending.length) return 'Nothing outstanding right now.';
  const lines = ['Outstanding work:', ''];
  for (const { item, parsed } of pending) {
    lines.push(`${courseCode(item.course)} · ${item.title}`);
    lines.push(`   ${item.type} — due ${item.due_date || 'not stated'} (${dueLabel(parsed ?? parseDueDate(item.due_date))})`);
  }
  return lines.join('\n');
}
