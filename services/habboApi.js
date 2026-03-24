// services/habboApi.js  — Só API oficial do Habbo (sem habboapi.site)

const BATCH_SIZE = 25 // limite da API oficial

function getHotelBaseUrl(hotel = 'br') {
  const map = {
    br: 'https://www.habbo.com.br',
    com: 'https://www.habbo.com',
    de: 'https://www.habbo.de',
    es: 'https://www.habbo.es',
    fi: 'https://www.habbo.fi',
    fr: 'https://www.habbo.fr',
    it: 'https://www.habbo.it',
    nl: 'https://www.habbo.nl',
    tr: 'https://www.habbo.com.tr',
  }
  return map[String(hotel).toLowerCase()] || 'https://www.habbo.com.br'
}

function chunk(arr, size) {
  const chunks = []
  for (let i = 0; i < arr.length; i += size) chunks.push(arr.slice(i, i + size))
  return chunks
}

async function fetchBatchRaw(roomItems, wallItems, hotel) {
  const base = getHotelBaseUrl(hotel)
  const res = await fetch(`${base}/api/public/marketplace/stats/batch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ roomItems, wallItems }),
  })
  if (!res.ok) throw new Error(`Habbo API ${res.status}`)
  return res.json()
}

// Busca um lote de até 25 itens (respeitando o limite oficial)
export async function fetchOfficialMarketBatch(items, hotel = 'br') {
  const roomItems = []
  const wallItems = []
  for (const { classname, furniType } of items) {
    if (!classname?.trim()) continue
    const entry = { item: classname.trim() }
    if (furniType === 'wallItem') wallItems.push(entry)
    else roomItems.push(entry)
  }
  return fetchBatchRaw(roomItems, wallItems, hotel)
}

// Busca N itens quebrando automaticamente em lotes de 25
export async function fetchOfficialMarketBatchSafe(items, hotel = 'br') {
  const roomItems = items.filter(i => i.furniType !== 'wallItem')
  const wallItems = items.filter(i => i.furniType === 'wallItem')
  const roomChunks = chunk(roomItems, BATCH_SIZE)
  const wallChunks = chunk(wallItems, BATCH_SIZE)
  const total = Math.max(roomChunks.length, wallChunks.length, 1)

  const results = await Promise.all(
    Array.from({ length: total }, (_, i) =>
      fetchBatchRaw(
        (roomChunks[i] ?? []).map(x => ({ item: x.classname })),
        (wallChunks[i] ?? []).map(x => ({ item: x.classname })),
        hotel
      ).catch(() => null)
    )
  )

  return results.reduce(
    (acc, batch) => {
      if (!batch) return acc
      return {
        roomItemData: [...acc.roomItemData, ...(batch.roomItemData ?? [])],
        wallItemData: [...acc.wallItemData, ...(batch.wallItemData ?? [])],
      }
    },
    { roomItemData: [], wallItemData: [] }
  )
}

function normalizeOfficialItem(officialItem, statsDate) {
  const history = (officialItem.history ?? [])
    .map(entry => {
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
    officialBatch.wallItemData?.[0]?.statsDate ??
    null

  for (const entry of officialBatch.roomItemData ?? []) {
    if (entry.item)
      officialMap.set(entry.item.toLowerCase(), {
        data: entry,
        statsDate: entry.statsDate ?? statsDate,
      })
  }
  for (const entry of officialBatch.wallItemData ?? []) {
    if (entry.item)
      officialMap.set(entry.item.toLowerCase(), {
        data: entry,
        statsDate: entry.statsDate ?? statsDate,
      })
  }

  return legacyItems.map(item => {
    const key = item.ClassName?.toLowerCase()
    const official = key ? officialMap.get(key) : null
    if (!official) return item
    return {
      ...item,
      marketData: normalizeOfficialItem(official.data, official.statsDate),
    }
  })
}

// Busca o preço atual de um classname único
export async function fetchCurrentPrice(className, hotel = 'br') {
  try {
    const batch = await fetchOfficialMarketBatch(
      [{ classname: className, furniType: 'roomItem' }],
      hotel
    )
    const found =
      batch.roomItemData?.find(
        i => i.item?.toLowerCase() === className.toLowerCase()
      ) ??
      batch.wallItemData?.find(
        i => i.item?.toLowerCase() === className.toLowerCase()
      )

    if (!found) {
      // Tenta wallItem se roomItem não retornou
      const wallBatch = await fetchOfficialMarketBatch(
        [{ classname: className, furniType: 'wallItem' }],
        hotel
      )
      const wallFound = wallBatch.wallItemData?.find(
        i => i.item?.toLowerCase() === className.toLowerCase()
      )
      if (!wallFound) return null
      const norm = normalizeOfficialItem(wallFound, wallBatch.wallItemData?.[0]?.statsDate)
      return norm.currentPrice || norm.averagePrice || null
    }

    const norm = normalizeOfficialItem(found, batch.roomItemData?.[0]?.statsDate)
    return norm.currentPrice || norm.averagePrice || null
  } catch {
    return null
  }
}