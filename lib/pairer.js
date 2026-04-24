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
// Returns Promise<string> resolving to the 8-char code e.g. "ABCD-1234"
// Calls onSuccess(sessionId) or onError(err) asynchronously after WA connects
//
// 515 reconnect strategy (learned from working implementations):
//   After pairing WA sends stream:error 515 = "restart required".
//   The correct fix is NOT a separate socket — just call the internal connect()
//   again. On reconnect creds.registered===true so requestPairingCode is
//   skipped and the socket simply waits for connection==='open'.
//   This mirrors how gifted-session and other proven pairers handle 515.
//
//   NOTE: lastDisconnect?.error?.output?.statusCode is unreliable in Baileys
//   v7 rc.x — it can return undefined for 515. We check the error message too.
// ─────────────────────────────────────────────────────────────────────────────
async function startPairingCode(phone, onSuccess, onError) {
  if (activeSessions.has(phone)) {
    try { activeSessions.get(phone)(true) } catch (_) { }
  }

  const sessionDir = path.join(__dirname, '..', 'sessions', phone)

  const shared = {
    done: false,          // true once DM sent + onSuccess called
    sessionId: null,      // set after MongoDB upload
    jid: null,            // target JID
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

  async function connect(isFirstConnect) {
    if (shared.done) return

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
      logger: pino({ level: 'silent' }),
      auth: state,
      browser: Browsers.ubuntu('Chrome'),
      connectTimeoutMs: 60000,
      keepAliveIntervalMs: 30000,
      defaultQueryTimeoutMs: undefined,
      generateHighQualityLinkPreview: false,
      syncFullHistory: false,
    })

    console.log(`[PAIR-CODE] [${new Date().toLocaleTimeString()}] Socket #${shared.reconnectCount + 1} ready for ${phone}`)

    sock.ev.on('creds.update', async (update) => {
      try { await saveCreds(update) } catch (e) { /* silent flush errors */ }

      if (update.me && !shared.sessionId && !shared.done) {
        console.log(`[PAIR-CODE] ✅ Authenticated as ${update.me.id} — uploading to MongoDB...`)
        try {
          const credsPath = path.join(sessionDir, 'creds.json')
          let attempts = 0
          while (!fs.existsSync(credsPath) && attempts < 5) {
            await new Promise(r => setTimeout(r, 1000))
            attempts++
          }

          shared.jid = update.me.id || `${phone}@s.whatsapp.net`
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

      if (connection === 'open') {
        if (shared.done) return

        if (shared.sessionId) {
          shared.done = true
          console.log(`[PAIR-CODE] ✅ Reconnected & open — sending Session ID to ${shared.jid}`)
          try {
            const msg = await sock.sendMessage(shared.jid, { text: buildSuccessMessage(shared.sessionId) })
            console.log(`[PAIR-CODE] Message sent (ID: ${msg?.key?.id}), waiting for socket flush...`)
            onSuccess(shared.sessionId)
          } catch (err) {
            console.error('[PAIR-CODE] DM send failed:', err.message)
            onSuccess(shared.sessionId) // Still count as success since DB is updated
          } finally {
            setTimeout(() => {
              console.log('[PAIR-CODE] ✅ Connection cleanup (10s buffer)')
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
        const isLoggedOut = statusCode === DisconnectReason.loggedOut || statusCode === 401

        console.log(`[PAIR-CODE] Close — is515=${is515} | hasSession=${!!shared.sessionId} | attempt=${shared.reconnectCount}`)

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
            onError(new Error(`Max reconnects reached`))
            fullCleanup(false)
          }
          return
        }

        if (!shared.codeResolved) {
          shared.codeResolved = true
          shared.rejectCode(lastDisconnect?.error || new Error('Closed before code'))
        }

        shared.reconnectCount++
        const delay = (is515 && shared.sessionId) ? 3000 : is515 ? 15000 : 5000
        console.log(`[PAIR-CODE] Reconnecting in ${delay/1000}s (attempt ${shared.reconnectCount})`)
        setTimeout(() => connect(false), delay)
      }
    })

    if (!sock.authState.creds.registered) {
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

  // Unique folder per session scan to avoid stale file conflicts
  const uniqueId = Math.random().toString(36).slice(2, 10)
  const sessionDir = path.join(__dirname, '..', 'sessions', `${sessionKey}_${uniqueId}`)

  const shared = {
    done: false,          // true once DM sent + onSuccess called
    sessionId: null,      // set after MongoDB upload
    phone: null,          // set after MongoDB upload
    jid: null,            // set after MongoDB upload
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

  async function connect(isFirstConnect) {
    if (shared.done) return

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
      logger: pino({ level: 'silent' }), // silence noisy internal logs
      auth: state,
      browser: Browsers.ubuntu('Chrome'),
      connectTimeoutMs: 60000,
      keepAliveIntervalMs: 30000,
      defaultQueryTimeoutMs: undefined,
      generateHighQualityLinkPreview: false,
      syncFullHistory: false,
    })

    console.log(`[QR] [${new Date().toLocaleTimeString()}] Socket #${shared.reconnectCount + 1} ready for ${sessionKey}`)
    if (sock.ws && typeof sock.ws.on === 'function') {
      sock.ws.on('error', (e) => console.log(`[QR] WS Error: ${e.message}`))
    }

    // ── STEP 1: On creds.update with me → save to MongoDB immediately
    // Do NOT try to sendMessage here — the socket is about to get a 515 and die.
    sock.ev.on('creds.update', async (update) => {
      try { await saveCreds(update) } catch (e) { /* ignore flush errors */ }

      if (update.me && !shared.sessionId && !shared.done) {
        console.log(`[QR] ✅ Authenticated as ${update.me.id} — uploading to MongoDB...`)
        try {
          // Wait for creds.json to be fully flushed to disk
          const credsPath = path.join(sessionDir, 'creds.json')
          let attempts = 0
          while (!fs.existsSync(credsPath) && attempts < 5) {
            await new Promise(r => setTimeout(r, 1000))
            attempts++
          }

          const creds = JSON.parse(fs.readFileSync(credsPath, 'utf8'))
          shared.phone = creds?.me?.id?.split(':')[0]?.split('@')[0] || sessionKey
          shared.jid = update.me.id || `${shared.phone}@s.whatsapp.net`
          shared.sessionId = await saveToMongo(credsPath, shared.phone)
          console.log(`[QR] ✅ Saved to MongoDB → ${shared.sessionId}`)
          // Socket will now get a 515. We wait for the reconnect to send the DM.
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

      // Show new QR codes only if we haven't authenticated yet
      if (qr && !shared.sessionId) {
        try {
          const dataUrl = await QRCode.toDataURL(qr, { errorCorrectionLevel: 'H', margin: 2, width: 300 })
          onQR(dataUrl)
        } catch (err) {
          console.error('[QR] QR gen failed:', err.message)
        }
      }

      // ── STEP 2: On reconnected open → send the DM if sessionId is ready
      if (connection === 'open') {
        if (shared.done) return

        if (shared.sessionId) {
          // We have the sessionId from the previous socket's creds.update — send the DM now!
          shared.done = true
          console.log(`[QR] ✅ Reconnected & open — sending Session ID to ${shared.jid}`)
          try {
            const msg = await sock.sendMessage(shared.jid, { text: buildSuccessMessage(shared.sessionId) })
            
            // Log for debugging
            console.log(`[QR] Message sent (ID: ${msg?.key?.id}), waiting for socket flush...`)

            onSuccess(shared.sessionId)
          } catch (err) {
            console.error('[QR] DM send failed:', err.message)
            onSuccess(shared.sessionId)
          } finally {
            // Wait 10s for the message to actually leave the buffer and be delivered
            setTimeout(() => {
              console.log('[QR] ✅ Connection cleanup (10s buffer expired)')
              try { if (sock.ws?.readyState === 1) sock.end(undefined) } catch (_) { }
              cleanup()
            }, 10000)
          }
        }
        // If sessionId is not yet set, the creds.update is still processing — just wait
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
        const isLoggedOut = statusCode === DisconnectReason.loggedOut || statusCode === 401

        console.log(`[QR] Close — is515=${is515} | hasSession=${!!shared.sessionId} | attempt=${shared.reconnectCount}`)

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
        // After 515 with a sessionId ready, reconnect fast to send DM
        const delay = (is515 && shared.sessionId) ? 3000 : is515 ? 15000 : 5000
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