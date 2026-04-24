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
const { uploadToMega } = require('./megaUpload')
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
    // If a session exists, trigger its cleanup SYNCHRONOUSLY to prevent its 
    // pending setTimeout from deleting our new directory later.
    try { activeSessions.get(phone)(true) } catch (_) { }
  }

  const sessionDir = path.join(__dirname, '..', 'sessions', phone)

  // Shared state across reconnect cycles
  const shared = {
    settled: false,
    codeResolved: false,
    resolveCode: null,
    rejectCode: null,
    reconnectCount: 0,
    version: null,
  }

  const MAX_RECONNECTS = 10

  // Full session cleanup
  const fullCleanup = (sync = false) => {
    activeSessions.delete(phone)
    if (sync) {
      try { fs.rmSync(sessionDir, { recursive: true, force: true }) } catch (_) { }
    } else {
      setTimeout(() => {
        // Double check it hasn't been re-registered by a newer session
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

  // ── Internal recursive connect ─────────────────────────────────────────────
  // isFirstConnect=true  → wipe session dir, fresh creds, request pairing code
  // isFirstConnect=false → use existing saved creds, skip code request, wait for open
  async function connect(isFirstConnect) {
    if (shared.settled) return

    if (isFirstConnect) {
      // Wipe stale session data — old creds cause passive:true → WA rejects code
      try { fs.rmSync(sessionDir, { recursive: true, force: true }) } catch (_) { }
      fs.mkdirSync(sessionDir, { recursive: true })
    } else if (!fs.existsSync(sessionDir)) {
      // Ensure directory exists even on reconnects (in case of unexpected deletion)
      fs.mkdirSync(sessionDir, { recursive: true })
    }

    // Fetch version once, reuse on reconnects
    if (!shared.version) {
      const { version } = await fetchLatestBaileysVersion()
      shared.version = version
    }

    const { state, saveCreds } = await useMultiFileAuthState(sessionDir)

    const sock = makeWASocket({
      version: shared.version,
      printQRInTerminal: false,
      logger: pino({ level: 'debug' }),
      auth: state,
      browser: Browsers.ubuntu('Chrome'),
      defaultQueryTimeoutMs: undefined,
      generateHighQualityLinkPreview: false,
      syncFullHistory: false,
    })

    if (sock.ws && typeof sock.ws.on === 'function') {
      sock.ws.on('error', () => { })
    }

    // Attach ALL listeners BEFORE any async work (mirrors gifted pattern)
    sock.ev.on('creds.update', saveCreds)

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect } = update

      // Pull statusCode both ways — Baileys v7 rc.x is inconsistent about
      // populating output.statusCode on stream errors, so we check both
      const statusCode = lastDisconnect?.error?.output?.statusCode
        ?? lastDisconnect?.error?.data?.reason
      const errMsg = lastDisconnect?.error?.message ?? ''

      console.log(
        `[PAIR-CODE] conn=${connection ?? '-'} | status=${statusCode} | ` +
        `reconnects=${shared.reconnectCount} | settled=${shared.settled} | ` +
        `registered=${sock.authState.creds.registered} | msg="${errMsg}"`
      )

      // ── Connection open = pairing complete ──────────────────────────────
      if (connection === 'open') {
        if (shared.settled) return
        shared.settled = true
        console.log('[PAIR-CODE] ✅ Connection open — uploading session...')
        try {
          const credsPath = path.join(sessionDir, 'creds.json')
          const sessionId = await uploadToMega(credsPath, phone)
          const jid = `${phone}@s.whatsapp.net`
          await sock.sendMessage(jid, { text: buildSuccessMessage(sessionId) })
          onSuccess(sessionId)
          console.log(`[PAIR-CODE] ✅ Session delivered to ${phone}`)
        } catch (err) {
          console.error('[PAIR-CODE] Upload/send failed:', err.message)
          onError(err)
        } finally {
          try { if (sock.ws?.readyState === 1) sock.end(undefined) } catch (_) { }
          fullCleanup(false) // Use delayed cleanup on success
        }
        return
      }

      // ── Connection closed ────────────────────────────────────────────────
      if (connection === 'close') {
        // Check if this is 515 / restart-required — Baileys v7 is unreliable
        // with statusCode on stream errors so we check the message too
        const is515 = (
          statusCode === 515 ||
          statusCode === DisconnectReason.restartRequired ||
          errMsg.toLowerCase().includes('restart required') ||
          errMsg.toLowerCase().includes('stream errored')
        )
        const isLoggedOut = statusCode === DisconnectReason.loggedOut || statusCode === 401
        const isFatal = isLoggedOut || statusCode === 403

        console.log(`[PAIR-CODE] close detail — is515=${is515} | isFatal=${isFatal}`)

        // Fatal: logged out or forbidden — don't retry
        if (isFatal) {
          if (!shared.settled) {
            shared.settled = true
            const err = lastDisconnect?.error || new Error(`Fatal disconnect (${statusCode})`)
            if (!shared.codeResolved) { shared.rejectCode(err); shared.codeResolved = true }
            onError(err)
            fullCleanup(false)
          }
          return
        }

        // Too many reconnects
        if (shared.reconnectCount >= MAX_RECONNECTS) {
          if (!shared.settled) {
            shared.settled = true
            const err = new Error(`Max reconnects (${MAX_RECONNECTS}) reached`)
            if (!shared.codeResolved) { shared.rejectCode(err); shared.codeResolved = true }
            onError(err)
            fullCleanup(false)
          }
          return
        }

        // Reject code promise if we closed before ever getting a code
        if (!shared.codeResolved) {
          shared.codeResolved = true
          shared.rejectCode(lastDisconnect?.error || new Error(`WS closed before code (${statusCode})`))
        }

        if (shared.settled) return

        // Reconnect — 515 waits 15s (WA needs time after pairing handshake),
        // everything else waits 5s
        shared.reconnectCount++
        const delay = is515 ? 15000 : 5000
        console.log(`[PAIR-CODE] Reconnecting in ${delay / 1000}s (attempt ${shared.reconnectCount}/${MAX_RECONNECTS})...`)
        setTimeout(() => connect(false), delay)
      }
    })

    // ── Request pairing code (first connect only) ──────────────────────────
    // On reconnects creds.registered===true so we skip this block and just
    // let the socket open naturally — this is the core of the gifted pattern
    if (!sock.authState.creds.registered) {
      // Small delay for WS handshake to settle before hitting the code endpoint
      await new Promise(r => setTimeout(r, 2000))
      if (shared.settled) return

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
        if (!shared.settled) {
          shared.settled = true
          if (!shared.codeResolved) { shared.rejectCode(err); shared.codeResolved = true }
          onError(err)
          fullCleanup(false)
        }
      }
    } else {
      console.log(`[PAIR-CODE] Reconnect — creds registered, waiting for open...`)
    }
  }

  // Kick off
  connect(true).catch(err => {
    if (!shared.settled) {
      shared.settled = true
      if (!shared.codeResolved) { shared.rejectCode(err); shared.codeResolved = true }
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

  const sessionDir = path.join(__dirname, '..', 'sessions', sessionKey)

  try { fs.rmSync(sessionDir, { recursive: true, force: true }) } catch (_) { }
  fs.mkdirSync(sessionDir, { recursive: true })

  const { state, saveCreds } = await useMultiFileAuthState(sessionDir)
  const { version } = await fetchLatestBaileysVersion()

  const sock = makeWASocket({
    version,
    printQRInTerminal: false,
    logger: pino({ level: 'debug' }),
    auth: state,
    browser: Browsers.ubuntu('Chrome'),
    defaultQueryTimeoutMs: undefined,
    generateHighQualityLinkPreview: false,
    syncFullHistory: false,
  })

  if (sock.ws && typeof sock.ws.on === 'function') {
    sock.ws.on('error', () => { })
  }

  let settled = false

  const cleanup = () => {
    activeSessions.delete(sessionKey)
    try { if (sock.ws?.readyState === 1) sock.end(undefined) } catch (_) { }
    setTimeout(() => {
      try { fs.rmSync(sessionDir, { recursive: true, force: true }) } catch (_) { }
    }, config.sessionCleanupDelay)
  }

  activeSessions.set(sessionKey, cleanup)
  sock.ev.on('creds.update', saveCreds)

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update

    if (qr) {
      try {
        const dataUrl = await QRCode.toDataURL(qr, {
          errorCorrectionLevel: 'H',
          margin: 2,
          width: 300,
        })
        onQR(dataUrl)
      } catch (err) {
        if (!settled) { settled = true; onError(err); cleanup() }
      }
    }

    if (connection === 'open') {
      if (settled) return
      settled = true
      try {
        const credsPath = path.join(sessionDir, 'creds.json')
        const creds = JSON.parse(fs.readFileSync(credsPath, 'utf8'))
        const phone = creds?.me?.id?.split(':')[0]?.split('@')[0] ?? sessionKey
        const sessionId = await uploadToMega(credsPath, phone)
        const jid = creds?.me?.id ?? `${phone}@s.whatsapp.net`
        await sock.sendMessage(jid, { text: buildSuccessMessage(sessionId) })
        onSuccess(sessionId)
      } catch (err) {
        onError(err)
      } finally {
        cleanup()
      }
    }

    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode
      const isLoggedOut = statusCode === DisconnectReason.loggedOut || statusCode === 401
      if (!settled && isLoggedOut) {
        settled = true
        onError(lastDisconnect?.error || new Error('Session expired'))
        cleanup()
      }
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