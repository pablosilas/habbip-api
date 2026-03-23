import express from "express"

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


let furniCache = {}
const CACHE_TTL_MS = 60 * 60 * 1000 // 1 hora

export async function warmupFurniCache() {
  try {
    const res = await fetch("https://www.habbo.com.br/gamedata/furnidata_json/1")
    if (!res.ok) return
    const data = await res.json()
    furniCache["br"] = { data, fetchedAt: Date.now() }
    console.log("[warmup] furnidata br carregado")
  } catch (err) {
    console.warn("[warmup] falhou:", err.message)
  }
}

router.get("/", async (req, res) => {
  const hotel = req.query.hotel || "br"
  const baseUrl = hotelMap[hotel] || hotelMap.br

  if (furniCache[hotel] && Date.now() - furniCache[hotel].fetchedAt < CACHE_TTL_MS) {
    return res.json(furniCache[hotel].data)
  }

  try {
    const response = await fetch(`${baseUrl}/gamedata/furnidata_json/1`)
    if (!response.ok) throw new Error(`Habbo retornou ${response.status}`)
    const data = await response.json()
    furniCache[hotel] = { data, fetchedAt: Date.now() }
    console.log(`[furnidata] buscado do Habbo: ${hotel}`)
    res.json(data)
  } catch (err) {
    console.error("[furnidata] erro:", err.message)
    res.status(502).json({ error: "Falha ao buscar furnidata." })
  }
})

router.get("/search", async (req, res) => {
  const { q, hotel = "br" } = req.query
  if (!q?.trim()) return res.json([])

  // Reutiliza o cache do furnidata
  let data = furniCache[hotel]?.data
  if (!data) {
    try {
      const response = await fetch(`${hotelMap[hotel] || hotelMap.br}/gamedata/furnidata_json/1`)
      if (!response.ok) throw new Error()
      data = await response.json()
      furniCache[hotel] = { data, fetchedAt: Date.now() }
    } catch {
      return res.status(502).json({ error: "Falha ao buscar furnidata." })
    }
  }

  const term = q.trim().toLowerCase()

  const roomItems = (data?.roomitemtypes?.furnitype ?? [])
    .filter(i => i.name?.toLowerCase().includes(term))
    .map(i => ({ classname: i.classname, furniName: i.name, furniType: "roomItem", revision: i.revision }))

  const wallItems = (data?.wallitemtypes?.furnitype ?? [])
    .filter(i => i.name?.toLowerCase().includes(term))
    .map(i => ({ classname: i.classname, furniName: i.name, furniType: "wallItem", revision: i.revision }))

  res.json([...roomItems, ...wallItems])
})

const imageUrlCache = new Map() // classname:hotel → url

router.get("/image-url", async (req, res) => {
  const { classname, hotel = "br" } = req.query
  if (!classname) return res.status(400).json({ error: "classname obrigatório." })

  const base = classname.replace("*", "_")   // para URL
  const cacheKey = `${base}:${hotel}`

  if (imageUrlCache.has(cacheKey)) {
    return res.json({ url: imageUrlCache.get(cacheKey) })
  }

  let data = furniCache[hotel]?.data
  if (!data) {
    try {
      const response = await fetch(`${hotelMap[hotel] || hotelMap.br}/gamedata/furnidata_json/1`)
      if (!response.ok) throw new Error()
      data = await response.json()
      furniCache[hotel] = { data, fetchedAt: Date.now() }
    } catch {
      return res.status(502).json({ error: "Falha ao buscar furnidata." })
    }
  }

  const allItems = [
    ...(data?.roomitemtypes?.furnitype ?? []),
    ...(data?.wallitemtypes?.furnitype ?? []),
  ]

  // busca pelo classname original (*) ou pelo base (_)
  const found = allItems.find(i => i.classname === classname || i.classname === base)
  const revision = found?.revision

  const candidates = [
    revision ? `https://habcat.net/media/furni2/${revision}/${base}/0_0.webp` : null,
    `https://habboapi.site/api/image/${encodeURIComponent(classname)}`,
    revision ? `https://images.habbo.com/dcr/hof_furni/${revision}/${base}.png` : null,
    revision ? `https://images.habbo.com/dcr/hof_furni/${revision}/${base}_icon.png` : null,
  ].filter(Boolean)

  let resolvedUrl = ""
  for (const url of candidates) {
    try {
      const check = await fetch(url, { method: "HEAD" })
      if (check.ok) { resolvedUrl = url; break }
    } catch { }
  }

  imageUrlCache.set(cacheKey, resolvedUrl)
  res.json({ url: resolvedUrl })
})

export default router