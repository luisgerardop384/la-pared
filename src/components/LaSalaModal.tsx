import React, { useEffect, useRef, useState } from "react";
import { X, Send, Clock, Sparkles } from "lucide-react";

// Servidor de producción en Cloudflare Workers con Durable Objects
const CLOUDFLARE_WORKER_HTTP = "https://la-sala.luisgerardope384.workers.dev";
const CLOUDFLARE_WORKER_WSS = "wss://la-sala.luisgerardope384.workers.dev";

interface EphemeralMessage {
  id: string;
  text: string;
  timestamp: number;
  durationMs: number;
  isMine?: boolean;
  engine?: "gemini" | "fallback";
  model?: string;
}

interface LaSalaModalProps {
  clientId: string;
  isOpen: boolean;
  onClose: () => void;
}

export default function LaSalaModal({ clientId, isOpen, onClose }: LaSalaModalProps) {
  const [messages, setMessages] = useState<EphemeralMessage[]>([]);
  const [inputText, setInputText] = useState("");
  const [sessionRemainingSec, setSessionRemainingSec] = useState<number | null>(null);
  const [cooldownRemainingSec, setCooldownRemainingSec] = useState<number | null>(null);
  const [isExpired, setIsExpired] = useState(false);
  const [inCooldown, setInCooldown] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isConnected, setIsConnected] = useState(false);

  const wsRef = useRef<WebSocket | null>(null);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const timerIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const cooldownIntervalRef = useRef<NodeJS.Timeout | null>(null);

  // Auto-scroll to bottom when new messages arrive
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // Connect to La Sala WebSocket
  const connectWebSocket = () => {
    if (!clientId) return;

    // Check status first via Cloudflare Worker HTTP endpoint (HTTPS)
    fetch(`${CLOUDFLARE_WORKER_HTTP}/api/sala/status?clientId=${encodeURIComponent(clientId)}`)
      .then((res) => res.json())
      .then((data) => {
        if (data.inCooldown) {
          setInCooldown(true);
          setIsExpired(true);
          setCooldownRemainingSec(data.remainingCooldownSeconds);
          startCooldownTicker(data.remainingCooldownSeconds);
          return;
        }

        setIsExpired(false);
        setInCooldown(false);
        if (data.sessionActive && typeof data.remainingSessionSeconds === "number") {
          setSessionRemainingSec(data.remainingSessionSeconds);
        }

        // Establish real WebSocket connection with Cloudflare Workers (WSS)
        const wsUrl = `${CLOUDFLARE_WORKER_WSS}/api/sala/ws?clientId=${encodeURIComponent(clientId)}`;
        const ws = new WebSocket(wsUrl);
        wsRef.current = ws;

        ws.onopen = () => {
          setIsConnected(true);
          setErrorMessage(null);
        };

        ws.onmessage = (event) => {
          try {
            const data = JSON.parse(event.data);

            if (data.type === "session_init") {
              setSessionRemainingSec(data.remainingSessionSeconds);
              setIsExpired(false);
              setInCooldown(false);

              if (Array.isArray(data.activeMessages)) {
                setMessages(
                  data.activeMessages.map((m: any) => ({
                    ...m,
                    isMine: false,
                  }))
                );
              }

              // Start session countdown ticker
              startSessionTicker(data.remainingSessionSeconds);
            } else if (data.type === "message_new") {
              const msg: EphemeralMessage = {
                ...data.message,
                isMine: data.message.senderClientId === clientId,
              };

              // Diagnóstico seguro: distinguir respuestas de Gemini y del sistema de respaldo
              if (data.message.engine) {
                console.log(
                  `[La Sala Diagnóstico] Respuesta recibida | Motor: ${data.message.engine.toUpperCase()}${
                    data.message.model ? ` (${data.message.model})` : ""
                  }`
                );
              }

              setMessages((prev) => {
                if (prev.some((m) => m.id === msg.id)) return prev;
                return [...prev, msg];
              });
            } else if (data.type === "message_expired") {
              setMessages((prev) => prev.filter((m) => m.id !== data.id));
            } else if (data.type === "session_expired") {
              setIsExpired(true);
              setSessionRemainingSec(0);
              const cooldown = data.remainingCooldownSeconds || 600;
              setCooldownRemainingSec(cooldown);
              startCooldownTicker(cooldown);
              ws.close();
            } else if (data.type === "in_cooldown") {
              setInCooldown(true);
              setCooldownRemainingSec(data.remainingCooldownSeconds || 600);
              startCooldownTicker(data.remainingCooldownSeconds || 600);
              ws.close();
            } else if (data.type === "error") {
              setErrorMessage(data.error);
            }
          } catch (err) {
            console.error("Error processing incoming message in La Sala:", err);
          }
        };

        ws.onclose = (event) => {
          setIsConnected(false);
          if (event.code === 4001) {
            setIsExpired(true);
          } else if (event.code === 4002) {
            setInCooldown(true);
          }
        };

        ws.onerror = () => {
          setIsConnected(false);
        };
      })
      .catch((err) => {
        console.error("Error checking Sala status:", err);
        setErrorMessage("No se pudo conectar a La Sala. Inténtalo de nuevo.");
      });
  };

  const startSessionTicker = (initialSeconds: number) => {
    if (timerIntervalRef.current) clearInterval(timerIntervalRef.current);
    let current = initialSeconds;

    timerIntervalRef.current = setInterval(() => {
      current -= 1;
      if (current <= 0) {
        if (timerIntervalRef.current) clearInterval(timerIntervalRef.current);
        setSessionRemainingSec(0);
        setIsExpired(true);
        setCooldownRemainingSec(600);
        startCooldownTicker(600);
      } else {
        setSessionRemainingSec(current);
      }
    }, 1000);
  };

  const startCooldownTicker = (initialCooldownSec: number) => {
    if (cooldownIntervalRef.current) clearInterval(cooldownIntervalRef.current);
    let cd = initialCooldownSec;

    cooldownIntervalRef.current = setInterval(() => {
      cd -= 1;
      if (cd <= 0) {
        if (cooldownIntervalRef.current) clearInterval(cooldownIntervalRef.current);
        setCooldownRemainingSec(0);
        setInCooldown(false);
        setIsExpired(false);
      } else {
        setCooldownRemainingSec(cd);
      }
    }, 1000);
  };

  useEffect(() => {
    if (isOpen) {
      connectWebSocket();
    } else {
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
      if (timerIntervalRef.current) clearInterval(timerIntervalRef.current);
      if (cooldownIntervalRef.current) clearInterval(cooldownIntervalRef.current);
      setMessages([]);
      setInputText("");
      setErrorMessage(null);
      setIsExpired(false);
      setInCooldown(false);
      setSessionRemainingSec(null);
      setCooldownRemainingSec(null);
    }

    return () => {
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
      if (timerIntervalRef.current) clearInterval(timerIntervalRef.current);
      if (cooldownIntervalRef.current) clearInterval(cooldownIntervalRef.current);
    };
  }, [isOpen, clientId]);

  // Local message expiration ticker to smoothly fade out & remove messages at 15s
  useEffect(() => {
    const interval = setInterval(() => {
      const now = Date.now();
      setMessages((prev) => prev.filter((m) => now - m.timestamp < 15500));
    }, 500);

    return () => clearInterval(interval);
  }, []);

  const handleExitSala = () => {
    // Releasing room slot without forfeiting remaining session time
    if (clientId) {
      fetch(`${CLOUDFLARE_WORKER_HTTP}/api/sala/leave?clientId=${encodeURIComponent(clientId)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clientId }),
      }).catch(() => {});
    }
    if (wsRef.current) {
      try {
        wsRef.current.send(JSON.stringify({ type: "leave_sala" }));
      } catch (_) {}
      wsRef.current.close();
      wsRef.current = null;
    }
    onClose();
  };

  const handleSendMessage = (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    const trimmed = inputText.trim();

    if (!trimmed) return;
    if (trimmed.length > 180) {
      setErrorMessage("El mensaje no puede exceder 180 caracteres.");
      return;
    }

    const urlRegex = /(https?:\/\/|www\.|\.com|\.org|\.net|\.io|\.me)/i;
    if (urlRegex.test(trimmed)) {
      setErrorMessage("No se permiten enlaces en La Sala.");
      return;
    }

    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(
        JSON.stringify({
          type: "send_message",
          text: trimmed,
        })
      );
      setInputText("");
      setErrorMessage(null);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSendMessage();
    }
  };

  const formatTime = (seconds: number) => {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center p-3 md:p-6 pointer-events-none select-none animate-in fade-in duration-300">
      <div className="pointer-events-auto w-full max-w-xl h-[86vh] md:h-[78vh] liquid-glass-container rounded-3xl flex flex-col overflow-hidden ring-1 ring-black/10 transition-all duration-300">
        {/* Top Navbar */}
        <div className="px-5 py-3.5 md:px-6 md:py-4 border-b border-black/10 flex items-center justify-between liquid-glass-subtle shrink-0">
          <div className="flex items-center gap-2.5">
            <div className="w-2 h-2 rounded-full bg-black/80 animate-pulse" />
            <div>
              <h2 className="text-xs md:text-sm font-bold uppercase tracking-[0.25em] font-sans text-black">
                LA SALA
              </h2>
              <p className="text-[9px] text-neutral-500 font-mono tracking-wider">
                ESPACIO EFÍMERO • 100% ANÓNIMO
              </p>
            </div>
          </div>

          <div className="flex items-center gap-3">
            {/* Session Timer (Authoritative) */}
            {sessionRemainingSec !== null && !isExpired && !inCooldown && (
              <div
                className={`flex items-center gap-1.5 px-3 py-1 rounded-full font-mono text-xs font-bold transition-colors shadow-xs ${
                  sessionRemainingSec <= 30
                    ? "bg-red-500/15 border border-red-500/40 text-red-600 animate-pulse"
                    : "bg-white/80 border border-black/10 text-neutral-800"
                }`}
                title="Tiempo restante de acceso"
              >
                <Clock className="w-3.5 h-3.5" />
                <span>{formatTime(sessionRemainingSec)}</span>
              </div>
            )}

            {/* Exit Button */}
            <button
              id="btn-close-sala"
              onClick={handleExitSala}
              className="w-8 h-8 rounded-full flex items-center justify-center bg-white/70 hover:bg-black hover:text-white border border-black/10 transition-all text-neutral-700 shadow-xs cursor-pointer active:scale-95"
              title="Volver a La Pared"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Content Area */}
        {isExpired || inCooldown ? (
          /* Cooldown / Session Expired Screen */
          <div className="flex-1 p-6 md:p-10 flex flex-col items-center justify-center text-center bg-transparent">
            <div className="w-14 h-14 md:w-16 md:h-16 rounded-full border border-black/15 flex items-center justify-center mb-5 bg-white/60 backdrop-blur-md shadow-sm">
              <Clock className="w-7 h-7 text-black" />
            </div>

            <h3 className="text-sm md:text-base font-bold uppercase tracking-[0.2em] font-mono text-black mb-3">
              TU TIEMPO EN LA SALA HA TERMINADO
            </h3>

            <p className="text-xs text-neutral-600 max-w-md font-sans leading-relaxed mb-6">
              Cada visita dura exactamente 5 minutos para mantener la espontaneidad y la pureza del espacio.
              La Sala se encuentra en período de recarga durante 10 minutos.
            </p>

            <div className="p-4 bg-white/60 backdrop-blur-md border border-black/10 rounded-2xl shadow-sm mb-8 flex flex-col items-center min-w-[220px]">
              <span className="text-[9px] uppercase tracking-widest text-neutral-400 font-mono mb-1 font-bold">
                RECARGA EN CURSO
              </span>
              <span className="text-2xl font-mono font-bold text-black tracking-wider">
                {cooldownRemainingSec !== null && cooldownRemainingSec > 0
                  ? formatTime(cooldownRemainingSec)
                  : "00:00"}
              </span>
              <span className="text-[9px] text-neutral-500 font-mono mt-1">
                {cooldownRemainingSec === 0
                  ? "¡Recarga completada!"
                  : `Podrás volver en ${cooldownRemainingSec !== null ? formatTime(cooldownRemainingSec) : "10:00"}`}
              </span>
            </div>

            <div className="flex flex-col sm:flex-row gap-3 w-full max-w-xs">
              {cooldownRemainingSec === 0 ? (
                <button
                  onClick={() => {
                    setIsExpired(false);
                    setInCooldown(false);
                    connectWebSocket();
                  }}
                  className="flex-1 bg-black text-white hover:bg-neutral-800 border border-black py-2.5 rounded-xl text-xs font-mono font-bold tracking-widest uppercase transition-all shadow-sm active:scale-95 cursor-pointer"
                >
                  Entrar de nuevo
                </button>
              ) : null}

              <button
                onClick={handleExitSala}
                className="flex-1 bg-white/80 hover:bg-white text-black border border-black/15 py-2.5 rounded-xl text-xs font-mono font-bold tracking-widest uppercase transition-all shadow-sm active:scale-95 cursor-pointer"
              >
                Volver a La Pared
              </button>
            </div>
          </div>
        ) : (
          /* Active Chat Feed */
          <div className="flex-1 flex flex-col min-h-0 bg-transparent">
            {/* Messages Feed */}
            <div className="flex-1 p-4 md:p-6 overflow-y-auto space-y-3 custom-scrollbar flex flex-col">
              {messages.length === 0 ? (
                <div className="flex-1 flex flex-col items-center justify-center text-center p-6 my-auto text-neutral-500 font-sans">
                  <div className="w-10 h-10 border border-black/10 rounded-full flex items-center justify-center mb-3 text-neutral-400 bg-white/50 shadow-xs">
                    <Sparkles className="w-4 h-4" />
                  </div>
                  <p className="text-xs md:text-sm max-w-sm leading-relaxed mb-1 font-serif italic text-neutral-600">
                    “Las palabras aquí no se graban en piedra: se desvanecen en 15 segundos.”
                  </p>
                  <p className="text-[10px] font-mono uppercase tracking-wider text-neutral-400 mt-2">
                    Escribe un mensaje para romper el silencio
                  </p>
                </div>
              ) : (
                messages.map((msg) => {
                  const now = Date.now();
                  const ageMs = now - msg.timestamp;
                  const remainingRatio = Math.max(0, Math.min(1, (15000 - ageMs) / 15000));
                  const isExpiring = ageMs >= 13500;

                  return (
                    <div
                      key={msg.id}
                      className={`flex flex-col transition-all duration-300 ${
                        isExpiring ? "animate-message-disappear" : "animate-message-appear"
                      }`}
                    >
                      <div
                        title={
                          !msg.isMine && msg.engine
                            ? `Respuesta generada por: ${
                                msg.engine === "gemini"
                                  ? `Gemini AI (${msg.model || "flash"})`
                                  : "Motor de Respaldo Contextual"
                              }`
                            : undefined
                        }
                        data-engine={msg.engine}
                        className={`relative px-4 py-2.5 md:py-3 rounded-2xl shadow-xs max-w-[85%] md:max-w-[75%] select-text overflow-hidden border ${
                          msg.isMine
                            ? "ml-auto bg-black/85 text-white border-black/10 rounded-tr-xs"
                            : "mr-auto bg-white/85 text-black border-black/10 rounded-tl-xs backdrop-blur-xs"
                        }`}
                      >
                        <p className="text-xs md:text-sm font-sans leading-relaxed whitespace-pre-wrap select-text break-words">
                          {msg.text}
                        </p>

                        {/* 15-second ephemeral progress bar at the bottom */}
                        <div className="absolute bottom-0 left-0 right-0 h-[2px] bg-black/10 overflow-hidden">
                          <div
                            className={`h-full transition-[width] duration-500 ease-linear ${
                              msg.isMine ? "bg-white/60" : "bg-black/35"
                            }`}
                            style={{
                              width: `${remainingRatio * 100}%`,
                            }}
                          />
                        </div>
                      </div>
                    </div>
                  );
                })
              )}
              <div ref={messagesEndRef} />
            </div>

            {/* Error banner if any */}
            {errorMessage && (
              <div className="px-4 py-2 bg-red-50/90 border-t border-b border-red-200 text-red-600 text-[10px] font-mono flex items-center justify-between backdrop-blur-xs">
                <span>{errorMessage}</span>
                <button
                  onClick={() => setErrorMessage(null)}
                  className="text-red-400 hover:text-red-700"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>
            )}

            {/* Input Bar */}
            <form
              onSubmit={handleSendMessage}
              className="p-3.5 md:p-4 liquid-glass-dock rounded-b-3xl flex flex-col gap-2 shrink-0"
            >
              <div className="flex gap-2">
                <textarea
                  id="sala-input-message"
                  value={inputText}
                  onChange={(e) => {
                    const text = e.target.value;
                    if (text.length <= 180) {
                      setInputText(text);
                    }
                  }}
                  onKeyDown={handleKeyDown}
                  placeholder="Escribe tu mensaje efímero... (Enter para enviar)"
                  maxLength={180}
                  rows={2}
                  className="flex-1 bg-white/80 border border-black/15 focus:border-black focus:bg-white rounded-xl outline-none p-2.5 text-xs text-black placeholder-neutral-400 resize-none font-sans transition-colors"
                />

                <button
                  type="submit"
                  id="btn-send-sala"
                  disabled={!inputText.trim() || inputText.length > 180 || !isConnected}
                  className="px-4 bg-black text-white hover:bg-neutral-800 disabled:opacity-20 disabled:pointer-events-none transition-all rounded-xl shadow-xs flex items-center justify-center gap-1.5 cursor-pointer active:scale-95"
                  title="Enviar mensaje"
                >
                  <Send className="w-4 h-4" />
                </button>
              </div>

              {/* Bottom Counter & Info */}
              <div className="flex items-center justify-between text-[9px] font-mono text-neutral-500 px-1">
                <span>Solo texto • Sin historial • Desaparece en 15s</span>
                <span
                  className={
                    inputText.length >= 170 ? "text-red-600 font-bold" : "text-neutral-500"
                  }
                >
                  {inputText.length} / 180
                </span>
              </div>
            </form>
          </div>
        )}
      </div>
    </div>
  );
}
