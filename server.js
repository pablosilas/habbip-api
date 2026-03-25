import "dotenv/config"
import express from "express"
import cors from "cors"
import helmet from "helmet"
import rateLimit, { ipKeyGenerator } from "express-rate-limit"
import { pool, initDb } from "./db.js"
import authRoutes from "./routes/auth.js"
import { startPriceMonitor } from "./jobs/priceMonitor.js"
import userDataRoutes from "./routes/userData.js"
import furniDataRoutes, { warmupFurniCache } from "./routes/furnidata.js"
import streamRoutes, { initSSESubscriber } from "./routes/stream.js"
import subscriptionRoutes from "./routes/subscriptions.js"
import { connectRedis } from "./services/redis.js"

const app = express()
const PORT = process.env.PORT || 3001

// ── Segurança ──────────────────────────────────────────────────────────────
app.use(helmet())
app.use(cors({
  origin: process.env.FRONTEND_URL || "http://localhost:5173",
  credentials: true,
}))
app.use(express.json({ limit: "2mb" }))

// ── Rate limiters específicos ──────────────────────────────────────────────

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: { error: "Muitas tentativas de login. Aguarde 15 minutos." },
})

const userDataLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  keyGenerator: (req) => {
    if (req.userId) return `user:${req.userId}`
    return ipKeyGenerator(req)
  },
  message: { error: "Muitas alterações. Aguarde um minuto." },
})

const furniLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  max: 500,
  message: { error: "Muitas buscas. Aguarde um momento." },
})

const sseLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: "Muitas conexões. Tente novamente em alguns minutos." },
})

const subscriptionsLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  max: 60,
  message: { error: "Muitas requisições. Aguarde um momento." },
})

// ── Rotas sem rate limit global (têm limiters próprios) ───────────────────
app.use("/api/furnidata", furniLimiter, furniDataRoutes)
app.use("/api/stream", sseLimiter, streamRoutes)
app.use("/api/subscriptions", subscriptionsLimiter, subscriptionRoutes)

// ── Rate limiting global ───────────────────────────────────────────────────
app.use(rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Muitas requisições. Tente novamente em alguns minutos." },
}))

// ── Rotas com rate limit global ───────────────────────────────────────────
app.use("/api/auth", authLimiter, authRoutes)
app.use("/api/user", userDataLimiter, userDataRoutes)

app.get("/api/health", (req, res) => {
  res.json({ ok: true, ts: Date.now() })
})

// ── 404 e erros ────────────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ error: "Rota não encontrada." })
})

app.use((err, req, res, _next) => {
  console.error("[ERROR]", err)
  res.status(500).json({ error: "Erro interno no servidor." })
})

// ── Variáveis globais para controle de intervalos ──────────────────────────
let priceMonitorInterval = null
let tokenCleanupInterval = null

const CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000

async function cleanExpiredTokens() {
  try {
    const { rowCount } = await pool.query(
      "DELETE FROM refresh_tokens WHERE expires_at < NOW()"
    )
    if (rowCount > 0) {
      console.log(`[TokenCleanup] ${rowCount} token(s) expirado(s) removido(s).`)
    }
  } catch (err) {
    console.error("[TokenCleanup] Erro ao limpar tokens expirados:", err.message)
  }
}

function startTokenCleanup() {
  cleanExpiredTokens()
  tokenCleanupInterval = setInterval(cleanExpiredTokens, CLEANUP_INTERVAL_MS)
  console.log("[TokenCleanup] Job de limpeza iniciado (intervalo: 24h).")
}

// ── Graceful Shutdown ─────────────────────────────────────────────────────
function gracefulShutdown(signal) {
  console.log(`\n${signal} recebido, desligando gracefully...`)

  if (priceMonitorInterval) clearInterval(priceMonitorInterval)
  if (tokenCleanupInterval) clearInterval(tokenCleanupInterval)

  pool.end()
    .then(() => {
      console.log("Pool de conexões encerrado.")
      process.exit(0)
    })
    .catch((err) => {
      console.error("Erro ao encerrar pool:", err.message)
      process.exit(1)
    })
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'))
process.on('SIGINT', () => gracefulShutdown('SIGINT'))

// ── Inicialização ──────────────────────────────────────────────────────────
async function start() {
  await initDb()
  await warmupFurniCache()
  await connectRedis()
  await initSSESubscriber()
  startPriceMonitor()
  startTokenCleanup()
  app.listen(PORT, () => {
    console.log(`✅ Habbip API rodando na porta ${PORT}`)
  })
}

start().catch((err) => {
  console.error("Falha ao iniciar servidor:", err)
  process.exit(1)
})