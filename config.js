require('dotenv').config()

module.exports = {

  // ── MongoDB Configuration ──────────────────
  mongo: {
    url: process.env.MONGODB_URL || '',
    collection: 'sessions',
  },

  // ── Bot Identity ──────────────────────────
  bot: {
    name: process.env.BOT_NAME || 'HANS BYTE MD',
    sessionPrefix: process.env.SESSION_PREFIX || 'HANS-BYTE~',
    owner: process.env.OWNER_NAME || 'Harold Mth',
    repoUrl: process.env.REPO_URL || 'https://github.com/HaroldMth/HANS___MD',
  },

  // ── Server ────────────────────────────────
  port: process.env.PORT || 3000,

  // ── Session cleanup (ms after pairing) ────
  sessionCleanupDelay: 60_000, 
}
