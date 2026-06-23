-- Esquema de la base de datos "educacion"
-- Ejecutar con: psql -U app_educacion -h 127.0.0.1 -d educacion -f db/schema.sql

BEGIN;

-- =========================
-- ADMINISTRADORES (único rol que puede dar de alta/baja profesores y alumnos)
-- =========================
CREATE TABLE IF NOT EXISTS administradores (
  id SERIAL PRIMARY KEY,
  nombre VARCHAR(100) NOT NULL DEFAULT 'Administrador',
  usuario VARCHAR(50) NOT NULL UNIQUE,
  contrasena_hash VARCHAR(100) NOT NULL,
  creado_en TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- =========================
-- PROFESORES
-- =========================
CREATE TABLE IF NOT EXISTS profesores (
  id SERIAL PRIMARY KEY,
  nombre VARCHAR(100) NOT NULL,
  apellido_paterno VARCHAR(100) NOT NULL,
  apellido_materno VARCHAR(100),
  numero_cuenta VARCHAR(30) NOT NULL UNIQUE,
  estado VARCHAR(10) NOT NULL DEFAULT 'activo' CHECK (estado IN ('activo', 'inactivo')),
  anio_nacimiento SMALLINT NOT NULL CHECK (anio_nacimiento BETWEEN 1900 AND 2100),
  mes_nacimiento SMALLINT NOT NULL CHECK (mes_nacimiento BETWEEN 1 AND 12),
  dia_nacimiento SMALLINT NOT NULL CHECK (dia_nacimiento BETWEEN 1 AND 31),
  correo VARCHAR(150) NOT NULL UNIQUE,
  usuario VARCHAR(50) NOT NULL UNIQUE,
  contrasena_hash VARCHAR(100) NOT NULL,
  -- Contraseña propia (distinta de la de inicio de sesión) que el profesor define para
  -- desbloquear el analizador en el chat de sus alumnos. NULL hasta que el profesor la configure.
  analizador_contrasena_hash VARCHAR(100),
  creado_en TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- =========================
-- ALUMNOS
-- =========================
CREATE TABLE IF NOT EXISTS alumnos (
  id SERIAL PRIMARY KEY,
  nombre VARCHAR(100) NOT NULL,
  apellido_paterno VARCHAR(100) NOT NULL,
  apellido_materno VARCHAR(100),
  numero_cuenta VARCHAR(30) NOT NULL UNIQUE,
  estado VARCHAR(10) NOT NULL DEFAULT 'activo' CHECK (estado IN ('activo', 'inactivo')),
  anio_nacimiento SMALLINT NOT NULL CHECK (anio_nacimiento BETWEEN 1900 AND 2100),
  mes_nacimiento SMALLINT NOT NULL CHECK (mes_nacimiento BETWEEN 1 AND 12),
  dia_nacimiento SMALLINT NOT NULL CHECK (dia_nacimiento BETWEEN 1 AND 31),
  usuario VARCHAR(50) NOT NULL UNIQUE,
  contrasena_hash VARCHAR(100) NOT NULL,
  creado_por_profesor_id INTEGER REFERENCES profesores(id) ON DELETE SET NULL,
  creado_en TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- =========================
-- CLASES (cada clase pertenece a un profesor y tiene su propio prompt de examen)
-- =========================
CREATE TABLE IF NOT EXISTS clases (
  id SERIAL PRIMARY KEY,
  profesor_id INTEGER NOT NULL REFERENCES profesores(id) ON DELETE CASCADE,
  nombre VARCHAR(150) NOT NULL,
  prompt_examen TEXT NOT NULL DEFAULT '',
  criterios_nombrado JSONB NOT NULL DEFAULT '{"fields": [], "order": [], "customFormat": ""}'::jsonb,
  estado VARCHAR(10) NOT NULL DEFAULT 'activa' CHECK (estado IN ('activa', 'inactiva')),
  creado_en TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_clases_profesor ON clases(profesor_id);

-- =========================
-- INSCRIPCIONES (relación muchos a muchos alumno <-> clase)
-- =========================
CREATE TABLE IF NOT EXISTS inscripciones (
  id SERIAL PRIMARY KEY,
  clase_id INTEGER NOT NULL REFERENCES clases(id) ON DELETE CASCADE,
  alumno_id INTEGER NOT NULL REFERENCES alumnos(id) ON DELETE CASCADE,
  inscrito_en TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (clase_id, alumno_id)
);

CREATE INDEX IF NOT EXISTS idx_inscripciones_alumno ON inscripciones(alumno_id);
CREATE INDEX IF NOT EXISTS idx_inscripciones_clase ON inscripciones(clase_id);

-- =========================
-- ENTREGABLES (actividades dentro de una clase: cada una es un examen/tarea independiente,
-- con su propio prompt para el bot, su propio ciclo de vida y sus propias entregas)
-- =========================
CREATE TABLE IF NOT EXISTS entregables (
  id SERIAL PRIMARY KEY,
  clase_id INTEGER NOT NULL REFERENCES clases(id) ON DELETE CASCADE,
  nombre VARCHAR(150) NOT NULL,
  descripcion TEXT,
  fecha_limite TIMESTAMPTZ,
  -- Prompt propio de esta actividad: cada actividad de una clase puede tener un examen/tarea
  -- distinto para el bot (antes era un único prompt por clase).
  prompt_examen TEXT NOT NULL DEFAULT '',
  -- Estado de la actividad, controlado por el profesor: habilitada (visible y disponible para
  -- el alumno), pausada (visible pero el alumno no puede iniciarla) o eliminada (oculta para el
  -- alumno, pero se conserva junto con sus calificaciones y entregas ya guardadas).
  estado VARCHAR(12) NOT NULL DEFAULT 'habilitada' CHECK (estado IN ('habilitada', 'pausada', 'eliminada')),
  -- Campos del alumno (y orden) que el profesor eligió para nombrar los archivos de chat guardados
  criterios_nombrado JSONB NOT NULL DEFAULT '{"fields": []}'::jsonb,
  -- Nombre de carpeta fijo en chat_logs/<profesor>/<carpeta>/, fijado al crear el entregable
  -- para que renombrar el entregable después no rompa la ruta de las entregas ya guardadas
  carpeta VARCHAR(100) NOT NULL DEFAULT '',
  creado_en TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_entregables_clase ON entregables(clase_id);

-- =========================
-- CALIFICACIONES (vincula entregable + alumno; rellenado manual o automático por el bot)
-- =========================
CREATE TABLE IF NOT EXISTS calificaciones (
  id SERIAL PRIMARY KEY,
  entregable_id INTEGER NOT NULL REFERENCES entregables(id) ON DELETE CASCADE,
  alumno_id INTEGER NOT NULL REFERENCES alumnos(id) ON DELETE CASCADE,
  calificacion NUMERIC(5,2) NOT NULL CHECK (calificacion >= 0 AND calificacion <= 10),
  comentarios TEXT,
  origen VARCHAR(10) NOT NULL DEFAULT 'manual' CHECK (origen IN ('manual', 'automatico')),
  registrado_por_profesor_id INTEGER REFERENCES profesores(id) ON DELETE SET NULL,
  creado_en TIMESTAMPTZ NOT NULL DEFAULT now(),
  actualizado_en TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (entregable_id, alumno_id)
);

CREATE INDEX IF NOT EXISTS idx_calificaciones_alumno ON calificaciones(alumno_id);
CREATE INDEX IF NOT EXISTS idx_calificaciones_entregable ON calificaciones(entregable_id);

-- =========================
-- SESIONES DE EXAMEN (vincula una conversación del chatbot con alumno/clase/entregable)
-- =========================
CREATE TABLE IF NOT EXISTS sesiones_examen (
  id SERIAL PRIMARY KEY,
  alumno_id INTEGER NOT NULL REFERENCES alumnos(id) ON DELETE CASCADE,
  clase_id INTEGER NOT NULL REFERENCES clases(id) ON DELETE CASCADE,
  entregable_id INTEGER REFERENCES entregables(id) ON DELETE SET NULL,
  iniciado_en TIMESTAMPTZ NOT NULL DEFAULT now(),
  finalizado_en TIMESTAMPTZ,
  archivo_log VARCHAR(255)
);

CREATE INDEX IF NOT EXISTS idx_sesiones_alumno ON sesiones_examen(alumno_id);
CREATE INDEX IF NOT EXISTS idx_sesiones_clase ON sesiones_examen(clase_id);

-- Mantener actualizado_en al día en calificaciones
CREATE OR REPLACE FUNCTION set_actualizado_en()
RETURNS TRIGGER AS $$
BEGIN
  NEW.actualizado_en = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_calificaciones_actualizado_en ON calificaciones;
CREATE TRIGGER trg_calificaciones_actualizado_en
  BEFORE UPDATE ON calificaciones
  FOR EACH ROW
  EXECUTE FUNCTION set_actualizado_en();

COMMIT;
