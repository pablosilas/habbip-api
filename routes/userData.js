import { Router } from "express"
import { pool } from "../db.js"
import { requireAuth } from "../middleware/auth.js"

const router = Router()

// Todos os endpoints de dados exigem autenticação
router.use(requireAuth)

// ── Helpers ────────────────────────────────────────────────────────────────

// Garante que a linha de user_data existe (upsert-safe)
async function ensureUserData(userId) {
  await pool.query(
    `INSERT INTO user_data (user_id) VALUES ($1)
     ON CONFLICT (user_id) DO NOTHING`,
    [userId]
  )
}

// Campos permitidos para evitar SQL injection via campo dinâmico
const ALLOWED_FIELDS = new Set([
  "inventory",
  "watchlist",
  "settings",
  "mobi_history",
  "user_history",
  "inv_history",
  "notifications",
])

// ── Limites de validação ──────────────────────────────────────────────────
const MAX_JSON_SIZE_BYTES = 5 * 1024 * 1024 // 5MB por campo
const MAX_ARRAY_LENGTH = 100000 // Máximo de itens em arrays

function validateJsonSize(value) {
  const jsonStr = JSON.stringify(value)
  if (jsonStr.length > MAX_JSON_SIZE_BYTES) {
    throw new Error(`Dados excedem tamanho máximo de ${MAX_JSON_SIZE_BYTES / 1024}KB`)
  }
  if (Array.isArray(value) && value.length > MAX_ARRAY_LENGTH) {
    throw new Error(`Array excede tamanho máximo de ${MAX_ARRAY_LENGTH} itens`)
  }
}

// ── GET /api/user/data ─────────────────────────────────────────────────────
// Retorna todos os dados do usuário de uma vez (carregamento inicial)
router.get("/data", async (req, res) => {
  try {
    await ensureUserData(req.userId)

    const { rows } = await pool.query(
      `SELECT inventory, watchlist, settings,
              mobi_history, user_history, inv_history, notifications,
              updated_at
       FROM user_data WHERE user_id = $1`,
      [req.userId]
    )

    if (rows.length === 0) {
      return res.json({
        inventory: [],
        watchlist: [],
        settings: {},
        mobi_history: { history: [], favorites: [] },
        user_history: { history: [], favorites: [] },
        inv_history: { history: [], favorites: [] },
        notifications: [],
      })
    }

    res.json(rows[0])
  } catch (err) {
    console.error("[UserData GET] Erro:", err.message)
    res.status(500).json({ error: "Erro ao carregar dados." })
  }
})

// ── PUT /api/user/data/:field ──────────────────────────────────────────────
// Atualiza um campo específico (sync parcial)
router.put("/data/:field", async (req, res) => {
  try {
    const { field } = req.params

    if (!ALLOWED_FIELDS.has(field)) {
      return res.status(400).json({ error: "Campo não permitido." })
    }

    const { value } = req.body
    if (value === undefined) {
      return res.status(400).json({ error: "Campo 'value' não fornecido." })
    }

    // Validar tamanho dos dados
    try {
      validateJsonSize(value)
    } catch (err) {
      return res.status(400).json({ error: err.message })
    }

    await ensureUserData(req.userId)

    await pool.query(
      `UPDATE user_data SET ${field} = $1, updated_at = NOW()
       WHERE user_id = $2`,
      [JSON.stringify(value), req.userId]
    )

    res.json({ ok: true })
  } catch (err) {
    console.error("[UserData PUT field] Erro:", err.message)
    res.status(500).json({ error: "Erro ao atualizar dados." })
  }
})

// ── PUT /api/user/data ─────────────────────────────────────────────────────
// Atualiza múltiplos campos de uma vez (sync completo)
router.put("/data", async (req, res) => {
  try {
    const updates = req.body ?? {}
    const fields = Object.keys(updates).filter((k) => ALLOWED_FIELDS.has(k))

    if (fields.length === 0) {
      return res.status(400).json({ error: "Nenhum campo válido fornecido." })
    }

    // Validar tamanho de todos os campos
    for (const field of fields) {
      try {
        validateJsonSize(updates[field])
      } catch (err) {
        return res.status(400).json({ error: `Campo "${field}": ${err.message}` })
      }
    }

    await ensureUserData(req.userId)

    // Monta SET dinâmico com placeholders
    const setClauses = fields.map((f, i) => `${f} = $${i + 1}`)
    const values = fields.map((f) => JSON.stringify(updates[f]))
    values.push(req.userId)

    await pool.query(
      `UPDATE user_data SET ${setClauses.join(", ")}, updated_at = NOW()
       WHERE user_id = $${values.length}`,
      values
    )

    res.json({ ok: true })
  } catch (err) {
    console.error("[UserData PUT bulk] Erro:", err.message)
    res.status(500).json({ error: "Erro ao atualizar dados." })
  }
})

// ── DELETE /api/user/data ──────────────────────────────────────────────────
// Reseta todos os dados do usuário
router.delete("/data", async (req, res) => {
  try {
    await pool.query(
      `UPDATE user_data
       SET inventory = '[]', watchlist = '[]', settings = '{}',
           mobi_history = '{"history":[],"favorites":[]}',
           user_history = '{"history":[],"favorites":[]}',
           inv_history  = '{"history":[],"favorites":[]}',
           notifications = '[]',
           updated_at = NOW()
       WHERE user_id = $1`,
      [req.userId]
    )
    res.json({ ok: true })
  } catch (err) {
    console.error("[UserData DELETE] Erro:", err.message)
    res.status(500).json({ error: "Erro ao resetar dados." })
  }
})

export default router