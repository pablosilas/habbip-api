import { createClient } from 'redis'

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379'

// Upstash usa rediss:// (TLS) — o cliente Redis precisa de socket.tls
function createRedisClient() {
  const url = REDIS_URL.replace(/^"(.+)"$/, '$1') // remove aspas se houver

  return createClient({
    url,
    socket: {
      tls: url.startsWith('rediss://'),
      reconnectStrategy: (retries) => {
        if (retries > 5) return new Error('Redis: muitas tentativas')
        return Math.min(retries * 500, 3000)
      },
    },
  })
}

export const redisPublisher = createRedisClient()
export const redisSubscriber = createRedisClient()

let redisAvailable = false

export async function connectRedis() {
  try {
    await Promise.all([
      redisPublisher.connect(),
      redisSubscriber.connect(),
    ])
    redisAvailable = true
    console.log('✅ Redis conectado')
  } catch (err) {
    console.warn('⚠️  Redis indisponível — alertas em tempo real desativados:', err.message)
    redisAvailable = false
  }
}

export function isRedisAvailable() {
  return redisAvailable
}

export async function cacheGet(key) {
  if (!redisAvailable) return null
  try {
    const val = await redisPublisher.get(key)
    return val ? JSON.parse(val) : null
  } catch { return null }
}

export async function cacheSet(key, value, ttlSeconds = 300) {
  if (!redisAvailable) return
  try {
    await redisPublisher.setEx(key, ttlSeconds, JSON.stringify(value))
  } catch { }
}