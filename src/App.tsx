import { useEffect, useState } from "react";
import CanvasWall from "./components/CanvasWall";
import NoteDetailsModal from "./components/NoteDetailsModal";
import { Note } from "./types";

export default function App() {
  const [selectedNote, setSelectedNote] = useState<Note | null>(null);
  const [notes, setNotes] = useState<Note[]>([]);
  const [clientId, setClientId] = useState<string>("");

  // Ensure unique persistent anonymous client ID exists
  useEffect(() => {
    let id = localStorage.getItem("lapared_client_id");
    if (!id) {
      id = "client_" + Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
      localStorage.setItem("lapared_client_id", id);
    }
    setClientId(id);
  }, []);

  return (
    <div className="w-screen h-screen overflow-hidden bg-white flex flex-col font-sans antialiased text-black select-none">
      <CanvasWall
        clientId={clientId}
        selectedNote={selectedNote}
        setSelectedNote={setSelectedNote}
        notes={notes}
        setNotes={setNotes}
      />

      {selectedNote && (
        <NoteDetailsModal
          note={selectedNote}
          onClose={() => setSelectedNote(null)}
        />
      )}
    </div>
  );
}
