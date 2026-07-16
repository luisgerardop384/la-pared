import React, { useEffect, useRef, useState } from "react";
import { Compass, Plus, Sparkles, HelpCircle, X, Download } from "lucide-react";
import { Note } from "../types";
import { supabase } from '../supabaseClient';

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
  { name: "Sombra", hex: "#171717" },
];

const AVAILABLE_FONTS = [
  { name: "Máquina de escribir", css: "'Courier New', Courier, monospace" },
  { name: "Elegante", css: "Georgia, serif" },
  { name: "Moderna", css: "Arial, Helvetica, sans-serif" },
  { name: "Manuscrita", css: "'Caveat', cursive, sans-serif" },
  { name: "Llamativa", css: "'Impact', sans-serif" },
];


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

  const [isDragging, setIsDragging] = useState(false);
  const [dragStart, setDragStart] = useState({ x: 0, y: 0 });
  const [dragStartOffset, setDragStartOffset] = useState({ x: 0, y: 0 });

  const [width, setWidth] = useState(800);
  const [height, setHeight] = useState(600);

  // Camera scale (Zoom limits: MIN_SCALE=0.35, MAX_SCALE=1.8, starts at 1.0)
  const [scale, setScale] = useState(1.0);
  const MIN_SCALE = 0.35;
  const MAX_SCALE = 1.8;

  // Camera translation variables (as defined mathematically to match view coordinates centered on offsetX/Y)
  const cameraX = -offsetX + width / (2 * scale);
  const cameraY = -offsetY + height / (2 * scale);

  // Aplicar la escala y posición al contenedor de la pared
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

  // Run camera transformation whenever scale, cameraX, or cameraY change
  useEffect(() => {
    aplicarTransformacionCamara();
  }, [scale, cameraX, cameraY]);

  // SISTEMA ANTICOLISIÓN - Desactivado para permitir ubicación libre exacta
  const calcularPosicionFinal = (
    clickX: number,
    clickY: number,
    notasExistentes: Note[]
  ): { x: number; y: number } => {
    return { x: Math.round(clickX), y: Math.round(clickY) };
  };

  // Creation state with canvas relative coordinates to center precisely
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
      e.preventDefault();
      const zoomFactor = 0.08; // Smooth zoom adjustment speed
      setScale((prevScale) => {
        const delta = e.deltaY < 0 ? zoomFactor : -zoomFactor;
        const newScale = Math.min(Math.max(prevScale + delta, MIN_SCALE), MAX_SCALE);
        return newScale;
      });
    };

    container.addEventListener("wheel", handleWheel, { passive: false });
    return () => {
      container.removeEventListener("wheel", handleWheel);
    };
  }, []);

  // Fetch Notes in Viewport
  const fetchNotesInViewport = async (curX: number, curY: number, viewW: number, viewH: number, curScale: number) => {
    // If zoomed out (low scale), the world area seen is much larger
    const worldW = viewW / curScale;
    const worldH = viewH / curScale;
    // Extra padding around viewport to load notes on edges smoothly
    const padX = Math.round(worldW * 1.5);
    const padY = Math.round(worldH * 1.5);
    const minX = Math.round(curX - padX);
    const maxX = Math.round(curX + padX);
    const minY = Math.round(curY - padY);
    const maxY = Math.round(curY + padY);

    try {
      if (supabase) {
        const { data, error } = await supabase
          .from('notas') // Asegúrate de que tu tabla en Supabase se llame exactamente 'notas'
          .select('*')
          .gte('x', minX)
          .lte('x', maxX)
          .gte('y', minY)
          .lte('y', maxY);

        if (error) throw error;

        if (data) {
          const mapped = data.map((n: any) => ({
            _id: n.id,
            text: n.texto || n.text || "",
            x: n.x,
            y: n.y,
            color: n.color || "#ffffff",
            fontFamily: n.fuente || n.fontFamily || "Georgia",
            createdAt: n.created_at || n.createdAt || new Date().toISOString(),
          }));
          setNotes(mapped);
          return;
        }
      }
    } catch (err) {
  console.error("DEBUG SUPABASE:", err);
  alert("Error: " + JSON.stringify(err));
}

    // Fallback a la API de Express local
    try {
      const res = await fetch(`/api/notes?minX=${minX}&maxX=${maxX}&minY=${minY}&maxY=${maxY}`);
      if (res.ok) {
        const data = await res.json();
        setNotes(data);
      }
    } catch (err) {
      console.error("Error cargando notas desde la API local:", err);
    }
  };

  // Fetch when panning, resizing, or zooming
  useEffect(() => {
    fetchNotesInViewport(offsetX, offsetY, width, height, scale);
  }, [offsetX, offsetY, width, height, scale]);

  // Main Canvas Render Loop - Estética Pureza Blanca (Sin Cuadrícula)
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    // Pure white canvas background completely liso
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, width, height);
  }, [offsetX, offsetY, width, height, notes]);

  // Secret Dev Reset Key Listener (v + b + n)
  useEffect(() => {
    const keysPressed = new Set<string>();

    const handleKeyDown = async (e: KeyboardEvent) => {
      const key = e.key.toLowerCase();
      keysPressed.add(key);

      if (keysPressed.has("v") && keysPressed.has("b") && keysPressed.has("n")) {
        keysPressed.clear();
        console.log("¡Combinación secreta v+b+n detectada! Ejecutando Reset de Pruebas...");

        // 1. Borrar localStorage
        localStorage.clear();

        try {
          // 2. Enviar petición rápida a endpoint de backend
          const res = await fetch("/api/dev/limpiar", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
            },
          });

          if (res.ok) {
            console.log("La Pared ha sido reiniciada con éxito.");
          } else {
            console.error("Error al reiniciar La Pared en el servidor.");
          }
        } catch (err) {
          console.error("Error de red al intentar reiniciar La Pared:", err);
        } finally {
          // 3. Refrescar la página automáticamente
          window.location.reload();
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

  // DRAG & PAN EVENTS
  const handleMouseDown = (e: React.MouseEvent) => {
    if (e.button !== 0) return; // Left click only
    const target = e.target as HTMLElement;
    if (target.closest(".interactive-note") || target.closest(".wall-ui-element")) return;

    setIsDragging(true);
    setDragStart({ x: e.clientX, y: e.clientY });
    setDragStartOffset({ x: offsetX, y: offsetY });
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    if (!isDragging) return;
    const dx = e.clientX - dragStart.x;
    const dy = e.clientY - dragStart.y;
    setOffsetX(Math.round(dragStartOffset.x - dx / scale));
    setOffsetY(Math.round(dragStartOffset.y - dy / scale));
  };

  const handleMouseUp = () => {
    setIsDragging(false);
  };

  // Touch support for mobile devices
  const handleTouchStart = (e: React.TouchEvent) => {
    const target = e.target as HTMLElement;
    if (target.closest(".interactive-note") || target.closest(".wall-ui-element")) return;

    setIsDragging(true);
    const touch = e.touches[0];
    setDragStart({ x: touch.clientX, y: touch.clientY });
    setDragStartOffset({ x: offsetX, y: offsetY });
  };

  const handleTouchMove = (e: React.TouchEvent) => {
    if (!isDragging) return;
    const touch = e.touches[0];
    const dx = touch.clientX - dragStart.x;
    const dy = touch.clientY - dragStart.y;
    setOffsetX(Math.round(dragStartOffset.x - dx / scale));
    setOffsetY(Math.round(dragStartOffset.y - dy / scale));
  };

  const handleTouchEnd = () => {
    setIsDragging(false);
  };

  // DOUBLE CLICK - Create a Note
  const handleDoubleClick = (e: React.MouseEvent) => {
    const target = e.target as HTMLElement;
    if (target.closest(".interactive-note") || target.closest(".wall-ui-element")) return;

    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;

    const clientX = e.clientX - rect.left;
    const clientY = e.clientY - rect.top;

    // Direct, exact Screen-to-World mapping formula:
    // P_world = (P_screen - center) / scale + offset
    const actualX = (clientX - rect.width / 2) / scale + offsetX;
    const actualY = (clientY - rect.height / 2) / scale + offsetY;

    // 2. Pasar estas coordenadas ajustadas a tu sistema de cuadrícula/colisiones
    const posicionFinal = calcularPosicionFinal(actualX, actualY, notes);

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

  // SAVE NOTE TO WALL (Engrave)
  const handleSaveNote = async () => {
    if (!creatingNote || !creatingNote.text.trim()) return;

    const textTrimmed = creatingNote.text.trim();
    const isAdmin = textTrimmed.startsWith("admin123");

    // Strict character limit check
    if (textTrimmed.length > 50) {
      setSavingError("La inscripción no puede exceder los 50 caracteres.");
      return;
    }

    // Extra double-check for limit before saving (bypass for admin)
    if (!isAdmin) {
      const hasPosted = localStorage.getItem("lapared_has_posted") === "true";
      if (hasPosted) {
        setShowLimitAlert(true);
        setCreatingNote(null);
        return;
      }
    }

    setSaving(true);
    setSavingError("");

    // Guardar exactamente en las coordenadas donde el usuario hizo doble clic
    const finalX = Math.round(creatingNote.x);
    const finalY = Math.round(creatingNote.y);

    try {
      const res = await fetch("/api/notes", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-client-id": clientId,
        },
        body: JSON.stringify({
          text: creatingNote.text,
          x: finalX,
          y: finalY,
          color: creatingNote.color,
          fontFamily: creatingNote.fontFamily,
        }),
      });

      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.error || "No se pudo grabar la inscripción.");
      }

      // Asegurar que el objeto de nota guardado localmente refleje las coordenadas finales sin encimarse
      const finalNote = {
        ...data,
        x: finalX,
        y: finalY
      };

      // Mark as posted in localStorage ONLY if NOT admin
      if (!isAdmin) {
        localStorage.setItem("lapared_has_posted", "true");
      }

      // Add to local state immediately
      setNotes((prev) => [finalNote, ...prev]);

      // Automatically generate PNG photo with exact coordinates and download
      generateAndDownloadPhoto(finalNote);

      // Reset state
      setCreatingNote(null);
    } catch (err: any) {
      setSavingError(err.message || "Error al grabar la inscripción en La Pared.");
    } finally {
      setSaving(false);
    }
  };

  // GENERATE PHOTO PNG & DOWNLOAD WITH WIDE CONTEXT
  // GENERATE PHOTO PNG & DOWNLOAD WITH WIDE CONTEXT
  const generateAndDownloadPhoto = (newNote: Note) => {
    const exportCanvas = document.createElement("canvas");
    exportCanvas.width = 800;
    exportCanvas.height = 600;
    const ctx = exportCanvas.getContext("2d");
    if (!ctx) return;

    // 1. Clear with clean white background
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, 800, 600);

    const scaleFactor = 0.75; // "Zoom out" camera ratio with generous surrounding space

    // 2. Render all neighboring notes that are close to the center (newNote)
    // Draw other notes first as background neighbors
    notes.forEach((note) => {
      if (note._id === newNote._id) return; // Draw newNote last to be on top

      // Calculate relative screen coordinate on the 800x600 canvas
      // centered around newNote (which will be at 400, 300) and zoomed out by scaleFactor
      const relX = (note.x - newNote.x) * scaleFactor + 400;
      const relY = (note.y - newNote.y) * scaleFactor + 300;

      // Draw neighboring note
      drawNoteOnExportCanvas(ctx, note, relX, relY, scaleFactor, false);
    });

    // 3. Draw the newly created note right in the center (400, 300)
    drawNoteOnExportCanvas(ctx, newNote, 400, 300, scaleFactor, true);

    // 4. Draw HUD Watermark on the exported photo
    // Minimalist layout stamp
    ctx.save();
    ctx.fillStyle = "#000000";
    ctx.font = "bold 18px monospace";
    ctx.textAlign = "left";
    ctx.fillText("LA PARED", 45, 520);

    ctx.font = "11px monospace";
    ctx.fillStyle = "#737373";
    ctx.fillText("El Registro Inmutable de la Humanidad", 45, 545);

    // Stamp coordinates in the bottom right corner
    ctx.textAlign = "right";
    ctx.font = "bold 14px monospace";
    ctx.fillStyle = "#000000";
    ctx.fillText(`COORDS: X: ${newNote.x.toLocaleString()}  |  Y: ${newNote.y.toLocaleString()}`, 755, 520);

    ctx.font = "10px monospace";
    ctx.fillStyle = "#a3a3a3";
    ctx.fillText(`Grabado: ${new Date().toLocaleDateString()}`, 755, 545);
    ctx.restore();

    // 5. Download Trigger
    const dataURL = exportCanvas.toDataURL("image/png");
    const link = document.createElement("a");
    link.download = `lapared_inscripcion_${newNote.x}_${newNote.y}.png`;
    link.href = dataURL;
    link.click();
  };

  // Helper to draw a single note card on the export canvas
  const drawNoteOnExportCanvas = (
    ctx: CanvasRenderingContext2D,
    n: Note,
    relX: number,
    relY: number,
    scaleFactor: number,
    isNewNote: boolean
  ) => {
    // Proportions matching the interactive card precisely:
    // On desktop screen: width is 250px
    const w = 250;
    
    // First, calculate wrapping to determine dynamic height
    ctx.save();
    ctx.font = `13px ${n.fontFamily || "Georgia, serif"}`;
    const paddingLeftRight = 18;
    const maxWidth = w - paddingLeftRight * 2; // 214px

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

    // Dynamic height based on wrapped lines
    const startYOffset = 25;
    const lineHeight = 17;
    const barHeight = 35;
    const extraPadding = 15;
    let h = startYOffset + lines.length * lineHeight + barHeight + extraPadding;
    if (h < 135) h = 135; // minimum height to ensure good spacing

    ctx.restore(); // Restore context to clean state

    // Skip if totally out of export viewport bounds (accounting for scaling and size)
    const margin = (w / 2) * scaleFactor;
    if (relX < -margin || relX > 800 + margin || relY < -(h/2)*scaleFactor || relY > 600 + (h/2)*scaleFactor) {
      return;
    }

    ctx.save();
    // Translate and scale the context for perfect vector proportions!
    ctx.translate(relX, relY);
    ctx.scale(scaleFactor, scaleFactor);

    // Centered at (0, 0), so x and y are relative
    const x = -w / 2;
    const y = -h / 2;

    // Minimalist solid shadow offset (scaled automatically)
    ctx.fillStyle = isNewNote ? "rgba(0, 0, 0, 0.08)" : "rgba(0, 0, 0, 0.03)";
    ctx.fillRect(x + (isNewNote ? 5 : 3), y + (isNewNote ? 5 : 3), w, h);

    // Draw note body
    ctx.fillStyle = n.color || "#ffffff";
    ctx.fillRect(x, y, w, h);

    // Draw bottom white bar (barra técnica inferior)
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(x + 0.5, y + h - barHeight, w - 1, barHeight - 0.5);

    // Draw divider line between the note body and the white bottom bar
    ctx.strokeStyle = "#000000";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, y + h - barHeight);
    ctx.lineTo(x + w, y + h - barHeight);
    ctx.stroke();

    // Draw note border
    ctx.strokeStyle = "#000000";
    ctx.lineWidth = isNewNote ? 2 : 1;
    ctx.strokeRect(x, y, w, h);

    // Double border inside to highlight newly created note
    if (isNewNote) {
      ctx.strokeStyle = "#000000";
      ctx.lineWidth = 1;
      ctx.strokeRect(x + 4, y + 4, w - 8, h - 8);
    }

    // Determine contrast text color for the note body text
    const color = (n.color || "#ffffff").replace("#", "");
    const r = parseInt(color.substring(0, 2), 16);
    const g = parseInt(color.substring(2, 4), 16);
    const b = parseInt(color.substring(4, 6), 16);
    const yiq = (r * 299 + g * 587 + b * 114) / 1000;
    ctx.fillStyle = yiq >= 128 ? "#000000" : "#ffffff";

    // Typography setting
    ctx.font = `13px ${n.fontFamily || "Georgia, serif"}`;
    ctx.textBaseline = "top";
    ctx.textAlign = "left";

    // Draw wrapped text
    const textStartY = y + startYOffset;
    for (let i = 0; i < lines.length; i++) {
      ctx.fillText(lines[i], x + paddingLeftRight, textStartY + i * lineHeight);
    }

    // Draw content inside the technical white bottom bar
    ctx.fillStyle = "#000000";
    ctx.font = "8px monospace";
    ctx.textBaseline = "middle";

    // Left side: Brand slogan
    ctx.textAlign = "left";
    ctx.fillText("El Registro Inmutable de la Humanidad", x + paddingLeftRight, y + h - barHeight / 2);

    // Right side: Exact coordinates
    ctx.textAlign = "right";
    ctx.fillText(`X: ${n.x} | Y: ${n.y}`, x + w - paddingLeftRight, y + h - barHeight / 2);

    ctx.restore();
  };

  // Helper to determine text contrast based on background color
  const getTextColor = (hex: string) => {
    const color = hex.replace("#", "");
    const r = parseInt(color.substring(0, 2), 16);
    const g = parseInt(color.substring(2, 4), 16);
    const b = parseInt(color.substring(4, 6), 16);
    const yiq = (r * 299 + g * 587 + b * 114) / 1000;
    return yiq >= 128 ? "text-neutral-900" : "text-white";
  };

  const isMobile = width < 768;

  return (
    <div className="relative w-full h-full bg-white overflow-hidden select-none">
      {/* Top Navbar HUD */}
      <div 
        className="wall-ui-element absolute top-0 left-0 right-0 p-4 md:px-8 md:py-5 flex flex-col md:flex-row gap-4 items-center justify-between border-b border-neutral-200/20"
        style={{ 
          zIndex: 10,
          backgroundColor: "rgba(255, 255, 255, 0.15)",
        }}
      >
        {/* Elegant Brand Title */}
        <div className="flex flex-col items-center md:items-start text-center md:text-left">
          <h1 className="text-2xl md:text-3xl font-light tracking-[0.45em] uppercase text-black mb-1 select-none font-sans">
            LA PARED
          </h1>
          <p className="text-[9px] md:text-[10px] text-neutral-400 uppercase tracking-[0.25em] font-sans">
            El registro inmutable de la humanidad
          </p>
        </div>

        {/* Dynamic Navigation Coordinates HUD */}
        <div className="flex items-center gap-4">
          <div className="gallery-ui px-4 py-2.5 md:px-5 md:py-3 shadow-[4px_4px_0px_0px_rgba(0,0,0,1)] bg-white border border-black flex items-center gap-4 md:gap-5">
            <div className="flex flex-col items-center md:items-end">
              <span className="text-[8px] uppercase text-neutral-400 tracking-widest leading-none font-mono font-bold">
                Coordenadas
              </span>
              <span className="text-xs font-mono font-bold text-black mt-1">
                X: {offsetX.toLocaleString()} <span className="text-neutral-300 mx-1">|</span> Y: {offsetY.toLocaleString()}
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
            <div className="w-px h-6 bg-neutral-200" />
            <div className="flex flex-col items-center md:items-end">
              <span className="text-[8px] uppercase text-neutral-400 tracking-widest leading-none font-mono font-bold">
                Cargadas
              </span>
              <span className="text-xs font-mono font-bold text-black mt-1">
                {notes.length} notas
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* Main Drag-to-Pan Canvas Area */}
      <div
        ref={containerRef}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
        onDoubleClick={handleDoubleClick}
        className={`absolute inset-0 w-full h-full ${
          isDragging ? "cursor-grabbing" : "cursor-grab"
        }`}
        style={{ zIndex: 1 }}
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
          }}
        >
          <canvas ref={canvasRef} className="absolute inset-0 block w-full h-full bg-white" />

          {/* Floating Minimalist Sticky Notes */}
          {notes.map((note, index) => {
            // Real visible coordinates on the screen after scale:
            const visualX = (note.x - offsetX) * scale + width / 2;
            const visualY = (note.y - offsetY) * scale + height / 2;

            const noteWidth = isMobile ? 180 : 250;
            const halfNoteWidth = noteWidth / 2;
            const visualWidth = noteWidth * scale;
            const visualHeight = (isMobile ? 110 : 120) * scale;

            // Hide notes that are completely outside the screen for performance
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

            return (
              <div
                key={note._id}
                className="interactive-note absolute p-4 md:p-5 border border-black shadow-[4px_4px_0px_0px_rgba(0,0,0,1)] hover:shadow-[7px_7px_0px_0px_rgba(0,0,0,1)] hover:-translate-y-0.5 active:translate-y-0.5 cursor-pointer select-text flex flex-col justify-between"
                style={{
                  left: `${Math.round(note.x - halfNoteWidth)}px`, // Raw coordinate layout inside translated/scaled canvas, rounded to prevent decimals
                  top: `${Math.round(note.y - 60)}px`,  // Center align based on min-height, rounded to prevent decimals
                  width: `${noteWidth}px`,
                  minHeight: isMobile ? "110px" : "120px",
                  height: "auto",
                  backgroundColor: note.color || "#ffffff",
                  transition: "transform 0.1s ease, shadow 0.1s ease",
                  transformStyle: "preserve-3d",
                  backfaceVisibility: "hidden",
                  willChange: "transform",
                  zIndex: zIndex,
                  overflowWrap: "break-word",
                  wordBreak: "break-all",
                  whiteSpace: "pre-wrap",
                }}
                onMouseEnter={() => setHoveredNoteId(note._id)}
                onMouseLeave={() => setHoveredNoteId(null)}
                onClick={() => setSelectedNote(note)}
              >
                {/* Text message */}
                <p 
                  className={`text-[11px] md:text-[13px] leading-relaxed mt-1 mb-3 flex-1 select-text ${txtColor}`}
                  style={{
                    fontFamily: note.fontFamily || "Georgia, serif",
                    wordBreak: "break-all",
                    overflowWrap: "break-word",
                    whiteSpace: "pre-wrap",
                    maxWidth: "100%",
                  }}
                >
                  “{note.text}”
                </p>

                {/* Position stamp */}
                <div className="pt-1.5 md:pt-2 border-t border-black/10 flex items-center justify-between text-[7px] md:text-[8px] font-mono text-neutral-400">
                  <span className="font-bold tracking-wider text-black">LA PARED</span>
                  <span>X:{note.x} Y:{note.y}</span>
                </div>
              </div>
            );
          })}
        </div>

        {/* Double Click - Creating Note Form Bubble (Remains unscaled for crisp input legibility, but centered over the target cell) */}
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
              <span>X:{creatingNote.x} Y:{creatingNote.y}</span>
            </div>

            <textarea
              id="note-textarea"
              placeholder="Deja tu mensaje de forma permanente..."
              autoFocus
              value={creatingNote.text}
              onChange={(e) => {
                const val = e.target.value;
                if (val.length <= 50) {
                  setCreatingNote((prev) => prev && { ...prev, text: val });
                }
              }}
              maxLength={50}
              className="bg-neutral-50 border border-neutral-200 focus:border-black outline-none p-3 text-xs text-black placeholder-neutral-400 flex-1 resize-none mb-1 focus:ring-0"
              style={{
                fontFamily: creatingNote.fontFamily,
                backgroundColor: creatingNote.color,
                color: getTextColor(creatingNote.color) === "text-white" ? "#ffffff" : "#000000",
              }}
            />

            <div className="text-[10px] font-mono text-neutral-500 mb-2.5 text-right">
              Letras: {creatingNote.text.length} / 50
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
                disabled={saving || !creatingNote.text.trim() || creatingNote.text.length > 50}
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
        <span>Supabase DB</span>
      </div>

      {/* Floating Action Button (FAB) for Manual */}
      <button
        onClick={() => setIsManualOpen(true)}
        className="wall-ui-element absolute bottom-10 right-6 w-11 h-11 rounded-full bg-white border border-neutral-300 hover:border-black shadow-[2px_2px_4px_rgba(0,0,0,0.1)] hover:shadow-[4px_4px_0px_0px_rgba(0,0,0,1)] flex items-center justify-center text-sm font-mono font-bold text-black transition-all hover:scale-105 active:scale-95 cursor-pointer"
        style={{ zIndex: 25 }}
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
                <span>Arrastra el lienzo infinito para navegar por las coordenadas espaciales.</span>
              </li>
              <li className="flex gap-2.5">
                <span className="text-black font-mono font-bold">02/</span>
                <span>Haz <b className="text-black">doble clic</b> en cualquier espacio blanco del lienzo para comenzar una inscripción.</span>
              </li>
              <li className="flex gap-2.5">
                <span className="text-black font-mono font-bold">03/</span>
                <span>Escoge el color de fondo, tu tipografía ideal y escribe tu mensaje. Haz clic en <b className="text-black">Grabar</b> para fijarla en el espacio.</span>
              </li>
              <li className="flex gap-2.5">
                <span className="text-black font-mono font-bold">04/</span>
                <span>Haz clic en cualquier inscripción existente para leerla a detalle y apreciar su ubicación exacta.</span>
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
    </div>
  );
}
