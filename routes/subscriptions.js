// routes/subscriptions.js
import { Router } from 'express'
import { requireAuth } from '../middleware/auth.js'
import { pool } from '../db.js'

const router = Router()
router.use(requireAuth)

// GET /api/subscriptions — lista inscrições do usuário
router.get('/', async (req, res) => {
  const { rows } = await pool.query(
    `SELECT s.classname, s.hotel, s.furni_name, s.furni_type,
            s.alert_config, s.base_price, s.created_at,
            mp.current_price, mp.average_price, mp.open_offers, mp.market_data
     FROM user_subscriptions s
     LEFT JOIN market_prices mp
       ON mp.classname = s.classname AND mp.hotel = s.hotel
     WHERE s.user_id = $1 AND s.active = TRUE
     ORDER BY s.created_at DESC`,
    [req.userId]
  )
  res.json(rows)
})

// POST /api/subscriptions — adiciona item ao monitoramento
router.post('/', async (req, res) => {
  const { classname, hotel = 'br', furniName, furniType = 'roomItem', basePrice, alertConfig } = req.body ?? {}
  if (!classname) return res.status(400).json({ error: 'classname obrigatório.' })

  const client = await pool.connect()
  try {
    await client.query('BEGIN')

    // Upsert na inscrição do usuário
    await client.query(
      `INSERT INTO user_subscriptions
         (user_id, classname, hotel, furni_name, furni_type, base_price, alert_config)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (user_id, classname, hotel) DO UPDATE
       SET active = TRUE, base_price = COALESCE($6, user_subscriptions.base_price),
           alert_config = COALESCE($7, user_subscriptions.alert_config)`,
      [req.userId, classname, hotel, furniName, furniType, basePrice,
      JSON.stringify(alertConfig ?? { alertMode: 'any', targetPrice: null, priceMargin: null })]
    )

    // Garante que o item existe em monitored_items e atualiza subscriber_count
    await client.query(
      `INSERT INTO monitored_items (classname, hotel, furni_name, furni_type, subscriber_count, priority)
       VALUES ($1, $2, $3, $4, 1, 3)
       ON CONFLICT (classname, hotel) DO UPDATE
       SET subscriber_count = (
         SELECT COUNT(*) FROM user_subscriptions
         WHERE classname = $1 AND hotel = $2 AND active = TRUE
       ),
       priority = CASE
         WHEN (SELECT COUNT(*) FROM user_subscriptions WHERE classname=$1 AND hotel=$2 AND active=TRUE) > 10 THEN 1
         WHEN (SELECT COUNT(*) FROM user_subscriptions WHERE classname=$1 AND hotel=$2 AND active=TRUE) > 3  THEN 2
         ELSE 3
       END,
       furni_name = COALESCE($3, monitored_items.furni_name),
       furni_type = COALESCE($4, monitored_items.furni_type)`,
      [classname, hotel, furniName, furniType]
    )

    await client.query('COMMIT')
    res.json({ ok: true })
  } catch (err) {
    await client.query('ROLLBACK')
    res.status(500).json({ error: err.message })
  } finally {
    client.release()
  }
})

// DELETE /api/subscriptions/:classname — remove inscrição
router.delete('/:classname', async (req, res) => {
  const { classname } = req.params
  const { hotel = 'br' } = req.query

  await pool.query(
    `UPDATE user_subscriptions SET active = FALSE
     WHERE user_id = $1 AND classname = $2 AND hotel = $3`,
    [req.userId, classname, hotel]
  )

  // Atualiza subscriber_count
  await pool.query(
    `UPDATE monitored_items
     SET subscriber_count = (
       SELECT COUNT(*) FROM user_subscriptions
       WHERE classname = $1 AND hotel = $2 AND active = TRUE
     )
     WHERE classname = $1 AND hotel = $2`,
    [classname, hotel]
  )

  res.json({ ok: true })
})

// PATCH /api/subscriptions/:classname/alert — atualiza alertConfig
router.patch('/:classname/alert', async (req, res) => {
  const { classname } = req.params
  const { hotel = 'br', alertConfig } = req.body ?? {}

  await pool.query(
    `UPDATE user_subscriptions SET alert_config = $1
     WHERE user_id = $2 AND classname = $3 AND hotel = $4 AND active = TRUE`,
    [JSON.stringify(alertConfig), req.userId, classname, hotel]
  )

  res.json({ ok: true })
})

export default router