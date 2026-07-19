import React from "react";
import { X, Calendar, Compass } from "lucide-react";
import { Note } from "../types";

interface NoteDetailsModalProps {
  note: Note;
  onClose: () => void;
}

export default function NoteDetailsModal({ note, onClose }: NoteDetailsModalProps) {
  const formatDate = (dateString: string) => {
    try {
      const date = new Date(dateString);
      return date.toLocaleDateString("es-ES", {
        year: "numeric",
        month: "long",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      });
    } catch (e) {
      return dateString;
    }
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

  const getSecondaryTextColor = (hex: string) => {
    const color = hex.replace("#", "");
    const r = parseInt(color.substring(0, 2), 16);
    const g = parseInt(color.substring(2, 4), 16);
    const b = parseInt(color.substring(4, 6), 16);
    const yiq = (r * 299 + g * 587 + b * 114) / 1000;
    return yiq >= 128 ? "text-neutral-500" : "text-white/60";
  };

  const getBorderColor = (hex: string) => {
    const color = hex.replace("#", "");
    const r = parseInt(color.substring(0, 2), 16);
    const g = parseInt(color.substring(2, 4), 16);
    const b = parseInt(color.substring(4, 6), 16);
    const yiq = (r * 299 + g * 587 + b * 114) / 1000;
    return yiq >= 128 ? "border-neutral-200" : "border-white/10";
  };

  const textColorClass = getTextColor(note.color || "#ffffff");
  const secondaryColorClass = getSecondaryTextColor(note.color || "#ffffff");
  const borderColorClass = getBorderColor(note.color || "#ffffff");

  return (
    <div
      id="note-details-overlay"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4 animate-in fade-in duration-200"
      onClick={onClose}
    >
      <div
        id="note-details-modal"
        className="w-full max-w-md border border-black shadow-[8px_8px_0px_0px_rgba(0,0,0,1)] overflow-hidden flex flex-col p-6 animate-in fade-in zoom-in-95 duration-200"
        style={{
          backgroundColor: note.color || "#ffffff",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className={`flex items-start justify-between pb-4 border-b ${borderColorClass} mb-5`}>
          <div>
            <span className={`text-[10px] font-mono tracking-[0.2em] uppercase ${secondaryColorClass}`}>Inscripción Grabada</span>
            <h3 className={`text-sm font-bold font-mono mt-1 flex items-center gap-1.5 ${textColorClass}`}>
              <Compass className="w-4 h-4 shrink-0" />
              X: {note.x.toLocaleString()} | Y: {note.y.toLocaleString()}
            </h3>
          </div>
          <button
            id="close-details-modal"
            onClick={onClose}
            className={`${secondaryColorClass} hover:opacity-80 transition-opacity p-1`}
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 py-2">
          <p 
            className="text-lg leading-relaxed font-light"
            style={{
              fontFamily: note.fontFamily || "Georgia",
              color: (note.color === "#171717" || note.color === "#000000") ? "#ffffff" : "#000000",
              wordBreak: "break-all",
              overflowWrap: "break-word",
              whiteSpace: "pre-wrap",
              maxWidth: "100%",
            }}
          >
            “{note.text}”
          </p>
        </div>

        {/* Footer */}
        <div className={`mt-8 pt-4 border-t ${borderColorClass} flex items-center justify-between text-[10px] font-mono ${secondaryColorClass}`}>
          <span className="flex items-center gap-1.5">
            <Calendar className="w-3.5 h-3.5" />
            Engravado el {formatDate(note.createdAt)}
          </span>
          <span className={`uppercase font-bold tracking-wider ${textColorClass}`}>La Pared</span>
        </div>
      </div>
    </div>
  );
}
