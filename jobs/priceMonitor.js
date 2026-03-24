// jobs/priceMonitor.js — Worker sem prioridade, todos os itens no mesmo intervalo

import crypto from "node:crypto";
import { fetchOfficialMarketBatchSafe } from "../services/habboApi.js";
import { pool } from "../db.js";
import { redisPublisher } from "../services/redis.js";

const ITEM_DELAY_MS = 300;
const MAX_NOTIFICATIONS = 50;
const MONITOR_INTERVAL_MS = 30 * 1000; // todos os itens são checados a cada 30s

// Busca itens que precisam ser verificados agora, agrupados por hotel
async function fetchItemsDue() {
  const cutoff = new Date(Date.now() - MONITOR_INTERVAL_MS);

  const { rows } = await pool.query(
    `SELECT id, classname, hotel, furni_name, furni_type,
            last_known_price, subscriber_count
     FROM monitored_items
     WHERE subscriber_count > 0
       AND (last_checked_at IS NULL OR last_checked_at < $1)
     ORDER BY last_checked_at ASC NULLS FIRST
     LIMIT 300`,
    [cutoff],
  );

  return rows;
}

// Agrupa itens por hotel para fazer batch por hotel
function groupByHotel(items) {
  const map = new Map();

  for (const item of items) {
    const hotel = item.hotel || "br";
    if (!map.has(hotel)) map.set(hotel, []);
    map.get(hotel).push(item);
  }

  return map;
}

async function processHotelBatch(hotel, items) {
  const batchItems = items.map((i) => ({
    classname: i.classname,
    furniType: i.furni_type === "wallItem" ? "wallItem" : "roomItem",
  }));

  let officialBatch;

  try {
    officialBatch = await fetchOfficialMarketBatchSafe(batchItems, hotel);
  } catch (err) {
    console.error(`[Monitor] Erro ao buscar batch hotel=${hotel}:`, err.message);
    return;
  }

  const officialMap = new Map();

  for (const entry of officialBatch.roomItemData ?? []) {
    if (entry.item) officialMap.set(entry.item.toLowerCase(), entry);
  }

  for (const entry of officialBatch.wallItemData ?? []) {
    if (entry.item) officialMap.set(entry.item.toLowerCase(), entry);
  }

  for (const item of items) {
    const official = officialMap.get(item.classname.toLowerCase());

    const currentPrice =
      official?.currentPrice != null ? Number(official.currentPrice) : null;

    const averagePrice =
      official?.averagePrice != null ? Number(official.averagePrice) : null;

    const newPrice = currentPrice;

    // Atualiza last_checked_at sempre
    await pool.query(
      `UPDATE monitored_items
       SET last_checked_at = NOW(),
           last_known_price = COALESCE($1, last_known_price),
           subscriber_count = (
             SELECT COUNT(*)
             FROM user_subscriptions
             WHERE classname = $2
               AND hotel = $3
               AND active = TRUE
           )
       WHERE classname = $2
         AND hotel = $3`,
      [newPrice, item.classname, hotel],
    );

    if (newPrice == null) continue;

    // Salva em market_prices (upsert)
    const marketData = official
      ? {
        currentPrice: official.currentPrice,
        averagePrice: official.averagePrice,
        currentOpenOffers: official.currentOpenOffers,
        totalOpenOffers: official.totalOpenOffers,
        soldItemCount: official.soldItemCount,
        history: official.history ?? [],
      }
      : null;

    await pool.query(
      `INSERT INTO market_prices (
         classname,
         hotel,
         current_price,
         average_price,
         open_offers,
         market_data,
         updated_at
       )
       VALUES ($1, $2, $3, $4, $5, $6, NOW())
       ON CONFLICT (classname, hotel) DO UPDATE
       SET current_price = $3,
           average_price = $4,
           open_offers = $5,
           market_data = $6,
           updated_at = NOW()`,
      [
        item.classname,
        hotel,
        currentPrice,
        averagePrice,
        official?.currentOpenOffers ?? null,
        JSON.stringify(marketData),
      ],
    );

    const oldPrice = item.last_known_price;

    console.log("[Monitor][debug]", {
      classname: item.classname,
      hotel,
      oldPrice,
      currentPrice,
      averagePrice,
      newPrice,
    });

    if (!oldPrice || oldPrice === newPrice) continue;

    // Salva no histórico
    await pool.query(
      `INSERT INTO price_history (classname, hotel, price)
       VALUES ($1, $2, $3)`,
      [item.classname, hotel, newPrice],
    );

    const diff = newPrice - oldPrice;
    const pct = parseFloat(((diff / oldPrice) * 100).toFixed(1));

    const detectedAt = Date.now();
    const eventId = crypto.randomUUID();

    // Publica no Redis — a API vai distribuir para os SSE dos usuários inscritos
    const event = {
      id: eventId,
      type: "price_changed",
      className: item.classname,
      classname: item.classname,
      furniName: item.furni_name,
      hotel,
      oldPrice,
      newPrice,
      diff,
      pct,
      direction: diff > 0 ? "up" : "down",
      detectedAt,
      timestamp: detectedAt,
    };

    try {
      const publishAt = Date.now();
      event.publishAt = publishAt;

      console.log(
        `[Monitor] ${event.className}/${hotel} detectado -> publish: ${publishAt - detectedAt}ms`,
      );

      await redisPublisher.publish(
        "habbip:price_events",
        JSON.stringify(event),
      );
    } catch (err) {
      console.error("[Monitor] Erro ao publicar no Redis:", err.message);
    }

    // Cria notificações no banco para os inscritos (fallback se SSE cair)
    await createNotificationsForSubscribers(item.classname, hotel, event);

    await new Promise((r) => setTimeout(r, ITEM_DELAY_MS));
  }
}

async function createNotificationsForSubscribers(classname, hotel, event) {
  const { rows: subs } = await pool.query(
    `SELECT user_id, alert_config
     FROM user_subscriptions
     WHERE classname = $1
       AND hotel = $2
       AND active = TRUE`,
    [classname, hotel],
  );

  for (const sub of subs) {
    const cfg = sub.alert_config || { alertMode: "any" };
    let shouldNotify = false;

    if (cfg.alertMode === "any") {
      shouldNotify = true;
    } else if (cfg.alertMode === "price" && cfg.targetPrice != null) {
      const margin = cfg.priceMargin ?? 0;
      shouldNotify =
        event.newPrice >= cfg.targetPrice - margin &&
        event.newPrice <= cfg.targetPrice + margin;
    }

    if (!shouldNotify) continue;

    const notif = {
      id: `${classname}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      className: classname,
      classname,
      furniName: event.furniName,
      oldPrice: event.oldPrice,
      newPrice: event.newPrice,
      diff: event.diff,
      pct: event.pct,
      direction: event.direction,
      hotel,
      read: false,
      createdAt: Date.now(),
      source: "background",
      detectedAt: event.detectedAt ?? null,
      publishAt: event.publishAt ?? null,
    };

    await prependNotification(sub.user_id, notif);
  }
}

async function prependNotification(userId, notif) {
  const { rows } = await pool.query(
    `SELECT notifications
     FROM user_data
     WHERE user_id = $1`,
    [userId],
  );

  const current = Array.isArray(rows[0]?.notifications)
    ? rows[0].notifications
    : [];

  const next = [notif, ...current].slice(0, MAX_NOTIFICATIONS);

  await pool.query(
    `UPDATE user_data
     SET notifications = $1::jsonb
     WHERE user_id = $2`,
    [JSON.stringify(next), userId],
  );
}

async function runPriceMonitor() {
  console.log("[Monitor] Ciclo iniciado...");

  const items = await fetchItemsDue();

  if (items.length === 0) {
    console.log("[Monitor] Nenhum item elegível neste ciclo");
    return;
  }

  console.log(`[Monitor] ${items.length} itens a verificar`);

  const byHotel = groupByHotel(items);

  for (const [hotel, hotelItems] of byHotel) {
    await processHotelBatch(hotel, hotelItems);
  }

  console.log("[Monitor] Ciclo concluído");
}

export function startPriceMonitor() {
  console.log(
    `[Monitor] Iniciado — ciclos a cada ${MONITOR_INTERVAL_MS / 1000}s, sem prioridade`,
  );

  runPriceMonitor();
  setInterval(runPriceMonitor, 15 * 1000);
}