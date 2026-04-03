import { Router } from "express"
import rateLimit, { ipKeyGenerator } from "express-rate-limit"
import { requireAuth } from "../middleware/auth.js"
import { redisSubscriber } from "../services/redis.js"
import { pool } from "../db.js"

const router = Router()

const sseLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  keyGenerator: (req) => {
    if (req.userId) return `user:${req.userId}`
    return ipKeyGenerator(req)
  },
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Muitas conexões. Tente novamente em alguns instantes." },
})

const connections = new Map()
const subscriptionCache = new Map()
const SUBSCRIPTION_CACHE_TTL_MS = 30 * 1000

function addConnection(userId, res) {
  if (!connections.has(userId)) connections.set(userId, new Set())
  connections.get(userId).add(res)
}

function removeConnection(userId, res) {
  connections.get(userId)?.delete(res)
  if (connections.get(userId)?.size === 0) {
    connections.delete(userId)
  }
}

async function getSubscribers(classname, hotel) {
  const key = `${classname}:${hotel}`
  const cached = subscriptionCache.get(key)

  if (cached && Date.now() - cached.fetchedAt < SUBSCRIPTION_CACHE_TTL_MS) {
    return cached.subscribers
  }

  const { rows } = await pool.query(
    `SELECT user_id, alert_config
     FROM user_subscriptions
     WHERE classname = $1
       AND hotel = $2
       AND active = TRUE`,
    [classname, hotel]
  )

  const subscribers = new Map(
    rows.map((row) => [row.user_id, row.alert_config ?? { alertMode: "any" }])
  )

  subscriptionCache.set(key, { subscribers, fetchedAt: Date.now() })
  return subscribers
}

export function invalidateSubscriptionCache(classname, hotel) {
  subscriptionCache.delete(`${classname}:${hotel}`)
}

export async function initSSESubscriber() {
  await redisSubscriber.subscribe("habbip:price_events", async (message) => {
    const redisReceivedAt = Date.now()

    let event
    try {
      event = JSON.parse(message)
    } catch {
      return
    }

    const eventClassname = event.className ?? event.classname

    if (event.publishAt) {
      console.log(
        `[SSE] ${eventClassname}/${event.hotel} publish -> redisSubscriber: ${redisReceivedAt - event.publishAt}ms`
      )
    }

    if (connections.size === 0) return

    let subscribers
    try {
      subscribers = await getSubscribers(eventClassname, event.hotel)
    } catch (err) {
      console.error("[SSE] Erro ao buscar inscritos:", err.message)
      return
    }

    const sseSentAt = Date.now()

    for (const [userId, cfg] of subscribers) {
      const userConns = connections.get(userId)
      if (!userConns) continue

      let shouldSend = false

      if (cfg.alertMode === "any") {
        shouldSend = true
      } else if (cfg.alertMode === "price" && cfg.targetPrice != null) {
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
          `[SSE] ${eventClassname}/${event.hotel} detectado -> SSE write: ${sseSentAt - event.detectedAt}ms`
        )
      }
    }
  })

  console.log("✅ SSE subscriber Redis pronto")
}

router.get("/", requireAuth, sseLimiter, (req, res) => {
  res.setHeader("Content-Type", "text/event-stream")
  res.setHeader("Cache-Control", "no-cache")
  res.setHeader("Connection", "keep-alive")
  res.setHeader("X-Accel-Buffering", "no")
  res.flushHeaders()

  addConnection(req.userId, res)

  let cleanedUp = false

  const cleanup = () => {
    if (cleanedUp) return
    cleanedUp = true
    clearInterval(heartbeat)
    removeConnection(req.userId, res)
  }

  const heartbeat = setInterval(() => {
    try {
      res.write(": ping\n\n")
    } catch {
      cleanup()
    }
  }, 20000) 

  res.write(
    `data: ${JSON.stringify({ type: "connected", userId: req.userId })}\n\n`
  )

  req.on("close", cleanup)
  res.on("close", cleanup)
})

export default router