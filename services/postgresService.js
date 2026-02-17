const { Pool } = require('pg');
const config = require('../config');

let pool = null;

function initializePool() {
  try {
    if (pool) return pool;

    const { host, port, user, database, password } = config.postgres;
    if (!host || !user || !database || !password) {
      throw new Error('Faltan variables de PostgreSQL en .env: PGHOST, PGUSER/POSTGRES_USER, POSTGRES_DB, POSTGRES_PASSWORD');
    }

    pool = new Pool({
      host,
      port: port || 5432,
      user,
      database,
      password,
      max: 10,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 10000
    });

    console.log('✅ Pool de conexiones PostgreSQL inicializado correctamente');
    return pool;
  } catch (error) {
    console.error('❌ Error inicializando pool PostgreSQL:', error.message);
    throw error;
  }
}

async function getConnection() {
  try {
    if (!pool) initializePool();
    return await pool.connect();
  } catch (error) {
    console.error('❌ Error obteniendo conexión PostgreSQL:', error.message);
    throw error;
  }
}

async function query(sql, params = []) {
  try {
    if (!pool) initializePool();
    const result = await pool.query(sql, params);
    return { rows: result.rows, rowCount: result.rowCount };
  } catch (error) {
    console.error('❌ Error ejecutando query PostgreSQL:', error.message);
    console.error('SQL:', sql);
    console.error('Params:', params);
    throw error;
  }
}

async function queryRaw(sql) {
  try {
    if (!pool) initializePool();
    const result = await pool.query(sql);
    return { rows: result.rows, rowCount: result.rowCount };
  } catch (error) {
    console.error('❌ Error ejecutando query raw PostgreSQL:', error.message);
    console.error('SQL:', sql);
    throw error;
  }
}

async function testConnection() {
  try {
    if (!pool) initializePool();
    const client = await pool.connect();
    await client.query('SELECT 1');
    client.release();
    console.log('✅ Conexión a PostgreSQL verificada correctamente');
    return true;
  } catch (error) {
    console.error('❌ Error verificando conexión PostgreSQL:', error.message);
    return false;
  }
}

async function closePool() {
  try {
    if (pool) {
      await pool.end();
      pool = null;
      console.log('✅ Pool de conexiones PostgreSQL cerrado');
    }
  } catch (error) {
    console.error('❌ Error cerrando pool PostgreSQL:', error.message);
  }
}

module.exports = {
  initializePool,
  getConnection,
  query,
  queryRaw,
  testConnection,
  closePool
};
