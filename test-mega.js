require('dotenv').config()
const { Storage } = require('megajs')
const config = require('./config')

async function testMega() {
  console.log('Testing MEGA credentials...')
  console.log(`Email: ${config.mega.email}`)
  console.log(`Password: ${config.mega.password.replace(/./g, '*')}`)

  try {
    const storage = await new Storage({
      email: config.mega.email,
      password: config.mega.password,
    }).ready

    console.log('✅ Successfully logged in to MEGA!')
    console.log(`Root folder name: ${storage.root.name}`)
    
    // Check for sessions folder
    const folder = Object.values(storage.root.children || {})
      .find(n => n.name === config.mega.folder)

    if (folder) {
      console.log(`✅ Session folder "${config.mega.folder}" exists.`)
    } else {
      console.log(`ℹ️ Session folder "${config.mega.folder}" doesn't exist yet (will be created on first pair).`)
    }

    process.exit(0)
  } catch (err) {
    console.error('❌ Failed to login to MEGA.')
    console.error(`Error: ${err.message}`)
    
    if (err.message.includes('password')) {
      console.log('TIP: Double check your email and password in the .env file.')
    } else if (err.message.includes('ECONNREFUSED')) {
      console.log('TIP: Check your internet connection.')
    }
    
    process.exit(1)
  }
}

testMega()
