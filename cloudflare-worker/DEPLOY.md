# Guía de Despliegue en Cloudflare Workers (La Sala)

Esta implementación traslada la lógica de servidor de **La Sala** (`server.ts`) a un entorno de borde (*edge*) con **Cloudflare Workers** y **Durable Objects**.

---

## 1. Archivos en este directorio

- `wrangler.toml`: Configuración de Wrangler para el Worker `la-sala`, con el binding de Durable Object `SALA_ROOM` y la migración `v1`.
- `sala-worker.ts`: Código fuente del Worker y la clase Durable Object `SalaRoom`.

---

## 2. Requisitos Previos

1. Tener instalado [Node.js](https://nodejs.org/).
2. Iniciar sesión en Cloudflare desde la terminal:
   ```bash
   npx wrangler login
   ```
3. Tu cuenta de Cloudflare (admite Durable Objects con SQLite tanto en el **plan gratuito** como en el plan de pago gracias a `new_sqlite_classes`).

---

## 3. Configurar el Secret de Gemini (si no lo hiciste aún)

Desde el directorio `cloudflare-worker` (o pasando `-c wrangler.toml`):

```bash
cd cloudflare-worker
npx wrangler secret put GEMINI_API_KEY
```
*Pega tu clave de API de Google Gemini cuando la terminal te lo solicite.*

---

## 4. Desplegar el Worker

Para compilar y publicar el Worker con su Durable Object y migración:

```bash
cd cloudflare-worker
npx wrangler deploy
```

Al finalizar el despliegue, Wrangler te proporcionará una URL pública similar a:
`https://la-sala.<tu-subdominio>.workers.dev`

---

## 5. Pruebas Locales con Wrangler (Opcional)

Puedes simular el Worker y el Durable Object localmente antes de pasarlo a producción:

```bash
cd cloudflare-worker
npx wrangler dev
```

---

## 6. Conectar el Frontend a Cloudflare Workers

En tu cliente web (por ejemplo, en `src/components/LaSalaModal.tsx` o mediante variables de entorno):

1. **Rutas HTTP utilizadas:**
   - `GET /api/sala/status?clientId=<id>`
   - `POST /api/sala/leave` (con `clientId`)
2. **Ruta WebSocket utilizada:**
   - `wss://la-sala.<tu-subdominio>.workers.dev/api/sala/ws?clientId=<id>`

Si el frontend se aloja en el mismo dominio o a través de Cloudflare Routes, las rutas `/api/sala/*` se enrutan automáticamente al Worker `la-sala`. Si se consume de forma cruzada, el Worker ya incluye cabeceras CORS (`Access-Control-Allow-Origin: *`).
