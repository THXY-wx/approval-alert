/**
 * Always-on-top alert cards for the DeepSeek Harness desktop app.
 *
 * Three things are worth interrupting a background run for, and each has its own
 * extension point:
 *
 * - a permission ask: `approval/request` is a waterfall, so a listener may claim
 *   the decision or delegate with `next()`. This plugin never claims it — it only
 *   observes the pending ask, raises the card, and delegates immediately, so the
 *   composed answerer still decides exactly as before.
 * - a question to the user: `user-questions/request`, wrapped the same way,
 *   because an unanswered `ask_user_question` blocks the loop too.
 * - a finished answer: `session/event` lets the durable `turn/end` record decide,
 *   so only a turn that actually completed raises a card and a turn the user
 *   stopped does not.
 *
 * The card is a separate `powershell.exe` process running `popup.ps1`: one
 * process per card, killed as soon as the reason disappears, so the screen never
 * keeps a reminder for something that was already handled. Everything the card
 * renders travels through `DSH_ALERT_*` environment variables, which keeps
 * arbitrary model text out of the command line and out of any quoting layer.
 *
 * @module @local/dsh-approval-alert
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const name = 'approval-alert'

const SCRIPT_FILE = 'popup.ps1'
/**
 * The card script is kept ASCII-only so a missing byte-order mark can never turn
 * its Chinese literals into parse errors under Windows PowerShell 5.1; every
 * localized string therefore arrives from here.
 */
const ACTION_LABEL = '打开 Harness'
const DEFAULT_TITLE = '需要授权确认'
const DEFAULT_QUESTION_TITLE = '需要你的回答'
const DEFAULT_FINISHED_TITLE = 'AI 已回答完成'
const MAX_TITLE_CHARS = 60
const MAX_HEADLINE_CHARS = 120
const MAX_DETAIL_CHARS = 160
const MAX_HINT_CHARS = 80
const MAX_REPLY_CHARS = 110
const MAX_SESSION_CHARS = 8
const MAX_POPUPS = 8
const MAX_AUTO_CLOSE_SECONDS = 86400

/**
 * Flag order matters: `-File` must come last, and the script takes no
 * positional arguments because every value arrives through the environment.
 */
const POWERSHELL_ARGS = ['-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-File']

const DEFAULTS = Object.freeze({
  enabled: true,
  sound: true,
  title: DEFAULT_TITLE,
  questionTitle: DEFAULT_QUESTION_TITLE,
  finishedTitle: DEFAULT_FINISHED_TITLE,
  autoCloseSeconds: 0,
  maxPopups: 4,
  notifyQuestions: false,
  notifyFinished: true,
})

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

function finiteOr(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value))
}

function textOr(value, fallback) {
  if (typeof value !== 'string') return fallback
  const text = value.trim()
  return text.length === 0 ? fallback : text
}

/**
 * Normalize the row's `config` mapping. Invalid values fall back to the
 * documented defaults, so a hand-edited profile patch cannot make the plugin
 * refuse to mount.
 *
 * @param {unknown} raw - the Loader row config.
 * @returns {{ enabled: boolean, sound: boolean, title: string, questionTitle: string, finishedTitle: string, autoCloseSeconds: number, maxPopups: number, notifyQuestions: boolean, notifyFinished: boolean }}
 */
export function normalizeConfig(raw) {
  const source = raw !== null && typeof raw === 'object' ? raw : {}
  return {
    enabled: source.enabled !== false,
    sound: source.sound !== false,
    title: textOr(source.title, DEFAULT_TITLE).slice(0, MAX_TITLE_CHARS),
    questionTitle: textOr(source.questionTitle, DEFAULT_QUESTION_TITLE).slice(0, MAX_TITLE_CHARS),
    finishedTitle: textOr(source.finishedTitle, DEFAULT_FINISHED_TITLE).slice(0, MAX_TITLE_CHARS),
    autoCloseSeconds: Math.round(clamp(finiteOr(source.autoCloseSeconds, DEFAULTS.autoCloseSeconds), 0, MAX_AUTO_CLOSE_SECONDS)),
    maxPopups: Math.round(clamp(finiteOr(source.maxPopups, DEFAULTS.maxPopups), 1, MAX_POPUPS)),
    notifyQuestions: source.notifyQuestions === true,
    notifyFinished: source.notifyFinished !== false,
  }
}

// ---------------------------------------------------------------------------
// Card text
// ---------------------------------------------------------------------------

/**
 * Collapse text onto one line so a multi-line model sentence cannot blow up
 * the card's fixed layout.
 *
 * @param {unknown} value - candidate text.
 * @param {number} limit - maximum code units to keep.
 * @returns {string} one trimmed line, or `''`.
 */
function oneLine(value, limit) {
  if (typeof value !== 'string') return ''
  const text = value.replace(/\s+/g, ' ').trim()
  if (text.length === 0) return ''
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`
}

/**
 * Shorten a SessionId for the card. Harness ids carry a `session-` prefix that
 * would otherwise consume the whole visible slice, so it is dropped first.
 *
 * @param {unknown} value - a SessionId.
 * @returns {string} the first characters after the prefix, or `''`.
 */
function shortSession(value) {
  if (typeof value !== 'string') return ''
  return value.replace(/^session-/i, '').slice(0, MAX_SESSION_CHARS)
}

/**
 * Build the card's bottom line from the session label and the card's own
 * lifetime promise.
 *
 * @param {string} session - short session label, or `''`.
 * @param {string} suffix - what happens to the card next.
 * @returns {string} one line for the card.
 */
function hintFor(session, suffix) {
  return session.length > 0 ? `会话 ${session} · ${suffix}` : suffix
}

/**
 * Pick the human-language reason for an approval ask. The display table is
 * preferred because it is written for the user; `reason` is the model-facing
 * fallback.
 *
 * @param {unknown} request - an approval request event.
 * @returns {string} one trimmed line, or `''`.
 */
export function approvalReason(request) {
  const display = request?.displayReason
  if (display !== null && typeof display === 'object') {
    for (const key of ['zh', 'zh-CN', 'en']) {
      const text = oneLine(display[key], MAX_DETAIL_CHARS)
      if (text.length > 0) return text
    }
    for (const value of Object.values(display)) {
      const text = oneLine(value, MAX_DETAIL_CHARS)
      if (text.length > 0) return text
    }
  }
  return oneLine(request?.reason, MAX_DETAIL_CHARS)
}

/**
 * Summarize a user-question ask: the first question, or its localized display
 * question when the ask carries one.
 *
 * @param {unknown} request - a user-question request event.
 * @returns {string} one trimmed line, or `''`.
 */
export function questionReason(request) {
  const items = Array.isArray(request?.questions) ? request.questions : []
  const first = items[0]
  const display = first?.intent?.display?.question
  if (display !== null && typeof display === 'object') {
    for (const key of ['zh', 'zh-CN', 'en']) {
      const text = oneLine(display[key], MAX_DETAIL_CHARS)
      if (text.length > 0) return text
    }
  }
  return oneLine(first?.question, MAX_DETAIL_CHARS)
}

/**
 * Take the opening words of the last assistant message, so the card says what
 * was actually answered instead of only that something happened.
 *
 * @param {unknown} session - the session whose turn ended.
 * @returns {string} one trimmed line, or `''`.
 */
export function replyPreview(session) {
  let messages
  try {
    messages = session?.deriveMessages?.()
  } catch {
    return ''
  }
  if (!Array.isArray(messages)) return ''
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message?.role !== 'assistant') continue
    const parts = []
    for (const block of Array.isArray(message.content) ? message.content : []) {
      if (block?.type === 'text' && typeof block.text === 'string' && block.text.trim().length > 0) parts.push(block.text)
    }
    const text = oneLine(parts.join(' '), MAX_REPLY_CHARS)
    if (text.length > 0) return text
  }
  return ''
}

/**
 * Whether a session belongs to a subagent run. Those turns end constantly while
 * the parent is still working, so they would drown the card the user cares about.
 *
 * @param {unknown} session - a session.
 * @returns {boolean} true when the session is a delegated child.
 */
export function isSubagentSession(session) {
  const header = session?.header
  if (header === null || typeof header !== 'object') return false
  if (header.parentSession !== undefined && header.parentSession !== null) return true
  return header.origin === 'subagent'
}

// ---------------------------------------------------------------------------
// Process plumbing
// ---------------------------------------------------------------------------

/**
 * Windows PowerShell 5.1 is the one shell guaranteed to carry WinForms on a
 * stock Windows install, so it is resolved from the system directory instead of
 * relying on PATH.
 *
 * @returns {string} an executable path, or the bare command name as a last resort.
 */
export function powershellPath() {
  const root = textOr(process.env.SystemRoot, '')
  if (root.length > 0) {
    const candidate = path.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    if (existsSync(candidate)) return candidate
  }
  return 'powershell.exe'
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

/**
 * Raise an alert card for permission asks, questions, and finished answers.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - the plugin's owning context.
 * @param {unknown} config - the Loader row config; see {@link normalizeConfig}.
 */
export function apply(ctx, config) {
  const settings = normalizeConfig(config)
  if (!settings.enabled) return

  const logger = ctx.logger

  if (process.platform !== 'win32') {
    logger?.info?.('approval-alert: always-on-top cards are a Windows-only feature; nothing to do here')
    return
  }

  const script = path.join(path.dirname(fileURLToPath(import.meta.url)), SCRIPT_FILE)
  if (!existsSync(script)) {
    logger?.warn?.(`approval-alert: ${SCRIPT_FILE} is missing next to the plugin; alerts are disabled`)
    return
  }
  const powershell = powershellPath()

  /** card key -> live card process. */
  const live = new Map()
  /** session id -> the one answer card kept for that session. */
  const answerCards = new Map()
  let sequence = 0
  let disposed = false

  /**
   * Start one card. Returns undefined when the card could not be started, which
   * callers treat as "nothing to close" rather than as a failure.
   *
   * @param {{ kind: 'approval' | 'question' | 'finished', title: string, headline: string, detail: string, hint: string, sound: boolean, timeout: number, closeOnFocus: boolean }} card
   * @returns {{ close: () => void } | undefined}
   */
  function openCard(card) {
    if (disposed) return undefined

    if (live.size >= settings.maxPopups) {
      // A pending ask outranks an answer that has already been delivered.
      const stale = [...live.entries()].find(([, handle]) => handle.kind === 'finished')
      if (stale === undefined) {
        logger?.debug?.(`approval-alert: ${String(live.size)} cards are already up; not adding another`)
        return undefined
      }
      stale[1].close()
    }

    sequence += 1
    const key = `${card.kind}:${String(sequence)}`
    const env = {
      ...process.env,
      DSH_ALERT_KIND: card.kind,
      DSH_ALERT_TITLE: oneLine(card.title, MAX_TITLE_CHARS),
      DSH_ALERT_HEADLINE: oneLine(card.headline, MAX_HEADLINE_CHARS),
      DSH_ALERT_DETAIL: oneLine(card.detail, MAX_DETAIL_CHARS),
      DSH_ALERT_HINT: oneLine(card.hint, MAX_HINT_CHARS),
      DSH_ALERT_ACTION: ACTION_LABEL,
      DSH_ALERT_SOUND: card.sound ? '1' : '0',
      DSH_ALERT_TIMEOUT: String(card.timeout),
      DSH_ALERT_CLOSE_ON_FOCUS: card.closeOnFocus ? '1' : '0',
      DSH_ALERT_OWNER_PID: String(process.pid),
      DSH_ALERT_INDEX: String(live.size),
    }

    let child
    try {
      child = spawn(powershell, [...POWERSHELL_ARGS, script], {
        env,
        stdio: 'ignore',
        windowsHide: true,
      })
    } catch (error) {
      logger?.warn?.(`approval-alert: could not start the alert process: ${String(error)}`)
      return undefined
    }

    const handle = {
      kind: card.kind,
      close() {
        if (!live.has(key)) return
        live.delete(key)
        try {
          child.kill()
        } catch {
          // The card already exited; nothing to release.
        }
      },
    }
    live.set(key, handle)

    child.once('error', (error) => {
      live.delete(key)
      logger?.debug?.(`approval-alert: alert process failed: ${String(error)}`)
    })
    child.once('exit', () => {
      live.delete(key)
    })

    return handle
  }

  /** Wrap one answerer ask so a card lives exactly as long as the ask does. */
  async function withCard(card, next) {
    let handle
    try {
      handle = openCard(card)
    } catch (error) {
      // A failed reminder must never turn into a failed approval.
      logger?.warn?.(`approval-alert: could not raise the alert: ${String(error)}`)
    }
    try {
      return await next()
    } finally {
      handle?.close()
    }
  }

  // `prepend` matters: the waterfall stops at the first listener that returns an
  // outcome, and the interactive answerer that shows the in-app dialog is
  // registered earlier. Prepending puts this observer in front of it so the card
  // opens, then `next()` hands the decision back to that answerer unchanged.
  // `global` keeps every session's ask visible, including scoped agent presets.
  const OBSERVER = { prepend: true, global: true }

  ctx.on('approval/request', (request, next) => {
    const session = shortSession(request?.agent?.id)
    const tool = typeof request?.toolName === 'string' ? request.toolName : ''
    return withCard({
      kind: 'approval',
      title: settings.title,
      headline: tool.length > 0 ? `AI 请求使用工具：${tool}` : 'AI 请求一项受限操作',
      detail: approvalReason(request) || '请在 DeepSeek Harness 中允许或拒绝这次请求',
      hint: hintFor(session, '处理完成后自动关闭'),
      sound: settings.sound,
      timeout: settings.autoCloseSeconds,
      closeOnFocus: false,
    }, next)
  }, OBSERVER)

  if (settings.notifyQuestions) {
    ctx.on('user-questions/request', (request, next) => {
      const session = shortSession(request?.agent?.id)
      return withCard({
        kind: 'question',
        title: settings.questionTitle,
        headline: 'AI 正在等待你的回答',
        detail: questionReason(request) || '请在 DeepSeek Harness 中回答这个问题',
        hint: hintFor(session, '回答后自动关闭'),
        sound: settings.sound,
        timeout: settings.autoCloseSeconds,
        closeOnFocus: false,
      }, next)
    }, OBSERVER)
  }

  if (settings.notifyFinished) {
    // The durable `turn/end` record decides: a completed turn notifies, while a
    // turn the user stopped, or one that errored, stays silent.
    ctx.on('session/event', (session, event) => {
      if (disposed || event?.type !== 'turn/end') return
      if (event.data?.reason?.kind !== 'completed') return
      if (isSubagentSession(session)) return

      const id = typeof session?.id === 'string' ? session.id : ''
      // One answer card per session: a later turn replaces the earlier card
      // instead of stacking, so a long-running session cannot paper the screen.
      const previous = answerCards.get(id)
      if (previous !== undefined) {
        answerCards.delete(id)
        previous.close()
      }

      const handle = openCard({
        kind: 'finished',
        title: settings.finishedTitle,
        headline: '回答已完成，可以查看',
        detail: replyPreview(session) || '这一轮回答已经结束',
        hint: hintFor(shortSession(id), '切回 Harness 后自动关闭'),
        sound: settings.sound,
        timeout: 0,
        closeOnFocus: true,
      })
      if (handle !== undefined) answerCards.set(id, handle)
    })
  }

  ctx.effect(() => () => {
    disposed = true
    for (const handle of live.values()) handle.close()
    live.clear()
    answerCards.clear()
  })
}
