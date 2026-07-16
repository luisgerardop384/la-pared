import express from "express";
import path from "path";
import fs from "fs";
import { createServer as createViteServer } from "vite";
import { createClient } from "@supabase/supabase-js";
import joi from "joi";
import dotenv from "dotenv";

dotenv.config();

const app = express();
const PORT = 3000;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;

app.use(express.json());

// Create data directory for JSON fallback
const DATA_DIR = path.join(process.cwd(), "data");
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}
const LOCAL_DB_PATH = path.join(DATA_DIR, "db.json");

interface LocalDB {
  notes: any[];
}

const getLocalDB = (): LocalDB => {
  if (!fs.existsSync(LOCAL_DB_PATH)) {
    const initial = { notes: [] };
    fs.writeFileSync(LOCAL_DB_PATH, JSON.stringify(initial, null, 2));
    return initial;
  }
  try {
    return JSON.parse(fs.readFileSync(LOCAL_DB_PATH, "utf8"));
  } catch (e) {
    return { notes: [] };
  }
};

const saveLocalDB = (data: LocalDB) => {
  fs.writeFileSync(LOCAL_DB_PATH, JSON.stringify(data, null, 2));
};

// --- SUPABASE CONNECTION ---
let isUsingSupabase = false;
let supabase: any = null;

const isPlaceholder = (url?: string, key?: string) => {
  if (!url || !key) return true;
  if (url.includes("your-project") || key.includes("your-anon-key")) return true;
  return false;
};

if (SUPABASE_URL && SUPABASE_ANON_KEY && !isPlaceholder(SUPABASE_URL, SUPABASE_ANON_KEY)) {
  console.log("Configurando cliente de Supabase...");
  try {
    supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
    isUsingSupabase = true;
    console.log("¡Cliente de Supabase inicializado correctamente!");
  } catch (err: any) {
    console.error("Error al conectar a Supabase. Usando fallback local JSON:", err.message);
    isUsingSupabase = false;
  }
} else {
  console.log("No se proporcionó SUPABASE_URL o SUPABASE_ANON_KEY válidos. Usando base de datos local JSON...");
  isUsingSupabase = false;
}

// --- JOI VALIDATION SCHEMAS ---
const noteInputSchema = joi.object({
  text: joi.string().min(1).max(300).required().messages({
    "string.min": "El mensaje no puede estar vacío.",
    "string.max": "El mensaje no puede superar los 300 caracteres.",
    "any.required": "El mensaje es un campo requerido.",
  }),
  x: joi.number().required().messages({
    "any.required": "La coordenada X es requerida.",
  }),
  y: joi.number().required().messages({
    "any.required": "La coordenada Y es requerida.",
  }),
  color: joi.string().allow("").optional(),
  fontFamily: joi.string().allow("").optional(),
});

// --- API ROUTES ---

// GET /api/notes - Query notes inside a viewport bounding box or fallback to latest
app.get("/api/notes", async (req, res) => {
  const { minX, maxX, minY, maxY } = req.query;
  let useFallback = !isUsingSupabase;

  if (isUsingSupabase) {
    try {
      let query = supabase.from("notas").select("*");

      if (minX !== undefined && maxX !== undefined && minY !== undefined && maxY !== undefined) {
        const xMin = parseFloat(minX as string);
        const xMax = parseFloat(maxX as string);
        const yMin = parseFloat(minY as string);
        const yMax = parseFloat(maxY as string);

        query = query
          .gte("x", xMin)
          .lte("x", xMax)
          .gte("y", yMin)
          .lte("y", yMax);
      }

      const { data: notes, error } = await query.order("created_at", { ascending: false }).limit(500);

      if (error) {
        throw error;
      }

      // Map Supabase columns to frontend schema
      const mappedNotes = (notes || []).map((n: any) => ({
        _id: n.id,
        text: n.texto,
        x: n.x,
        y: n.y,
        color: n.color || "#ffffff",
        fontFamily: n.fuente || "Georgia",
        createdAt: n.created_at,
      }));

      return res.json(mappedNotes);
    } catch (err: any) {
      console.warn("Supabase query failed, falling back to local JSON database:", err.message || err);
      useFallback = true;
    }
  }

  if (useFallback) {
    try {
      // Fallback Local JSON DB
      const db = getLocalDB();
      let filteredNotes = [...db.notes];

      if (minX !== undefined && maxX !== undefined && minY !== undefined && maxY !== undefined) {
        const xMin = parseFloat(minX as string);
        const xMax = parseFloat(maxX as string);
        const yMin = parseFloat(minY as string);
        const yMax = parseFloat(maxY as string);

        filteredNotes = filteredNotes.filter(
          (n) => n.x >= xMin && n.x <= xMax && n.y >= yMin && n.y <= yMax
        );
      } else {
        // Sort by createdAt descending
        filteredNotes.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
      }

      return res.json(filteredNotes.slice(0, 500));
    } catch (err: any) {
      console.error("Error al recuperar notas del JSON local:", err);
      return res.status(500).json({ error: "Error interno al recuperar notas de La Pared." });
    }
  }
});

// POST /api/notes - Create a new anonymous note (Limit to 1 note per clientId)
app.post("/api/notes", async (req, res) => {
  const { error, value } = noteInputSchema.validate(req.body);
  if (error) {
    return res.status(400).json({ error: error.details[0].message });
  }

  const clientId = req.headers["x-client-id"] as string;
  if (!clientId || clientId.trim() === "") {
    return res.status(400).json({ error: "Identificador de cliente no válido o ausente." });
  }

  const { text, x, y, color, fontFamily } = value;
  const textTrimmed = text.trim();
  const isAdmin = textTrimmed.startsWith("admin123");
  let displayText = text;
  let finalClientId = clientId;

  if (isAdmin) {
    displayText = textTrimmed.slice(8).trim();
    if (displayText.length === 0) {
      return res.status(400).json({ error: "El mensaje del administrador no puede estar vacío." });
    }
    if (displayText.length > 50) {
      return res.status(400).json({ error: "El mensaje del administrador no puede superar los 50 caracteres." });
    }
    // Generate a unique client ID to bypass database and local unique checks
    finalClientId = `${clientId}-admin-${Math.random().toString(36).substr(2, 9)}`;
  } else {
    if (textTrimmed.length > 50) {
      return res.status(400).json({ error: "El mensaje no puede superar los 50 caracteres." });
    }
  }

  let useFallback = !isUsingSupabase;

  if (isUsingSupabase) {
    try {
      if (!isAdmin) {
        // Check if client has already posted a note
        const { data: existingNote, error: fetchError } = await supabase
          .from("notas")
          .select("*")
          .eq("clientId", finalClientId)
          .maybeSingle();

        if (fetchError) {
          throw fetchError;
        }

        if (existingNote) {
          return res.status(400).json({
            error: "Ya has dejado tu huella en La Pared. Solo se permite una inscripción por persona.",
          });
        }
      }

      // Insert new note
      const { data: insertedData, error: insertError } = await supabase
        .from("notas")
        .insert({
          texto: displayText,
          x,
          y,
          clientId: finalClientId,
          color: color || "#ffffff",
          fuente: fontFamily || "Georgia",
        })
        .select()
        .single();

      if (insertError) {
        // Check for unique constraint violation (code 23505)
        if (insertError.code === "23505") {
          return res.status(400).json({
            error: "Ya has dejado tu huella en La Pared. Solo se permite una inscripción por persona.",
          });
        }
        throw insertError;
      }

      const mappedNote = {
        _id: insertedData.id,
        text: insertedData.texto,
        x: insertedData.x,
        y: insertedData.y,
        color: insertedData.color || "#ffffff",
        fontFamily: insertedData.fuente || "Georgia",
        createdAt: insertedData.created_at,
      };

      return res.status(201).json(mappedNote);
    } catch (err: any) {
      console.warn("Supabase insertion failed, falling back to local JSON database:", err.message || err);
      useFallback = true;
    }
  }

  if (useFallback) {
    try {
      // Fallback Local JSON DB
      const db = getLocalDB();
      if (!isAdmin) {
        const existingNote = db.notes.find((n) => n.clientId === finalClientId);
        if (existingNote) {
          return res.status(400).json({
            error: "Ya has dejado tu huella en La Pared. Solo se permite una inscripción por persona.",
          });
        }
      }

      const newNote = {
        _id: Math.random().toString(36).substr(2, 9),
        text: displayText,
        x,
        y,
        clientId: finalClientId,
        color: color || "#ffffff",
        fontFamily: fontFamily || "Georgia",
        createdAt: new Date().toISOString(),
      };

      db.notes.push(newNote);
      saveLocalDB(db);
      return res.status(201).json(newNote);
    } catch (err: any) {
      console.error("Error al guardar nota en el JSON local:", err);
      return res.status(500).json({ error: "Error interno al grabar la inscripción." });
    }
  }
});

// POST /api/dev/limpiar - Delete all notes (Secret development reset endpoint)
app.post("/api/dev/limpiar", async (req, res) => {
  let useFallback = !isUsingSupabase;

  if (isUsingSupabase) {
    try {
      const { error } = await supabase.from("notas").delete().not("id", "is", "null");
      if (error) {
        throw error;
      }
      return res.json({ success: true, message: "La Pared ha sido limpia por completo de Supabase." });
    } catch (err: any) {
      console.warn("Supabase deletion failed, falling back to local JSON database:", err.message || err);
      useFallback = true;
    }
  }

  if (useFallback) {
    try {
      saveLocalDB({ notes: [] });
      return res.json({ success: true, message: "La Pared ha sido limpia por completo del JSON Local." });
    } catch (err: any) {
      console.error("Error al limpiar notas localmente:", err);
      return res.status(500).json({ error: "Error interno al limpiar La Pared." });
    }
  }
});

// GET /api/status - Status endpoint
app.get("/api/status", (req, res) => {
  res.json({
    status: "online",
    database: isUsingSupabase ? "Supabase" : "JSON Local Fallback",
    noteCount: isUsingSupabase ? "Dynamic" : getLocalDB().notes.length,
    timestamp: new Date().toISOString(),
  });
});

// --- VITE MIDDLEWARE SETUP ---
async function startServer() {
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`========================================`);
    console.log(` Servidor de "La Pared" iniciado`);
    console.log(` Puerto: ${PORT}`);
    console.log(` Modo: ${process.env.NODE_ENV || "development"}`);
    console.log(` Base de datos: ${isUsingSupabase ? "Supabase" : "Local JSON (Fallback)"}`);
    console.log(`========================================`);
  });
}

startServer();
