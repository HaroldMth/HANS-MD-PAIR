const express = require('express')
const cors = require('cors')
const path = require('path')
const config = require('./config')
const { startPairingCode, startQRSession } = require('./lib/pairer')
const { getSession } = require('./lib/mongoStore')

const app = express()
app.use(cors())
app.use(express.json())
app.use(express.static(path.join(__dirname, 'public')))

// ─── Pending sessions registry (phone → sessionId once done) ──────────────────
const pendingSessions = new Map()   // phone → { sessionId: null | string, error: null | string }

function genKey() { return Math.random().toString(36).slice(2) }

// ─── POST /api/pair/code ───────────────────────────────────────────────────────
// Body: { phone: "237612345678" }
// Returns: { code: "ABCD-1234" } immediately; use GET /api/status/:phone to poll
app.post('/api/pair/code', async (req, res) => {
  const { phone } = req.body
  if (!phone) return res.status(400).json({ error: 'Phone number is required' })

  const cleaned = phone.replace(/\D/g, '')
  if (cleaned.length < 7 || cleaned.length > 15)
    return res.status(400).json({ error: 'Invalid phone number format' })

  // Reset status for this phone
  pendingSessions.set(cleaned, { sessionId: null, error: null })

  try {
    const code = await startPairingCode(
      cleaned,
      (sessionId) => {
        console.log(`[✓] Pairing success for ${cleaned}`)
        pendingSessions.set(cleaned, { sessionId, error: null })
        // Auto-cleanup registry after 10 minutes
        setTimeout(() => pendingSessions.delete(cleaned), 600_000)
      },
      (err) => {
        console.error(`[✗] Pairing error for ${cleaned}:`, err.message)
        pendingSessions.set(cleaned, { sessionId: null, error: err.message })
      }
    )
    return res.json({ code })
  } catch (err) {
    console.error('[✗] startPairingCode threw:', err.message)
    pendingSessions.delete(cleaned)
    return res.status(500).json({ error: err.message || 'Failed to generate pairing code' })
  }
})

// ─── GET /api/status/:phone ───────────────────────────────────────────────────
// Polling endpoint used by frontend after code is displayed
app.get('/api/status/:phone', (req, res) => {
  const phone = req.params.phone.replace(/\D/g, '')
  const entry = pendingSessions.get(phone)
  if (!entry) return res.status(404).json({ error: 'No active session' })
  if (entry.error) return res.status(500).json({ error: entry.error })
  if (entry.sessionId) return res.json({ sessionId: entry.sessionId })
  return res.json({ pending: true })
})

// ─── GET /api/pair/qr ─────────────────────────────────────────────────────────
// SSE stream. Sends:
//   { type: 'qr',     data: '<dataUrl>' }
//   { type: 'success',data: '<sessionId>' }
//   { type: 'error',  data: '<message>' }
app.get('/api/pair/qr', (req, res) => {
  const sessionKey = req.query.key || genKey()

  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.setHeader('X-Accel-Buffering', 'no')
  res.flushHeaders()

  const send = (type, data) => {
    res.write(`data: ${JSON.stringify({ type, data })}\n\n`)
  }

  // Heartbeat every 20s so the connection stays alive
  const heartbeat = setInterval(() => res.write(': ping\n\n'), 20_000)

  const cleanup = () => { clearInterval(heartbeat) }

  req.on('close', cleanup)

  send('connected', sessionKey)

  startQRSession(
    sessionKey,
    (qrDataUrl) => send('qr', qrDataUrl),
    (sessionId) => {
      send('success', sessionId)
      cleanup()
    },
    (err) => {
      send('error', err.message || 'Connection failed')
      cleanup()
    }
  ).catch((err) => {
    send('error', err.message || 'Failed to start QR session')
    cleanup()
  })
})

// ─── GET /session/:id ──────────────────────────────────────────────────────────
// Public endpoint for bots to fetch their session data
app.get('/session/:id', async (req, res) => {
  const sessionId = req.params.id
  try {
    const data = await getSession(sessionId)
    if (!data) return res.status(404).json({ error: 'Session not found' })
    return res.json(data)
  } catch (err) {
    return res.status(500).json({ error: 'Internal server error' })
  }
})

// ─── GET /api/test-db ────────────────────────────────────────────────────────
// Test connectivity to MongoDB and list basic stats
app.get('/api/test-db', async (req, res) => {
  const { MongoClient } = require('mongodb')
  const client = new MongoClient(config.mongo.url)
  try {
    await client.connect()
    const db = client.db()
    const collection = db.collection(config.mongo.collection)
    const count = await collection.countDocuments()
    return res.json({ 
      status: 'success', 
      message: 'MongoDB connection successful',
      collection: config.mongo.collection,
      sessionCount: count 
    })
  } catch (err) {
    return res.status(500).json({ status: 'error', message: err.message })
  } finally {
    await client.close()
  }
})

// ─── GET / ────────────────────────────────────────────────────────────────────
app.get('*', (_, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'))
})

// ─── Start ────────────────────────────────────────────────────────────────────
app.listen(config.port, () => {
  console.log(`
╔══════════════════════════════════════╗
║       HANS MD PAIRING SERVER         ║
╠══════════════════════════════════════╣
║  Status  : ✅ Running                ║
║  Port    : ${String(config.port).padEnd(26)}║
║  URL     : http://localhost:${String(config.port).padEnd(10)}║
╚══════════════════════════════════════╝
  `)
})
