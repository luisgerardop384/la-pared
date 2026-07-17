import express from "express";
import path from "path";
import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";
import { createServer as createViteServer } from "vite";

dotenv.config();

const app = express();
const PORT = 3000;

// Setup Supabase
const supabaseUrl = process.env.VITE_SUPABASE_URL || 'https://puxbetrtwngjtjowwjmp.supabase.co';
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.VITE_SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InB1eGJldHJ0d25nanRqb3d3am1wIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQxNDY4NjcsImV4cCI6MjA5OTcyMjg2N30.J0K_uK4ql8sJ7ruBz3PeaO7mnmBAt4FEreaZNwpD92Y';
const supabase = createClient(supabaseUrl, supabaseKey);

app.use(express.json());

// API: Healthcheck
app.get("/api/health", (req, res) => {
  res.json({ status: "ok" });
});

// API: Save Note
app.post("/api/notas", async (req, res) => {
  try {
    const { texto, x, y, client_id, color, fuente } = req.body;
    const rawTexto = texto || "";
    const adminPassword = process.env.ADMIN_PASSWORD || "admin123";
    const prefix = adminPassword + " ";

    let finalTexto = rawTexto;
    let isAdmin = false;

    // 1. Check if the text starts with the correct password followed by a space
    if (rawTexto.startsWith(prefix)) {
      isAdmin = true;
      // Strip the password and the space after it
      finalTexto = rawTexto.slice(prefix.length);
    }

    const textTrimmed = finalTexto.trim();

    // 2. Reject if a note contains EXACTLY the administrative password
    if (textTrimmed === adminPassword) {
      return res.status(400).json({ error: "Contenido no permitido" });
    }

    // 3. Do not publish if there is no message remaining after stripping the password
    if (textTrimmed === "") {
      return res.status(400).json({ error: "La inscripción no puede estar vacía." });
    }

    // 4. Character limit check on the final message
    if (textTrimmed.length > 50) {
      return res.status(400).json({ error: "La inscripción no puede exceder los 50 caracteres." });
    }

    // 5. Duplicate client_id limit check (only for non-admins)
    if (!isAdmin) {
      const { data: existingNotes, error: checkError } = await supabase
        .from('notas')
        .select('id')
        .eq('client_id', client_id);

      if (checkError) {
        console.warn("Error checking existing notes:", checkError);
      } else if (existingNotes && existingNotes.length > 0) {
        return res.status(400).json({ limitExceeded: true, error: "Límite excedido" });
      }
    }

    // 6. Generate client id
    const uniqueClientId = isAdmin
      ? "admin_" + Math.random().toString(36).substring(2, 10) + "_" + Date.now()
      : client_id;

    // 7. Insert note
    const { data, error } = await supabase
      .from('notas')
      .insert([
        {
          texto: textTrimmed,
          x: Math.round(x),
          y: Math.round(y),
          client_id: uniqueClientId,
          color,
          fuente: fuente || 'Georgia',
        }
      ])
      .select();

    if (error) {
      if (error.code === '23505') {
        return res.status(400).json({ limitExceeded: true, error: "Límite excedido" });
      }
      return res.status(500).json({ error: "Error de base de datos" });
    }

    if (!data || data.length === 0) {
      return res.status(500).json({ error: "No se pudo guardar la inscripción." });
    }

    return res.json({ success: true, data: data[0], isAdmin });
  } catch (err) {
    return res.status(500).json({ error: "Error interno del servidor" });
  }
});

// API: Clear all notes
app.post("/api/admin/clear-notes", async (req, res) => {
  try {
    const { password } = req.body;
    const adminPassword = process.env.ADMIN_PASSWORD || "admin123";

    if (!password || password !== adminPassword) {
      return res.status(401).json({ error: "Credenciales incorrectas" });
    }

    const { error } = await supabase
      .from('notas')
      .delete()
      .neq('id', 0);

    if (error) {
      console.error("Error deleting notes from Supabase:", error);
      return res.status(500).json({ error: "Error al borrar las notas de la base de datos" });
    }

    return res.json({ success: true, message: "La Pared ha sido reiniciada con éxito." });
  } catch (err) {
    return res.status(500).json({ error: "Error interno del servidor" });
  }
});

async function startServer() {
  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
