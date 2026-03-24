import pg from "pg";

const { Pool } = pg;

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl:
    process.env.NODE_ENV === "production"
      ? { rejectUnauthorized: false }
      : false,
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

pool.on("error", (err) => {
  console.error("Erro inesperado no pool do PostgreSQL:", err);
});

export async function initDb() {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // habbo_nick é o login único — sem username separado
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id            SERIAL PRIMARY KEY,
        habbo_nick    VARCHAR(64) NOT NULL UNIQUE,
        password_hash VARCHAR(255) NOT NULL,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_users_habbo_nick_lower
      ON users (LOWER(habbo_nick))
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS refresh_tokens (
        id         SERIAL PRIMARY KEY,
        user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        token_hash VARCHAR(255) NOT NULL UNIQUE,
        expires_at TIMESTAMPTZ NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS user_data (
        user_id         INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        inventory       JSONB NOT NULL DEFAULT '[]',
        watchlist       JSONB NOT NULL DEFAULT '[]',
        settings        JSONB NOT NULL DEFAULT '{}',
        mobi_history    JSONB NOT NULL DEFAULT '{"history":[],"favorites":[]}',
        user_history    JSONB NOT NULL DEFAULT '{"history":[],"favorites":[]}',
        inv_history     JSONB NOT NULL DEFAULT '{"history":[],"favorites":[]}',
        notifications   JSONB NOT NULL DEFAULT '[]',
        updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE OR REPLACE FUNCTION update_updated_at()
      RETURNS TRIGGER AS $$
      BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
      $$ LANGUAGE plpgsql
    `);
    await client.query(`
      DROP TRIGGER IF EXISTS trg_users_updated_at ON users;
      CREATE TRIGGER trg_users_updated_at
        BEFORE UPDATE ON users
        FOR EACH ROW EXECUTE FUNCTION update_updated_at()
    `);
    await client.query(`
      DROP TRIGGER IF EXISTS trg_user_data_updated_at ON user_data;
      CREATE TRIGGER trg_user_data_updated_at
        BEFORE UPDATE ON user_data
        FOR EACH ROW EXECUTE FUNCTION update_updated_at()
    `);

    // monitored_items: cada item único sendo monitorado globalmente
    await client.query(`
  CREATE TABLE IF NOT EXISTS monitored_items (
    id                SERIAL PRIMARY KEY,
    classname         VARCHAR(128) NOT NULL,
    hotel             VARCHAR(8) NOT NULL DEFAULT 'br',
    furni_name        VARCHAR(256),
    furni_type        VARCHAR(16) NOT NULL DEFAULT 'roomItem',
    subscriber_count  INTEGER NOT NULL DEFAULT 0,
    priority          SMALLINT NOT NULL DEFAULT 2,
    -- 1 = alta (>10 subs ou mudou recente), 2 = média, 3 = baixa
    last_checked_at   TIMESTAMPTZ,
    last_known_price  INTEGER,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(classname, hotel)
  )
`);

    await client.query(`
  CREATE INDEX IF NOT EXISTS idx_monitored_items_priority
  ON monitored_items (priority, last_checked_at ASC NULLS FIRST)
`);

    // market_prices: cache central de preços (uma linha por item)
    await client.query(`
  CREATE TABLE IF NOT EXISTS market_prices (
    id              SERIAL PRIMARY KEY,
    classname       VARCHAR(128) NOT NULL,
    hotel           VARCHAR(8) NOT NULL DEFAULT 'br',
    current_price   INTEGER,
    average_price   INTEGER,
    open_offers     INTEGER,
    market_data     JSONB,
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(classname, hotel)
  )
`);

    // price_history: histórico de preços detectados pelo worker
    await client.query(`
  CREATE TABLE IF NOT EXISTS price_history (
    id          BIGSERIAL PRIMARY KEY,
    classname   VARCHAR(128) NOT NULL,
    hotel       VARCHAR(8) NOT NULL DEFAULT 'br',
    price       INTEGER NOT NULL,
    recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )
`);

    await client.query(`
  CREATE INDEX IF NOT EXISTS idx_price_history_item
  ON price_history (classname, hotel, recorded_at DESC)
`);

    // user_subscriptions: substitui watchlist em user_data
    // (mantemos user_data.watchlist por compatibilidade, mas esta é a fonte de verdade)
    await client.query(`
  CREATE TABLE IF NOT EXISTS user_subscriptions (
    id           SERIAL PRIMARY KEY,
    user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    classname    VARCHAR(128) NOT NULL,
    hotel        VARCHAR(8) NOT NULL DEFAULT 'br',
    furni_name   VARCHAR(256),
    furni_type   VARCHAR(16) NOT NULL DEFAULT 'roomItem',
    alert_config JSONB NOT NULL DEFAULT '{"alertMode":"any","targetPrice":null,"priceMargin":null}',
    base_price   INTEGER,
    active       BOOLEAN NOT NULL DEFAULT TRUE,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(user_id, classname, hotel)
  )
`);

    await client.query(`
  CREATE INDEX IF NOT EXISTS idx_user_subs_user
  ON user_subscriptions (user_id) WHERE active = TRUE
`);

    await client.query("COMMIT");
    console.log("✅ Banco de dados inicializado");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
