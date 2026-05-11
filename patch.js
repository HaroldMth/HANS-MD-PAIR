const fs = require('fs')
const path = require('path')

const baileysLib = path.join(__dirname, 'node_modules', '@whiskeysockets', 'baileys', 'lib')

function assertExists(filePath, label) {
  if (!fs.existsSync(filePath)) {
    console.error(`❌ Patch aborted: ${label} not found at ${filePath}`)
    console.error('   Is @whiskeysockets/baileys installed?')
    process.exit(1)
  }
}

function assertReplaced(before, after, label) {
  if (before === after) {
    console.warn(`⚠  Patch skipped: "${label}" pattern not found — already patched or RC changed`)
  } else {
    console.log(`✅ Patched: ${label}`)
  }
}

function applyPatches() {
  // ── validate-connection.js ──────────────────────────────────────────────
  const validatePath = path.join(baileysLib, 'Utils', 'validate-connection.js')
  assertExists(validatePath, 'Utils/validate-connection.js')

  let vc = fs.readFileSync(validatePath, 'utf8')
  const vc0 = vc

  // Patch 1: passive: true → passive: false
  // WA server treats passive:true as a listener-only device and kills it with 401
  const vc1 = vc.replace(/passive:\s*true/g, 'passive: false')
  assertReplaced(vc, vc1, 'passive: true → false')
  vc = vc1

  // Patch 2: remove lidDbMigrated: false
  // Field doesn't exist in WA's protocol spec — server rejects payloads containing it
  const vc2 = vc
    .replace(/,\s*\/\/[^\n]*\n\s*lidDbMigrated:\s*false/g, '')   // with preceding comment
    .replace(/,\s*lidDbMigrated:\s*false/g, '')                   // with leading comma
    .replace(/lidDbMigrated:\s*false,\s*/g, '')                   // with trailing comma
    .replace(/lidDbMigrated:\s*false/g, '')                       // bare
  assertReplaced(vc, vc2, 'lidDbMigrated: false removed')
  vc = vc2

  fs.writeFileSync(validatePath, vc)

  // ── socket.js ───────────────────────────────────────────────────────────
  const socketPath = path.join(baileysLib, 'Socket', 'socket.js')
  assertExists(socketPath, 'Socket/socket.js')

  let sock = fs.readFileSync(socketPath, 'utf8')
  const sock0 = sock

  // Patch 3: await noise.finishInit() → noise.finishInit()
  // The await creates a race condition — keep-alive fires before the noise
  // handshake state is committed, causing WA to reject the session with 401
  const sock1 = sock.replace(/await\s+noise\.finishInit\(\)/g, 'noise.finishInit()')
  assertReplaced(sock, sock1, 'await noise.finishInit() → noise.finishInit()')
  sock = sock1

  fs.writeFileSync(socketPath, sock)

  // ── Verify ──────────────────────────────────────────────────────────────
  console.log('\n🔍 Verification:')

  const vcFinal = fs.readFileSync(validatePath, 'utf8')
  console.log('  passive:       ', vcFinal.includes('passive: false') ? '✅ false' : '❌ still true')
  console.log('  lidDbMigrated: ', vcFinal.includes('lidDbMigrated') ? '❌ still present' : '✅ removed')

  const sockFinal = fs.readFileSync(socketPath, 'utf8')
  const hasAwait = /await\s+noise\.finishInit\(\)/.test(sockFinal)
  console.log('  finishInit:    ', hasAwait ? '❌ await still present' : '✅ await removed')

  if (
    !vcFinal.includes('passive: false') ||
    vcFinal.includes('lidDbMigrated') ||
    hasAwait
  ) {
    console.error('\n❌ One or more patches failed — check output above')
    process.exit(1)
  }

  console.log('\n✅ All Baileys RC patches applied successfully\n')
}

applyPatches()
