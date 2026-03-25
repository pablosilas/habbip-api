// routes/stream.js — Server-Sent Events para alertas em tempo real
import { Router } from 'express'
import { requireAuth } from '../middleware/auth.js'
import { redisSubscriber } from '../services/redis.js'
import { pool } from '../db.js'

const router = Router()

// Map de userId -> Set de res (SSE connections) — local desta instância
const connections = new Map()

// Cache de inscritos por item — evita query SQL a cada evento Redis
// Estrutura: "classname:hotel" -> { userIds: Map<userId, alertConfig>, fetchedAt: number }
const subscriptionCache = new Map()
const SUBSCRIPTION_CACHE_TTL_MS = 30 * 1000 // 30 segundos

function addConnection(userId, res) {
  if (!connections.has(userId)) connections.set(userId, new Set())
  connections.get(userId).add(res)
}

function removeConnection(userId, res) {
  connections.get(userId)?.delete(res)
  if (connections.get(userId)?.size === 0) connections.delete(userId)
}

// Retorna inscritos do cache ou busca no banco
async function getSubscribers(classname, hotel) {
  const key = `${classname}:${hotel}`
  const cached = subscriptionCache.get(key)

  if (cached && Date.now() - cached.fetchedAt < SUBSCRIPTION_CACHE_TTL_MS) {
    return cached.subscribers
  }

  const { rows } = await pool.query(
    `SELECT user_id, alert_config FROM user_subscriptions
     WHERE classname = $1 AND hotel = $2 AND active = TRUE`,
    [classname, hotel]
  )

  // Map de userId -> alertConfig para lookup O(1)
  const subscribers = new Map(
    rows.map((row) => [row.user_id, row.alert_config ?? { alertMode: 'any' }])
  )

  subscriptionCache.set(key, { subscribers, fetchedAt: Date.now() })
  return subscribers
}

// Invalida o cache quando uma inscrição muda
// Chame isso nas rotas de POST/DELETE de subscriptions
export function invalidateSubscriptionCache(classname, hotel) {
  subscriptionCache.delete(`${classname}:${hotel}`)
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

    // Verifica se há alguma conexão ativa nesta instância antes de ir ao banco
    // Otimização: evita query SQL quando não há ninguém conectado
    if (connections.size === 0) return

    let subscribers
    try {
      subscribers = await getSubscribers(
        event.className ?? event.classname,
        event.hotel
      )
    } catch (err) {
      console.error('[SSE] Erro ao buscar inscritos:', err.message)
      return
    }

    const sseSentAt = Date.now()

    for (const [userId, cfg] of subscribers) {
      // Verifica se este usuário tem conexão nesta instância
      const userConns = connections.get(userId)
      if (!userConns) continue

      // Aplica filtro de alertConfig
      let shouldSend = false
      if (cfg.alertMode === 'any') {
        shouldSend = true
      } else if (cfg.alertMode === 'price' && cfg.targetPrice != null) {
        const margin = cfg.priceMargin ?? 0
        shouldSend =
          event.newPrice >= cfg.targetPrice - margin &&
          event.newPrice <= cfg.targetPrice + margin
      }

      if (!shouldSend) continue

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
          removeConnection(userId, res)
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
  res.setHeader('X-Accel-Buffering', 'no')
  res.flushHeaders()

  const heartbeat = setInterval(() => {
    try { res.write(': ping\n\n') } catch { clearInterval(heartbeat) }
  }, 25000)

  addConnection(req.userId, res)

  res.write(`data: ${JSON.stringify({ type: 'connected', userId: req.userId })}\n\n`)

  req.on('close', () => {
    clearInterval(heartbeat)
    removeConnection(req.userId, res)
  })
})

export default router