import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

serve(async (req) => {
  // Handle CORS preflight requests
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const { texto, x, y, color, fuente, client_id, action, password } = await req.json()

    // Retrieve secret administrative password
    const adminPassword = Deno.env.get("ADMIN_PASSWORD")

    if (!adminPassword) {
      return new Response(
        JSON.stringify({ error: "Configuración administrativa incompleta" }),
        {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" }
        }
      )
    }

    // 1. Action: Clear all notes (V+B+N shortcut trigger)
    if (action === "clear") {
      if (!password || password !== adminPassword) {
        return new Response(
          JSON.stringify({ error: "Credenciales incorrectas" }),
          { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        )
      }

      // Initialize secure Supabase client with service role key
      const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? ""
      const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""
      const supabase = createClient(supabaseUrl, supabaseServiceKey)

      const { error } = await supabase
        .from('notas')
        .delete()
        .neq('id', 0)

      if (error) {
        return new Response(
          JSON.stringify({ error: `Error al borrar notas: ${error.message}` }),
          { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        )
      }

      return new Response(
        JSON.stringify({ success: true, message: "La Pared ha sido reiniciada con éxito." }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      )
    }

    // 2. Action: Create Admin Note with Prefix
    const rawTexto = texto || ""
    const prefix = adminPassword + " "

    let finalTexto = rawTexto
    let isAdmin = false

    // Check if the input begins with the password followed by a space
    if (rawTexto.startsWith(prefix)) {
      isAdmin = true
      finalTexto = rawTexto.slice(prefix.length)
    }

    const textTrimmed = finalTexto.trim()

    // If it's a normal note, return isNormal: true so that frontend performs normal client insert
    if (!isAdmin) {
      return new Response(
        JSON.stringify({ isNormal: true }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      )
    }

    // Strict validation: Reject if the note contains exactly the admin password itself
    if (textTrimmed === adminPassword) {
      return new Response(
        JSON.stringify({ error: "Contenido no permitido" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      )
    }

    // Reject if message is empty after stripping the password prefix
    if (textTrimmed === "") {
      return new Response(
        JSON.stringify({ error: "La inscripción no puede estar vacía." }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      )
    }

    // Strict character limit check of 50 characters
    if (textTrimmed.length > 50) {
      return new Response(
        JSON.stringify({ error: "La inscripción no puede exceder los 50 caracteres." }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      )
    }

    // Initialize secure Supabase client with service role key
    const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? ""
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""
    const supabase = createClient(supabaseUrl, supabaseServiceKey)

    // Generate a unique client ID to bypass the RLS unique constraint on regular device postings
    const randomUuid = crypto.randomUUID()
    const uniqueClientId = `admin_${randomUuid}`

    // Securely insert the note on behalf of the admin
    const { data, error } = await supabase
      .from('notas')
      .insert([
        {
          texto: textTrimmed,
          x: Math.round(x),
          y: Math.round(y),
          client_id: uniqueClientId,
          color: color || '#ffffff',
          fuente: fuente || 'Georgia',
        }
      ])
      .select()

    if (error) {
      return new Response(
        JSON.stringify({ error: `Error de base de datos: ${error.message}` }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      )
    }

    if (!data || data.length === 0) {
      return new Response(
        JSON.stringify({ error: "No se pudo guardar la inscripción." }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      )
    }

    return new Response(
      JSON.stringify({ success: true, data: data[0], isAdmin: true }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    )

  } catch (err: any) {
    return new Response(
      JSON.stringify({ error: `Error interno de la Edge Function: ${err.message}` }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    )
  }
})
