const { Pool } = require('pg');

// La configuración se toma de las variables de entorno estándar de pg
// (PGHOST, PGPORT, PGDATABASE, PGUSER, PGPASSWORD), cargadas desde .env.
const pool = new Pool();

pool.on('error', (err) => {
  console.error('Error inesperado en el pool de PostgreSQL:', err);
});

function query(text, params) {
  return pool.query(text, params);
}

module.exports = { pool, query };
