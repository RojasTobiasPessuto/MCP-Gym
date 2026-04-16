#!/usr/bin/env node

const { Server } = require("@modelcontextprotocol/sdk/server/index.js");
const { StdioServerTransport } = require("@modelcontextprotocol/sdk/server/stdio.js");
const { CallToolRequestSchema, ListToolsRequestSchema } = require("@modelcontextprotocol/sdk/types.js");
const axios = require("axios");
const fs = require("fs");
const path = require("path");

// Cargar secrets desde archivo local (NO en .claude.json para evitar exposición)
const SECRETS_PATH = path.join(__dirname, "secrets.json");
let secrets = {};
try {
  secrets = JSON.parse(fs.readFileSync(SECRETS_PATH, "utf8"));
} catch (e) {
  console.error("ADVERTENCIA: No se pudo cargar secrets.json. Usando variables de entorno como fallback.");
}

const API_KEY = secrets.GHL_API_KEY || process.env.GHL_API_KEY;
const COMPANY_ID = secrets.GHL_COMPANY_ID || process.env.GHL_COMPANY_ID;
const DEFAULT_SNAPSHOT_ID = secrets.GHL_SNAPSHOT_ID || process.env.GHL_SNAPSHOT_ID;
const BASE_URL = "https://services.leadconnectorhq.com";

const api = axios.create({
  baseURL: BASE_URL,
  headers: {
    Authorization: `Bearer ${API_KEY}`,
    "Content-Type": "application/json",
    Version: "2021-07-28",
  },
});

const server = new Server(
  { name: "ghl-gym-mcp", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "create_subaccount",
      description: "Crea una sub-cuenta (location) en Go High Level con los datos del formulario de onboarding del gimnasio.",
      inputSchema: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description: "Nombre fiscal de la empresa (empresa_nombre_fiscal)",
          },
          email: {
            type: "string",
            description: "Email de la empresa (empresa_email)",
          },
          phone: {
            type: "string",
            description: "Teléfono de la empresa con código de país (empresa_telefono), ej: +34612345678",
          },
          address: {
            type: "string",
            description: "Dirección de la empresa (empresa_direccion)",
          },
          city: {
            type: "string",
            description: "Ciudad (empresa_ciudad)",
          },
          state: {
            type: "string",
            description: "Provincia o estado (opcional)",
          },
          postalCode: {
            type: "string",
            description: "Código postal (empresa_codigo_postal)",
          },
          country: {
            type: "string",
            description: "País (empresa_pais), ej: ES, MX, AR",
          },
          timezone: {
            type: "string",
            description: "Zona horaria IANA, ej: Europe/Madrid. Por defecto: Europe/Madrid",
          },
        },
        required: ["name", "email", "phone", "address", "city", "postalCode", "country"],
      },
    },
    {
      name: "apply_snapshot",
      description: "Aplica un snapshot (plantilla de agencia) a una sub-cuenta existente en Go High Level.",
      inputSchema: {
        type: "object",
        properties: {
          locationId: {
            type: "string",
            description: "ID de la sub-cuenta/location donde aplicar el snapshot",
          },
          snapshotId: {
            type: "string",
            description: "ID del snapshot a aplicar. Si no se proporciona, usa el snapshot por defecto configurado en GHL_SNAPSHOT_ID",
          },
        },
        required: ["locationId"],
      },
    },
    {
      name: "list_subaccounts",
      description: "Lista las sub-cuentas (locations) de la agencia en Go High Level. Soporta búsqueda y paginación.",
      inputSchema: {
        type: "object",
        properties: {
          limit: {
            type: "number",
            description: "Cantidad de resultados (máx 100, default 20)",
          },
          offset: {
            type: "number",
            description: "Offset para paginación (default 0)",
          },
          query: {
            type: "string",
            description: "Texto de búsqueda por nombre de location (opcional)",
          },
        },
      },
    },
    {
      name: "get_subaccount",
      description: "Obtiene los detalles completos de una sub-cuenta específica en Go High Level.",
      inputSchema: {
        type: "object",
        properties: {
          locationId: {
            type: "string",
            description: "ID de la sub-cuenta/location",
          },
        },
        required: ["locationId"],
      },
    },
    {
      name: "list_snapshots",
      description: "Lista los snapshots disponibles en la agencia de Go High Level.",
      inputSchema: {
        type: "object",
        properties: {
          limit: {
            type: "number",
            description: "Cantidad de resultados (default 50)",
          },
          offset: {
            type: "number",
            description: "Offset para paginación (default 0)",
          },
        },
      },
    },
    {
      name: "check_snapshot_status",
      description: "Verifica el estado de aplicacion de un snapshot en una sub-cuenta. Util para saber si termino de propagarse.",
      inputSchema: {
        type: "object",
        properties: {
          locationId: { type: "string", description: "ID de la sub-cuenta" },
          snapshotId: { type: "string", description: "ID del snapshot (opcional, usa GHL_SNAPSHOT_ID por defecto)" },
        },
        required: ["locationId"],
      },
    },
    {
      name: "update_location",
      description: "Actualiza la informacion de una sub-cuenta (location) existente: website, telefono, direccion, timezone, etc.",
      inputSchema: {
        type: "object",
        properties: {
          locationId: { type: "string", description: "ID de la sub-cuenta a actualizar" },
          name: { type: "string", description: "Nombre del negocio" },
          phone: { type: "string", description: "Telefono con codigo de pais" },
          email: { type: "string", description: "Email de la empresa" },
          address: { type: "string" },
          city: { type: "string" },
          state: { type: "string" },
          postalCode: { type: "string" },
          country: { type: "string", description: "Codigo ISO 2 letras" },
          timezone: { type: "string", description: "Zona horaria IANA" },
          website: { type: "string", description: "URL del sitio web" },
        },
        required: ["locationId"],
      },
    },
    {
      name: "create_custom_value",
      description: "Crea un custom value (variable) en una sub-cuenta. Util para guardar datos del formulario: CIF, sedes, servicios, URLs, procesos, tarifas.",
      inputSchema: {
        type: "object",
        properties: {
          locationId: { type: "string", description: "ID de la sub-cuenta" },
          name: { type: "string", description: "Nombre de la variable (ej: identificador_fiscal, sedes_info)" },
          value: { type: "string", description: "Valor de la variable" },
        },
        required: ["locationId", "name", "value"],
      },
    },
    {
      name: "create_user",
      description: "Crea un usuario (empleado) dentro de una sub-cuenta. El usuario se asocia al locationId especificado.",
      inputSchema: {
        type: "object",
        properties: {
          locationId: { type: "string", description: "ID de la sub-cuenta donde se asigna el usuario" },
          firstName: { type: "string", description: "Nombre del empleado" },
          lastName: { type: "string", description: "Apellido del empleado" },
          email: { type: "string", description: "Email del empleado (debe ser unico)" },
          phone: { type: "string", description: "Telefono con codigo de pais" },
          role: { type: "string", description: "Rol: admin o user. Default: user" },
          password: { type: "string", description: "Password temporal (opcional, se genera uno si no se da)" },
        },
        required: ["locationId", "firstName", "lastName", "email"],
      },
    },
    {
      name: "create_calendar",
      description: "Crea un calendario en una sub-cuenta con disponibilidad horaria. Puede ser personal, event, round_robin, etc.",
      inputSchema: {
        type: "object",
        properties: {
          locationId: { type: "string", description: "ID de la sub-cuenta" },
          name: { type: "string", description: "Nombre del calendario" },
          calendarType: { type: "string", description: "Tipo: personal, event, round_robin, collective, class_booking, service_booking" },
          teamMemberIds: { type: "array", items: { type: "string" }, description: "Array de userIds asignados al calendario" },
          slotDuration: { type: "number", description: "Duracion del slot en minutos (default 60)" },
          openHours: {
            type: "array",
            description: "Array de disponibilidad. Cada item: {daysOfTheWeek: ['mon','tue',...], hours: [{openHour, openMinute, closeHour, closeMinute}]}",
            items: { type: "object" },
          },
          autoConfirm: { type: "boolean", description: "Confirmar citas automaticamente (default true)" },
        },
        required: ["locationId", "name"],
      },
    },
    {
      name: "create_product",
      description: "Crea un producto en una sub-cuenta. Paso previo a crear un precio (tarifa).",
      inputSchema: {
        type: "object",
        properties: {
          locationId: { type: "string", description: "ID de la sub-cuenta" },
          name: { type: "string", description: "Nombre del producto" },
          productType: { type: "string", description: "Tipo: DIGITAL, PHYSICAL, SERVICE. Default: SERVICE" },
          description: { type: "string", description: "Descripcion del producto" },
        },
        required: ["locationId", "name"],
      },
    },
    {
      name: "create_price",
      description: "Crea un precio asociado a un producto. Soporta precios recurrentes (mensual/anual).",
      inputSchema: {
        type: "object",
        properties: {
          locationId: { type: "string", description: "ID de la sub-cuenta" },
          productId: { type: "string", description: "ID del producto al que asociar el precio" },
          name: { type: "string", description: "Nombre del precio" },
          amount: { type: "number", description: "Monto del precio (ej: 39.99)" },
          currency: { type: "string", description: "Codigo de moneda: USD, EUR, GBP, MXN, ARS, etc." },
          type: { type: "string", description: "Tipo: one_time o recurring. Default: recurring" },
          interval: { type: "string", description: "Intervalo recurrente: day, week, month, year. Default: month" },
          intervalCount: { type: "number", description: "Cantidad de intervalos (default 1)" },
        },
        required: ["locationId", "productId", "name", "amount", "currency"],
      },
    },
    {
      name: "list_custom_values",
      description: "Lista todos los custom values existentes en una sub-cuenta. Usar ANTES de crear para verificar si ya existen (el snapshot los puede haber creado).",
      inputSchema: {
        type: "object",
        properties: {
          locationId: { type: "string", description: "ID de la sub-cuenta" },
        },
        required: ["locationId"],
      },
    },
    {
      name: "update_custom_value",
      description: "Actualiza el valor de un custom value existente. Usar cuando el snapshot ya creo el campo y solo hay que ponerle el valor real del formulario.",
      inputSchema: {
        type: "object",
        properties: {
          locationId: { type: "string", description: "ID de la sub-cuenta" },
          customValueId: { type: "string", description: "ID del custom value a actualizar" },
          name: { type: "string", description: "Nombre (opcional, para cambiarlo)" },
          value: { type: "string", description: "Nuevo valor" },
        },
        required: ["locationId", "customValueId", "value"],
      },
    },
    {
      name: "list_calendars",
      description: "Lista los calendarios existentes en una sub-cuenta. Usar para encontrar calendarios creados por el snapshot y poder actualizarlos.",
      inputSchema: {
        type: "object",
        properties: {
          locationId: { type: "string", description: "ID de la sub-cuenta" },
          showDrafted: { type: "boolean", description: "Incluir calendarios en borrador (default false)" },
        },
        required: ["locationId"],
      },
    },
    {
      name: "update_calendar",
      description: "Actualiza un calendario existente: miembros del equipo, disponibilidad, duracion del slot, etc. Usar cuando el calendario ya existe por el snapshot.",
      inputSchema: {
        type: "object",
        properties: {
          calendarId: { type: "string", description: "ID del calendario" },
          name: { type: "string" },
          teamMemberIds: { type: "array", items: { type: "string" }, description: "Lista de userIds asignados" },
          openHours: { type: "array", items: { type: "object" }, description: "Disponibilidad horaria (mismo formato que create_calendar)" },
          slotDuration: { type: "number" },
          autoConfirm: { type: "boolean" },
          isActive: { type: "boolean" },
        },
        required: ["calendarId"],
      },
    },
    {
      name: "find_user_by_email",
      description: "Busca un usuario de la agencia por email. Retorna el usuario si existe, o vacio si no. CRITICO para no duplicar usuarios al cargar empleados.",
      inputSchema: {
        type: "object",
        properties: {
          email: { type: "string", description: "Email del empleado a buscar" },
        },
        required: ["email"],
      },
    },
    {
      name: "update_user",
      description: "Actualiza un usuario existente. Util para agregar una sub-cuenta (locationId) a un usuario que ya existe en la agencia.",
      inputSchema: {
        type: "object",
        properties: {
          userId: { type: "string", description: "ID del usuario existente" },
          locationIds: { type: "array", items: { type: "string" }, description: "Array completo de locations a las que pertenece (incluir las previas + la nueva)" },
          firstName: { type: "string" },
          lastName: { type: "string" },
          phone: { type: "string" },
          role: { type: "string" },
        },
        required: ["userId"],
      },
    },
    {
      name: "add_user_to_location",
      description: "Agrega un usuario existente a una sub-cuenta sin perder sus otras asignaciones. Primero obtiene el usuario, extrae sus locationIds actuales y agrega la nueva.",
      inputSchema: {
        type: "object",
        properties: {
          userId: { type: "string", description: "ID del usuario existente" },
          locationId: { type: "string", description: "ID de la sub-cuenta a agregar" },
        },
        required: ["userId", "locationId"],
      },
    },
    {
      name: "list_products",
      description: "Lista los productos existentes en una sub-cuenta. Usar antes de crear para verificar si el snapshot ya los cargo.",
      inputSchema: {
        type: "object",
        properties: {
          locationId: { type: "string", description: "ID de la sub-cuenta" },
          limit: { type: "number", description: "Cantidad (default 100)" },
          offset: { type: "number" },
        },
        required: ["locationId"],
      },
    },
    {
      name: "update_product",
      description: "Actualiza un producto existente (nombre, descripcion, tipo). Usar cuando el snapshot ya creo el producto.",
      inputSchema: {
        type: "object",
        properties: {
          productId: { type: "string", description: "ID del producto" },
          locationId: { type: "string", description: "ID de la sub-cuenta" },
          name: { type: "string" },
          description: { type: "string" },
          productType: { type: "string", description: "DIGITAL, PHYSICAL, SERVICE" },
        },
        required: ["productId", "locationId"],
      },
    },
    {
      name: "list_prices",
      description: "Lista los precios existentes de un producto. Usar para encontrar precios creados por el snapshot y actualizarlos.",
      inputSchema: {
        type: "object",
        properties: {
          productId: { type: "string", description: "ID del producto" },
          locationId: { type: "string", description: "ID de la sub-cuenta" },
        },
        required: ["productId", "locationId"],
      },
    },
    {
      name: "update_price",
      description: "Actualiza un precio existente (monto, periodicidad, moneda). Usar cuando el snapshot ya creo el precio y hay que ajustarlo con los datos del form.",
      inputSchema: {
        type: "object",
        properties: {
          productId: { type: "string", description: "ID del producto" },
          priceId: { type: "string", description: "ID del precio" },
          locationId: { type: "string", description: "ID de la sub-cuenta" },
          name: { type: "string" },
          amount: { type: "number" },
          currency: { type: "string" },
          interval: { type: "string", description: "month, year, etc" },
          intervalCount: { type: "number" },
        },
        required: ["productId", "priceId", "locationId"],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    let response;

    if (name === "create_subaccount") {
      response = await api.post("/locations", {
        companyId: COMPANY_ID,
        name: args.name,
        email: args.email,
        phone: args.phone,
        address: args.address,
        city: args.city,
        state: args.state || "",
        postalCode: args.postalCode,
        country: args.country,
        timezone: args.timezone || "Europe/Madrid",
      });
    } else if (name === "apply_snapshot") {
      const snapshotId = args.snapshotId || DEFAULT_SNAPSHOT_ID;
      if (!snapshotId) {
        throw new Error("No se proporcionó snapshotId y no hay GHL_SNAPSHOT_ID configurado");
      }
      response = await api.post(`/snapshots/snapshot-status/${snapshotId}/location/${args.locationId}`);
    } else if (name === "list_subaccounts") {
      response = await api.get("/locations/search", {
        params: {
          companyId: COMPANY_ID,
          limit: Math.min(args.limit || 20, 100),
          offset: args.offset || 0,
          ...(args.query && { query: args.query }),
        },
      });
    } else if (name === "get_subaccount") {
      response = await api.get(`/locations/${args.locationId}`);
    } else if (name === "list_snapshots") {
      response = await api.get("/snapshots", {
        params: {
          companyId: COMPANY_ID,
          limit: args.limit || 50,
          offset: args.offset || 0,
        },
      });
    } else if (name === "check_snapshot_status") {
      const snapId = args.snapshotId || DEFAULT_SNAPSHOT_ID;
      if (!snapId) throw new Error("No se proporciono snapshotId y no hay GHL_SNAPSHOT_ID configurado");
      response = await api.get(`/snapshots/snapshot-status/${snapId}/location/${args.locationId}`);
    } else if (name === "update_location") {
      const body = { companyId: COMPANY_ID };
      ["name", "phone", "email", "address", "city", "state", "postalCode", "country", "timezone", "website"].forEach((k) => {
        if (args[k] !== undefined) body[k] = args[k];
      });
      response = await api.put(`/locations/${args.locationId}`, body);
    } else if (name === "create_custom_value") {
      response = await api.post(`/locations/${args.locationId}/customValues`, {
        name: args.name,
        value: args.value,
      });
    } else if (name === "create_user") {
      response = await api.post("/users/", {
        companyId: COMPANY_ID,
        firstName: args.firstName,
        lastName: args.lastName,
        email: args.email,
        phone: args.phone || "",
        type: "account",
        role: args.role || "user",
        locationIds: [args.locationId],
        password: args.password || `Temp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      });
    } else if (name === "create_calendar") {
      const calPayload = {
        locationId: args.locationId,
        name: args.name,
        calendarType: args.calendarType || "event",
        slotDuration: args.slotDuration || 60,
        slotDurationUnit: "mins",
        slotInterval: 30,
        slotIntervalUnit: "mins",
        autoConfirm: args.autoConfirm !== false,
        isActive: true,
      };
      if (args.teamMemberIds && args.teamMemberIds.length > 0) {
        calPayload.teamMembers = args.teamMemberIds.map((userId) => ({
          userId,
          priority: 0.5,
          meetingLocationType: "default",
        }));
        if (args.teamMemberIds.length > 1 && calPayload.calendarType === "round_robin") {
          calPayload.eventType = "RoundRobin_OptimizeForAvailability";
        }
      }
      if (args.openHours && args.openHours.length > 0) {
        calPayload.openHours = args.openHours;
        calPayload.availabilityType = 0;
      }
      response = await api.post("/calendars/", calPayload);
    } else if (name === "create_product") {
      response = await api.post("/products/", {
        locationId: args.locationId,
        name: args.name,
        productType: args.productType || "SERVICE",
        description: args.description || "",
      });
    } else if (name === "create_price") {
      const pricePayload = {
        locationId: args.locationId,
        name: args.name,
        type: args.type || "recurring",
        currency: (args.currency || "EUR").toLowerCase(),
        amount: Math.round((args.amount || 0) * 100) / 100,
      };
      if (pricePayload.type === "recurring") {
        pricePayload.recurring = {
          interval: args.interval || "month",
          intervalCount: args.intervalCount || 1,
        };
      }
      response = await api.post(`/products/${args.productId}/price`, pricePayload);
    } else if (name === "list_custom_values") {
      response = await api.get(`/locations/${args.locationId}/customValues`);
    } else if (name === "update_custom_value") {
      const body = { value: args.value };
      if (args.name) body.name = args.name;
      response = await api.put(`/locations/${args.locationId}/customValues/${args.customValueId}`, body);
    } else if (name === "list_calendars") {
      response = await api.get("/calendars/", {
        params: {
          locationId: args.locationId,
          showDrafted: args.showDrafted || false,
        },
      });
    } else if (name === "update_calendar") {
      const body = {};
      if (args.name !== undefined) body.name = args.name;
      if (args.slotDuration !== undefined) { body.slotDuration = args.slotDuration; body.slotDurationUnit = "mins"; }
      if (args.autoConfirm !== undefined) body.autoConfirm = args.autoConfirm;
      if (args.isActive !== undefined) body.isActive = args.isActive;
      if (args.teamMemberIds && args.teamMemberIds.length > 0) {
        body.teamMembers = args.teamMemberIds.map((userId) => ({
          userId,
          priority: 0.5,
          meetingLocationType: "default",
        }));
      }
      if (args.openHours && args.openHours.length > 0) {
        body.openHours = args.openHours;
        body.availabilityType = 0;
      }
      response = await api.put(`/calendars/${args.calendarId}`, body);
    } else if (name === "find_user_by_email") {
      // Usa el endpoint de agencia
      try {
        response = await api.get("/users/search/filter-by-email", {
          params: {
            companyId: COMPANY_ID,
            email: args.email,
          },
        });
      } catch (e) {
        // Fallback: buscar con /users/search
        response = await api.get("/users/search", {
          params: {
            companyId: COMPANY_ID,
            query: args.email,
          },
        });
      }
    } else if (name === "update_user") {
      const body = {};
      ["firstName", "lastName", "phone", "role", "locationIds"].forEach((k) => {
        if (args[k] !== undefined) body[k] = args[k];
      });
      response = await api.put(`/users/${args.userId}`, body);
    } else if (name === "add_user_to_location") {
      // 1. Obtener el usuario actual
      const userRes = await api.get(`/users/${args.userId}`);
      const userData = userRes.data.user || userRes.data;
      const currentLocationIds = userData.roles && userData.roles.locationIds
        ? userData.roles.locationIds
        : (userData.locationIds || []);

      // 2. Agregar la nueva location si no esta
      const newLocationIds = currentLocationIds.includes(args.locationId)
        ? currentLocationIds
        : [...currentLocationIds, args.locationId];

      // 3. Actualizar
      response = await api.put(`/users/${args.userId}`, {
        locationIds: newLocationIds,
      });
    } else if (name === "list_products") {
      response = await api.get("/products/", {
        params: {
          locationId: args.locationId,
          limit: args.limit || 100,
          offset: args.offset || 0,
        },
      });
    } else if (name === "update_product") {
      const body = { locationId: args.locationId };
      ["name", "description", "productType"].forEach((k) => {
        if (args[k] !== undefined) body[k] = args[k];
      });
      response = await api.put(`/products/${args.productId}`, body);
    } else if (name === "list_prices") {
      response = await api.get(`/products/${args.productId}/price`, {
        params: { locationId: args.locationId },
      });
    } else if (name === "update_price") {
      const body = { locationId: args.locationId };
      if (args.name !== undefined) body.name = args.name;
      if (args.amount !== undefined) body.amount = Math.round(args.amount * 100) / 100;
      if (args.currency !== undefined) body.currency = args.currency.toLowerCase();
      if (args.interval !== undefined || args.intervalCount !== undefined) {
        body.recurring = {
          interval: args.interval || "month",
          intervalCount: args.intervalCount || 1,
        };
      }
      response = await api.put(`/products/${args.productId}/price/${args.priceId}`, body);
    } else {
      throw new Error(`Herramienta desconocida: ${name}`);
    }

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(response.data, null, 2),
        },
      ],
    };
  } catch (error) {
    const msg = error.response
      ? `Error ${error.response.status}: ${JSON.stringify(error.response.data)}`
      : error.message;

    return {
      content: [{ type: "text", text: `Error al llamar a GHL: ${msg}` }],
      isError: true,
    };
  }
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("GHL Gym MCP server corriendo...");
}

main().catch(console.error);
