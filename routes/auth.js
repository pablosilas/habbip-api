import { Router } from "express"
import bcrypt from "bcryptjs"
import crypto from "crypto"
import { pool } from "../db.js"
import {
  signAccessToken,
  signRefreshToken,
  verifyRefreshToken,
  requireAuth,
} from "../middleware/auth.js"

const router = Router()
const BCRYPT_ROUNDS = 12

// Nick do Habbo: 1-64 chars
function isValidNick(n) {
  return typeof n === "string" && n.trim().length >= 1 && n.trim().length <= 64
}

// PIN: 4 a 6 dígitos numéricos
function isValidPin(p) {
  return typeof p === "string" && /^\d{4,6}$/.test(p)
}

function hashToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex")
}

// ── POST /api/auth/register ────────────────────────────────────────────────
router.post("/register", async (req, res) => {
  const { habboNick, password } = req.body ?? {}

  if (!habboNick || !password) {
    return res.status(400).json({ error: "Nick e PIN são obrigatórios." })
  }
  if (!isValidNick(habboNick)) {
    return res.status(400).json({ error: "Nick inválido." })
  }
  if (!isValidPin(password)) {
    return res.status(400).json({ error: "PIN deve ter entre 4 e 6 dígitos numéricos." })
  }

  const nick = habboNick.trim()
  const client = await pool.connect()
  try {
    await client.query("BEGIN")

    const existing = await client.query(
      "SELECT id FROM users WHERE LOWER(habbo_nick) = LOWER($1)",
      [nick]
    )
    if (existing.rows.length > 0) {
      await client.query("ROLLBACK")
      return res.status(409).json({ error: "Esse nick já tem uma conta cadastrada." })
    }

    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS)

    const { rows } = await client.query(
      `INSERT INTO users (habbo_nick, password_hash)
       VALUES ($1, $2)
       RETURNING id, habbo_nick, created_at`,
      [nick, passwordHash]
    )
    const user = rows[0]

    await client.query(
      "INSERT INTO user_data (user_id) VALUES ($1)",
      [user.id]
    )

    await client.query("COMMIT")

    const accessToken = signAccessToken({ userId: user.id, habboNick: user.habbo_nick })
    const refreshToken = signRefreshToken({ userId: user.id })

    await pool.query(
      `INSERT INTO refresh_tokens (user_id, token_hash, expires_at)
       VALUES ($1, $2, NOW() + INTERVAL '30 days')`,
      [user.id, hashToken(refreshToken)]
    )

    res.status(201).json({
      accessToken,
      refreshToken,
      user: { id: user.id, habboNick: user.habbo_nick },
    })
  } catch (err) {
    await client.query("ROLLBACK")
    throw err
  } finally {
    client.release()
  }
})

// ── POST /api/auth/login ───────────────────────────────────────────────────
router.post("/login", async (req, res) => {
  const { habboNick, password } = req.body ?? {}

  if (!habboNick || !password) {
    return res.status(400).json({ error: "Nick e PIN são obrigatórios." })
  }

  const { rows } = await pool.query(
    `SELECT id, habbo_nick, password_hash
     FROM users WHERE LOWER(habbo_nick) = LOWER($1)`,
    [habboNick.trim()]
  )

  const user = rows[0]

  const passwordOk = user
    ? await bcrypt.compare(password, user.password_hash)
    : await bcrypt.compare(password, "$2a$12$invalidhashtopreventtimingattack1234567890")

  if (!user || !passwordOk) {
    return res.status(401).json({ error: "Nick ou PIN incorretos." })
  }

  const accessToken = signAccessToken({ userId: user.id, habboNick: user.habbo_nick })
  const refreshToken = signRefreshToken({ userId: user.id })

  await pool.query(
    `INSERT INTO refresh_tokens (user_id, token_hash, expires_at)
     VALUES ($1, $2, NOW() + INTERVAL '30 days')`,
    [user.id, hashToken(refreshToken)]
  )

  res.json({
    accessToken,
    refreshToken,
    user: { id: user.id, habboNick: user.habbo_nick },
  })
})

// ── POST /api/auth/refresh ─────────────────────────────────────────────────
router.post("/refresh", async (req, res) => {
  const { refreshToken } = req.body ?? {}
  if (!refreshToken) {
    return res.status(400).json({ error: "Refresh token não fornecido." })
  }

  let payload
  try {
    payload = verifyRefreshToken(refreshToken)
  } catch {
    return res.status(401).json({ error: "Refresh token inválido ou expirado." })
  }

  const tokenHash = hashToken(refreshToken)
  const { rows } = await pool.query(
    `SELECT id, user_id FROM refresh_tokens
     WHERE token_hash = $1 AND expires_at > NOW()`,
    [tokenHash]
  )

  if (rows.length === 0) {
    return res.status(401).json({ error: "Refresh token não encontrado ou expirado." })
  }

  const userRes = await pool.query(
    "SELECT id, habbo_nick FROM users WHERE id = $1",
    [rows[0].user_id]
  )
  if (userRes.rows.length === 0) {
    return res.status(401).json({ error: "Usuário não encontrado." })
  }
  const user = userRes.rows[0]

  await pool.query("DELETE FROM refresh_tokens WHERE token_hash = $1", [tokenHash])

  const newAccessToken = signAccessToken({ userId: user.id, habboNick: user.habbo_nick })
  const newRefreshToken = signRefreshToken({ userId: user.id })

  await pool.query(
    `INSERT INTO refresh_tokens (user_id, token_hash, expires_at)
     VALUES ($1, $2, NOW() + INTERVAL '30 days')`,
    [user.id, hashToken(newRefreshToken)]
  )

  res.json({
    accessToken: newAccessToken,
    refreshToken: newRefreshToken,
    user: { id: user.id, habboNick: user.habbo_nick },
  })
})

// ── POST /api/auth/logout ──────────────────────────────────────────────────
router.post("/logout", requireAuth, async (req, res) => {
  try {
    const { refreshToken } = req.body ?? {}
    if (refreshToken) {
      await pool.query(
        "DELETE FROM refresh_tokens WHERE token_hash = $1",
        [hashToken(refreshToken)]
      )
    } else {
      await pool.query(
        "DELETE FROM refresh_tokens WHERE user_id = $1",
        [req.userId]
      )
    }
    res.json({ ok: true })
  } catch (err) {
    console.error("[Logout] Erro:", err.message)
    res.status(500).json({ error: "Erro ao fazer logout." })
  }
})

// ── PATCH /api/auth/me ─────────────────────────────────────────────────────
router.patch("/me", requireAuth, async (req, res) => {
  const { currentPassword, newPassword } = req.body ?? {}

  if (!newPassword) {
    return res.status(400).json({ error: "Novo PIN é obrigatório." })
  }
  if (!currentPassword) {
    return res.status(400).json({ error: "PIN atual é necessário." })
  }
  if (!isValidPin(newPassword)) {
    return res.status(400).json({ error: "Novo PIN deve ter entre 4 e 6 dígitos numéricos." })
  }

  const { rows } = await pool.query(
    "SELECT password_hash FROM users WHERE id = $1",
    [req.userId]
  )
  const ok = await bcrypt.compare(currentPassword, rows[0].password_hash)
  if (!ok) {
    return res.status(401).json({ error: "PIN atual incorreto." })
  }

  await pool.query(
    "UPDATE users SET password_hash = $1 WHERE id = $2",
    [await bcrypt.hash(newPassword, BCRYPT_ROUNDS), req.userId]
  )

  res.json({ ok: true })
})

export default router