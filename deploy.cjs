const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { randomBytes } = require('node:crypto')
const { spawnSync } = require('node:child_process')
const { parseEnv } = require('node:util')
const { createInterface } = require('node:readline/promises')

if (process.platform !== 'linux') throw new Error('Deployment requires Linux with systemd.')

const envFile = path.join(__dirname, '.env')
const config = fs.existsSync(envFile) ? parseEnv(fs.readFileSync(envFile, 'utf8')) : {}
config.UPLOAD_KEY ||= randomBytes(32).toString('base64url')

function saveConfig() {
  fs.writeFileSync(envFile, Object.entries(config).map(([key, value]) => `${key}=${JSON.stringify(value)}\n`).join(''), { mode: 0o600 })
}

function run(command, args, options) {
  const result = spawnSync(command, args, { cwd: __dirname, stdio: 'inherit', ...options })
  if (result.status !== 0) throw new Error(`${path.basename(command)} failed`)
  return result
}

async function main() {
  const defaultName = config.WORKER_NAME || 'pit-events'
  if (process.stdin.isTTY) {
    const rl = createInterface({ input: process.stdin, output: process.stdout })
    config.WORKER_NAME = (await rl.question(`Worker name (empty for '${defaultName}'): `)).trim() || defaultName
    rl.close()
  } else {
    config.WORKER_NAME = defaultName
  }
  saveConfig()

  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'pit-events-'))
  const secretsFile = path.join(temp, 'secrets.json')
  const outputFile = path.join(temp, 'output.jsonl')
  try {
    fs.writeFileSync(secretsFile, JSON.stringify({ UPLOAD_KEY: config.UPLOAD_KEY }), { mode: 0o600 })
    const wrangler = path.join(path.dirname(require.resolve('wrangler/package.json')), 'bin', 'wrangler.js')
    if (spawnSync(process.execPath, [wrangler, 'whoami', '--json'], { stdio: 'pipe' }).status !== 0) {
      run(process.execPath, [wrangler, 'login', '--device', '--browser', 'false'])
    }
    run(process.execPath, [wrangler, 'deploy', '--name', config.WORKER_NAME, '--secrets-file', secretsFile], {
      env: { ...process.env, WRANGLER_OUTPUT_FILE_PATH: outputFile }
    })

    const deployment = fs.readFileSync(outputFile, 'utf8').trim().split('\n').map(line => JSON.parse(line))
      .findLast(entry => entry.type === 'deploy')
    config.WORKER_URL = deployment?.targets.find(target => target.endsWith('.workers.dev'))
    if (!config.WORKER_URL) throw new Error('No workers.dev URL returned')
    saveConfig()

    run(process.execPath, [wrangler, 'd1', 'execute', 'pit-events', '--remote', '--file', path.join(__dirname, 'schema.sql'), '--yes'])

    const user = os.userInfo().username
    run(process.getuid() === 0 ? 'loginctl' : 'sudo', process.getuid() === 0
      ? ['enable-linger', user]
      : ['loginctl', 'enable-linger', user])

    const directory = path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'systemd', 'user')
    fs.mkdirSync(directory, { recursive: true })
    fs.writeFileSync(path.join(directory, 'pit-events.service'), `[Unit]
Description=Collect Pit events

[Service]
Type=oneshot
WorkingDirectory=${__dirname}
ExecStart="${process.execPath}" "${path.join(__dirname, 'collector.cjs')}"
TimeoutStartSec=infinity
`)
    fs.writeFileSync(path.join(directory, 'pit-events.timer'), `[Unit]
Description=Collect Pit events hourly

[Timer]
OnCalendar=hourly
AccuracySec=1us
RandomizedDelaySec=0

[Install]
WantedBy=timers.target
`)
    run('systemctl', ['--user', 'daemon-reload'])
    const initial = spawnSync(process.execPath, [path.join(__dirname, 'collector.cjs')], {
      cwd: __dirname,
      stdio: 'inherit',
      env: { ...process.env, ...config }
    })
    if (initial.status !== 0) throw new Error('Initial collection failed')
    run('systemctl', ['--user', 'enable', '--now', 'pit-events.timer'])
    console.log(`Events URL: ${new URL('/', config.WORKER_URL)}`)
  } finally {
    fs.rmSync(secretsFile, { force: true })
    fs.rmSync(outputFile, { force: true })
    fs.rmdirSync(temp)
  }
}

main().catch(error => {
  console.error(error.message)
  process.exitCode = 1
})
