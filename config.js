require('dotenv').config()

module.exports = {

  // ── MEGA Credentials ──────────────────────
  mega: {
    email: process.env.MEGA_EMAIL || 'your_mega_email@gmail.com',
    password: process.env.MEGA_PASSWORD || 'your_mega_password',
    folder: 'HANS-SESSIONS',
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
