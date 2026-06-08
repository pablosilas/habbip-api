import jwt from "jsonwebtoken"
import { pool } from "../db.js"

const JWT_SECRET = process.env.JWT_SECRET
const JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET

if (!JWT_SECRET || !JWT_REFRESH_SECRET) {
  throw new Error("JWT_SECRET e JWT_REFRESH_SECRET devem estar definidos nas variáveis de ambiente.")
}

export function signAccessToken(payload) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: "15m" })
}

export function signRefreshToken(payload) {
  return jwt.sign(payload, JWT_REFRESH_SECRET, { expiresIn: "30d" })
}

export function verifyAccessToken(token) {
  return jwt.verify(token, JWT_SECRET)
}

export function verifyRefreshToken(token) {
  return jwt.verify(token, JWT_REFRESH_SECRET)
}

export function requireAuth(req, res, next) {
  const queryToken = req.query?.token
  const header = req.headers.authorization
  const token = queryToken ?? (header?.startsWith('Bearer ') ? header.slice(7) : null)
  if (!token) return res.status(401).json({ error: 'Autenticação necessária.' })

  try {
    const payload = verifyAccessToken(token)
    req.userId = payload.userId
    req.habboNick = payload.habboNick
    req.email = payload.email
    next()
  } catch (err) {
    if (err.name === 'TokenExpiredError')
      return res.status(401).json({ error: 'Token expirado.', code: 'TOKEN_EXPIRED' })
    return res.status(401).json({ error: 'Token inválido.' })
  }
}

export async function requireSubscription(req, res, next) {
  try {
    const { rows } = await pool.query(
      `SELECT id FROM user_plan_subscriptions
       WHERE user_id = $1 AND status = 'active' AND expires_at > NOW()
       LIMIT 1`,
      [req.userId]
    )
    if (rows.length === 0) {
      return res.status(403).json({ error: 'Assinatura necessária.', code: 'SUBSCRIPTION_REQUIRED' })
    }
    next()
  } catch (err) {
    console.error('[requireSubscription]', err.message)
    res.status(500).json({ error: 'Erro ao verificar assinatura.' })
  }
}

export function optionalAuth(req, res, next) {
  const header = req.headers.authorization
  if (header?.startsWith("Bearer ")) {
    try {
      const payload = verifyAccessToken(header.slice(7))
      req.userId = payload.userId
      req.habboNick = payload.habboNick
      req.email = payload.email
    } catch {
      // continua como anônimo
    }
  }
  next()
}
