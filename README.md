# GHL Gym Onboarding

Server que recibe datos de un form de onboarding y crea sub-cuentas automaticas en Go High Level con snapshot, empleados, calendarios y bot de conversacion AI.

## Stack

- Node.js + Express
- Axios para GHL API (OAuth 2.0)
- Cola de procesamiento max 3 concurrentes

## Desarrollo local

```bash
npm install
cp .env.example .env   # editar con tus valores
# O editar secrets.json y dejar USE_ENV_SECRETS=false
node server.js
```

Abrir: `http://localhost:3500/form.html`

## Deploy en Render

1. Subir este repo a GitHub
2. En Render: New > Web Service > Conectar repo
3. Configurar variables de entorno (ver `.env.example`)
4. Deploy

URL productiva: `https://tu-servicio.onrender.com`

## Webhook GHL

Despues de deploy, registrar este webhook en GHL App Marketplace > App 2 > Settings > Webhooks:

```
URL: https://tu-servicio.onrender.com/webhooks/ghl/install
Event: INSTALL
```

## Flujo

1. Usuario llena form `/form.html`
2. POST a `/api/onboarding` → encola + responde OK
3. Server procesa en cola (max 3 simultaneos):
   - Crea sub-cuenta + snapshot
   - Obtiene location token (webhook INSTALL o fallback bridge 2 min)
   - Genera CSV base de conocimiento
   - Crea empleados
   - Actualiza custom fields
   - Configura calendarios (con placeholder si no hay empleados)
   - Crea bot ClaudIA personalizado con datos del form
   - Conecta action appointmentBooking

## Estructura

- `server.js` - Server HTTP principal
- `form.html` - Formulario de 9 pasos
- `index.js` - MCP server (uso desde Claude Code)
- `secrets.json` - Secretos locales (gitignored)
- `Base de Conocimiento/` - CSVs generados automaticamente

## Limitaciones conocidas

- Agency Unlimited $297 no permite modificar usuarios existentes (solo crear)
- Un solo appointmentBooking action por bot (se conecta a la 1° sede)
- Los CSV generados no persisten entre reinicios del container en Render free tier
