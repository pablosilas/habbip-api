/**
 * Funções para buscar dados da API do Habbo no backend.
 * Espelham a lógica do frontend (habboApi.js) mas rodam no servidor.
 */

const HABBO_MARKET_API_BASE = "https://habboapi.site"

function getHotelBaseUrl(hotel = "br") {
  const map = {
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
  return map[String(hotel).toLowerCase()] || "https://www.habbo.com.br"
}

export async function fetchMarketHistory({ classname, hotel = "br", days = "7" }) {
  const params = new URLSearchParams()
  if (classname?.trim()) params.set("classname", classname.trim())
  params.set("hotel", hotel)
  params.set("days", days)

  const res = await fetch(`${HABBO_MARKET_API_BASE}/api/market/history?${params}`)
  if (!res.ok) throw new Error(`Erro ao buscar histórico: ${res.status}`)
  return res.json()
}

export async function fetchOfficialMarketBatch(items, hotel = "br") {
  const roomItems = []
  const wallItems = []

  for (const { classname, furniType } of items) {
    if (!classname?.trim()) continue
    const entry = { item: classname.trim() }
    if (furniType === "wallItem") wallItems.push(entry)
    else roomItems.push(entry)
  }

  const res = await fetch(`${getHotelBaseUrl(hotel)}/api/public/marketplace/stats/batch`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ roomItems, wallItems }),
  })
  if (!res.ok) throw new Error(`Erro ao buscar batch oficial: ${res.status}`)
  return res.json()
}

function normalizeOfficialItem(officialItem, statsDate) {
  const history = (officialItem.history ?? [])
    .map((entry) => {
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
    })
    .filter(([price]) => price > 0)

  return {
    averagePrice: officialItem.averagePrice ?? 0,
    currentPrice: officialItem.currentPrice ?? 0,
    totalOpenOffers: officialItem.totalOpenOffers ?? 0,
    currentOpenOffers: officialItem.currentOpenOffers ?? 0,
    soldItemCount: officialItem.soldItemCount ?? 0,
    creditSum: officialItem.creditSum ?? 0,
    history,
  }
}

export function mergeOfficialMarketData(legacyItems, officialBatch) {
  const officialMap = new Map()
  const statsDate =
    officialBatch.roomItemData?.[0]?.statsDate ??
    officialBatch.wallItemData?.[0]?.statsDate ?? null

  for (const entry of officialBatch.roomItemData ?? []) {
    if (entry.item) officialMap.set(entry.item.toLowerCase(), { data: entry, statsDate: entry.statsDate ?? statsDate })
  }
  for (const entry of officialBatch.wallItemData ?? []) {
    if (entry.item) officialMap.set(entry.item.toLowerCase(), { data: entry, statsDate: entry.statsDate ?? statsDate })
  }

  return legacyItems.map((item) => {
    const key = item.ClassName?.toLowerCase()
    const official = key ? officialMap.get(key) : null
    if (!official) return item
    return { ...item, marketData: normalizeOfficialItem(official.data, official.statsDate) }
  })
}

/**
 * Busca o preço atual de um item pelo classname.
 * Retorna o número do preço ou null se não encontrar.
 */
export async function fetchCurrentPrice(className, hotel = "br") {
  const legacyData = await fetchMarketHistory({ classname: className, hotel, days: "7" })

  const legacyItems = (Array.isArray(legacyData) ? legacyData : []).filter(
    (i) => !!i?.ClassName?.trim()
  )
  if (legacyItems.length === 0) return null

  const batchItems = legacyItems.map((i) => ({
    classname: i.ClassName,
    furniType: i.FurniType === "wallItem" ? "wallItem" : "roomItem",
  }))

  let officialBatch = null
  try {
    officialBatch = await fetchOfficialMarketBatch(batchItems, hotel)
  } catch { }

  const merged = officialBatch
    ? mergeOfficialMarketData(legacyItems, officialBatch)
    : legacyItems

  const found = merged.find(
    (i) => i.ClassName?.toLowerCase() === className.toLowerCase()
  )
  if (!found) return null

  return (
    found?.marketData?.currentPrice ??
    (found?.marketData?.history?.length > 0
      ? found.marketData.history[found.marketData.history.length - 1]?.[0]
      : null) ??
    found?.marketData?.averagePrice ??
    null
  )
}