import {
  fetchCurrentPrice,
} from "../services/habboApi.js"
import { pool } from "../db.js"

const POLL_INTERVAL_MS = 30 * 60 * 1000  // 30 minutos
const BATCH_SIZE = 5                       // usuários por lote
const ITEM_DELAY_MS = 800                  // pausa entre itens
const USER_DELAY_MS = 200                  // pausa entre usuários
const MAX_NOTIFICATIONS = 50

// ── Processa um único usuário ────────────────────────────────────────────────
async function processUser(userId, watchlist) {
  if (!Array.isArray(watchlist) || watchlist.length === 0) return 0

  const newNotifications = []
  const updatedWatchlist = [...watchlist]

  for (let i = 0; i < watchlist.length; i++) {
    const item = watchlist[i]
    if (!item?.ClassName) continue

    try {
      const newPrice = await fetchCurrentPrice(item.ClassName, item.hotel ?? "br")
      if (newPrice == null || newPrice === 0) continue

      const oldPrice = item.basePrice

      // Atualiza basePrice sempre, mesmo sem variação
      updatedWatchlist[i] = { ...item, basePrice: newPrice }

      if (!oldPrice || oldPrice === newPrice) continue

      const diff = newPrice - oldPrice
      const pct = parseFloat(((diff / oldPrice) * 100).toFixed(1))

      newNotifications.push({
        id: `${item.ClassName}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        className: item.ClassName,
        furniName: item.FurniName,
        oldPrice,
        newPrice,
        diff,
        pct,
        direction: diff > 0 ? "up" : "down",
        hotel: item.hotel ?? "br",
        read: false,
        createdAt: Date.now(),
        source: "background",
      })
    } catch {
      // Silencia erros individuais
    }

    if (i < watchlist.length - 1) {
      await new Promise((r) => setTimeout(r, ITEM_DELAY_MS))
    }
  }

  // Só salva se teve mudança
  const watchlistChanged = updatedWatchlist.some((u, i) => u !== watchlist[i])
  if (newNotifications.length === 0 && !watchlistChanged) return 0

  const client = await pool.connect()
  try {
    await client.query("BEGIN")

    const { rows } = await client.query(
      "SELECT notifications FROM user_data WHERE user_id = $1 FOR UPDATE",
      [userId]
    )
    const existing = Array.isArray(rows[0]?.notifications) ? rows[0].notifications : []
    const mergedNotifs = [...newNotifications, ...existing].slice(0, MAX_NOTIFICATIONS)

    await client.query(
      `UPDATE user_data
       SET watchlist = $1, notifications = $2, updated_at = NOW()
       WHERE user_id = $3`,
      [JSON.stringify(updatedWatchlist), JSON.stringify(mergedNotifs), userId]
    )

    await client.query("COMMIT")
    return newNotifications.length
  } catch (err) {
    await client.query("ROLLBACK")
    console.error(`[Monitor] Erro ao salvar para usuário ${userId}:`, err.message)
    return 0
  } finally {
    client.release()
  }
}

// ── Job principal ────────────────────────────────────────────────────────────
async function runPriceMonitor() {
  console.log("[Monitor] Iniciando verificação de preços...")
  const startedAt = Date.now()
  let totalUsers = 0
  let totalNotifs = 0
  let offset = 0

  try {
    while (true) {
      const { rows } = await pool.query(
        `SELECT user_id, watchlist
         FROM user_data
         WHERE jsonb_array_length(watchlist) > 0
         ORDER BY updated_at ASC
         LIMIT $1 OFFSET $2`,
        [BATCH_SIZE, offset]
      )

      if (rows.length === 0) break

      for (const row of rows) {
        const count = await processUser(row.user_id, row.watchlist)
        totalNotifs += count
        totalUsers++
        await new Promise((r) => setTimeout(r, USER_DELAY_MS))
      }

      offset += rows.length
      if (rows.length < BATCH_SIZE) break
    }
  } catch (err) {
    console.error("[Monitor] Erro no job:", err.message)
  }

  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1)
  console.log(`[Monitor] Concluído em ${elapsed}s — ${totalUsers} usuário(s), ${totalNotifs} notificação(ões)`)
}

// ── Exporta a função de inicialização ────────────────────────────────────────
export function startPriceMonitor() {
  console.log(`[Monitor] Iniciado — verificações a cada ${POLL_INTERVAL_MS / 60000} minutos`)
  runPriceMonitor() // roda imediatamente
  setInterval(runPriceMonitor, POLL_INTERVAL_MS)
}