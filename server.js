require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const { v4: uuidv4 } = require('uuid');
const session = require('express-session');
const path = require('path');
const fs = require('fs');
const os = require('os');
const {
  generateBotResponse,
  formatGeminiResponse,
  saveChatHistoryToFile,
  initializeConversation,
  processUserMessage
} = require('./utils');
const db = require('./db');
const auth = require('./auth');
const analyzer = require('./analyzer');

const app = express();
const port = process.env.PORT || 3000;

// Misma ruta que usa utils.js para guardar los historiales de chat (chat_logs/<profesor>/<entregable>/...)
const chatLogsDir = path.join(__dirname, 'chat_logs');

// Red de seguridad a nivel de proceso: con muchos alumnos conectados simultáneamente, un solo
// error sin capturar (p. ej. una promesa rechazada en una sola petición) no debe tumbar
// el servidor entero y desconectar a todos los demás. Se registra el error y el proceso sigue vivo.
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled Rejection (el servidor continúa activo):', reason);
});
process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception (el servidor continúa activo):', err);
});

// ===================================================================================
// Configuración legacy (prompt único global) — se mantiene solo por compatibilidad
// con /profe y /config-naming. El flujo nuevo usa un prompt independiente por clase
// (columna clases.prompt_examen).
// ===================================================================================
const configFilePath = path.join(__dirname, 'config.json');

function loadConfig() {
  try {
    if (fs.existsSync(configFilePath)) {
      return JSON.parse(fs.readFileSync(configFilePath, 'utf8'));
    }
  } catch (error) {
    console.error('Error al leer config.json:', error);
  }
  return { initialPrompt: '', namingCriteria: { fields: [], order: [], customFormat: '' } };
}

function saveConfig() {
  fs.writeFileSync(configFilePath, JSON.stringify({ initialPrompt: INITIAL_PROMPT, namingCriteria }, null, 2), 'utf8');
}

const savedConfig = loadConfig();
let INITIAL_PROMPT = savedConfig.initialPrompt || '';
let namingCriteria = savedConfig.namingCriteria || { fields: [], order: [], customFormat: '' };

// Historiales de conversación del flujo legacy (un único prompt global)
const conversationHistory = {};
// Historiales de conversación del flujo nuevo (un prompt por clase), separados para no mezclarse
const examConversations = {};
// Validaciones por IP (flujo legacy)
const ipValidations = {};

// ===================================================================================
// Middlewares base
// ===================================================================================
app.use(session({
  secret: process.env.SESSION_SECRET || 'your-secret-key',
  resave: false,
  saveUninitialized: true,
  cookie: { secure: false }
}));
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());

function restrictToLocalhost(req, res, next) {
  const clientIp = req.ip;
  if (clientIp === '::1' || clientIp === '127.0.0.1' || clientIp === '::ffff:127.0.0.1') {
    next();
  } else {
    res.status(403).send('Acceso denegado: esta página solo está disponible desde localhost.');
  }
}

function requireProfesorApi(req, res, next) {
  if (!req.session.profesorId) {
    return res.status(401).json({ error: 'Debes iniciar sesión como profesor.' });
  }
  next();
}

function requireAlumnoApi(req, res, next) {
  if (!req.session.alumnoId) {
    return res.status(401).json({ error: 'Debes iniciar sesión como alumno.' });
  }
  next();
}

function requireAdminApi(req, res, next) {
  if (!req.session.adminId) {
    return res.status(401).json({ error: 'Debes iniciar sesión como administrador.' });
  }
  next();
}

function requireAdminPage(req, res, next) {
  if (!req.session.adminId) {
    return res.redirect('/login-admin.html');
  }
  next();
}

function requireProfesorPage(req, res, next) {
  if (!req.session.profesorId) {
    return res.redirect('/login-profesor.html');
  }
  next();
}

function requireAlumnoPage(req, res, next) {
  if (!req.session.alumnoId) {
    return res.redirect('/login-alumno.html');
  }
  next();
}

async function claseDeProfesor(claseId, profesorId) {
  const result = await db.query('SELECT * FROM clases WHERE id = $1 AND profesor_id = $2', [claseId, profesorId]);
  return result.rows[0] || null;
}

// Verifica que un entregable pertenezca a una clase de este profesor y devuelve
// el entregable junto con el nombre/carpeta de la clase y del profesor.
async function entregableDeProfesor(entregableId, profesorId) {
  const result = await db.query(
    `SELECT e.*, c.nombre AS clase_nombre, p.usuario AS profesor_usuario
     FROM entregables e
     JOIN clases c ON c.id = e.clase_id
     JOIN profesores p ON p.id = c.profesor_id
     WHERE e.id = $1 AND c.profesor_id = $2`,
    [entregableId, profesorId]
  );
  return result.rows[0] || null;
}

// Convierte un texto en un nombre de carpeta/archivo seguro para el sistema de archivos
// (sin acentos, sin caracteres inválidos en Windows, espacios -> guion bajo).
function sanitizeForPath(str) {
  const sinAcentos = String(str || '').normalize('NFD').replace(/[̀-ͯ]/g, '');
  const limpio = sinAcentos.replace(/[\\/:*?"<>|]/g, '').replace(/\s+/g, '_').replace(/^\.+/, '');
  return limpio.slice(0, 80) || 'sin_nombre';
}

// Campos del alumno disponibles para que el profesor arme el nombre del archivo de chat
const CAMPOS_NOMBRADO = {
  nombre: (a) => a.nombre,
  apellidoPaterno: (a) => a.apellido_paterno,
  apellidoMaterno: (a) => a.apellido_materno,
  numeroCuenta: (a) => a.numero_cuenta,
  usuario: (a) => a.usuario
};

// Arma el nombre del archivo de chat según los criterios elegidos por el profesor para ese
// entregable; si no eligió ninguno, usa el usuario del alumno. Siempre agrega una marca de
// tiempo para no sobrescribir intentos anteriores del mismo alumno.
function construirNombreArchivo(criteriosNombrado, alumno) {
  const fields = (criteriosNombrado && Array.isArray(criteriosNombrado.fields)) ? criteriosNombrado.fields : [];
  const partes = fields
    .map((key) => (CAMPOS_NOMBRADO[key] ? CAMPOS_NOMBRADO[key](alumno) : null))
    .filter(Boolean)
    .map(sanitizeForPath);
  const base = partes.length > 0 ? partes.join('_') : sanitizeForPath(alumno.usuario);
  return `${base}_${Date.now()}.txt`;
}

// Convierte el contenido guardado por saveChatHistoryToFile ("Usuario: ...\n\nBot: ...\n\n")
// en una lista de turnos { sender: 'alumno' | 'bot', content } para mostrarlo de forma amigable.
function parseChatLog(content) {
  const chunks = content.split(/\n\n(?=(?:Usuario|Bot):\s)/);
  return chunks
    .map((chunk) => {
      const match = chunk.match(/^(Usuario|Bot):\s([\s\S]*)$/);
      if (!match) return null;
      return { sender: match[1] === 'Usuario' ? 'alumno' : 'bot', content: match[2].trim() };
    })
    .filter(Boolean);
}

// ===================================================================================
// Páginas protegidas (deben resolverse ANTES de express.static, para que el archivo
// estático no se sirva directamente sin pasar por el control de acceso)
// ===================================================================================

// Página principal: ahora es presenta.html (selección de rol), tanto por IP:puerto como localhost
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'presenta.html'));
});

app.get('/profesor-dashboard.html', requireProfesorPage, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'profesor-dashboard.html'));
});

app.get('/alumno-dashboard.html', requireAlumnoPage, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'alumno-dashboard.html'));
});

app.get('/admin-dashboard.html', requireAdminPage, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin-dashboard.html'));
});

// Solo el administrador puede registrar profesores: ya no hay auto-registro público.
app.get('/registro-profesor.html', requireAdminPage, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'registro-profesor.html'));
});

// El chat (index.html) requiere: examen activo (flujo nuevo, por clase) o, en su defecto,
// el flujo legacy basado en student-input.html con un nombre de archivo asignado.
function ensureChatAccess(req, res, next) {
  const isLocal = req.ip === '::1' || req.ip === '127.0.0.1' || req.ip === '::ffff:127.0.0.1';
  if (isLocal) return next();
  if (req.session.examenActivo && req.session.alumnoId) return next();
  if (req.session.customFilename) return next();
  return res.redirect('/presenta.html');
}

app.get('/index.html', ensureChatAccess, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.use(express.static('public', { index: false }));

// ===================================================================================
// Autenticación: Profesor (no existe auto-registro: solo el administrador puede crear profesores)
// ===================================================================================
app.post('/api/profesor/login', async (req, res) => {
  try {
    const { usuario, contrasena } = req.body || {};
    const profesor = await auth.loginProfesor(usuario, contrasena);
    if (!profesor) {
      return res.status(401).json({ error: 'Usuario o contraseña incorrectos.' });
    }
    req.session.profesorId = profesor.id;
    res.json({ profesor });
  } catch (error) {
    console.error('Error en /api/profesor/login:', error);
    res.status(500).json({ error: 'Error técnico al iniciar sesión.' });
  }
});

app.post('/api/profesor/logout', (req, res) => {
  delete req.session.profesorId;
  res.json({ message: 'Sesión cerrada.' });
});

app.get('/api/profesor/me', requireProfesorApi, async (req, res) => {
  try {
    const result = await db.query(
      `SELECT id, nombre, apellido_paterno, apellido_materno, usuario, correo,
              (analizador_contrasena_hash IS NOT NULL) AS analizador_configurado
       FROM profesores WHERE id = $1`,
      [req.session.profesorId]
    );
    res.json({ profesor: result.rows[0] || null });
  } catch (error) {
    console.error('Error en /api/profesor/me:', error);
    res.status(500).json({ error: 'Error técnico.' });
  }
});

// El profesor define (o cambia) su propia contraseña del analizador, distinta de su
// contraseña de inicio de sesión. El alumno nunca puede establecerla: solo la usa para
// desbloquear el analizador en su chat (ver POST /api/analizador/solicitar-ayuda).
app.put('/api/profesor/me/analizador-password', requireProfesorApi, async (req, res) => {
  try {
    const { contrasena } = req.body || {};
    await auth.setAnalizadorPassword(req.session.profesorId, contrasena);
    res.json({ message: 'Contraseña del analizador actualizada.' });
  } catch (error) {
    if (error.code === 'WEAK_PASSWORD') {
      return res.status(400).json({ error: error.message });
    }
    console.error('Error en PUT /api/profesor/me/analizador-password:', error);
    res.status(500).json({ error: 'Error técnico al guardar la contraseña del analizador.' });
  }
});

// ===================================================================================
// Autenticación: Alumno (no existe auto-registro: solo un profesor puede crear alumnos)
// ===================================================================================
// Auto-registro público de alumnos: cualquiera puede crear su cuenta de alumno entrando a la
// página, sin necesitar a un profesor. Hasta que un profesor lo matricule en una clase
// (inscripciones), el alumno no verá ninguna clase, profesor ni calificación: las consultas
// de /api/alumno/clases y /api/alumno/calificaciones solo devuelven filas vinculadas por
// inscripciones/calificaciones, así que un alumno recién registrado siempre parte vacío.
app.post('/api/alumno/registro', async (req, res) => {
  try {
    const alumno = await auth.registrarAlumno(req.body || {}, null);
    req.session.alumnoId = alumno.id;
    res.json({ alumno });
  } catch (error) {
    if (error.code === 'WEAK_PASSWORD') {
      return res.status(400).json({ error: error.message, reglas: error.failedRules });
    }
    if (error.code === '23505') {
      return res.status(409).json({ error: 'El usuario o número de cuenta ya está registrado.' });
    }
    console.error('Error en POST /api/alumno/registro:', error);
    res.status(500).json({ error: 'Error técnico al registrar la cuenta.' });
  }
});

app.post('/api/alumno/login', async (req, res) => {
  try {
    const { usuario, contrasena } = req.body || {};
    const alumno = await auth.loginAlumno(usuario, contrasena);
    if (!alumno) {
      return res.status(401).json({ error: 'Usuario o contraseña incorrectos.' });
    }
    req.session.alumnoId = alumno.id;
    res.json({ alumno });
  } catch (error) {
    console.error('Error en /api/alumno/login:', error);
    res.status(500).json({ error: 'Error técnico al iniciar sesión.' });
  }
});

app.post('/api/alumno/logout', (req, res) => {
  delete req.session.alumnoId;
  delete req.session.examenActivo;
  res.json({ message: 'Sesión cerrada.' });
});

app.get('/api/alumno/me', requireAlumnoApi, async (req, res) => {
  try {
    const result = await db.query(
      'SELECT id, nombre, apellido_paterno, apellido_materno, usuario, numero_cuenta FROM alumnos WHERE id = $1',
      [req.session.alumnoId]
    );
    res.json({ alumno: result.rows[0] || null });
  } catch (error) {
    console.error('Error en /api/alumno/me:', error);
    res.status(500).json({ error: 'Error técnico.' });
  }
});

// ===================================================================================
// API del profesor: clases
// ===================================================================================
app.get('/api/profesor/clases', requireProfesorApi, async (req, res) => {
  try {
    const result = await db.query(
      `SELECT c.id, c.nombre, c.estado, c.creado_en,
              (SELECT COUNT(*) FROM inscripciones i WHERE i.clase_id = c.id)::int AS total_alumnos
       FROM clases c WHERE c.profesor_id = $1 ORDER BY c.creado_en DESC`,
      [req.session.profesorId]
    );
    res.json({ clases: result.rows });
  } catch (error) {
    console.error('Error en GET /api/profesor/clases:', error);
    res.status(500).json({ error: 'Error técnico al obtener las clases.' });
  }
});

app.post('/api/profesor/clases', requireProfesorApi, async (req, res) => {
  try {
    const { nombre, promptExamen } = req.body || {};
    if (!nombre || !nombre.trim()) {
      return res.status(400).json({ error: 'El nombre de la clase es obligatorio.' });
    }
    const result = await db.query(
      `INSERT INTO clases (profesor_id, nombre) VALUES ($1, $2)
       RETURNING id, nombre, estado, creado_en`,
      [req.session.profesorId, nombre.trim()]
    );
    const clase = result.rows[0];
    // Cada clase nueva obtiene automáticamente una primera actividad "Examen" con el prompt
    // que se haya indicado (cada actividad tiene su propio prompt; ya no es uno solo por clase).
    await db.query(
      `INSERT INTO entregables (clase_id, nombre, descripcion, carpeta, prompt_examen)
       VALUES ($1, 'Examen', 'Examen generado por el tutor académico', $2, $3)`,
      [clase.id, sanitizeForPath('Examen'), (promptExamen || '').trim()]
    );
    res.json({ clase });
  } catch (error) {
    console.error('Error en POST /api/profesor/clases:', error);
    res.status(500).json({ error: 'Error técnico al crear la clase.' });
  }
});

app.get('/api/profesor/clases/:claseId', requireProfesorApi, async (req, res) => {
  try {
    const clase = await claseDeProfesor(req.params.claseId, req.session.profesorId);
    if (!clase) return res.status(404).json({ error: 'Clase no encontrada.' });

    const alumnos = await db.query(
      `SELECT a.id, a.nombre, a.apellido_paterno, a.apellido_materno, a.numero_cuenta, a.usuario, i.inscrito_en
       FROM inscripciones i JOIN alumnos a ON a.id = i.alumno_id
       WHERE i.clase_id = $1 ORDER BY a.apellido_paterno, a.nombre`,
      [clase.id]
    );
    const entregables = await db.query(
      `SELECT id, nombre, descripcion, fecha_limite, criterios_nombrado, carpeta, estado, prompt_examen
       FROM entregables WHERE clase_id = $1 ORDER BY id`,
      [clase.id]
    );

    res.json({ clase, alumnos: alumnos.rows, entregables: entregables.rows });
  } catch (error) {
    console.error('Error en GET /api/profesor/clases/:claseId:', error);
    res.status(500).json({ error: 'Error técnico al obtener la clase.' });
  }
});

app.put('/api/profesor/clases/:claseId', requireProfesorApi, async (req, res) => {
  try {
    const clase = await claseDeProfesor(req.params.claseId, req.session.profesorId);
    if (!clase) return res.status(404).json({ error: 'Clase no encontrada.' });

    const { nombre, promptExamen, estado } = req.body || {};
    const result = await db.query(
      `UPDATE clases SET
         nombre = COALESCE(NULLIF($1, ''), nombre),
         prompt_examen = COALESCE($2, prompt_examen),
         estado = COALESCE(NULLIF($3, ''), estado)
       WHERE id = $4
       RETURNING id, nombre, prompt_examen, estado`,
      [nombre, promptExamen, estado, clase.id]
    );
    res.json({ clase: result.rows[0] });
  } catch (error) {
    console.error('Error en PUT /api/profesor/clases/:claseId:', error);
    res.status(500).json({ error: 'Error técnico al actualizar la clase.' });
  }
});

// Registrar un alumno NUEVO y matricularlo automáticamente en la clase.
// Solo el profesor puede ejecutar esta ruta: un alumno nunca puede dar de alta a otro.
app.post('/api/profesor/clases/:claseId/alumnos', requireProfesorApi, async (req, res) => {
  const client = await db.pool.connect();
  try {
    const clase = await claseDeProfesor(req.params.claseId, req.session.profesorId);
    if (!clase) return res.status(404).json({ error: 'Clase no encontrada.' });

    await client.query('BEGIN');

    let alumno;
    try {
      alumno = await auth.registrarAlumno(req.body || {}, req.session.profesorId);
    } catch (error) {
      await client.query('ROLLBACK');
      if (error.code === 'WEAK_PASSWORD') {
        return res.status(400).json({ error: error.message, reglas: error.failedRules });
      }
      if (error.code === '23505') {
        return res.status(409).json({ error: 'El usuario o número de cuenta ya está registrado.' });
      }
      throw error;
    }

    await client.query(
      'INSERT INTO inscripciones (clase_id, alumno_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [clase.id, alumno.id]
    );
    await client.query('COMMIT');
    res.json({ alumno });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('Error en POST /api/profesor/clases/:claseId/alumnos:', error);
    res.status(500).json({ error: 'Error técnico al registrar al alumno.' });
  } finally {
    client.release();
  }
});

// Matricular en esta clase a un alumno YA EXISTENTE (p. ej. que ya toma otra clase con otro profesor)
app.post('/api/profesor/clases/:claseId/inscribir', requireProfesorApi, async (req, res) => {
  try {
    const clase = await claseDeProfesor(req.params.claseId, req.session.profesorId);
    if (!clase) return res.status(404).json({ error: 'Clase no encontrada.' });

    const { numeroCuenta } = req.body || {};
    const alumnoResult = await db.query('SELECT id, nombre, apellido_paterno FROM alumnos WHERE numero_cuenta = $1', [numeroCuenta]);
    const alumno = alumnoResult.rows[0];
    if (!alumno) return res.status(404).json({ error: 'No existe un alumno con ese número de cuenta.' });

    await db.query(
      'INSERT INTO inscripciones (clase_id, alumno_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [clase.id, alumno.id]
    );
    res.json({ alumno });
  } catch (error) {
    console.error('Error en POST /api/profesor/clases/:claseId/inscribir:', error);
    res.status(500).json({ error: 'Error técnico al matricular al alumno.' });
  }
});

// Si un alumno olvida su contraseña, su profesor puede restablecerla (sin necesitar al
// administrador). Solo puede hacerlo si el alumno está inscrito en alguna de sus clases,
// para que un profesor no pueda tocar la cuenta de un alumno ajeno.
app.put('/api/profesor/alumnos/:alumnoId/contrasena', requireProfesorApi, async (req, res) => {
  try {
    const relacion = await db.query(
      `SELECT 1 FROM inscripciones i JOIN clases c ON c.id = i.clase_id
       WHERE i.alumno_id = $1 AND c.profesor_id = $2 LIMIT 1`,
      [req.params.alumnoId, req.session.profesorId]
    );
    if (relacion.rows.length === 0) {
      return res.status(404).json({ error: 'Ese alumno no está inscrito en ninguna de tus clases.' });
    }

    const { contrasena } = req.body || {};
    const { valid, failedRules } = auth.validatePasswordStrength(contrasena);
    if (!valid) {
      return res.status(400).json({ error: 'La contraseña no cumple los requisitos mínimos de seguridad.', reglas: failedRules });
    }
    const hash = await auth.hashPassword(contrasena);
    await db.query('UPDATE alumnos SET contrasena_hash = $1 WHERE id = $2', [hash, req.params.alumnoId]);
    res.json({ message: 'Contraseña actualizada.' });
  } catch (error) {
    console.error('Error en PUT /api/profesor/alumnos/:alumnoId/contrasena:', error);
    res.status(500).json({ error: 'Error técnico al cambiar la contraseña.' });
  }
});

app.post('/api/profesor/clases/:claseId/entregables', requireProfesorApi, async (req, res) => {
  try {
    const clase = await claseDeProfesor(req.params.claseId, req.session.profesorId);
    if (!clase) return res.status(404).json({ error: 'Clase no encontrada.' });

    const { nombre, descripcion, fechaLimite, criteriosNombrado, promptExamen } = req.body || {};
    if (!nombre || !nombre.trim()) {
      return res.status(400).json({ error: 'El nombre de la actividad es obligatorio.' });
    }
    const camposValidos = Object.keys(CAMPOS_NOMBRADO);
    const fields = Array.isArray(criteriosNombrado?.fields)
      ? criteriosNombrado.fields.filter((f) => camposValidos.includes(f))
      : [];
    const carpeta = sanitizeForPath(nombre.trim());
    const result = await db.query(
      `INSERT INTO entregables (clase_id, nombre, descripcion, fecha_limite, carpeta, criterios_nombrado, prompt_examen)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, nombre, descripcion, fecha_limite, carpeta, criterios_nombrado, estado, prompt_examen`,
      [clase.id, nombre.trim(), descripcion || null, fechaLimite || null, carpeta, JSON.stringify({ fields }), (promptExamen || '').trim()]
    );
    res.json({ entregable: result.rows[0] });
  } catch (error) {
    console.error('Error en POST /api/profesor/clases/:claseId/entregables:', error);
    res.status(500).json({ error: 'Error técnico al crear la actividad.' });
  }
});

// Permite al profesor elegir qué campos del alumno (y en qué orden) se usan para nombrar
// los archivos de chat guardados de este entregable. La carpeta en chat_logs/ no cambia
// aunque luego se renombre el entregable, para no perder la referencia a entregas ya guardadas.
app.put('/api/profesor/entregables/:entregableId', requireProfesorApi, async (req, res) => {
  try {
    const entregable = await entregableDeProfesor(req.params.entregableId, req.session.profesorId);
    if (!entregable) return res.status(404).json({ error: 'Entregable no encontrado.' });

    const { nombre, descripcion, fechaLimite, criteriosNombrado, promptExamen } = req.body || {};
    const camposValidos = Object.keys(CAMPOS_NOMBRADO);
    let criteriosJson = null;
    if (criteriosNombrado) {
      const fields = Array.isArray(criteriosNombrado.fields)
        ? criteriosNombrado.fields.filter((f) => camposValidos.includes(f))
        : [];
      criteriosJson = JSON.stringify({ fields });
    }

    const result = await db.query(
      `UPDATE entregables SET
         nombre = COALESCE(NULLIF($1, ''), nombre),
         descripcion = COALESCE($2, descripcion),
         fecha_limite = COALESCE($3, fecha_limite),
         criterios_nombrado = COALESCE($4::jsonb, criterios_nombrado),
         prompt_examen = COALESCE($5, prompt_examen)
       WHERE id = $6
       RETURNING id, nombre, descripcion, fecha_limite, carpeta, criterios_nombrado, estado, prompt_examen`,
      [nombre, descripcion, fechaLimite, criteriosJson, promptExamen, entregable.id]
    );
    res.json({ entregable: result.rows[0] });
  } catch (error) {
    console.error('Error en PUT /api/profesor/entregables/:entregableId:', error);
    res.status(500).json({ error: 'Error técnico al actualizar la actividad.' });
  }
});

// Cambia el estado de una actividad: habilitada (visible y disponible para el alumno),
// pausada (visible pero el alumno no puede iniciarla) o eliminada (oculta para el alumno,
// pero conserva sus calificaciones y entregas ya guardadas — no es un borrado real).
app.put('/api/profesor/entregables/:entregableId/estado', requireProfesorApi, async (req, res) => {
  try {
    const entregable = await entregableDeProfesor(req.params.entregableId, req.session.profesorId);
    if (!entregable) return res.status(404).json({ error: 'Actividad no encontrada.' });

    const { estado } = req.body || {};
    if (!['habilitada', 'pausada', 'eliminada'].includes(estado)) {
      return res.status(400).json({ error: 'Estado inválido.' });
    }

    const result = await db.query(
      `UPDATE entregables SET estado = $1 WHERE id = $2
       RETURNING id, nombre, descripcion, fecha_limite, carpeta, criterios_nombrado, estado, prompt_examen`,
      [estado, entregable.id]
    );
    res.json({ entregable: result.rows[0] });
  } catch (error) {
    console.error('Error en PUT /api/profesor/entregables/:entregableId/estado:', error);
    res.status(500).json({ error: 'Error técnico al cambiar el estado de la actividad.' });
  }
});

// Lista los archivos de chat ya guardados (entregas) para este entregable, en
// chat_logs/<profesorUsuario>/<entregable.carpeta>/, ordenados del más reciente al más antiguo.
app.get('/api/profesor/entregables/:entregableId/entregas', requireProfesorApi, async (req, res) => {
  try {
    const entregable = await entregableDeProfesor(req.params.entregableId, req.session.profesorId);
    if (!entregable) return res.status(404).json({ error: 'Entregable no encontrado.' });

    const dir = path.join(chatLogsDir, sanitizeForPath(entregable.profesor_usuario), entregable.carpeta);
    if (!fs.existsSync(dir)) {
      return res.json({ entregas: [] });
    }
    const entregas = fs.readdirSync(dir)
      .filter((f) => f.toLowerCase().endsWith('.txt'))
      .map((f) => {
        const stat = fs.statSync(path.join(dir, f));
        return { archivo: f, modificadoEn: stat.mtime, tamano: stat.size };
      })
      .sort((a, b) => new Date(b.modificadoEn) - new Date(a.modificadoEn));
    res.json({ entregas });
  } catch (error) {
    console.error('Error en GET /api/profesor/entregables/:entregableId/entregas:', error);
    res.status(500).json({ error: 'Error técnico al listar las entregas.' });
  }
});

// Devuelve el contenido de una entrega ya parseado en turnos { sender, content } para
// mostrarlo de forma amigable (bot en azul, alumno en rojo) en el panel del profesor.
app.get('/api/profesor/entregables/:entregableId/entregas/:archivo', requireProfesorApi, async (req, res) => {
  try {
    const entregable = await entregableDeProfesor(req.params.entregableId, req.session.profesorId);
    if (!entregable) return res.status(404).json({ error: 'Entregable no encontrado.' });

    // El nombre de archivo viene de la URL: se valida que sea un nombre simple (sin
    // separadores de ruta) para impedir un path traversal hacia fuera de la carpeta del entregable.
    const archivo = req.params.archivo;
    if (!/^[^\\/]+\.txt$/i.test(archivo)) {
      return res.status(400).json({ error: 'Nombre de archivo inválido.' });
    }
    const dir = path.join(chatLogsDir, sanitizeForPath(entregable.profesor_usuario), entregable.carpeta);
    const filePath = path.join(dir, archivo);
    if (path.dirname(filePath) !== dir || !fs.existsSync(filePath)) {
      return res.status(404).json({ error: 'Entrega no encontrada.' });
    }
    const contenido = fs.readFileSync(filePath, 'utf8');
    res.json({ archivo, turnos: parseChatLog(contenido) });
  } catch (error) {
    console.error('Error en GET /api/profesor/entregables/:entregableId/entregas/:archivo:', error);
    res.status(500).json({ error: 'Error técnico al leer la entrega.' });
  }
});

app.get('/api/profesor/clases/:claseId/calificaciones', requireProfesorApi, async (req, res) => {
  try {
    const clase = await claseDeProfesor(req.params.claseId, req.session.profesorId);
    if (!clase) return res.status(404).json({ error: 'Clase no encontrada.' });

    const result = await db.query(
      `SELECT a.id AS alumno_id, a.nombre, a.apellido_paterno, a.apellido_materno,
              e.id AS entregable_id, e.nombre AS entregable_nombre,
              c.calificacion, c.origen, c.comentarios
       FROM inscripciones i
       JOIN alumnos a ON a.id = i.alumno_id
       CROSS JOIN entregables e
       LEFT JOIN calificaciones c ON c.alumno_id = a.id AND c.entregable_id = e.id
       WHERE i.clase_id = $1 AND e.clase_id = $1
       ORDER BY a.apellido_paterno, a.nombre, e.id`,
      [clase.id]
    );
    res.json({ filas: result.rows });
  } catch (error) {
    console.error('Error en GET /api/profesor/clases/:claseId/calificaciones:', error);
    res.status(500).json({ error: 'Error técnico al obtener las calificaciones.' });
  }
});

// Captura manual (o corrección) de una calificación por el profesor
app.post('/api/profesor/calificaciones', requireProfesorApi, async (req, res) => {
  try {
    const { entregableId, alumnoId, calificacion, comentarios } = req.body || {};
    const num = Number(calificacion);
    if (Number.isNaN(num) || num < 0 || num > 10) {
      return res.status(400).json({ error: 'La calificación debe ser un número entre 0 y 10.' });
    }

    // Verificar que el entregable pertenezca a una clase de este profesor
    const ownershipCheck = await db.query(
      `SELECT e.id FROM entregables e JOIN clases c ON c.id = e.clase_id
       WHERE e.id = $1 AND c.profesor_id = $2`,
      [entregableId, req.session.profesorId]
    );
    if (ownershipCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Entregable no encontrado.' });
    }

    const result = await db.query(
      `INSERT INTO calificaciones (entregable_id, alumno_id, calificacion, comentarios, origen, registrado_por_profesor_id)
       VALUES ($1, $2, $3, $4, 'manual', $5)
       ON CONFLICT (entregable_id, alumno_id) DO UPDATE SET
         calificacion = EXCLUDED.calificacion,
         comentarios = EXCLUDED.comentarios,
         origen = 'manual',
         registrado_por_profesor_id = EXCLUDED.registrado_por_profesor_id,
         actualizado_en = now()
       RETURNING *`,
      [entregableId, alumnoId, num, comentarios || null, req.session.profesorId]
    );
    res.json({ calificacion: result.rows[0] });
  } catch (error) {
    console.error('Error en POST /api/profesor/calificaciones:', error);
    res.status(500).json({ error: 'Error técnico al guardar la calificación.' });
  }
});

// ===================================================================================
// API del alumno
// ===================================================================================
app.get('/api/alumno/clases', requireAlumnoApi, async (req, res) => {
  try {
    const result = await db.query(
      `SELECT c.id, c.nombre, c.estado, p.nombre AS profesor_nombre, p.apellido_paterno AS profesor_apellido
       FROM inscripciones i
       JOIN clases c ON c.id = i.clase_id
       JOIN profesores p ON p.id = c.profesor_id
       WHERE i.alumno_id = $1
       ORDER BY c.creado_en DESC`,
      [req.session.alumnoId]
    );
    res.json({ clases: result.rows });
  } catch (error) {
    console.error('Error en GET /api/alumno/clases:', error);
    res.status(500).json({ error: 'Error técnico al obtener tus clases.' });
  }
});

// Lista las actividades de una clase visibles para el alumno (oculta las eliminadas). El
// alumno necesita esto porque ahora una clase puede tener varias actividades, cada una con
// su propio prompt y estado (habilitada / pausada / eliminada) definido por el profesor.
app.get('/api/alumno/clases/:claseId/actividades', requireAlumnoApi, async (req, res) => {
  try {
    const inscripcion = await db.query(
      'SELECT 1 FROM inscripciones WHERE clase_id = $1 AND alumno_id = $2',
      [req.params.claseId, req.session.alumnoId]
    );
    if (inscripcion.rows.length === 0) {
      return res.status(403).json({ error: 'No estás inscrito en esta clase.' });
    }

    const result = await db.query(
      `SELECT id, nombre, descripcion, fecha_limite, estado
       FROM entregables
       WHERE clase_id = $1 AND estado IN ('habilitada', 'pausada')
       ORDER BY id`,
      [req.params.claseId]
    );
    res.json({ actividades: result.rows });
  } catch (error) {
    console.error('Error en GET /api/alumno/clases/:claseId/actividades:', error);
    res.status(500).json({ error: 'Error técnico al obtener las actividades.' });
  }
});

app.get('/api/alumno/calificaciones', requireAlumnoApi, async (req, res) => {
  try {
    const result = await db.query(
      `SELECT c.nombre AS clase_nombre, e.nombre AS entregable_nombre, cal.calificacion, cal.origen, cal.actualizado_en
       FROM calificaciones cal
       JOIN entregables e ON e.id = cal.entregable_id
       JOIN clases c ON c.id = e.clase_id
       WHERE cal.alumno_id = $1
       ORDER BY cal.actualizado_en DESC`,
      [req.session.alumnoId]
    );
    res.json({ calificaciones: result.rows });
  } catch (error) {
    console.error('Error en GET /api/alumno/calificaciones:', error);
    res.status(500).json({ error: 'Error técnico al obtener tus calificaciones.' });
  }
});

// Inicia (o reanuda) el chat para una actividad específica de una clase. Ahora una clase puede
// tener varias actividades (antes era un único examen por clase), así que el alumno debe elegir
// cuál quiere hacer desde su panel; aquí solo se valida que pueda entrar a esa en particular.
app.get('/examen/:claseId/:entregableId', requireAlumnoPage, async (req, res) => {
  try {
    const claseId = Number(req.params.claseId);
    const entregableId = Number(req.params.entregableId);
    const inscripcion = await db.query(
      'SELECT 1 FROM inscripciones WHERE clase_id = $1 AND alumno_id = $2',
      [claseId, req.session.alumnoId]
    );
    if (inscripcion.rows.length === 0) {
      return res.status(403).send('No estás inscrito en esta clase.');
    }

    const claseResult = await db.query(
      `SELECT c.*, p.usuario AS profesor_usuario FROM clases c
       JOIN profesores p ON p.id = c.profesor_id
       WHERE c.id = $1`,
      [claseId]
    );
    const clase = claseResult.rows[0];
    if (!clase) return res.status(404).send('Clase no encontrada.');

    const entregableResult = await db.query(
      'SELECT id, nombre, carpeta, criterios_nombrado, estado FROM entregables WHERE id = $1 AND clase_id = $2',
      [entregableId, claseId]
    );
    const entregable = entregableResult.rows[0];
    if (!entregable) return res.status(404).send('Actividad no encontrada.');
    if (entregable.estado !== 'habilitada') {
      return res.status(403).send('Esta actividad no está disponible en este momento (el profesor la pausó o eliminó).');
    }

    const alumnoResult = await db.query(
      'SELECT nombre, apellido_paterno, apellido_materno, numero_cuenta, usuario FROM alumnos WHERE id = $1',
      [req.session.alumnoId]
    );
    const alumno = alumnoResult.rows[0];

    const nombreArchivo = construirNombreArchivo(entregable.criterios_nombrado, alumno);
    const customFilename = path.join(sanitizeForPath(clase.profesor_usuario), entregable.carpeta, nombreArchivo);

    const sesion = await db.query(
      `INSERT INTO sesiones_examen (alumno_id, clase_id, entregable_id, archivo_log)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [req.session.alumnoId, claseId, entregable.id, customFilename]
    );

    req.session.examenActivo = {
      claseId,
      entregableId: entregable.id,
      sesionId: sesion.rows[0].id,
      customFilename
    };
    // Reiniciar el historial de conversación de cualquier intento anterior de esta misma actividad
    delete examConversations[`exam_${req.sessionID}_${entregable.id}`];

    res.redirect('/index.html');
  } catch (error) {
    console.error('Error en GET /examen/:claseId/:entregableId:', error);
    res.status(500).send('Error técnico al iniciar la actividad.');
  }
});

// ===================================================================================
// Chat: ruta inicial y de mensajes — bifurcan entre el flujo nuevo (prompt por clase)
// y el flujo legacy (prompt único global), según lo que haya en la sesión.
// ===================================================================================
app.get('/initial-message', ensureChatAccess, async (req, res) => {
  try {
    if (req.session.examenActivo) {
      const { entregableId, customFilename } = req.session.examenActivo;
      const entregableResult = await db.query('SELECT prompt_examen FROM entregables WHERE id = $1', [entregableId]);
      const promptExamen = entregableResult.rows[0]?.prompt_examen || '';
      const examKey = `exam_${req.sessionID}_${entregableId}`;

      const result = await initializeConversation(examKey, examConversations, promptExamen, customFilename);
      await guardarCalificacionSiAplica(req, result);

      if (result) {
        return res.json({ response: result.response || '', needsApproval: false });
      }
      return res.json({ response: '', needsApproval: false });
    }

    // Flujo legacy
    let sessionId = req.session.sessionId;
    if (!sessionId) {
      sessionId = uuidv4();
      req.session.sessionId = sessionId;
    }
    const clientIp = req.ip;
    const result = await initializeConversation(sessionId, conversationHistory, INITIAL_PROMPT, req.session.customFilename);
    if (!ipValidations[clientIp]) ipValidations[clientIp] = [];
    ipValidations[clientIp].push({ sessionId, timestamp: new Date(), validated: true });

    if (result) {
      res.json({
        response: result.response || result || '',
        needsApproval: result.needsApproval || false,
        analyzerFeedback: result.analyzerFeedback || ''
      });
    } else {
      res.json({ response: '', needsApproval: false });
    }
  } catch (error) {
    console.error('Error en /initial-message:', error);
    res.json({ response: 'Hubo un problema técnico al iniciar la conversación. Por favor, recarga la página.', needsApproval: false });
  }
});

app.post('/chat', ensureChatAccess, async (req, res) => {
  try {
    const userMessage = req.body.message;

    if (req.session.examenActivo) {
      const { entregableId, customFilename } = req.session.examenActivo;
      const examKey = `exam_${req.sessionID}_${entregableId}`;
      if (!examConversations[examKey]) examConversations[examKey] = [];

      const result = await processUserMessage(examKey, userMessage, examConversations[examKey], customFilename);
      await guardarCalificacionSiAplica(req, result);

      return res.json({
        response: result.response,
        needsApproval: result.needsApproval || false,
        taskCompleted: result.calificacionFinal != null
      });
    }

    // Flujo legacy
    let sessionId = req.session.sessionId;
    if (!sessionId) {
      sessionId = uuidv4();
      req.session.sessionId = sessionId;
    }
    if (!conversationHistory[sessionId]) conversationHistory[sessionId] = [];

    const result = await processUserMessage(sessionId, userMessage, conversationHistory[sessionId], req.session.customFilename);
    res.json({
      response: result.response,
      sessionId,
      needsApproval: result.needsApproval || false,
      analyzerFeedback: result.analyzerFeedback || '',
      taskCompleted: result.taskCompleted || false,
      isAnalyzerHelp: result.isAnalyzerHelp || false
    });
  } catch (error) {
    console.error('Error en /chat:', error);
    res.json({
      response: 'Hubo un problema técnico procesando tu mensaje. Por favor, intenta enviarlo de nuevo.',
      needsApproval: false,
      taskCompleted: false,
      isAnalyzerHelp: false
    });
  }
});

// El alumno solicita ayuda del analizador desde un botón dedicado en el chat (ya no por
// palabra clave). Requiere la contraseña del analizador que su profesor definió de antemano;
// el alumno nunca puede definirla ni cambiarla, solo ingresarla para desbloquear esta solicitud.
app.post('/api/analizador/solicitar-ayuda', requireAlumnoApi, async (req, res) => {
  try {
    if (!req.session.examenActivo) {
      return res.status(400).json({ error: 'El analizador solo está disponible durante un examen activo.' });
    }
    const { claseId, entregableId } = req.session.examenActivo;
    const claseResult = await db.query('SELECT profesor_id FROM clases WHERE id = $1', [claseId]);
    const clase = claseResult.rows[0];
    if (!clase) return res.status(404).json({ error: 'Clase no encontrada.' });

    const { contrasena } = req.body || {};
    const ok = await auth.verificarAnalizadorPassword(clase.profesor_id, contrasena);
    if (!ok) {
      return res.status(401).json({ error: 'Contraseña del analizador incorrecta, o tu profesor todavía no la ha configurado.' });
    }

    const examKey = `exam_${req.sessionID}_${entregableId}`;
    const helpResponse = await analyzer.provideAnalyzerHelp(examKey, 'ayuda analizador');
    res.json({ response: formatGeminiResponse(helpResponse) });
  } catch (error) {
    console.error('Error en POST /api/analizador/solicitar-ayuda:', error);
    res.status(500).json({ error: 'Error técnico al solicitar ayuda del analizador.' });
  }
});

// Si el bot acaba de cerrar el examen con una calificación, la guarda automáticamente
// y marca la sesión de examen como finalizada.
async function guardarCalificacionSiAplica(req, result) {
  if (!result || result.calificacionFinal == null || !req.session.examenActivo) return;
  const { entregableId, sesionId } = req.session.examenActivo;
  try {
    await db.query(
      `INSERT INTO calificaciones (entregable_id, alumno_id, calificacion, origen)
       VALUES ($1, $2, $3, 'automatico')
       ON CONFLICT (entregable_id, alumno_id) DO UPDATE SET
         calificacion = EXCLUDED.calificacion,
         origen = 'automatico',
         actualizado_en = now()`,
      [entregableId, req.session.alumnoId, result.calificacionFinal]
    );
    await db.query('UPDATE sesiones_examen SET finalizado_en = now() WHERE id = $1', [sesionId]);
  } catch (error) {
    console.error('Error al guardar la calificación automática:', error);
  }
}

// ===================================================================================
// Autenticación: Administrador
// ===================================================================================
app.post('/api/admin/login', async (req, res) => {
  try {
    const { usuario, contrasena } = req.body || {};
    const admin = await auth.loginAdmin(usuario, contrasena);
    if (!admin) {
      return res.status(401).json({ error: 'Usuario o contraseña incorrectos.' });
    }
    req.session.adminId = admin.id;
    res.json({ admin });
  } catch (error) {
    console.error('Error en /api/admin/login:', error);
    res.status(500).json({ error: 'Error técnico al iniciar sesión.' });
  }
});

app.post('/api/admin/logout', (req, res) => {
  delete req.session.adminId;
  res.json({ message: 'Sesión cerrada.' });
});

app.get('/api/admin/me', requireAdminApi, async (req, res) => {
  try {
    const result = await db.query('SELECT id, nombre, usuario FROM administradores WHERE id = $1', [req.session.adminId]);
    res.json({ admin: result.rows[0] || null });
  } catch (error) {
    console.error('Error en /api/admin/me:', error);
    res.status(500).json({ error: 'Error técnico.' });
  }
});

// ===================================================================================
// API del administrador: alta/baja de profesores y alumnos, y vista de las relaciones
// ===================================================================================
app.get('/api/admin/profesores', requireAdminApi, async (req, res) => {
  try {
    const result = await db.query(
      `SELECT id, nombre, apellido_paterno, apellido_materno, numero_cuenta, estado, correo, usuario, creado_en
       FROM profesores ORDER BY creado_en DESC`
    );
    res.json({ profesores: result.rows });
  } catch (error) {
    console.error('Error en GET /api/admin/profesores:', error);
    res.status(500).json({ error: 'Error técnico al obtener los profesores.' });
  }
});

app.post('/api/admin/profesores', requireAdminApi, async (req, res) => {
  try {
    const profesor = await auth.registrarProfesor(req.body || {});
    res.json({ profesor });
  } catch (error) {
    if (error.code === 'WEAK_PASSWORD') {
      return res.status(400).json({ error: error.message, reglas: error.failedRules });
    }
    if (error.code === '23505') {
      return res.status(409).json({ error: 'El usuario, correo o número de cuenta ya está registrado.' });
    }
    console.error('Error en POST /api/admin/profesores:', error);
    res.status(500).json({ error: 'No se pudo crear la cuenta de profesor.' });
  }
});

app.delete('/api/admin/profesores/:id', requireAdminApi, async (req, res) => {
  try {
    const result = await db.query('DELETE FROM profesores WHERE id = $1 RETURNING id', [req.params.id]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Profesor no encontrado.' });
    res.json({ message: 'Profesor eliminado.' });
  } catch (error) {
    console.error('Error en DELETE /api/admin/profesores/:id:', error);
    res.status(500).json({ error: 'Error técnico al eliminar al profesor.' });
  }
});

// Restablece la contraseña de un profesor que la olvidó: el profesor se lo pide al
// administrador (fuera del sistema, p. ej. en persona o por correo) y el administrador
// la cambia desde aquí.
app.put('/api/admin/profesores/:id/contrasena', requireAdminApi, async (req, res) => {
  try {
    const { contrasena } = req.body || {};
    const { valid, failedRules } = auth.validatePasswordStrength(contrasena);
    if (!valid) {
      return res.status(400).json({ error: 'La contraseña no cumple los requisitos mínimos de seguridad.', reglas: failedRules });
    }
    const hash = await auth.hashPassword(contrasena);
    const result = await db.query(
      'UPDATE profesores SET contrasena_hash = $1 WHERE id = $2 RETURNING id, usuario',
      [hash, req.params.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Profesor no encontrado.' });
    res.json({ message: 'Contraseña actualizada.' });
  } catch (error) {
    console.error('Error en PUT /api/admin/profesores/:id/contrasena:', error);
    res.status(500).json({ error: 'Error técnico al cambiar la contraseña.' });
  }
});

app.get('/api/admin/alumnos', requireAdminApi, async (req, res) => {
  try {
    const result = await db.query(
      `SELECT id, nombre, apellido_paterno, apellido_materno, numero_cuenta, estado, usuario, creado_en
       FROM alumnos ORDER BY creado_en DESC`
    );
    res.json({ alumnos: result.rows });
  } catch (error) {
    console.error('Error en GET /api/admin/alumnos:', error);
    res.status(500).json({ error: 'Error técnico al obtener los alumnos.' });
  }
});

app.post('/api/admin/alumnos', requireAdminApi, async (req, res) => {
  try {
    const alumno = await auth.registrarAlumno(req.body || {}, null);
    res.json({ alumno });
  } catch (error) {
    if (error.code === 'WEAK_PASSWORD') {
      return res.status(400).json({ error: error.message, reglas: error.failedRules });
    }
    if (error.code === '23505') {
      return res.status(409).json({ error: 'El usuario o número de cuenta ya está registrado.' });
    }
    console.error('Error en POST /api/admin/alumnos:', error);
    res.status(500).json({ error: 'No se pudo crear la cuenta de alumno.' });
  }
});

app.delete('/api/admin/alumnos/:id', requireAdminApi, async (req, res) => {
  try {
    const result = await db.query('DELETE FROM alumnos WHERE id = $1 RETURNING id', [req.params.id]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Alumno no encontrado.' });
    res.json({ message: 'Alumno eliminado.' });
  } catch (error) {
    console.error('Error en DELETE /api/admin/alumnos/:id:', error);
    res.status(500).json({ error: 'Error técnico al eliminar al alumno.' });
  }
});

// El administrador también puede restablecer la contraseña de cualquier alumno que la olvidó.
app.put('/api/admin/alumnos/:id/contrasena', requireAdminApi, async (req, res) => {
  try {
    const { contrasena } = req.body || {};
    const { valid, failedRules } = auth.validatePasswordStrength(contrasena);
    if (!valid) {
      return res.status(400).json({ error: 'La contraseña no cumple los requisitos mínimos de seguridad.', reglas: failedRules });
    }
    const hash = await auth.hashPassword(contrasena);
    const result = await db.query(
      'UPDATE alumnos SET contrasena_hash = $1 WHERE id = $2 RETURNING id, usuario',
      [hash, req.params.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Alumno no encontrado.' });
    res.json({ message: 'Contraseña actualizada.' });
  } catch (error) {
    console.error('Error en PUT /api/admin/alumnos/:id/contrasena:', error);
    res.status(500).json({ error: 'Error técnico al cambiar la contraseña.' });
  }
});

app.get('/api/admin/clases', requireAdminApi, async (req, res) => {
  try {
    const result = await db.query(
      `SELECT c.id, c.nombre, c.estado, c.creado_en,
              p.nombre AS profesor_nombre, p.apellido_paterno AS profesor_apellido,
              (SELECT COUNT(*) FROM inscripciones i WHERE i.clase_id = c.id)::int AS total_alumnos
       FROM clases c JOIN profesores p ON p.id = c.profesor_id
       ORDER BY c.creado_en DESC`
    );
    res.json({ clases: result.rows });
  } catch (error) {
    console.error('Error en GET /api/admin/clases:', error);
    res.status(500).json({ error: 'Error técnico al obtener las clases.' });
  }
});

app.get('/api/admin/inscripciones', requireAdminApi, async (req, res) => {
  try {
    const result = await db.query(
      `SELECT i.id, a.nombre AS alumno_nombre, a.apellido_paterno AS alumno_apellido,
              c.nombre AS clase_nombre, p.nombre AS profesor_nombre, p.apellido_paterno AS profesor_apellido,
              i.inscrito_en
       FROM inscripciones i
       JOIN alumnos a ON a.id = i.alumno_id
       JOIN clases c ON c.id = i.clase_id
       JOIN profesores p ON p.id = c.profesor_id
       ORDER BY i.inscrito_en DESC`
    );
    res.json({ inscripciones: result.rows });
  } catch (error) {
    console.error('Error en GET /api/admin/inscripciones:', error);
    res.status(500).json({ error: 'Error técnico al obtener las inscripciones.' });
  }
});

app.get('/api/admin/calificaciones', requireAdminApi, async (req, res) => {
  try {
    const result = await db.query(
      `SELECT cal.id, a.nombre AS alumno_nombre, a.apellido_paterno AS alumno_apellido,
              c.nombre AS clase_nombre, e.nombre AS entregable_nombre,
              cal.calificacion, cal.origen, cal.actualizado_en
       FROM calificaciones cal
       JOIN alumnos a ON a.id = cal.alumno_id
       JOIN entregables e ON e.id = cal.entregable_id
       JOIN clases c ON c.id = e.clase_id
       ORDER BY cal.actualizado_en DESC`
    );
    res.json({ calificaciones: result.rows });
  } catch (error) {
    console.error('Error en GET /api/admin/calificaciones:', error);
    res.status(500).json({ error: 'Error técnico al obtener las calificaciones.' });
  }
});

// ===================================================================================
// Legacy: configuración del profesor con prompt único global (se mantiene por compatibilidad)
// ===================================================================================
app.get('/profe', restrictToLocalhost, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'config-naming.html'));
});

app.post('/update-prompt', restrictToLocalhost, (req, res) => {
  const newPrompt = req.body.prompt?.trim();
  if (!newPrompt) {
    return res.status(400).json({ error: 'El prompt no puede estar vacío.' });
  }
  INITIAL_PROMPT = newPrompt;
  saveConfig();
  res.json({ message: 'Prompt inicial actualizado correctamente.' });
});

app.get('/analyzer-status/:sessionId', restrictToLocalhost, (req, res) => {
  const analyzer = require('./analyzer');
  const state = analyzer.getAnalyzerState(req.params.sessionId);
  res.json(state || { message: 'No hay estado para esta sesión' });
});

app.get('/ip-stats', restrictToLocalhost, (req, res) => {
  const stats = {};
  for (const ip in ipValidations) {
    stats[ip] = {
      totalSessions: ipValidations[ip].length,
      lastAccess: ipValidations[ip][ipValidations[ip].length - 1].timestamp
    };
  }
  res.json(stats);
});

app.get('/config-naming', restrictToLocalhost, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'config-naming.html'));
});

app.post('/save-naming-criteria', restrictToLocalhost, (req, res) => {
  const { fields, order, customFormat } = req.body;
  namingCriteria.fields = Array.isArray(fields) ? fields : [fields];
  namingCriteria.order = Array.isArray(order) ? order : [order];
  namingCriteria.customFormat = customFormat || '';
  saveConfig();
  res.json({ message: 'Criterios de nombrado guardados correctamente.' });
});

app.get('/get-naming-criteria', (req, res) => {
  res.json(namingCriteria.fields);
});

app.get('/student-input', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'student-input.html'));
});

app.post('/submit-student-data', (req, res) => {
  const studentData = req.body;
  const filenameParts = namingCriteria.fields.map(field => studentData[field] ? studentData[field].replace(/\s+/g, '') : 'unknown');
  const customFilename = filenameParts.join('_') + '.txt';
  req.session.customFilename = customFilename;
  res.redirect('/chat_logs');
});

// ===================================================================================
// Arranque del servidor
// ===================================================================================
// Nombres de adaptadores que NO sirven para que otros dispositivos de la misma red (p. ej.
// los alumnos por Wi-Fi) se conecten: redes virtuales de VMs, VPNs, WSL, etc. Aunque Node los
// reporte como "no internos", solo son alcanzables desde la propia máquina (o sus VMs).
const ADAPTADOR_VIRTUAL_RE = /vmware|virtualbox|vbox|hyper-v|vethernet|virtual ethernet|tailscale|wireguard|zerotier|wsl|loopback|ppp|npcap|tap-/i;

// Devuelve TODAS las IPv4 "reales" (no internas, no de adaptadores virtuales) de la máquina,
// para mostrarlas todas en el arranque: con varios adaptadores (Wi-Fi, Ethernet, VMs, etc.) no
// hay forma fiable de adivinar cuál es la red real del salón de clase, así que se listan todas
// y el profesor elige la que corresponda a la red en la que están los alumnos.
function getServerIps() {
  const interfaces = os.networkInterfaces();
  const candidatas = [];
  for (const ifaceName in interfaces) {
    if (ADAPTADOR_VIRTUAL_RE.test(ifaceName)) continue;
    for (const addr of interfaces[ifaceName]) {
      if (addr.family === 'IPv4' && !addr.internal) {
        candidatas.push({ nombre: ifaceName, ip: addr.address });
      }
    }
  }
  return candidatas;
}

app.listen(port, '0.0.0.0', () => {
  const ips = getServerIps();
  if (ips.length === 0) {
    console.log(`Server listening at http://localhost:${port}/ (no se detectó ninguna IP de red local; revisa tu adaptador Wi-Fi/Ethernet)`);
  } else if (ips.length === 1) {
    console.log(`Server listening at http://${ips[0].ip}:${port}/`);
  } else {
    console.log('Server listening — varias redes detectadas, usa la IP del adaptador por el que se conectan los alumnos (normalmente Wi-Fi o Ethernet):');
    ips.forEach(({ nombre, ip }) => console.log(`  - ${nombre}: http://${ip}:${port}/`));
  }
  console.log(`Página principal: http://localhost:${port}/`);
});
