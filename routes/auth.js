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

function isValidEmail(e) {
  return typeof e === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e.trim())
}

function isValidPassword(p) {
  return typeof p === "string" && p.length >= 8
}

function isValidNick(n) {
  return typeof n === "string" && n.trim().length >= 1 && n.trim().length <= 64
}

function hashToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex")
}

// ── POST /api/auth/register ────────────────────────────────────────────────
router.post("/register", async (req, res) => {
  const { email, habboNick, password } = req.body ?? {}

  if (!email || !password) {
    return res.status(400).json({ error: "Email e senha são obrigatórios." })
  }
  if (!isValidEmail(email)) {
    return res.status(400).json({ error: "Email inválido." })
  }
  if (!isValidPassword(password)) {
    return res.status(400).json({ error: "Senha deve ter no mínimo 8 caracteres." })
  }
  if (habboNick && !isValidNick(habboNick)) {
    return res.status(400).json({ error: "Nick do Habbo inválido." })
  }

  const emailNorm = email.trim().toLowerCase()
  const nick = habboNick?.trim() || null

  const client = await pool.connect()
  try {
    await client.query("BEGIN")

    const existing = await client.query(
      "SELECT id FROM users WHERE LOWER(email) = $1",
      [emailNorm]
    )
    if (existing.rows.length > 0) {
      await client.query("ROLLBACK")
      return res.status(409).json({ error: "Este email já está cadastrado." })
    }

    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS)

    const { rows } = await client.query(
      `INSERT INTO users (email, habbo_nick, password_hash)
       VALUES ($1, $2, $3)
       RETURNING id, email, habbo_nick, created_at`,
      [emailNorm, nick, passwordHash]
    )
    const user = rows[0]

    await client.query(
      "INSERT INTO user_data (user_id) VALUES ($1)",
      [user.id]
    )

    await client.query("COMMIT")

    const accessToken = signAccessToken({ userId: user.id, habboNick: user.habbo_nick, email: user.email })
    const refreshToken = signRefreshToken({ userId: user.id })

    await pool.query(
      `INSERT INTO refresh_tokens (user_id, token_hash, expires_at)
       VALUES ($1, $2, NOW() + INTERVAL '30 days')`,
      [user.id, hashToken(refreshToken)]
    )

    res.status(201).json({
      accessToken,
      refreshToken,
      user: { id: user.id, email: user.email, habboNick: user.habbo_nick },
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
  const { email, password } = req.body ?? {}

  if (!email || !password) {
    return res.status(400).json({ error: "Email e senha são obrigatórios." })
  }

  const { rows } = await pool.query(
    `SELECT id, email, habbo_nick, password_hash
     FROM users WHERE LOWER(email) = LOWER($1)`,
    [email.trim()]
  )

  const user = rows[0]

  const passwordOk = user
    ? await bcrypt.compare(password, user.password_hash)
    : await bcrypt.compare(password, "$2a$12$invalidhashtopreventtimingattack1234567890")

  if (!user || !passwordOk) {
    return res.status(401).json({ error: "Email ou senha incorretos." })
  }

  const accessToken = signAccessToken({ userId: user.id, habboNick: user.habbo_nick, email: user.email })
  const refreshToken = signRefreshToken({ userId: user.id })

  await pool.query(
    `INSERT INTO refresh_tokens (user_id, token_hash, expires_at)
     VALUES ($1, $2, NOW() + INTERVAL '30 days')`,
    [user.id, hashToken(refreshToken)]
  )

  res.json({
    accessToken,
    refreshToken,
    user: { id: user.id, email: user.email, habboNick: user.habbo_nick },
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
    "SELECT id, email, habbo_nick FROM users WHERE id = $1",
    [rows[0].user_id]
  )
  if (userRes.rows.length === 0) {
    return res.status(401).json({ error: "Usuário não encontrado." })
  }
  const user = userRes.rows[0]

  await pool.query("DELETE FROM refresh_tokens WHERE token_hash = $1", [tokenHash])

  const newAccessToken = signAccessToken({ userId: user.id, habboNick: user.habbo_nick, email: user.email })
  const newRefreshToken = signRefreshToken({ userId: user.id })

  await pool.query(
    `INSERT INTO refresh_tokens (user_id, token_hash, expires_at)
     VALUES ($1, $2, NOW() + INTERVAL '30 days')`,
    [user.id, hashToken(newRefreshToken)]
  )

  res.json({
    accessToken: newAccessToken,
    refreshToken: newRefreshToken,
    user: { id: user.id, email: user.email, habboNick: user.habbo_nick },
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
  const { currentPassword, newPassword, email } = req.body ?? {}

  if (!currentPassword) {
    return res.status(400).json({ error: "Senha atual é necessária." })
  }
  if (!newPassword && !email) {
    return res.status(400).json({ error: "Informe nova senha ou novo email." })
  }
  if (newPassword && !isValidPassword(newPassword)) {
    return res.status(400).json({ error: "Nova senha deve ter no mínimo 8 caracteres." })
  }
  if (email && !isValidEmail(email)) {
    return res.status(400).json({ error: "Email inválido." })
  }

  const { rows } = await pool.query(
    "SELECT password_hash, email FROM users WHERE id = $1",
    [req.userId]
  )
  const ok = await bcrypt.compare(currentPassword, rows[0].password_hash)
  if (!ok) {
    return res.status(401).json({ error: "Senha atual incorreta." })
  }

  const sets = []
  const values = []
  let idx = 1

  if (newPassword) {
    sets.push(`password_hash = $${idx++}`)
    values.push(await bcrypt.hash(newPassword, BCRYPT_ROUNDS))
  }
  if (email) {
    const emailNorm = email.trim().toLowerCase()
    const dup = await pool.query(
      "SELECT id FROM users WHERE LOWER(email) = $1 AND id != $2",
      [emailNorm, req.userId]
    )
    if (dup.rows.length > 0) return res.status(409).json({ error: "Email já em uso." })
    sets.push(`email = $${idx++}`)
    values.push(emailNorm)
  }

  values.push(req.userId)
  await pool.query(`UPDATE users SET ${sets.join(", ")} WHERE id = $${idx}`, values)

  const updated = await pool.query("SELECT id, email, habbo_nick FROM users WHERE id = $1", [req.userId])
  const u = updated.rows[0]
  res.json({ ok: true, user: { id: u.id, email: u.email, habboNick: u.habbo_nick } })
})

export default router
