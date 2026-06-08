// jobs/trendingMonitor.js — Job que calcula "Mobis em Alta" a cada 1h

import { fetchOfficialMarketBatchSafe } from "../services/habboApi.js"
import { cacheSet, cacheGet } from "../services/redis.js"

const TRENDING_INTERVAL_MS = 60 * 60 * 1000 // 1h
const REDIS_KEY = "habbip:trending:br"
const REDIS_TTL_S = 3600 // 1h
const TOP_COUNT = 50

/**
 * Normaliza um entry do history de objeto para array
 * [price, sold, creditSum, openOffers, timestamp]
 */
function normalizeHistoryEntry(entry, statsDate) {
  const dayOffset = Number(entry.dayOffset ?? 0)
  const price = Number(entry.averagePrice ?? 0)
  const sold = Number(entry.totalSoldItems ?? 0)
  const creditSum = Number(entry.totalCreditSum ?? 0)
  const openOffers = Number(entry.totalOpenOffers ?? 0)

  let timestamp = null
  if (statsDate) {
    const base = new Date(`${statsDate}T00:00:00`)
    if (!isNaN(base.getTime())) {
      base.setDate(base.getDate() + dayOffset)
      timestamp = Math.floor(base.getTime() / 1000)
    }
  }

  return [price, sold, creditSum, openOffers, timestamp]
}

/**
 * Busca furnidata do Redis (já cacheado pelo warmup)
 * e filtra apenas itens tradeable
 */
async function getTradeableItems() {
  console.log("[Trending] Buscando furnidata do Redis...")
  const furnidata = await cacheGet("furnidata:br")

  if (!furnidata) {
    console.warn("[Trending] ⚠️  furnidata não encontrado no Redis")
    return []
  }

  const tradeable = []

  for (const item of furnidata?.roomitemtypes?.furnitype ?? []) {
    // Se tradeable não está definido OU é true, inclui
    // (no Habbo, ausência da flag = tradeable por padrão)
    if (item.tradeable !== false) {
      tradeable.push({
        classname: item.classname,
        furniName: item.name,
        furniType: "roomItem",
      })
    }
  }

  for (const item of furnidata?.wallitemtypes?.furnitype ?? []) {
    if (item.tradeable !== false) {
      tradeable.push({
        classname: item.classname,
        furniName: item.name,
        furniType: "wallItem",
      })
    }
  }

  console.log(`[Trending] ✅ ${tradeable.length} itens tradeable encontrados`)
  return tradeable
}

/**
 * Calcula vendas das últimas 48h e variação de preço (só informativo)
 */
function calculateMetrics(history) {
  // Valida se history é array antes de processar
  if (!history || !Array.isArray(history) || history.length === 0) {
    return null
  }

  // history formato: [price, sold, creditSum, openOffers, timestamp]
  const now = Math.floor(Date.now() / 1000)
  const twoDaysAgo = now - 48 * 60 * 60

  // Filtra últimas 48h
  const recent = history.filter(entry => {
    if (!Array.isArray(entry) || entry.length < 5) return false
    const ts = entry[4]
    return ts && ts >= twoDaysAgo
  })

  // Debug no primeiro item processado
  if (history.length > 0 && !calculateMetrics._debugged) {
    calculateMetrics._debugged = true
    console.log(`[Trending] 🔍 Debug calculateMetrics:`)
    console.log(`  - history total entries: ${history.length}`)
    console.log(`  - recent (48h) entries: ${recent.length}`)
    console.log(`  - now timestamp: ${now}`)
    console.log(`  - twoDaysAgo timestamp: ${twoDaysAgo}`)
    if (history[0]) {
      console.log(`  - first entry timestamp: ${history[0][4]} (${new Date(history[0][4] * 1000).toISOString()})`)
      console.log(`  - first entry sold: ${history[0][1]}`)
    }
  }

  if (recent.length === 0) return null

  // Soma total de vendas das últimas 48h
  const totalSales = recent.reduce((sum, entry) => {
    const sold = Number(entry[1]) || 0
    return sum + sold
  }, 0)

  // Calcula variação de preço (informativo)
  let priceChange = null
  if (recent.length >= 2) {
    const oldestPrice = recent[0][0]
    const newestPrice = recent[recent.length - 1][0]

    if (oldestPrice && newestPrice && oldestPrice > 0) {
      const diff = newestPrice - oldestPrice
      const pct = ((diff / oldestPrice) * 100).toFixed(1)

      priceChange = {
        oldPrice: oldestPrice,
        newPrice: newestPrice,
        diff,
        pct: parseFloat(pct),
      }
    }
  }

  return {
    sales48h: totalSales,
    priceChange,
  }
}

/**
 * Roda o job de trending
 */
export async function runTrendingJob() {
  console.log("[Trending] 🚀 Iniciando job...")

  try {
    const tradeableItems = await getTradeableItems()
    if (tradeableItems.length === 0) {
      console.warn("[Trending] ⚠️  Nenhum item tradeable encontrado - abortando job")
      return
    }

    console.log(`[Trending] 📊 Buscando dados de mercado para ${tradeableItems.length} itens...`)

    const officialBatch = await fetchOfficialMarketBatchSafe(tradeableItems, "br")

    // Mapeia resultados
    const officialMap = new Map()
    const statsDate =
      officialBatch.roomItemData?.[0]?.statsDate ??
      officialBatch.wallItemData?.[0]?.statsDate ??
      null

    for (const entry of officialBatch.roomItemData ?? []) {
      if (entry.item) {
        officialMap.set(entry.item.toLowerCase(), {
          ...entry,
          statsDate: entry.statsDate ?? statsDate
        })
      }
    }
    for (const entry of officialBatch.wallItemData ?? []) {
      if (entry.item) {
        officialMap.set(entry.item.toLowerCase(), {
          ...entry,
          statsDate: entry.statsDate ?? statsDate
        })
      }
    }

    console.log(`[Trending] 📦 API retornou dados para ${officialMap.size} itens`)

    // Debug: pega um item de exemplo para ver o formato
    const firstItem = Array.from(officialMap.values())[0]
    if (firstItem) {
      console.log(`[Trending] 🔍 Debug - Exemplo de item:`)
      console.log(`  - classname: ${firstItem.item}`)
      console.log(`  - currentPrice: ${firstItem.currentPrice}`)
      console.log(`  - soldItemCount: ${firstItem.soldItemCount}`)
      console.log(`  - history length: ${firstItem.history?.length ?? 0}`)
      if (firstItem.history && firstItem.history.length > 0) {
        console.log(`  - history[0]: ${JSON.stringify(firstItem.history[0])}`)
        console.log(`  - history type: ${typeof firstItem.history[0]}`)
      }
    }

    // Monta lista com dados calculados
    const itemsWithData = []
    let itemsWithHistory = 0
    let itemsWithMetrics = 0

    for (const item of tradeableItems) {
      const official = officialMap.get(item.classname.toLowerCase())
      if (!official) continue

      const currentPrice = official.currentPrice ?? 0
      const averagePrice = official.averagePrice ?? 0
      const hasOffers = (official.currentOpenOffers ?? 0) > 0

      // Normaliza history de objeto para array
      const rawHistory = official.history ?? []
      const history = Array.isArray(rawHistory)
        ? rawHistory.map(entry => normalizeHistoryEntry(entry, official.statsDate))
        : []

      if (history.length > 0) itemsWithHistory++

      const metrics = calculateMetrics(history)

      if (metrics) itemsWithMetrics++

      // Só inclui itens com vendas nas últimas 48h
      if (!metrics || metrics.sales48h === 0) continue

      itemsWithData.push({
        classname: item.classname,
        furniName: item.furniName,
        furniType: item.furniType,
        currentPrice,
        averagePrice,
        hasOffers,
        sales48h: metrics.sales48h,
        priceChange: metrics.priceChange,
      })
    }

    console.log(`[Trending] 📊 Stats:`)
    console.log(`  - Itens com histórico: ${itemsWithHistory}`)
    console.log(`  - Itens com metrics calculadas: ${itemsWithMetrics}`)
    console.log(`  - Itens com sales48h > 0: ${itemsWithData.length}`)
    console.log(`[Trending] 📈 ${itemsWithData.length} itens com vendas (48h) encontrados`)

    // Ordena por vendas (descendente) e pega top 50
    const top = itemsWithData
      .sort((a, b) => b.sales48h - a.sales48h)
      .slice(0, TOP_COUNT)

    // Salva no Redis
    await cacheSet(REDIS_KEY, top, REDIS_TTL_S)

    console.log(`[Trending] ✅ Job concluído — ${top.length} itens salvos no Redis`)
  } catch (err) {
    console.error("[Trending] ❌ Erro no job:", err.message)
    console.error(err.stack)
  }
}

let trendingInterval = null

/**
 * Inicia o job com intervalo de 1h
 */
export function startTrendingMonitor() {
  // Roda imediatamente no startup
  runTrendingJob()

  // Agenda execuções a cada 1h
  trendingInterval = setInterval(runTrendingJob, TRENDING_INTERVAL_MS)
  console.log(`[Trending] Monitor iniciado (intervalo: 1h)`)
}

/**
 * Para o job (graceful shutdown)
 */
export function stopTrendingMonitor() {
  if (trendingInterval) {
    clearInterval(trendingInterval)
    trendingInterval = null
    console.log("[Trending] Monitor parado")
  }
}