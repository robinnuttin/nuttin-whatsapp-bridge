const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
} = require('@whiskeysockets/baileys')
const express = require('express')
const fetch = require('node-fetch')
const qrcode = require('qrcode')
const pino = require('pino')

const app = express()
app.use(express.json())

// ─── Config ───────────────────────────────────────────────────
const PORT = process.env.PORT || 3000
const NUTTIN_WEBHOOK = process.env.NUTTIN_WEBHOOK_URL   // e.g. https://nuttin-dashboard.vercel.app/api/whatsapp/webhook
const MY_NUMBER = process.env.MY_WA_NUMBER              // e.g. 32477123456 (zonder +)
const logger = pino({ level: 'silent' })

// ─── State ────────────────────────────────────────────────────
let sock = null
let currentQR = null
let isConnected = false

// ─── Start WhatsApp ───────────────────────────────────────────
async function startSock() {
  const { state, saveCreds } = await useMultiFileAuthState('auth_info')
  const { version } = await fetchLatestBaileysVersion()

  sock = makeWASocket({
    version,
    auth: state,
    logger,
    printQRInTerminal: true,
    browser: ['Nuttin OS', 'Chrome', '1.0'],
  })

  sock.ev.on('creds.update', saveCreds)

  sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      currentQR = await qrcode.toDataURL(qr)
      console.log('QR code gereed — open /qr in browser')
    }

    if (connection === 'open') {
      isConnected = true
      currentQR = null
      console.log('WhatsApp verbonden!')
    }

    if (connection === 'close') {
      isConnected = false
      const code = lastDisconnect?.error?.output?.statusCode
      const shouldReconnect = code !== DisconnectReason.loggedOut
      console.log('Verbinding verbroken, code:', code)
      if (shouldReconnect) setTimeout(startSock, 3000)
    }
  })

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return

    for (const msg of messages) {
      if (msg.key.fromMe) continue
      const from = msg.key.remoteJid || ''

      // Alleen berichten van jouw nummer verwerken
      if (MY_NUMBER && !from.includes(MY_NUMBER)) continue

      const text =
        msg.message?.conversation ||
        msg.message?.extendedTextMessage?.text ||
        msg.message?.imageMessage?.caption ||
        ''

      if (!text.trim()) continue
      console.log(`Bericht van ${from}: ${text}`)

      if (!NUTTIN_WEBHOOK) {
        console.warn('NUTTIN_WEBHOOK_URL niet ingesteld')
        continue
      }

      try {
        const res = await fetch(NUTTIN_WEBHOOK, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ from, body: text }),
        })
        const data = await res.json()

        if (data.reply) {
          await sock.sendMessage(from, { text: data.reply })
        }
      } catch (err) {
        console.error('Webhook fout:', err.message)
      }
    }
  })
}

// ─── Routes ───────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({
    status: isConnected ? 'connected' : currentQR ? 'awaiting_qr_scan' : 'disconnected',
    message: isConnected ? 'WhatsApp verbonden!' : 'Open /qr om te verbinden',
  })
})

app.get('/qr', (req, res) => {
  if (isConnected) {
    return res.send('<html><body style="font-family:sans-serif;padding:40px;background:#0f0;"><h2>✅ WhatsApp verbonden!</h2></body></html>')
  }
  if (!currentQR) {
    return res.send(`
      <html><head><meta http-equiv="refresh" content="3"></head>
      <body style="font-family:sans-serif;padding:40px;">
        <h2>QR code laden...</h2><p>Pagina vernieuwt automatisch.</p>
      </body></html>
    `)
  }
  res.send(`
    <html><head><meta http-equiv="refresh" content="30"></head>
    <body style="font-family:sans-serif;padding:40px;max-width:400px;margin:0 auto;text-align:center;">
      <h2>Scan met WhatsApp</h2>
      <p>WhatsApp → Instellingen → Gekoppelde apparaten → Apparaat koppelen</p>
      <img src="${currentQR}" style="width:300px;height:300px;" />
      <p style="color:#888;font-size:12px;">QR vernieuwt elke 30 seconden</p>
    </body></html>
  `)
})

app.get('/status', (req, res) => {
  res.json({ connected: isConnected, hasQR: !!currentQR })
})

// Nuttin OS kan hiermee een bericht sturen naar jouw WhatsApp
app.post('/send', async (req, res) => {
  const { to, message } = req.body
  if (!sock || !isConnected) return res.status(503).json({ error: 'Niet verbonden' })
  try {
    const jid = to.includes('@') ? to : `${to}@s.whatsapp.net`
    await sock.sendMessage(jid, { text: message })
    res.json({ ok: true })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

app.listen(PORT, () => {
  console.log(`Nuttin WhatsApp Bridge draait op poort ${PORT}`)
  console.log(`QR scan: http://localhost:${PORT}/qr`)
  startSock()
})
