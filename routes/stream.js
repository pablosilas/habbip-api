// routes/stream.js — Server-Sent Events para alertas em tempo real
import { Router } from 'express'
import { requireAuth } from '../middleware/auth.js'
import { redisSubscriber } from '../services/redis.js'
import { pool } from '../db.js'

const router = Router()

// Map de userId -> Set de res (SSE connections)
const connections = new Map()

function addConnection(userId, res) {
  if (!connections.has(userId)) connections.set(userId, new Set())
  connections.get(userId).add(res)
}

function removeConnection(userId, res) {
  connections.get(userId)?.delete(res)
  if (connections.get(userId)?.size === 0) connections.delete(userId)
}

// Inicializa o subscriber Redis para distribuir eventos SSE
export async function initSSESubscriber() {
  await redisSubscriber.subscribe('habbip:price_events', async (message) => {
    const redisReceivedAt = Date.now()

    let event
    try {
      event = JSON.parse(message)
    } catch {
      return
    }

    if (event.publishAt) {
      console.log(
        `[SSE] ${event.className}/${event.hotel} publish -> redisSubscriber: ${redisReceivedAt - event.publishAt}ms`
      )
    }

    // Busca usuários inscritos neste item
    const { rows } = await pool.query(
      `SELECT user_id, alert_config FROM user_subscriptions
       WHERE classname = $1 AND hotel = $2 AND active = TRUE`,
      [event.className ?? event.classname, event.hotel]
    )

    for (const sub of rows) {
      const cfg = sub.alert_config || { alertMode: 'any' }
      let shouldSend = false

      if (cfg.alertMode === 'any') shouldSend = true
      else if (cfg.alertMode === 'price' && cfg.targetPrice != null) {
        const margin = cfg.priceMargin ?? 0
        shouldSend =
          event.newPrice >= cfg.targetPrice - margin &&
          event.newPrice <= cfg.targetPrice + margin
      }

      if (!shouldSend) continue

      const userConns = connections.get(sub.user_id)
      if (!userConns) continue

      const sseSentAt = Date.now()

      const payload = JSON.stringify({
        ...event,
        classname: event.classname ?? event.className,
        className: event.className ?? event.classname,
        redisReceivedAt,
        sseSentAt,
      })

      for (const res of userConns) {
        try {
          res.write(`data: ${payload}\n\n`)
        } catch {
          removeConnection(sub.user_id, res)
        }
      }

      if (event.detectedAt) {
        console.log(
          `[SSE] ${event.className}/${event.hotel} detectado -> SSE write: ${sseSentAt - event.detectedAt}ms`
        )
      }
    }
  })

  console.log('✅ SSE subscriber Redis pronto')
}

// GET /api/stream — abre a conexão SSE
router.get('/', requireAuth, (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.setHeader('X-Accel-Buffering', 'no') // Nginx: desativa buffering
  res.flushHeaders()

  // Heartbeat a cada 25s para manter conexão viva
  const heartbeat = setInterval(() => {
    try { res.write(': ping\n\n') } catch { clearInterval(heartbeat) }
  }, 25000)

  addConnection(req.userId, res)

  // Envia evento de conexão bem-sucedida
  res.write(`data: ${JSON.stringify({ type: 'connected', userId: req.userId })}\n\n`)

  req.on('close', () => {
    clearInterval(heartbeat)
    removeConnection(req.userId, res)
  })
})

export default router