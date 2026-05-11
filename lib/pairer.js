const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
} = require('@whiskeysockets/baileys')
const pino = require('pino')
const path = require('path')
const fs = require('fs')
const QRCode = require('qrcode')
const { saveToMongo } = require('./mongoStore')
const config = require('../config')

// Active sessions map: sessionKey → cleanup fn
const activeSessions = new Map()

// ─────────────────────────────────────────────────────────────────────────────
// SEND SESSION MESSAGES
// Opens a FRESH authenticated socket using the already-saved creds, waits for
// connection to be 'open', then sends:
//   1. The full branded success message
//   2. A plain message with just the Session ID (easy copy-paste)
// Closes the socket after delivery (or after a 35s hard timeout).
// ─────────────────────────────────────────────────────────────────────────────
async function sendSessionMessages(sessionDir, jid, sessionId, version) {
  return new Promise(async (resolve) => {
    let delivered = false

    // Hard timeout must be > connectTimeoutMs (30s) so the socket gets a fair
    // chance to open before we give up
    const hardTimeout = setTimeout(() => {
      if (!delivered) {
        console.warn('[SEND-MSG] ⚠ Hard timeout — closing delivery socket without confirmed send')
        delivered = true
        resolve()
      }
    }, 35000)

    const finish = (sock) => {
      if (delivered) return
      delivered = true
      clearTimeout(hardTimeout)
      setTimeout(() => {
        try { if (sock?.ws?.readyState === 1) sock.end(undefined) } catch (_) { }
        resolve()
      }, 3000)
    }

    try {
      const { state, saveCreds } = await useMultiFileAuthState(sessionDir)

      const sock = makeWASocket({
        version,
        printQRInTerminal: false,
        logger: pino({ level: 'silent' }),
        auth: state,
        browser: ['Mac OS', 'Chrome', '14.4.1'],
        connectTimeoutMs: 30000,
        keepAliveIntervalMs: 20000,
        defaultQueryTimeoutMs: undefined,
        generateHighQualityLinkPreview: false,
        syncFullHistory: false,
      })

      sock.ev.on('creds.update', saveCreds)

      sock.ev.on('connection.update', async ({ connection, lastDisconnect }) => {
        if (connection) console.log(`[SEND-MSG] Connection: ${connection}`)

        if (connection === 'open') {
          console.log(`[SEND-MSG] ✅ Delivery socket open — sending to ${jid}`)
          try {
            // Message 1: full branded message
            await sock.sendMessage(jid, { text: buildSuccessMessage(sessionId) })
            console.log('[SEND-MSG] ✅ Full message sent')

            // Small delay so they appear as separate bubbles
            await new Promise(r => setTimeout(r, 1500))

            // Message 2: session ID only (for easy copy-paste)
            await sock.sendMessage(jid, { text: sessionId })
            console.log('[SEND-MSG] ✅ Session ID message sent')
          } catch (err) {
            console.error('[SEND-MSG] Send failed:', err.message)
          } finally {
            finish(sock)
          }
          return
        }

        if (connection === 'close') {
          const code = lastDisconnect?.error?.output?.statusCode
          console.log(`[SEND-MSG] Delivery socket closed — code=${code}`)
          // Don't retry — just resolve so the caller isn't blocked forever
          finish(sock)
        }
      })
    } catch (err) {
      console.error('[SEND-MSG] Failed to open delivery socket:', err.message)
      clearTimeout(hardTimeout)
      resolve()
    }
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// PAIRING CODE
// ─────────────────────────────────────────────────────────────────────────────
async function startPairingCode(phone, onSuccess, onError) {
  if (activeSessions.has(phone)) {
    try { activeSessions.get(phone)(true) } catch (_) { }
  }

  const sessionDir = path.join(__dirname, '..', 'sessions', phone)

  const shared = {
    done: false,
    sessionId: null,
    jid: null,
    codeResolved: false,
    resolveCode: null,
    rejectCode: null,
    reconnectCount: 0,
    version: null,
  }

  const MAX_RECONNECTS = 10

  const fullCleanup = (sync = false) => {
    activeSessions.delete(phone)
    if (sync) {
      try { fs.rmSync(sessionDir, { recursive: true, force: true }) } catch (_) { }
    } else {
      setTimeout(() => {
        if (!activeSessions.has(phone)) {
          try { fs.rmSync(sessionDir, { recursive: true, force: true }) } catch (_) { }
        }
      }, config.sessionCleanupDelay)
    }
  }

  activeSessions.set(phone, fullCleanup)

  const codePromise = new Promise((res, rej) => {
    shared.resolveCode = res
    shared.rejectCode = rej
  })

  async function connect(isFirstConnect = true) {
    if (isFirstConnect || !shared.sessionId) {
      // Wipe on first connect OR any reconnect before pairing completed
      // — stale registration keys cause 401 on reconnect
      try { fs.rmSync(sessionDir, { recursive: true, force: true }) } catch (_) { }
      fs.mkdirSync(sessionDir, { recursive: true })
    }

    if (!shared.version) {
      const { version } = await fetchLatestBaileysVersion()
      shared.version = version
    }

    const { state, saveCreds } = await useMultiFileAuthState(sessionDir)

    const sock = makeWASocket({
      version: shared.version,
      printQRInTerminal: false,
      logger: pino({ level: 'trace' }),
      auth: state,
      browser: ['Mac OS', 'Chrome', '14.4.1'],
      connectTimeoutMs: 60000,
      keepAliveIntervalMs: 30000,
      defaultQueryTimeoutMs: undefined,
      generateHighQualityLinkPreview: false,
      syncFullHistory: false,
    })

    console.log(`[PAIR-CODE] [${new Date().toLocaleTimeString()}] Socket #${shared.reconnectCount + 1} for ${phone} (registered: ${!!sock.authState.creds.registered})`)

    sock.ev.on('creds.update', async (update) => {
      try { await saveCreds(update) } catch (e) { console.error('[PAIR-CODE] saveCreds error:', e.message) }

      if (sock.authState.creds.registered && !shared.sessionId && !shared.done) {
        console.log('[PAIR-CODE] ✅ Authenticated — saving to MongoDB...')
        try {
          const credsPath = path.join(sessionDir, 'creds.json')
          let attempts = 0
          while (!fs.existsSync(credsPath) && attempts < 15) {
            await new Promise(r => setTimeout(r, 500))
            attempts++
          }
          try { await saveCreds(update) } catch (_) { }
          await new Promise(r => setTimeout(r, 1000))

          if (!fs.existsSync(credsPath)) {
            throw new Error('creds.json not found after 15 attempts — disk flush failed')
          }

          shared.jid = sock.authState.creds.me?.id || `${phone}@s.whatsapp.net`
          shared.sessionId = await saveToMongo(credsPath, phone)
          console.log(`[PAIR-CODE] ✅ Saved to MongoDB → ${shared.sessionId}`)
        } catch (err) {
          console.error('[PAIR-CODE] MongoDB upload failed:', err.message)
          shared.done = true
          onError(err)
          fullCleanup(false)
        }
      }
    })

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect } = update
      if (connection) console.log(`[PAIR-CODE] Connection: ${connection}`)

      if (connection === 'open') {
        if (shared.done) return

        // Wait for MongoDB save if creds came in but upload is still in flight
        if (sock.authState.creds.registered && !shared.sessionId) {
          let attempts = 0
          while (!shared.sessionId && attempts < 20 && !shared.done) {
            await new Promise(r => setTimeout(r, 500))
            attempts++
          }
        }

        if (shared.sessionId && !shared.done) {
          shared.done = true
          shared.jid = sock.authState.creds.me?.id || shared.jid

          console.log(`[PAIR-CODE] ✅ Open — closing pairing socket, will reconnect to deliver messages`)
          try { if (sock.ws?.readyState === 1) sock.end(undefined) } catch (_) { }

          // ── Reconnect with saved creds and send both messages ──
          console.log(`[PAIR-CODE] Spawning delivery socket for ${shared.jid}...`)
          await sendSessionMessages(sessionDir, shared.jid, shared.sessionId, shared.version)

          onSuccess(shared.sessionId)
          setTimeout(() => {
            console.log('[PAIR-CODE] ✅ Cleanup (10s buffer)')
            fullCleanup(false)
          }, 10000)
        }
        return
      }

      if (connection === 'close') {
        const statusCode = lastDisconnect?.error?.output?.statusCode ?? lastDisconnect?.error?.data?.reason
        const errMsg = lastDisconnect?.error?.message ?? ''

        const isLoggedOut = (statusCode === DisconnectReason.loggedOut || statusCode === 401) && !shared.sessionId

        console.log(`[PAIR-CODE] Close — code=${statusCode} | isLoggedOut=${isLoggedOut} | hasSession=${!!shared.sessionId} | attempt=${shared.reconnectCount}`)

        // 515 = WA "restart required" — official pairing complete signal
        if (statusCode === 515 && shared.sessionId && !shared.done) {
          shared.done = true
          console.log('[PAIR-CODE] ✅ 515 restart — session confirmed, spawning delivery socket...')
          await sendSessionMessages(sessionDir, shared.jid, shared.sessionId, shared.version)
          onSuccess(shared.sessionId)
          fullCleanup(false)
          return
        }

        // 401 after session saved = WA closing the pairing socket normally
        if (statusCode === 401 && shared.sessionId && !shared.done) {
          shared.done = true
          console.log(`[PAIR-CODE] ✅ Pairing socket closed (401) — session in MongoDB, spawning delivery socket...`)
          await sendSessionMessages(sessionDir, shared.jid, shared.sessionId, shared.version)
          onSuccess(shared.sessionId)
          fullCleanup(false)
          return
        }

        if (isLoggedOut) {
          if (!shared.done) {
            shared.done = true
            onError(lastDisconnect?.error || new Error('Logged out'))
            fullCleanup(false)
          }
          return
        }

        if (shared.done) return

        if (shared.reconnectCount >= MAX_RECONNECTS) {
          if (!shared.done) {
            shared.done = true
            onError(new Error(`Max reconnects (${MAX_RECONNECTS}) reached`))
            fullCleanup(false)
          }
          return
        }

        if (!shared.codeResolved) {
          shared.codeResolved = true
          shared.rejectCode(lastDisconnect?.error || new Error('Closed before code'))
        }

        shared.reconnectCount++
        const delay = 5000
        console.log(`[PAIR-CODE] Reconnecting in ${delay / 1000}s (attempt ${shared.reconnectCount})`)
        setTimeout(() => connect(false), delay)
      }
    })

    if (!shared.codeResolved && !shared.sessionId) {
      await new Promise(r => setTimeout(r, 2000))
      if (shared.done) return

      try {
        const cleanPhone = phone.replace(/\D/g, '')
        console.log(`[PAIR-CODE] Requesting code for ${cleanPhone}...`)
        const raw = await sock.requestPairingCode(cleanPhone)
        const code = raw?.match(/.{1,4}/g)?.join('-') ?? raw
        shared.codeResolved = true
        shared.resolveCode(code)
        console.log(`[PAIR-CODE] Code issued: ${code}`)
      } catch (err) {
        console.error('[PAIR-CODE] requestPairingCode failed:', err.message)
        if (!shared.done) {
          shared.done = true
          if (!shared.codeResolved) { shared.rejectCode(err); shared.codeResolved = true }
          onError(err)
          fullCleanup(false)
        }
      }
    }
  }

  connect(true).catch(err => {
    if (!shared.done) {
      shared.done = true
      onError(err)
      fullCleanup(false)
    }
  })

  return codePromise
}

// ─────────────────────────────────────────────────────────────────────────────
// QR SESSION
// ─────────────────────────────────────────────────────────────────────────────
async function startQRSession(sessionKey, onQR, onSuccess, onError) {
  if (activeSessions.has(sessionKey)) {
    try { activeSessions.get(sessionKey)() } catch (_) { }
  }

  const uniqueId = Math.random().toString(36).slice(2, 10)
  const sessionDir = path.join(__dirname, '..', 'sessions', `${sessionKey}_${uniqueId}`)

  const shared = {
    done: false,
    sessionId: null,
    phone: null,
    jid: null,
    reconnectCount: 0,
    version: null,
  }

  const MAX_RECONNECTS = 10

  const cleanup = () => {
    activeSessions.delete(sessionKey)
    setTimeout(() => {
      try { fs.rmSync(sessionDir, { recursive: true, force: true }) } catch (_) { }
    }, config.sessionCleanupDelay)
  }

  activeSessions.set(sessionKey, cleanup)

  async function connect(isFirstConnect = true) {
    if (isFirstConnect || !shared.sessionId) {
      // Wipe on first connect OR any reconnect before pairing completed
      // — stale registration keys cause 401 on reconnect
      try { fs.rmSync(sessionDir, { recursive: true, force: true }) } catch (_) { }
      fs.mkdirSync(sessionDir, { recursive: true })
    }

    if (!shared.version) {
      const { version } = await fetchLatestBaileysVersion()
      shared.version = version
    }

    const { state, saveCreds } = await useMultiFileAuthState(sessionDir)

    const sock = makeWASocket({
      version: shared.version,
      printQRInTerminal: false,
      logger: pino({ level: 'trace' }),
      auth: state,
      browser: ['Mac OS', 'Chrome', '14.4.1'],
      connectTimeoutMs: 60000,
      keepAliveIntervalMs: 30000,
      defaultQueryTimeoutMs: undefined,
      generateHighQualityLinkPreview: false,
      syncFullHistory: false,
    })

    console.log(`[QR] [${new Date().toLocaleTimeString()}] Socket #${shared.reconnectCount + 1} for ${sessionKey} (registered: ${!!sock.authState.creds.registered})`)
    if (sock.ws && typeof sock.ws.on === 'function') {
      sock.ws.on('error', (e) => console.log(`[QR] WS Error: ${e.message}`))
    }

    sock.ev.on('creds.update', async (update) => {
      try { await saveCreds(update) } catch (e) { console.error('[QR] saveCreds error:', e.message) }

      if (sock.authState.creds.registered && !shared.sessionId && !shared.done) {
        console.log('[QR] ✅ Authenticated — saving to MongoDB...')
        try {
          const credsPath = path.join(sessionDir, 'creds.json')
          let attempts = 0
          while (!fs.existsSync(credsPath) && attempts < 10) {
            await new Promise(r => setTimeout(r, 500))
            attempts++
          }
          try { await saveCreds(update) } catch (_) { }
          await new Promise(r => setTimeout(r, 1000))

          const creds = JSON.parse(fs.readFileSync(credsPath, 'utf8'))
          shared.phone = creds?.me?.id?.split(':')[0]?.split('@')[0] || sessionKey
          shared.jid = sock.authState.creds.me?.id || `${shared.phone}@s.whatsapp.net`
          shared.sessionId = await saveToMongo(credsPath, shared.phone)
          console.log(`[QR] ✅ Saved to MongoDB → ${shared.sessionId}`)
        } catch (err) {
          console.error('[QR] MongoDB upload failed:', err.message)
          shared.done = true
          onError(err)
          cleanup()
        }
      }
    })

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update
      if (connection) console.log(`[QR] Connection: ${connection}`)

      if (qr && !shared.sessionId) {
        try {
          const dataUrl = await QRCode.toDataURL(qr, { errorCorrectionLevel: 'H', margin: 2, width: 300 })
          onQR(dataUrl)
        } catch (err) {
          console.error('[QR] QR gen failed:', err.message)
        }
      }

      if (connection === 'open') {
        if (shared.done) return

        if (sock.authState.creds.registered && !shared.sessionId) {
          let attempts = 0
          while (!shared.sessionId && attempts < 20 && !shared.done) {
            await new Promise(r => setTimeout(r, 500))
            attempts++
          }
        }

        if (shared.sessionId && !shared.done) {
          shared.done = true
          shared.jid = sock.authState.creds.me?.id || shared.jid

          console.log(`[QR] ✅ Open — closing QR socket, spawning delivery socket for ${shared.jid}`)
          try { if (sock.ws?.readyState === 1) sock.end(undefined) } catch (_) { }

          await sendSessionMessages(sessionDir, shared.jid, shared.sessionId, shared.version)

          onSuccess(shared.sessionId)
          setTimeout(() => {
            console.log('[QR] ✅ Cleanup (10s buffer expired)')
            cleanup()
          }, 10000)
        }
        return
      }

      if (connection === 'close') {
        const statusCode = lastDisconnect?.error?.output?.statusCode ?? lastDisconnect?.error?.data?.reason
        const isLoggedOut = (statusCode === DisconnectReason.loggedOut || statusCode === 401) && !shared.sessionId

        console.log(`[QR] Close — code=${statusCode} | isLoggedOut=${isLoggedOut} | hasSession=${!!shared.sessionId} | attempt=${shared.reconnectCount}`)

        if (statusCode === 515 && shared.sessionId && !shared.done) {
          shared.done = true
          console.log('[QR] ✅ 515 restart — session confirmed, spawning delivery socket...')
          await sendSessionMessages(sessionDir, shared.jid, shared.sessionId, shared.version)
          onSuccess(shared.sessionId)
          cleanup()
          return
        }

        if (statusCode === 401 && shared.sessionId && !shared.done) {
          shared.done = true
          console.log('[QR] ✅ Pairing socket closed (401) — session in MongoDB, spawning delivery socket...')
          await sendSessionMessages(sessionDir, shared.jid, shared.sessionId, shared.version)
          onSuccess(shared.sessionId)
          cleanup()
          return
        }

        if (isLoggedOut) {
          if (!shared.done) {
            shared.done = true
            onError(lastDisconnect?.error || new Error('Logged out'))
            cleanup()
          }
          return
        }

        if (shared.done) return

        if (shared.reconnectCount >= MAX_RECONNECTS) {
          if (!shared.done) {
            shared.done = true
            onError(new Error(`Max reconnects (${MAX_RECONNECTS}) reached`))
            cleanup()
          }
          return
        }

        shared.reconnectCount++
        const delay = 5000
        console.log(`[QR] Reconnecting in ${delay / 1000}s (attempt ${shared.reconnectCount})`)
        setTimeout(() => connect(false), delay)
      }
    })
  }

  connect(true).catch(err => {
    if (!shared.done) {
      shared.done = true
      onError(err)
      cleanup()
    }
  })
}

// ─────────────────────────────────────────────────────────────────────────────

function buildSuccessMessage(sessionId) {
  return `╔══════════════════════════════╗
║   🤖  HANS BYTE MD  🤖       ║
╚══════════════════════════════╝

✅ *Pairing Successful, Legend!* 🎉

You just unlocked the full power of *HANS BYTE MD* 🔥
Your session has been generated and stored securely.

📋 *Your Session ID:*
\`\`\`
${sessionId}
\`\`\`

📌 *Setup in 3 steps:*
1  Copy the Session ID above
2  Set it as your \`SESSION_ID\` environment variable
3  Deploy & flex on em 😎

🔗 *Bot Repo:*
${config.bot.repoUrl}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
⚡ Powered by *${config.bot.name}*
🛠  Built with ❤  by ${config.bot.owner}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

> ⚠  *Keep this Session ID private.*
> Anyone with it can control your bot instance.`
}

module.exports = { startPairingCode, startQRSession }
