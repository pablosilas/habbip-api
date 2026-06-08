import { Router } from 'express'
import bcrypt from 'bcryptjs'
import { pool } from '../db.js'

const router = Router()
const BCRYPT_ROUNDS = 12

function requireAdminKey(req, res, next) {
  const key = req.headers['x-admin-key']
  if (!key || key !== process.env.ADMIN_SECRET_KEY) {
    return res.status(401).json({ error: 'Não autorizado.' })
  }
  next()
}

// POST /api/admin/users — cria usuário
router.post('/users', requireAdminKey, async (req, res) => {
  const { email, password, habboNick, grantAccess = false, days = 30, unlimited = false } = req.body ?? {}

  if (!email || !password) {
    return res.status(400).json({ error: 'Email e senha são obrigatórios.' })
  }
  if (password.length < 8) {
    return res.status(400).json({ error: 'Senha deve ter no mínimo 8 caracteres.' })
  }

  const emailNorm = email.trim().toLowerCase()
  const client = await pool.connect()
  try {
    await client.query('BEGIN')

    const existing = await client.query(
      'SELECT id FROM users WHERE LOWER(email) = $1', [emailNorm]
    )
    if (existing.rows.length > 0) {
      await client.query('ROLLBACK')
      return res.status(409).json({ error: 'Email já cadastrado.' })
    }

    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS)
    const { rows } = await client.query(
      `INSERT INTO users (email, habbo_nick, password_hash)
       VALUES ($1, $2, $3) RETURNING id, email, habbo_nick`,
      [emailNorm, habboNick?.trim() || null, passwordHash]
    )
    const user = rows[0]

    await client.query('INSERT INTO user_data (user_id) VALUES ($1)', [user.id])

    if (grantAccess) {
      const expiresAt = unlimited ? null : `NOW() + INTERVAL '${Number(days)} days'`
      await client.query(
        `INSERT INTO user_plan_subscriptions (user_id, status, expires_at)
         VALUES ($1, 'active', ${unlimited ? 'NULL' : expiresAt})`,
        [user.id]
      )
    }

    await client.query('COMMIT')
    res.status(201).json({
      user: { id: user.id, email: user.email, habboNick: user.habbo_nick },
      accessGranted: grantAccess,
      expiresIn: grantAccess ? `${days} dias` : null,
    })
  } catch (err) {
    await client.query('ROLLBACK')
    throw err
  } finally {
    client.release()
  }
})

// POST /api/admin/users/:id/grant — ativa ou renova acesso
router.post('/users/:id/grant', requireAdminKey, async (req, res) => {
  const userId = Number(req.params.id)
  const { days = 30, unlimited = false } = req.body ?? {}

  if (!userId) return res.status(400).json({ error: 'ID inválido.' })

  const userRes = await pool.query('SELECT id, email FROM users WHERE id = $1', [userId])
  if (userRes.rows.length === 0) {
    return res.status(404).json({ error: 'Usuário não encontrado.' })
  }

  let newExpiry = null
  if (!unlimited) {
    const current = await pool.query(
      `SELECT expires_at FROM user_plan_subscriptions
       WHERE user_id = $1 AND status = 'active' AND (expires_at IS NULL OR expires_at > NOW())
       ORDER BY expires_at DESC NULLS LAST LIMIT 1`,
      [userId]
    )
    const baseDate = (current.rows.length > 0 && current.rows[0].expires_at)
      ? new Date(current.rows[0].expires_at)
      : new Date()
    newExpiry = new Date(baseDate)
    newExpiry.setDate(newExpiry.getDate() + days)
  }

  const updated = await pool.query(
    `UPDATE user_plan_subscriptions SET status = 'active', expires_at = $1, updated_at = NOW()
     WHERE user_id = $2 AND status = 'active' RETURNING id`,
    [newExpiry, userId]
  )

  if (updated.rows.length === 0) {
    await pool.query(
      `INSERT INTO user_plan_subscriptions (user_id, status, expires_at)
       VALUES ($1, 'active', $2)`,
      [userId, newExpiry]
    )
  }

  res.json({ ok: true, userId, email: userRes.rows[0].email, expiresAt: newExpiry, unlimited: !newExpiry })
})

// DELETE /api/admin/users/:id/revoke — revoga acesso
router.delete('/users/:id/revoke', requireAdminKey, async (req, res) => {
  const userId = Number(req.params.id)
  if (!userId) return res.status(400).json({ error: 'ID inválido.' })

  await pool.query(
    `UPDATE user_plan_subscriptions SET status = 'revoked', updated_at = NOW()
     WHERE user_id = $1 AND status = 'active'`,
    [userId]
  )
  res.json({ ok: true, userId })
})

// PATCH /api/admin/users/:id — edita email, senha e/ou habboNick
router.patch('/users/:id', requireAdminKey, async (req, res) => {
  const userId = Number(req.params.id)
  if (!userId) return res.status(400).json({ error: 'ID inválido.' })

  const { email, password, habboNick } = req.body ?? {}
  if (!email && !password && habboNick === undefined) {
    return res.status(400).json({ error: 'Nenhum campo para atualizar.' })
  }

  const userRes = await pool.query('SELECT id FROM users WHERE id = $1', [userId])
  if (userRes.rows.length === 0) return res.status(404).json({ error: 'Usuário não encontrado.' })

  const sets = []
  const values = []
  let idx = 1

  if (email) {
    const emailNorm = email.trim().toLowerCase()
    const dup = await pool.query('SELECT id FROM users WHERE LOWER(email) = $1 AND id != $2', [emailNorm, userId])
    if (dup.rows.length > 0) return res.status(409).json({ error: 'Email já em uso.' })
    sets.push(`email = $${idx++}`)
    values.push(emailNorm)
  }
  if (password) {
    if (password.length < 8) return res.status(400).json({ error: 'Senha deve ter no mínimo 8 caracteres.' })
    sets.push(`password_hash = $${idx++}`)
    values.push(await bcrypt.hash(password, BCRYPT_ROUNDS))
  }
  if (habboNick !== undefined) {
    sets.push(`habbo_nick = $${idx++}`)
    values.push(habboNick?.trim() || null)
  }

  values.push(userId)
  await pool.query(`UPDATE users SET ${sets.join(', ')} WHERE id = $${idx}`, values)
  res.json({ ok: true, userId })
})

// GET /api/admin/users — lista todos os usuários com status
router.get('/users', requireAdminKey, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT u.id, u.email, u.habbo_nick, u.created_at,
       s.status as subscription_status, s.expires_at,
       (s.status = 'active' AND s.expires_at IS NULL) as unlimited
     FROM users u
     LEFT JOIN LATERAL (
       SELECT status, expires_at FROM user_plan_subscriptions
       WHERE user_id = u.id ORDER BY created_at DESC LIMIT 1
     ) s ON true
     ORDER BY u.created_at DESC`
  )
  res.json(rows)
})

export default router