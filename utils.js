
// Al inicio de utils.js
require('dotenv').config(); // Carga las variables de .env
const fs = require('fs');
const path = require('path');
const { ChatOpenAI } = require('@langchain/openai');
const PQueue = require('p-queue').default;
const { HumanMessage, AIMessage, SystemMessage } = require('@langchain/core/messages');
const analyzer = require('./analyzer');

// Configuración de la API de NVIDIA NIM (endpoint compatible con OpenAI) con LangChain
const apiKey = process.env.NVIDIA_API_KEY;
const modelName = 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning';

// Inicializar el modelo de LangChain
const model = new ChatOpenAI({
  apiKey: apiKey,
  model: modelName,
  // Temperatura baja: este bot necesita ser consistente (numeración de preguntas,
  // seguimiento de instrucciones paso a paso), no creativo.
  temperature: 0.3,
  topP: 0.9,
  // max_tokens en NVIDIA NIM es un techo compartido entre el razonamiento interno
  // (reasoning_content) y la respuesta visible: si se queda corto, el modelo puede
  // agotarlo solo "pensando" y devolver una respuesta vacía o cortada a la mitad.
  maxTokens: 8192,
  maxRetries: 3,
  timeout: 60000,
  configuration: {
    baseURL: 'https://integrate.api.nvidia.com/v1',
  },
  modelKwargs: {
    // OJO: se probó desactivar enable_thinking para evitar que el razonamiento
    // se filtre como respuesta visible, pero esto causa algo peor: el modelo entra
    // en bucles de repetición con formato corrupto ("{(type: 'text', ...)}") y deja
    // de avanzar en la conversación. El razonamiento interno es necesario para que
    // este modelo "nano" mantenga el hilo en tareas largas de varios turnos.
    // Se deja habilitado y el filtrado ocasional se maneja con reintentos
    // (ver looksLikeLeakedReasoning más abajo).
    chat_template_kwargs: { enable_thinking: true },
    reasoning_budget: 1024,
  },
});

// La capa gratuita de NVIDIA NIM limita a ~40 requests/minuto: se deja margen (35)
// y se acota la concurrencia para no saturar el endpoint con 40+ usuarios a la vez.
const requestQueue = new PQueue({ concurrency: 5, intervalCap: 35, interval: 60 * 1000 });

// Carpeta para guardar historiales
const chatLogsDir = path.join(__dirname, 'chat_logs');
// NUEVO: Asegurar que la carpeta chat_logs exista antes de usarla
if (!fs.existsSync(chatLogsDir)) {
  fs.mkdirSync(chatLogsDir, { recursive: true });
  console.log(`Carpeta ${chatLogsDir} creada.`);
}

// Devuelve la fecha y hora reales del sistema (zona horaria CDMX) en formato YYYY-MM-DD HH:mm.
// Se usa para inyectar la hora real en cada petición a la API, ya que el modelo no tiene
// acceso al reloj del sistema y, dejado solo, inventa o repite una fecha fija (p. ej. siempre "2025-11-03").
function getCurrentDateTimeCDMX() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Mexico_City',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false
  }).formatToParts(new Date());
  const get = (type) => parts.find(p => p.type === type).value;
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}`;
}

// Heurística para detectar si el modelo "filtró" su razonamiento interno crudo
// en lugar de dar una respuesta limpia (p. ej. "Hmm, given the pattern we need to...").
function looksLikeLeakedReasoning(text) {
  if (!text) return false;
  const sample = text.slice(0, 400).toLowerCase();
  const reasoningMarkers = [
    'we need to', 'let\'s', "let's", 'given the pattern', 'given the instruction',
    'so we should', 'so i think', 'wait,', 'actually,', 'hmm', 'the user answered',
    'thus we need', 'we should treat'
  ];
  return reasoningMarkers.some(marker => sample.includes(marker));
}

// Heurística para detectar cuando el modelo devuelve un bloque de contenido
// mal formado en vez de texto plano, p. ej. {'type': 'text', 'text': '...'}.
function looksLikeMalformedContentBlock(text) {
  if (!text) return false;
  return /['"(]\s*type['"]?\s*:\s*['"]text['"]/i.test(text.slice(0, 200));
}

// Función para generar respuesta del bot (NVIDIA Nemotron) usando LangChain.
// Reintenta automáticamente ante respuestas vacías, razonamiento filtrado o
// errores transitorios, para nunca dejar al estudiante sin respuesta.
async function generateBotResponse(messages, attempt = 1) {
  const maxAttempts = 3;
  try {
    // Convertir mensajes al formato de LangChain
    const langchainMessages = messages.map(message => {
      if (message.role === 'user') {
        return new HumanMessage(message.content);
      } else if (message.role === 'model') {
        return new AIMessage(message.content);
      } else if (message.role === 'system') {
        return new SystemMessage(message.content);
      }
      return new HumanMessage(message.content);
    });

    // Inyectar la fecha/hora real del sistema solo en la petición a la API (no se guarda
    // en el historial ni se muestra al alumno), para que el modelo deje de inventar/repetir fechas.
    langchainMessages.push(new SystemMessage(
      `[Información del sistema] Fecha y hora actuales reales: ${getCurrentDateTimeCDMX()} (México, CDMX). ` +
      'Usa siempre esta fecha y hora real en tu respuesta (por ejemplo en los paréntesis de cada pregunta o en el resumen final). ' +
      'Nunca inventes, repitas o reutilices una fecha/hora de un turno anterior.'
    ));

    // Instrucción permanente para poder capturar la calificación automáticamente: cuando el
    // examen haya concluido y se informe el resultado final al alumno, el modelo debe incluir
    // una línea con un formato fijo que el servidor pueda parsear, sin importar lo que pida
    // el prompt configurado por cada profesor.
    langchainMessages.push(new SystemMessage(
      '[Información del sistema] Cuando (y solo cuando) el examen haya concluido por completo y estés dando el ' +
      'resultado final al alumno, agrega al final de tu mensaje, en su propia línea, exactamente este formato ' +
      '(sin texto adicional en esa línea): CALIFICACION_FINAL: X.X — donde X.X es la calificación en una escala de ' +
      '0 a 10 con un decimal, calculada como (aciertos totales / preguntas totales) * 10. No incluyas esta línea ' +
      'en ningún otro momento de la conversación, solo en el mensaje de cierre del examen.'
    ));

    // Encolar la invocación para no exceder el rate limit de la API de NVIDIA
    const response = await requestQueue.add(() => model.invoke(langchainMessages));

    // Extraer el texto de la respuesta
    const responseText = response.content;

    if (!responseText || looksLikeLeakedReasoning(responseText) || looksLikeMalformedContentBlock(responseText)) {
      console.warn(`Respuesta vacía, con razonamiento filtrado o mal formada (intento ${attempt}/${maxAttempts})`);
      if (attempt < maxAttempts) {
        return generateBotResponse(messages, attempt + 1);
      }
      return 'Hubo un problema generando la respuesta. ¿Puedes repetir tu última respuesta o pregunta?';
    }

    return responseText;

  } catch (error) {
    console.error(`Error with LangChain NVIDIA API (intento ${attempt}/${maxAttempts}):`, {
      message: error.message,
      status: error.status || error.response?.status,
      body: error.error || error.response?.data,
    });
    if (attempt < maxAttempts) {
      return generateBotResponse(messages, attempt + 1);
    }
    return 'Hubo un problema técnico generando la respuesta. Por favor, intenta enviar tu mensaje de nuevo.';
  }
}

// Busca la marca CALIFICACION_FINAL: X.X que el modelo agrega al cerrar un examen (ver
// instrucción de sistema en generateBotResponse) y la separa del texto que verá el alumno,
// mostrándole en su lugar una línea más amigable.
function extractCalificacionFinal(rawText) {
  if (!rawText) return { calificacion: null, text: rawText };
  const match = rawText.match(/CALIFICACION_FINAL:\s*([0-9]+(?:\.[0-9]+)?)/i);
  if (!match) return { calificacion: null, text: rawText };

  let calificacion = parseFloat(match[1]);
  if (Number.isNaN(calificacion)) return { calificacion: null, text: rawText };
  calificacion = Math.max(0, Math.min(10, calificacion));

  const cleanedText = rawText
    .replace(match[0], `Calificación final: ${calificacion.toFixed(1)}/10`)
    .trim();

  return { calificacion, text: cleanedText };
}

// Función para formatear la respuesta
function formatGeminiResponse(responseText) {
  let formattedText = responseText.replace(/\*\*(.*?)\*\*/g, '<b>$1</b>');
  formattedText = formattedText.replace(/:(?!\s)/g, ': ');
  formattedText = formattedText.replace(/\n/g, '<br>');
  return formattedText;
}

// Guarda el historial de la conversación en un archivo. customFilename puede incluir
// subcarpetas (p. ej. "profesor/entregable/archivo.txt"); se crean si no existen.
function saveChatHistoryToFile(sessionId, history, customFilename) {
  // NUEVO: Usar la ruta absoluta con chatLogsDir y el nombre personalizado
  const filename = customFilename ? path.join(chatLogsDir, customFilename) : path.join(chatLogsDir, `chat_${sessionId}.txt`);
  const dir = path.dirname(filename);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  let fileContent = '';

  history.forEach(message => {
    const sender = message.role === 'user' ? 'Usuario' : 'Bot';
    // Guardar con prefijo pero sin escapar saltos de línea
    fileContent += `${sender}: ${message.content}\n\n`;
  });

  fs.writeFileSync(filename, fileContent, 'utf8');
  console.log(`Chat history saved to ${filename}`);
}

// Inicializa la conversación con el prompt inicial (analizador solo se activa bajo demanda)
async function initializeConversation(sessionId, conversationHistory, initialPrompt, customFilename) {
  if (!conversationHistory[sessionId]) {
    conversationHistory[sessionId] = [];
    
    // Inicializar el estado del analizador (solo guarda el prompt en memoria, no hace
    // ninguna llamada a la IA todavía). El análisis real solo ocurre si el alumno lo solicita
    // explícitamente con la contraseña del profesor, en POST /api/analizador/solicitar-ayuda.
    analyzer.initializeAnalyzerState(sessionId, initialPrompt);

    // Agregar el prompt inicial como mensaje del usuario
    conversationHistory[sessionId].push({ role: 'user', content: initialPrompt });
    
    // Generar respuesta inicial del bot (sin validación automática)
    const rawResponseFull = await generateBotResponse(conversationHistory[sessionId]);
    const { calificacion, text: rawResponse } = extractCalificacionFinal(rawResponseFull);
    const botResponse = formatGeminiResponse(rawResponse);

    // Agregar respuesta del bot al historial
    conversationHistory[sessionId].push({ role: 'model', content: rawResponse });

    // Guardar historial
    saveChatHistoryToFile(sessionId, conversationHistory[sessionId], customFilename);

    return {
      response: botResponse,
      needsApproval: false,
      calificacionFinal: calificacion
    };
  }
  return null;
}

// Procesa mensaje del usuario. El analizador NUNCA se invoca desde aquí: la única forma de
// activarlo es la solicitud explícita y protegida por contraseña en
// POST /api/analizador/solicitar-ayuda (ver server.js), para que nunca actúe por su cuenta.
async function processUserMessage(sessionId, userMessage, conversationHistory, customFilename) {
  // Flujo normal: agregar mensaje del usuario y generar respuesta sin intervención del analizador
  conversationHistory.push({ role: 'user', content: userMessage });

  // Generar respuesta del bot (sin validación automática)
  const rawResponseFull = await generateBotResponse(conversationHistory);
  const { calificacion, text: rawResponse } = extractCalificacionFinal(rawResponseFull);
  const botResponse = formatGeminiResponse(rawResponse);

  // Agregar respuesta al historial
  conversationHistory.push({ role: 'model', content: rawResponse });

  // Guardar historial
  saveChatHistoryToFile(sessionId, conversationHistory, customFilename);

  return {
    response: botResponse,
    needsApproval: false,
    calificacionFinal: calificacion
  };
}

module.exports = {
  generateBotResponse,
  formatGeminiResponse,
  saveChatHistoryToFile,
  initializeConversation,
  processUserMessage,
  extractCalificacionFinal
};