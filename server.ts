import express from "express";
import http from "http";
import path from "path";
import { fileURLToPath } from "url";
import { WebSocketServer, WebSocket } from "ws";
import { GoogleGenAI } from "@google/genai";
import dotenv from "dotenv";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = http.createServer(app);
const PORT = process.env.PORT || 3000;

app.use(express.json());

// Initialize Gemini Client
let aiClient: GoogleGenAI | null = null;
if (process.env.GEMINI_API_KEY) {
  try {
    aiClient = new GoogleGenAI({
      apiKey: process.env.GEMINI_API_KEY,
      httpOptions: {
        headers: {
          "User-Agent": "aistudio-build",
        },
      },
    });
  } catch (err) {
    console.log("Error initializing Gemini API:", err);
  }
}

// Circuit breaker for external Gemini API models (tracks cooldowns for 429, 503, timeouts)
const modelCooldowns = new Map<string, number>();

// Initial greetings pool when 1 user enters an empty room (brief and natural)
const INITIAL_GREETINGS = [
  "hola",
  "holaa",
  "buenas",
  "qué onda",
  "hola qué tal",
];

// Smart, multi-turn, context-aware conversational fallback engine if external Gemini API is rate-limited or unavailable
function getContextualFallback(userPrompt?: string, history: Array<{ role: string; text: string }> = []): string {
  const current = (userPrompt || "").trim();
  const lower = current.toLowerCase();
  // Strip diacritics for ultra-reliable Spanish matching
  const normalized = lower.normalize("NFD").replace(/[\u0300-\u036f]/g, "");

  // Extract previous turns (excluding the current prompt if already at the end of history)
  const pastTurns = history.filter(
    (h, idx) => !(idx === history.length - 1 && h.text.trim() === current)
  );
  const allPastText = pastTurns
    .map((h) => h.text.toLowerCase())
    .join(" ")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");

  // 1. SINCERITY ABOUT BEING AN IA / BOT (Honest & Casual)
  if (/(\beres\b.*\b(ia|ai|bot|robot|humano|humana|persona|real)\b|\bque\b\s+eres\b|\bquien\b\s+eres\b)/i.test(normalized)) {
    const aiReplies = [
      "sí jaja, soy una IA",
      "sí, soy un bot mientras no entra alguien más",
      "soy una IA jaja, nomás pasando el rato",
      "sí, no soy humano",
    ];
    return aiReplies[Math.floor(Math.random() * aiReplies.length)];
  }

  // 2. GREETINGS (Proportional and brief, no unsolicited questions)
  if (/^(hola|holaa|holaaa|buenas|que onda|q onda|que tal|q tal|hey|buenas buenas|buenos dias|buenas tardes|buenas noches)$/i.test(normalized)) {
    const greetings = ["hola", "qué onda", "holaa", "buenas", "qué tal"];
    return greetings[Math.floor(Math.random() * greetings.length)];
  }

  // 3. LAUGHTER / REACTIONS
  if (/^(jaja|jajaja|jajajaja|xd|jjsjs|jeje|jaja\s+si)$/i.test(normalized)) {
    const laughs = ["jaja", "jajaja", "xd", "la neta sí jaja"];
    return laughs[Math.floor(Math.random() * laughs.length)];
  }

  // 4. JOKES / HUMOR ("cuéntame un chiste", "chiste")
  if (/(chiste|broma|cuentame\s+algo\s+gracioso)/i.test(normalized)) {
    const jokes = [
      "¿qué le dice un jaguar a otro? jaguar you jajaja",
      "¿por qué los pájaros no usan facebook? porque ya tienen twitter jajaja",
      "—oye, ¿sabes qué hora es? —sí. —ah bueno gracias jajaja",
    ];
    return jokes[Math.floor(Math.random() * jokes.length)];
  }

  // 5. QUESTIONS SPECIFICALLY ABOUT "QUÉ SE HACE" / "¿TÚ SABES QUÉ SE TIENE QUE HACER?"
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

  // 6. MULTI-TURN CONTEXT: EXAMS / STUDYING / SCHOOL / SUBJECTS
  const isExamContext =
    /(examen|estudi|reprob|parcial|materia|clase|profesor|profe|calculo|mate|matematicas|fisica|quimica|derivada|integral)/i.test(allPastText) ||
    /(examen|estudi|reprob|parcial|calculo|mate|matematicas|derivada|integral)/i.test(normalized);

  if (isExamContext) {
    // A) User just said "pero ya estudié" / "ya me lo sé"
    if (/(ya\s+estudie|ya\s+repase|si\s+estudie|ya\s+le\s+se|medio\s+estudie|estudie\s+algo|pero\s+ya\s+estudie)/i.test(normalized)) {
      const prepReplies = [
        "ahh bueno, entonces ya vas del otro lado",
        "ahh entonces vas preparado, seguro te va chido",
        "bueno eso da calma jaja, con fe",
        "con eso la armas, ya verás",
      ];
      return prepReplies[Math.floor(Math.random() * prepReplies.length)];
    }

    // B) User said they didn't study / panic
    if (/(no\s+estudie|no\s+se\s+nada|voy\s+a\s+reprobar|me\s+voy\s+a\s+morir|valio\s+madre|valio)/i.test(normalized)) {
      const panicReplies = [
        "no manches jaja, ¿y no alcanzas a repasar un poco?",
        "uff ahí sí está rudo, a rezarle al de arriba jaja",
        "no digas eso jaja, a veces sale mejor de lo que esperas",
        "uy no, toca improvisar durísimo mañana jaja",
      ];
      return panicReplies[Math.floor(Math.random() * panicReplies.length)];
    }

    // C) Specific mathematical/scientific topics (e.g. "derivadas", "integrales")
    if (/(derivadas?|integrales?|limites?|matrices|fracciones|vectores|ecuaciones)/i.test(normalized)) {
      const topicReplies = [
        "uff, esas luego se ponen feas jajaja",
        "las derivadas a veces confunden bastante jaja, ¿sí le entiendes?",
        "no inventes, esas tienen su maña jajaja",
        "uy esas luego se enredan un buen jajaja",
      ];
      return topicReplies[Math.floor(Math.random() * topicReplies.length)];
    }

    // D) Subject (e.g. "de cálculo", "matemáticas", "física", "historia")
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

    // E) Initial mention of exam
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

  // 7. USER IS THE CREATOR / PROGRAMMED THE SITE
  if (/(yo\s+(hice|cree|desarrolle|programe)|soy\s+el\s+creador|es\s+mi\s+(pagina|proyecto|sitio))/i.test(normalized)) {
    const creatorReplies = [
      "¿en serio? jaja qué rifado, te quedó muy bien",
      "ah mira qué chido, está buena la dinámica",
      "no manches, ¿tú la programaste? qué padre",
    ];
    return creatorReplies[Math.floor(Math.random() * creatorReplies.length)];
  }

  // 8. "¿QUÉ ES ESTO?" / "¿DE QUÉ TRATA ESTA PÁGINA?"
  if (/^(que\s+es\s+esto|q\s+es\s+esto|de\s+que\s+trata\s+esto|que\s+es\s+aqui)\??$/i.test(normalized)) {
    const whatReplies = [
      "¿la sala? es un chat anónimo temporal de 5 minutos jaja",
      "es como un chat efímero donde los mensajes duran 15 segundos",
      "nomás una sala de chat anónima para pasar el rato jaja",
    ];
    return whatReplies[Math.floor(Math.random() * whatReplies.length)];
  }

  // 9. "¿QUÉ ES LA PARED?" / "¿QUÉ ES EL MURO?"
  if (/(la\s+pared|el\s+muro)/i.test(normalized) && /(que\s+es|sabes|conoces|de\s+que)/i.test(normalized)) {
    return "es donde la gente deja notas anónimas en el muro";
  }

  // 10. "¿HAY ALGUIEN?" / "¿CUÁNTOS SOMOS?"
  if (/(hay\s+alguien|alguien\s+aqui|cuantos\s+somos|cuanta\s+gente)/i.test(normalized)) {
    const peopleReplies = [
      "ahorita nomás estamos tú y yo",
      "por ahora nadie más ha entrado",
      "nomás tú y yo por el momento",
    ];
    return peopleReplies[Math.floor(Math.random() * peopleReplies.length)];
  }

  // 11. "¿QUÉ HACES?"
  if (/(que\s+haces|q\s+haces|que\s+haces\s+o\s+que)/i.test(normalized)) {
    const doingReplies = [
      "aquí nomás pasando el rato jaja",
      "viendo quién entra a platicar",
      "nada en especial, aquí esperando a ver qué onda",
    ];
    return doingReplies[Math.floor(Math.random() * doingReplies.length)];
  }

  // 12. "¿CÓMO ESTÁS?"
  if (/(como\s+estas|como\s+andas|que\s+tal\s+todo)/i.test(normalized)) {
    const howReplies = [
      "todo bien por acá, ¿y tú qué tal?",
      "tranqui, pasando el rato jaja",
      "bien bien, ¿tú qué cuentas?",
    ];
    return howReplies[Math.floor(Math.random() * howReplies.length)];
  }

  // 13. "ESTOY ABURRIDO"
  if (/(aburrid|no\s+tengo\s+nada\s+que\s+hacer|que\s+aburrimiento)/i.test(normalized)) {
    const boredReplies = [
      "somos dos jaja, por eso ando aquí",
      "suele pasar jaja, ¿qué estabas haciendo antes?",
      "está tranquilo el día la verdad",
    ];
    return boredReplies[Math.floor(Math.random() * boredReplies.length)];
  }

  // 14. "ME VOY" / "BYE"
  if (/(me\s+voy|ya\s+me\s+voy|adios|bye|chao|al\s+rato|hasta\s+luego|nos\s+vemos)/i.test(normalized)) {
    const byeReplies = [
      "sale, cuídate",
      "va que va, suerte",
      "va, que te vaya chido",
      "nos vemos, cuídate",
    ];
    return byeReplies[Math.floor(Math.random() * byeReplies.length)];
  }

  // 15. USER ASKS A DIRECT QUESTION OR SAYS SOMETHING AMBIGUOUS
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

  // 16. NATURAL SHORT CASUAL REACTIONS (Varying, never default "ya veo" or "a veces pasa")
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

// ============================================================================
// SESSION & COOLDOWN MANAGEMENT (Server-Authoritative)
// Each entry gives a maximum session of 5 minutes (300s).
// When session finishes (05:00 -> 00:00) OR when user leaves early:
// Any remaining session time is DISCARDED (lost).
// An independent cooldown of EXACTLY 10 minutes (600s) starts immediately.
// Cooldown is NEVER added to remaining time. Cooldown is ALWAYS exactly 10 min.
// ============================================================================
// SESSION & COOLDOWN MANAGEMENT (Server-Authoritative)
// Each user session has a strict 5-minute (300s) window from initial entry.
// Disconnecting or closing the interface releases room presence but DOES NOT
// terminate the session: remaining time is preserved until absolute expiration.
// An independent cooldown of 10 minutes (600s) starts ONLY when the absolute
// session expiration (sessionExpiresAt) is reached.
// ============================================================================
const SESSION_DURATION_MS = 5 * 60 * 1000; // 300 seconds
const COOLDOWN_DURATION_MS = 10 * 60 * 1000; // 600 seconds
const MESSAGE_LIFESPAN_MS = 15 * 1000; // 15 seconds

interface UserSession {
  clientId: string;
  sessionStartedAt: number;
  sessionExpiresAt: number;
}

const userSessions = new Map<string, UserSession>();

function getUserSessionStatus(clientId: string) {
  const now = Date.now();
  const session = userSessions.get(clientId);

  if (!session) {
    return {
      inCooldown: false,
      remainingCooldownSeconds: 0,
      sessionActive: false,
      remainingSessionSeconds: Math.floor(SESSION_DURATION_MS / 1000),
    };
  }

  // 1. Active 5-minute session in progress
  if (now < session.sessionExpiresAt) {
    return {
      inCooldown: false,
      remainingCooldownSeconds: 0,
      sessionActive: true,
      remainingSessionSeconds: Math.max(1, Math.ceil((session.sessionExpiresAt - now) / 1000)),
    };
  }

  // 2. 5-minute session expired, currently within 10-minute cooldown
  const cooldownExpiresAt = session.sessionExpiresAt + COOLDOWN_DURATION_MS;
  if (now < cooldownExpiresAt) {
    return {
      inCooldown: true,
      remainingCooldownSeconds: Math.max(1, Math.ceil((cooldownExpiresAt - now) / 1000)),
      sessionActive: false,
      remainingSessionSeconds: 0,
    };
  }

  // 3. Both session and cooldown expired; eligible for a fresh session
  return {
    inCooldown: false,
    remainingCooldownSeconds: 0,
    sessionActive: false,
    remainingSessionSeconds: Math.floor(SESSION_DURATION_MS / 1000),
  };
}

function startOrResumeUserSession(clientId: string): { allowed: boolean; remainingSessionSeconds: number; remainingCooldownSeconds: number } {
  const now = Date.now();
  let session = userSessions.get(clientId);

  if (session) {
    // 1. If currently within 10-minute cooldown, reject access
    const cooldownExpiresAt = session.sessionExpiresAt + COOLDOWN_DURATION_MS;
    if (now >= session.sessionExpiresAt && now < cooldownExpiresAt) {
      return {
        allowed: false,
        remainingSessionSeconds: 0,
        remainingCooldownSeconds: Math.max(1, Math.ceil((cooldownExpiresAt - now) / 1000)),
      };
    }

    // 2. If existing session is still valid (now < sessionExpiresAt), RESUME with remaining time
    if (now < session.sessionExpiresAt) {
      return {
        allowed: true,
        remainingSessionSeconds: Math.max(1, Math.ceil((session.sessionExpiresAt - now) / 1000)),
        remainingCooldownSeconds: 0,
      };
    }
  }

  // 3. New session: either first time or previous session + cooldown fully elapsed
  const sessionExpiresAt = now + SESSION_DURATION_MS;
  session = {
    clientId,
    sessionStartedAt: now,
    sessionExpiresAt,
  };
  userSessions.set(clientId, session);

  return {
    allowed: true,
    remainingSessionSeconds: Math.floor(SESSION_DURATION_MS / 1000),
    remainingCooldownSeconds: 0,
  };
}

// REST endpoint for client to check session & cooldown without opening WebSocket
app.get("/api/sala/status", (req, res) => {
  const clientId = (req.query.clientId as string) || "";
  if (!clientId) {
    return res.status(400).json({ error: "clientId is required" });
  }
  const status = getUserSessionStatus(clientId);
  res.json(status);
});

// REST endpoint for client to leave room presence without forfeiting session
app.post("/api/sala/leave", (req, res) => {
  const clientId = (req.body?.clientId as string) || (req.query?.clientId as string) || "";
  if (!clientId) {
    return res.status(400).json({ error: "clientId is required" });
  }
  roomManager.leaveRoom(clientId);
  const status = getUserSessionStatus(clientId);
  res.json({ success: true, ...status });
});

// ============================================================================
// ROOMS & ACTOR ARCHITECTURE (Cloudflare Durable Objects mental model)
// Each room has max 5 real users. Complete anonymity.
// 0 users: No AI.
// 1 user: AI joins.
// 2+ users: AI leaves immediately.
// Messages live for 15s.
// ============================================================================
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
  joinedAt: number;
}

class SalaRoom {
  id: string;
  clients = new Map<string, RoomClient>(); // clientId -> RoomClient
  activeMessages = new Map<string, EphemeralMessage>();
  conversationContext: Array<{ role: "user" | "ia"; text: string }> = [];
  aiActive = false;
  aiTypingTimeout: NodeJS.Timeout | null = null;
  aiSilenceInterval: NodeJS.Timeout | null = null;
  lastAiMessageTime = 0;
  emptySince: number | null = null;

  constructor(id: string) {
    this.id = id;
  }

  get realUserCount(): number {
    return this.clients.size;
  }

  isFull(): boolean {
    return this.clients.size >= 5;
  }

  addClient(clientId: string, ws: WebSocket) {
    this.emptySince = null;
    this.clients.set(clientId, { clientId, ws, joinedAt: Date.now() });
    this.handleParticipantCountChange();
  }

  removeClient(clientId: string) {
    this.clients.delete(clientId);
    if (this.clients.size === 0) {
      this.emptySince = Date.now();
      // Wipe temporary conversation context immediately on empty
      this.conversationContext = [];
    }
    this.handleParticipantCountChange();
  }

  broadcast(payload: any, excludeClientId?: string) {
    const data = JSON.stringify(payload);
    for (const [cId, client] of this.clients.entries()) {
      if (excludeClientId && cId === excludeClientId) continue;
      if (client.ws.readyState === WebSocket.OPEN) {
        try {
          client.ws.send(data);
        } catch (_) {}
      }
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
    const message: EphemeralMessage = {
      id: msgId,
      text,
      timestamp: Date.now(),
      durationMs: MESSAGE_LIFESPAN_MS,
      senderClientId: isFromAi ? undefined : senderClientId,
      engine: isFromAi ? engine : undefined,
      model: isFromAi ? model : undefined,
    };

    this.activeMessages.set(msgId, message);

    // Track ephemeral conversation context only for current session
    this.conversationContext.push({
      role: isFromAi ? "ia" : "user",
      text,
    });
    if (this.conversationContext.length > 10) {
      this.conversationContext.shift();
    }

    // Broadcast new message
    this.broadcast({
      type: "message_new",
      message,
    });

    // Schedule automatic expiration in exactly 15 seconds
    setTimeout(() => {
      this.activeMessages.delete(msgId);
      this.broadcast({
        type: "message_expired",
        id: msgId,
      });
    }, MESSAGE_LIFESPAN_MS);

    // If user sent message and AI is currently active (1 real user), evaluate participation
    if (!isFromAi && this.aiActive && this.realUserCount === 1) {
      this.evaluateAiParticipation(text);
    }
  }

  handleParticipantCountChange() {
    const count = this.realUserCount;

    if (count === 1) {
      // Exactly 1 real user -> ENTRA LA IA
      if (!this.aiActive) {
        this.aiActive = true;
        this.scheduleAiInitialGreeting();
      }
    } else {
      // 0 or >= 2 real users -> LA IA DEBE SALIR INMEDIATAMENTE
      if (this.aiActive) {
        this.aiActive = false;
        this.cancelAiActions();
        // Clear ephemeral context immediately when AI leaves the room
        this.conversationContext = [];
      }
      if (count === 0) {
        // Clear ephemeral conversation memory when room is empty
        this.conversationContext = [];
      }
    }
  }

  cancelAiActions() {
    if (this.aiTypingTimeout) {
      clearTimeout(this.aiTypingTimeout);
      this.aiTypingTimeout = null;
    }
  }

  scheduleAiInitialGreeting() {
    this.cancelAiActions();
    // When a single person enters an empty room, send a natural casual greeting after a short pause (2.5s)
    // so they do not find the room completely empty
    if (this.conversationContext.length === 0) {
      this.aiTypingTimeout = setTimeout(() => {
        if (this.aiActive && this.realUserCount === 1 && this.conversationContext.length === 0) {
          const idx = Math.floor(Math.random() * INITIAL_GREETINGS.length);
          this.addMessage(INITIAL_GREETINGS[idx], true, undefined, "fallback");
        }
      }, 2500);
    }
  }

  evaluateAiParticipation(userMessage: string) {
    const trimmed = userMessage.trim();

    // 1. Direct identity question: must always respond honestly
    const isIdentityQuestion =
      /(\beres\b.*\b(ia|ai|bot|robot|humano|humana|persona|real)\b|\bque\b\s+eres\b|\bquien\b\s+eres\b)/i.test(trimmed);

    if (isIdentityQuestion) {
      this.scheduleAiResponse(userMessage, true);
      return;
    }

    // 2. Dead-end single-word closures: let conversation breathe and stay silent
    const isClosure = /^(ok|vale|ya|ah|ahh|bueno|sip|nop|👍|va|sale)$/i.test(trimmed);
    if (isClosure) {
      return;
    }

    // 3. Questions or topical messages
    const isQuestionOrTopic =
      trimmed.includes("?") ||
      trimmed.includes("¿") ||
      /^(hola|buenas|que onda|q onda|que tal|q tal|que haces|q haces|de donde|como estas|como andas|quien|cuantos|cuanta|por que|pq)/i.test(trimmed) ||
      /(la pared|el muro|la sala|yo hice|mi proyecto|aburrid|examen|program|estudi)/i.test(trimmed);

    // Occasional participation:
    // AI does not monopolize. Responds to direct questions/topics (~95%), reactions (~60%), or general statements (~75%)
    let shouldRespond = true;
    if (/^(jaja|jajaja|xd|jjsjs)$/i.test(trimmed)) {
      shouldRespond = Math.random() < 0.60;
    } else if (!isQuestionOrTopic) {
      shouldRespond = Math.random() < 0.75;
    }

    if (shouldRespond) {
      this.scheduleAiResponse(userMessage, false);
    }
  }

  scheduleAiResponse(userMessage: string, isIdentityQuestion = false) {
    if (this.aiTypingTimeout) {
      clearTimeout(this.aiTypingTimeout);
    }

    // Natural pause between 0.8 and 1.6 seconds before generating response
    const delay = 800 + Math.random() * 800;
    this.aiTypingTimeout = setTimeout(() => {
      if (this.aiActive && this.realUserCount === 1) {
        this.generateAiMessage(userMessage, isIdentityQuestion);
      }
    }, delay);
  }

  async generateAiMessage(userPrompt?: string, isIdentityQuestion = false) {
    if (!this.aiActive || this.realUserCount !== 1) return;

    let aiText = "";
    let usedEngine: "gemini" | "fallback" = "fallback";
    let usedModel: string | undefined = undefined;

    if (aiClient && process.env.GEMINI_API_KEY) {
      try {
        const systemPrompt =
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

        // Build structured multi-turn conversation contents for Gemini
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

        // Current user turn
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

        // Model priority order: gemini-3.5-flash is currently fast (~1.5s) and has available quota
        const modelsToTry = [
          "gemini-3.5-flash",
          "gemini-3.1-flash-lite-preview",
          "gemini-3.1-flash-lite",
          "gemini-3.8-flash",
          "gemini-flash-latest",
        ];

        let lastAttemptedModel = "";
        const modelErrors: Array<{ model: string; code: string | number; message: string }> = [];

        for (const model of modelsToTry) {
          // Check circuit breaker cooldown for rate-limited (429) or high-demand (503) models
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
            const apiCall = aiClient.models.generateContent({
              model,
              contents: structuredContents,
              config: {
                systemInstruction: systemPrompt,
                temperature: 0.85,
              },
            });
            const timeoutPromise = new Promise<null>((_, reject) =>
              setTimeout(() => reject(new Error("Timeout")), 4500)
            );
            const response = await Promise.race([apiCall, timeoutPromise]);
            const raw = response?.text?.trim() || "";
            if (raw) {
              aiText = raw.replace(/^["']|["']$/g, "").replace(/\n+/g, " ").trim().slice(0, 180);
              usedEngine = "gemini";
              usedModel = model;
              console.log(`[DIAGNÓSTICO LA SALA] ÉXITO: Respuesta generada por Gemini | Modelo utilizado: ${model} | Longitud: ${aiText.length} chars | Motor: GEMINI`);
              break;
            }
          } catch (err: any) {
            const status = err?.status || err?.code || (err?.message === "Timeout" ? "TIMEOUT" : "UNKNOWN_ERROR");
            const errorMsg = err?.message?.slice(0, 80) || "Sin detalle";
            modelErrors.push({ model, code: status, message: errorMsg });

            if (status === 429) {
              // Rate limit / daily quota reached: cooldown for 5 minutes
              modelCooldowns.set(model, Date.now() + 5 * 60 * 1000);
            } else if (status === 503) {
              // High demand spike: short cooldown for 30 seconds
              modelCooldowns.set(model, Date.now() + 30 * 1000);
            } else {
              // Timeout or connection error: cooldown for 15 seconds
              modelCooldowns.set(model, Date.now() + 15 * 1000);
            }
            console.log(`[DIAGNÓSTICO LA SALA] Error en modelo ${model} -> Código de error API: ${status} | Causa: ${errorMsg}`);
          }
        }
      } catch (err: any) {
        console.log("[DIAGNÓSTICO LA SALA] Excepción en procesamiento de Gemini:", err?.message || err);
      }
    }

    // Contextual fallback if API is unavailable, hit rate limits, or empty
    if (!aiText) {
      console.log(`[DIAGNÓSTICO LA SALA] Todos los modelos de Gemini fallaron o no están disponibles. Derivando a getContextualFallback | Motor: FALLBACK`);
      aiText = getContextualFallback(userPrompt, this.conversationContext);
      usedEngine = "fallback";
      usedModel = undefined;
      console.log(`[DIAGNÓSTICO LA SALA] Respuesta generada por getContextualFallback | Longitud: ${aiText.length} chars | Motor: FALLBACK`);
    }

    // Double check that we still only have 1 real user before sending
    if (this.aiActive && this.realUserCount === 1 && aiText) {
      this.lastAiMessageTime = Date.now();
      this.addMessage(aiText, true, undefined, usedEngine, usedModel);
    }
  }
}

// Global Matchmaking Manager
class RoomManager {
  rooms = new Map<string, SalaRoom>();
  clientRoomMap = new Map<string, string>(); // clientId -> roomId

  getOrCreateAvailableRoom(): SalaRoom {
    // Find room with < 5 real users
    for (const room of this.rooms.values()) {
      if (!room.isFull()) {
        return room;
      }
    }

    // All existing rooms full or no rooms exist -> create a new one
    const newRoomId = "room_" + Math.random().toString(36).substring(2, 10);
    const room = new SalaRoom(newRoomId);
    this.rooms.set(newRoomId, room);
    return room;
  }

  joinRoom(clientId: string, ws: WebSocket): SalaRoom {
    this.leaveRoom(clientId);
    const room = this.getOrCreateAvailableRoom();
    room.addClient(clientId, ws);
    this.clientRoomMap.set(clientId, room.id);
    return room;
  }

  leaveRoom(clientId: string) {
    const roomId = this.clientRoomMap.get(clientId);
    if (!roomId) return;

    this.clientRoomMap.delete(clientId);
    const room = this.rooms.get(roomId);
    if (room) {
      room.removeClient(clientId);
      if (room.realUserCount === 0) {
        // Destroy empty room
        this.rooms.delete(roomId);
      }
    }
  }

  getRoomForClient(clientId: string): SalaRoom | undefined {
    const roomId = this.clientRoomMap.get(clientId);
    return roomId ? this.rooms.get(roomId) : undefined;
  }
}

const roomManager = new RoomManager();

// ============================================================================
// WEBSOCKET SERVER ATTACHMENT
// Route: /api/sala/ws?clientId=...
// ============================================================================
const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (request, socket, head) => {
  const url = new URL(request.url || "", `http://${request.headers.host}`);
  if (url.pathname === "/api/sala/ws") {
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit("connection", ws, request);
    });
  }
});

wss.on("connection", (ws: WebSocket, request) => {
  const url = new URL(request.url || "", `http://${request.headers.host}`);
  const clientId = url.searchParams.get("clientId");

  if (!clientId) {
    ws.close(4000, "Missing clientId");
    return;
  }

  // Validate session with Server Authority
  const sessionCheck = startOrResumeUserSession(clientId);
  if (!sessionCheck.allowed) {
    ws.send(
      JSON.stringify({
        type: "in_cooldown",
        remainingCooldownSeconds: sessionCheck.remainingCooldownSeconds,
      })
    );
    ws.close(4002, "In cooldown");
    return;
  }

  // Join room automatically (matchmaking handles < 5 people cap)
  const room = roomManager.joinRoom(clientId, ws);

  // Send initial session sync + existing active ephemeral messages
  const initialMessages = Array.from(room.activeMessages.values()).map((m) => {
    const elapsed = Date.now() - m.timestamp;
    const remaining = Math.max(0, m.durationMs - elapsed);
    return {
      ...m,
      durationMs: remaining,
    };
  });

  ws.send(
    JSON.stringify({
      type: "session_init",
      remainingSessionSeconds: sessionCheck.remainingSessionSeconds,
      activeMessages: initialMessages,
    })
  );

  // Periodic heartbeat / session countdown check for this user
  const sessionCheckInterval = setInterval(() => {
    const session = userSessions.get(clientId);
    if (!session) return;
    const now = Date.now();

    if (now >= session.sessionExpiresAt) {
      // Session has reached 00:00 (5 minutes full completed)!
      clearInterval(sessionCheckInterval);
      const cooldownExpiresAt = session.sessionExpiresAt + COOLDOWN_DURATION_MS;
      const remainingCooldown = Math.max(0, Math.ceil((cooldownExpiresAt - now) / 1000));
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(
          JSON.stringify({
            type: "session_expired",
            remainingCooldownSeconds: remainingCooldown,
          })
        );
        ws.close(4001, "Session Expired");
      }
      roomManager.leaveRoom(clientId);
    }
  }, 1000);

  ws.on("message", (raw) => {
    try {
      const data = JSON.parse(raw.toString());

      // Voluntary exit event from client - releases room slot, does not terminate session time
      if (data.type === "leave_sala") {
        clearInterval(sessionCheckInterval);
        roomManager.leaveRoom(clientId);
        ws.close(1000, "User Left Room");
        return;
      }

      if (data.type === "send_message") {
        const text = typeof data.text === "string" ? data.text.trim() : "";

        // Server-side validation:
        // 1. Session must be active
        const session = userSessions.get(clientId);
        if (!session || Date.now() >= session.sessionExpiresAt) {
          ws.send(JSON.stringify({ type: "error", error: "Tu tiempo en La Sala ha terminado." }));
          return;
        }

        // 2. Length must be <= 180 and > 0
        if (!text || text.length > 180) {
          ws.send(JSON.stringify({ type: "error", error: "El mensaje debe tener entre 1 y 180 caracteres." }));
          return;
        }

        // 3. Disallow links/multimedia initially
        const urlRegex = /(https?:\/\/|www\.|\.com|\.org|\.net|\.io|\.me)/i;
        if (urlRegex.test(text)) {
          ws.send(JSON.stringify({ type: "error", error: "No se permiten enlaces en La Sala." }));
          return;
        }

        // Add and broadcast message
        const currentRoom = roomManager.getRoomForClient(clientId);
        if (currentRoom) {
          currentRoom.addMessage(text, false, clientId);
        }
      }
    } catch (err) {
      console.error("Error processing websocket message:", err);
    }
  });

  ws.on("close", () => {
    clearInterval(sessionCheckInterval);
    const room = roomManager.getRoomForClient(clientId);
    if (room && room.clients.get(clientId)?.ws === ws) {
      roomManager.leaveRoom(clientId);
    }
  });

  ws.on("error", () => {
    clearInterval(sessionCheckInterval);
    const room = roomManager.getRoomForClient(clientId);
    if (room && room.clients.get(clientId)?.ws === ws) {
      roomManager.leaveRoom(clientId);
    }
  });
});

// ============================================================================
// VITE DEV MIDDLEWARES / STATIC SERVING
// ============================================================================
async function startServer() {
  const isDev = process.env.NODE_ENV !== "production";

  if (isDev) {
    const { createServer: createViteServer } = await import("vite");
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.resolve(__dirname, "dist");
    app.use(express.static(distPath));
    app.get("*", (_req, res) => {
      res.sendFile(path.resolve(distPath, "index.html"));
    });
  }

  server.listen(PORT, () => {
    console.log(`Server listening on port ${PORT} (dev: ${isDev})`);
  });
}

startServer();
