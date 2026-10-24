/**
 * CLOUDFLARE WORKERS + DURABLE OBJECTS + WEBSOCKETS + GEMINI API
 * Implementación de servidor para "La Sala" en Cloudflare Workers.
 *
 * Características:
 * - Matchmaking global real: todas las peticiones convergen en la misma instancia de Durable Object ("sala_global").
 * - Búsqueda de sala con espacio disponible (< 5 usuarios reales) antes de crear una nueva.
 * - Límite estricto de máximo 5 usuarios reales por sala.
 * - Presencia de IA (Gemini):
 *   - Si hay exactamente 1 usuario real en la sala, Gemini conversa con él.
 *   - Si entran 2 o más usuarios reales, Gemini se desactiva y deja de responder de inmediato.
 *   - Si la sala vuelve a tener exactamente 1 usuario, Gemini regresa.
 * - Totalmente anónimo: no se transmiten nombres, avatares ni IDs personales en los mensajes.
 * - Autoridad del servidor sobre sesiones:
 *   - Ventana estricta de 5 minutos (300 s) por sesión desde el ingreso inicial.
 *   - Cooldown obligatorio de 10 minutos (600 s) tras expirar los 5 minutos.
 *   - Los datos de sesión persisten en el storage del Durable Object para resistir reinicios.
 * - Mensajes efímeros de exactamente 15 segundos con notificación de expiración a los clientes.
 * - Reanálisis seguro de reconexiones sin duplicar cupos ni corromper el conteo de usuarios.
 */

export interface Env {
  SALA_ROOM: DurableObjectNamespace;
  GEMINI_API_KEY?: string;
}

const SESSION_DURATION_MS = 5 * 60 * 1000; // 300 segundos
const COOLDOWN_DURATION_MS = 10 * 60 * 1000; // 600 segundos
const MESSAGE_LIFESPAN_MS = 15 * 1000; // 15 segundos
const MAX_USERS_PER_ROOM = 5;

// Saludos casuales iniciales
const INITIAL_GREETINGS = [
  "hola",
  "holaa",
  "buenas",
  "qué onda",
  "hola qué tal",
];

// System prompt idéntico y aprobado de La Sala
const AI_SYSTEM_PROMPT =
  "Eres un usuario en un chat anónimo casual en línea ('La Sala').\n" +
  "OBJETIVO: Conversa como alguien completamente normal en un chat informal de internet, sin intentar parecer interesante, profundo, poético o excesivamente amable.\n\n" +
  "REGLAS OBLIGATORIAS:\n" +
  "1. PROPORCIONALIDAD: Responde de manera proporcional al mensaje recibido. Si alguien escribe 'hola', responde simplemente 'hola', 'holaa' o algo similar. No agregues reflexiones, descripciones ni preguntas innecesarias. Si el usuario escribe una sola palabra, tú puedes responder con una sola palabra.\n" +
  "2. BREVEDAD Y NATURALIDAD: Utiliza respuestas breves y naturales. Una palabra puede ser suficiente ('hola', 'simón', 'sí', 'total', 'claro', 'bueno'). LÍMITE ESTRICTO: máximo 180 caracteres. Respuestas cortas de 1 o 2 frases simples como máximo.\n" +
  "3. NO CONVIERTAS CADA RESPUESTA EN UNA PREGUNTA: Prohibido terminar cada mensaje con una pregunta. Alterna respuestas simples, reacciones cortas ('ah ya', 'jaja sí', 'no manches', 'qué loco'), comentarios y preguntas solo cuando surjan naturalmente.\n" +
  "4. CERO ARTIFICIALIDAD: Evita frases artificiales como 'qué bonito lugar', 'este espacio es especial', 'qué interesante lo que compartes' o reflexiones sobre la vida. Cero tono servicial de asistente ('¿En qué te ayudo?', 'Gracias por compartir').\n" +
  "5. NO MENCIONAR CONSTANTEMENTE LA PARED O LA SALA: No menciones La Pared, La Sala, notas ni el propósito de la app a menos que el usuario lo pregunte específicamente. No actúes como promotor ni guía turístico.\n" +
  "6. RESPUESTA A '¿QUÉ ES ESTO?': Si alguien pregunta '¿qué es esto?', responde con incertidumbre casual o natural, como '¿la sala?' o 'es como un chat creo jaja', según el contexto. No inventes desconocimiento cuando sí tengas información relevante (si preguntan por La Pared, sabes que es un muro donde la gente deja notas).\n" +
  "7. ADAPTA LONGITUD Y TONO: Adapta la longitud, energía y lenguaje a la conversación. No uses siempre 'jaja', 'xd' ni emojis; úsalos con moderación y variedad.\n" +
  "8. CONTEXTO Y NO REPETICIÓN: Conserva el contexto de los mensajes anteriores durante la sesión y evita repetir respuestas o muletillas.\n" +
  "9. SINCERIDAD SOBRE SER IA: Si te preguntan si eres una IA, bot, humano o persona real, responde con sincera naturalidad (ej: 'sí jaja, soy una IA', 'sí, soy un bot mientras no entra nadie'). Nunca afirmes ser humano ni inventes vivencias personales falsas (familia, infancia, pareja). Si no te lo preguntan, nunca digas 'como IA...'.\n" +
  "10. VARIEDAD: Genera respuestas variadas según el contexto, sin caer en respuestas predeterminadas repetitivas. Español informal y cotidiano.";

// Motor de respaldo contextual multi-turno idéntico
function getContextualFallback(
  userPrompt?: string,
  history: Array<{ role: string; text: string }> = []
): string {
  const current = (userPrompt || "").trim();
  const lower = current.toLowerCase();
  const normalized = lower.normalize("NFD").replace(/[\u0300-\u036f]/g, "");

  const pastTurns = history.filter(
    (h, idx) => !(idx === history.length - 1 && h.text.trim() === current)
  );
  const allPastText = pastTurns
    .map((h) => h.text.toLowerCase())
    .join(" ")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");

  // 1. Pregunta directa sobre identidad de IA
  if (/(\beres\b.*\b(ia|ai|bot|robot|humano|humana|persona|real)\b|\bque\b\s+eres\b|\bquien\b\s+eres\b)/i.test(normalized)) {
    const aiReplies = [
      "sí jaja, soy una IA",
      "sí, soy un bot mientras no entra alguien más",
      "soy una IA jaja, nomás pasando el rato",
      "sí, no soy humano",
    ];
    return aiReplies[Math.floor(Math.random() * aiReplies.length)];
  }

  // 2. Saludos
  if (/^(hola|holaa|holaaa|buenas|que onda|q onda|que tal|q tal|hey|buenas buenas|buenos dias|buenas tardes|buenas noches)$/i.test(normalized)) {
    const greetings = ["hola", "qué onda", "holaa", "buenas", "qué tal"];
    return greetings[Math.floor(Math.random() * greetings.length)];
  }

  // 3. Risas
  if (/^(jaja|jajaja|jajajaja|xd|jjsjs|jeje|jaja\s+si)$/i.test(normalized)) {
    const laughs = ["jaja", "jajaja", "xd", "la neta sí jaja"];
    return laughs[Math.floor(Math.random() * laughs.length)];
  }

  // 4. Chistes
  if (/(chiste|broma|cuentame\s+algo\s+gracioso)/i.test(normalized)) {
    const jokes = [
      "¿qué le dice un jaguar a otro? jaguar you jajaja",
      "¿por qué los pájaros no usan facebook? porque ya tienen twitter jajaja",
      "—oye, ¿sabes qué hora es? —sí. —ah bueno gracias jajaja",
    ];
    return jokes[Math.floor(Math.random() * jokes.length)];
  }

  // 5. Preguntas sobre qué hacer en La Sala
  if (/(sabes\s+(que\s+)?(se\s+)?(tiene|hay)\s+que\s+hacer|que\s+(se\s+)?(tiene|hay)\s+que\s+hacer|que\s+se\s+hace\s+aqui|como\s+funciona\s+esto)/i.test(normalized) ||
      /(que\s+hacemos|a\s+que\s+se\s+juega|para\s+que\s+es\s+esto)/i.test(normalized) ||
      /(tu\s+)?sabes\s+que\s+se\s+tiene/i.test(normalized)) {
    const doReplies = [
      "¿aquí en la sala? nomás cotorrear o platicar un rato jaja",
      "¿hacer de qué? si es aquí en la sala, solo chatear",
      "nomás platicar mientras no se acabe el tiempo jaja",
      "creo que solo pasar el rato y conversar",
    ];
    return doReplies[Math.floor(Math.random() * doReplies.length)];
  }

  // 6. Contexto multi-turno: Exámenes, escuela, cálculo
  const isExamContext =
    /(examen|estudi|reprob|parcial|materia|clase|profesor|profe|calculo|mate|matematicas|fisica|quimica|derivada|integral)/i.test(allPastText) ||
    /(examen|estudi|reprob|parcial|calculo|mate|matematicas|derivada|integral)/i.test(normalized);

  if (isExamContext) {
    if (/(ya\s+estudie|ya\s+repase|si\s+estudie|ya\s+le\s+se|medio\s+estudie|estudie\s+algo|pero\s+ya\s+estudie)/i.test(normalized)) {
      const prepReplies = [
        "ahh bueno, entonces ya vas del otro lado",
        "ahh entonces vas preparado, seguro te va chido",
        "bueno eso da calma jaja, con fe",
        "con eso la armas, ya verás",
      ];
      return prepReplies[Math.floor(Math.random() * prepReplies.length)];
    }

    if (/(no\s+estudie|no\s+se\s+nada|voy\s+a\s+reprobar|me\s+voy\s+a\s+morir|valio\s+madre|valio)/i.test(normalized)) {
      const panicReplies = [
        "no manches jaja, ¿y no alcanzas a repasar un poco?",
        "uff ahí sí está rudo, a rezarle al de arriba jaja",
        "no digas eso jaja, a veces sale mejor de lo que esperas",
        "uy no, toca improvisar durísimo mañana jaja",
      ];
      return panicReplies[Math.floor(Math.random() * panicReplies.length)];
    }

    if (/(derivadas?|integrales?|limites?|matrices|fracciones|vectores|ecuaciones)/i.test(normalized)) {
      const topicReplies = [
        "uff, esas luego se ponen feas jajaja",
        "las derivadas a veces confunden bastante jaja, ¿sí le entiendes?",
        "no inventes, esas tienen su maña jajaja",
        "uy esas luego se enredan un buen jajaja",
      ];
      return topicReplies[Math.floor(Math.random() * topicReplies.length)];
    }

    if (/(calculo|mate|matematicas|algebra|fisica|quimica|historia|programacion|filosofia|derecho|medicina|biologia)/i.test(normalized)) {
      if (/(calculo|mate|matematicas|algebra)/i.test(normalized)) {
        const mathReplies = [
          "uy, ¿qué tema?",
          "uy cálculo, ¿qué tema viene?",
          "no manches, cálculo se pone pesado jaja, ¿qué tema?",
        ];
        return mathReplies[Math.floor(Math.random() * mathReplies.length)];
      } else if (/(fisica|quimica)/i.test(normalized)) {
        return "uy esas materias tienen fórmulas para aventar jaja, ¿qué tema te toca?";
      } else if (/(historia|filosofia|derecho)/i.test(normalized)) {
        return "uff un montón para memorizar y leer, ¿ya te aprendiste casi todo?";
      } else {
        return "no manches, ¿y sí le entiendes bien o está pesado?";
      }
    }

    if (/(tengo\s+examen|mañana\s+tengo|examen\s+mañana|presento\s+examen|tengo\s+parcial)/i.test(normalized)) {
      const examInitReplies = [
        "¿de qué materia?",
        "uy, ¿de qué?",
        "no manches, ¿de qué materia te toca?",
        "uff, ¿de qué es tu examen?",
      ];
      return examInitReplies[Math.floor(Math.random() * examInitReplies.length)];
    }
  }

  // 7. Creador de la página
  if (/(yo\s+(hice|cree|desarrolle|programe)|soy\s+el\s+creador|es\s+mi\s+(pagina|proyecto|sitio))/i.test(normalized)) {
    const creatorReplies = [
      "¿en serio? jaja qué rifado, te quedó muy bien",
      "ah mira qué chido, está buena la dinámica",
      "no manches, ¿tú la programaste? qué padre",
    ];
    return creatorReplies[Math.floor(Math.random() * creatorReplies.length)];
  }

  // 8. Qué es esto
  if (/^(que\s+es\s+esto|q\s+es\s+esto|de\s+que\s+trata\s+esto|que\s+es\s+aqui)\??$/i.test(normalized)) {
    const whatReplies = [
      "¿la sala? es un chat anónimo temporal de 5 minutos jaja",
      "es como un chat efímero donde los mensajes duran 15 segundos",
      "nomás una sala de chat anónima para pasar el rato jaja",
    ];
    return whatReplies[Math.floor(Math.random() * whatReplies.length)];
  }

  // 9. Qué es la pared
  if (/(la\s+pared|el\s+muro)/i.test(normalized) && /(que\s+es|sabes|conoces|de\s+que)/i.test(normalized)) {
    return "es donde la gente deja notas anónimas en el muro";
  }

  // 10. Hay alguien
  if (/(hay\s+alguien|alguien\s+aqui|cuantos\s+somos|cuanta\s+gente)/i.test(normalized)) {
    const peopleReplies = [
      "ahorita nomás estamos tú y yo",
      "por ahora nadie más ha entrado",
      "nomás tú y yo por el momento",
    ];
    return peopleReplies[Math.floor(Math.random() * peopleReplies.length)];
  }

  // 11. Qué haces
  if (/(que\s+haces|q\s+haces|que\s+haces\s+o\s+que)/i.test(normalized)) {
    const doingReplies = [
      "aquí nomás pasando el rato jaja",
      "viendo quién entra a platicar",
      "nada en especial, aquí esperando a ver qué onda",
    ];
    return doingReplies[Math.floor(Math.random() * doingReplies.length)];
  }

  // 12. Cómo estás
  if (/(como\s+estas|como\s+andas|que\s+tal\s+todo)/i.test(normalized)) {
    const howReplies = [
      "todo bien por acá, ¿y tú qué tal?",
      "tranqui, pasando el rato jaja",
      "bien bien, ¿tú qué cuentas?",
    ];
    return howReplies[Math.floor(Math.random() * howReplies.length)];
  }

  // 13. Aburrimiento
  if (/(aburrid|no\s+tengo\s+nada\s+que\s+hacer|que\s+aburrimiento)/i.test(normalized)) {
    const boredReplies = [
      "somos dos jaja, por eso ando aquí",
      "suele pasar jaja, ¿qué estabas haciendo antes?",
      "está tranquilo el día la verdad",
    ];
    return boredReplies[Math.floor(Math.random() * boredReplies.length)];
  }

  // 14. Despedidas
  if (/(me\s+voy|ya\s+me\s+voy|adios|bye|chao|al\s+rato|hasta\s+luego|nos\s+vemos)/i.test(normalized)) {
    const byeReplies = [
      "sale, cuídate",
      "va que va, suerte",
      "va, que te vaya chido",
      "nos vemos, cuídate",
    ];
    return byeReplies[Math.floor(Math.random() * byeReplies.length)];
  }

  // 15. Preguntas abiertas o ambiguas
  if (normalized.includes("?") || /^(por\s+que|pq|como|donde|cuando|cual|quien|de\s+donde)/i.test(normalized)) {
    const clarifyReplies = [
      "¿cómo así?",
      "¿de qué o qué?",
      "¿a qué te refieres con eso?",
      "no sabría decirte la verdad jaja",
      "ni idea jaja, ¿por?",
    ];
    return clarifyReplies[Math.floor(Math.random() * clarifyReplies.length)];
  }

  // 16. Reacciones cortas naturales variadas
  const naturalReplies = [
    "órale, no me la sabía",
    "la neta sí",
    "tiene sentido",
    "qué loco jaja",
    "simón",
    "claro",
    "mira tú",
    "ándale",
  ];
  return naturalReplies[Math.floor(Math.random() * naturalReplies.length)];
}

interface UserSession {
  clientId: string;
  sessionStartedAt: number;
  sessionExpiresAt: number;
}

interface EphemeralMessage {
  id: string;
  text: string;
  timestamp: number;
  durationMs: number;
  senderClientId?: string;
  engine?: "gemini" | "fallback";
  model?: string;
}

interface RoomClient {
  clientId: string;
  ws: WebSocket;
  sessionExpiresAt: number;
}

// Circuit breaker en memoria de la instancia DO para controlar modelos con 429/503
const modelCooldowns = new Map<string, number>();

// Representación de una Sala en vivo dentro del Durable Object
class ActiveRoom {
  id: string;
  clients = new Map<string, RoomClient>();
  activeMessages = new Map<string, EphemeralMessage>();
  conversationContext: Array<{ role: "user" | "ia"; text: string }> = [];
  aiActive = false;
  aiTypingTimeout: any = null;
  messageTimers = new Map<string, any>();

  constructor(id: string) {
    this.id = id;
  }

  get realUserCount(): number {
    return this.clients.size;
  }

  isFull(): boolean {
    return this.clients.size >= MAX_USERS_PER_ROOM;
  }
}

// ============================================================================
// DURABLE OBJECT: SalaRoom
// Actúa como el Coordinador Global y Gestor de Salas en una única instancia
// compartida ("sala_global"), eliminando inconsistencias y desincronizaciones.
// ============================================================================
export class SalaRoom implements DurableObject {
  state: DurableObjectState;
  env: Env;

  // Estado persistente en storage (sesiones de 5m / cooldown 10m)
  sessions = new Map<string, UserSession>();

  // Estado en memoria de salas activas
  rooms = new Map<string, ActiveRoom>();
  clientRoomMap = new Map<string, string>(); // clientId -> roomId

  heartbeatInterval: any = null;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;

    // Cargar sesiones persistentes del almacenamiento SQLite / Storage
    this.state.blockConcurrencyWhile(async () => {
      const storedSessions = await this.state.storage.get<Record<string, UserSession>>("sessions");
      if (storedSessions) {
        for (const [k, v] of Object.entries(storedSessions)) {
          this.sessions.set(k, v);
        }
      }
    });

    // Iniciar verificación continua de expiración de sesiones (5 minutos)
    this.heartbeatInterval = setInterval(() => {
      this.checkExpiredSessions();
    }, 1000);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    const now = Date.now();

    // 1. Endpoint /api/sala/status
    if (url.pathname === "/api/sala/status") {
      const clientId = url.searchParams.get("clientId") || "";
      const status = this.getUserSessionStatus(clientId, now);
      return new Response(JSON.stringify(status), {
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }

    // 2. Endpoint /api/sala/leave
    if (url.pathname === "/api/sala/leave") {
      let clientId = url.searchParams.get("clientId") || "";
      if (!clientId && request.method === "POST") {
        try {
          const body: any = await request.json();
          clientId = body.clientId || "";
        } catch (_) {}
      }
      this.leaveRoom(clientId);
      const status = this.getUserSessionStatus(clientId, now);
      return new Response(JSON.stringify({ success: true, ...status }), {
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }

    // 3. Endpoint WebSocket /api/sala/ws?clientId=...
    if (url.pathname === "/api/sala/ws") {
      const upgradeHeader = request.headers.get("Upgrade");
      if (!upgradeHeader || upgradeHeader.toLowerCase() !== "websocket") {
        return new Response("Expected WebSocket", { status: 426, headers: corsHeaders });
      }

      const clientId = url.searchParams.get("clientId");
      if (!clientId) {
        return new Response("Missing clientId", { status: 400, headers: corsHeaders });
      }

      // Validar ventana de sesión y cooldown de 10 min
      const sessionCheck = this.startOrResumeUserSession(clientId, now);
      if (!sessionCheck.allowed) {
        const pair = new WebSocketPair();
        const [clientWs, serverWs] = Object.values(pair);
        serverWs.accept();
        serverWs.send(
          JSON.stringify({
            type: "in_cooldown",
            remainingCooldownSeconds: sessionCheck.remainingCooldownSeconds,
          })
        );
        serverWs.close(4002, "In cooldown");
        return new Response(null, { status: 101, webSocket: clientWs });
      }

      // Crear par WebSocket para el cliente
      const pair = new WebSocketPair();
      const [clientWs, serverWs] = Object.values(pair);
      serverWs.accept();

      // Emparejar en sala disponible (< 5 usuarios)
      this.handleClientWebSocket(clientId, serverWs, sessionCheck.sessionExpiresAt);

      return new Response(null, { status: 101, webSocket: clientWs });
    }

    return new Response("La Sala Cloudflare Worker - Operativo", { status: 200, headers: corsHeaders });
  }

  // --------------------------------------------------------------------------
  // Control de Sesiones y Cooldown
  // --------------------------------------------------------------------------
  getUserSessionStatus(clientId: string, now: number) {
    const session = this.sessions.get(clientId);
    if (!session) {
      return {
        inCooldown: false,
        remainingCooldownSeconds: 0,
        sessionActive: false,
        remainingSessionSeconds: Math.floor(SESSION_DURATION_MS / 1000),
      };
    }

    // Sesión activa en curso
    if (now < session.sessionExpiresAt) {
      return {
        inCooldown: false,
        remainingCooldownSeconds: 0,
        sessionActive: true,
        remainingSessionSeconds: Math.max(1, Math.ceil((session.sessionExpiresAt - now) / 1000)),
      };
    }

    // Sesión expirada, en cooldown estricto de 10 min
    const cooldownExpiresAt = session.sessionExpiresAt + COOLDOWN_DURATION_MS;
    if (now < cooldownExpiresAt) {
      return {
        inCooldown: true,
        remainingCooldownSeconds: Math.max(1, Math.ceil((cooldownExpiresAt - now) / 1000)),
        sessionActive: false,
        remainingSessionSeconds: 0,
      };
    }

    // Cooldown finalizado
    return {
      inCooldown: false,
      remainingCooldownSeconds: 0,
      sessionActive: false,
      remainingSessionSeconds: Math.floor(SESSION_DURATION_MS / 1000),
    };
  }

  startOrResumeUserSession(clientId: string, now: number) {
    let session = this.sessions.get(clientId);

    if (session) {
      const cooldownExpiresAt = session.sessionExpiresAt + COOLDOWN_DURATION_MS;
      // En cooldown de 10 min: rechazar
      if (now >= session.sessionExpiresAt && now < cooldownExpiresAt) {
        return {
          allowed: false,
          remainingSessionSeconds: 0,
          remainingCooldownSeconds: Math.max(1, Math.ceil((cooldownExpiresAt - now) / 1000)),
          sessionExpiresAt: session.sessionExpiresAt,
        };
      }

      // Sesión aún válida dentro de sus 5 min: reanudar
      if (now < session.sessionExpiresAt) {
        return {
          allowed: true,
          remainingSessionSeconds: Math.max(1, Math.ceil((session.sessionExpiresAt - now) / 1000)),
          remainingCooldownSeconds: 0,
          sessionExpiresAt: session.sessionExpiresAt,
        };
      }
    }

    // Nueva sesión de 5 minutos
    const sessionExpiresAt = now + SESSION_DURATION_MS;
    session = {
      clientId,
      sessionStartedAt: now,
      sessionExpiresAt,
    };
    this.sessions.set(clientId, session);
    this.saveSessionsToStorage();

    return {
      allowed: true,
      remainingSessionSeconds: Math.floor(SESSION_DURATION_MS / 1000),
      remainingCooldownSeconds: 0,
      sessionExpiresAt,
    };
  }

  async saveSessionsToStorage() {
    const obj: Record<string, UserSession> = {};
    for (const [k, v] of this.sessions.entries()) {
      obj[k] = v;
    }
    await this.state.storage.put("sessions", obj);
  }

  checkExpiredSessions() {
    const now = Date.now();
    for (const room of this.rooms.values()) {
      for (const [cId, client] of room.clients.entries()) {
        if (now >= client.sessionExpiresAt) {
          const cooldownExpiresAt = client.sessionExpiresAt + COOLDOWN_DURATION_MS;
          const remainingCooldown = Math.max(1, Math.ceil((cooldownExpiresAt - now) / 1000));
          try {
            client.ws.send(
              JSON.stringify({
                type: "session_expired",
                remainingCooldownSeconds: remainingCooldown,
              })
            );
            client.ws.close(4001, "Session Expired");
          } catch (_) {}
          this.leaveRoom(cId);
        }
      }
    }
  }

  // --------------------------------------------------------------------------
  // Matchmaking Global de Salas (Máximo 5 usuarios por sala)
  // --------------------------------------------------------------------------
  getOrCreateAvailableRoom(): ActiveRoom {
    // 1. Buscar primero una sala existente con espacio disponible (< 5 usuarios reales)
    for (const room of this.rooms.values()) {
      if (!room.isFull()) {
        return room;
      }
    }

    // 2. Si no hay salas disponibles o todas están llenas, crear una nueva sala
    const newRoomId = "sala_" + Math.random().toString(36).substring(2, 9);
    const newRoom = new ActiveRoom(newRoomId);
    this.rooms.set(newRoomId, newRoom);
    return newRoom;
  }

  joinRoom(clientId: string, ws: WebSocket, sessionExpiresAt: number): ActiveRoom {
    const existingRoomId = this.clientRoomMap.get(clientId);
    let room: ActiveRoom | undefined;

    // Si el usuario ya estaba registrado en una sala (ej. reconexión / recarga)
    if (existingRoomId && this.rooms.has(existingRoomId)) {
      room = this.rooms.get(existingRoomId)!;
      const oldClient = room.clients.get(clientId);
      if (oldClient && oldClient.ws !== ws) {
        try {
          oldClient.ws.close(1000, "Reconnected");
        } catch (_) {}
      }
      room.clients.set(clientId, { clientId, ws, sessionExpiresAt });
    } else {
      // Si no estaba en ninguna sala, buscar una con espacio o crear una nueva
      this.leaveRoom(clientId);
      room = this.getOrCreateAvailableRoom();
      room.clients.set(clientId, { clientId, ws, sessionExpiresAt });
      this.clientRoomMap.set(clientId, room.id);
    }

    this.handleParticipantCountChange(room);
    return room;
  }

  leaveRoom(clientId: string) {
    const roomId = this.clientRoomMap.get(clientId);
    if (!roomId) return;

    this.clientRoomMap.delete(clientId);
    const room = this.rooms.get(roomId);
    if (room) {
      room.clients.delete(clientId);
      this.handleParticipantCountChange(room);

      // Si la sala queda completamente vacía, limpiar timers y destruirla
      if (room.realUserCount === 0) {
        for (const timer of room.messageTimers.values()) {
          clearTimeout(timer);
        }
        room.messageTimers.clear();
        if (room.aiTypingTimeout) {
          clearTimeout(room.aiTypingTimeout);
          room.aiTypingTimeout = null;
        }
        this.rooms.delete(roomId);
      }
    }
  }

  // --------------------------------------------------------------------------
  // Gestión de Presencia de la IA en Sala
  // --------------------------------------------------------------------------
  handleParticipantCountChange(room: ActiveRoom) {
    const count = room.realUserCount;

    if (count === 1) {
      // EXACTAMENTE 1 USUARIO REAL: ENTRA LA IA
      if (!room.aiActive) {
        room.aiActive = true;
        this.scheduleAiInitialGreeting(room);
      }
    } else {
      // 2 O MÁS USUARIOS REALES (O SALA VACÍA): LA IA SE RETIRA DE INMEDIATO
      if (room.aiActive) {
        room.aiActive = false;
        if (room.aiTypingTimeout) {
          clearTimeout(room.aiTypingTimeout);
          room.aiTypingTimeout = null;
        }
        room.conversationContext = [];
      }
      if (count === 0) {
        room.conversationContext = [];
        room.activeMessages.clear();
      }
    }
  }

  scheduleAiInitialGreeting(room: ActiveRoom) {
    if (room.conversationContext.length === 0) {
      room.aiTypingTimeout = setTimeout(() => {
        if (room.aiActive && room.realUserCount === 1 && room.conversationContext.length === 0) {
          const idx = Math.floor(Math.random() * INITIAL_GREETINGS.length);
          this.addMessage(room, INITIAL_GREETINGS[idx], true, undefined, "fallback");
        }
      }, 2500);
    }
  }

  // --------------------------------------------------------------------------
  // Emisión de Mensajes y Ciclo Efímero (15 Segundos)
  // --------------------------------------------------------------------------
  broadcast(room: ActiveRoom, payload: any, excludeClientId?: string) {
    const raw = JSON.stringify(payload);
    for (const [cId, client] of room.clients.entries()) {
      if (excludeClientId && cId === excludeClientId) continue;
      try {
        client.ws.send(raw);
      } catch (_) {}
    }
  }

  addMessage(
    room: ActiveRoom,
    text: string,
    isFromAi = false,
    senderClientId?: string,
    engine?: "gemini" | "fallback",
    model?: string
  ) {
    const msgId = "msg_" + Math.random().toString(36).substring(2, 9) + Date.now();
    const message: EphemeralMessage = {
      id: msgId,
      text,
      timestamp: Date.now(),
      durationMs: MESSAGE_LIFESPAN_MS,
      senderClientId: isFromAi ? undefined : senderClientId,
      engine: isFromAi ? engine : undefined,
      model: isFromAi ? model : undefined,
    };

    room.activeMessages.set(msgId, message);

    // Contexto conversacional efímero para Gemini (solo cuando hay 1 usuario real)
    if (room.realUserCount === 1) {
      room.conversationContext.push({
        role: isFromAi ? "ia" : "user",
        text,
      });
      if (room.conversationContext.length > 10) {
        room.conversationContext.shift();
      }
    }

    // Broadcast inmediato a todos los participantes conectados a la sala
    this.broadcast(room, {
      type: "message_new",
      message,
    });

    // Expiración estricta a los 15 segundos
    const timer = setTimeout(() => {
      room.activeMessages.delete(msgId);
      room.messageTimers.delete(msgId);
      this.broadcast(room, {
        type: "message_expired",
        id: msgId,
      });
    }, MESSAGE_LIFESPAN_MS);
    room.messageTimers.set(msgId, timer);

    // Evaluar participación de la IA ÚNICAMENTE si hay exactamente 1 usuario real
    if (!isFromAi && room.aiActive && room.realUserCount === 1) {
      this.evaluateAiParticipation(room, text);
    }
  }

  evaluateAiParticipation(room: ActiveRoom, userMessage: string) {
    const trimmed = userMessage.trim();

    // 1. Pregunta sobre identidad de IA: responder siempre con honestidad
    const isIdentityQuestion =
      /(\beres\b.*\b(ia|ai|bot|robot|humano|humana|persona|real)\b|\bque\b\s+eres\b|\bquien\b\s+eres\b)/i.test(trimmed);

    if (isIdentityQuestion) {
      this.scheduleAiResponse(room, userMessage);
      return;
    }

    // 2. Cierres monosilábicos: dejar respirar
    const isClosure = /^(ok|vale|ya|ah|ahh|bueno|sip|nop|👍|va|sale)$/i.test(trimmed);
    if (isClosure) return;

    // 3. Preguntas o temas relevantes
    const isQuestionOrTopic =
      trimmed.includes("?") ||
      trimmed.includes("¿") ||
      /^(hola|buenas|que onda|q onda|que tal|q tal|que haces|q haces|de donde|como estas|como andas|quien|cuantos|cuanta|por que|pq)/i.test(trimmed) ||
      /(la pared|el muro|la sala|yo hice|mi proyecto|aburrid|examen|program|estudi)/i.test(trimmed);

    let shouldRespond = true;
    if (/^(jaja|jajaja|xd|jjsjs)$/i.test(trimmed)) {
      shouldRespond = Math.random() < 0.60;
    } else if (!isQuestionOrTopic) {
      shouldRespond = Math.random() < 0.75;
    }

    if (shouldRespond) {
      this.scheduleAiResponse(room, userMessage);
    }
  }

  scheduleAiResponse(room: ActiveRoom, userMessage: string) {
    if (room.aiTypingTimeout) {
      clearTimeout(room.aiTypingTimeout);
    }

    const delay = 800 + Math.random() * 800;
    room.aiTypingTimeout = setTimeout(() => {
      if (room.aiActive && room.realUserCount === 1) {
        this.generateAiMessage(room, userMessage);
      }
    }, delay);
  }

  async generateAiMessage(room: ActiveRoom, userPrompt?: string) {
    // Si ya entraron más personas o la sala quedó vacía, abortar inmediatamente
    if (!room.aiActive || room.realUserCount !== 1) return;

    let aiText = "";
    let usedEngine: "gemini" | "fallback" = "fallback";
    let usedModel: string | undefined = undefined;

    if (this.env.GEMINI_API_KEY) {
      try {
        const past = room.conversationContext.filter(
          (m, idx) => !(idx === room.conversationContext.length - 1 && m.text.trim() === (userPrompt || "").trim())
        ).slice(-6);

        const structuredContents: Array<{ role: "user" | "model"; parts: Array<{ text: string }> }> = [];
        const historyRolesSummary: string[] = [];

        for (const m of past) {
          const role = m.role === "ia" ? "model" : "user";
          structuredContents.push({
            role,
            parts: [{ text: m.text }],
          });
          historyRolesSummary.push(role);
        }

        const promptLen = (userPrompt || "").length;
        if (userPrompt) {
          structuredContents.push({
            role: "user",
            parts: [{ text: userPrompt }],
          });
        } else {
          structuredContents.push({
            role: "user",
            parts: [{ text: "hola" }],
          });
        }

        console.log(
          `[DIAGNÓSTICO LA SALA] Turno entrante | Historial recibido: ${past.length} turnos previas [${historyRolesSummary.join(" -> ") || "ninguna"}] | Longitud prompt: ${promptLen} chars`
        );

        const modelsToTry = [
          "gemini-3.5-flash",
          "gemini-3.1-flash-lite-preview",
          "gemini-3.1-flash-lite",
          "gemini-3.8-flash",
        ];

        let lastAttemptedModel = "";
        const modelErrors: Array<{ model: string; code: string | number; message: string }> = [];

        for (const model of modelsToTry) {
          const cooldownUntil = modelCooldowns.get(model) || 0;
          if (Date.now() < cooldownUntil) {
            console.log(`[DIAGNÓSTICO LA SALA] Modelo ${model} en enfriamiento activo.`);
            continue;
          }

          if (lastAttemptedModel && lastAttemptedModel !== model) {
            console.log(`[DIAGNÓSTICO LA SALA] Cambio automático de modelo: pasando a ${model}.`);
          }
          lastAttemptedModel = model;

          try {
            console.log(`[DIAGNÓSTICO LA SALA] Consultando modelo Gemini: ${model}...`);

            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 4500);

            const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${this.env.GEMINI_API_KEY}`;
            const apiRes = await fetch(endpoint, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "User-Agent": "aistudio-build",
              },
              body: JSON.stringify({
                contents: structuredContents,
                systemInstruction: {
                  parts: [{ text: AI_SYSTEM_PROMPT }],
                },
                generationConfig: {
                  temperature: 0.85,
                  maxOutputTokens: 120,
                },
              }),
              signal: controller.signal,
            });

            clearTimeout(timeoutId);

            if (!apiRes.ok) {
              const errBody: any = await apiRes.json().catch(() => ({}));
              const errCode = apiRes.status;
              const errMsg = errBody?.error?.message || apiRes.statusText;
              throw { status: errCode, message: errMsg };
            }

            const data: any = await apiRes.json();
            const raw = data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || "";
            if (raw) {
              aiText = raw.replace(/^["']|["']$/g, "").replace(/\n+/g, " ").trim().slice(0, 180);
              usedEngine = "gemini";
              usedModel = model;
              console.log(`[DIAGNÓSTICO LA SALA] ÉXITO: Respuesta generada por Gemini | Modelo: ${model} | Longitud: ${aiText.length} chars`);
              break;
            }
          } catch (err: any) {
            const isAbort = err?.name === "AbortError" || err?.message === "Timeout";
            const status = isAbort ? "TIMEOUT" : (err?.status || err?.code || "UNKNOWN_ERROR");
            const errorMsg = isAbort ? "Timeout 4500ms" : (err?.message?.slice(0, 80) || "Sin detalle");
            modelErrors.push({ model, code: status, message: errorMsg });

            if (status === 429) {
              modelCooldowns.set(model, Date.now() + 5 * 60 * 1000);
            } else if (status === 503) {
              modelCooldowns.set(model, Date.now() + 30 * 1000);
            } else {
              modelCooldowns.set(model, Date.now() + 15 * 1000);
            }
            console.log(`[DIAGNÓSTICO LA SALA] Error en modelo ${model} -> Código: ${status} | Causa: ${errorMsg}`);
          }
        }
      } catch (err: any) {
        console.log("[DIAGNÓSTICO LA SALA] Excepción en llamada a Gemini:", err?.message || err);
      }
    }

    // Motor de respaldo inteligente contextual si Gemini no está configurado o falla
    if (!aiText) {
      console.log(`[DIAGNÓSTICO LA SALA] Derivando a getContextualFallback | Motor: FALLBACK`);
      aiText = getContextualFallback(userPrompt, room.conversationContext);
      usedEngine = "fallback";
      usedModel = undefined;
    }

    // Confirmar que sigue habiendo exactamente 1 usuario real antes de enviar
    if (room.aiActive && room.realUserCount === 1 && aiText) {
      this.addMessage(room, aiText, true, undefined, usedEngine, usedModel);
    }
  }

  // --------------------------------------------------------------------------
  // Manejador del ciclo de vida WebSocket por cliente
  // --------------------------------------------------------------------------
  handleClientWebSocket(clientId: string, ws: WebSocket, sessionExpiresAt: number) {
    const room = this.joinRoom(clientId, ws, sessionExpiresAt);

    // Enviar sincronización inicial al cliente que se conecta
    const now = Date.now();
    const remainingSec = Math.max(1, Math.ceil((sessionExpiresAt - now) / 1000));
    const activeList = Array.from(room.activeMessages.values()).map((m) => {
      const elapsed = now - m.timestamp;
      const remaining = Math.max(0, m.durationMs - elapsed);
      return { ...m, durationMs: remaining };
    });

    ws.send(
      JSON.stringify({
        type: "session_init",
        remainingSessionSeconds: remainingSec,
        activeMessages: activeList,
      })
    );

    // Escuchar mensajes entrantes del cliente
    ws.addEventListener("message", (event) => {
      try {
        const data = JSON.parse(event.data as string);

        if (data.type === "leave_sala") {
          this.leaveRoom(clientId);
          ws.close(1000, "User Left");
          return;
        }

        if (data.type === "send_message") {
          const clientData = room.clients.get(clientId);
          if (!clientData || Date.now() >= clientData.sessionExpiresAt) {
            ws.send(JSON.stringify({ type: "error", error: "Tu tiempo en La Sala ha terminado." }));
            return;
          }

          const text = (data.text || "").trim();
          if (!text || text.length > 180) {
            ws.send(JSON.stringify({ type: "error", error: "El mensaje debe tener entre 1 y 180 caracteres." }));
            return;
          }

          const urlRegex = /(https?:\/\/|www\.|\.com|\.org|\.net|\.io|\.me)/i;
          if (urlRegex.test(text)) {
            ws.send(JSON.stringify({ type: "error", error: "No se permiten enlaces en La Sala." }));
            return;
          }

          // Emitir a la sala
          this.addMessage(room, text, false, clientId);
        }
      } catch (_) {}
    });

    ws.addEventListener("close", () => {
      const cur = room.clients.get(clientId);
      if (cur && cur.ws === ws) {
        this.leaveRoom(clientId);
      }
    });

    ws.addEventListener("error", () => {
      const cur = room.clients.get(clientId);
      if (cur && cur.ws === ws) {
        this.leaveRoom(clientId);
      }
    });
  }
}

// ============================================================================
// WORKER ENTRY POINT
// Todas las conexiones enrutan a la instancia compartida "sala_global"
// ============================================================================
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const globalId = env.SALA_ROOM.idFromName("sala_global");
    const salaStub = env.SALA_ROOM.get(globalId);
    return salaStub.fetch(request);
  },
};
