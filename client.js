/**
 * Browser half of the approval-alert bundle.
 *
 * The card's action button activates the Harness window, but only the page can
 * change which Conversation is on screen. The card process has no channel to the
 * page, so the Host records "open this session" when the card exits with its
 * open code, and this half polls that record and calls
 * `ctx.uiWorkspace.openSession()`.
 *
 * The poll is deliberately small and stateless: one JSON GET per tick, no
 * WebSocket of its own, and a request older than the Host's freshness window is
 * ignored so a click from minutes ago cannot move the page later.
 */

window.__ModuleLoader__.load({
  id: '@local/dsh-approval-alert',
  factory() {
    const OPEN_ENDPOINT = '/approval-alert/open'
    const POLL_MS = 1200
    /** Must not exceed the Host's own freshness window. */
    const MAX_AGE_MS = 20000

    function apply(ctx) {
      let since = -1
      let timer = null
      let stopped = false
      let inFlight = false

      function openSession(sessionId) {
        let workspace
        try {
          workspace = ctx.get('uiWorkspace')
        } catch {
          workspace = undefined
        }
        if (workspace === undefined || workspace === null || typeof workspace.openSession !== 'function') return
        try {
          workspace.openSession(sessionId)
        } catch {
          // A superseded navigation is not a failure worth surfacing.
        }
      }

      async function poll() {
        if (stopped || inFlight || typeof fetch !== 'function') return
        inFlight = true
        try {
          const response = await fetch(`${OPEN_ENDPOINT}?since=${since}`, {
            headers: { accept: 'application/json' },
            cache: 'no-store',
          })
          if (!response.ok) return
          const payload = await response.json()
          const seq = typeof payload?.seq === 'number' ? payload.seq : since
          if (!(seq > since)) return
          since = seq
          const sessionId = typeof payload?.sessionId === 'string' ? payload.sessionId : ''
          const at = typeof payload?.at === 'number' ? payload.at : 0
          const now = typeof payload?.now === 'number' ? payload.now : Date.now()
          if (sessionId.length === 0) return
          if (now - at > MAX_AGE_MS) return
          openSession(sessionId)
        } catch {
          // The Host may be restarting; the next tick retries.
        } finally {
          inFlight = false
        }
      }

      function start() {
        if (timer === null) timer = setInterval(() => void poll(), POLL_MS)
      }

      function stop() {
        if (timer === null) return
        clearInterval(timer)
        timer = null
      }

      // Coming back to the page is the moment a click most likely just happened,
      // so poll at once instead of waiting for the next tick.
      function onVisibility() {
        if (!document.hidden) void poll()
      }

      start()
      void poll()
      document.addEventListener('visibilitychange', onVisibility)

      ctx.effect(() => () => {
        stopped = true
        stop()
        document.removeEventListener('visibilitychange', onVisibility)
      }, 'approval-alert: host open requests')
    }

    return { apply }
  },
})
