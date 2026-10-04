/**
 * @local/dsh-telegram-bridge — Client half (plain JS, no JSX).
 *
 * Two slot contributions:
 * - `sidebar.workspaces.session.menu.item`: one "…" menu row per session
 *   that opens the session and expands the bridge panel.
 * - `conversation.composer.dock`: the bridge panel itself (collapsed status
 *   bar + expandable details) scoped to the open session.
 *
 * v2 model (no bind codes): the panel lists every Telegram user/chat that
 * has messaged the bot (name + id); checking 放行 (allow) — logged as
 * `/tg allow <id>` — lets that sender inject prompts into the session,
 * receive forwarded messages, and answer questions on Telegram.
 *
 * Host channels: actions go through `remote.commands.execute` (`/tg …`,
 * durably logged) and `remote.credentials` (the per-session bot token, never
 * logged); state arrives through the `telegramBridge` session projection,
 * re-read on a light poll because parts of the view (bot status, senders)
 * are runtime-derived.
 */
// HMR marker: force the browser client bundle to re-evaluate after plugin graph changes.
window.__ModuleLoader__.load({
  id: '@local/dsh-telegram-bridge',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const NS = 'dshTelegramBridge';
    const PROJECTION_KEY = 'telegramBridge';

    const DICTS = {
      en: {
        'menu.open': 'Telegram bridge…',
        'bar.title': 'Telegram',
        'state.off': 'disabled',
        'state.on': 'enabled',
        'state.noToken': 'no token',
        'state.error': 'error',
        'summary.senders': '{n} senders',
        'summary.allowed': '{m} allowed',
        'token.configured': 'Bot token saved',
        'token.placeholder': 'Paste the BotFather token, e.g. 123456:ABC-DEF…',
        'token.save': 'Save token',
        'token.clear': 'Clear',
        'token.edit': 'Edit',
        'toggle.on': 'Enable forwarding',
        'toggle.off': 'Disable',
        'enable.hint': 'Enable forwarding, then anyone who messages the bot appears below.',
        'senders.title': 'People & chats that messaged the bot — check "allow" to let their messages enter this session:',
        'senders.empty': 'Nobody has messaged the bot yet. Open your bot in Telegram and send /start.',
        'senders.allowed': 'allowed',
        'senders.kind.group': 'group',
        'senders.kind.channel': 'channel',
        'question.pending': 'A question is waiting on Telegram…',
        'recent.inbound': 'Latest Telegram message',
        'action.error': 'Action failed',
        'bot.online': 'polling',
        'bot.offline': 'not polling',
        'count.msg': '{n} msgs',
      },
      zh: {
        'menu.open': 'Telegram 桥接…',
        'bar.title': 'Telegram',
        'state.off': '未启用',
        'state.on': '已启用',
        'state.noToken': '未配置 Token',
        'state.error': '出错',
        'summary.senders': '{n} 位发送者',
        'summary.allowed': '{m} 位已放行',
        'token.configured': '已保存 Bot Token',
        'token.placeholder': '粘贴 BotFather 给的 Token，如 123456:ABC-DEF…',
        'token.save': '保存 Token',
        'token.clear': '清除',
        'token.edit': '修改',
        'toggle.on': '启用转发',
        'toggle.off': '停用',
        'enable.hint': '启用转发后，任何给 Bot 发过消息的人都会出现在下方列表。',
        'senders.title': '给 Bot 发过消息的用户/群聊（勾选"放行"后其消息进入本会话并接收转发）：',
        'senders.empty': '还没有人给 Bot 发过消息。在 Telegram 里打开你的 Bot 发送 /start 试试。',
        'senders.allowed': '已放行',
        'senders.kind.group': '群聊',
        'senders.kind.channel': '频道',
        'question.pending': '有一个提问正在 Telegram 上等待回答…',
        'recent.inbound': '最近收到的 Telegram 消息',
        'action.error': '操作失败',
        'bot.online': '轮询中',
        'bot.offline': '未轮询',
        'count.msg': '{n} 条',
      },
    };
    DICTS['zh-CN'] = DICTS.zh;

    // --- expand requests cross from the (root-scoped) menu item to the
    // (session-scoped) dock panel through this module-local bus.
    const expandListeners = new Map(); // sessionId -> Set<fn>
    let pendingExpand = null;
    const busSubscribe = (sessionId, fn) => {
      let set = expandListeners.get(sessionId);
      if (!set) expandListeners.set(sessionId, (set = new Set()));
      set.add(fn);
      return () => { set.delete(fn); };
    };
    const busRequestExpand = (sessionId) => {
      pendingExpand = sessionId;
      const set = expandListeners.get(sessionId);
      if (set) for (const fn of set) fn();
    };

    const tokenRefFor = (sessionId) =>
      'TELEGRAM_BRIDGE_BOT_TOKEN_' + String(sessionId).toUpperCase().replace(/[^A-Z0-9]/g, '_');

    const fmtTime = (ts) => {
      try { return new Date(ts).toLocaleString(); } catch { return ''; }
    };

    return {
      inject: ['slots', 'locale', 'remote', 'remote.commands', 'remote.credentials', 'remote.session', 'uiWorkspace'],
      apply(ctx) {
        for (const [locale, dict] of Object.entries(DICTS)) {
          try { ctx.locale.register(NS, locale, dict); } catch { /* unknown locale id */ }
        }
        let t0;
        try { t0 = ctx.locale.bind(NS); } catch { t0 = (key) => key; }
        const t = (key, vars) => {
          // Defensive: if the host locale service lacks our namespace or key,
          // fall back to this package's own tables — text must never render
          // empty or as a bare dotted key.
          let text;
          try { text = t0(key); } catch { text = undefined; }
          if (typeof text !== 'string' || text === '' || text === key) {
            let localeId;
            try {
              const snap = ctx.locale.getLocale?.() ?? ctx.locale.getSnapshot?.();
              localeId = snap?.locale ?? snap?.id;
            } catch { localeId = undefined; }
            const dict = (typeof localeId === 'string' && localeId.startsWith('zh')) ? DICTS.zh : DICTS.en;
            text = dict[key] ?? key;
          }
          if (vars) for (const [k, v] of Object.entries(vars)) text = text.replace(`{${k}}`, String(v));
          return text;
        };

        const execTg = async (sessionId, line) => {
          try {
            const r = await ctx.remote.commands.execute(sessionId, `/tg ${line}`, []);
            if (!r || r.ok === false) return { ok: false, text: r?.error?.message ?? 'RPC failed' };
            const exec = r.value;
            if (!exec) return { ok: false, text: 'command not registered (host half not running?)' };
            return { ok: exec.result.kind === 'success', text: exec.result.text ?? '' };
          } catch (error) {
            return { ok: false, text: error?.message ?? String(error) };
          }
        };

        // ------------------------------------------------------ dock panel

        function SenderRow(props) {
          const { sender, busy, onToggle } = props;
          const kind = sender.chatType === 'group' || sender.chatType === 'supergroup'
            ? h('span', { className: 'dsg-tg-kind' }, t('senders.kind.group'))
            : sender.chatType === 'channel'
              ? h('span', { className: 'dsg-tg-kind' }, t('senders.kind.channel'))
              : null;
          return h('div', { className: 'dsg-tg-sender' },
            h('label', { className: 'dsg-tg-sender-main' },
              h('input', {
                type: 'checkbox',
                checked: sender.allowed,
                disabled: busy,
                onChange: () => onToggle(sender),
              }),
              h('span', { className: 'dsg-tg-sender-name' }, sender.name),
              sender.username ? h('span', { className: 'dsg-tg-sender-username' }, `@${sender.username}`) : null,
              kind,
              sender.chatTitle ? h('span', { className: 'dsg-tg-dim' }, `(${sender.chatTitle})`) : null,
            ),
            h('span', { className: 'dsg-tg-sender-id' }, `id:${sender.id} · chat:${sender.chatId}`),
            h('span', { className: 'dsg-tg-sender-meta' }, `${t('count.msg', { n: sender.count })} · ${fmtTime(sender.lastAt)}`),
            sender.allowed ? h('span', { className: 'dsg-tg-badge dsg-tg-badge-allowed' }, t('senders.allowed')) : null,
          );
        }

        function TelegramDock(props) {
          const sessionId = props.sessionId;
          const [expanded, setExpanded] = React.useState(false);
          const [view, setView] = React.useState(null);
          const [tokenDraft, setTokenDraft] = React.useState('');
          const [tokenEditing, setTokenEditing] = React.useState(false);
          const [tokenConfigured, setTokenConfigured] = React.useState(null);
          const [busy, setBusy] = React.useState(false);
          const [note, setNote] = React.useState(null);

          // live projection value (when the slot provides the hook)
          const live = typeof props.useProjection === 'function' ? props.useProjection(PROJECTION_KEY) : undefined;
          React.useEffect(() => {
            if (live && typeof live === 'object') setView(live.enabled !== undefined ? live : (live[PROJECTION_KEY] ?? null));
          }, [live]);

          // polling refresh (the view carries runtime state: bot status, senders)
          const refresh = React.useCallback(async () => {
            try {
              const r = await ctx.remote.session.projections({ sessionId });
              const v = r && r.ok === false ? null : (r?.value ?? r);
              const values = v?.values;
              if (values && values[PROJECTION_KEY]) setView(values[PROJECTION_KEY]);
            } catch { /* session cold or host busy */ }
          }, [sessionId]);
          React.useEffect(() => {
            refresh();
            const id = setInterval(refresh, expanded ? 3000 : 12000);
            return () => clearInterval(id);
          }, [refresh, expanded]);

          // token state
          const refreshToken = React.useCallback(async () => {
            try {
              const ref = tokenRefFor(sessionId);
              const r = await ctx.remote.credentials.describe([ref]);
              const info = r && r.ok === false ? null : (r?.value ?? r)?.[ref];
              setTokenConfigured(Boolean(info?.configured));
            } catch { setTokenConfigured(null); }
          }, [sessionId]);
          React.useEffect(() => { refreshToken(); }, [refreshToken]);

          // expand requests from the session menu
          React.useEffect(() => {
            if (pendingExpand === sessionId) {
              pendingExpand = null;
              setExpanded(true);
            }
            return busSubscribe(sessionId, () => setExpanded(true));
          }, [sessionId]);

          const act = async (line, okNote) => {
            setBusy(true);
            setNote(null);
            const r = await execTg(sessionId, line);
            setBusy(false);
            setNote({ ok: r.ok, text: r.text || (r.ok ? (okNote ?? 'OK') : t('action.error')) });
            refresh();
          };

          const saveToken = async () => {
            const value = tokenDraft.trim();
            if (!value) return;
            setBusy(true);
            try {
              await ctx.remote.credentials.set(tokenRefFor(sessionId), value);
              setTokenDraft('');
              setTokenEditing(false);
              setNote({ ok: true, text: t('token.configured') });
            } catch (error) {
              setNote({ ok: false, text: error?.message ?? String(error) });
            }
            setBusy(false);
            refreshToken();
          };

          const clearToken = async () => {
            setBusy(true);
            try { await ctx.remote.credentials.unset(tokenRefFor(sessionId)); } catch { /* best effort */ }
            setBusy(false);
            setTokenEditing(false);
            refreshToken();
          };

          const enabled = view?.enabled === true;
          const configured = tokenConfigured === true;
          const bot = view?.bot ?? { username: null, running: false, error: null };
          const senders = view?.senders ?? [];
          const allowedCount = (view?.allowed ?? []).length;

          const stateText = !configured ? t('state.noToken')
            : bot.error ? t('state.error')
            : enabled ? t('state.on') : t('state.off');

          const bar = h('button', {
            type: 'button',
            className: 'dsg-tg-bar',
            onClick: () => setExpanded(!expanded),
            'aria-expanded': expanded,
          },
            h('span', { className: 'dsg-tg-plane' }, '✈'),
            h('span', { className: 'dsg-tg-bar-title' }, t('bar.title')),
            h('span', {
              className: 'dsg-tg-badge ' + (!configured ? 'dsg-tg-badge-warn' : bot.error ? 'dsg-tg-badge-error' : enabled ? 'dsg-tg-badge-on' : 'dsg-tg-badge-off'),
            }, stateText),
            bot.username ? h('span', { className: 'dsg-tg-bar-bot' }, `@${bot.username}`) : null,
            enabled ? h('span', { className: 'dsg-tg-bar-counts' },
              `${t('summary.senders', { n: senders.length })} · ${t('summary.allowed', { m: allowedCount })}`) : null,
            h('span', { className: 'dsg-tg-caret' }, expanded ? '▾' : '▸'),
          );

          if (!expanded) return h('div', { className: 'dsg-tg-root' }, bar, h('style', { dangerouslySetInnerHTML: { __html: CSS } }));

          const details = h('div', { className: 'dsg-tg-details' },
            // status / error
            bot.error ? h('div', { className: 'dsg-tg-error' }, bot.error) : null,
            view?.domainError ? h('div', { className: 'dsg-tg-error' }, view.domainError) : null,
            view?.pendingQuestion ? h('div', { className: 'dsg-tg-pending' }, t('question.pending')) : null,

            // token row
            h('div', { className: 'dsg-tg-row' },
              h('span', { className: 'dsg-tg-label' }, 'Bot Token'),
              configured && !tokenEditing
                ? h(React.Fragment, null,
                    h('span', { className: 'dsg-tg-dim' }, t('token.configured')),
                    h('button', { type: 'button', className: 'dsg-tg-btn', disabled: busy, onClick: () => setTokenEditing(true) }, t('token.edit')),
                    h('button', { type: 'button', className: 'dsg-tg-btn', disabled: busy, onClick: clearToken }, t('token.clear')),
                  )
                : h(React.Fragment, null,
                    h('input', {
                      className: 'dsg-tg-input',
                      type: 'password',
                      placeholder: t('token.placeholder'),
                      value: tokenDraft,
                      disabled: busy,
                      onChange: (e) => setTokenDraft(e.target.value),
                      onKeyDown: (e) => { if (e.key === 'Enter') saveToken(); },
                    }),
                    h('button', { type: 'button', className: 'dsg-tg-btn dsg-tg-btn-primary', disabled: busy || !tokenDraft.trim(), onClick: saveToken }, t('token.save')),
                  ),
            ),

            // enable row
            h('div', { className: 'dsg-tg-row' },
              h('button', {
                type: 'button',
                className: 'dsg-tg-btn ' + (enabled ? '' : 'dsg-tg-btn-primary'),
                disabled: busy,
                onClick: () => act(enabled ? 'off' : 'on'),
              }, enabled ? t('toggle.off') : t('toggle.on')),
              bot.username ? h('span', { className: 'dsg-tg-dim' }, `@${bot.username} · ${bot.running ? t('bot.online') : t('bot.offline')}`) : null,
              !enabled ? h('span', { className: 'dsg-tg-dim' }, t('enable.hint')) : null,
            ),

            // action feedback
            note ? h('div', { className: note.ok ? 'dsg-tg-note' : 'dsg-tg-error' }, note.text) : null,

            // senders
            view?.recentInbound ? h('div', { className: 'dsg-tg-recent' },
               h('span', { className: 'dsg-tg-senders-title' }, t('recent.inbound') + ': '),
               h('strong', null, view.recentInbound.name),
               view.recentInbound.username ? h('span', { className: 'dsg-tg-sender-username' }, ` @${view.recentInbound.username}`) : null,
               h('span', { className: 'dsg-tg-dim' }, ` · ${fmtTime(view.recentInbound.at)}`),
               h('div', { className: 'dsg-tg-recent-preview' }, view.recentInbound.preview),
             ) : null,

             h('div', { className: 'dsg-tg-senders-title' }, t('senders.title')),
            senders.length === 0
              ? h('div', { className: 'dsg-tg-dim' }, t('senders.empty'))
              : h('div', { className: 'dsg-tg-senders' },
                  senders.map((sender) => h(SenderRow, {
                    key: sender.id,
                    sender,
                    busy,
                    onToggle: (s) => act(`${s.allowed ? 'disallow' : 'allow'} ${s.id}`),
                  })),
                ),
          );

          return h('div', { className: 'dsg-tg-root' }, bar, details, h('style', { dangerouslySetInnerHTML: { __html: CSS } }));
        }

        // ------------------------------------------------------ menu item

        function TelegramMenuItem(props) {
          const openState = typeof props.hooks?.menuOpenState === 'function' ? props.hooks.menuOpenState() : null;
          const closeMenu = () => {
            try {
              if (Array.isArray(openState) && typeof openState[1] === 'function') openState[1](false);
              else if (openState && typeof openState.close === 'function') openState.close();
            } catch { /* menu closes on its own */ }
          };
          return h('button', {
            type: 'button',
            role: 'menuitem',
            className: 'dsg-tg-menuitem',
            onClick: () => {
              busRequestExpand(props.sessionId);
              try { ctx.get('uiWorkspace')?.openSession(props.sessionId); } catch { /* session opens via default row click */ }
              closeMenu();
            },
          },
            h('span', { className: 'dsg-tg-menuitem-icon', 'aria-hidden': true }, '✈'),
            h('span', null, t('menu.open')),
            h('style', { dangerouslySetInnerHTML: { __html: MENU_CSS } }));
        }

        ctx.slots.inject('conversation.composer.dock', () =>
          ctx.slots.register({ name: 'conversation.composer.dock', id: 'telegram-bridge', order: 40 }, TelegramDock));
        ctx.slots.inject('sidebar.workspaces.session.menu.item', () =>
          ctx.slots.register({ name: 'sidebar.workspaces.session.menu.item', id: 'telegram-bridge', order: 350, label: () => t('menu.open') }, TelegramMenuItem));
      },
    };
  },
});

// Theme-token-only styling (see --dsw-alias-* palette); layout copied from
// host dock rows so the panel reads as part of the composer.
const CSS = `
.dsg-tg-root { display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: var(--dsw-alias-label-primary); }
.dsg-tg-bar { display: flex; align-items: center; gap: 8px; width: 100%; padding: 4px 8px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 8px; background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); cursor: pointer; text-align: left; }
.dsg-tg-bar:hover { background: var(--dsw-alias-bg-layer-2); }
.dsg-tg-plane { font-size: 13px; }
.dsg-tg-bar-title { font-weight: 600; }
.dsg-tg-bar-bot { color: var(--dsw-alias-label-secondary); }
.dsg-tg-bar-counts { color: var(--dsw-alias-label-secondary); margin-left: auto; }
.dsg-tg-caret { margin-left: auto; color: var(--dsw-alias-label-secondary); }
.dsg-tg-bar-counts + .dsg-tg-caret { margin-left: 0; }
.dsg-tg-badge { padding: 0 6px; border-radius: 999px; font-size: 11px; line-height: 18px; white-space: nowrap; }
.dsg-tg-badge-on { color: var(--dsw-alias-state-success-primary); border: 1px solid var(--dsw-alias-state-success-primary); }
.dsg-tg-badge-off { color: var(--dsw-alias-state-idle-primary); border: 1px solid var(--dsw-alias-border-l2); }
.dsg-tg-badge-warn { color: var(--dsw-alias-state-warn-primary); border: 1px solid var(--dsw-alias-state-warn-primary); }
.dsg-tg-badge-error { color: var(--dsw-alias-state-error-primary); border: 1px solid var(--dsw-alias-state-error-primary); }
.dsg-tg-badge-allowed { color: var(--dsw-alias-brand-primary); border: 1px solid var(--dsw-alias-brand-primary); }
.dsg-tg-details { display: flex; flex-direction: column; gap: 8px; padding: 8px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 8px; background: var(--dsw-alias-bg-layer-1); }
.dsg-tg-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.dsg-tg-label { font-weight: 600; min-width: 72px; }
.dsg-tg-input { flex: 1; min-width: 180px; padding: 4px 8px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 6px; background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary); font-size: 12px; }
.dsg-tg-btn { padding: 3px 10px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 6px; background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); cursor: pointer; font-size: 12px; }
.dsg-tg-btn:hover { border-color: var(--dsw-alias-brand-primary); }
.dsg-tg-btn:disabled { opacity: 0.5; cursor: default; }
.dsg-tg-btn-primary { border-color: var(--dsw-alias-brand-primary); color: var(--dsw-alias-brand-primary); background: transparent; font-weight: 600; }
.dsg-tg-btn-primary:hover { background: var(--dsw-alias-bg-layer-2); }
.dsg-tg-error { color: var(--dsw-alias-state-error-primary); white-space: pre-wrap; }
.dsg-tg-note { color: var(--dsw-alias-state-success-primary); white-space: pre-wrap; }
.dsg-tg-pending { color: var(--dsw-alias-state-warn-primary); }
.dsg-tg-dim { color: var(--dsw-alias-label-secondary); }
.dsg-tg-kind { padding: 0 4px; border-radius: 4px; background: var(--dsw-alias-bg-layer-2); border: 1px solid var(--dsw-alias-border-l1); color: var(--dsw-alias-label-secondary); font-size: 10px; }
.dsg-tg-senders-title { color: var(--dsw-alias-label-secondary); }
.dsg-tg-recent { padding: 6px 8px; border-left: 2px solid var(--dsw-alias-brand-primary); background: var(--dsw-alias-bg-layer-2); }
.dsg-tg-recent-preview { margin-top: 3px; color: var(--dsw-alias-label-primary); white-space: pre-wrap; overflow-wrap: anywhere; }
.dsg-tg-senders { display: flex; flex-direction: column; gap: 2px; max-height: 220px; overflow-y: auto; }
.dsg-tg-sender { display: flex; align-items: center; gap: 8px; padding: 3px 4px; border-radius: 6px; flex-wrap: wrap; }
.dsg-tg-sender:hover { background: var(--dsw-alias-bg-layer-2); }
.dsg-tg-sender-main { display: flex; align-items: center; gap: 6px; cursor: pointer; flex: 1; min-width: 0; }
.dsg-tg-sender-name { font-weight: 500; }
.dsg-tg-sender-username { color: var(--dsw-alias-brand-primary); }
.dsg-tg-sender-id { color: var(--dsw-alias-label-secondary); font-family: monospace; font-size: 11px; }
.dsg-tg-sender-meta { color: var(--dsw-alias-label-secondary); font-size: 11px; }
`;

const MENU_CSS = `
.dsg-tg-menuitem { display: flex; align-items: center; gap: 8px; width: 100%; padding: 6px 10px; border: none; background: transparent; color: var(--dsw-alias-label-primary); cursor: pointer; font-size: 13px; text-align: left; }
.dsg-tg-menuitem:hover { background: var(--dsw-alias-bg-layer-2); }
.dsg-tg-menuitem-icon { width: 16px; text-align: center; }
`;
