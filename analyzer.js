// Módulo del Analizador Sintáctico
require('dotenv').config();
const { ChatGoogleGenerativeAI } = require('@langchain/google-genai');
const { HumanMessage, AIMessage, SystemMessage } = require('@langchain/core/messages');

// Configuración del modelo analizador con su propia API key
const analyzerApiKey = process.env.ANALIZADOR_API_KEY;
const analyzerModel = new ChatGoogleGenerativeAI({
  apiKey: analyzerApiKey,
  modelName: 'gemini-2.5-flash',
  temperature: 0.3, // Temperatura más baja para análisis más preciso
});

// Almacenamiento del estado del analizador por sesión
const analyzerState = {};

/**
 * Inicializa el estado del analizador para una nueva sesión
 */
function initializeAnalyzerState(sessionId, initialPrompt) {
  analyzerState[sessionId] = {
    initialPrompt: initialPrompt,
    taskCompleted: false,
    currentStep: 0,
    totalSteps: 0,
    isFirstResponse: true,
    awaitingUserApproval: false,
    conversationHistory: []
  };
}

/**
 * Analiza el prompt inicial para extraer requisitos y restricciones
 */
async function analyzeInitialPrompt(sessionId, prompt) {
  const analysisPrompt = `Eres un analizador sintáctico experto en español. Analiza el siguiente prompt del profesor y extrae:
1. Si requiere respuestas paso a paso (pregunta por pregunta)
2. Número total de pasos o preguntas si se especifica
3. Restricciones específicas que debe seguir el bot
4. Formato de respuesta esperado

Prompt del profesor:
"${prompt}"

Responde en formato JSON con esta estructura:
{
  "stepByStep": true/false,
  "totalSteps": número o null,
  "restrictions": ["restricción1", "restricción2"],
  "responseFormat": "descripción del formato"
}`;

  try {
    const response = await analyzerModel.invoke([
      new SystemMessage('Eres un analizador sintáctico preciso que responde solo en formato JSON.'),
      new HumanMessage(analysisPrompt)
    ]);

    const content = response.content.trim();
    // Extraer JSON del contenido (puede venir con markdown)
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const analysis = JSON.parse(jsonMatch[0]);
      
      if (!analyzerState[sessionId]) {
        initializeAnalyzerState(sessionId, prompt);
      }
      
      analyzerState[sessionId].stepByStep = analysis.stepByStep;
      analyzerState[sessionId].totalSteps = analysis.totalSteps || 0;
      analyzerState[sessionId].restrictions = analysis.restrictions || [];
      analyzerState[sessionId].responseFormat = analysis.responseFormat || '';
      
      return analysis;
    }
  } catch (error) {
    console.error('Error al analizar prompt inicial:', error);
  }
  
  return null;
}

/**
 * Valida si la respuesta del bot cumple con el prompt inicial
 */
async function validateBotResponse(sessionId, botResponse, userMessage = '') {
  const state = analyzerState[sessionId];
  if (!state) {
    return { isValid: true, feedback: '', needsRegeneration: false };
  }

  // Construir el contexto para el analizador
  const validationPrompt = `Eres un analizador sintáctico que verifica si las respuestas cumplen con las instrucciones del profesor.

PROMPT INICIAL DEL PROFESOR:
"${state.initialPrompt}"

ANÁLISIS DEL PROMPT:
- Paso a paso: ${state.stepByStep ? 'SÍ' : 'NO'}
- Pasos totales: ${state.totalSteps || 'No especificado'}
- Paso actual: ${state.currentStep + 1}
- Restricciones: ${state.restrictions.join(', ') || 'Ninguna'}
- Formato esperado: ${state.responseFormat || 'No especificado'}

${userMessage ? `MENSAJE DEL USUARIO: "${userMessage}"` : ''}

RESPUESTA DEL BOT A VALIDAR:
"${botResponse}"

Analiza si la respuesta del bot:
1. Cumple con el formato requerido (paso a paso si se solicita)
2. Respeta las restricciones del prompt
3. Está en el paso correcto de la secuencia
4. ${state.stepByStep ? 'Presenta UNA SOLA pregunta/paso y espera respuesta' : 'Responde adecuadamente'}

Responde en formato JSON:
{
  "isValid": true/false,
  "feedback": "explicación breve de qué está mal o bien",
  "needsRegeneration": true/false,
  "suggestedCorrection": "sugerencia para corregir si needsRegeneration es true"
}`;

  try {
    const response = await analyzerModel.invoke([
      new SystemMessage('Eres un analizador sintáctico estricto que valida respuestas. Responde solo en JSON.'),
      new HumanMessage(validationPrompt)
    ]);

    const content = response.content.trim();
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    
    if (jsonMatch) {
      const validation = JSON.parse(jsonMatch[0]);
      
      // Guardar en historial del analizador
      state.conversationHistory.push({
        userMessage,
        botResponse,
        validation,
        timestamp: new Date()
      });
      
      return validation;
    }
  } catch (error) {
    console.error('Error al validar respuesta:', error);
  }

  return { isValid: true, feedback: '', needsRegeneration: false };
}

/**
 * Genera instrucciones de corrección para el bot inicial
 */
async function generateCorrectionInstructions(sessionId, botResponse, validationFeedback) {
  const state = analyzerState[sessionId];
  
  const correctionPrompt = `Como analizador sintáctico, necesitas dar instrucciones claras al bot para corregir su respuesta.

PROMPT ORIGINAL: "${state.initialPrompt}"
RESPUESTA INCORRECTA DEL BOT: "${botResponse}"
PROBLEMA DETECTADO: "${validationFeedback}"

Genera instrucciones específicas y claras para que el bot corrija su respuesta. Las instrucciones deben ser directas y accionables.`;

  try {
    const response = await analyzerModel.invoke([
      new SystemMessage('Eres un supervisor que da instrucciones claras y específicas.'),
      new HumanMessage(correctionPrompt)
    ]);

    return response.content;
  } catch (error) {
    console.error('Error al generar instrucciones de corrección:', error);
    return 'Por favor, ajusta tu respuesta para cumplir con el formato solicitado en el prompt inicial.';
  }
}

/**
 * Proporciona ayuda del analizador al usuario
 */
async function provideAnalyzerHelp(sessionId, userMessage) {
  const state = analyzerState[sessionId];
  if (!state) {
    return 'Todavía no hay una conversación de examen activa para analizar.';
  }

  // El análisis estructural del prompt (pasos, restricciones, formato) se calcula aquí, la
  // primera vez que el analizador es invocado explícitamente — nunca antes ni automáticamente.
  if (state.stepByStep === undefined) {
    await analyzeInitialPrompt(sessionId, state.initialPrompt);
  }

  const helpPrompt = `El usuario está solicitando ayuda del analizador.

CONTEXTO:
- Prompt inicial: "${state.initialPrompt}"
- Paso actual: ${state.currentStep + 1} de ${state.totalSteps || '?'}
- Mensaje del usuario: "${userMessage}"

Proporciona ayuda clara y útil al usuario sobre cómo proceder o qué se espera en este momento.`;

  try {
    const response = await analyzerModel.invoke([
      new SystemMessage('Eres un asistente útil que ayuda a los usuarios a entender qué se espera de ellos.'),
      new HumanMessage(helpPrompt)
    ]);

    return response.content;
  } catch (error) {
    console.error('Error al proporcionar ayuda:', error);
    return 'Estoy aquí para ayudarte. ¿Qué necesitas saber sobre la tarea actual?';
  }
}

/**
 * Marca la aprobación del usuario para la respuesta actual
 */
function approveCurrentResponse(sessionId) {
  const state = analyzerState[sessionId];
  if (state) {
    state.awaitingUserApproval = false;
    state.currentStep++;
    
    // Verificar si se completó la tarea
    if (state.totalSteps > 0 && state.currentStep >= state.totalSteps) {
      state.taskCompleted = true;
    }
  }
}

/**
 * Rechaza la respuesta actual y permite regeneración
 */
function rejectCurrentResponse(sessionId) {
  const state = analyzerState[sessionId];
  if (state) {
    state.awaitingUserApproval = false;
  }
}

/**
 * Verifica si la tarea está completa
 */
function isTaskCompleted(sessionId) {
  const state = analyzerState[sessionId];
  return state ? state.taskCompleted : false;
}

/**
 * Obtiene el estado actual del analizador
 */
function getAnalyzerState(sessionId) {
  return analyzerState[sessionId] || null;
}

/**
 * Marca que se está esperando aprobación del usuario
 */
function setAwaitingApproval(sessionId, awaiting = true) {
  const state = analyzerState[sessionId];
  if (state) {
    state.awaitingUserApproval = awaiting;
    state.isFirstResponse = false;
  }
}

module.exports = {
  initializeAnalyzerState,
  analyzeInitialPrompt,
  validateBotResponse,
  generateCorrectionInstructions,
  provideAnalyzerHelp,
  approveCurrentResponse,
  rejectCurrentResponse,
  isTaskCompleted,
  getAnalyzerState,
  setAwaitingApproval
};
