// jobs/priceMonitor.js — Worker sem prioridade, todos os itens no mesmo intervalo

import crypto from "node:crypto";
import { fetchOfficialMarketBatchSafe } from "../services/habboApi.js";
import { pool } from "../db.js";
import { redisPublisher } from "../services/redis.js";

const ITEM_DELAY_MS = 300;
const MAX_NOTIFICATIONS = 50;
const MONITOR_INTERVAL_MS = 30 * 1000;

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

    // Primeira detecção — publica evento mas sem diff/notificação
    if (oldPrice == null) {
      const event = {
        id: crypto.randomUUID(),
        type: "price_changed",
        className: item.classname,
        classname: item.classname,
        furniName: item.furni_name,
        hotel,
        oldPrice: null,
        newPrice,
        diff: 0,
        pct: 0,
        direction: "up",
        detectedAt: Date.now(),
        timestamp: Date.now(),
      };

      try {
        await redisPublisher.publish(
          "habbip:price_events",
          JSON.stringify(event),
        );
        console.log(`[Monitor] ${item.classname}/${hotel} primeira detecção: ${newPrice}`);
      } catch (err) {
        console.error("[Monitor] Erro ao publicar primeira detecção:", err.message);
      }

      continue;
    }

    // Preço não mudou — nada a fazer
    if (oldPrice === newPrice) continue;

    // Preço mudou — salva histórico e notifica
    await pool.query(
      `INSERT INTO price_history (classname, hotel, price)
       VALUES ($1, $2, $3)`,
      [item.classname, hotel, newPrice],
    );

    const diff = newPrice - oldPrice;
    const pct = parseFloat(((diff / oldPrice) * 100).toFixed(1));
    const detectedAt = Date.now();
    const eventId = crypto.randomUUID();

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

      // Cria notificações no banco para os inscritos (fallback se SSE cair)
      await createNotificationsForSubscribers(item.classname, hotel, event);

      await redisPublisher.publish(
        "habbip:price_events",
        JSON.stringify(event),
      );
      
    } catch (err) {
      console.error("[Monitor] Erro ao publicar no Redis:", err.message);
    }

    await new Promise((r) => setTimeout(r, ITEM_DELAY_MS));
  }
}

// Substitua createNotificationsForSubscribers inteira

async function createNotificationsForSubscribers(classname, hotel, event) {
  const { rows: subs } = await pool.query(
    `SELECT user_id, alert_config
     FROM user_subscriptions
     WHERE classname = $1 AND hotel = $2 AND active = TRUE`,
    [classname, hotel]
  )

  // Filtra quem deve receber a notificação
  const eligibleUserIds = subs
    .filter((sub) => {
      const cfg = sub.alert_config || { alertMode: "any" }
      if (cfg.alertMode === "any") return true
      if (cfg.alertMode === "price" && cfg.targetPrice != null) {
        const margin = cfg.priceMargin ?? 0
        return (
          event.newPrice >= cfg.targetPrice - margin &&
          event.newPrice <= cfg.targetPrice + margin
        )
      }
      return false
    })
    .map((sub) => sub.user_id)

  if (eligibleUserIds.length === 0) return

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
  }

  const notifJson = JSON.stringify(notif)

  // Um único UPDATE para todos os usuários elegíveis de uma vez
  await pool.query(
    `UPDATE user_data
     SET notifications = (
       SELECT jsonb_agg(elem)
       FROM (
         SELECT elem
         FROM jsonb_array_elements(
           jsonb_build_array($1::jsonb) || COALESCE(notifications, '[]'::jsonb)
         ) AS elem
         LIMIT $3
       ) sub
     )
     WHERE user_id = ANY($2::int[])`,
    [notifJson, eligibleUserIds, MAX_NOTIFICATIONS]
  )
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

let monitorRunning = false

async function runLoop() {
  if (monitorRunning) {
    console.warn("[Monitor] Ciclo anterior ainda em execução, pulando.")
    setTimeout(runLoop, MONITOR_INTERVAL_MS)
    return
  }

  monitorRunning = true
  try {
    await runPriceMonitor()
  } catch (err) {
    console.error("[Monitor] Erro não tratado no ciclo:", err.message)
  } finally {
    monitorRunning = false
    setTimeout(runLoop, MONITOR_INTERVAL_MS)
  }
}

export function startPriceMonitor() {
  console.log(
    `[Monitor] Iniciado — ciclos encadeados com intervalo de ${MONITOR_INTERVAL_MS / 1000}s após cada execução`,
  )
  runLoop()
}