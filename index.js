import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
} from '@whiskeysockets/baileys'
import express from 'express'
import fetch from 'node-fetch'
import qrcode from 'qrcode'
import pino from 'pino'
import cors from 'cors'

const app = express()
app.use(express.json())
app.use(cors())

const PORT = process.env.PORT || 3000
const NUTTIN_WEBHOOK = process.env.NUTTIN_WEBHOOK_URL
const MY_NUMBER = process.env.MY_WA_NUMBER
const logger = pino({ level: 'silent' })

let sock = null
let currentQR = null
let isConnected = false
let reconnectAttempts = 0
const MAX_RECONNECT = 10

async function startSock() {
  const { state, saveCreds } = await useMultiFileAuthState('auth_info')
  const { version } = await fetchLatestBaileysVersion()

  sock = makeWASocket({
    version,
    auth: state,
    logger,
    printQRInTerminal: true,
    browser: ['Nuttin OS', 'Chrome', '1.0'],
    connectTimeoutMs: 60000,
    keepAliveIntervalMs: 25000,
  })

  sock.ev.on('creds.update', saveCreds)

  sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      currentQR = await qrcode.toDataURL(qr)
      console.log('QR gereed — open /qr')
    }
    if (connection === 'open') {
      isConnected = true
      currentQR = null
      reconnectAttempts = 0
      console.log('WhatsApp verbonden!')
    }
    if (connection === 'close') {
      isConnected = false
      const code = lastDisconnect?.error?.output?.statusCode
      if (code === DisconnectReason.loggedOut) {
        console.log('Uitgelogd — verwijder auth en herstart')
        // Reset auth so a new QR is generated
        currentQR = null
        return
      }
      reconnectAttempts++
      if (reconnectAttempts <= MAX_RECONNECT) {
        const delay = Math.min(3000 * reconnectAttempts, 30000)
        console.log(`Herverbinden poging ${reconnectAttempts}/${MAX_RECONNECT} in ${delay}ms...`)
        setTimeout(startSock, delay)
      } else {
        console.error('Max herverbindpogingen bereikt. Herstart de server.')
      }
    }
  })

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return
    for (const msg of messages) {
      if (msg.key.fromMe) continue
      const from = msg.key.remoteJid || ''
      if (MY_NUMBER && !from.includes(MY_NUMBER)) continue
      const text =
        msg.message?.conversation ||
        msg.message?.extendedTextMessage?.text || ''
      if (!text.trim() || !NUTTIN_WEBHOOK) continue
      try {
        const res = await fetch(NUTTIN_WEBHOOK, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ from, body: text }),
        })
        const data = await res.json()
        if (data.reply) {
          await sock.sendMessage(from, { text: data.reply })
          console.log(`Antwoord gestuurd naar ${from}: ${data.reply.substring(0, 50)}...`)
        }
      } catch (e) { console.error('Webhook fout:', e.message) }
    }
  })
}

// ─── Routes ──────────────────────────────────────────────────

app.get('/', (_, res) => res.json({
  service: 'Nuttin WhatsApp Bridge',
  status: isConnected ? 'connected' : currentQR ? 'awaiting_scan' : 'starting',
  connected: isConnected,
  hasQR: !!currentQR,
  number: MY_NUMBER || 'not set',
  uptime: Math.floor(process.uptime()),
}))

app.get('/qr', (_, res) => {
  if (isConnected) {
    return res.send(`<html><body style="font-family:-apple-system,sans-serif;text-align:center;padding:60px;background:#f0fff0">
      <h2 style="color:#1B7A2B">WhatsApp verbonden</h2>
      <p style="color:#666;margin-top:8px">Nummer: ${MY_NUMBER || 'onbekend'}</p>
      <p style="color:#999;font-size:13px;margin-top:16px">Je kunt dit venster sluiten.</p>
    </body></html>`)
  }
  if (!currentQR) {
    return res.send(`<html><head><meta http-equiv="refresh" content="3"></head>
      <body style="font-family:-apple-system,sans-serif;text-align:center;padding:60px">
      <h2>QR laden...</h2>
      <p style="color:#666">Pagina vernieuwt automatisch.</p>
    </body></html>`)
  }
  res.send(`<html><head><meta http-equiv="refresh" content="20"></head>
    <body style="font-family:-apple-system,sans-serif;text-align:center;padding:40px;max-width:400px;margin:0 auto">
    <h2 style="margin-bottom:8px">Scan met WhatsApp</h2>
    <p style="color:#666;font-size:14px;margin-bottom:20px">WhatsApp → Instellingen → Gekoppelde apparaten → Apparaat koppelen</p>
    <img src="${currentQR}" style="width:280px;height:280px;border:1px solid #eee;border-radius:12px" />
    <p style="color:#aaa;font-size:12px;margin-top:16px">QR vernieuwt automatisch</p>
  </body></html>`)
})

app.get('/status', (_, res) => res.json({
  connected: isConnected,
  hasQR: !!currentQR,
  number: MY_NUMBER || null,
  uptime: Math.floor(process.uptime()),
}))

app.post('/send', async (req, res) => {
  const { to, message } = req.body
  if (!to || !message) return res.status(400).json({ error: 'Verplicht: to en message' })
  if (!sock || !isConnected) return res.status(503).json({ error: 'WhatsApp niet verbonden. Scan eerst de QR code.' })
  try {
    const jid = to.includes('@') ? to : `${to}@s.whatsapp.net`
    await sock.sendMessage(jid, { text: message })
    console.log(`Bericht gestuurd naar ${jid}: ${message.substring(0, 50)}`)
    res.json({ ok: true, to: jid })
  } catch (e) {
    console.error('Send error:', e.message)
    res.status(500).json({ error: e.message })
  }
})

// Health check for Render
app.get('/health', (_, res) => res.status(200).json({ ok: true }))

app.listen(PORT, () => {
  console.log(`Nuttin WhatsApp Bridge draait op poort ${PORT}`)
  startSock()
})
