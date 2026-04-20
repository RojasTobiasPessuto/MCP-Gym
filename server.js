#!/usr/bin/env node

// ============================================================
// GHL Gym Onboarding Server (OAuth version)
//
// Flujo:
//   1. Cliente llena form → POST /api/onboarding con JSON
//   2. Server crea sub-cuenta con App 1 (agency token) + snapshot
//   3. Marca la sub-cuenta como "pendiente de configuración"
//   4. GHL auto-instala App 2 en la sub-cuenta (installToFutureLocations=true)
//   5. GHL dispara webhook INSTALL → server recibe en /webhooks/ghl/install
//   6. Si la sub-cuenta está en "pendientes", server configura todo
//      (empleados, calendars, custom fields). Si NO, solo guarda el token.
//   7. Sub-cuenta lista
//
// Configuración:
//   node server.js
//   Abrir http://localhost:3500/form.html
//   Para webhook desde GHL: exponer con ngrok http 3500
// ============================================================

const express = require("express");
const path = require("path");
const axios = require("axios");
const fs = require("fs");
const crypto = require("crypto");

// ============================================================
// CONFIG
// ============================================================

const PORT = process.env.PORT || 3500;
const BASE_URL = "https://services.leadconnectorhq.com";
const SECRETS_PATH = path.join(__dirname, "secrets.json");
const USE_ENV_SECRETS = process.env.USE_ENV_SECRETS === "true";

// In-memory cache para secrets cuando estamos en producción con env vars
let secretsCache = null;

function loadSecrets() {
  // Produccion: cargar de env vars (primera vez) y mantener en memoria
  if (USE_ENV_SECRETS) {
    if (!secretsCache) {
      secretsCache = {
        GHL_API_KEY: process.env.GHL_API_KEY || "",
        GHL_COMPANY_ID: process.env.GHL_COMPANY_ID || "",
        GHL_SNAPSHOT_ID: process.env.GHL_SNAPSHOT_ID || "",
        GHL_OAUTH_CLIENT_ID: process.env.GHL_OAUTH_CLIENT_ID || "",
        GHL_OAUTH_CLIENT_SECRET: process.env.GHL_OAUTH_CLIENT_SECRET || "",
        GHL_OAUTH_REDIRECT_URI: process.env.GHL_OAUTH_REDIRECT_URI || "",
        GHL_OAUTH_ACCESS_TOKEN: process.env.GHL_OAUTH_ACCESS_TOKEN || "",
        GHL_OAUTH_REFRESH_TOKEN: process.env.GHL_OAUTH_REFRESH_TOKEN || "",
        GHL_OAUTH_TOKEN_EXPIRES_AT: parseInt(process.env.GHL_OAUTH_TOKEN_EXPIRES_AT || "0", 10),
        GHL_OAUTH_SUBACCOUNT_CLIENT_ID: process.env.GHL_OAUTH_SUBACCOUNT_CLIENT_ID || "",
        GHL_OAUTH_SUBACCOUNT_CLIENT_SECRET: process.env.GHL_OAUTH_SUBACCOUNT_CLIENT_SECRET || "",
        GHL_OAUTH_SUBACCOUNT_APP_ID: process.env.GHL_OAUTH_SUBACCOUNT_APP_ID || "",
        GHL_OAUTH_SUBACCOUNT_BRIDGE_ACCESS_TOKEN: process.env.GHL_OAUTH_SUBACCOUNT_BRIDGE_ACCESS_TOKEN || "",
        GHL_OAUTH_SUBACCOUNT_BRIDGE_REFRESH_TOKEN: process.env.GHL_OAUTH_SUBACCOUNT_BRIDGE_REFRESH_TOKEN || "",
        GHL_LOCATION_TOKENS: {},
      };
    }
    return secretsCache;
  }
  // Desarrollo local: leer de secrets.json
  return JSON.parse(fs.readFileSync(SECRETS_PATH, "utf8"));
}

function saveSecrets(s) {
  if (USE_ENV_SECRETS) {
    secretsCache = s;
    return;
  }
  fs.writeFileSync(SECRETS_PATH, JSON.stringify(s, null, 2));
}

// Estado en memoria de sub-cuentas pendientes de configurar
// key = locationId, value = { formData, createdAt, status }
const pendingOnboardings = new Map();

// ============================================================
// HELPERS
// ============================================================

function wait(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Convertir nombre de pais a codigo ISO 3166-1 alpha-2
function normalizeCountry(input) {
  if (!input) return "ES";
  const s = String(input).trim();
  // Ya es codigo de 2 letras
  if (/^[A-Za-z]{2}$/.test(s)) return s.toUpperCase();
  const key = s.toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "") // quitar tildes
    .replace(/[^a-z ]/g, "").trim();
  const map = {
    "espana": "ES", "spain": "ES", "espania": "ES",
    "mexico": "MX",
    "argentina": "AR",
    "colombia": "CO",
    "chile": "CL",
    "peru": "PE",
    "venezuela": "VE",
    "ecuador": "EC",
    "uruguay": "UY",
    "paraguay": "PY",
    "bolivia": "BO",
    "costa rica": "CR",
    "panama": "PA",
    "guatemala": "GT",
    "honduras": "HN",
    "el salvador": "SV",
    "nicaragua": "NI",
    "cuba": "CU",
    "republica dominicana": "DO", "dominicana": "DO",
    "puerto rico": "PR",
    "estados unidos": "US", "united states": "US", "usa": "US", "eeuu": "US", "ee uu": "US",
    "canada": "CA",
    "brasil": "BR", "brazil": "BR",
    "francia": "FR", "france": "FR",
    "italia": "IT", "italy": "IT",
    "alemania": "DE", "germany": "DE",
    "reino unido": "GB", "united kingdom": "GB", "uk": "GB", "inglaterra": "GB",
    "portugal": "PT",
  };
  return map[key] || "ES"; // fallback a ES si no se reconoce
}

function ghlError(err) {
  if (err.response) return `Error ${err.response.status}: ${JSON.stringify(err.response.data)}`;
  return err.message;
}

// Axios con PIT (Private Integration Token) - NO expira
// Se usa para crear sub-cuentas y aplicar snapshots
async function getAgencyClient() {
  const s = loadSecrets();

  if (!s.GHL_API_KEY) {
    throw new Error("GHL_API_KEY (PIT) no configurado en env vars");
  }

  return axios.create({
    baseURL: BASE_URL,
    headers: {
      Authorization: `Bearer ${s.GHL_API_KEY}`,
      "Content-Type": "application/json",
      Version: "2021-07-28",
    },
  });
}

// Axios con location token específico (refresca si expiró)
async function getLocationClient(locationId) {
  const s = loadSecrets();
  const tokens = s.GHL_LOCATION_TOKENS && s.GHL_LOCATION_TOKENS[locationId];

  if (!tokens || !tokens.access_token) {
    throw new Error(`No hay location token para ${locationId}. Esperar webhook INSTALL.`);
  }

  const now = Date.now();
  if ((tokens.expires_at - now) < 5 * 60 * 1000) {
    console.log(`[location-token] Refreshing ${locationId}...`);
    const res = await axios.post(
      `${BASE_URL}/oauth/token`,
      new URLSearchParams({
        client_id: s.GHL_OAUTH_SUBACCOUNT_CLIENT_ID,
        client_secret: s.GHL_OAUTH_SUBACCOUNT_CLIENT_SECRET,
        grant_type: "refresh_token",
        refresh_token: tokens.refresh_token,
        user_type: "Location",
      }).toString(),
      { headers: { "Content-Type": "application/x-www-form-urlencoded" } }
    );
    s.GHL_LOCATION_TOKENS[locationId].access_token = res.data.access_token;
    s.GHL_LOCATION_TOKENS[locationId].refresh_token = res.data.refresh_token;
    s.GHL_LOCATION_TOKENS[locationId].expires_at = Date.now() + res.data.expires_in * 1000;
    saveSecrets(s);
  }

  const updated = loadSecrets();
  return axios.create({
    baseURL: BASE_URL,
    headers: {
      Authorization: `Bearer ${updated.GHL_LOCATION_TOKENS[locationId].access_token}`,
      "Content-Type": "application/json",
      Version: "2021-07-28",
    },
  });
}

// Obtener location token via bridge token (cuando no hay webhook)
async function getLocationTokenViaBridge(locationId) {
  const s = loadSecrets();
  const res = await axios.post(
    `${BASE_URL}/oauth/locationToken`,
    new URLSearchParams({
      companyId: s.GHL_COMPANY_ID,
      locationId: locationId,
    }).toString(),
    {
      headers: {
        Authorization: `Bearer ${s.GHL_OAUTH_SUBACCOUNT_BRIDGE_ACCESS_TOKEN}`,
        "Content-Type": "application/x-www-form-urlencoded",
        Version: "2021-07-28",
      },
    }
  );

  if (!s.GHL_LOCATION_TOKENS) s.GHL_LOCATION_TOKENS = {};
  s.GHL_LOCATION_TOKENS[locationId] = {
    access_token: res.data.access_token,
    refresh_token: res.data.refresh_token,
    expires_at: Date.now() + res.data.expires_in * 1000,
    obtained_via: "bridge",
    obtained_at: new Date().toISOString(),
  };
  saveSecrets(s);
  return res.data.access_token;
}

// ============================================================
// EXPRESS APP
// ============================================================

const app = express();
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));
app.use(express.static(path.join(__dirname)));

// Redirect raiz al form
app.get("/", (req, res) => res.redirect("/form.html"));

// ============================================================
// COLA DE PROCESAMIENTO (max 3 concurrentes)
// ============================================================

const MAX_CONCURRENT = 3;
const jobQueue = [];
let activeCount = 0;
const jobHistory = new Map(); // En memoria + persistencia

const JOBS_PATH = path.join(__dirname, "jobs.json");
const MAX_JOBS_HISTORY = 500; // Limitar historial persistido

function loadJobsFromDisk() {
  try {
    if (!fs.existsSync(JOBS_PATH)) return;
    const arr = JSON.parse(fs.readFileSync(JOBS_PATH, "utf8"));
    arr.forEach((j) => {
      // Jobs cargados de disco no deben estar "queued" ni "running" post-reinicio
      if (j.status !== "done") j.status = "interrupted";
      jobHistory.set(j.jobId, j);
    });
    console.log(`[jobs] Cargados ${jobHistory.size} jobs del historial`);
  } catch (err) {
    console.error("[jobs] Error cargando historial:", err.message);
  }
}

function saveJobsToDisk() {
  try {
    const arr = Array.from(jobHistory.values())
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, MAX_JOBS_HISTORY)
      .map(serializeJobForStorage);
    fs.writeFileSync(JOBS_PATH, JSON.stringify(arr, null, 2));
  } catch (err) {
    console.error("[jobs] Error guardando:", err.message);
  }
}

function serializeJobForStorage(job) {
  // Versión limpia sin referencias circulares ni base64 pesados
  const cleanData = job.data ? JSON.parse(JSON.stringify(job.data)) : null;
  if (cleanData && cleanData.kpis && Array.isArray(cleanData.kpis)) {
    cleanData.kpis.forEach((k) => { if (k.base64) delete k.base64; });
  }
  return {
    jobId: job.jobId,
    status: job.status,
    createdAt: job.createdAt,
    finishedAt: job.finishedAt || null,
    locationId: job.locationId || null,
    empresa: (cleanData && cleanData.empresa && cleanData.empresa.nombre_fiscal) || "Desconocida",
    email: (cleanData && cleanData.empresa && cleanData.empresa.email) || "",
    sedes: (cleanData && cleanData.sedes || []).length,
    empleados: (cleanData && cleanData.empleados || []).length,
    tarifas: (cleanData && cleanData.tarifas || []).length,
    log: job.log || [],
    result: job.result || null,
    data: cleanData,
  };
}

// Debounced save (evita escribir al disco en cada log line)
let saveTimer = null;
function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    saveJobsToDisk();
  }, 5000);
}

function enqueueJob(data, jobId) {
  const job = { jobId, data, log: [], status: "queued", result: null, createdAt: Date.now() };
  jobHistory.set(jobId, job);
  jobQueue.push(job);
  console.log(`[queue] Job ${jobId} encolado. Cola: ${jobQueue.length}, Activos: ${activeCount}`);
  scheduleSave();
  processQueue();
}

function processQueue() {
  while (activeCount < MAX_CONCURRENT && jobQueue.length > 0) {
    const job = jobQueue.shift();
    activeCount++;
    job.status = "running";
    console.log(`[queue] Procesando ${job.jobId}. Cola restante: ${jobQueue.length}, Activos: ${activeCount}`);

    runJob(job).finally(() => {
      activeCount--;
      console.log(`[queue] Job ${job.jobId} completado. Activos: ${activeCount}`);
      processQueue();
    });
  }
}

async function runJob(job) {
  function addLog(msg) {
    console.log(`[job ${job.jobId}] ${msg}`);
    job.log.push(msg);
    scheduleSave();
  }

  const { data } = job;
  const empresa = data.empresa;

  try {
    addLog("[1/2] Creando sub-cuenta con snapshot...");
    const s = loadSecrets();
    const agency = await getAgencyClient();

    const locationRes = await agency.post("/locations/", {
      companyId: s.GHL_COMPANY_ID,
      name: empresa.nombre_fiscal,
      email: empresa.email,
      phone: empresa.telefono || "",
      address: empresa.direccion || "",
      city: empresa.ciudad || "",
      postalCode: empresa.codigo_postal || "",
      country: normalizeCountry(empresa.pais),
      timezone: data.timezone || "Europe/Madrid",
      snapshotId: s.GHL_SNAPSHOT_ID,
    });

    const locationId = locationRes.data.id;
    if (!locationId) throw new Error("No se pudo obtener locationId");
    addLog(`[1/2] Sub-cuenta creada: ${locationId}`);
    job.locationId = locationId;

    // Marcar como pendiente (webhook o fallback)
    pendingOnboardings.set(locationId, { formData: data, job, createdAt: Date.now() });
    addLog(`[2/2] Esperando webhook INSTALL o fallback bridge...`);

    // Esperar max 2 min
    await new Promise((resolve) => {
      setTimeout(async () => {
        if (pendingOnboardings.has(locationId)) {
          addLog(`[2/2] Webhook no llegó. Intentando via bridge...`);
          try {
            await getLocationTokenViaBridge(locationId);
            addLog(`[2/2] Token obtenido via bridge. Configurando...`);
            await configureSubaccount(locationId, data, job);
            pendingOnboardings.delete(locationId);
          } catch (err) {
            addLog(`ERROR bridge: ${ghlError(err)}`);
            job.result = {
              success: false,
              location_id: locationId,
              message: "Sub-cuenta creada pero no se pudo configurar: " + ghlError(err),
            };
            job.status = "done"; job.finishedAt = Date.now(); scheduleSave();
          }
        }
        resolve();
      }, 120 * 1000);
    });

    // Si terminó via webhook antes del timeout, status ya es "done"
    if (job.status !== "done") {
      // No ocurrió el done aún (esperó los 2 min sin respuesta)
      job.status = "done"; job.finishedAt = Date.now(); scheduleSave();
    }
  } catch (err) {
    addLog(`ERROR FATAL: ${ghlError(err)}`);
    job.result = { success: false, message: ghlError(err) };
    job.status = "done"; job.finishedAt = Date.now(); scheduleSave();
  }
}

app.get("/api/onboarding/status/:jobId", (req, res) => {
  const job = jobHistory.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: "Job no encontrado" });
  res.json({
    jobId: job.jobId,
    status: job.status,
    result: job.result,
    empresa: job.data.empresa && job.data.empresa.nombre_fiscal,
  });
});

// ============================================================
// WEBHOOK RECEIVER - GHL Install events
// ============================================================

app.post("/webhooks/ghl/install", async (req, res) => {
  console.log("\n========== WEBHOOK INSTALL ==========");
  console.log(JSON.stringify(req.body, null, 2));
  console.log("=====================================\n");

  const { locationId, companyId, type, appId } = req.body;

  // Respondemos 200 inmediatamente (GHL reintenta si falla)
  res.status(200).json({ received: true });

  if (type !== "INSTALL" || !locationId) {
    console.log("[webhook] Ignorado (no es INSTALL o sin locationId)");
    return;
  }

  try {
    // Obtener el location token para esta sub-cuenta
    console.log(`[webhook] Obteniendo location token para ${locationId}...`);
    await getLocationTokenViaBridge(locationId);
    console.log(`[webhook] Token guardado para ${locationId}`);

    // Chequear si está pendiente de config
    const pending = pendingOnboardings.get(locationId);
    if (pending) {
      console.log(`[webhook] ${locationId} está pendiente. Configurando...`);
      await configureSubaccount(locationId, pending.formData, pending.job);
      pendingOnboardings.delete(locationId);
    } else {
      console.log(`[webhook] ${locationId} NO estaba pendiente. Solo se guardó el token.`);
    }
  } catch (err) {
    console.error(`[webhook] Error:`, ghlError(err));
  }
});

// ============================================================
// ONBOARDING ENDPOINT
// ============================================================

app.post("/api/onboarding", async (req, res) => {
  const data = req.body;
  const empresa = data.empresa;

  if (!empresa || !empresa.nombre_fiscal || !empresa.email) {
    return res.status(400).json({
      success: false,
      message: "Faltan datos obligatorios de la empresa.",
    });
  }

  const jobId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  enqueueJob(data, jobId);

  // Respondemos inmediatamente al form con mensaje de exito
  const posicion = activeCount + jobQueue.length;
  res.json({
    success: true,
    jobId: jobId,
    message: "Sub-cuenta en proceso de creacion. Te estaremos enviando las credenciales por email.",
    queuePosition: posicion,
    estimatedMinutes: Math.ceil(posicion / MAX_CONCURRENT) * 3,
  });
});

// ============================================================
// CONFIGURACIÓN COMPLETA DE LA SUB-CUENTA
// ============================================================

// ============================================================
// GENERAR CSV con datos del form y guardarlo en Base de Conocimiento/
// ============================================================

function generarCsvBaseConocimiento(data, addLog) {
  try {
    const empresa = data.empresa || {};
    const sedes = data.sedes || [];
    const tarifas = data.tarifas || [];
    const nombreEmpresa = empresa.nombre_fiscal || "Sin nombre";
    const moneda = (tarifas[0] && tarifas[0].moneda) || "EUR";

    // Construir strings de precios
    const preciosStr = tarifas.length > 0
      ? tarifas.map(t => `${t.nombre}: ${t.precio} ${t.moneda}/${t.periodicidad === "anual" ? "ano" : "mes"}`).join(" | ")
      : "";

    const tipoMembresia = tarifas.map(t => t.nombre).filter(Boolean).join(" | ") || "Consultar";

    const DIAS_LABEL = { lunes: "Lun", martes: "Mar", miercoles: "Mie", jueves: "Jue", viernes: "Vie", sabado: "Sab", domingo: "Dom" };

    const headers = ["nombre_sede","alias_sede","Estado","ciudad","distrito","pais","direccion","horarios","moneda","tipo_membresia_disponible","precios_all_access","precios_exclusiva","precios_uni_exclusiva","descuentos_disponibles","observacion_inscripcion","beneficios_incluidos","servicios_adicionales","free_pass_url","sitio_web"];

    function csvEscape(val) {
      const s = String(val == null ? "" : val).replace(/"/g, '""');
      return `"${s}"`;
    }

    const lines = [headers.map(csvEscape).join(",")];

    sedes.forEach((sede) => {
      // Construir string de horario
      const horarioStr = sede.horario
        ? Object.keys(sede.horario)
            .filter(d => !sede.horario[d].cerrado && sede.horario[d].apertura)
            .map(d => `${DIAS_LABEL[d] || d} ${sede.horario[d].apertura}-${sede.horario[d].cierre}`)
            .join(" | ")
        : "";

      // Construir string de servicios
      const servicios = [];
      if (sede.servicios) {
        if (sede.servicios.fitness) servicios.push("Fitness");
        if (sede.servicios.actividades_dirigidas) servicios.push("Actividades dirigidas");
        if (sede.servicios.adicionales && sede.servicios.adicionales.length > 0) {
          servicios.push(...sede.servicios.adicionales.filter(Boolean));
        }
      }
      const serviciosStr = servicios.join(" | ");

      const urls = (data.urls && data.urls.length > 0) ? data.urls.filter(Boolean) : [];
      const freePass = urls[0] || "";
      const sitioWeb = urls[urls.length - 1] || "";

      const row = [
        `${nombreEmpresa} - ${sede.nombre}`,          // nombre_sede
        sede.nombre || "",                            // alias_sede
        "Operando",                                   // Estado
        empresa.ciudad || "",                         // ciudad
        empresa.ciudad || "",                         // distrito (mismo que ciudad si no hay mas info)
        empresa.pais || "",                           // pais
        empresa.direccion || "",                      // direccion
        horarioStr,                                   // horarios
        moneda === "EUR" ? "Euros (EUR)" : `${moneda}`, // moneda
        tipoMembresia,                                // tipo_membresia_disponible
        preciosStr,                                   // precios_all_access
        "",                                           // precios_exclusiva
        "",                                           // precios_uni_exclusiva
        "Consultar con un asesor sobre descuentos especiales vigentes",  // descuentos_disponibles
        "No se cobra inscripcion separada",           // observacion_inscripcion
        serviciosStr,                                 // beneficios_incluidos
        "Consultar con la sede",                      // servicios_adicionales
        freePass,                                     // free_pass_url
        sitioWeb,                                     // sitio_web
      ];
      lines.push(row.map(csvEscape).join(","));
    });

    const csvContent = lines.join("\n");

    // Guardar en Base de Conocimiento/<nombre_subcuenta>.csv
    const fileName = `${nombreEmpresa}.csv`;
    const outPath = path.join(__dirname, "Base de Conocimiento", fileName);

    // Asegurar que la carpeta exista
    const dir = path.dirname(outPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    fs.writeFileSync(outPath, csvContent, "utf8");
    if (addLog) addLog(`[CSV] Generado: Base de Conocimiento/${fileName}`);
    return outPath;
  } catch (err) {
    if (addLog) addLog(`[CSV] ERROR generando CSV: ${err.message}`);
    return null;
  }
}

async function configureSubaccount(locationId, data, job) {
  function addLog(msg) {
    console.log(`[config ${locationId}] ${msg}`);
    if (job) job.log.push(msg);
  }

  const errors = [];
  const loc = await getLocationClient(locationId);

  // --------- PASO: Generar CSV para base de conocimiento ---------
  generarCsvBaseConocimiento(data, addLog);

  try {
    // --------- PASO: Crear empleados ---------
    addLog("[3/6] Creando empleados...");
    const empleados = data.empleados || [];
    const userMap = {};

    for (const emp of empleados) {
      try {
        const userRes = await loc.post("/users/", {
          companyId: loadSecrets().GHL_COMPANY_ID,
          firstName: emp.nombre || "Empleado",
          lastName: emp.apellido || "",
          email: emp.email,
          phone: emp.telefono || "",
          type: "account",
          role: "user",
          locationIds: [locationId],
          password: `Temp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}!`,
        });
        const userId = userRes.data.id;
        userMap[emp.id] = userId;
        addLog(`[3/6] ${emp.nombre} ${emp.apellido} -> ${userId}`);
      } catch (err) {
        errors.push({ step: `user_${emp.email}`, msg: ghlError(err) });
        addLog(`[3/6] WARN ${emp.nombre}: ${ghlError(err)}`);
      }
    }

    // --------- PASO: Actualizar custom fields de sede ---------
    addLog("[4/6] Actualizando custom fields de sede...");
    const sedeNames = (data.sedes || []).map((s) => s.nombre).filter(Boolean);

    if (sedeNames.length > 0) {
      try {
        const cfRes = await loc.get(`/locations/${locationId}/customFields`);
        const cfList = cfRes.data.customFields || [];

        // Contact fields de sede
        const contactSedeKeys = ["tg_centers", "sede_elegida", "nombre_de_sede_prueba", "nombre_de_sede"];
        for (const field of cfList) {
          const baseKey = field.fieldKey.split(".").pop();
          if (contactSedeKeys.includes(baseKey)) {
            try {
              await loc.put(`/locations/${locationId}/customFields/${field.id}`, {
                name: field.name,
                options: sedeNames,
              });
              addLog(`[4/6] Updated ${field.name}`);
            } catch (e) {
              errors.push({ step: `cf_${field.name}`, msg: ghlError(e) });
            }
          }
        }

        // contact.propietario con empleados
        const propField = cfList.find((f) => f.fieldKey === "contact.propietario");
        if (propField) {
          const empleadoNames = empleados.map((e) => `${e.nombre} ${e.apellido}`).filter(Boolean);
          if (empleadoNames.length > 0) {
            try {
              await loc.put(`/locations/${locationId}/customFields/${propField.id}`, {
                name: "Propietario",
                options: empleadoNames,
              });
              addLog(`[4/6] Updated Propietario con ${empleadoNames.length} empleados`);
            } catch (e) {
              errors.push({ step: "cf_propietario", msg: ghlError(e) });
            }
          }
        }

        // opportunity.sede
        const oppRes = await loc.get(`/locations/${locationId}/customFields?model=opportunity`);
        const oppSede = (oppRes.data.customFields || []).find((f) => f.fieldKey === "opportunity.sede");
        if (oppSede) {
          try {
            await loc.put(`/locations/${locationId}/customFields/${oppSede.id}`, {
              name: "Sede",
              options: sedeNames,
            });
            addLog(`[4/6] Updated opportunity.sede`);
          } catch (e) {
            errors.push({ step: "cf_opp_sede", msg: ghlError(e) });
          }
        }
      } catch (err) {
        errors.push({ step: "custom_fields", msg: ghlError(err) });
        addLog(`[4/6] WARN: ${ghlError(err)}`);
      }
    }

    // --------- PASO: Configurar calendarios ---------
    addLog("[5/7] Configurando calendarios...");
    const sedes = data.sedes || [];
    const DIAS_MAP = { lunes: 1, martes: 2, miercoles: 3, jueves: 4, viernes: 5, sabado: 6, domingo: 7 };
    const renamedCalendars = []; // { id, sedeName }
    let placeholderUserId = null;

    try {
      const calRes = await loc.get(`/calendars/?locationId=${locationId}`);
      const calendars = calRes.data.calendars || [];
      addLog(`[5/7] Snapshot trajo ${calendars.length} calendarios`);

      // Si no hay empleados creados, crear usuario placeholder
      if (Object.keys(userMap).length === 0 && sedes.length > 0) {
        try {
          const phRes = await loc.post("/users/", {
            companyId: loadSecrets().GHL_COMPANY_ID,
            firstName: "Admin",
            lastName: "Placeholder",
            email: `admin-placeholder-${locationId}@gymonb.local`,
            phone: "+34600000000",
            type: "account",
            role: "admin",
            locationIds: [locationId],
            password: `Temp_Admin_${Date.now()}_${Math.random().toString(36).slice(2, 8)}!`,
          });
          placeholderUserId = phRes.data.id;
          addLog(`[5/7] Usuario placeholder creado para calendarios: ${placeholderUserId}`);
        } catch (err) {
          addLog(`[5/7] WARN: No se pudo crear placeholder: ${ghlError(err)}`);
        }
      }

      // Renombrar primeros N calendarios a las sedes
      for (let i = 0; i < sedes.length && i < calendars.length; i++) {
        const sede = sedes[i];
        const cal = calendars[i];

        const sedeEmp = empleados.filter((e) => e.sede_id === sede.id);
        let teamMemberIds = sedeEmp.map((e) => userMap[e.id]).filter(Boolean);

        // Si no hay empleados reales, usar placeholder
        if (teamMemberIds.length === 0 && placeholderUserId) {
          teamMemberIds = [placeholderUserId];
        }

        const teamMembers = teamMemberIds.map((userId) => ({
          userId, priority: 0.5, meetingLocationType: "custom",
        }));

        const openHours = [];
        if (sede.horario) {
          for (const dia of Object.keys(sede.horario)) {
            const h = sede.horario[dia];
            if (!h.cerrado && h.apertura && h.cierre) {
              const dayNum = DIAS_MAP[dia];
              if (dayNum) {
                openHours.push({
                  daysOfTheWeek: [dayNum],
                  hours: [{
                    openHour: parseInt(h.apertura.split(":")[0]),
                    openMinute: parseInt(h.apertura.split(":")[1]) || 0,
                    closeHour: parseInt(h.cierre.split(":")[0]),
                    closeMinute: parseInt(h.cierre.split(":")[1]) || 0,
                  }],
                });
              }
            }
          }
        }

        const body = {
          name: sede.nombre,
          teamMembers,
          availabilityType: 0,
          isActive: true,
        };
        if (openHours.length > 0) body.openHours = openHours;

        try {
          await loc.put(`/calendars/${cal.id}`, body);
          renamedCalendars.push({ id: cal.id, sedeName: sede.nombre });
          addLog(`[5/7] Renombrado "${cal.name}" -> "${sede.nombre}" (${teamMembers.length} miembros, activo)`);
        } catch (e) {
          addLog(`[5/7] WARN ${sede.nombre}: ${ghlError(e)}`);
          errors.push({ step: `cal_${sede.nombre}`, msg: ghlError(e) });
        }
      }

      // Eliminar calendarios sobrantes
      const toDelete = calendars.slice(sedes.length);
      for (const cal of toDelete) {
        try {
          await loc.delete(`/calendars/${cal.id}`);
          addLog(`[5/7] Deleted calendario "${cal.name}"`);
        } catch (e) {
          errors.push({ step: `cal_del_${cal.name}`, msg: ghlError(e) });
        }
      }
    } catch (err) {
      errors.push({ step: "calendars", msg: ghlError(err) });
      addLog(`[5/7] WARN: ${ghlError(err)}`);
    }

    // --------- PASO: Crear bot ClaudIA ---------
    addLog("[6/7] Creando bot ClaudIA (Agente - Calendario - Closer)...");
    try {
      const empresa = data.empresa || {};
      const sedesNames = sedes.map(s => s.nombre).filter(Boolean);
      const ciudad = empresa.ciudad || "tu ciudad";
      const pais = empresa.pais || "tu pais";
      const nombreEmpresa = empresa.nombre_fiscal || "el gimnasio";
      const tarifas = data.tarifas || [];
      const moneda = (tarifas[0] && tarifas[0].moneda) || "EUR";
      const monedaNombre = moneda === "EUR" ? "euros (EUR)" : moneda;

      // Construir string de horarios por sede
      const horariosPorSede = sedes.map(s => {
        if (!s.horario) return "";
        const dias = Object.keys(s.horario).filter(d => !s.horario[d].cerrado && s.horario[d].apertura);
        const DIAS_SHORT = { lunes:"Lun", martes:"Mar", miercoles:"Mie", jueves:"Jue", viernes:"Vie", sabado:"Sab", domingo:"Dom" };
        const horarios = dias.map(d => `${DIAS_SHORT[d]} ${s.horario[d].apertura}-${s.horario[d].cierre}`).join(", ");
        return `- ${s.nombre}: ${horarios}`;
      }).filter(Boolean).join("\n");

      const personality = `Asesor humano especializado en gestion y cierre de citas para ${nombreEmpresa}, gimnasio en ${ciudad}, ${pais}.\n\nEl agente debe percibirse siempre como un asesor humano del equipo. Nunca debe mencionar que es una IA, bot, sistema automatizado o asistente virtual. Su nombre es ClaudIA.\n\nTono y estilo: profesional, seguro, cercano, resolutivo. Comunicacion clara, directa y eficiente.\n\nImagen: transmitir seguridad, rapidez, organizacion, atencion personalizada.\n\nMensajes breves y funcionales. Maximo dos emojis por conversacion, unicamente si encajan de forma natural.\n\nAlcance: no realiza venta consultiva ni cierre comercial directo. No asesora medicamente. No explica procesos internos de la empresa.\n\nEntra despues de un flujo previo de botoneras, cuando ciudad y sede ya fueron definidas.`;

      const goal = `Cerrar una cita concreta para una visita al gimnasio ${nombreEmpresa} utilizando la agenda disponible en GoHighLevel.\n\nMomento de activacion: cuando la sede (${sedesNames.join(" o ")}) ya esta definida y el usuario confirmo que desea agendar una cita.\n\nResultado esperado: dejar la cita registrada con sede, dia, hora y datos obligatorios completos.\n\nPrioridad operativa (orden inquebrantable):\n1. Completar los datos obligatorios faltantes.\n2. Solicitar un dia y una hora exactos de preferencia.\n3. Consultar disponibilidad solo despues.\n4. Agendar si existe disponibilidad.\n5. Si no existe disponibilidad, pedir otra hora para el mismo dia.\n\nSi el usuario pregunta por precios, promociones, membresias, horarios, servicios o informacion general, responder solo con la base de conocimiento de la sede definida y retomar el flujo en el punto exacto en que quedo.\n\nResponder dudas no autoriza a saltarse el flujo ni a ofrecer horarios antes de tiempo.\n\nTambien puede cancelar citas existentes cuando el usuario lo pida. Puede reprogramar citas pidiendo nuevo dia y hora.`;

      const instructions = `ROL OPERATIVO\nCloser de agenda para visitas al gimnasio ${nombreEmpresa} (${ciudad}, ${pais}). Convierte la intencion del usuario en una cita confirmada. Entra cuando el lead mostro interes y la sede (${sedesNames.join(" o ")}) ya fue definida. No volver a preguntar ciudad o sede ni reiniciar contexto.\n\nREGLAS DE COMUNICACION\nLenguaje claro, natural, profesional y directo. Evitar lenguaje robotico, textos largos y explicaciones tecnicas.\nCorrecto: "Perfecto, para continuar, me indicas tu nombre y apellido?"\nIncorrecto: "Claro, con mucho gusto procedere a gestionar tu solicitud dentro de nuestro sistema de agenda."\n\nAPERTURA (presentarse una sola vez al tomar la conversacion, sin reiniciar contexto):\n"Hola, soy ClaudIA del equipo de ${nombreEmpresa}. Entiendo que quieres agendar un dia gratuito para vivir la experiencia. Para formalizar tu solicitud, me indicas tu nombre y apellido?"\n\nFLUJO OBLIGATORIO (orden inquebrantable):\n1. Capturar nombre completo si falta.\n2. Capturar correo electronico si falta.\n3. Capturar telefono si el sistema no lo tiene.\n4. Pedir dia y hora exactos de preferencia.\n5. Consultar disponibilidad.\n6. Si hay disponibilidad, agendar.\n7. Si no hay, pedir otra hora para el mismo dia.\n\nREGLA CRITICA: nunca consultar agenda, ofrecer horarios ni agendar antes de completar datos obligatorios y recibir dia y hora exacta del cliente. Aunque exista disponibilidad visible, no mostrarla al inicio.\nSi el lead pregunta sobre precios o servicios, responder con la base de conocimiento de la sede y retomar el paso pendiente.\nSi es queja o reclamo, escalar a humano.\n\nCAPTURA DE DATOS OBLIGATORIOS\nPaso 1 - Nombre: usar mensaje de apertura.\nPaso 2 - Correo: "Gracias. Cual es tu correo electronico?" Validacion: aceptar cualquier correo con @ y dominio. Si no es valido, pedir una vez mas.\nPaso 3 - Telefono (solo si no existe): "Me confirmas tu numero de contacto?" Validacion: solo numeros, sin simbolos. Si no cumple, pedir una vez mas.\n\nSOLICITUD DE DIA Y HORA\n"Que dia y hora te gustaria venir? Con esa preferencia reviso disponibilidad."\n- Precios en ${monedaNombre}.\n- No sugerir dias ni horas. Pedir primero dia y hora exactos.\n- Nunca enumerar horarios antes de la preferencia del cliente.\n\nSi el usuario responde con horarios ambiguos ("por la tarde", "temprano"):\n"Podrias indicarme una hora aproximada? Por ejemplo: 9 am, 11:30 am o 6 pm."\nHora valida: numero concreto con referencia (9, 11:30 am, 18:00, 7 pm).\n\nCONSULTA DE DISPONIBILIDAD\nSolo consultar con datos completos + dia y hora exacta.\nHorario permitido por sede:\n${horariosPorSede}\n\nSi disponible: "Listo, ya quedo programada tu visita el [dia] a las [hora] en ${nombreEmpresa} [sede]. Te esperamos para que vivas la experiencia."\nSi no disponible: "En ese horario ya no tenemos disponibilidad. Que otra hora te funcionaria ese mismo dia?"\nNo cambiar de dia salvo que el usuario lo proponga.\n\nPREGUNTAS SOBRE PRECIOS O SERVICIOS\nUsar unicamente la base de conocimiento de la sede seleccionada.\nNunca mezclar sedes, inventar datos ni suponer.\nModelo: "Claro. Te comparto la info de ${nombreEmpresa} [sede]. [Respuesta de la base de conocimiento]. [Retomar flujo]."\nTras responder, retomar el paso pendiente del flujo.\n\nCANCELACIONES Y REPROGRAMACIONES\nPuedes cancelar citas cuando el usuario lo solicite.\nPuedes reprogramar pidiendo nuevo dia y hora.\n\nESCALAMIENTO\nSolo escalar a humano ante quejas o reclamos.\nRespuesta: "Entiendo tu situacion. Voy a derivar tu caso con un asesor para ayudarte. Me envias un numero de contacto?"\n\nREGLAS CRITICAS INQUEBRANTABLES\nEl agente NUNCA debe:\n- decir que es IA o bot\n- mencionar sistemas internos o GoHighLevel\n- explicar procesos internos\n- asumir horarios ambiguos\n- inventar disponibilidad, precios, promos o servicios\n- responder sin usar la base de conocimiento de la sede\n- mezclar info entre sedes\n- saltarse datos obligatorios\n- consultar agenda antes de tener datos + dia y hora exacta\n- ofrecer horarios antes de la preferencia del cliente\n- cambiar el orden del flujo`;

      const botRes = await loc.post("/conversation-ai/agents", {
        name: "Agente - Calendario - Closer",
        mode: "auto-pilot",
        channels: ["IG","FB","WhatsApp","SMS","Live_Chat","WebChat","Email"],
        waitTime: 15,
        waitTimeUnit: "seconds",
        personality,
        goal,
        instructions,
      }, { headers: { Version: "2021-04-15" } });

      const botId = botRes.data.id;
      addLog(`[6/7] Bot ClaudIA creado: ${botId}`);

      // Action: appointmentBooking con primer calendario
      if (renamedCalendars.length > 0) {
        try {
          await loc.post(`/conversation-ai/agents/${botId}/actions`, {
            type: "appointmentBooking",
            name: `Agendar Cita ${renamedCalendars[0].sedeName}`,
            details: {
              onlySendLink: false,
              triggerWorkflow: false,
              sleepAfterBooking: false,
              transferBot: false,
              rescheduleEnabled: true,
              cancelEnabled: true,
              calendarId: renamedCalendars[0].id,
            },
          }, { headers: { Version: "2021-04-15" } });
          addLog(`[6/7] Action appointmentBooking -> ${renamedCalendars[0].sedeName}`);
        } catch (e) {
          errors.push({ step: "bot_action", msg: ghlError(e) });
          addLog(`[6/7] WARN action: ${ghlError(e)}`);
        }
      }
    } catch (err) {
      errors.push({ step: "bot", msg: ghlError(err) });
      addLog(`[6/7] WARN bot: ${ghlError(err)}`);
    }

    // --------- PASO: Final ---------
    addLog("[7/7] Configuración finalizada");

    if (job) {
      job.result = {
        success: true,
        location_id: locationId,
        message: errors.length > 0
          ? `Configurado con ${errors.length} warning(s)`
          : "Sub-cuenta configurada completamente",
        errors: errors.length > 0 ? errors : undefined,
        form_data: {
          empresa: data.empresa.nombre_fiscal,
          sedes: sedes.length,
          empleados: empleados.length,
          empleados_creados: Object.keys(userMap).length,
        },
      };
      job.status = "done"; job.finishedAt = Date.now(); scheduleSave();
    }
  } catch (err) {
    addLog(`ERROR FATAL: ${ghlError(err)}`);
    if (job) {
      job.result = { success: false, location_id: locationId, message: ghlError(err), errors };
      job.status = "done"; job.finishedAt = Date.now(); scheduleSave();
    }
  }
}

// ============================================================
// ADMIN: panel de control con todos los jobs
// ============================================================

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "";

function checkAdminAuth(req, res) {
  if (!ADMIN_PASSWORD) {
    res.status(503).json({ error: "ADMIN_PASSWORD no configurado en env vars" });
    return false;
  }
  const pass = req.query.key || req.headers["x-admin-password"] || (req.body && req.body.key);
  if (pass !== ADMIN_PASSWORD) {
    res.status(401).json({ error: "Unauthorized. Agregar ?key=XXX o header X-Admin-Password" });
    return false;
  }
  return true;
}

app.get("/admin", (req, res) => {
  res.sendFile(path.join(__dirname, "admin.html"));
});

app.get("/api/admin/jobs", (req, res) => {
  if (!checkAdminAuth(req, res)) return;
  const jobs = Array.from(jobHistory.values())
    .sort((a, b) => b.createdAt - a.createdAt)
    .map((j) => {
      const s = serializeJobForStorage(j);
      return {
        jobId: s.jobId,
        status: s.status,
        createdAt: s.createdAt,
        finishedAt: s.finishedAt,
        locationId: s.locationId,
        empresa: s.empresa,
        email: s.email,
        sedes: s.sedes,
        empleados: s.empleados,
        tarifas: s.tarifas,
        hasResult: !!s.result,
        resultSuccess: s.result && s.result.success,
        errorCount: (s.result && s.result.errors && s.result.errors.length) || 0,
      };
    });
  res.json({ total: jobs.length, jobs });
});

app.get("/api/admin/jobs/:jobId", (req, res) => {
  if (!checkAdminAuth(req, res)) return;
  const job = jobHistory.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: "Job no encontrado" });
  res.json(serializeJobForStorage(job));
});

app.get("/api/admin/jobs/:jobId/csv", (req, res) => {
  if (!checkAdminAuth(req, res)) return;
  const job = jobHistory.get(req.params.jobId);
  if (!job || !job.data || !job.data.empresa) return res.status(404).json({ error: "No encontrado" });
  const nombre = job.data.empresa.nombre_fiscal;
  const csvPath = path.join(__dirname, "Base de Conocimiento", `${nombre}.csv`);
  if (!fs.existsSync(csvPath)) return res.status(404).json({ error: "CSV no encontrado" });
  res.download(csvPath, `${nombre}.csv`);
});

// ============================================================
// MISC ENDPOINTS
// ============================================================

app.get("/api/status", (req, res) => {
  const s = loadSecrets();
  res.json({
    queue: {
      max_concurrent: MAX_CONCURRENT,
      active: activeCount,
      queued: jobQueue.length,
      total_jobs: jobHistory.size,
    },
    pending_webhooks: Array.from(pendingOnboardings.keys()),
    location_tokens: Object.keys(s.GHL_LOCATION_TOKENS || {}),
    agency_token_expires_in_min: Math.round((s.GHL_OAUTH_TOKEN_EXPIRES_AT - Date.now()) / 60000),
  });
});

// ============================================================
// START
// ============================================================

// Cargar historial de jobs al arrancar
loadJobsFromDisk();

app.listen(PORT, () => {
  console.log("");
  console.log("===========================================");
  console.log("  GHL Gym Onboarding Server (OAuth)");
  console.log("===========================================");
  console.log(`  Form:       http://localhost:${PORT}/form.html`);
  console.log(`  Onboarding: http://localhost:${PORT}/api/onboarding`);
  console.log(`  Webhook:    http://localhost:${PORT}/webhooks/ghl/install`);
  console.log(`  Status:     http://localhost:${PORT}/api/status`);
  console.log(`  Admin:      http://localhost:${PORT}/admin`);
  console.log("");
  console.log("===========================================");
  console.log("");
});
