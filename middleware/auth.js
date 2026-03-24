import jwt from "jsonwebtoken"

const JWT_SECRET = process.env.JWT_SECRET
const JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET

if (!JWT_SECRET || !JWT_REFRESH_SECRET) {
  throw new Error("JWT_SECRET e JWT_REFRESH_SECRET devem estar definidos nas variáveis de ambiente.")
}

// Access token: curta duração (15 min)
export function signAccessToken(payload) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: "15m" })
}

// Refresh token: longa duração (30 dias)
export function signRefreshToken(payload) {
  return jwt.sign(payload, JWT_REFRESH_SECRET, { expiresIn: "30d" })
}

export function verifyAccessToken(token) {
  return jwt.verify(token, JWT_SECRET)
}

export function verifyRefreshToken(token) {
  return jwt.verify(token, JWT_REFRESH_SECRET)
}

// ── Middleware Express ─────────────────────────────────────────────────────

/**
 * requireAuth — protege rotas que exigem login.
 * Extrai o token do header Authorization: Bearer <token>
 */
export function requireAuth(req, res, next) {
  // Suporte a token via query param (necessário para EventSource/SSE)
  const queryToken = req.query?.token
  const header = req.headers.authorization

  const token = queryToken ?? (header?.startsWith('Bearer ') ? header.slice(7) : null)
  if (!token) return res.status(401).json({ error: 'Autenticação necessária.' })

  try {
    const payload = verifyAccessToken(token)
    req.userId = payload.userId
    req.habboNick = payload.habboNick
    next()
  } catch (err) {
    if (err.name === 'TokenExpiredError')
      return res.status(401).json({ error: 'Token expirado.', code: 'TOKEN_EXPIRED' })
    return res.status(401).json({ error: 'Token inválido.' })
  }
}

/**
 * optionalAuth — não bloqueia, mas popula req.userId se tiver token válido.
 * Usado em rotas que funcionam para anônimos e logados (mas com comportamentos diferentes).
 */
export function optionalAuth(req, res, next) {
  const header = req.headers.authorization
  if (header?.startsWith("Bearer ")) {
    try {
      const payload = verifyAccessToken(header.slice(7))
      req.userId = payload.userId
      req.habboNick = payload.habboNick
    } catch {
      // Token inválido/expirado — continua como anônimo
    }
  }
  next()
}