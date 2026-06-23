# Sistema de Analizador Sintáctico - Documentación

## 📋 Descripción General

Este sistema implementa un **agente analizador sintáctico** que supervisa y valida las respuestas del bot principal, asegurando que se cumplan las instrucciones del prompt del profesor.

## 🏗️ Arquitectura del Sistema

### Componentes Principales

1. **Bot Principal** (`utils.js`)
   - Utiliza LangChain con la API de NVIDIA NIM (modelo `nvidia/nemotron-3-nano-omni-30b-a3b-reasoning`, endpoint compatible con OpenAI)
   - Genera respuestas basadas en el prompt del profesor
   - API Key: `NVIDIA_API_KEY`
   - Las llamadas pasan por una cola (`p-queue`) que limita la tasa a ~35 req/min para no exceder el límite de la capa gratuita de NVIDIA (~40 req/min) con muchos usuarios concurrentes

2. **Analizador Sintáctico** (`analyzer.js`)
   - Valida respuestas del bot principal
   - Detecta si se cumplen las restricciones del prompt
   - Genera instrucciones de corrección
   - API Key: `ANALIZADOR_API_KEY`

3. **Servidor** (`server.js`)
   - Gestiona la comunicación entre componentes
   - Rastrea validaciones por IP
   - Maneja el flujo de aprobación del usuario

4. **Interfaz de Usuario** (`index.html`)
   - Panel de validación visual
   - Botones de aprobación/rechazo
   - Soporte para ayuda del analizador

## 🔄 Flujo de Trabajo

### 1. Inicialización
```
Profesor configura prompt → Analizador analiza requisitos → Bot genera respuesta inicial → Analizador valida
```

### 2. Validación Automática
- El analizador verifica cada respuesta del bot
- Si no cumple con el prompt, regenera automáticamente (máx. 3 intentos)
- Extrae: formato paso a paso, número de pasos, restricciones

### 3. Validación del Usuario
Cuando el prompt requiere respuestas paso a paso:
- Se muestra un panel de validación
- Usuario puede **aprobar** o **rechazar** la respuesta
- Si aprueba: continúa al siguiente paso
- Si rechaza: puede proporcionar más detalles

### 4. Seguimiento de Progreso
- El analizador rastrea el paso actual
- Verifica si la tarea está completa
- Muestra mensaje de finalización cuando se completan todos los pasos

## 🎯 Características Principales

### ✅ Validación por IP
- Cada nueva IP que se conecta es rastreada
- El analizador valida la primera respuesta para cada IP
- Estadísticas disponibles en `/ip-stats` (solo localhost)

### ✅ Modo Paso a Paso
Cuando el profesor solicita preguntas una por una:
- El bot presenta **una sola pregunta** a la vez
- Espera aprobación del usuario antes de continuar
- El analizador verifica que se respete este formato

### ✅ Ayuda del Analizador
El usuario puede escribir **"ayuda analizador"** para:
- Obtener orientación sobre qué se espera
- Entender el paso actual
- Recibir asistencia contextual

### ✅ Regeneración Inteligente
Si la respuesta no cumple con el prompt:
1. Analizador detecta el problema
2. Genera instrucciones de corrección específicas
3. Bot regenera la respuesta
4. Proceso se repite hasta 3 veces

## 🔧 Configuración

### Variables de Entorno (.env)
```env
NVIDIA_API_KEY=tu_api_key_del_bot_principal (NVIDIA NIM)
GEMINI_API_KEY=tu_api_key_de_gemini (sin uso actualmente, se conserva por compatibilidad)
ANALIZADOR_API_KEY=tu_api_key_del_analizador (Gemini)
```

### Ejemplo de Prompt del Profesor
```
Realiza un examen de 20 preguntas sobre matemáticas.
Presenta una pregunta a la vez y espera la respuesta del estudiante.
No muestres la siguiente pregunta hasta que el estudiante responda la actual.
```

El analizador detectará:
- ✓ Modo paso a paso: SÍ
- ✓ Total de pasos: 20
- ✓ Restricción: Una pregunta a la vez
- ✓ Formato: Esperar respuesta antes de continuar

## 📊 Endpoints de Administración (Solo Localhost)

### Estado del Analizador
```
GET /analyzer-status/:sessionId
```
Retorna el estado actual del analizador para una sesión.

### Estadísticas de IPs
```
GET /ip-stats
```
Muestra estadísticas de todas las IPs que han accedido.

## 🎨 Interfaz de Usuario

### Panel de Validación
Aparece cuando se requiere aprobación del usuario:
- **Botón Verde**: ✓ Correcto, Continuar
- **Botón Rojo**: ✗ Necesita Ajustes
- **Tip**: Recordatorio de "ayuda analizador"

### Indicadores Visuales
- **Verde**: Respuestas aprobadas
- **Rojo**: Respuestas rechazadas
- **Amarillo**: Ayuda del analizador
- **Verde con ✓**: Tarea completada

## 🚀 Uso

### Para el Profesor
1. Acceder a `http://localhost:3000/profe`
2. Configurar el prompt inicial
3. Definir criterios de nombrado para estudiantes

### Para el Estudiante
1. Acceder a la URL del servidor
2. Completar datos solicitados
3. Interactuar con el chatbot
4. Aprobar/rechazar respuestas cuando se solicite
5. Usar "ayuda analizador" si necesita asistencia

## 🔍 Palabras Clave de Aprobación

El sistema reconoce estas palabras para aprobar respuestas:
- correcto
- bien
- está bien
- ok
- continuar
- siguiente
- sí / si
- aprobado

## 🛡️ Seguridad

- **Separación de APIs**: Cada agente usa su propia API key
- **Restricción por IP**: Páginas de administración solo en localhost
- **Validación de campos**: Todos los campos de estudiante son obligatorios
- **Rastreo de sesiones**: Cada sesión es única y rastreada

## 📝 Notas Técnicas

### Temperatura de los Modelos
- **Bot Principal**: 0.7 (más creativo)
- **Analizador**: 0.3 (más preciso y estricto)

### Límites
- Máximo 3 intentos de regeneración por respuesta
- Historial guardado en archivos `.txt` en `/chat_logs`

## 🐛 Debugging

Para ver logs del analizador en la consola del servidor:
- Regeneraciones automáticas
- Validaciones fallidas
- Estado de cada sesión

## 📦 Dependencias Principales

- `langchain`: Framework de LLM
- `@langchain/google-genai`: Integración con Gemini
- `@langchain/core`: Mensajes y tipos base
- `express`: Servidor web
- `express-session`: Gestión de sesiones

## ✨ Mejoras Futuras Sugeridas

- [ ] Dashboard visual para el profesor
- [ ] Métricas de rendimiento del analizador
- [ ] Exportación de resultados en diferentes formatos
- [ ] Configuración de temperatura por prompt
- [ ] Historial de validaciones del analizador
