import pg from "pg"

const { Pool } = pg

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : false,
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
})

pool.on("error", (err) => {
  console.error("Erro inesperado no pool do PostgreSQL:", err)
})

export async function initDb() {
  const client = await pool.connect()
  try {
    await client.query("BEGIN")

    // habbo_nick é o login único — sem username separado
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id            SERIAL PRIMARY KEY,
        habbo_nick    VARCHAR(64) NOT NULL UNIQUE,
        password_hash VARCHAR(255) NOT NULL,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `)

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_users_habbo_nick_lower
      ON users (LOWER(habbo_nick))
    `)

    await client.query(`
      CREATE TABLE IF NOT EXISTS refresh_tokens (
        id         SERIAL PRIMARY KEY,
        user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        token_hash VARCHAR(255) NOT NULL UNIQUE,
        expires_at TIMESTAMPTZ NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `)

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
    `)

    await client.query(`
      CREATE OR REPLACE FUNCTION update_updated_at()
      RETURNS TRIGGER AS $$
      BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
      $$ LANGUAGE plpgsql
    `)
    await client.query(`
      DROP TRIGGER IF EXISTS trg_users_updated_at ON users;
      CREATE TRIGGER trg_users_updated_at
        BEFORE UPDATE ON users
        FOR EACH ROW EXECUTE FUNCTION update_updated_at()
    `)
    await client.query(`
      DROP TRIGGER IF EXISTS trg_user_data_updated_at ON user_data;
      CREATE TRIGGER trg_user_data_updated_at
        BEFORE UPDATE ON user_data
        FOR EACH ROW EXECUTE FUNCTION update_updated_at()
    `)

    await client.query("COMMIT")
    console.log("✅ Banco de dados inicializado")
  } catch (err) {
    await client.query("ROLLBACK")
    throw err
  } finally {
    client.release()
  }
}