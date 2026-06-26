// Helper de configuracion: aplica el esquema SQL y crea la cuenta de administrador.
// Es llamado por setup.ps1 despues de que npm install y la BD ya estan listos.
// Recibe las credenciales del admin via variables de entorno SETUP_ADMIN_*.

require('dotenv').config();
const fs   = require('fs');
const path = require('path');
const { Pool } = require('pg');
const bcrypt   = require('bcrypt');

async function main() {
  const pool = new Pool();

  try {
    await pool.query('SELECT 1');
  } catch (err) {
    console.error('No se pudo conectar a PostgreSQL:', err.message);
    console.error('Verifica que PGHOST, PGPORT, PGDATABASE, PGUSER y PGPASSWORD esten bien en .env');
    process.exit(1);
  }

  // ── Aplicar esquema ──────────────────────────────────────────────────────
  console.log('[1/2] Aplicando esquema de tablas...');
  const schemaPath = path.join(__dirname, 'db', 'schema.sql');
  const schema = fs.readFileSync(schemaPath, 'utf8');

  // Otorgar privilegios al usuario de la app sobre las tablas recien creadas
  const grantSql = `
    GRANT ALL PRIVILEGES ON ALL TABLES    IN SCHEMA public TO "${process.env.PGUSER}";
    GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO "${process.env.PGUSER}";
    ALTER DEFAULT PRIVILEGES IN SCHEMA public
      GRANT ALL ON TABLES    TO "${process.env.PGUSER}";
    ALTER DEFAULT PRIVILEGES IN SCHEMA public
      GRANT ALL ON SEQUENCES TO "${process.env.PGUSER}";
  `;

  try {
    await pool.query(schema);
    await pool.query(grantSql);
    console.log('      Tablas creadas y permisos aplicados.');
  } catch (err) {
    console.error('Error al aplicar el esquema:', err.message);
    await pool.end();
    process.exit(1);
  }

  // ── Crear administrador ──────────────────────────────────────────────────
  console.log('[2/2] Creando cuenta de administrador...');
  const adminUsuario = process.env.SETUP_ADMIN_USER;
  const adminPass    = process.env.SETUP_ADMIN_PASS;
  const adminNombre  = process.env.SETUP_ADMIN_NOMBRE;

  if (!adminUsuario || !adminPass) {
    console.error('Faltan SETUP_ADMIN_USER o SETUP_ADMIN_PASS. No se creo el admin.');
    await pool.end();
    process.exit(1);
  }

  const hash = await bcrypt.hash(adminPass, 12);

  await pool.query(
    `INSERT INTO administradores (nombre, usuario, contrasena_hash)
     VALUES ($1, $2, $3)
     ON CONFLICT (usuario) DO UPDATE SET contrasena_hash = EXCLUDED.contrasena_hash`,
    [adminNombre || 'Administrador General', adminUsuario, hash]
  );
  console.log(`      Administrador '${adminUsuario}' listo.`);

  await pool.end();
}

main().catch(err => {
  console.error('Error inesperado en setup-db.js:', err.message);
  process.exit(1);
});
