const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  Browsers,
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
// PAIRING CODE
// Every attempt (including reconnects) starts with a clean session dir so
// there are never stale / half-written creds causing 401s.
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
    if (shared.done) return

    // Session dir must ONLY be wiped on the first attempt so reconnects can load the saved creds
    if (isFirstConnect) {
      try { fs.rmSync(sessionDir, { recursive: true, force: true }) } catch (_) { }
      fs.mkdirSync(sessionDir, { recursive: true })
    } else if (!fs.existsSync(sessionDir)) {
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
      browser: Browsers.ubuntu('Chrome'),
      connectTimeoutMs: 60000,
      keepAliveIntervalMs: 30000,
      defaultQueryTimeoutMs: undefined,
      generateHighQualityLinkPreview: false,
      syncFullHistory: true,
    })

    console.log(`[PAIR-CODE] [${new Date().toLocaleTimeString()}] Socket #${shared.reconnectCount + 1} for ${phone} (registered: ${!!sock.authState.creds.registered})`)

    sock.ev.on('creds.update', async (update) => {
      try { await saveCreds(update) } catch (e) { console.error('[PAIR-CODE] saveCreds error:', e.message) }

      if (sock.authState.creds.registered && !shared.sessionId && !shared.done) {
        console.log(`[PAIR-CODE] ✅ Authenticated (registered) — saving to MongoDB...`)
        try {
          const credsPath = path.join(sessionDir, 'creds.json')
          let attempts = 0
          while (!fs.existsSync(credsPath) && attempts < 15) {
            await new Promise(r => setTimeout(r, 500))
            attempts++
          }
          try { await saveCreds(update) } catch (_) {}
          await new Promise(r => setTimeout(r, 1000))

          if (!fs.existsSync(credsPath)) {
            throw new Error('creds.json not found after 15 attempts — disk flush failed')
          }

          shared.jid = sock.authState.creds.me.id || `${phone}@s.whatsapp.net`
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
          console.log(`[PAIR-CODE] ✅ Open — sending Session ID to ${shared.jid}`)
          try {
            const msg = await sock.sendMessage(shared.jid, { text: buildSuccessMessage(shared.sessionId) })
            console.log(`[PAIR-CODE] Message sent (ID: ${msg?.key?.id})`)
            onSuccess(shared.sessionId)
          } catch (err) {
            console.error('[PAIR-CODE] DM send failed:', err.message)
            onSuccess(shared.sessionId)
          } finally {
            setTimeout(() => {
              console.log('[PAIR-CODE] ✅ Cleanup (10s buffer)')
              try { if (sock.ws?.readyState === 1) sock.end(undefined) } catch (_) { }
              fullCleanup(false)
            }, 10000)
          }
        }
        return
      }

      if (connection === 'close') {
        const statusCode = lastDisconnect?.error?.output?.statusCode ?? lastDisconnect?.error?.data?.reason
        const errMsg = lastDisconnect?.error?.message ?? ''

        const is515 = (
          statusCode === 515 ||
          statusCode === DisconnectReason.restartRequired ||
          errMsg.toLowerCase().includes('restart required') ||
          errMsg.toLowerCase().includes('stream errored')
        )
        const isLoggedOut = (statusCode === DisconnectReason.loggedOut || statusCode === 401) && !shared.sessionId

        console.log(`[PAIR-CODE] Close — code=${statusCode} | is515=${is515} | isLoggedOut=${isLoggedOut} | hasSession=${!!shared.sessionId} | attempt=${shared.reconnectCount}`)

        // 401 with session already saved = WA closing the pairing socket (not a real logout)
        if (statusCode === 401 && shared.sessionId && !shared.done) {
          console.log(`[PAIR-CODE] ✅ WA closed pairing socket (401) — session already in MongoDB, delivering...`)
          shared.done = true
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
        console.log(`[PAIR-CODE] Reconnecting in ${delay/1000}s (attempt ${shared.reconnectCount})`)
        setTimeout(() => connect(false), delay)
      }
    })

    // Request pairing code on fresh sockets only (not after creds already issued)
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
    if (shared.done) return

    // Session dir must ONLY be wiped on the first attempt so reconnects can load the saved creds
    if (isFirstConnect) {
      try { fs.rmSync(sessionDir, { recursive: true, force: true }) } catch (_) { }
      fs.mkdirSync(sessionDir, { recursive: true })
    } else if (!fs.existsSync(sessionDir)) {
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
      browser: Browsers.ubuntu('Chrome'),
      connectTimeoutMs: 60000,
      keepAliveIntervalMs: 30000,
      defaultQueryTimeoutMs: undefined,
      generateHighQualityLinkPreview: false,
      syncFullHistory: true,
    })

    console.log(`[QR] [${new Date().toLocaleTimeString()}] Socket #${shared.reconnectCount + 1} for ${sessionKey} (registered: ${!!sock.authState.creds.registered})`)
    if (sock.ws && typeof sock.ws.on === 'function') {
      sock.ws.on('error', (e) => console.log(`[QR] WS Error: ${e.message}`))
    }

    sock.ev.on('creds.update', async (update) => {
      try { await saveCreds(update) } catch (e) { console.error('[QR] saveCreds error:', e.message) }

      if (sock.authState.creds.registered && !shared.sessionId && !shared.done) {
        console.log(`[QR] ✅ Authenticated (registered) — saving to MongoDB...`)
        try {
          const credsPath = path.join(sessionDir, 'creds.json')
          let attempts = 0
          while (!fs.existsSync(credsPath) && attempts < 10) {
            await new Promise(r => setTimeout(r, 500))
            attempts++
          }
          try { await saveCreds(update) } catch (_) {}
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
          console.log(`[QR] ✅ Open — sending Session ID to ${shared.jid}`)
          try {
            const msg = await sock.sendMessage(shared.jid, { text: buildSuccessMessage(shared.sessionId) })
            console.log(`[QR] Message sent (ID: ${msg?.key?.id})`)
            onSuccess(shared.sessionId)
          } catch (err) {
            console.error('[QR] DM send failed:', err.message)
            onSuccess(shared.sessionId)
          } finally {
            setTimeout(() => {
              console.log('[QR] ✅ Cleanup (10s buffer expired)')
              try { if (sock.ws?.readyState === 1) sock.end(undefined) } catch (_) { }
              cleanup()
            }, 10000)
          }
        }
        return
      }

      if (connection === 'close') {
        const statusCode = lastDisconnect?.error?.output?.statusCode ?? lastDisconnect?.error?.data?.reason
        const errMsg = lastDisconnect?.error?.message ?? ''

        const is515 = (
          statusCode === 515 ||
          statusCode === DisconnectReason.restartRequired ||
          errMsg.toLowerCase().includes('restart required') ||
          errMsg.toLowerCase().includes('stream errored')
        )
        const isLoggedOut = (statusCode === DisconnectReason.loggedOut || statusCode === 401) && !shared.sessionId

        console.log(`[QR] Close — code=${statusCode} | is515=${is515} | isLoggedOut=${isLoggedOut} | hasSession=${!!shared.sessionId} | attempt=${shared.reconnectCount}`)

        if (statusCode === 401 && shared.sessionId && !shared.done) {
          console.log(`[QR] ✅ WA closed pairing socket (401) — session already in MongoDB, delivering...`)
          shared.done = true
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
        console.log(`[QR] Reconnecting in ${delay/1000}s (attempt ${shared.reconnectCount})`)
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
1⃣  Copy the Session ID above
2⃣  Set it as your \`SESSION_ID\` environment variable
3⃣  Deploy & flex on em 😎

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