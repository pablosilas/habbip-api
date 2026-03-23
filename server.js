import "dotenv/config"
import express from "express"
import cors from "cors"
import helmet from "helmet"
import rateLimit from "express-rate-limit"
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

// ── Rotas ──────────────────────────────────────────────────────────────────
app.use("/api/auth", authLimiter, authRoutes)
app.use("/api/user", userDataRoutes)
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

// ── Inicialização ──────────────────────────────────────────────────────────
async function start() {
  await initDb()
  await warmupFurniCache()
  startPriceMonitor()
  app.listen(PORT, () => {
    console.log(`✅ Habbip API rodando na porta ${PORT}`)
  })
}

start().catch((err) => {
  console.error("Falha ao iniciar servidor:", err)
  process.exit(1)
})