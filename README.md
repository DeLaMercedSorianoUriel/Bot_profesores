# Tutor Académico IA

Asistente virtual inteligente que actúa como tutor personal de cada alumno, bajo la supervisión y el control total del docente. El sistema permite que los estudiantes resuelvan dudas en un chat privado, mientras que la inteligencia artificial responde **únicamente** con base en los materiales y temas que el profesor le proporciona. El servidor centraliza el conocimiento del curso y automatiza tareas pesadas como la creación de ejercicios, guías de estudio y exámenes personalizados para cada estudiante, liberando al profesor de carga administrativa sin que este pierda el seguimiento detallado del progreso individual de su grupo.

## Concepto del proyecto

### Propósito y problemática

El propósito general del proyecto es desarrollar una plataforma de asistencia educativa basada en inteligencia artificial que actúe como moderador entre los materiales del docente y las dudas del estudiante, centralizando la gestión de contenidos en un servidor propio. Busca resolver la dificultad de brindar atención personalizada en grupos grandes y la excesiva carga administrativa que implica generar materiales de evaluación y refuerzo (exámenes y guías) de forma constante.

La necesidad surge de observar cómo los estudiantes ya consultan inteligencias artificiales comerciales (como ChatGPT) que no conocen el programa de la materia, lo que genera confusión, respuestas fuera de contexto o plagio difícil de detectar. Existen también plataformas de gestión de cursos como Moodle, pero ninguna integra ambas piezas —gestión de curso e IA conversacional— de forma que el servidor controle totalmente el contenido y genere materiales oficiales de manera privada para cada usuario.

La carencia identificada en la enseñanza-aprendizaje es la falta de una herramienta que permita al profesor "programar" el comportamiento de la IA para que esta se limite a su metodología y materiales, asegurando que el aprendizaje sea guiado y no una simple búsqueda de respuestas. La solución propuesta es un servidor intermedio que filtra y dirige la IA, obligándola a usar solo información aprobada por el docente para asistir a cada alumno de forma individual.

Al finalizar el trabajo, la meta es entregar un sistema funcional donde el docente cargue su información y el servidor gestione chats individuales con los alumnos, siendo capaz de generar automáticamente exámenes, guías y ejercicios personalizados, con un seguimiento completo y rastreable del progreso de cada estudiante. La población beneficiada son estudiantes y docentes de nivel medio superior y superior, que manejan contenidos técnicos y académicos que requieren supervisión y personalización constante.

### Justificación e impacto

El proyecto se justifica en la necesidad de modernizar la atención docente: permite que cada alumno tenga un apoyo disponible las 24 horas que responde con el mismo criterio que el profesor, garantizando la continuidad del aprendizaje fuera del aula. Es importante porque permite que el docente recupere el control sobre las herramientas tecnológicas, usándolas para reducir su carga administrativa y enfocarse en la formación crítica de los estudiantes, mientras la IA resuelve las tareas repetitivas.

El impacto esperado es positivo en la eficiencia educativa: los alumnos resuelven dudas al instante y los profesores obtienen reportes detallados y materiales de evaluación generados automáticamente, mejorando el rendimiento académico general del grupo.

### Viabilidad

El plan de desarrollo inicia con el diseño de la interfaz de usuario, seguido de la configuración del servidor central para el manejo de cuentas. Después se integra la IA mediante una conexión que le permite leer el material específico del curso y, finalmente, se construye el módulo de generación y entrega de documentos.

Técnicamente se apoya en programación web para el servidor y la interfaz, una base de datos relacional para aislar los chats y datos de cada alumno, y una API de modelos de lenguaje para conectar el "cerebro" de la IA al sistema. La calidad y pertinencia del proyecto se garantiza mediante pruebas de validación, alimentando al sistema con temarios reales para asegurar que las respuestas y exámenes generados coincidan con lo esperado por un docente experto. Se cuenta con la infraestructura computacional, el acceso a los modelos de lenguaje necesarios y el tiempo estipulado dentro del calendario de titulación para completar el desarrollo.

### Descripción del sistema

Es una plataforma web privada donde el servidor identifica de forma única a cada cliente. Sus características principales son el aislamiento de conversaciones entre alumnos, la lectura de los materiales cargados por el docente y la capacidad de generar y entregar archivos dinámicamente dentro del chat del alumno. El resultado esperado es un software capaz de gestionar múltiples tutorías simultáneas, donde el servidor mantenga siempre el control de la información y entregue resultados académicos tangibles: exámenes calificados y guías de estudio personalizadas para cada estudiante.

## Arquitectura implementada

El sistema está construido como una aplicación web Node.js/Express con PostgreSQL, y tres roles independientes con su propia autenticación de sesión:

- **Administrador** — único rol que puede dar de alta o baja a profesores y alumnos, y consultar las relaciones entre clases, inscripciones y calificaciones desde un panel con interfaz de botones.
- **Profesor** — crea sus clases, define el prompt de examen y los materiales que la IA debe usar, registra y matricula alumnos, configura cómo se nombran los archivos de chat guardados por cada entregable, y consulta las entregas y calificaciones de su grupo.
- **Alumno** — entra a un chat privado y aislado por clase/entregable, donde la IA (modelo NVIDIA Nemotron vía LangChain) lo guía únicamente con el prompt y los criterios definidos por su profesor.

Cada conversación se guarda como bitácora de texto en `chat_logs/<usuario_profesor>/<entregable>/`, con el nombre de archivo configurado por el profesor a partir de los datos del alumno. El profesor puede revisar esas entregas desde su panel con un visor de conversación con burbujas de color (bot en azul, alumno en rojo) para una lectura clara y rápida.

### Stack técnico

- **Backend:** Node.js, Express, express-session
- **Base de datos:** PostgreSQL (tablas `administradores`, `profesores`, `alumnos`, `clases`, `inscripciones`, `entregables`, `calificaciones`, `sesiones_examen`)
- **IA conversacional:** LangChain + NVIDIA NIM (modelo Nemotron) para el tutor, con un analizador de apoyo
- **Autenticación:** bcrypt para contraseñas, sesiones independientes por rol
- **Frontend:** HTML/CSS/JS plano, sin framework, servido por Express

## Estructura del proyecto

```
server.js            Rutas y lógica de la API (Express)
auth.js               Registro, login y hashing de contraseñas
utils.js              Integración con el modelo de IA y manejo de historiales de chat
analyzer.js           Apoyo de análisis/validación de respuestas
db.js                 Conexión a PostgreSQL
db/schema.sql         Esquema completo de la base de datos
public/               Páginas (login, paneles de admin/profesor/alumno, chat)
chat_logs/            Bitácoras de conversación, organizadas por profesor y entregable
```

## Puesta en marcha

1. Instalar dependencias:
   ```
   npm install
   ```
2. Configurar las variables de entorno en `.env` (claves de API de IA, credenciales de PostgreSQL y `SESSION_SECRET`).
3. Crear el esquema de base de datos:
   ```
   psql -U <usuario> -h 127.0.0.1 -d <basededatos> -f db/schema.sql
   ```
4. Levantar el servidor:
   ```
   npm start
   ```
5. El servidor imprime en consola la(s) IP(s) de red local disponibles para que los alumnos se conecten desde otros dispositivos en la misma red.
