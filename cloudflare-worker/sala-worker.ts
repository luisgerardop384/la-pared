/**
 * CLOUDFLARE WORKERS + DURABLE OBJECTS + WEBSOCKETS + GEMINI API
 * Implementación de servidor para "La Sala" en Cloudflare Workers.
 *
 * Características:
 * - Matchmaking automático: salas independientes con tope estricto de máximo 5 usuarios reales por sala.
 * - Totalmente anónimo: no se transmiten nombres, avatares ni IDs personales en los mensajes.
 * - Autoridad del servidor sobre sesiones:
 *   - Ventana estricta de 5 minutos (300 s) por sesión desde el ingreso inicial.
 *   - Si el usuario se desconecta o recarga, el tiempo de sesión sigue corriendo en el servidor y puede reanudarlo.
 *   - Al llegar a 00:00 (5 min completos), se cierra la conexión y se activa una espera obligatoria (cooldown)
 *     inquebrantable de exactamente 10 minutos (600 s) protegida por el servidor.
 *   - Los datos de sesión persisten en el storage del Durable Object para resistir reinicios o cold-starts.
 * - Mensajes efímeros de exactamente 15 segundos: se autodestruyen en memoria y notifican a los clientes (0 persistencia).
 * - IA conversacional de servidor (Gemini API):
 *   - Activa únicamente si hay exactamente 1 usuario real en la sala.
 *   - Si entra una segunda persona o la sala queda vacía, la IA sale de inmediato y cancela acciones.
 *   - Saludo casual a los 2.5s si la sala está vacía.
 *   - Personalidad 100% idéntica a server.ts (casual, breve, proporción natural, honesta si preguntan si es IA).
 *   - Cascada de modelos (gemini-3.5-flash prioritario) con circuit breaker para errores 429 / 503 / timeouts.
 *   - Motor de respaldo inteligente contextual idéntico con normalización de diacríticos y seguimiento temático.
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

// Motor de respaldo contextual multi-turno idéntico a server.ts
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

// Circuit breaker en memoria de la instancia DO para controlar modelos con 429/503
const modelCooldowns = new Map<string, number>();

// ============================================================================
// WORKER ENTRY POINT (Enrutador global y Matchmaking)
// ============================================================================
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // Cabeceras CORS para comunicación segura desde la app web
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    // Instancia única del Coordinador Global (gestión de sesiones y matchmaking de salas)
    const coordinatorId = env.SALA_ROOM.idFromName("global_coordinator");
    const coordinatorStub = env.SALA_ROOM.get(coordinatorId);

    // 1. Endpoint /api/sala/status
    if (url.pathname === "/api/sala/status") {
      const response = await coordinatorStub.fetch(request);
      const data = await response.text();
      return new Response(data, {
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }

    // 2. Endpoint /api/sala/leave
    if (url.pathname === "/api/sala/leave") {
      const response = await coordinatorStub.fetch(request);
      const data = await response.text();
      return new Response(data, {
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

      // Validar sesión y matchmaking con el coordinador
      const matchRequest = new Request("http://internal/coordinator/match", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clientId }),
      });
      const matchRes = await coordinatorStub.fetch(matchRequest);
      const matchData: any = await matchRes.json();

      if (!matchData.allowed) {
        // Enviar respuesta en cooldown
        const pair = new WebSocketPair();
        const [clientWs, serverWs] = Object.values(pair);
        serverWs.accept();
        serverWs.send(
          JSON.stringify({
            type: "in_cooldown",
            remainingCooldownSeconds: matchData.remainingCooldownSeconds,
          })
        );
        serverWs.close(4002, "In cooldown");
        return new Response(null, { status: 101, webSocket: clientWs });
      }

      // Redirigir el WebSocket al Durable Object específico de la sala asignada (< 5 usuarios)
      const roomId = matchData.roomId;
      const roomStub = env.SALA_ROOM.get(env.SALA_ROOM.idFromName("room_" + roomId));

      const roomWsRequest = new Request(request.url, {
        headers: {
          ...Object.fromEntries(request.headers.entries()),
          "X-Sala-Room-Id": roomId,
          "X-Sala-Session-Expires": String(matchData.sessionExpiresAt),
        },
      });

      return roomStub.fetch(roomWsRequest);
    }

    return new Response("La Sala Cloudflare Worker - Operativo", { status: 200, headers: corsHeaders });
  },
};

// ============================================================================
// DURABLE OBJECT: SalaRoom
// Actúa en 2 roles según su ID:
// 1) "global_coordinator": Administra sesiones de 5m/cooldown 10m y matchmaking (< 5 usuarios).
// 2) "room_<id>": Maneja la sala en vivo, WebSockets, mensajes efímeros 15s y Gemini IA.
// ============================================================================
export class SalaRoom implements DurableObject {
  state: DurableObjectState;
  env: Env;
  isCoordinator: boolean = false;

  // Estado del Coordinador (persiste en storage)
  sessions = new Map<string, UserSession>();
  roomOccupancy = new Map<string, number>(); // roomId -> count

  // Estado de Sala Individual (en memoria en vivo de la sala)
  roomId: string = "";
  activeClients = new Map<string, { ws: WebSocket; sessionExpiresAt: number }>();
  activeMessages = new Map<string, EphemeralMessage>();
  conversationContext: Array<{ role: "user" | "ia"; text: string }> = [];
  aiActive = false;
  aiTypingTimeout: any = null;
  heartbeatInterval: any = null;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;

    // Cargar sesiones persistentes del storage si es el coordinador
    this.state.blockConcurrencyWhile(async () => {
      const storedSessions = await this.state.storage.get<Record<string, UserSession>>("sessions");
      if (storedSessions) {
        for (const [k, v] of Object.entries(storedSessions)) {
          this.sessions.set(k, v);
        }
      }
    });
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // ========================================================================
    // A) MODO COORDINADOR
    // ========================================================================
    if (url.pathname.startsWith("/coordinator/") || url.pathname === "/api/sala/status" || url.pathname === "/api/sala/leave") {
      this.isCoordinator = true;
      return this.handleCoordinatorRequest(request, url);
    }

    // ========================================================================
    // B) MODO SALA INDIVIDUAL
    // ========================================================================
    this.roomId = request.headers.get("X-Sala-Room-Id") || "default";
    const clientId = url.searchParams.get("clientId");
    const sessionExpiresAt = Number(request.headers.get("X-Sala-Session-Expires")) || (Date.now() + SESSION_DURATION_MS);

    if (url.pathname === "/api/sala/ws") {
      if (!clientId) {
        return new Response("Missing clientId", { status: 400 });
      }

      const pair = new WebSocketPair();
      const [clientWs, serverWs] = Object.values(pair);
      serverWs.accept();

      this.handleRoomWebSocket(clientId, serverWs, sessionExpiresAt);

      return new Response(null, { status: 101, webSocket: clientWs });
    }

    return new Response("Not found", { status: 404 });
  }

  // --------------------------------------------------------------------------
  // Lógica del Coordinador (Sesiones, Cooldown y Matchmaking de Salas)
  // --------------------------------------------------------------------------
  async handleCoordinatorRequest(request: Request, url: URL): Promise<Response> {
    const now = Date.now();

    // 1. Status Check
    if (url.pathname === "/api/sala/status") {
      const clientId = url.searchParams.get("clientId") || "";
      const status = this.getUserSessionStatus(clientId, now);
      return Response.json(status);
    }

    // 2. Leave Presence
    if (url.pathname === "/api/sala/leave") {
      let clientId = url.searchParams.get("clientId") || "";
      if (!clientId && request.method === "POST") {
        try {
          const body: any = await request.json();
          clientId = body.clientId || "";
        } catch (_) {}
      }
      const status = this.getUserSessionStatus(clientId, now);
      return Response.json({ success: true, ...status });
    }

    // 3. Matchmaking interno para asignar sala con < 5 usuarios
    if (url.pathname === "/coordinator/match") {
      const body: any = await request.json();
      const clientId = body.clientId || "";

      const check = this.startOrResumeUserSession(clientId, now);
      if (!check.allowed) {
        return Response.json({
          allowed: false,
          remainingCooldownSeconds: check.remainingCooldownSeconds,
        });
      }

      // Buscar sala activa con < 5 participantes
      let assignedRoomId = "";
      for (const [rId, count] of this.roomOccupancy.entries()) {
        if (count < MAX_USERS_PER_ROOM) {
          assignedRoomId = rId;
          break;
        }
      }

      if (!assignedRoomId) {
        assignedRoomId = "sala_" + Math.random().toString(36).substring(2, 8);
      }

      return Response.json({
        allowed: true,
        roomId: assignedRoomId,
        sessionExpiresAt: check.sessionExpiresAt,
        remainingSessionSeconds: check.remainingSessionSeconds,
      });
    }

    // 4. Actualización de ocupación enviada por una sala
    if (url.pathname === "/coordinator/update-occupancy") {
      const body: any = await request.json();
      const rId = body.roomId;
      const count = body.count;
      if (count <= 0) {
        this.roomOccupancy.delete(rId);
      } else {
        this.roomOccupancy.set(rId, count);
      }
      return Response.json({ success: true });
    }

    return new Response("Unknown coordinator command", { status: 404 });
  }

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

    // 1. Sesión activa en curso
    if (now < session.sessionExpiresAt) {
      return {
        inCooldown: false,
        remainingCooldownSeconds: 0,
        sessionActive: true,
        remainingSessionSeconds: Math.max(1, Math.ceil((session.sessionExpiresAt - now) / 1000)),
      };
    }

    // 2. Sesión expirada, en cooldown estricto de 10 min
    const cooldownExpiresAt = session.sessionExpiresAt + COOLDOWN_DURATION_MS;
    if (now < cooldownExpiresAt) {
      return {
        inCooldown: true,
        remainingCooldownSeconds: Math.max(1, Math.ceil((cooldownExpiresAt - now) / 1000)),
        sessionActive: false,
        remainingSessionSeconds: 0,
      };
    }

    // 3. Cooldown finalizado
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
      // En cooldown: rechazar
      if (now >= session.sessionExpiresAt && now < cooldownExpiresAt) {
        return {
          allowed: false,
          remainingSessionSeconds: 0,
          remainingCooldownSeconds: Math.max(1, Math.ceil((cooldownExpiresAt - now) / 1000)),
          sessionExpiresAt: session.sessionExpiresAt,
        };
      }

      // Sesión aún válida: reanudar
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

    // Persistir en storage del Durable Object
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

  // --------------------------------------------------------------------------
  // Lógica de Sala Individual (WebSockets, Mensajes Efímeros 15s y Gemini)
  // --------------------------------------------------------------------------
  handleRoomWebSocket(clientId: string, ws: WebSocket, sessionExpiresAt: number) {
    this.activeClients.set(clientId, { ws, sessionExpiresAt });
    this.notifyOccupancyChange();
    this.evaluateParticipantCount();

    // Inicializar sesión y sincronizar mensajes activos con tiempo restante
    const now = Date.now();
    const remainingSec = Math.max(1, Math.ceil((sessionExpiresAt - now) / 1000));
    const activeList = Array.from(this.activeMessages.values()).map((m) => {
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

    // Heartbeat periódico para verificar fin de sesión de 5 minutos
    if (!this.heartbeatInterval) {
      this.heartbeatInterval = setInterval(() => {
        const curTime = Date.now();
        for (const [cId, client] of this.activeClients.entries()) {
          if (curTime >= client.sessionExpiresAt) {
            const cooldownExpiresAt = client.sessionExpiresAt + COOLDOWN_DURATION_MS;
            const remainingCooldown = Math.max(1, Math.ceil((cooldownExpiresAt - curTime) / 1000));
            try {
              client.ws.send(
                JSON.stringify({
                  type: "session_expired",
                  remainingCooldownSeconds: remainingCooldown,
                })
              );
              client.ws.close(4001, "Session Expired");
            } catch (_) {}
            this.activeClients.delete(cId);
            this.notifyOccupancyChange();
            this.evaluateParticipantCount();
          }
        }
      }, 1000);
    }

    // Receptor de mensajes del cliente
    ws.addEventListener("message", (event) => {
      try {
        const data = JSON.parse(event.data as string);

        if (data.type === "leave_sala") {
          this.activeClients.delete(clientId);
          this.notifyOccupancyChange();
          this.evaluateParticipantCount();
          ws.close(1000, "User Left");
          return;
        }

        if (data.type === "send_message") {
          const clientData = this.activeClients.get(clientId);
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

          // Agregar mensaje de usuario y emitir
          this.addMessage(text, false, clientId);
        }
      } catch (_) {}
    });

    ws.addEventListener("close", () => {
      this.activeClients.delete(clientId);
      this.notifyOccupancyChange();
      this.evaluateParticipantCount();
    });

    ws.addEventListener("error", () => {
      this.activeClients.delete(clientId);
      this.notifyOccupancyChange();
      this.evaluateParticipantCount();
    });
  }

  notifyOccupancyChange() {
    const coordinatorId = this.env.SALA_ROOM.idFromName("global_coordinator");
    const coordinatorStub = this.env.SALA_ROOM.get(coordinatorId);
    coordinatorStub.fetch(
      new Request("http://internal/coordinator/update-occupancy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ roomId: this.roomId, count: this.activeClients.size }),
      })
    ).catch(() => {});
  }

  broadcast(payload: any) {
    const raw = JSON.stringify(payload);
    for (const client of this.activeClients.values()) {
      try {
        client.ws.send(raw);
      } catch (_) {}
    }
  }

  addMessage(
    text: string,
    isFromAi = false,
    senderClientId?: string,
    engine?: "gemini" | "fallback",
    model?: string
  ) {
    const msgId = "msg_" + Math.random().toString(36).substring(2, 9) + Date.now();
    const msg: EphemeralMessage = {
      id: msgId,
      text,
      timestamp: Date.now(),
      durationMs: MESSAGE_LIFESPAN_MS,
      senderClientId: isFromAi ? undefined : senderClientId,
      engine: isFromAi ? engine : undefined,
      model: isFromAi ? model : undefined,
    };

    this.activeMessages.set(msgId, msg);

    // Contexto conversacional efímero
    this.conversationContext.push({
      role: isFromAi ? "ia" : "user",
      text,
    });
    if (this.conversationContext.length > 10) {
      this.conversationContext.shift();
    }

    // Broadcast inmediato
    this.broadcast({
      type: "message_new",
      message: msg,
    });

    // Expiración estricta a los 15 segundos
    setTimeout(() => {
      this.activeMessages.delete(msgId);
      this.broadcast({
        type: "message_expired",
        id: msgId,
      });
    }, MESSAGE_LIFESPAN_MS);

    // Si es mensaje de usuario y la IA está activa (1 usuario real), evaluar participación
    if (!isFromAi && this.aiActive && this.activeClients.size === 1) {
      this.evaluateAiParticipation(text);
    }
  }

  evaluateParticipantCount() {
    const count = this.activeClients.size;
    if (count === 1) {
      if (!this.aiActive) {
        this.aiActive = true;
        this.scheduleAiGreeting();
      }
    } else {
      if (this.aiActive) {
        this.aiActive = false;
        if (this.aiTypingTimeout) {
          clearTimeout(this.aiTypingTimeout);
          this.aiTypingTimeout = null;
        }
        this.conversationContext = [];
      }
      if (count === 0) {
        this.conversationContext = [];
        this.activeMessages.clear();
      }
    }
  }

  scheduleAiGreeting() {
    if (this.conversationContext.length === 0) {
      this.aiTypingTimeout = setTimeout(() => {
        if (this.aiActive && this.activeClients.size === 1 && this.conversationContext.length === 0) {
          const idx = Math.floor(Math.random() * INITIAL_GREETINGS.length);
          this.addMessage(INITIAL_GREETINGS[idx], true);
        }
      }, 2500);
    }
  }

  evaluateAiParticipation(userMessage: string) {
    const trimmed = userMessage.trim();

    // 1. Pregunta sobre identidad de IA: responder siempre con honestidad
    const isIdentityQuestion =
      /(\beres\b.*\b(ia|ai|bot|robot|humano|humana|persona|real)\b|\bque\b\s+eres\b|\bquien\b\s+eres\b)/i.test(trimmed);

    if (isIdentityQuestion) {
      this.scheduleAiResponse(userMessage);
      return;
    }

    // 2. Cierres monosilábicos: dejar respirar
    const isClosure = /^(ok|vale|ya|ah|ahh|bueno|sip|nop|👍|va|sale)$/i.test(trimmed);
    if (isClosure) return;

    // 3. Preguntas o temas
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
      this.scheduleAiResponse(userMessage);
    }
  }

  scheduleAiResponse(userMessage: string) {
    if (this.aiTypingTimeout) {
      clearTimeout(this.aiTypingTimeout);
    }

    const delay = 800 + Math.random() * 800;
    this.aiTypingTimeout = setTimeout(() => {
      if (this.aiActive && this.activeClients.size === 1) {
        this.generateAiMessage(userMessage);
      }
    }, delay);
  }

  async generateAiMessage(userPrompt?: string) {
    if (!this.aiActive || this.activeClients.size !== 1) return;

    let aiText = "";
    let usedEngine: "gemini" | "fallback" = "fallback";
    let usedModel: string | undefined = undefined;

    // Si la clave de Gemini está configurada en los Secrets del Worker
    if (this.env.GEMINI_API_KEY) {
      try {
        const past = this.conversationContext.filter(
          (m, idx) => !(idx === this.conversationContext.length - 1 && m.text.trim() === (userPrompt || "").trim())
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
          `[DIAGNÓSTICO LA SALA] Turno entrante | Historial recibido: ${past.length} turnos previas [${historyRolesSummary.join(" -> ") || "ninguna"}] | Longitud del prompt: ${promptLen} chars`
        );

        // Cascada de modelos optimizada
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
            console.log(`[DIAGNÓSTICO LA SALA] Modelo ${model} en enfriamiento activo hasta ${new Date(cooldownUntil).toISOString().substring(11, 19)}.`);
            continue;
          }

          if (lastAttemptedModel && lastAttemptedModel !== model) {
            console.log(`[DIAGNÓSTICO LA SALA] Cambio automático de modelo activado: pasando de ${lastAttemptedModel} a ${model}.`);
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
              console.log(`[DIAGNÓSTICO LA SALA] ÉXITO: Respuesta generada por Gemini | Modelo utilizado: ${model} | Longitud: ${aiText.length} chars | Motor: GEMINI`);
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
            console.log(`[DIAGNÓSTICO LA SALA] Error en modelo ${model} -> Código de error API: ${status} | Causa: ${errorMsg}`);
          }
        }
      } catch (err: any) {
        console.log("[DIAGNÓSTICO LA SALA] Excepción en procesamiento de Gemini:", err?.message || err);
      }
    }

    // Motor de respaldo inteligente contextual si Gemini no está configurado o falla
    if (!aiText) {
      console.log(`[DIAGNÓSTICO LA SALA] Derivando a getContextualFallback | Motor: FALLBACK`);
      aiText = getContextualFallback(userPrompt, this.conversationContext);
      usedEngine = "fallback";
      usedModel = undefined;
      console.log(`[DIAGNÓSTICO LA SALA] Respuesta generada por getContextualFallback | Longitud: ${aiText.length} chars | Motor: FALLBACK`);
    }

    // Confirmar que sigue habiendo exactamente 1 usuario real antes de enviar
    if (this.aiActive && this.activeClients.size === 1 && aiText) {
      this.addMessage(aiText, true, undefined, usedEngine, usedModel);
    }
  }
}
