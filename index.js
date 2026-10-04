/**
 * @local/dsh-telegram-bridge — Host half.
 *
 * Bridges one DSH session to a user-supplied Telegram bot (clean-room
 * implementation against the installed Harness APIs; shares no code with any
 * published telegram package).
 *
 * Model (v2 — no bind codes):
 * - Every Telegram user or chat (group) that messages the bot is recorded in
 *   the panel's sender list, with display name and id — including `/start`.
 * - The session owner hand-picks entries as 放行 (allowed) in the panel; the
 *   allow-list is folded from `/tg allow …` command events in the session log
 *   (restart / resume / fork all restore it).
 * - An allowed entry: its messages are injected into the session as queued
 *   user prompts, it receives forwarded session messages, and it may answer
 *   agent questions on Telegram. A not-allowed entry is only recorded.
 *
 * State ownership:
 * - Session log: `enabled` + allow-list (via the `telegramBridge` projection).
 * - Credential service: the bot token, one ref per session.
 * - Storage domain: the sender/chat address book (with token fingerprints).
 * - Runtime-only: pollers and pending questions.
 *
 * Live-session rule: message flow runs while the session is live (opened
 * since app start); a cold session's sender gets a clear reply instead of
 * silent loss.
 */
import { createHash } from 'node:crypto';
import { z } from 'zod';

const TG_API = 'https://api.telegram.org';
const POLL_TIMEOUT_S = 25;
const MSG_LIMIT = 4096;
// Inbound prompts stay text-only. This short-lived map suppresses the matching
// user/message event from being echoed back to Telegram without polluting model text.
const INBOUND_ECHO_TTL_MS = 30_000;
const PROJECTION_KEY = 'telegramBridge';
const COMMAND_NAME = 'tg';

export const inject = ['sessionController', 'commands', 'credentials', 'sessionProjections', 'storageDomain', 'sessionQuery'];

const senderSchema = z.object({
  name: z.string(),
  username: z.string().optional(),
  chatId: z.number(),
  chatType: z.string().optional(),
  chatTitle: z.string().optional(),
  count: z.number().int().nonnegative(),
  lastAt: z.number(),
  notified: z.boolean().optional(),
}).strict();

const sessionRecordSchema = z.object({
  senders: z.record(z.string(), senderSchema),
  tokenFp: z.string().optional(),
}).strict();

const projectionStateSchema = z.object({
  sessionId: z.string(),
  enabled: z.boolean(),
  allowed: z.array(z.string()),
  pending: z.object({ commandId: z.string(), op: z.string(), arg: z.string() }).strict().nullable(),
}).strict();

const viewSchema = z.object({
  enabled: z.boolean(),
  allowed: z.array(z.string()),
  tokenConfigured: z.boolean(),
  bot: z.object({ username: z.string().nullable(), running: z.boolean(), error: z.string().nullable() }).strict(),
  senders: z.array(senderSchema.extend({ id: z.string(), allowed: z.boolean() }).strict()),
  pendingQuestion: z.boolean(),
  recentInbound: z.object({
    name: z.string(),
    username: z.string().nullable(),
    at: z.number(),
    preview: z.string(),
  }).strict().nullable(),
  domainError: z.string().nullable(),
}).strict();

export function apply(ctx) {
  /** sessionId -> runtime bridge (transient fields only) */
  const bridges = new Map();
  /** token -> bot runtime */
  const bots = new Map();
  let table = null; // domain table 'sessions', once opened
  let domainError = null; // surfaced into the projection view when persistence is broken
  let disposed = false;
  let promptSeq = 0;

  const log = (level, ...args) => {
    const logger = ctx.logger;
    if (logger && typeof logger[level] === 'function') logger[level]('[telegram-bridge]', ...args);
  };

  // ---------------------------------------------------------------- helpers

  const tokenRefFor = (sessionId) =>
    'TELEGRAM_BRIDGE_BOT_TOKEN_' + String(sessionId).toUpperCase().replace(/[^A-Z0-9]/g, '_');

  const tokenFp = (token) => createHash('sha256').update(token).digest('hex').slice(0, 10);

  const bridgeOf = (sessionId) => {
    let b = bridges.get(sessionId);
    if (!b) {
      b = {
        token: null,            // last resolved token (which bot this session rides)
        tokenConfigured: false,
        pendingAsks: new Map(), // askId -> pending question state
        lastError: null,
        recentInbound: null,
        inboundEchoes: [], // { text, at } entries used only to suppress outbound echo
      };
      bridges.set(sessionId, b);
    }
    return b;
  };

  const emptyRecord = () => ({ senders: {} });

  const readRecord = (sessionId) => {
    if (!table) return emptyRecord();
    return table.get(String(sessionId)) ?? emptyRecord();
  };

  const writeRecord = async (sessionId, mutate) => {
    if (!table) return;
    const key = String(sessionId);
    const current = table.get(key) ?? emptyRecord();
    await table.put(key, mutate(current));
  };

  /** Durable (log-folded) state for one LIVE session, when the projection is live. */
  const foldedState = (sessionId) => {
    const sessions = ctx.get('sessions');
    const session = sessions?.get(sessionId);
    if (!session) return undefined;
    return ctx.sessionProjections.stateOf(session, PROJECTION_KEY);
  };

  const isEnabled = (sessionId) => foldedState(sessionId)?.enabled === true;
  const allowedOf = (sessionId) => new Set(foldedState(sessionId)?.allowed ?? []);

  /** Cold-session fallback: fold the persisted log for the /tg enable state. */
  const coldEnabled = async (sessionId) => {
    try {
      const snap = await ctx.sessionQuery.readSession(sessionId);
      const events = snap?.events ?? snap?.records ?? [];
      let enabled = false;
      const pending = new Map();
      for (const ev of events) {
        if (ev?.type === 'command/run' && ev.data?.name === COMMAND_NAME && typeof ev.data.args === 'string') {
          const op = ev.data.args.trim().split(/\s+/)[0];
          if (op === 'on' || op === 'off') pending.set(String(ev.data.commandId), op);
        } else if (ev?.type === 'command/done') {
          const op = pending.get(String(ev.data?.commandId));
          if (op) { if (ev.data.kind === 'success') enabled = op === 'on'; pending.delete(String(ev.data.commandId)); }
        }
      }
      return enabled;
    } catch {
      return false;
    }
  };

  // ------------------------------------------------------------ telegram io

  async function tgCall(token, method, payload, signal) {
    const res = await fetch(`${TG_API}/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload ?? {}),
      signal,
    });
    const data = await res.json().catch(() => null);
    if (!res.ok || !data || data.ok !== true) {
      const description = data && typeof data.description === 'string' ? data.description : `HTTP ${res.status}`;
      const error = new Error(`telegram ${method}: ${description}`);
      error.tgStatus = res.status;
      error.tgCode = data?.error_code;
      throw error;
    }
    return data.result;
  }

  async function tgSend(token, chatId, text, extra = {}) {
    // Telegram caps one message at 4096 chars; split on paragraph boundaries.
    const chunks = [];
    let rest = String(text);
    while (rest.length > MSG_LIMIT) {
      let cut = rest.lastIndexOf('\n', MSG_LIMIT);
      if (cut < MSG_LIMIT / 2) cut = MSG_LIMIT;
      chunks.push(rest.slice(0, cut));
      rest = rest.slice(cut).replace(/^\n+/, '');
    }
    chunks.push(rest);
    let first = true;
    for (const chunk of chunks) {
      await tgCall(token, 'sendMessage', { chat_id: chatId, text: chunk, ...(first ? extra : {}) });
      first = false;
    }
  }

  // ------------------------------------------------------------- bot pool

  /** Every chat currently allowed by any session riding this token. */
  function computeTargets(bot) {
    const targets = new Map(); // chatId -> Set<sessionId>
    for (const sessionId of bot.sessions) {
      for (const key of allowedOf(sessionId)) {
        const sender = readRecord(sessionId).senders[key];
        if (!sender) continue;
        let set = targets.get(sender.chatId);
        if (!set) targets.set(sender.chatId, (set = new Set()));
        set.add(String(sessionId));
      }
    }
    return targets;
  }

  /** Cold-session fallback: fold the persisted log for the allow-list. */
  const coldAllowed = async (sessionId) => {
    try {
      const snap = await ctx.sessionQuery.readSession(sessionId);
      const events = snap?.events ?? snap?.records ?? [];
      const allowed = new Set();
      const pending = new Map();
      for (const ev of events) {
        if (ev?.type === 'command/run' && ev.data?.name === COMMAND_NAME && typeof ev.data.args === 'string') {
          const parts = ev.data.args.trim().split(/\s+/);
          const op = parts[0];
          if (op === 'allow' || op === 'disallow') pending.set(String(ev.data.commandId), { op, arg: parts.slice(1).join(' ').trim() });
        } else if (ev?.type === 'command/done') {
          const p = pending.get(String(ev.data?.commandId));
          if (p) {
            if (ev.data.kind === 'success' && p.arg) {
              if (p.op === 'allow') allowed.add(p.arg); else allowed.delete(p.arg);
            }
            pending.delete(String(ev.data?.commandId));
          }
        }
      }
      return allowed;
    } catch {
      return new Set();
    }
  };

  async function ensureBot(sessionId) {
    const bridge = bridgeOf(sessionId);
    let resolved;
    try {
      resolved = await ctx.credentials.resolve(tokenRefFor(sessionId));
    } catch (error) {
      bridge.lastError = `读取 Bot Token 失败: ${error?.message ?? error}`;
      return null;
    }
    bridge.tokenConfigured = Boolean(resolved?.value);
    if (!resolved?.value) {
      releaseBot(sessionId);
      return null;
    }
    const token = resolved.value.trim();
    if (bridge.token && bridge.token !== token) releaseBot(sessionId);
    bridge.token = token;
    let bot = bots.get(token);
    if (!bot) {
      bot = {
        token,
        fp: tokenFp(token),
        username: null,
        offset: 0,
        error: null,
        sessions: new Set(),
        targets: new Map(),
        abort: new AbortController(),
        loop: null,
      };
      bots.set(token, bot);
      bot.loop = pollLoop(bot).catch((error) => {
        bot.error = error?.message ?? String(error);
        log('warn', 'poll loop crashed:', error);
      });
      tgCall(token, 'getMe', {}, AbortSignal.timeout(10000))
        .then((me) => { bot.username = me?.username ?? null; })
        .catch(() => {});
    }
    if (!bot.sessions.has(sessionId)) {
      bot.sessions.add(sessionId);
      // remember which token this session rides, for cross-restart routing;
      // also forces the domain file to materialize immediately
      writeRecord(sessionId, (record) => ({ ...record, tokenFp: bot.fp })).catch(() => {});
      bot.targets = computeTargets(bot);
    }
    return bot;
  }

  function releaseBot(sessionId) {
    const bridge = bridges.get(sessionId);
    const token = bridge?.token;
    if (!token) return;
    const bot = bots.get(token);
    bridge.token = null;
    if (!bot) return;
    bot.sessions.delete(sessionId);
    bot.targets = computeTargets(bot);
    if (bot.sessions.size === 0) {
      bot.abort.abort();
      bots.delete(token);
    }
  }

  async function pollLoop(bot) {
    const { signal } = bot.abort;
    let backoffMs = 1000;
    while (!signal.aborted) {
      try {
        const updates = await tgCall(bot.token, 'getUpdates', {
          offset: bot.offset,
          timeout: POLL_TIMEOUT_S,
          allowed_updates: ['message', 'callback_query'],
        }, AbortSignal.any([signal, AbortSignal.timeout((POLL_TIMEOUT_S + 15) * 1000)]));
        bot.error = null;
        backoffMs = 1000;
        for (const update of updates) {
          bot.offset = update.update_id + 1;
          await handleUpdate(bot, update).catch((error) => log('warn', 'update handling failed:', error));
        }
      } catch (error) {
        if (signal.aborted) return;
        bot.error = error?.tgCode === 409
          ? '另一个进程正在轮询这个 Bot（getUpdates 409 冲突），请关闭它或更换 Token。'
          : `轮询失败: ${error?.message ?? error}`;
        await new Promise((resolve) => {
          const t = setTimeout(resolve, backoffMs);
          signal.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
        });
        backoffMs = Math.min(backoffMs * 2, 30000);
      }
    }
  }

  // --------------------------------------------------------- update intake

  async function handleUpdate(bot, update) {
    if (update.callback_query) return handleCallback(bot, update.callback_query);
    const message = update.message;
    if (!message || typeof message.text !== 'string') return;
    const chat = message.chat;
    const chatId = chat.id;
    const from = message.from ?? {};
    const text = message.text;
    const senderId = String(from.id ?? chatId); // anonymous group posts fall back to the chat id
    const senderName = [from.first_name, from.last_name].filter(Boolean).join(' ')
      || from.username
      || (chat.title ? `${chat.title}` : null)
      || senderId;

    // Record this sender for EVERY session riding this bot, so the panel of a
    // freshly enabled session lists them without any /bind step.
    for (const sessionId of bot.sessions) {
      await writeRecord(sessionId, (record) => {
        const prev = record.senders[senderId];
        return {
          ...record,
          senders: {
            ...record.senders,
            [senderId]: {
              name: senderName,
              ...(from.username ? { username: String(from.username) } : {}),
              chatId,
              ...(typeof chat.type === 'string' ? { chatType: chat.type } : {}),
              ...(chat.title ? { chatTitle: String(chat.title) } : {}),
              count: (prev?.count ?? 0) + 1,
              lastAt: Date.now(),
              ...(prev?.notified ? { notified: true } : {}),
            },
          },
        };
      }).catch((error) => log('warn', 'sender record failed:', error));
    }

    if (text === '/start' || text.startsWith('/start ')) {
      const names = [...bot.sessions].length;
      await tgSend(bot.token, chatId, [
        `👋 已连接到 DSH（${names} 个会话正在使用此 Bot）。`,
        '你的身份已出现在会话的 Telegram 面板里。请会话持有人在面板中把你勾选为"放行"；放行后：',
        '· 你在这里发的消息会进入 DSH 会话',
        '· 会话消息会转发到这里',
        '· 会话提问可以在这里作答',
      ].join('\n'));
      return;
    }
    if (text === '/status' || text.startsWith('/status@')) {
      const lines = [`Bot @${bot.username ?? '?'} 在线，服务 ${bot.sessions.size} 个会话。`];
      for (const sessionId of bot.sessions) {
        lines.push(`会话 ${sessionId.slice(0, 8)}…: ${isEnabled(sessionId) ? '转发启用' : '停用'}，放行 ${allowedOf(sessionId).size} 人`);
      }
      await tgSend(bot.token, chatId, lines.join('\n'));
      return;
    }

    // Which sessions admit this sender (via this chat)? Live sessions read
    // the fold; cold sessions sharing the token fall back to a cold log read.
    const admitted = [];
    const sessionIds = bot.targets.get(chatId);
    if (sessionIds) {
      for (const sid of sessionIds) {
        if (!bot.sessions.has(sid)) continue; // cold session: fallback below
        if (allowedOf(sid).has(senderId)) admitted.push(sid);
      }
    }
    if (admitted.length === 0 && table) {
      for (const [sessionId, record] of table.entries()) {
        if (bot.sessions.has(sessionId)) continue;
        if (!record.tokenFp || record.tokenFp !== bot.fp) continue;
        const sender = record.senders[senderId];
        if (!sender || sender.chatId !== chatId) continue;
        if (!(await coldAllowed(sessionId)).has(senderId)) continue;
        if (!(await coldEnabled(sessionId))) continue;
        admitted.push(sessionId);
        break;
      }
    }

    if (admitted.length === 0) {
      // Recorded but not allowed anywhere: one-time guidance per session.
      for (const sessionId of bot.sessions) {
        const record = readRecord(sessionId);
        if (record.senders[senderId]?.notified) continue;
        await tgSend(bot.token, chatId, `已记录你的身份（${senderName}），但会话还没有放行你，消息不会进入 DSH。请让会话持有人在 Telegram 面板勾选"放行"。`);
        await writeRecord(sessionId, (r) => ({
          ...r,
          senders: { ...r.senders, [senderId]: { ...r.senders[senderId], notified: true } },
        })).catch(() => {});
      }
      return;
    }

    for (const sessionId of admitted) {
      const bridge = bridgeOf(sessionId);

      // open questions take text answers first
      let answered = false;
      for (const ask of bridge.pendingAsks.values()) {
        if (ask.settled || !ask.chatIds.includes(chatId)) continue;
        if (ask.awaitingCustom && ask.awaitingCustom.senderId !== senderId) continue;
        const idx = ask.awaitingCustom
          ? ask.awaitingCustom.qi
          : ask.slots.findIndex((slot) => !slot.done && !slot.question.options?.length);
        if (idx >= 0 && !ask.slots[idx].done) {
          answerQuestionCustom(ask, idx, text);
          answered = true;
          break;
        }
      }
      if (answered) continue;

      const enabled = isEnabled(sessionId) || await coldEnabled(sessionId);
      if (!enabled) {
        await tgSend(bot.token, chatId, '该会话的 Telegram 转发当前已停用，或会话尚未在本次启动后打开。');
        continue;
      }
      try {
        const bridge = bridgeOf(sessionId);
        const now = Date.now();
        bridge.inboundEchoes = bridge.inboundEchoes.filter((entry) => now - entry.at < INBOUND_ECHO_TTL_MS);
        bridge.inboundEchoes.push({ text, at: now });
        bridge.recentInbound = {
          name: senderName,
          username: from.username ? String(from.username) : null,
          at: now,
          preview: text.slice(0, 160),
        };
        await ctx.sessionController.prompt({
          requestId: `tg-${Date.now().toString(36)}-${promptSeq++}`,
          sessionId,
          mode: 'queue',
          content: [{ type: 'text', text }],
        }, bot.abort.signal);
        await tgSend(bot.token, chatId, '✅ 已送入 DSH 会话队列。');
      } catch (error) {
        const bridge = bridgeOf(sessionId);
        bridge.inboundEchoes = bridge.inboundEchoes.filter((entry) => !(entry.text === text && Date.now() - entry.at < INBOUND_ECHO_TTL_MS));
        await tgSend(bot.token, chatId, `❌ 注入会话失败: ${error?.message ?? error}`).catch(() => {});
      }
    }
  }

  // ------------------------------------------------------ question bridging

  async function handleCallback(bot, query) {
    const data = String(query.data ?? '');
    const fromId = String(query.from?.id ?? '');
    const chatId = query.message?.chat?.id;
    const ack = (text, alert = false) =>
      tgCall(bot.token, 'answerCallbackQuery', { callback_query_id: query.id, text, show_alert: alert }).catch(() => {});

    const match = /^tgb:([a-z0-9]+):(\d+)(?::(\d+|done|custom))?$/.exec(data);
    if (!match) return ack('已过期');
    const [, askId, qiText, action] = match;
    const qi = Number(qiText);

    let found = null;
    let foundSession = null;
    for (const sessionId of bot.sessions) {
      const ask = bridges.get(sessionId)?.pendingAsks.get(askId);
      if (ask) { found = ask; foundSession = sessionId; break; }
    }
    if (!found || found.settled) return ack('该问题已关闭');
    if (!allowedOf(foundSession).has(fromId)) return ack('仅放行的用户可在 Telegram 上作答', true);

    const slot = found.slots[qi];
    if (!slot || slot.done) return ack('该问题已作答');

    if (action === 'custom') {
      found.awaitingCustom = { qi, senderId: fromId };
      await ack('请直接在聊天里回复文本');
      return;
    }
    if (action === 'done') {
      if (slot.selected.length === 0) return ack('尚未选择任何项', true);
      slot.done = true;
      await ack(`已提交: ${slot.selected.join('、')}`);
      maybeResolveAsk(bot, found);
      return;
    }
    const option = slot.question.options?.[Number(action)];
    if (!option) return ack('参数错误');
    if (slot.question.multiSelect) {
      slot.selected = slot.selected.includes(option.label)
        ? slot.selected.filter((l) => l !== option.label)
        : [...slot.selected, option.label];
      await ack(`已选: ${slot.selected.length > 0 ? slot.selected.join('、') : '（无）'}`);
      await refreshAskKeyboard(bot, found, qi).catch(() => {});
    } else {
      slot.selected = [option.label];
      slot.done = true;
      await ack(`已选择: ${option.label}`);
      maybeResolveAsk(bot, found);
    }
  }

  function answerQuestionCustom(ask, qi, text) {
    const slot = ask.slots[qi];
    slot.custom = text;
    slot.selected = [];
    slot.done = true;
    ask.awaitingCustom = null;
    maybeResolveAsk(ask.botRef, ask);
  }

  function maybeResolveAsk(bot, ask) {
    editAskMessages(bot, ask, (slot) => {
      if (!slot.done) return null; // leave others untouched
      const choice = slot.custom !== undefined ? `回复: ${slot.custom}` : `已选: ${slot.selected.join('、')}`;
      return `✅ ${slot.question.question}\n${choice}`;
    }).catch(() => {});
    if (ask.settled || !ask.slots.every((slot) => slot.done)) return;
    ask.settled = true;
    ask.resolve({
      answers: ask.slots.map((slot) => ({
        id: slot.question.id,
        selected: slot.selected,
        ...(slot.custom !== undefined ? { custom: slot.custom } : {}),
      })),
    });
  }

  function keyboardFor(ask, qi) {
    const slot = ask.slots[qi];
    const rows = (slot.question.options ?? []).map((option, oi) => [{
      text: `${slot.selected.includes(option.label) ? '☑' : '▢'} ${option.label}`.slice(0, 60),
      callback_data: `tgb:${ask.id}:${qi}:${oi}`,
    }]);
    rows.push([{ text: '✏️ 其他（回复文本）', callback_data: `tgb:${ask.id}:${qi}:custom` }]);
    if (slot.question.multiSelect) rows.push([{ text: '✅ 提交选择', callback_data: `tgb:${ask.id}:${qi}:done` }]);
    return { inline_keyboard: rows };
  }

  async function refreshAskKeyboard(bot, ask, qi) {
    const slot = ask.slots[qi];
    for (const [chatId, messageId] of slot.messages) {
      await tgCall(bot.token, 'editMessageReplyMarkup', {
        chat_id: chatId, message_id: messageId, reply_markup: keyboardFor(ask, qi),
      }).catch(() => {});
    }
  }

  async function editAskMessages(bot, ask, renderText) {
    for (let qi = 0; qi < ask.slots.length; qi++) {
      const text = renderText(ask.slots[qi]);
      if (text === null) continue;
      for (const [chatId, messageId] of ask.slots[qi].messages) {
        await tgCall(bot.token, 'editMessageText', {
          chat_id: chatId, message_id: messageId, text: text.slice(0, MSG_LIMIT),
        }).catch(() => {});
      }
    }
  }

  /** Offer the question batch on Telegram; resolves the answer batch. */
  async function askViaTelegram(sessionId, bot, request) {
    const bridge = bridgeOf(sessionId);
    const targetChatIds = [];
    for (const [chatId, sessionSet] of bot.targets) {
      if (sessionSet.has(String(sessionId))) targetChatIds.push(chatId);
    }
    const askId = Math.random().toString(36).slice(2, 8);
    const ask = {
      id: askId,
      botRef: bot,
      chatIds: targetChatIds,
      slots: request.questions.map((question) => ({ question, selected: [], custom: undefined, done: false, messages: new Map() })),
      awaitingCustom: null,
      settled: false,
      resolve: null,
      reject: null,
    };
    const promise = new Promise((resolve, reject) => { ask.resolve = resolve; ask.reject = reject; });
    bridge.pendingAsks.set(askId, ask);

    const finish = (reason) => {
      bridge.pendingAsks.delete(askId);
      editAskMessages(bot, ask, (slot) => slot.done ? null : `⛔ ${slot.question.question}\n（${reason}）`).catch(() => {});
    };
    promise.then(() => finish('已结束'), () => finish('已结束'));

    try {
      for (const [qi, slot] of ask.slots.entries()) {
        const q = slot.question;
        const body = [
          '❓ DSH 会话提问' + (q.header ? `（${q.header}）` : ''),
          '',
          q.question,
          ...(q.detail ? ['', q.detail.slice(0, 1500)] : []),
          '',
          q.options?.length ? '请点击下方选项，或点「其他」回复文本：' : '请直接回复文本作答：',
        ].join('\n');
        for (const chatId of targetChatIds) {
          const sent = await tgCall(bot.token, 'sendMessage', {
            chat_id: chatId,
            text: body.slice(0, MSG_LIMIT),
            ...(q.options?.length ? { reply_markup: keyboardFor(ask, qi) } : {}),
          });
          slot.messages.set(chatId, sent.message_id);
        }
      }
    } catch (error) {
      bridge.pendingAsks.delete(askId);
      throw error;
    }

    request.signal?.addEventListener('abort', () => {
      if (ask.settled) return;
      ask.settled = true;
      ask.reject(Object.assign(new Error('telegram question wait aborted'), { name: 'AbortError' }));
    }, { once: true });

    return promise;
  }

  // -------------------------------------------------------- event bridges

  // Outbound: committed session messages -> chats whose sender entry is allowed.
  ctx.on('session/event', (session, event) => {
    const sessionId = session.id;
    if (!isEnabled(sessionId)) return;
    const bridge = bridges.get(sessionId);
    const bot = bridge?.token ? bots.get(bridge.token) : undefined;
    if (!bot) return;
    const allowed = allowedOf(sessionId);
    if (allowed.size === 0) return;
    const record = readRecord(sessionId);
    const chatIds = [...new Set([...allowed].map((key) => record.senders[key]?.chatId).filter((v) => v !== undefined))];
    if (chatIds.length === 0) return;

    let prefix = null;
    let text = null;
    if (event.type === 'user/message') {
      if (event.data.source?.kind !== 'user') return; // skip structured question replies etc.
      text = (event.data.content ?? []).filter((b) => b?.type === 'text').map((b) => b.text).join('\n').trim();
      if (!text) return;
      // The injected prompt is intentionally plain text. Consume one matching
      // short-lived entry instead of relying on a visible marker in the prompt.
      if (bridge.inboundEchoes?.length) {
        const now = Date.now();
        bridge.inboundEchoes = bridge.inboundEchoes.filter((entry) => now - entry.at < INBOUND_ECHO_TTL_MS);
        const echoIndex = bridge.inboundEchoes.findIndex((entry) => entry.text === text);
        if (echoIndex >= 0) {
          bridge.inboundEchoes.splice(echoIndex, 1);
          return;
        }
      }
      prefix = '👤 用户:';
    } else if (event.type === 'assistant/message') {
      text = (event.data.message?.content ?? []).filter((b) => b?.type === 'text').map((b) => b.text).join('\n').trim();
      if (!text) return;
      prefix = '🤖 助手:';
    } else {
      return;
    }
    for (const chatId of chatIds) {
      tgSend(bot.token, chatId, `${prefix}\n${text}`).catch((error) => {
        bridge.lastError = `转发失败: ${error?.message ?? error}`;
        log('warn', 'forward failed:', error);
      });
    }
  }, { global: true });

  // Questions: offer ask_user_question batches on Telegram in parallel with
  // the DSH UI; the first side to settle wins.
  ctx.on('user-questions/request', async (request, next) => {
    const sessionId = request.agent?.id;
    if (!sessionId) return next();
    if (!isEnabled(sessionId)) return next();
    if (allowedOf(sessionId).size === 0) return next();
    const bridge = bridges.get(sessionId);
    const bot = bridge?.token ? bots.get(bridge.token) : undefined;
    if (!bot) return next();
    const hasTarget = [...bot.targets.values()].some((set) => set.has(String(sessionId)));
    if (!hasTarget) return next();

    const tgPromise = askViaTelegram(sessionId, bot, request)
      .then((v) => ({ ok: true, side: 'tg', v }), (e) => ({ ok: false, side: 'tg', e }));
    let uiPromise;
    try {
      uiPromise = Promise.resolve(next()).then((v) => ({ ok: true, side: 'ui', v }), (e) => ({ ok: false, side: 'ui', e }));
    } catch (error) {
      uiPromise = Promise.resolve({ ok: false, side: 'ui', e: error });
    }
    const first = await Promise.race([tgPromise, uiPromise]);
    if (first.ok) return first.v;
    const second = await (first.side === 'tg' ? uiPromise : tgPromise);
    if (second.ok) return second.v;
    throw first.e;
  }, { global: true });

  // A live session whose fold says "enabled" rides a poller.
  const reconcile = async (sessionId) => {
    if (disposed) return;
    if (isEnabled(sessionId)) {
      const bot = await ensureBot(sessionId);
      if (bot) bot.targets = computeTargets(bot);
    } else {
      releaseBot(sessionId);
    }
  };

  ctx.on('session/created', (session) => {
    try { ctx.sessionProjections.stateOf(session, PROJECTION_KEY); } catch { /* fold not ready */ }
    reconcile(session.id).catch((error) => log('warn', 'reconcile failed:', error));
  }, { global: true });

  ctx.on('session/disposed', (session) => {
    const bridge = bridges.get(session.id);
    if (!bridge) return;
    for (const ask of bridge.pendingAsks.values()) {
      if (!ask.settled) {
        ask.settled = true;
        ask.reject(new Error('session disposed'));
      }
    }
    bridge.pendingAsks.clear();
    releaseBot(session.id);
  }, { global: true });

  ctx.sessionProjections.onChanged((session, key) => {
    if (key !== PROJECTION_KEY) return;
    reconcile(session.id).catch((error) => log('warn', 'reconcile failed:', error));
  });

  ctx.on('credentials/reference-updated', (ref) => {
    for (const [sessionId, bridge] of bridges) {
      if (tokenRefFor(sessionId) !== ref) continue;
      bridge.token = null; // force re-resolve on next reconcile
      reconcile(sessionId).catch((error) => log('warn', 'reconcile failed:', error));
    }
  });

  // ------------------------------------------------------------- commands

  ctx.inject(['commands'], (commandCtx) => {
    commandCtx.commands.register({
      definitionId: '@local/dsh-telegram-bridge',
      name: COMMAND_NAME,
      description: 'Telegram 桥接：/tg on 启用转发，/tg off 停用，/tg allow <发送者ID> 放行，/tg disallow <发送者ID> 取消放行，/tg status 查看状态。',
      input: { hint: 'on|off|status|allow <id>|disallow <id>' },
      handler: async ({ agent, rawInput }) => {
        const sessionId = agent.id;
        const bridge = bridgeOf(sessionId);
        const [op, ...restParts] = rawInput.trim().split(/\s+/).filter(Boolean);
        const rest = restParts.join(' ').trim();

        if (!op || op === 'status') {
          const record = readRecord(sessionId);
          const allowed = [...allowedOf(sessionId)];
          return {
            kind: 'success',
            text: [
              `Telegram 桥接: ${isEnabled(sessionId) ? '✅ 启用' : '⛔ 停用'}`,
              `Bot Token: ${bridge.tokenConfigured ? '已配置' : '未配置（在会话的 Telegram 面板中填写）'}`,
              `已放行: ${allowed.length > 0 ? allowed.join(', ') : '（无 — 只有放行用户的消息会注入会话并接收转发）'}`,
              `已记录发送者: ${Object.keys(record.senders).length} 位`,
            ].join('\n'),
          };
        }
        if (op === 'on') {
          let info;
          try {
            info = await ctx.credentials.describe(tokenRefFor(sessionId));
          } catch (error) {
            return { kind: 'error', text: `读取凭据失败: ${error?.message ?? error}` };
          }
          bridge.tokenConfigured = info.configured;
          if (!info.configured) {
            return { kind: 'error', text: '尚未配置 Bot Token。请在会话输入框下方的 Telegram 面板里粘贴 Bot Token 并保存。' };
          }
          // validate the token before admitting the enable, so the fold only
          // commits working setups
          const resolved = await ctx.credentials.resolve(tokenRefFor(sessionId));
          try {
            const me = await tgCall(resolved.value.trim(), 'getMe', {}, AbortSignal.timeout(10000));
            const bot = await ensureBot(sessionId);
            if (bot) bot.username = me?.username ?? bot.username;
            return {
              kind: 'success',
              text: `Telegram 转发已启用（Bot @${me?.username ?? '?'}）。让协作者给 Bot 发条消息（/start 即可），他们会出现在面板的发送者列表里，勾选"放行"后即可双向互通。`,
            };
          } catch (error) {
            return { kind: 'error', text: `无法连接 Telegram 或 Token 无效: ${error?.message ?? error}` };
          }
        }
        if (op === 'off') {
          releaseBot(sessionId);
          return { kind: 'success', text: 'Telegram 转发已停用（发送者记录保留）。' };
        }
        if (op === 'allow' || op === 'disallow') {
          if (!rest) return { kind: 'error', text: `用法: /tg ${op} <发送者ID>。ID 见面板发送者列表。` };
          const known = readRecord(sessionId).senders[rest];
          const verb = op === 'allow' ? '已放行' : '已取消放行';
          return {
            kind: 'success',
            text: `${verb}: ${known ? `${known.name} (${rest})` : rest}${known ? '' : '（注意: 该 ID 尚未给 Bot 发过消息）'}`,
          };
        }
        return { kind: 'error', text: `未知子命令 "${op}"。可用: on | off | status | allow <id> | disallow <id>` };
      },
    });
  });

  // ----------------------------------------------------------- projection

  ctx.sessionProjections.register({
    key: PROJECTION_KEY,
    stateVersion: 2,
    stateSchema: projectionStateSchema,
    init: (header) => ({ sessionId: String(header.id), enabled: false, allowed: [], pending: null }),
    apply: (state, event) => {
      if (event.type === 'command/run' && event.data.name === COMMAND_NAME) {
        if (event.data.args === undefined) return state;
        const [op, ...restParts] = event.data.args.trim().split(/\s+/).filter(Boolean);
        if (!['on', 'off', 'allow', 'disallow'].includes(op)) return state;
        return { ...state, pending: { commandId: String(event.data.commandId), op, arg: restParts.join(' ').trim() } };
      }
      if (event.type === 'command/done' && state.pending && String(event.data.commandId) === state.pending.commandId) {
        const { pending } = state;
        if (event.data.kind !== 'success') return { ...state, pending: null };
        if (pending.op === 'on') return { ...state, pending: null, enabled: true };
        if (pending.op === 'off') return { ...state, pending: null, enabled: false };
        if (pending.op === 'allow' && pending.arg && !state.allowed.includes(pending.arg)) {
          return { ...state, pending: null, allowed: [...state.allowed, pending.arg].sort() };
        }
        if (pending.op === 'disallow') {
          return { ...state, pending: null, allowed: state.allowed.filter((id) => id !== pending.arg) };
        }
        return { ...state, pending: null };
      }
      return state;
    },
    wire: {
      viewSchema,
      view: (state) => {
        const sessionId = state.sessionId;
        const bridge = bridges.get(sessionId);
        const record = readRecord(sessionId);
        const bot = bridge?.token ? bots.get(bridge.token) : undefined;
        const allowed = new Set(state.allowed);
        return {
          enabled: state.enabled,
          allowed: state.allowed,
          tokenConfigured: bridge?.tokenConfigured ?? false,
          bot: {
            username: bot?.username ?? null,
            running: Boolean(bot && !bot.abort.signal.aborted),
            error: bot?.error ?? bridge?.lastError ?? null,
          },
          senders: Object.entries(record.senders)
            .map(([id, s]) => ({
              id,
              name: s.name,
              ...(s.username ? { username: s.username } : {}),
              chatId: s.chatId,
              ...(s.chatType ? { chatType: s.chatType } : {}),
              ...(s.chatTitle ? { chatTitle: s.chatTitle } : {}),
              count: s.count,
              lastAt: s.lastAt,
              allowed: allowed.has(id),
            }))
            .sort((a, b) => b.lastAt - a.lastAt),
          pendingQuestion: Boolean(bridge && [...bridge.pendingAsks.values()].some((a) => !a.settled)),
          recentInbound: bridge?.recentInbound ?? null,
          domainError,
        };
      },
    },
  });

  // -------------------------------------------------------------- startup

  // NOTE: domain/unit names must match /^[a-z][a-z0-9_]*$/ — no dashes.
  const openDomain = async () => {
    // Re-activation can race the previous fiber's close; retry briefly.
    let lastError;
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        const domain = await ctx.storageDomain.open({
          name: 'telegram_bridge',
          version: 2,
          compatibleVersions: [1],
          invalidRecords: 'backup-and-skip',
          tables: { sessions: { valueSchema: sessionRecordSchema } },
        });
        if (disposed) { await domain.close(); return; }
        table = domain.table('sessions');
        domainError = null;
        ctx.effect(() => () => { table = null; void domain.close(); }, 'telegram-bridge: close domain');
        // rebuild forwarding routes now that the address book is readable
        for (const bot of bots.values()) bot.targets = computeTargets(bot);
        return;
      } catch (error) {
        lastError = error;
        log('warn', `storage domain open attempt ${attempt + 1} failed:`, error?.message ?? error);
        await new Promise((resolve) => setTimeout(resolve, 800 * (attempt + 1)));
        if (disposed) return;
      }
    }
    domainError = `存储域不可用: ${lastError?.message ?? lastError}（发送者记录不会持久化）`;
    log('warn', 'storage domain unavailable, running memory-only:', lastError?.message ?? lastError);
  };
  void openDomain().then(() => {
    // After a reload/HMR, already-live enabled sessions get no session/created
    // event — scan and reattach them here.
    const sessions = ctx.get('sessions');
    for (const session of sessions?.list?.() ?? []) {
      try { ctx.sessionProjections.stateOf(session, PROJECTION_KEY); } catch { /* fold not ready */ }
      reconcile(session.id).catch((error) => log('warn', 'reconcile failed:', error));
    }
  });

  ctx.effect(() => () => {
    disposed = true;
    for (const bot of bots.values()) bot.abort.abort();
    bots.clear();
    for (const bridge of bridges.values()) {
      for (const ask of bridge.pendingAsks.values()) {
        if (!ask.settled) { ask.settled = true; ask.reject(new Error('plugin unloaded')); }
      }
    }
    bridges.clear();
  }, 'telegram-bridge: shutdown');
}
