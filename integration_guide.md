# HANS-MD Bot Integration Guide

This guide explains how to update the main HANS-MD bot to fetch session data from your new pairing server's MongoDB storage.

## 1. Updated Session Workflow

The pairing server now saves `creds.json` to MongoDB and provides a `SESSION_ID` in the format:  
`HANS-BYTE~66266...` (where the part after `~` is the MongoDB ObjectId).

The main bot needs to fetch this data on startup instead of relying on local files.

## 2. Bot Configuration

Update your bot's `config.js` or `.env` to include the pairing server's base URL:

```javascript
// Example in bot config.js
module.exports = {
    SESSION_ID: process.env.SESSION_ID || '',
    PAIRING_SERVER_URL: process.env.PAIRING_SERVER_URL || 'https://your-pairing-server.com',
}
```

## 3. Implementation (Main Bot `index.js`)

Add a helper function to fetch the session data before initializing the socket.

```javascript
const axios = require('axios');
const fs = require('fs');
const path = require('path');

async function initializeSession() {
    const { SESSION_ID, PAIRING_SERVER_URL } = require('./config');
    const sessionPath = './session'; // Your local session folder
    const credsPath = path.join(sessionPath, 'creds.json');

    // Skip if session already exists locally or no ID provided
    if (fs.existsSync(credsPath)) return;
    if (!SESSION_ID || !SESSION_ID.startsWith('HANS-BYTE~')) return;

    console.log('📡 Fetching session from cloud storage...');

    try {
        const response = await axios.get(`${PAIRING_SERVER_URL}/session/${SESSION_ID}`);
        
        if (!fs.existsSync(sessionPath)) fs.mkdirSync(sessionPath);
        
        fs.writeFileSync(credsPath, JSON.stringify(response.data, null, 2));
        console.log('✅ Session synchronized successfully!');
    } catch (err) {
        console.error('❌ Failed to fetch session:', err.message);
        process.exit(1);
    }
}

// Call this before starting your Baileys socket
initializeSession().then(() => startBot());
```

## 4. Why This is Better
- **Persistence**: Sessions are stored in MongoDB, not ephemeral server files.
- **Ease of Deployment**: Users only need to copy a short Session ID string to Heroku/Koyeb/Render.
- **Security**: The pairing server provides a secure API to fetch specific IDs.

## 5. Security Note
> [!CAUTION]
> Ensure `PAIRING_SERVER_URL` is kept private if possible, or implement a secret header check in `server.js` if you want to prevent unauthorized fetching of sessions.
