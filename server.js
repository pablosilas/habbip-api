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

const app = express()
const PORT = process.env.PORT || 3001

// ── Segurança ──────────────────────────────────────────────────────────────
app.use(helmet())
app.use(cors({
  origin: process.env.FRONTEND_URL || "http://localhost:5173",
  credentials: true,
}))
app.use(express.json({ limit: "2mb" }))

// Rate limiting global
app.use(rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutos
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Muitas requisições. Tente novamente em alguns minutos." },
}))

// Rate limiting mais restrito para auth
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: { error: "Muitas tentativas de login. Aguarde 15 minutos." },
})

// Rate limiting específico para user data (escritas)
// Usa userId quando disponível, caso contrário usa ipKeyGenerator para suporte a IPv6
const userDataLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minuto
  max: 30,
  keyGenerator: (req) => {
    // Se usuário autenticado, usa userId como chave
    if (req.userId) {
      return `user:${req.userId}`
    }
    // Fallback para IP com suporte correto a IPv6
    return ipKeyGenerator(req)
  },
  message: { error: "Muitas alterações. Aguarde um minuto." },
})

// ── Rotas ──────────────────────────────────────────────────────────────────
app.use("/api/auth", authLimiter, authRoutes)
app.use("/api/user", userDataLimiter, userDataRoutes)
app.use("/api/furnidata", furniDataRoutes)

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

// ── Limpeza de refresh tokens expirados ───────────────────────────────────
//
// Tokens com expires_at < NOW() nunca são removidos automaticamente durante
// o uso normal (só no logout explícito). Com o tempo, a tabela refresh_tokens
// acumula registros mortos que ocupam espaço e degradam queries de leitura.
//
// Este job roda uma vez ao iniciar (para limpar acúmulo histórico) e depois
// a cada 24h. Usa um try/catch isolado para nunca derrubar o servidor em caso
// de falha pontual de conexão com o banco.
const CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000 // 24 horas

async function cleanExpiredTokens() {
  try {
    const { rowCount } = await pool.query(
      "DELETE FROM refresh_tokens WHERE expires_at < NOW()"
    )
    if (rowCount > 0) {
      console.log(`[TokenCleanup] ${rowCount} token(s) expirado(s) removido(s).`)
    }
  } catch (err) {
    // Loga mas não propaga — falha aqui não deve afetar o servidor
    console.error("[TokenCleanup] Erro ao limpar tokens expirados:", err.message)
  }
}

function startTokenCleanup() {
  // Roda imediatamente ao iniciar para limpar acúmulo histórico
  cleanExpiredTokens()
  // Depois a cada 24h
  tokenCleanupInterval = setInterval(cleanExpiredTokens, CLEANUP_INTERVAL_MS)
  console.log("[TokenCleanup] Job de limpeza iniciado (intervalo: 24h).")
}

// ── Graceful Shutdown ─────────────────────────────────────────────────────
function gracefulShutdown(signal) {
  console.log(`\n${signal} recebido, desligando gracefully...`)
  
  // Limpar intervalos
  if (priceMonitorInterval) {
    clearInterval(priceMonitorInterval)
  }
  if (tokenCleanupInterval) {
    clearInterval(tokenCleanupInterval)
  }
  
  // Encerrar pool de conexões
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