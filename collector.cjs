const path = require('node:path')
const fs = require('node:fs')
const mineflayer = require('mineflayer')
const nbt = require('prismarine-nbt')
const { Authflow } = require('prismarine-auth')

const envFile = path.join(__dirname, '.env')
if (fs.existsSync(envFile)) process.loadEnvFile(envFile)

if (!process.env.WORKER_URL || !process.env.UPLOAD_KEY) {
  console.error('Run npm run deploy first, or set WORKER_URL and UPLOAD_KEY.')
  process.exit(1)
}
const endpoint = new URL('/', process.env.WORKER_URL)
if (endpoint.protocol !== 'https:' && !(endpoint.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname))) {
  console.error('WORKER_URL must use HTTPS, except for local development.')
  process.exit(1)
}

let bot
let stage = 'authenticating'
let timer
let stopCapture

const logFile = path.join(__dirname, 'latest.log')
fs.writeFileSync(logFile, '')

function note(message) {
  const line = `${new Date().toISOString()} ${message}`
  fs.appendFileSync(logFile, line + '\n')
  console.log(line)
}

function stop(error) {
  if (stage === 'stopped') return
  stage = 'stopped'
  clearTimeout(timer)
  stopCapture?.()
  note(error ? `failed: ${error.message}` : 'success')
  if (error) process.exitCode = 1
  bot?.quit()
}

function enterPit() {
  if (stage !== 'joining') return
  stage = 'pit'
  clearTimeout(timer)
  note('in pit')
  timer = setTimeout(() => openEventMenu(), 5000)
}

function openEventMenu(retry = false) {
  stage = 'menu'
  note(retry ? 'retry /events' : 'chat /events')
  bot.chat('/events')
  timer = setTimeout(() => {
    if (retry) stop(new Error('Event menu not received after two attempts'))
    else openEventMenu(true)
  }, 10000)
}

function readEvents(window, capturedAt) {
  const events = []
  const minute = Math.ceil(capturedAt / 60000) * 60000
  for (const item of window.containerItems()) {
    const data = item.nbt ? nbt.simplify(item.nbt) : null
    const name = data?.display?.Name?.replace(/§[0-9a-fk-or]/gi, '')
    const lines = data?.display?.Lore
    if (!/^Major #\d+$/.test(name) || !Array.isArray(lines) || !lines.length) {
      throw new Error(`Unrecognized event menu slot: ${item.slot}.`)
    }
    for (const [index, line] of lines.entries()) {
      const text = line.replace(/§[0-9a-fk-or]/gi, '')
      if (text.startsWith('+Imminently: ')) continue
      const match = /^\+(?:(\d+)d)?(\d+)h(?:(\d+)m)?: (.+)$/.exec(text)
      if (!match) throw new Error(`Cannot parse event time: ${line}`)
      if (match[3] === undefined) continue
      const offset = ((Number(match[1] ?? 0) * 24 + Number(match[2])) * 60 + Number(match[3])) * 60000
      const timestamp = minute + offset
      if (timestamp <= capturedAt || timestamp > capturedAt + 86400000) continue
      events.push({
        name: match[4],
        type: index === lines.length - 1 ? 'major' : 'minor',
        time: new Date(timestamp).toISOString().slice(0, 16) + 'Z'
      })
    }
  }
  if (!events.length) throw new Error('Event menu is empty. Nothing was uploaded.')
  return events.sort((a, b) => a.time < b.time ? -1 : a.time > b.time ? 1 : 0)
}

async function upload(window, capturedAt) {
  stage = 'uploading'
  stopCapture()
  try {
    const events = readEvents(window, capturedAt)
    note(`uploading ${events.length} events`)
    const response = await fetch(endpoint, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${process.env.UPLOAD_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(events),
      redirect: 'error',
      signal: AbortSignal.timeout(15000)
    })
    if (!response.ok) throw new Error(`Upload failed: HTTP ${response.status}.`)
    stop()
  } catch (error) {
    stop(error)
  }
}

async function main() {
  const flow = new Authflow('pit-events', path.join(__dirname, 'auth-cache'), undefined, code => {
    console.log(`Open ${code.verification_uri} and enter code ${code.user_code}.`)
  })
  const { token, profile } = await flow.getMinecraftJavaToken({ fetchProfile: true })
  if (stage === 'stopped') return
  if (!token || !profile?.id || !profile.name) {
    throw new Error('Minecraft authentication did not return a profile.')
  }

  stage = 'waiting'
  await new Promise(resolve => {
    timer = setTimeout(resolve, 60000 - Date.now() % 60000)
  })
  if (stage === 'stopped') return

  stage = 'connecting'
  timer = setTimeout(() => stop(new Error('Hypixel connection and spawn timed out')), 10000)
  bot = mineflayer.createBot({
    host: 'mc.hypixel.net',
    version: '1.8.9',
    username: profile.name,
    auth: (client, options) => {
      client.username = profile.name
      client.session = { accessToken: token, selectedProfile: profile }
      options.accessToken = token
      options.haveCredentials = true
      options.connect(client)
    }
  })

  bot.on('connect', () => note('connect'))
  bot.on('login', () => {
    note('login')
    enterPit()
  })
  bot.once('spawn', () => {
    note(`spawn ${bot.game.dimension} ${bot.entity.position}`)
    if (stage !== 'connecting') return
    clearTimeout(timer)
    stage = 'spawned'
    timer = setTimeout(() => {
      stage = 'joining'
      note('chat /play pit')
      bot.chat('/play pit')
      timer = setTimeout(() => stop(new Error('Pit join timed out')), 10000)
    }, 5000)
  })
  bot.on('message', message => {
    const text = message.toString().replace(/§[0-9a-fk-or]/gi, '')
    if (text.startsWith('PIT!')) enterPit()
    if (/pit|sending|queue|limbo|events/i.test(text)) note(`chat ${text}`)
  })

  bot.on('windowOpen', window => {
    const capturedAt = Date.now()
    note(`windowOpen ${JSON.stringify(window.title)}`)
    if (stage !== 'menu' || !window.title.includes('Pit Supporter: /events')) return
    clearTimeout(timer)
    stage = 'capturing'
    let captureTimer

    function schedule(slot) {
      if (slot !== undefined && slot >= window.inventoryStart) return
      clearTimeout(captureTimer)
      captureTimer = setTimeout(() => upload(window, capturedAt), 300)
    }
    stopCapture = () => {
      clearTimeout(captureTimer)
      window.removeListener('updateSlot', schedule)
      stopCapture = undefined
    }
    window.on('updateSlot', schedule)
    schedule()
  })

  bot.on('windowClose', window => {
    note(`windowClose ${JSON.stringify(window.title)}`)
    if (stage === 'capturing') stop(new Error('Event menu closed before capture completed'))
  })
  bot.on('kicked', reason => stop(new Error(`Kicked: ${JSON.stringify(reason)}`)))
  bot.on('error', stop)
  bot.on('end', reason => stop(new Error(`Connection ended: ${reason}`)))
}

process.on('SIGINT', () => stop())
main().catch(stop)
