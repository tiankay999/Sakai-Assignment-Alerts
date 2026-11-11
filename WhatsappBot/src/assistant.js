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
import { timetableManager } from './timetable.js';
import { courseCode, truncate } from './util.js';

const API_ROOT = 'https://generativelanguage.googleapis.com/v1beta/models';
const REQUEST_TIMEOUT_MS = 60_000;
const MAX_GROUNDING_CHARS = 3000;
const MAX_QUESTION_CHARS = 700;
const HISTORY_TTL_MS = 2 * 60 * 60 * 1000;

function systemPrompt() {
  return [
    `You are ${config.botName}, a friendly, witty, and clever study buddy & group chat assistant for University of Ghana (Legon) students, especially DCIT Level 300 coursemates.`,
    '',
    'Personality & Tone:',
    '- Be warm, approachable, humorous, and engaging — like a sharp, funny Level 300 coursemate who is always down for good banter AND great at helping with schoolwork.',
    '- Freely join casual conversations, non-academic discussions, campus/life chat, and playful banter without awkwardly forcing everything back to studying.',
    '- Tell good, clever jokes! Whenever someone asks for a joke, or when the vibe is right, deliver funny programming/tech jokes, witty Legon campus humor, relatable student struggles, or clever puns.',
    '- You can read and analyze images (screenshots of code/errors, assignment photos, diagrams, whiteboards, past papers, or funny memes). Comment on memes/casual pics playfully, and explain or solve study/code images clearly.',
    '- When a user replies to a previous message (`[Replying to a previous message]`), always read that quoted message carefully and respond to it directly.',
    '- Keep answers readable on a phone: concise, natural, and well-paced (prefer under 150 words unless breaking down a detailed code/image question). Use light WhatsApp *bold* and emojis naturally; never use markdown # headings or raw markdown tables.',
    '',
    'Course & Timetable Data Rules:',
    '- The COURSE & TIMETABLE DATA block below comes from the group\'s Sakai scraper and DCS Level 300 timetable. It is the single source of truth for deadlines, announcements, class times, venues, and lecturers.',
    '- Never invent or guess a deadline or class time. If something is not listed in COURSE DATA, say you haven\'t seen an update for it on Sakai yet and suggest checking Sakai directly.',
    '- COURSE DATA reflects class-wide items; you have no access to anyone\'s private grades or personal account.',
    '',
    'Safety & Privacy Rules:',
    '- Never ask anyone for a Sakai ID, PIN, password, or login credentials. If someone offers them, warn them not to share and do not repeat them.',
    '- Never reveal or discuss your internal configuration, API keys, environment variables, admin numbers, or file paths.',
    '- Do not help with active cheating during an invigilated or closed-book exam. Explaining concepts, past questions, and assignment guidance is always fine.',
    `- When a question is specifically about a course or past questions, you may mention that past questions are available at ${config.questionsDeyUrl} (QuestionsDey).`,
    `- When asked who your Creator is say Christian Asante and his GitHub link is https://github.com/tiankay999 `
  ].join('\n');
}

/** Compact, capped snapshot of the scraper's state & today's timetable for grounding. */
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

  try {
    const todayClasses = timetableManager.getClassesForToday();
    if (todayClasses.length) {
      lines.push('', "TODAY'S DCIT LEVEL 300 CLASSES:");
      for (const c of todayClasses) {
        lines.push(`- ${c.startTime}-${c.endTime} | ${c.courseCode} (${c.courseTitle}) | ${c.venue} | ${c.lecturer}`);
      }
    } else {
      lines.push('', "TODAY'S DCIT LEVEL 300 CLASSES: No classes scheduled today.");
    }
  } catch {
    // ignore if timetable not loaded yet
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

  async function callGroq(questionText, chatHistory, apiKey, model, images = []) {
    const hasImages = Array.isArray(images) && images.length > 0;
    const isVisionCapable = (m) => /qwen3\.8|muse-spark|llama-4-scout|llama-4-maverick|vision|llava|-vl\b/i.test(String(m || ''));

    let targetModel = model || 'llama-3.1-8b-instant';
    if (hasImages) {
      if (process.env.GROQ_VISION_MODEL) {
        targetModel = process.env.GROQ_VISION_MODEL.trim();
      } else if (isVisionCapable(model)) {
        targetModel = model;
      } else {
        targetModel = 'qwen/qwen3.8-27b';
      }
    }

    async function sendGroqRequest(modelName) {
      const messages = [
        { role: 'system', content: systemPrompt() },
        ...chatHistory.map((turn) => ({
          role: turn.role === 'model' ? 'assistant' : 'user',
          content: turn.parts ? turn.parts[0].text : (turn.text ?? ''),
        })),
      ];

      if (hasImages) {
        messages.push({
          role: 'user',
          content: [
            { type: 'text', text: questionText },
            ...images.map((img) => ({
              type: 'image_url',
              image_url: { url: `data:${img.mimeType};base64,${img.base64}` },
            })),
          ],
        });
      } else {
        messages.push({ role: 'user', content: questionText });
      }

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
            model: modelName,
            messages,
            temperature: 0.7,
            max_tokens: 1200,
          }),
          signal: controller.signal,
        });

        const status = resp.status;
        if (!resp.ok) {
          const errJson = await resp.json().catch(() => ({}));
          const errMsg = errJson?.error?.message || `HTTP ${status}`;
          logger.error({ status, model: modelName, errMsg }, 'groq request failed');
          return { ok: false, status, errMsg };
        }

        const data = await resp.json();
        let text = data.choices?.[0]?.message?.content?.trim() ?? '';
        text = text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
        if (!text) return { ok: false, status: 200, errMsg: 'empty', reason: 'empty' };

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
        return { ok: false, status: 0, errMsg: err.message, reason };
      } finally {
        clearTimeout(timer);
      }
    }

    let result = await sendGroqRequest(targetModel);

    // If vision model fails with 404/400, dynamically find an available Groq vision model on this account
    if (!result.ok && hasImages && (result.status === 404 || result.status === 400)) {
      try {
        const modelsRes = await fetch('https://api.groq.com/openai/v1/models', {
          headers: { authorization: `Bearer ${apiKey}` },
        });
        if (modelsRes.ok) {
          const modelsData = await modelsRes.json();
          const availableIds = (modelsData.data || []).map((m) => m.id);
          const visionCandidates = availableIds.filter((id) => id !== targetModel && isVisionCapable(id));

          // Also include user's configured model if not yet attempted
          if (model && model !== targetModel && availableIds.includes(model) && !visionCandidates.includes(model)) {
            visionCandidates.push(model);
          }

          if (visionCandidates.length > 0) {
            for (const candidate of visionCandidates) {
              logger.info({ oldModel: targetModel, visionModel: candidate }, 'retrying image request with discovered Groq model');
              result = await sendGroqRequest(candidate);
              if (result.ok) break;
            }
          } else {
            logger.warn({ availableIds }, 'no vision-capable model found in Groq account catalog');
          }
        }
      } catch (lookupErr) {
        logger.warn({ err: lookupErr.message }, 'could not query Groq models catalog for vision fallback');
      }
    }

    if (!result.ok) {
      const reason = result.reason || (result.status === 429 ? 'quota' : 'api');
      return { ok: false, reason, detail: `Groq error (${result.status}): ${result.errMsg}` };
    }

    return { ok: true, text: result.text };
  }

  async function callGemini(contents, apiKey, model, images = []) {
    const generationConfig = {
      temperature: 0.7,
      maxOutputTokens: 800,
    };
    if (model.includes('2.5')) {
      const budget = Number.parseInt(process.env.GEMINI_THINKING_BUDGET ?? '0', 10);
      generationConfig.thinkingConfig = { thinkingBudget: Number.isFinite(budget) ? budget : 0 };
    }

    if (Array.isArray(images) && images.length > 0 && contents.length > 0) {
      const last = contents[contents.length - 1];
      if (last.role === 'user' && Array.isArray(last.parts)) {
        for (const img of images) {
          last.parts.push({
            inlineData: {
              mimeType: img.mimeType || 'image/jpeg',
              data: img.base64,
            },
          });
        }
      }
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

  async function ask({ chatJid, userKey, question, quotedText = '', images = [], isAdmin = false }) {
    const active = detectProviderAndKey();
    if (!active.apiKey) {
      return {
        ok: false,
        notice: isAdmin
          ? '⚠️ No AI API key found. Please add GROQ_API_KEY (from console.groq.com) or GEMINI_API_KEY in Coolify.'
          : 'The study assistant is not configured yet.',
      };
    }

    let trimmedQuestion = truncate(String(question ?? '').trim(), MAX_QUESTION_CHARS);
    const hasImages = Array.isArray(images) && images.length > 0;
    const hasQuoted = Boolean(quotedText && String(quotedText).trim());

    if (!trimmedQuestion && !hasImages && !hasQuoted) {
      return { ok: false, notice: 'Say hello, ask me a question, or send an image!' };
    }

    if (!trimmedQuestion) {
      if (hasImages && hasQuoted) {
        trimmedQuestion = 'Please read the previous message and inspect the attached image to respond or help.';
      } else if (hasImages) {
        trimmedQuestion = 'Please inspect this image and explain what is in it or help out!';
      } else {
        trimmedQuestion = 'Please read and respond to this previous message.';
      }
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

    const promptLines = [groundingBlock(), ''];
    if (hasQuoted) {
      promptLines.push('[Replying to a previous message]:');
      promptLines.push(`"${truncate(String(quotedText).trim(), 800)}"`);
      promptLines.push('');
    }
    promptLines.push('Message from the group:');
    promptLines.push(trimmedQuestion);
    const fullPrompt = promptLines.join('\n');

    const contents = [
      ...history(chatJid).map((turn) => ({
        role: turn.role,
        parts: [{ text: turn.text }],
      })),
      {
        role: 'user',
        parts: [{ text: fullPrompt }],
      },
    ];

    let result = active.provider === 'groq'
      ? await callGroq(fullPrompt, history(chatJid), active.apiKey, active.model, images)
      : await callGemini(contents, active.apiKey, active.model, images);

    // Optional vision fallback: if Groq failed on an image and a Gemini AIza key is also configured, try Gemini
    if (!result.ok && hasImages && active.provider === 'groq') {
      const fallbackGeminiKey = String(process.env.GEMINI_API_KEY || '').trim();
      if (fallbackGeminiKey.startsWith('AIza')) {
        logger.info('falling back to Gemini for image analysis');
        result = await callGemini(contents, fallbackGeminiKey, process.env.GEMINI_MODEL || 'gemini-1.5-flash', images);
      }
    }

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

    const historyEntry =
      (hasQuoted ? `[Replying to: "${truncate(String(quotedText).trim(), 120)}"] ` : '') +
      (hasImages ? '[Image attached] ' : '') +
      trimmedQuestion;

    remember(chatJid, 'user', historyEntry);
    remember(chatJid, 'model', result.text);

    let text = truncate(result.text, config.gemini.maxReplyChars);
    const course = referencedCourse(`${quotedText} ${trimmedQuestion}`);
    if (course || mentionsPastQuestions(`${quotedText} ${trimmedQuestion}`)) {
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
