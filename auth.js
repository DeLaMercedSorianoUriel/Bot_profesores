const bcrypt = require('bcrypt');
const db = require('./db');

const SALT_ROUNDS = 12;

// Política mínima de seguridad de contraseña: 8+ caracteres, mayúscula, minúscula, número y símbolo.
const PASSWORD_RULES = [
  { id: 'length', label: 'Al menos 8 caracteres', test: (pw) => pw.length >= 8 },
  { id: 'upper', label: 'Al menos una letra mayúscula', test: (pw) => /[A-Z]/.test(pw) },
  { id: 'lower', label: 'Al menos una letra minúscula', test: (pw) => /[a-z]/.test(pw) },
  { id: 'number', label: 'Al menos un número', test: (pw) => /[0-9]/.test(pw) },
  { id: 'symbol', label: 'Al menos un símbolo (!@#$%^&*...)', test: (pw) => /[^A-Za-z0-9]/.test(pw) }
];

function validatePasswordStrength(password) {
  const failed = PASSWORD_RULES.filter(rule => !rule.test(password || ''));
  return { valid: failed.length === 0, failedRules: failed.map(r => r.label) };
}

async function hashPassword(password) {
  return bcrypt.hash(password, SALT_ROUNDS);
}

async function verifyPassword(password, hash) {
  return bcrypt.compare(password, hash);
}

async function registrarProfesor({
  nombre, apellidoPaterno, apellidoMaterno, numeroCuenta,
  anioNacimiento, mesNacimiento, diaNacimiento, correo, usuario, contrasena
}) {
  const { valid, failedRules } = validatePasswordStrength(contrasena);
  if (!valid) {
    const err = new Error('La contraseña no cumple los requisitos mínimos de seguridad.');
    err.code = 'WEAK_PASSWORD';
    err.failedRules = failedRules;
    throw err;
  }

  const contrasenaHash = await hashPassword(contrasena);

  const result = await db.query(
    `INSERT INTO profesores
      (nombre, apellido_paterno, apellido_materno, numero_cuenta, anio_nacimiento, mes_nacimiento, dia_nacimiento, correo, usuario, contrasena_hash)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     RETURNING id, nombre, apellido_paterno, apellido_materno, usuario, correo`,
    [nombre, apellidoPaterno, apellidoMaterno || null, numeroCuenta, anioNacimiento, mesNacimiento, diaNacimiento, correo, usuario, contrasenaHash]
  );
  return result.rows[0];
}

async function loginProfesor(usuario, contrasena) {
  const result = await db.query(
    `SELECT id, nombre, apellido_paterno, apellido_materno, usuario, contrasena_hash, estado
     FROM profesores WHERE usuario = $1`,
    [usuario]
  );
  const profesor = result.rows[0];
  if (!profesor || profesor.estado !== 'activo') return null;
  const ok = await verifyPassword(contrasena, profesor.contrasena_hash);
  if (!ok) return null;
  delete profesor.contrasena_hash;
  return profesor;
}

// Puede crear el alumno un profesor autenticado (profesorCreadorId presente) o el propio
// alumno mediante auto-registro público (profesorCreadorId = null/undefined). Un alumno
// auto-registrado no queda inscrito en ninguna clase hasta que un profesor lo matricule.
async function registrarAlumno({
  nombre, apellidoPaterno, apellidoMaterno, numeroCuenta,
  anioNacimiento, mesNacimiento, diaNacimiento, usuario, contrasena
}, profesorCreadorId) {
  const { valid, failedRules } = validatePasswordStrength(contrasena);
  if (!valid) {
    const err = new Error('La contraseña no cumple los requisitos mínimos de seguridad.');
    err.code = 'WEAK_PASSWORD';
    err.failedRules = failedRules;
    throw err;
  }

  const contrasenaHash = await hashPassword(contrasena);

  const result = await db.query(
    `INSERT INTO alumnos
      (nombre, apellido_paterno, apellido_materno, numero_cuenta, anio_nacimiento, mes_nacimiento, dia_nacimiento, usuario, contrasena_hash, creado_por_profesor_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     RETURNING id, nombre, apellido_paterno, apellido_materno, usuario, numero_cuenta`,
    [nombre, apellidoPaterno, apellidoMaterno || null, numeroCuenta, anioNacimiento, mesNacimiento, diaNacimiento, usuario, contrasenaHash, profesorCreadorId]
  );
  return result.rows[0];
}

async function loginAlumno(usuario, contrasena) {
  const result = await db.query(
    `SELECT id, nombre, apellido_paterno, apellido_materno, usuario, contrasena_hash, estado
     FROM alumnos WHERE usuario = $1`,
    [usuario]
  );
  const alumno = result.rows[0];
  if (!alumno || alumno.estado !== 'activo') return null;
  const ok = await verifyPassword(contrasena, alumno.contrasena_hash);
  if (!ok) return null;
  delete alumno.contrasena_hash;
  return alumno;
}

// Contraseña del analizador: la define cada profesor para su propio uso (no es la de login)
// y es la que el alumno debe ingresar manualmente en el chat para poder invocar el analizador.
// No usa la política de contraseña de login (es una palabra de activación, no una credencial de cuenta).
async function setAnalizadorPassword(profesorId, contrasena) {
  const limpia = (contrasena || '').trim();
  if (limpia.length < 4) {
    const err = new Error('La contraseña del analizador debe tener al menos 4 caracteres.');
    err.code = 'WEAK_PASSWORD';
    throw err;
  }
  const hash = await hashPassword(limpia);
  await db.query('UPDATE profesores SET analizador_contrasena_hash = $1 WHERE id = $2', [hash, profesorId]);
}

async function verificarAnalizadorPassword(profesorId, contrasena) {
  const result = await db.query('SELECT analizador_contrasena_hash FROM profesores WHERE id = $1', [profesorId]);
  const hash = result.rows[0]?.analizador_contrasena_hash;
  if (!hash) return false;
  return verifyPassword(contrasena || '', hash);
}

async function loginAdmin(usuario, contrasena) {
  const result = await db.query(
    `SELECT id, nombre, usuario, contrasena_hash FROM administradores WHERE usuario = $1`,
    [usuario]
  );
  const admin = result.rows[0];
  if (!admin) return null;
  const ok = await verifyPassword(contrasena, admin.contrasena_hash);
  if (!ok) return null;
  delete admin.contrasena_hash;
  return admin;
}

module.exports = {
  PASSWORD_RULES,
  validatePasswordStrength,
  hashPassword,
  registrarProfesor,
  loginProfesor,
  registrarAlumno,
  loginAlumno,
  loginAdmin,
  setAnalizadorPassword,
  verificarAnalizadorPassword
};
