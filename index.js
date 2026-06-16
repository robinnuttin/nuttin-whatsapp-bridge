import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
} from '@whiskeysockets/baileys'
import express from 'express'
import fetch from 'node-fetch'
import qrcode from 'qrcode'
import pino from 'pino'

const app = express()
app.use(express.json())

const PORT = process.env.PORT || 3000
const NUTTIN_WEBHOOK = process.env.NUTTIN_WEBHOOK_URL
const MY_NUMBER = process.env.MY_WA_NUMBER
const logger = pino({ level: 'silent' })

let sock = null
let currentQR = null
let isConnected = false

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
      console.log('QR gereed — open /qr')
    }
    if (connection === 'open') {
      isConnected = true
      currentQR = null
      console.log('WhatsApp verbonden!')
    }
    if (connection === 'close') {
      isConnected = false
      const code = lastDisconnect?.error?.output?.statusCode
      if (code !== DisconnectReason.loggedOut) setTimeout(startSock, 3000)
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
        if (data.reply) await sock.sendMessage(from, { text: data.reply })
      } catch (e) { console.error('Webhook fout:', e.message) }
    }
  })
}

app.get('/', (_, res) => res.json({
  status: isConnected ? 'connected' : currentQR ? 'awaiting_scan' : 'starting',
}))

app.get('/qr', (_, res) => {
  if (isConnected) return res.send('<html><body style="font-family:sans-serif;text-align:center;padding:60px;background:#f0fff0"><h2>✅ WhatsApp verbonden!</h2></body></html>')
  if (!currentQR) return res.send('<html><head><meta http-equiv="refresh" content="3"></head><body style="font-family:sans-serif;text-align:center;padding:60px"><h2>QR laden...</h2><p>Pagina vernieuwt automatisch elke 3 sec.</p></body></html>')
  res.send(`<html><head><meta http-equiv="refresh" content="25"></head><body style="font-family:sans-serif;text-align:center;padding:40px;max-width:380px;margin:0 auto">
    <h2 style="margin-bottom:8px">Scan met WhatsApp</h2>
    <p style="color:#666;font-size:14px;margin-bottom:20px">WhatsApp → Instellingen → Gekoppelde apparaten → Apparaat koppelen</p>
    <img src="${currentQR}" style="width:280px;height:280px;border:1px solid #eee;border-radius:12px" />
    <p style="color:#aaa;font-size:12px;margin-top:12px">QR vernieuwt elke 25 sec</p>
  </body></html>`)
})

app.get('/status', (_, res) => res.json({ connected: isConnected, hasQR: !!currentQR }))

app.post('/send', async (req, res) => {
  const { to, message } = req.body
  if (!sock || !isConnected) return res.status(503).json({ error: 'Niet verbonden' })
  try {
    await sock.sendMessage(to.includes('@') ? to : `${to}@s.whatsapp.net`, { text: message })
    res.json({ ok: true })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

app.listen(PORT, () => {
  console.log(`Bridge draait op poort ${PORT}`)
  startSock()
})
