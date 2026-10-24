import React, { useEffect, useRef, useState } from "react";
import { Compass, Plus, Sparkles, HelpCircle, X, MessageSquare } from "lucide-react";
import { Note } from "../types";
import { supabase } from '../supabaseClient';
import AmbientBackground from "./AmbientBackground";
import LaSalaModal from "./LaSalaModal";

interface CanvasWallProps {
  clientId: string;
  selectedNote: Note | null;
  setSelectedNote: (note: Note | null) => void;
  notes: Note[];
  setNotes: React.Dispatch<React.SetStateAction<Note[]>>;
}

const NOTE_COLORS = [
  { name: "Blanco puro", hex: "#ffffff" },
  { name: "Amarillo pálido", hex: "#fef08a" },
  { name: "Verde pálido", hex: "#bbf7d0" },
  { name: "Azul pálido", hex: "#bfdbfe" },
  { name: "Rosa pálido", hex: "#fbcfe8" },
  { name: "Naranja pálido", hex: "#fed7aa" },
  { name: "Gris pálido", hex: "#f3f4f6" },
  { name: "Morado pastel", hex: "#DCC6F8" },
  { name: "Sombra", hex: "#171717" },
];

const AVAILABLE_FONTS = [
  { name: "Máquina de escribir", css: "'Courier New', Courier, monospace" },
  { name: "Elegante", css: "Georgia, serif" },
  { name: "Moderna", css: "Arial, Helvetica, sans-serif" },
  { name: "Manuscrita", css: "'Caveat', cursive, sans-serif" },
  { name: "Llamativa", css: "'Impact', sans-serif" },
];

async function extractEdgeFunctionError(invokeError: any): Promise<string> {
  if (!invokeError) return "Error desconocido al contactar la función.";

  if (invokeError.context && typeof invokeError.context.json === "function") {
    try {
      const errBody = await invokeError.context.json();
      if (errBody && errBody.error) {
        return errBody.error;
      }
    } catch (_) {}
  }

  if (
    invokeError.message &&
    invokeError.message !== "Edge Function returned a non-2xx status code"
  ) {
    return invokeError.message;
  }

  if (invokeError.name === "FunctionsFetchError" || !invokeError.context) {
    return "No se pudo contactar con la Edge Function 'admin-note'. Verifica tu conexión a internet o el estado de Supabase.";
  }

  return `Error en la Edge Function (código ${invokeError.context?.status || "desconocido"}).`;
}

export default function CanvasWall({
  clientId,
  selectedNote,
  setSelectedNote,
  notes,
  setNotes,
}: CanvasWallProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);

  // Initial infinite offsets
  const [offsetX, setOffsetX] = useState(0);
  const [offsetY, setOffsetY] = useState(0);

  // Mouse pan state
  const [isDragging, setIsDragging] = useState(false);
  const [isPointerDown, setIsPointerDown] = useState(false);
  const [hasMouseDragged, setHasMouseDragged] = useState(false);
  const [dragStart, setDragStart] = useState({ x: 0, y: 0 });
  const [dragStartOffset, setDragStartOffset] = useState({ x: 0, y: 0 });
  const [mouseDownNoteId, setMouseDownNoteId] = useState<string | null>(null);

  const [width, setWidth] = useState(() => (typeof window !== "undefined" ? window.innerWidth : 800));
  const [height, setHeight] = useState(() => (typeof window !== "undefined" ? window.innerHeight : 600));

  // Camera scale (Zoom limits: MIN_SCALE=0.35, MAX_SCALE=1.8, starts at 1.0 on desktop, 0.65 on mobile)
  const [scale, setScale] = useState(() => {
    const isMobileInitial = typeof window !== "undefined" && window.innerWidth < 768;
    return isMobileInitial ? 0.65 : 1.0;
  });
  const MIN_SCALE = 0.35;
  const MAX_SCALE = 1.8;

  // La Sala ephemeral chat modal state
  const [isSalaOpen, setIsSalaOpen] = useState(false);

  // Onboarding first visit state (stored in localStorage only)
  const [isOnboardingActive, setIsOnboardingActive] = useState(() => {
    if (typeof window === "undefined") return false;
    return localStorage.getItem("lapared_onboarding_seen") !== "true";
  });

  const dismissOnboarding = () => {
    setIsOnboardingActive(false);
    try {
      localStorage.setItem("lapared_onboarding_seen", "true");
    } catch (_) {}
  };

  // Auto-dismiss onboarding after 7.5 seconds
  useEffect(() => {
    if (isOnboardingActive) {
      const timer = setTimeout(() => {
        dismissOnboarding();
      }, 7500);
      return () => clearTimeout(timer);
    }
  }, [isOnboardingActive]);

  // Camera translation variables
  const cameraX = -offsetX + width / (2 * scale);
  const cameraY = -offsetY + height / (2 * scale);

  // Direct camera transform on DOM
  const aplicarTransformacionCamara = () => {
    const paredCanvas = document.getElementById("pared-canvas");
    if (paredCanvas) {
      paredCanvas.style.transform = `scale(${scale}) translate3d(${Math.round(cameraX)}px, ${Math.round(cameraY)}px, 0px)`;
      paredCanvas.style.transformOrigin = "0 0";
      paredCanvas.style.transformStyle = "preserve-3d";
      paredCanvas.style.backfaceVisibility = "hidden";
      paredCanvas.style.willChange = "transform";
    }
  };

  useEffect(() => {
    aplicarTransformacionCamara();
  }, [scale, cameraX, cameraY]);

  const calcularPosicionFinal = (
    clickX: number,
    clickY: number
  ): { x: number; y: number } => {
    return { x: Math.round(clickX), y: Math.round(clickY) };
  };

  // Creation state
  const [creatingNote, setCreatingNote] = useState<{
    x: number;
    y: number;
    canvasX?: number;
    canvasY?: number;
    text: string;
    color: string;
    fontFamily: string;
  } | null>(null);

  const [saving, setSaving] = useState(false);
  const [savingError, setSavingError] = useState("");
  const [hoveredNoteId, setHoveredNoteId] = useState<string | null>(null);

  // One note per person limit alert state
  const [showLimitAlert, setShowLimitAlert] = useState(false);
  const [isManualOpen, setIsManualOpen] = useState(false);

  // Handle Resize of canvas viewport
  useEffect(() => {
    const handleResize = () => {
      if (containerRef.current) {
        const w = containerRef.current.clientWidth;
        const h = containerRef.current.clientHeight;
        setWidth(w);
        setHeight(h);
        if (canvasRef.current) {
          canvasRef.current.width = w;
          canvasRef.current.height = h;
        }
      }
    };

    handleResize();
    const observer = new ResizeObserver(() => handleResize());
    if (containerRef.current) {
      observer.observe(containerRef.current);
    }

    return () => {
      observer.disconnect();
    };
  }, []);

  // Evento de Zoom con la rueda del ratón
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const handleWheel = (e: WheelEvent) => {
      cancelSurpriseTravel();
      e.preventDefault();
      const zoomFactor = 0.08;
      setScale((prevScale) => {
        const delta = e.deltaY < 0 ? zoomFactor : -zoomFactor;
        return Math.min(Math.max(prevScale + delta, MIN_SCALE), MAX_SCALE);
      });
    };

    container.addEventListener("wheel", handleWheel, { passive: false });
    return () => {
      container.removeEventListener("wheel", handleWheel);
    };
  }, []);

  // Zone size for spatial chunk caching in memory
  const ZONE_SIZE = 800;
  const cachedZonesRef = useRef<Set<string>>(new Set());
  const pendingZonesRef = useRef<Set<string>>(new Set());
  const notesMapRef = useRef<Map<string, Note>>(new Map());
  const appearedNoteIdsRef = useRef<Set<string>>(new Set());

  // Fetch Notes in Viewport
  const fetchNotesInViewport = async (
    curX: number,
    curY: number,
    viewW: number,
    viewH: number,
    curScale: number,
    forceInvalidateBounds = false
  ) => {
    const worldW = viewW / curScale;
    const worldH = viewH / curScale;
    const padX = Math.round(worldW * 1.5);
    const padY = Math.round(worldH * 1.5);
    const minX = Math.round(curX - padX);
    const maxX = Math.round(curX + padX);
    const minY = Math.round(curY - padY);
    const maxY = Math.round(curY + padY);

    const startZoneX = Math.floor(minX / ZONE_SIZE);
    const endZoneX = Math.floor(maxX / ZONE_SIZE);
    const startZoneY = Math.floor(minY / ZONE_SIZE);
    const endZoneY = Math.floor(maxY / ZONE_SIZE);

    if (forceInvalidateBounds) {
      for (let zx = startZoneX; zx <= endZoneX; zx++) {
        for (let zy = startZoneY; zy <= endZoneY; zy++) {
          cachedZonesRef.current.delete(`${zx},${zy}`);
        }
      }
    }

    const uncachedZones: string[] = [];
    for (let zx = startZoneX; zx <= endZoneX; zx++) {
      for (let zy = startZoneY; zy <= endZoneY; zy++) {
        const key = `${zx},${zy}`;
        if (!cachedZonesRef.current.has(key) && !pendingZonesRef.current.has(key)) {
          uncachedZones.push(key);
        }
      }
    }

    if (uncachedZones.length === 0) {
      return;
    }

    uncachedZones.forEach((key) => pendingZonesRef.current.add(key));

    let qMinX = Infinity,
      qMaxX = -Infinity,
      qMinY = Infinity,
      qMaxY = -Infinity;
    uncachedZones.forEach((key) => {
      const [zxStr, zyStr] = key.split(",");
      const zx = Number(zxStr);
      const zy = Number(zyStr);
      const zMinX = zx * ZONE_SIZE;
      const zMaxX = (zx + 1) * ZONE_SIZE;
      const zMinY = zy * ZONE_SIZE;
      const zMaxY = (zy + 1) * ZONE_SIZE;

      if (zMinX < qMinX) qMinX = zMinX;
      if (zMaxX > qMaxX) qMaxX = zMaxX;
      if (zMinY < qMinY) qMinY = zMinY;
      if (zMaxY > qMaxY) qMaxY = zMaxY;
    });

    try {
      const { data, error } = await supabase
        .from('notas')
        .select('id, texto, x, y, color, fuente, created_at')
        .gte('x', qMinX)
        .lte('x', qMaxX)
        .gte('y', qMinY)
        .lte('y', qMaxY);

      if (error) {
        uncachedZones.forEach((key) => pendingZonesRef.current.delete(key));
        throw error;
      }

      uncachedZones.forEach((key) => {
        pendingZonesRef.current.delete(key);
        cachedZonesRef.current.add(key);
      });

      if (data) {
        let hasNew = false;
        data.forEach((n: any) => {
          const id = String(n.id);
          if (!notesMapRef.current.has(id)) {
            hasNew = true;
            notesMapRef.current.set(id, {
              _id: id,
              text: n.texto || n.text || "",
              x: Number(n.x),
              y: Number(n.y),
              color: n.color || "#ffffff",
              fontFamily: n.fuente || n.fontFamily || "Georgia",
              createdAt: n.created_at || n.createdAt || new Date().toISOString(),
            });
          }
        });

        if (hasNew) {
          setNotes(Array.from(notesMapRef.current.values()));
        }
      }
    } catch (err) {
      console.error("Error cargando notas desde Supabase:", err);
    }
  };

  // Fetch when panning, resizing, or zooming (Debounced 350ms)
  useEffect(() => {
    const timer = setTimeout(() => {
      fetchNotesInViewport(offsetX, offsetY, width, height, scale);
    }, 350);

    return () => {
      clearTimeout(timer);
    };
  }, [offsetX, offsetY, width, height, scale]);

  // Main Canvas Render Loop
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, width, height);
  }, [offsetX, offsetY, width, height, notes]);

  // Secret Dev Reset Key Listener (v + b + n)
  useEffect(() => {
    const keysPressed = new Set<string>();

    const handleKeyDown = async (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) {
        return;
      }

      const key = e.key.toLowerCase();
      keysPressed.add(key);

      if (keysPressed.has("v") && keysPressed.has("b") && keysPressed.has("n")) {
        keysPressed.clear();

        const password = window.prompt("Introduce la contraseña de administrador para borrar todas las notas:");
        if (!password) {
          return;
        }

        console.log("¡Combinación secreta v+b+n detectada! Ejecutando Reset de Pruebas...");

        try {
          const { data, error } = await supabase.functions.invoke("admin-note", {
            body: { action: "clear", password },
          });

          if (error) {
            console.error("Error al invocar admin-note para borrar:", error);
            const errorMsg = await extractEdgeFunctionError(error);
            alert(`Error: ${errorMsg}`);
            return;
          }

          if (data && data.error) {
            console.error("Error al reiniciar La Pared:", data.error);
            alert(`Error: ${data.error}`);
            return;
          }

          localStorage.clear();
          cachedZonesRef.current.clear();
          pendingZonesRef.current.clear();
          notesMapRef.current.clear();
          appearedNoteIdsRef.current.clear();
          console.log("La Pared ha sido reiniciada con éxito.");
          setNotes([]);
          alert("La Pared ha sido reiniciada con éxito.");
        } catch (err: any) {
          console.error("Error al intentar reiniciar La Pared:", err);
          alert(err.message || "Error al intentar reiniciar La Pared.");
        }
      }
    };

    const handleKeyUp = (e: KeyboardEvent) => {
      keysPressed.delete(e.key.toLowerCase());
    };

    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("keyup", handleKeyUp);

    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("keyup", handleKeyUp);
    };
  }, []);

  // Surprise Me Animation & State
  const [isTraveling, setIsTraveling] = useState(false);
  const isTravelingRef = useRef(false);
  const surpriseAnimationRef = useRef<number | null>(null);
  const surpriseOpenTimerRef = useRef<number | null>(null);
  const lastSurpriseNoteIdRef = useRef<string | null>(null);

  // Cancellation helper to cleanly stop any active travel
  const cancelSurpriseTravel = () => {
    if (surpriseAnimationRef.current) {
      cancelAnimationFrame(surpriseAnimationRef.current);
      surpriseAnimationRef.current = null;
    }
    if (surpriseOpenTimerRef.current) {
      clearTimeout(surpriseOpenTimerRef.current);
      surpriseOpenTimerRef.current = null;
    }
    if (isTravelingRef.current) {
      isTravelingRef.current = false;
      setIsTraveling(false);
    }
  };

  useEffect(() => {
    return () => {
      cancelSurpriseTravel();
    };
  }, []);

  const handleSurpriseMe = () => {
    dismissOnboarding();
    cancelSurpriseTravel();

    if (!notes || notes.length === 0) {
      return;
    }

    // Filtrar para evitar repetir la misma nota dos veces seguidas si hay más de una
    let candidates = notes;
    if (notes.length > 1 && lastSurpriseNoteIdRef.current) {
      candidates = notes.filter((n) => n._id !== lastSurpriseNoteIdRef.current);
      if (candidates.length === 0) candidates = notes;
    }

    const randomIndex = Math.floor(Math.random() * candidates.length);
    const targetNote = candidates[randomIndex];
    lastSurpriseNoteIdRef.current = targetNote._id;

    const startX = offsetXRef.current;
    const startY = offsetYRef.current;
    const targetX = targetNote.x;
    const targetY = targetNote.y;

    const startTime = performance.now();
    const duration = 750; // ms animación fluida y suave

    isTravelingRef.current = true;
    setIsTraveling(true);

    const animate = (now: number) => {
      if (!isTravelingRef.current) return;

      const elapsed = now - startTime;
      const progress = Math.min(1, elapsed / duration);

      // Curva de aceleración/desaceleración suave (ease-out cubic)
      const ease = 1 - Math.pow(1 - progress, 3);

      const currentX = Math.round(startX + (targetX - startX) * ease);
      const currentY = Math.round(startY + (targetY - startY) * ease);

      offsetXRef.current = currentX;
      offsetYRef.current = currentY;

      const paredCanvas = document.getElementById("pared-canvas");
      if (paredCanvas) {
        const s = scaleRef.current;
        const w = widthRef.current;
        const h = heightRef.current;
        const camX = -currentX + w / (2 * s);
        const camY = -currentY + h / (2 * s);
        paredCanvas.style.transform = `scale(${s}) translate3d(${Math.round(camX)}px, ${Math.round(camY)}px, 0px)`;
      }

      if (progress < 1) {
        surpriseAnimationRef.current = requestAnimationFrame(animate);
      } else {
        surpriseAnimationRef.current = null;
        isTravelingRef.current = false;
        setIsTraveling(false);
        setOffsetX(targetX);
        setOffsetY(targetY);
        setHoveredNoteId(targetNote._id);

        // Abrir automáticamente la nota en grande con el mismo visor/modal estándar
        setSelectedNote(targetNote);
        dismissOnboarding();

        surpriseOpenTimerRef.current = window.setTimeout(() => {
          setHoveredNoteId(null);
          surpriseOpenTimerRef.current = null;
        }, 1500);
      }
    };

    surpriseAnimationRef.current = requestAnimationFrame(animate);
  };

  // MOUSE DRAG & PAN (Permite iniciar arrastre sobre notas o fondo)
  const handleMouseDown = (e: React.MouseEvent) => {
    if (e.button !== 0) return; // Left click only
    const target = e.target as HTMLElement;

    // Ignorar sólo si está dentro del formulario de creación o botones/elementos UI
    if (
      target.closest("#cuadro-nueva-inscripcion") ||
      target.closest(".wall-ui-element") ||
      target.closest("button") ||
      target.closest("textarea") ||
      target.closest("input")
    ) {
      return;
    }

    cancelSurpriseTravel();

    const noteEl = target.closest(".interactive-note") as HTMLElement | null;
    const noteId = noteEl?.dataset?.noteId || null;

    setIsPointerDown(true);
    setHasMouseDragged(false);
    setMouseDownNoteId(noteId);
    setDragStart({ x: e.clientX, y: e.clientY });
    setDragStartOffset({ x: offsetX, y: offsetY });
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    if (!isPointerDown) return;
    const dx = e.clientX - dragStart.x;
    const dy = e.clientY - dragStart.y;
    const dist = Math.hypot(dx, dy);

    if (!hasMouseDragged && dist > 6) {
      setHasMouseDragged(true);
      setIsDragging(true);
      dismissOnboarding();
    }

    if (hasMouseDragged || dist > 6) {
      setOffsetX(Math.round(dragStartOffset.x - dx / scale));
      setOffsetY(Math.round(dragStartOffset.y - dy / scale));
    }
  };

  const handleMouseUp = (e: React.MouseEvent) => {
    if (isPointerDown) {
      if (!hasMouseDragged && mouseDownNoteId) {
        const found = notes.find((n) => n._id === mouseDownNoteId);
        if (found) {
          setSelectedNote(found);
          dismissOnboarding();
        }
      }
    }
    setIsPointerDown(false);
    setIsDragging(false);
    setHasMouseDragged(false);
    setMouseDownNoteId(null);
  };

  // Touch tracking refs for ultra-smooth 60/120fps direct DOM manipulation
  const touchStartRef = useRef({ x: 0, y: 0 });
  const touchStartOffsetRef = useRef({ x: 0, y: 0 });
  const isTouchDraggingRef = useRef(false);
  const hasTouchMovedBeyondThresholdRef = useRef(false);
  const touchNoteTargetIdRef = useRef<string | null>(null);

  // Pinch-to-zoom tracking refs
  const isPinchingRef = useRef(false);
  const initialPinchDistanceRef = useRef(0);
  const initialPinchScaleRef = useRef(1.0);

  // Double-tap tracking refs
  const lastTouchTimeRef = useRef<number>(0);
  const lastTouchPosRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });

  // Sync state values with refs
  const offsetXRef = useRef(offsetX);
  const offsetYRef = useRef(offsetY);
  const scaleRef = useRef(scale);
  const widthRef = useRef(width);
  const heightRef = useRef(height);

  useEffect(() => {
    offsetXRef.current = offsetX;
  }, [offsetX]);

  useEffect(() => {
    offsetYRef.current = offsetY;
  }, [offsetY]);

  useEffect(() => {
    scaleRef.current = scale;
  }, [scale]);

  useEffect(() => {
    widthRef.current = width;
    heightRef.current = height;
  }, [width, height]);

  // Generic helper to trigger note creation at a screen coordinate (clientX, clientY)
  const triggerCreateNote = (clientX: number, clientY: number) => {
    cancelSurpriseTravel();
    dismissOnboarding();
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;

    const relativeX = clientX - rect.left;
    const relativeY = clientY - rect.top;

    const currentScale = scaleRef.current;
    const currentOffsetX = offsetXRef.current;
    const currentOffsetY = offsetYRef.current;

    const actualX = (relativeX - rect.width / 2) / currentScale + currentOffsetX;
    const actualY = (relativeY - rect.height / 2) / currentScale + currentOffsetY;

    const posicionFinal = calcularPosicionFinal(actualX, actualY);

    setCreatingNote({
      x: posicionFinal.x,
      y: posicionFinal.y,
      canvasX: actualX,
      canvasY: actualY,
      text: "",
      color: "#ffffff",
      fontFamily: "Georgia, serif",
    });
    setSavingError("");
  };

  // Native touch listener to prevent default browser overscroll, and enable pan across notes & empty canvas
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let animationFrameId: number | null = null;
    let pendingUpdate = false;

    const requestUpdate = () => {
      if (pendingUpdate) return;
      pendingUpdate = true;
      animationFrameId = requestAnimationFrame(() => {
        pendingUpdate = false;

        const paredCanvas = document.getElementById("pared-canvas");
        if (paredCanvas) {
          const s = scaleRef.current;
          const oX = offsetXRef.current;
          const oY = offsetYRef.current;
          const w = widthRef.current;
          const h = heightRef.current;
          const camX = -oX + w / (2 * s);
          const camY = -oY + h / (2 * s);

          paredCanvas.style.transform = `scale(${s}) translate3d(${Math.round(camX)}px, ${Math.round(camY)}px, 0px)`;
        }
      });
    };

    const handleTouchStartNative = (e: TouchEvent) => {
      const target = e.target as HTMLElement;

      // Allow normal typing and button interaction inside creating note modal and UI overlays
      if (
        target.closest("#cuadro-nueva-inscripcion") ||
        target.closest(".wall-ui-element") ||
        target.closest("button") ||
        target.closest("textarea") ||
        target.closest("input")
      ) {
        return;
      }

      e.preventDefault();
      cancelSurpriseTravel();

      if (e.touches.length === 1) {
        const touch = e.touches[0];
        const touchX = touch.clientX;
        const touchY = touch.clientY;

        const noteEl = target.closest(".interactive-note") as HTMLElement | null;
        touchNoteTargetIdRef.current = noteEl?.dataset?.noteId || null;
        hasTouchMovedBeyondThresholdRef.current = false;

        const now = Date.now();
        const lastTouchTime = lastTouchTimeRef.current;
        const lastTouchPos = lastTouchPosRef.current;
        const delay = now - lastTouchTime;
        const dist = Math.hypot(touchX - lastTouchPos.x, touchY - lastTouchPos.y);

        // Double-tap on empty canvas
        if (!touchNoteTargetIdRef.current && delay < 300 && dist < 30) {
          lastTouchTimeRef.current = 0;
          isTouchDraggingRef.current = false;
          isPinchingRef.current = false;
          triggerCreateNote(touchX, touchY);
          return;
        }

        lastTouchTimeRef.current = now;
        lastTouchPosRef.current = { x: touchX, y: touchY };

        // Initiate dragging / panning
        isTouchDraggingRef.current = true;
        isPinchingRef.current = false;
        touchStartRef.current = { x: touchX, y: touchY };
        touchStartOffsetRef.current = { x: offsetXRef.current, y: offsetYRef.current };
      } else if (e.touches.length === 2) {
        // Pinch-to-zoom mode
        isTouchDraggingRef.current = false;
        isPinchingRef.current = true;

        const touch1 = e.touches[0];
        const touch2 = e.touches[1];
        const dx = touch1.clientX - touch2.clientX;
        const dy = touch1.clientY - touch2.clientY;
        initialPinchDistanceRef.current = Math.hypot(dx, dy);
        initialPinchScaleRef.current = scaleRef.current;
      }
    };

    const handleTouchMoveNative = (e: TouchEvent) => {
      const target = e.target as HTMLElement;
      if (
        target.closest("#cuadro-nueva-inscripcion") ||
        target.closest(".wall-ui-element") ||
        target.closest("button") ||
        target.closest("textarea") ||
        target.closest("input")
      ) {
        return;
      }

      e.preventDefault();

      if (e.touches.length === 1 && isTouchDraggingRef.current) {
        const touch = e.touches[0];
        const dx = touch.clientX - touchStartRef.current.x;
        const dy = touch.clientY - touchStartRef.current.y;
        const dist = Math.hypot(dx, dy);

        if (dist > 7) {
          hasTouchMovedBeyondThresholdRef.current = true;
          dismissOnboarding();
        }

        const s = scaleRef.current;
        offsetXRef.current = Math.round(touchStartOffsetRef.current.x - dx / s);
        offsetYRef.current = Math.round(touchStartOffsetRef.current.y - dy / s);

        requestUpdate();
      } else if (e.touches.length === 2 && isPinchingRef.current) {
        const touch1 = e.touches[0];
        const touch2 = e.touches[1];
        const dx = touch1.clientX - touch2.clientX;
        const dy = touch1.clientY - touch2.clientY;
        const currentDistance = Math.hypot(dx, dy);

        if (initialPinchDistanceRef.current > 10) {
          const factor = currentDistance / initialPinchDistanceRef.current;
          const newScale = Math.min(Math.max(initialPinchScaleRef.current * factor, MIN_SCALE), MAX_SCALE);
          scaleRef.current = newScale;

          requestUpdate();
        }
      }
    };

    const handleTouchEndNative = (e: TouchEvent) => {
      if (isTouchDraggingRef.current || isPinchingRef.current) {
        setOffsetX(offsetXRef.current);
        setOffsetY(offsetYRef.current);
        setScale(scaleRef.current);
      }

      // If user tapped a note without dragging beyond threshold, open note modal!
      if (!hasTouchMovedBeyondThresholdRef.current && touchNoteTargetIdRef.current) {
        const noteId = touchNoteTargetIdRef.current;
        const found = notesMapRef.current.get(noteId);
        if (found) {
          setSelectedNote(found);
          dismissOnboarding();
        }
      }

      isTouchDraggingRef.current = false;
      isPinchingRef.current = false;
      hasTouchMovedBeyondThresholdRef.current = false;
      touchNoteTargetIdRef.current = null;
    };

    container.addEventListener("touchstart", handleTouchStartNative, { passive: false });
    container.addEventListener("touchmove", handleTouchMoveNative, { passive: false });
    container.addEventListener("touchend", handleTouchEndNative, { passive: false });
    container.addEventListener("touchcancel", handleTouchEndNative, { passive: false });

    return () => {
      container.removeEventListener("touchstart", handleTouchStartNative);
      container.removeEventListener("touchmove", handleTouchMoveNative);
      container.removeEventListener("touchend", handleTouchEndNative);
      container.removeEventListener("touchcancel", handleTouchEndNative);
      if (animationFrameId) cancelAnimationFrame(animationFrameId);
    };
  }, []);

  // DOUBLE CLICK - Create a Note (Desktop)
  const handleDoubleClick = (e: React.MouseEvent) => {
    const target = e.target as HTMLElement;
    if (
      target.closest(".interactive-note") ||
      target.closest(".wall-ui-element") ||
      target.closest("button") ||
      target.closest("input") ||
      target.closest("textarea")
    ) {
      return;
    }
    triggerCreateNote(e.clientX, e.clientY);
  };

  // SAVE NOTE TO WALL (80 characters limit)
  const handleSaveNote = async () => {
    if (!creatingNote || !creatingNote.text.trim()) return;

    const textTrimmed = creatingNote.text.trim();

    // Strict character limit check of 80 characters
    if (textTrimmed.length > 80 && !textTrimmed.includes(" ")) {
      setSavingError("La inscripción no puede exceder los 80 caracteres.");
      return;
    }

    setSaving(true);
    setSavingError("");

    const finalX = Math.round(creatingNote.x);
    const finalY = Math.round(creatingNote.y);

    try {
      const { data: invokeData, error: invokeError } = await supabase.functions.invoke("admin-note", {
        body: {
          texto: textTrimmed,
          x: finalX,
          y: finalY,
          color: creatingNote.color,
          fuente: creatingNote.fontFamily || 'Georgia',
          client_id: clientId,
        },
      });

      if (invokeError) {
        console.warn("Error al invocar la Edge Function 'admin-note':", invokeError);
        const errorMsg = await extractEdgeFunctionError(invokeError);
        throw new Error(errorMsg);
      }

      if (invokeData && invokeData.error) {
        throw new Error(invokeData.error);
      }

      if (invokeData && invokeData.isAdmin) {
        const zx = Math.floor(finalX / ZONE_SIZE);
        const zy = Math.floor(finalY / ZONE_SIZE);
        cachedZonesRef.current.delete(`${zx},${zy}`);

        await fetchNotesInViewport(offsetX, offsetY, width, height, scale);
        setCreatingNote(null);
      } else if (invokeData && invokeData.isNormal) {
        const hasPosted = localStorage.getItem("lapared_has_posted") === "true";
        if (hasPosted) {
          setShowLimitAlert(true);
          setCreatingNote(null);
          return;
        }

        if (textTrimmed.length > 80) {
          setSavingError("La inscripción no puede exceder los 80 caracteres.");
          setSaving(false);
          return;
        }

        const { data: normalData, error: normalError } = await supabase
          .from('notas')
          .insert([
            {
              texto: textTrimmed,
              x: finalX,
              y: finalY,
              client_id: clientId,
              color: creatingNote.color,
              fuente: creatingNote.fontFamily || 'Georgia',
            },
          ])
          .select();

        if (normalError) {
          if (normalError.code === '23505') {
            setShowLimitAlert(true);
            localStorage.setItem("lapared_has_posted", "true");
            setCreatingNote(null);
            return;
          }
          throw new Error(normalError.message || "Error al grabar la inscripción.");
        }

        if (!normalData || normalData.length === 0) {
          throw new Error("No se pudo obtener la nota grabada de Supabase.");
        }

        const savedNote = normalData[0];
        const finalNote: Note = {
          _id: String(savedNote.id),
          text: savedNote.texto || "",
          x: Number(savedNote.x),
          y: Number(savedNote.y),
          color: savedNote.color || "#ffffff",
          fontFamily: savedNote.fuente || "Georgia",
          createdAt: savedNote.created_at || new Date().toISOString(),
        };

        localStorage.setItem("lapared_has_posted", "true");

        notesMapRef.current.set(finalNote._id, finalNote);
        const zx = Math.floor(finalNote.x / ZONE_SIZE);
        const zy = Math.floor(finalNote.y / ZONE_SIZE);
        cachedZonesRef.current.add(`${zx},${zy}`);

        setNotes(Array.from(notesMapRef.current.values()));
        generateAndDownloadPhoto(finalNote);
        setCreatingNote(null);
      } else {
        throw new Error("Respuesta inválida o desconocida de la Edge Function.");
      }
    } catch (err: any) {
      setSavingError(err.message || "Error al grabar la inscripción en La Pared.");
    } finally {
      setSaving(false);
    }
  };

  // GENERATE PHOTO PNG & DOWNLOAD
  const generateAndDownloadPhoto = (newNote: Note) => {
    const exportCanvas = document.createElement("canvas");
    exportCanvas.width = 800;
    exportCanvas.height = 600;
    const ctx = exportCanvas.getContext("2d");
    if (!ctx) return;

    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, 800, 600);

    const scaleFactor = 0.75;

    notes.forEach((note) => {
      if (note._id === newNote._id) return;
      const relX = (note.x - newNote.x) * scaleFactor + 400;
      const relY = (note.y - newNote.y) * scaleFactor + 300;
      drawNoteOnExportCanvas(ctx, note, relX, relY, scaleFactor, false);
    });

    drawNoteOnExportCanvas(ctx, newNote, 400, 300, scaleFactor, true);

    ctx.save();
    ctx.fillStyle = "#000000";
    ctx.font = "bold 18px monospace";
    ctx.textAlign = "left";
    ctx.fillText("LA PARED", 45, 520);

    ctx.font = "11px monospace";
    ctx.fillStyle = "#737373";
    ctx.fillText("El Registro Inmutable de la Humanidad", 45, 545);

    ctx.textAlign = "right";
    ctx.font = "bold 14px monospace";
    ctx.fillStyle = "#000000";
    ctx.fillText(`COORDS: X: ${newNote.x.toLocaleString()}  |  Y: ${(-newNote.y).toLocaleString()}`, 755, 520);

    ctx.font = "10px monospace";
    ctx.fillStyle = "#a3a3a3";
    ctx.fillText(`Grabado: ${new Date().toLocaleDateString()}`, 755, 545);
    ctx.restore();

    const dataURL = exportCanvas.toDataURL("image/png");
    const link = document.createElement("a");
    link.download = `lapared_inscripcion_${newNote.x}_${-newNote.y}.png`;
    link.href = dataURL;
    link.click();
  };

  const drawNoteOnExportCanvas = (
    ctx: CanvasRenderingContext2D,
    n: Note,
    relX: number,
    relY: number,
    scaleFactor: number,
    isNewNote: boolean
  ) => {
    const w = 250;
    ctx.save();
    ctx.font = `13px ${n.fontFamily || "Georgia, serif"}`;
    const paddingLeftRight = 18;
    const maxWidth = w - paddingLeftRight * 2;

    const paragraphs = n.text.split("\n");
    const lines: string[] = [];

    for (const para of paragraphs) {
      const words = para.split(" ");
      let currentLine = "";

      for (const word of words) {
        if (!word && word !== "") continue;

        const wordWidth = ctx.measureText(word).width;
        if (wordWidth > maxWidth) {
          if (currentLine) {
            lines.push(currentLine);
            currentLine = "";
          }
          let subLine = "";
          for (const char of word) {
            const testSub = subLine + char;
            if (ctx.measureText(testSub).width < maxWidth) {
              subLine = testSub;
            } else {
              lines.push(subLine);
              subLine = char;
            }
          }
          currentLine = subLine;
        } else {
          const space = currentLine ? " " : "";
          const testLine = currentLine + space + word;
          if (ctx.measureText(testLine).width < maxWidth) {
            currentLine = testLine;
          } else {
            lines.push(currentLine);
            currentLine = word;
          }
        }
      }
      if (currentLine) {
        lines.push(currentLine);
      }
    }

    if (lines.length === 0) {
      lines.push("");
    }

    const startYOffset = 25;
    const lineHeight = 17;
    const barHeight = 35;
    const extraPadding = 15;
    let h = startYOffset + lines.length * lineHeight + barHeight + extraPadding;
    if (h < 135) h = 135;

    ctx.restore();

    const margin = (w / 2) * scaleFactor;
    if (relX < -margin || relX > 800 + margin || relY < -(h / 2) * scaleFactor || relY > 600 + (h / 2) * scaleFactor) {
      return;
    }

    ctx.save();
    ctx.translate(relX, relY);
    ctx.scale(scaleFactor, scaleFactor);

    const x = -w / 2;
    const y = -h / 2;

    ctx.fillStyle = isNewNote ? "rgba(0, 0, 0, 0.08)" : "rgba(0, 0, 0, 0.03)";
    ctx.fillRect(x + (isNewNote ? 5 : 3), y + (isNewNote ? 5 : 3), w, h);

    ctx.fillStyle = n.color || "#ffffff";
    ctx.fillRect(x, y, w, h);

    ctx.fillStyle = "#ffffff";
    ctx.fillRect(x + 0.5, y + h - barHeight, w - 1, barHeight - 0.5);

    ctx.strokeStyle = "#000000";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, y + h - barHeight);
    ctx.lineTo(x + w, y + h - barHeight);
    ctx.stroke();

    ctx.strokeStyle = "#000000";
    ctx.lineWidth = isNewNote ? 2 : 1;
    ctx.strokeRect(x, y, w, h);

    if (isNewNote) {
      ctx.strokeStyle = "#000000";
      ctx.lineWidth = 1;
      ctx.strokeRect(x + 4, y + 4, w - 8, h - 8);
    }

    const color = (n.color || "#ffffff").replace("#", "");
    const r = parseInt(color.substring(0, 2), 16);
    const g = parseInt(color.substring(2, 4), 16);
    const b = parseInt(color.substring(4, 6), 16);
    const yiq = (r * 299 + g * 587 + b * 114) / 1000;
    ctx.fillStyle = yiq >= 128 ? "#000000" : "#ffffff";

    ctx.font = `13px ${n.fontFamily || "Georgia, serif"}`;
    ctx.textBaseline = "top";
    ctx.textAlign = "left";

    const textStartY = y + startYOffset;
    for (let i = 0; i < lines.length; i++) {
      ctx.fillText(lines[i], x + paddingLeftRight, textStartY + i * lineHeight);
    }

    ctx.fillStyle = "#000000";
    ctx.font = "8px monospace";
    ctx.textBaseline = "middle";

    ctx.textAlign = "left";
    ctx.fillText("El Registro Inmutable de la Humanidad", x + paddingLeftRight, y + h - barHeight / 2);

    ctx.textAlign = "right";
    ctx.fillText(`X: ${n.x} | Y: ${-n.y}`, x + w - paddingLeftRight, y + h - barHeight / 2);

    ctx.restore();
  };

  const getTextColor = (hex: string) => {
    const color = hex.replace("#", "");
    const r = parseInt(color.substring(0, 2), 16);
    const g = parseInt(color.substring(2, 4), 16);
    const b = parseInt(color.substring(4, 6), 16);
    const yiq = (r * 299 + g * 587 + b * 114) / 1000;
    return yiq >= 128 ? "text-neutral-900" : "text-white";
  };

  const isMobile = width < 768;
  const isTabletOrMobile = width < 1024;

  return (
    <div className="relative w-full h-full overflow-hidden select-none">
      <AmbientBackground />

      {/* Top Navbar HUD */}
      <div
        className="absolute top-0 left-0 right-0 p-4 md:px-8 md:py-5 flex flex-col md:flex-row gap-3 md:gap-4 items-center justify-between bg-transparent pointer-events-none"
        style={{ zIndex: 10 }}
      >
        {/* Elegant Brand Title */}
        <div className="flex flex-col items-center md:items-start text-center md:text-left pointer-events-auto">
          <h1 className="text-2xl md:text-3xl font-light tracking-[0.45em] uppercase text-black mb-1 select-none font-sans [text-shadow:_0_1px_3px_rgba(255,255,255,0.8)]">
            LA PARED
          </h1>
          <p className="text-[9px] md:text-[10px] text-neutral-400 uppercase tracking-[0.25em] font-sans [text-shadow:_0_1px_2px_rgba(255,255,255,0.8)]">
            El registro inmutable de la humanidad
          </p>
        </div>

        {/* Dynamic Navigation Coordinates HUD & Sorpréndeme */}
        <div className="flex items-center gap-3 md:gap-4 pointer-events-auto flex-wrap justify-center">
          {/* 🎲 Sorpréndeme Button (Desktop Only) */}
          <button
            id="btn-sorprendeme"
            onClick={handleSurpriseMe}
            className="hidden md:flex gallery-ui px-3.5 py-2 md:px-4 md:py-2.5 shadow-[4px_4px_0px_0px_rgba(0,0,0,1)] bg-white border border-black hover:bg-neutral-50 active:translate-y-0.5 text-xs font-mono font-bold text-black items-center gap-2 cursor-pointer transition-all hover:shadow-[6px_6px_0px_0px_rgba(0,0,0,1)]"
            title="Viajar hacia una nota existente de manera inesperada"
          >
            <span className="text-sm">🎲</span>
            <span className="tracking-wider uppercase text-xs">Sorpréndeme</span>
          </button>

          <div className="gallery-ui px-3.5 py-1.5 md:px-5 md:py-2.5 shadow-[3px_3px_0px_0px_rgba(0,0,0,1)] md:shadow-[4px_4px_0px_0px_rgba(0,0,0,1)] bg-white border border-black flex items-center gap-3 md:gap-5">
            <div className="flex flex-col items-center md:items-end">
              <span className="text-[8px] uppercase text-neutral-400 tracking-widest leading-none font-mono font-bold">
                Coordenadas
              </span>
              <span className="text-xs font-mono font-bold text-black mt-1">
                X: {offsetX.toLocaleString()} <span className="text-neutral-300 mx-1">|</span> Y: {(-offsetY).toLocaleString()}
              </span>
            </div>
            <div className="w-px h-6 bg-neutral-200" />
            <div className="flex flex-col items-center md:items-end">
              <span className="text-[8px] uppercase text-neutral-400 tracking-widest leading-none font-mono font-bold">
                Zoom
              </span>
              <span className="text-xs font-mono font-bold text-black mt-1">
                {Math.round(scale * 100)}%
              </span>
            </div>
          </div>

          {/* 💬 LA SALA Button */}
          <button
            id="btn-la-sala"
            onClick={() => setIsSalaOpen(true)}
            className="gallery-ui px-3.5 py-1.5 md:px-4 md:py-2.5 shadow-[3px_3px_0px_0px_rgba(0,0,0,1)] md:shadow-[4px_4px_0px_0px_rgba(0,0,0,1)] bg-white border border-black hover:bg-neutral-50 active:translate-y-0.5 text-xs font-mono font-bold text-black flex items-center gap-1.5 md:gap-2 cursor-pointer transition-all hover:shadow-[5px_5px_0px_0px_rgba(0,0,0,1)]"
            title="Entrar a La Sala efímera"
          >
            <MessageSquare className="w-3.5 h-3.5 text-black" />
            <span className="tracking-wider uppercase text-[10px] md:text-xs">La Sala</span>
          </button>
        </div>
      </div>

      {/* First Visit Discovery Banner / Tooltip */}
      {isOnboardingActive && (
        <div
          className="wall-ui-element absolute top-28 md:top-24 left-1/2 -translate-x-1/2 z-30 pointer-events-auto animate-in fade-in slide-in-from-top-4 duration-300 px-4 w-full max-w-md text-center"
        >
          <div className="bg-white border-2 border-black shadow-[6px_6px_0px_0px_rgba(0,0,0,1)] p-3 md:p-3.5 flex items-center justify-between gap-3">
            <div className="flex items-center gap-2.5 text-left">
              <span className="text-base md:text-lg">✨</span>
              <div>
                <p className="text-[11px] md:text-xs font-bold text-black font-sans leading-tight">
                  {isMobile
                    ? "Toca dos veces cualquier lugar para dejar tu nota"
                    : "Haz doble clic en cualquier lugar para dejar tu nota"}
                </p>
                <p className="text-[9px] text-neutral-500 font-mono mt-0.5">
                  Arrastra para navegar • Consulta el Manual (?) para más ayuda
                </p>
              </div>
            </div>
            <button
              onClick={dismissOnboarding}
              className="text-neutral-400 hover:text-black p-1 transition-colors"
              title="Cerrar ayuda"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>
      )}

      {/* Main Drag-to-Pan Canvas Area */}
      <div
        ref={containerRef}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
        onDoubleClick={handleDoubleClick}
        className={`absolute inset-0 w-full h-full ${
          isDragging ? "cursor-grabbing" : "cursor-grab"
        }`}
        style={{ zIndex: 1, touchAction: "none" }}
      >
        <div
          id="pared-canvas"
          className="absolute inset-0 w-full h-full"
          style={{
            transform: `scale(${scale}) translate3d(${Math.round(cameraX)}px, ${Math.round(cameraY)}px, 0px)`,
            transformOrigin: "0 0",
            transformStyle: "preserve-3d",
            backfaceVisibility: "hidden",
            willChange: "transform",
            filter: isTraveling ? "blur(1.5px)" : "none",
            opacity: isTraveling ? 0.88 : 1,
            transition: isTraveling
              ? "filter 0.25s ease-out, opacity 0.25s ease-out"
              : "filter 0.3s ease-out, opacity 0.3s ease-out",
          }}
        >
          <canvas ref={canvasRef} className="absolute inset-0 block w-full h-full bg-transparent" />

          {/* Floating Minimalist Sticky Notes */}
          {notes.map((note, index) => {
            const visualX = (note.x - offsetX) * scale + width / 2;
            const visualY = (note.y - offsetY) * scale + height / 2;

            const noteWidth = isMobile ? 180 : 250;
            const halfNoteWidth = noteWidth / 2;
            const visualWidth = noteWidth * scale;
            const visualHeight = (isMobile ? 110 : 120) * scale;

            if (
              visualX < -visualWidth ||
              visualX > width + visualWidth ||
              visualY < -visualHeight ||
              visualY > height + visualHeight
            ) {
              return null;
            }

            const txtColor = getTextColor(note.color || "#ffffff");
            const isHovered = hoveredNoteId === note._id;
            const baseZIndex = Math.min(99, notes.length - index);
            const zIndex = isHovered ? 100 : baseZIndex;

            const isNewNote = !appearedNoteIdsRef.current.has(note._id);
            if (isNewNote) {
              appearedNoteIdsRef.current.add(note._id);
            }

            return (
              <div
                key={note._id}
                data-note-id={note._id}
                className={`interactive-note absolute p-4 md:p-5 border border-black shadow-[4px_4px_0px_0px_rgba(0,0,0,1)] hover:shadow-[7px_7px_0px_0px_rgba(0,0,0,1)] hover:-translate-y-0.5 active:translate-y-0.5 cursor-pointer select-text flex flex-col justify-between ${
                  isNewNote ? "animate-note-fade-in" : ""
                } ${
                  isHovered ? "ring-2 ring-black scale-105" : ""
                }`}
                style={{
                  left: `${Math.round(note.x - halfNoteWidth)}px`,
                  top: `${Math.round(note.y - 60)}px`,
                  width: `${noteWidth}px`,
                  minHeight: isMobile ? "110px" : "120px",
                  height: "auto",
                  backgroundColor: note.color || "#ffffff",
                  transition: "transform 0.15s ease, shadow 0.15s ease",
                  transformStyle: "preserve-3d",
                  backfaceVisibility: "hidden",
                  willChange: "transform",
                  zIndex: zIndex,
                  overflowWrap: "break-word",
                  wordBreak: "normal",
                  whiteSpace: "pre-wrap",
                }}
                onMouseEnter={() => setHoveredNoteId(note._id)}
                onMouseLeave={() => setHoveredNoteId(null)}
              >
                {/* Text message */}
                <p
                  className={`text-[11px] md:text-[13px] leading-relaxed mt-1 mb-3 flex-1 select-text ${txtColor}`}
                  style={{
                    fontFamily: note.fontFamily || "Georgia, serif",
                    wordBreak: "normal",
                    overflowWrap: "break-word",
                    whiteSpace: "pre-wrap",
                    maxWidth: "100%",
                  }}
                >
                  “{note.text}”
                </p>

                {/* Position stamp */}
                <div
                  className={`pt-1.5 md:pt-2 border-t ${
                    note.color === "#171717" || note.color === "#000000"
                      ? "border-white/10 text-neutral-400"
                      : "border-black/10 text-neutral-400"
                  } flex items-center justify-between text-[7px] md:text-[8px] font-mono`}
                >
                  <span
                    className={`font-bold tracking-wider ${
                      note.color === "#171717" || note.color === "#000000" ? "text-white" : "text-black"
                    }`}
                  >
                    LA PARED
                  </span>
                  <span>
                    X:{note.x} Y:{-note.y}
                  </span>
                </div>
              </div>
            );
          })}
        </div>

        {/* Double Click - Creating Note Form Bubble */}
        {creatingNote && (
          <div
            id="cuadro-nueva-inscripcion"
            className="interactive-note absolute p-5 border-2 border-black bg-white shadow-[8px_8px_0px_0px_rgba(0,0,0,1)] flex flex-col justify-between z-30 animate-in fade-in zoom-in-95 duration-200"
            style={{
              left: `${Math.round((creatingNote.canvasX ?? creatingNote.x) * scale + cameraX * scale - (isMobile ? 140 : 200))}px`,
              top: `${Math.round((creatingNote.canvasY ?? creatingNote.y) * scale + cameraY * scale - (isMobile ? 185 : 225))}px`,
              width: isMobile ? "280px" : "400px",
              height: isMobile ? "370px" : "450px",
              transformStyle: "preserve-3d",
              backfaceVisibility: "hidden",
              willChange: "transform",
            }}
          >
            <div className="flex items-center justify-between mb-2 pb-2 border-b border-neutral-100 text-[9px] font-mono text-neutral-400">
              <span className="font-bold uppercase tracking-widest text-black">Nueva Inscripción</span>
              <span>
                X:{creatingNote.x} Y:{-creatingNote.y}
              </span>
            </div>

            <textarea
              id="note-textarea"
              placeholder="Deja tu mensaje de forma permanente..."
              autoFocus
              value={creatingNote.text}
              onChange={(e) => {
                const val = e.target.value;
                if (val.length <= 120) {
                  setCreatingNote((prev) => prev && { ...prev, text: val });
                }
              }}
              maxLength={120}
              className="bg-neutral-50 border border-neutral-200 focus:border-black outline-none p-3 text-xs text-black placeholder-neutral-400 flex-1 resize-none mb-1 focus:ring-0"
              style={{
                fontFamily: creatingNote.fontFamily,
                backgroundColor: creatingNote.color,
                color: getTextColor(creatingNote.color) === "text-white" ? "#ffffff" : "#000000",
              }}
            />

            <div className="text-[10px] font-mono text-neutral-500 mb-2.5 text-right">
              Letras: {creatingNote.text.length} / 80
            </div>

            {/* Custom Color Selector */}
            <div className="mb-2">
              <span className="block text-[8px] uppercase tracking-wider font-mono text-neutral-400 mb-1">
                Fondo de Nota:
              </span>
              <div className="flex gap-1.5 flex-wrap">
                {NOTE_COLORS.map((color) => (
                  <button
                    key={color.hex}
                    type="button"
                    title={color.name}
                    onClick={() =>
                      setCreatingNote((prev) => prev && { ...prev, color: color.hex })
                    }
                    className={`w-5 h-5 rounded-full border transition-transform ${
                      creatingNote.color === color.hex
                        ? "scale-125 border-black ring-1 ring-black/20"
                        : "border-neutral-200 hover:scale-110"
                    }`}
                    style={{ backgroundColor: color.hex }}
                  />
                ))}
              </div>
            </div>

            {/* Custom Font Selector */}
            <div className="mb-3">
              <span className="block text-[8px] uppercase tracking-wider font-mono text-neutral-400 mb-1">
                Tipografía:
              </span>
              <div className="flex gap-1 overflow-x-auto pb-1 custom-scrollbar">
                {AVAILABLE_FONTS.map((f) => (
                  <button
                    key={f.name}
                    type="button"
                    onClick={() =>
                      setCreatingNote((prev) => prev && { ...prev, fontFamily: f.css })
                    }
                    className={`px-2 py-1 text-[9px] border rounded transition-colors whitespace-nowrap ${
                      creatingNote.fontFamily === f.css
                        ? "bg-black text-white border-black font-bold"
                        : "bg-white text-neutral-600 border-neutral-200 hover:border-black hover:text-black"
                    }`}
                    style={{ fontFamily: f.css }}
                  >
                    {f.name}
                  </button>
                ))}
              </div>
            </div>

            {savingError && (
              <div className="text-[9px] text-red-600 bg-red-50 border border-red-200 p-2 rounded-none mb-2.5 leading-tight font-mono">
                {savingError}
              </div>
            )}

            <div className="flex gap-2.5">
              <button
                id="btn-cancel-create"
                onClick={() => setCreatingNote(null)}
                className="flex-1 bg-white hover:bg-neutral-50 text-neutral-500 hover:text-black text-[10px] font-bold tracking-widest py-2.5 border border-neutral-200 hover:border-black transition-colors uppercase font-mono"
              >
                DESCARTAR
              </button>
              <button
                id="btn-save-wall"
                onClick={handleSaveNote}
                disabled={saving || !creatingNote.text.trim() || creatingNote.text.length > 80}
                className="flex-1 bg-black text-white hover:bg-neutral-900 disabled:opacity-20 disabled:pointer-events-none text-[10px] font-bold tracking-widest py-2.5 transition-all flex items-center justify-center gap-1.5 uppercase font-mono"
              >
                {saving ? "GRABANDO..." : "GRABAR"}
                <Plus className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Small Elegant Footer */}
      <div
        className="wall-ui-element absolute bottom-3 left-6 right-6 flex justify-between items-center text-[9px] text-neutral-400 font-mono pointer-events-none"
        style={{ zIndex: 20 }}
      >
        <span>100% Anónimo & Libre</span>
      </div>

      {/* Floating Action Button (FAB) for Sorpréndeme on Mobile */}
      <button
        id="btn-sorprendeme-mobile"
        onClick={handleSurpriseMe}
        className="md:hidden wall-ui-element absolute right-6 px-3 py-2 bg-white border border-neutral-300 hover:border-black shadow-[2px_2px_4px_rgba(0,0,0,0.1)] active:shadow-[3px_3px_0px_0px_rgba(0,0,0,1)] active:translate-y-0.5 text-xs font-mono font-bold text-black flex items-center gap-1.5 cursor-pointer transition-all hover:scale-105 active:scale-95"
        style={{
          zIndex: 25,
          bottom: isTabletOrMobile
            ? "calc(env(safe-area-inset-bottom) + 5.5rem + 102px)"
            : "5.5rem",
        }}
        title="Viajar hacia una nota existente de manera inesperada"
      >
        <span className="text-xs">🎲</span>
        <span className="tracking-wider uppercase text-[10px]">Sorpréndeme</span>
      </button>

      {/* Floating Action Button (FAB) for Manual */}
      <button
        id="btn-manual-pared"
        onClick={() => {
          setIsManualOpen(true);
          dismissOnboarding();
        }}
        className={`wall-ui-element absolute right-6 w-11 h-11 rounded-full bg-white border border-neutral-300 hover:border-black shadow-[2px_2px_4px_rgba(0,0,0,0.1)] hover:shadow-[4px_4px_0px_0px_rgba(0,0,0,1)] flex items-center justify-center text-sm font-mono font-bold text-black transition-all hover:scale-105 active:scale-95 cursor-pointer ${
          isOnboardingActive ? "ring-2 ring-black/40 animate-pulse" : ""
        }`}
        style={{
          zIndex: 25,
          bottom: isTabletOrMobile ? "calc(env(safe-area-inset-bottom) + 5.5rem + 50px)" : "2.5rem",
        }}
        title="Manual de La Pared"
      >
        <HelpCircle className="w-5 h-5 text-black" />
      </button>

      {/* Manual Overlay Modal */}
      {isManualOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4 animate-in fade-in duration-200">
          <div className="w-full max-w-sm bg-white border border-black p-6 shadow-[8px_8px_0px_0px_rgba(0,0,0,1)] animate-in fade-in zoom-in-95 duration-200">
            <div className="flex items-start justify-between pb-3 border-b border-neutral-100 mb-4">
              <h3 className="text-xs font-bold uppercase tracking-wider font-mono text-black flex items-center gap-1.5">
                <HelpCircle className="w-4 h-4 text-black" />
                MANUAL DE LA PARED
              </h3>
              <button
                onClick={() => setIsManualOpen(false)}
                className="text-neutral-400 hover:text-black transition-colors"
              >
                <X className="w-4.5 h-4.5" />
              </button>
            </div>

            <ul className="text-xs text-neutral-600 space-y-3 font-sans leading-relaxed mb-6">
              <li className="flex gap-2.5">
                <span className="text-black font-mono font-bold">01/</span>
                <span>Arrastra el lienzo infinito para navegar por las coordenadas espaciales. Puedes arrastrar desde cualquier lugar, incluso encima de una nota.</span>
              </li>
              <li className="flex gap-2.5">
                <span className="text-black font-mono font-bold">02/</span>
                <span>
                  {isMobile ? "Toca dos veces" : "Haz doble clic"} en cualquier espacio del lienzo para comenzar una inscripción de hasta 80 caracteres.
                </span>
              </li>
              <li className="flex gap-2.5">
                <span className="text-black font-mono font-bold">03/</span>
                <span>Escoge el color de fondo, tu tipografía ideal y escribe tu mensaje. Haz clic en <b className="text-black">Grabar</b> para fijarla en el espacio.</span>
              </li>
              <li className="flex gap-2.5">
                <span className="text-black font-mono font-bold">04/</span>
                <span>Toca cualquier inscripción existente para leerla a detalle, o pulsa <b className="text-black">🎲 Sorpréndeme</b> para viajar hacia notas inesperadas.</span>
              </li>
            </ul>

            <button
              onClick={() => setIsManualOpen(false)}
              className="w-full bg-black text-white hover:bg-neutral-900 py-2.5 text-[10px] font-bold font-mono tracking-widest uppercase transition-colors"
            >
              Comenzar a explorar
            </button>
          </div>
        </div>
      )}

      {/* One Note Per Person Limit Alert Popup */}
      {showLimitAlert && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4 animate-in fade-in duration-200">
          <div className="w-full max-w-sm bg-white border border-black p-6 shadow-[8px_8px_0px_0px_rgba(0,0,0,1)] animate-in fade-in zoom-in-95 duration-200">
            <div className="flex items-start justify-between pb-3 border-b border-neutral-100 mb-4">
              <h3 className="text-xs font-bold uppercase tracking-wider font-mono text-black flex items-center gap-1.5">
                <Sparkles className="w-4 h-4 text-black animate-pulse" />
                Límite Alcanzado
              </h3>
              <button
                onClick={() => setShowLimitAlert(false)}
                className="text-neutral-400 hover:text-black transition-colors"
              >
                <X className="w-4.5 h-4.5" />
              </button>
            </div>
            <p className="text-xs text-neutral-600 leading-relaxed mb-5 font-sans">
              Ya has dejado tu huella en La Pared durante tu sesión. Para mantener la inmutabilidad y la pureza de este espacio colectivo, solo se permite grabar una sola inscripción por persona.
            </p>
            <button
              onClick={() => setShowLimitAlert(false)}
              className="w-full bg-black text-white hover:bg-neutral-900 py-2.5 text-[10px] font-bold font-mono tracking-widest uppercase transition-colors"
            >
              Entendido
            </button>
          </div>
        </div>
      )}

      {/* La Sala Ephemeral Chat Modal */}
      <LaSalaModal
        clientId={clientId}
        isOpen={isSalaOpen}
        onClose={() => setIsSalaOpen(false)}
      />
    </div>
  );
}
