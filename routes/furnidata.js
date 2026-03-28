// routes/furnidata.js
import express from "express"
import { cacheGet, cacheSet } from "../services/redis.js"

const router = express.Router()

const hotelMap = {
  br: "https://www.habbo.com.br",
  com: "https://www.habbo.com",
  de: "https://www.habbo.de",
  es: "https://www.habbo.es",
  fi: "https://www.habbo.fi",
  fr: "https://www.habbo.fr",
  it: "https://www.habbo.it",
  nl: "https://www.habbo.nl",
  tr: "https://www.habbo.com.tr",
}

// Cache L1 — memória local do processo (evita round-trip ao Redis)
let furniCache = {}
const CACHE_TTL_MS = 60 * 60 * 1000      // 1h em memória
const REDIS_TTL_S = 60 * 60             // 1h no Redis
const MAX_CACHE_HOTELS = 10
const DEFAULT_FETCH_TIMEOUT_MS = 5000

function fetchWithTimeout(url, options = {}, timeoutMs = DEFAULT_FETCH_TIMEOUT_MS) {
  return Promise.race([
    fetch(url, options),
    new Promise((_, reject) =>
      setTimeout(
        () => reject(new Error(`Timeout após ${timeoutMs}ms`)),
        timeoutMs
      )
    ),
  ])
}

// ── Helper central de furnidata ───────────────────────────────────────────
// Lógica de cache em três camadas: memória → Redis → Habbo
async function getFurniData(hotel) {
  // 1. Cache L1: memória local (mais rápido)
  if (furniCache[hotel] && Date.now() - furniCache[hotel].fetchedAt < CACHE_TTL_MS) {
    return furniCache[hotel].data
  }

  // 2. Cache L2: Redis (compartilhado entre instâncias)
  const redisData = await cacheGet(`furnidata:${hotel}`).catch(() => null)
  if (redisData) {
    // Popula L1 para as próximas requisições nesta instância
    furniCache[hotel] = { data: redisData, fetchedAt: Date.now() }
    return redisData
  }

  // 3. Fonte: API do Habbo
  const baseUrl = hotelMap[hotel] || hotelMap.br
  const response = await fetchWithTimeout(`${baseUrl}/gamedata/furnidata_json/1`)
  if (!response.ok) throw new Error(`Habbo retornou ${response.status}`)
  const data = await response.json()

  // Evita crescimento ilimitado do cache local
  if (Object.keys(furniCache).length >= MAX_CACHE_HOTELS && !furniCache[hotel]) {
    const oldest = Object.entries(furniCache)
      .sort(([, a], [, b]) => a.fetchedAt - b.fetchedAt)[0][0]
    delete furniCache[oldest]
  }

  // Salva em L1 e L2
  furniCache[hotel] = { data, fetchedAt: Date.now() }
  await cacheSet(`furnidata:${hotel}`, data, REDIS_TTL_S).catch(() => {
    // Redis indisponível não deve quebrar a rota — só loga
    console.warn(`[furnidata] Falha ao salvar hotel=${hotel} no Redis`)
  })

  console.log(`[furnidata] buscado do Habbo: ${hotel}`)
  return data
}

// ── Warmup ────────────────────────────────────────────────────────────────
export async function warmupFurniCache() {
  try {
    // Tenta Redis antes de ir ao Habbo
    const cached = await cacheGet("furnidata:br").catch(() => null)
    if (cached) {
      furniCache["br"] = { data: cached, fetchedAt: Date.now() }
      console.log("[warmup] furnidata br carregado do Redis")
      return
    }

    const res = await fetchWithTimeout("https://www.habbo.com.br/gamedata/furnidata_json/1")
    if (!res.ok) return
    const data = await res.json()

    furniCache["br"] = { data, fetchedAt: Date.now() }
    await cacheSet("furnidata:br", data, REDIS_TTL_S).catch(() => { })
    console.log("[warmup] furnidata br carregado do Habbo e salvo no Redis")
  } catch (err) {
    console.warn("[warmup] falhou:", err.message)
  }
}

// ── GET /api/furnidata ────────────────────────────────────────────────────
router.get("/", async (req, res) => {
  const hotel = req.query.hotel || "br"

  try {
    const data = await getFurniData(hotel)
    res.json(data)
  } catch (err) {
    console.error("[furnidata] erro:", err.message)
    res.status(502).json({ error: "Falha ao buscar furnidata." })
  }
})

// ── GET /api/furnidata/search ─────────────────────────────────────────────
router.get("/search", async (req, res) => {
  const { q, hotel = "br" } = req.query

  if (!q?.trim()) return res.json([])
  if (q.trim().length < 2) {
    return res.status(400).json({ error: "Digite pelo menos 2 caracteres." })
  }

  let data
  try {
    data = await getFurniData(hotel)
  } catch {
    return res.status(502).json({ error: "Falha ao buscar furnidata." })
  }

  const term = q.trim().toLowerCase()
  const RESULT_LIMIT = 400
  const allItems = []

  for (const i of data?.roomitemtypes?.furnitype ?? []) {
    if (!i.name?.toLowerCase().includes(term) && !i.classname?.toLowerCase().includes(term)) continue   
    allItems.push({ classname: i.classname, furniName: i.name, furniType: "roomItem", revision: i.revision })
    if (allItems.length > RESULT_LIMIT) {
      return res.status(200).json({ tooMany: true, total: ">400", items: [] })
    }
  }

  for (const i of data?.wallitemtypes?.furnitype ?? []) {
    if (!i.name?.toLowerCase().includes(term) && !i.classname?.toLowerCase().includes(term)) continue
    allItems.push({ classname: i.classname, furniName: i.name, furniType: "wallItem", revision: i.revision })
    if (allItems.length > RESULT_LIMIT) {
      return res.status(200).json({ tooMany: true, total: ">400", items: [] })
    }
  }

  res.json(allItems)
})

// ── Caches para image-url ─────────────────────────────────────────────────
// L1 continua em memória (URLs de imagem mudam raramente, não vale Redis)
const imageUrlCache = new Map()
const imageUrlPending = new Map()

function getCacheValue(map, key) {
  if (!map.has(key)) return undefined
  const value = map.get(key)
  map.delete(key)
  map.set(key, value)
  return value
}

function setCacheValue(map, key, value, maxSize = 500) {
  if (map.has(key)) {
    map.delete(key)
  } else if (map.size >= maxSize) {
    const oldestKey = map.keys().next().value
    map.delete(oldestKey)
  }
  map.set(key, value)
}

// ── GET /api/furnidata/image-url ──────────────────────────────────────────
router.get("/image-url", async (req, res) => {
  const { classname, hotel = "br" } = req.query
  if (!classname) return res.status(400).json({ error: "classname obrigatório." })
  if (!classname.match(/^[a-z0-9\-_*]+$/i)) {
    return res.status(400).json({ error: "classname inválido." })
  }

  const base = classname.replace("*", "_")
  const cacheKey = `${base}:${hotel}`

  const cached = getCacheValue(imageUrlCache, cacheKey)
  if (cached !== undefined) return res.json({ url: cached })

  if (imageUrlPending.has(cacheKey)) {
    try {
      const url = await imageUrlPending.get(cacheKey)
      return res.json({ url })
    } catch {
      return res.json({ url: "" })
    }
  }

  let data
  try {
    data = await getFurniData(hotel)
  } catch {
    return res.status(502).json({ error: "Falha ao buscar furnidata." })
  }

  const allItems = [
    ...(data?.roomitemtypes?.furnitype ?? []),
    ...(data?.wallitemtypes?.furnitype ?? []),
  ]

  const found = allItems.find(i => i.classname === classname || i.classname === base)
  const revision = found?.revision

  const candidates = [
    revision ? `https://habcat.net/media/furni2/${revision}/${base}/0_0.webp` : null,
    `https://habboapi.site/api/image/${encodeURIComponent(classname)}`,
  ].filter(Boolean)

  const resolvePromise = (async () => {
    let resolvedUrl = ""
    for (const url of candidates) {
      try {
        const check = await fetch(url, { method: "HEAD" })
        if (check.ok) { resolvedUrl = url; break }
      } catch { }
    }
    setCacheValue(imageUrlCache, cacheKey, resolvedUrl)
    imageUrlPending.delete(cacheKey)
    return resolvedUrl
  })()

  imageUrlPending.set(cacheKey, resolvePromise)

  try {
    const url = await resolvePromise
    res.json({ url })
  } catch {
    res.json({ url: "" })
  }
})

// ── GET /api/furnidata/image-icon ─────────────────────────────────────────
router.get("/image-icon", async (req, res) => {
  const { classname, hotel = "br" } = req.query
  if (!classname) return res.status(400).json({ error: "classname obrigatório." })
  if (!classname.match(/^[a-z0-9\-_*]+$/i)) {
    return res.status(400).json({ error: "classname inválido." })
  }

  const base = classname.replace("*", "_")

  let data
  try {
    data = await getFurniData(hotel)
  } catch {
    return res.status(502).json({ error: "Falha ao buscar furnidata." })
  }

  const allItems = [
    ...(data?.roomitemtypes?.furnitype ?? []),
    ...(data?.wallitemtypes?.furnitype ?? []),    
  ]

  const found = allItems.find(i => i.classname === classname || i.classname === base)
  const revision = found?.revision

  if (!revision) {
    return res.status(404).json({ error: "Item não encontrado." })
  }

  const url = `https://images.habbo.com/dcr/hof_furni/${revision}/${base}_icon.png`
  res.json({ url })
})

export default router