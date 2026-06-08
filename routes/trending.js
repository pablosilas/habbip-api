// routes/trending.js — Endpoint de Mobis em Alta

import { Router } from "express"
import { cacheGet } from "../services/redis.js"
import { runTrendingJob } from "../jobs/trendingMonitor.js"

const router = Router()

const REDIS_KEY = "habbip:trending:br"

/**
 * GET /api/trending
 * Retorna os top mobis em alta (calculados pelo job trendingMonitor)
 */
router.get("/", async (req, res) => {
  try {
    const trending = await cacheGet(REDIS_KEY)

    if (!trending || !Array.isArray(trending)) {
      return res.json([])
    }

    // Retorna os dados direto do cache
    res.json(trending)
  } catch (err) {
    console.error("[Trending] Erro ao buscar:", err.message)
    res.status(500).json({ error: "Erro ao buscar mobis em alta." })
  }
})

/**
 * POST /api/trending/refresh
 * Força execução manual do job (útil para debug)
 */
router.post("/refresh", async (req, res) => {
  try {
    console.log("[Trending] Refresh manual solicitado")
    await runTrendingJob()
    const trending = await cacheGet(REDIS_KEY)
    res.json({
      ok: true,
      count: trending?.length ?? 0,
      message: "Job executado com sucesso"
    })
  } catch (err) {
    console.error("[Trending] Erro no refresh:", err.message)
    res.status(500).json({ error: err.message })
  }
})

export default router