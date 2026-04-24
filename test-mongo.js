require('dotenv').config()
const { MongoClient } = require('mongodb')
const config = require('./config')

async function testMongo() {
  console.log('Testing MongoDB connection...')
  
  if (!config.mongo.url) {
    console.error('❌ MONGODB_URL is not set in your .env file!')
    console.log('Please add MONGODB_URL="your-connection-string" to your .env file.')
    process.exit(1)
  }

  // Hide the password in the URL for logging
  const maskedUrl = config.mongo.url.replace(/:([^:@]+)@/, ':****@')
  console.log(`Connecting to: ${maskedUrl}`)

  const client = new MongoClient(config.mongo.url)

  try {
    await client.connect()
    console.log('✅ Successfully connected to MongoDB!')
    
    // Check if the database and collection exist/are accessible
    const db = client.db()
    console.log(`Using Database: ${db.databaseName}`)
    
    const collections = await db.listCollections({ name: config.mongo.collection }).toArray()
    
    if (collections.length > 0) {
      console.log(`✅ Collection "${config.mongo.collection}" exists.`)
      
      const count = await db.collection(config.mongo.collection).countDocuments()
      console.log(`📊 Number of sessions stored: ${count}`)
    } else {
      console.log(`ℹ️ Collection "${config.mongo.collection}" doesn't exist yet (will be created automatically on first pair).`)
    }

    // Attempt a quick ping to confirm the connection is fully operational
    await db.command({ ping: 1 })
    console.log('✅ Database ping successful!')

    process.exit(0)
  } catch (err) {
    console.error('❌ Failed to connect to MongoDB.')
    console.error(`Error: ${err.message}`)
    
    if (err.message.includes('Authentication failed')) {
      console.log('TIP: Double check your username, password, and connection string in the .env file.')
    } else if (err.message.includes('ECONNREFUSED') || err.message.includes('ETIMEOUT')) {
      console.log('TIP: Check your internet connection and ensure your MongoDB cluster allows connections from your IP (Network Access in MongoDB Atlas).')
    }
    
    process.exit(1)
  }
}

testMongo()
