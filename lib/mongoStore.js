const { MongoClient } = require('mongodb')
const fs = require('fs')
const config = require('../config')

/**
 * Save session data to MongoDB and return a Session ID
 * @param {string} credsPath - path to creds.json
 * @param {string} phone - phone number
 * @returns {Promise<string>} - HANS-BYTE~uniqueId
 */
async function saveToMongo(credsPath, phone) {
  if (!config.mongo.url) {
    throw new Error('MONGODB_URL is not set in environment variables')
  }

  const client = new MongoClient(config.mongo.url)
  
  try {
    await client.connect()
    const db = client.db()
    const collection = db.collection(config.mongo.collection)

    const creds = JSON.parse(fs.readFileSync(credsPath, 'utf8'))
    
    // We store the creds as a base64 string or plain JSON string 
    // to make it easy for the bot to fetch and parse.
    const sessionData = Buffer.from(JSON.stringify(creds)).toString('base64')

    const result = await collection.insertOne({
      phone: phone,
      sessionData: sessionData,
      createdAt: new Date()
    })

    const sessionId = `${config.bot.sessionPrefix}${result.insertedId}`
    return sessionId
  } finally {
    await client.close()
  }
}

/**
 * Get session data from MongoDB by Session ID
 * @param {string} sessionId - the full session ID with prefix
 * @returns {Promise<object>} - the creds JSON
 */
async function getSession(sessionId) {
  const actualId = sessionId.split('~')[1]
  if (!actualId) throw new Error('Invalid Session ID format')

  const { ObjectId } = require('mongodb')
  const client = new MongoClient(config.mongo.url)
  try {
    await client.connect()
    const db = client.db()
    const collection = db.collection(config.mongo.collection)

    const doc = await collection.findOne({ _id: new ObjectId(actualId) })
    if (!doc) return null

    const sessionJson = Buffer.from(doc.sessionData, 'base64').toString('utf8')
    return JSON.parse(sessionJson)
  } finally {
    await client.close()
  }
}

module.exports = { saveToMongo, getSession }
