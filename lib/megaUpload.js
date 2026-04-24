const { Storage } = require('megajs')
const fs = require('fs')
const path = require('path')
const config = require('../config')

/**
 * Upload a creds.json file to MEGA and return the HANS-BYTE~ session ID
 * @param {string} credsPath - path to creds.json
 * @param {string} phone - phone number (used as filename)
 * @returns {Promise<string>} - HANS-BYTE~fileId#key
 */
async function uploadToMega(credsPath, phone) {
  const storage = await new Storage({
    email: config.mega.email,
    password: config.mega.password,
  }).ready

  // Get or create the sessions folder
  let folder = Object.values(storage.root.children || {})
    .find(n => n.name === config.mega.folder)

  if (!folder) {
    folder = await storage.mkdir(config.mega.folder)
  }

  const fileBuffer = fs.readFileSync(credsPath)
  const fileName = `${phone}_creds.json`

  // Upload
  const uploadedFile = await folder.upload({
    name: fileName,
    size: fileBuffer.length,
  }, fileBuffer).complete

  // Share and get public URL
  const shareUrl = await uploadedFile.link()

  // Parse: https://mega.nz/file/{fileId}#{key}
  // e.g.   https://mega.nz/file/AbCdEfGh#9Dqyn9Lw...
  const match = shareUrl.match(/mega\.nz\/file\/([^#]+)#(.+)/)
  if (!match) throw new Error(`Unexpected MEGA URL format: ${shareUrl}`)

  const [, fileId, key] = match
  const sessionId = `${config.bot.sessionPrefix}${fileId}#${key}`

  return sessionId
}

module.exports = { uploadToMega }
