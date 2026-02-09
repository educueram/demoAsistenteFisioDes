const mysql = require('mysql2/promise');
const config = require('../config');

/**
 * Servicio de conexión a MySQL
 * Pool de conexiones para mejor rendimiento
 */

let pool = null;

/**
 * Inicializar pool de conexiones
 */
function initializePool() {
  try {
    if (pool) {
      return pool;
    }

    pool = mysql.createPool({
      host: config.mysql.host,
      port: config.mysql.port,
      user: config.mysql.user,
      password: config.mysql.password,
      database: config.mysql.database,
      waitForConnections: true,
      connectionLimit: 10,
      queueLimit: 0,
      enableKeepAlive: true,
      keepAliveInitialDelay: 0
    });

    console.log('✅ Pool de conexiones MySQL inicializado correctamente');
    return pool;
  } catch (error) {
    console.error('❌ Error inicializando pool MySQL:', error.message);
    throw error;
  }
}

/**
 * Obtener conexión del pool
 */
async function getConnection() {
  try {
    if (!pool) {
      initializePool();
    }
    return await pool.getConnection();
  } catch (error) {
    console.error('❌ Error obteniendo conexión MySQL:', error.message);
    throw error;
  }
}

/**
 * Ejecutar query con parámetros
 */
async function query(sql, params = []) {
  try {
    if (!pool) {
      initializePool();
    }
    const [results] = await pool.execute(sql, params);
    return results;
  } catch (error) {
    console.error('❌ Error ejecutando query MySQL:', error.message);
    console.error('SQL:', sql);
    console.error('Params:', params);
    throw error;
  }
}

/**
 * Ejecutar query sin prepared statements (para queries dinámicas)
 */
async function queryRaw(sql) {
  try {
    if (!pool) {
      initializePool();
    }
    const [results] = await pool.query(sql);
    return results;
  } catch (error) {
    console.error('❌ Error ejecutando query raw MySQL:', error.message);
    console.error('SQL:', sql);
    throw error;
  }
}

/**
 * Verificar conexión a la base de datos
 */
async function testConnection() {
  try {
    if (!pool) {
      initializePool();
    }
    const connection = await pool.getConnection();
    await connection.ping();
    connection.release();
    console.log('✅ Conexión a MySQL verificada correctamente');
    return true;
  } catch (error) {
    console.error('❌ Error verificando conexión MySQL:', error.message);
    return false;
  }
}

/**
 * Cerrar pool de conexiones
 */
async function closePool() {
  try {
    if (pool) {
      await pool.end();
      pool = null;
      console.log('✅ Pool de conexiones MySQL cerrado');
    }
  } catch (error) {
    console.error('❌ Error cerrando pool MySQL:', error.message);
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

