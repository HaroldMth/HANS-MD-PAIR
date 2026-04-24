const { saveToMongo, getSession } = require('./lib/mongoStore')
const fs = require('fs')
const path = require('path')

/**
 * TEST SCRIPT: MongoDB Upload Check
 * This script creates a temporary dummy creds.json and attempts to upload it 
 * using the same logic the pairing server uses.
 */

async function runTest() {
  const testPhone = '237000000000'
  const tempDir = path.join(__dirname, 'sessions', 'test-session')
  const credsPath = path.join(tempDir, 'creds.json')

  console.log('🚀 Starting MongoDB Upload Test...')

  try {
    // 1. Setup dummy session file
    if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true })
    
    const dummyCreds = {
      noiseKey: { private: 'abc', public: 'def' },
      me: { id: `${testPhone}@s.whatsapp.net`, name: 'Test User' },
      testTimestamp: Date.now()
    }

    fs.writeFileSync(credsPath, JSON.stringify(dummyCreds, null, 2))
    console.log('📝 Created dummy creds.json')

    // 2. Test saveToMongo
    console.log('📤 Uploading to MongoDB...')
    const sessionId = await saveToMongo(credsPath, testPhone)
    console.log(`✅ Success! Received Session ID: ${sessionId}`)

    // 3. Verify by fetching it back
    console.log('📥 Verifying by fetching session back...')
    const fetched = await getSession(sessionId)
    
    if (fetched && fetched.me.id === dummyCreds.me.id) {
      console.log('✨ Data integrity verified! Fetch matched local data.')
    } else {
      throw new Error('Data verification failed — fetched data does not match!')
    }

    console.log('\n🎉 TEST PASSED SUCCESSFULLY')

  } catch (err) {
    console.error('\n❌ TEST FAILED')
    console.error(err.message)
    process.exit(1)
  } finally {
    // Cleanup
    try {
      if (fs.existsSync(credsPath)) fs.unlinkSync(credsPath)
      if (fs.existsSync(tempDir)) fs.rmdirSync(tempDir)
      console.log('🧹 Cleanup complete.')
    } catch (_) {}
  }
}

runTest()
