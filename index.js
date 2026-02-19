const express = require('express');
const cors = require('cors');
const moment = require('moment-timezone');
const cron = require('node-cron');

// Configurar moment en español
moment.locale('es');
const swaggerUi = require('swagger-ui-express');

// Importar configuración y servicios
const config = require('./config');
const { initializeAuth, getCalendarInstance } = require('./services/googleAuth');
const { getConfigData, findData, findWorkingHours, updateClientStatus, updateClientAppointmentDateTime, getClientDataByReservationCode, saveClientDataOriginal, consultaDatosPacientePorTelefono, getUpcomingAppointments24h, getUpcomingAppointments15min, getClienteByCelular } = require('./services/dataService');
const { initializePool, testConnection, query } = require('./services/postgresService');
const { findAvailableSlots, cancelEventByReservationCodeOriginal, createEventOriginal, createEventWithCustomId, generateUniqueReservationCode, formatTimeTo12Hour } = require('./services/googleCalendar');
const { sendAppointmentConfirmation, sendNewAppointmentNotification, sendRescheduledAppointmentConfirmation, emailServiceReady } = require('./services/emailService');
const { sendEmailReminder24h } = require('./services/reminderService');
const { sendWhatsAppReminder24h } = require('./services/whatsappService');

const app = express();
const PORT = config.server.port;

// Middlewares
app.use(cors({
  origin: function (origin, callback) {
    // Permitir requests sin origin (Postman, mobile apps, etc.)
    if (!origin) return callback(null, true);
    
    // Lista de orígenes permitidos
    const allowedOrigins = [
      'http://localhost:3000',
      'http://127.0.0.1:3000',
      'http://localhost:3001',
      'http://127.0.0.1:3001',
      /^https:\/\/.*\.railway\.app$/,
      /^https:\/\/.*\.vercel\.app$/,
      /^https:\/\/.*\.netlify\.app$/
    ];
    
    // Verificar si el origin está permitido
    const isAllowed = allowedOrigins.some(allowedOrigin => {
      if (typeof allowedOrigin === 'string') {
        return origin === allowedOrigin;
      } else if (allowedOrigin instanceof RegExp) {
        return allowedOrigin.test(origin);
      }
      return false;
    });
    
    if (isAllowed) {
      callback(null, true);
    } else {
      console.log(`CORS bloqueado para origen: ${origin}`);
      callback(null, true); // Permitir todos temporalmente para desarrollo
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Accept', 'X-Requested-With'],
  exposedHeaders: ['Content-Range', 'X-Content-Range']
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// =================================================================
// 🔧 INICIALIZACIÓN DE SERVICIOS
// =================================================================

// Inicializar conexión a PostgreSQL
try {
  initializePool();
  testConnection().then(async (success) => {
    if (success) {
      console.log('🔧 PostgreSQL inicializado correctamente');
      const { query } = require('./services/postgresService');
      const required = ['clientes', 'especialistas', 'servicios', 'horarios', 'calendario', 'citas'];
      try {
        const { rows } = await query("SELECT tablename FROM pg_tables WHERE schemaname = 'public'");
        const existing = (rows || []).map(r => (r.tablename || '').toLowerCase());
        const missing = required.filter(t => !existing.includes(t));
        if (missing.length > 0) {
          console.error('❌ Faltan tablas en la base de datos:', missing.join(', '));
          console.error('   → Ejecuta el script base.sql en tu base de PostgreSQL de Railway (Data > Query o con psql).');
        }
      } catch (e) {
        console.error('❌ No se pudo verificar tablas:', e.message);
      }
    } else {
      console.error('❌ Error verificando conexión PostgreSQL');
    }
  });
} catch (error) {
  console.error('❌ Error inicializando PostgreSQL:', error.message);
}

// KeepAlive: ejecutar SELECT 1 cada 3 horas para evitar que se duerma la conexión
cron.schedule('0 */3 * * *', async () => {
  try {
    await query('SELECT 1');
  } catch (err) {
    console.error('KeepAlive PostgreSQL:', err.message);
  }
});

// Inicializar autenticación de Google (para Calendar)
try {
  initializeAuth();
  console.log('🔧 Google Calendar API inicializada correctamente');
} catch (error) {
  console.error('❌ Error inicializando Google Calendar API:', error.message);
  console.log('⚠️ La aplicación continuará pero sin acceso a Google Calendar');
}

// =================================================================
// 💾 SISTEMA DE ALMACENAMIENTO DE INFORMACIÓN DE PACIENTES
// =================================================================

// Almacenamiento en memoria de información de pacientes
// Formato: { phone: { name, email, lastUpdated } }
const patientCache = new Map();

/**
 * Normalizar número de teléfono para búsqueda
 * Convierte +5214495847679 -> 4495847679
 */
function normalizePhone(phone) {
  if (!phone) return '';
  // Eliminar todos los caracteres no numéricos
  let cleaned = phone.replace(/\D/g, '');

  if (cleaned.startsWith('521') && cleaned.length >= 13) {
    cleaned = cleaned.substring(3, 13);
  } else if (cleaned.startsWith('52') && cleaned.length >= 12) {
    cleaned = cleaned.substring(2, 12);
  } else if (cleaned.length > 10) {
    cleaned = cleaned.substring(cleaned.length - 10);
  }

  return cleaned;
}

/**
 * Guardar información de paciente en caché
 */
function savePatientInfo(phone, name, email) {
  if (!phone) return;
  const normalizedPhone = normalizePhone(phone);
  if (normalizedPhone) {
    patientCache.set(normalizedPhone, {
      name: name || '',
      email: email || '',
      lastUpdated: new Date()
    });
    console.log(`💾 Información de paciente guardada: ${normalizedPhone} - ${name}`);
  }
}

/**
 * Obtener información de paciente del caché
 */
function getPatientInfo(phone) {
  if (!phone) return null;
  const normalizedPhone = normalizePhone(phone);
  if (normalizedPhone && patientCache.has(normalizedPhone)) {
    const info = patientCache.get(normalizedPhone);
    console.log(`📋 Información de paciente encontrada en caché: ${normalizedPhone} - ${info.name}`);
    return info;
  }
  return null;
}

// =================================================================
// 🛠️ FUNCIONES AUXILIARES MIGRADAS
// =================================================================

function createJsonResponse(data) {
  return data;
}

function formatTime(date) {
  return moment(date).tz(config.timezone.default).format('HH:mm');
}

const CIRCLED_LETTERS = [
  'Ⓐ', 'Ⓑ', 'Ⓒ', 'Ⓓ', 'Ⓔ', 'Ⓕ', 'Ⓖ', 'Ⓗ', 'Ⓘ', 'Ⓙ', 'Ⓚ', 'Ⓛ', 'Ⓜ',
  'Ⓝ', 'Ⓞ', 'Ⓟ', 'Ⓠ', 'Ⓡ', 'Ⓢ', 'Ⓣ', 'Ⓤ', 'Ⓥ', 'Ⓦ', 'Ⓧ', 'Ⓨ', 'Ⓩ'
];

function getCircledLetter(letter) {
  const index = letter.charCodeAt(0) - 65;
  return CIRCLED_LETTERS[index] || letter;
}

function formatSlotsShort(slots, limit = 6) {
  if (!Array.isArray(slots) || slots.length === 0) return '';
  const trimmed = slots.slice(0, limit).map(formatTimeTo12Hour);
  const extraCount = slots.length - trimmed.length;
  return extraCount > 0 ? `${trimmed.join(', ')} y ${extraCount} más` : trimmed.join(', ');
}

function formatSlotsForWhatsApp(slotEntries) {
  const total = slotEntries.length;
  let columns = 1;
  if (total >= 4 && total <= 8) {
    columns = 2;
  } else if (total >= 9) {
    columns = 3;
  }

  const chunkSize = Math.ceil(total / columns);
  const columnChunks = [];
  for (let i = 0; i < columns; i++) {
    columnChunks.push(slotEntries.slice(i * chunkSize, (i + 1) * chunkSize));
  }

  const colWidths = columnChunks.map((col) => {
    if (!col.length) return 0;
    return Math.max(...col.map((entry) => entry.display.length));
  });

  const maxRows = Math.max(...columnChunks.map((col) => col.length));
  const lines = [];
  for (let row = 0; row < maxRows; row++) {
    const parts = [];
    for (let col = 0; col < columns; col++) {
      const entry = columnChunks[col][row];
      if (!entry) {
        parts.push('');
        continue;
      }
      const padded = col < columns - 1 ? entry.display.padEnd(colWidths[col], ' ') : entry.display;
      parts.push(padded);
    }
    lines.push(parts.join('    ').trimEnd());
  }

  return lines.join('\n');
}



function formatDateToSpanishPremium(date) {
  // CORRECCIÓN: Usar moment con zona horaria de México para todos los cálculos
  // Asegurar que la fecha se parsea correctamente con la zona horaria
  const now = moment().tz(config.timezone.default);
  
  // Asegurar que la fecha se parsea correctamente
  let targetDate;
  if (date instanceof Date) {
    targetDate = moment(date).tz(config.timezone.default);
  } else if (typeof date === 'string') {
    // Si es string, parsear con formato YYYY-MM-DD
    targetDate = moment.tz(date, 'YYYY-MM-DD', config.timezone.default);
  } else {
    targetDate = moment(date).tz(config.timezone.default);
  }
  
  const today = now.clone().startOf('day');
  const tomorrow = today.clone().add(1, 'day');
  const yesterday = today.clone().subtract(1, 'day');
  const dayAfterTomorrow = today.clone().add(2, 'days');
  const targetNormalized = targetDate.clone().startOf('day');
  
  console.log(`🗓️ Comparando fechas en ${config.timezone.default}:`);
  console.log(`   - Hoy: ${today.format('YYYY-MM-DD')}`);
  console.log(`   - Objetivo: ${targetNormalized.format('YYYY-MM-DD')}`);
  console.log(`   - Mañana: ${tomorrow.format('YYYY-MM-DD')}`);
  
  if (targetNormalized.isSame(today, 'day')) {
    console.log(`   → Resultado: HOY`);
    return "HOY";
  } else if (targetNormalized.isSame(tomorrow, 'day')) {
    console.log(`   → Resultado: MAÑANA`);
    return "MAÑANA";
  } else if (targetNormalized.isSame(yesterday, 'day')) {
    console.log(`   → Resultado: HOY MISMO`);
    return "HOY MISMO";
  } else if (targetNormalized.isSame(dayAfterTomorrow, 'day')) {
    console.log(`   → Resultado: PASADO MAÑANA`);
    return "PASADO MAÑANA";
  } else {
    // CORRECCIÓN: Asegurar que el día de la semana se formatea correctamente
    const dayName = targetDate.clone().tz(config.timezone.default).format('dddd');
    const dayNumber = targetDate.format('D');
    const monthName = targetDate.format('MMMM');
    const result = `${dayName} ${dayNumber} de ${monthName}`;
    console.log(`   → Resultado: ${result} (fecha original: ${targetDate.format('YYYY-MM-DD')})`);
    return result;
  }
}

function normalizeText(value) {
  if (!value) return '';
  return value
    .toString()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseTimeTo24Hour(timeStr) {
  if (!timeStr) return null;
  const raw = timeStr.toString().trim().toLowerCase();
  const compact = raw.replace(/\s+/g, '');

  const ampmMatch = compact.match(/^(\d{1,2})(?::(\d{2}))?(am|pm)$/);
  if (ampmMatch) {
    let hour = parseInt(ampmMatch[1], 10);
    const minute = parseInt(ampmMatch[2] || '0', 10);
    const period = ampmMatch[3];
    if (hour < 1 || hour > 12 || minute < 0 || minute > 59) return null;
    if (period === 'pm' && hour !== 12) hour += 12;
    if (period === 'am' && hour === 12) hour = 0;
    return { hour, minute };
  }

  const twentyFourMatch = compact.match(/^(\d{1,2}):(\d{2})$/);
  if (twentyFourMatch) {
    const hour = parseInt(twentyFourMatch[1], 10);
    const minute = parseInt(twentyFourMatch[2], 10);
    if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
    return { hour, minute };
  }

  const hourOnlyMatch = compact.match(/^(\d{1,2})$/);
  if (hourOnlyMatch) {
    const hour = parseInt(hourOnlyMatch[1], 10);
    if (hour < 0 || hour > 23) return null;
    return { hour, minute: 0 };
  }

  return null;
}

function parseSpanishDateToMoment(dateStr) {
  if (!dateStr) return null;
  const formats = [
    'dddd D [de] MMMM [de] YYYY',
    'D [de] MMMM [de] YYYY',
    'YYYY-MM-DD'
  ];
  const parsed = moment.tz(dateStr, formats, config.timezone.default);
  if (parsed.isValid()) return parsed;

  const withoutWeekday = dateStr.toString().replace(/^[A-Za-zÁÉÍÓÚÑáéíóúñ]+\s+/i, '');
  const retry = moment.tz(withoutWeekday, ['D [de] MMMM [de] YYYY'], config.timezone.default);
  return retry.isValid() ? retry : null;
}

function getBusinessHoursForDay(dayOfWeek) {
  if (dayOfWeek === 0) return null; // domingo
  if (dayOfWeek === 6) {
    return {
      start: config.workingHours?.saturday?.startHour ?? 10,
      end: config.workingHours?.saturday?.endHour ?? 14
    };
  }
  return {
    start: config.workingHours?.startHour ?? 10,
    end: config.workingHours?.endHour ?? 18
  };
}

function findServiceNumberByName(serviceName, servicesData) {
  if (!serviceName || !servicesData) return null;
  const target = normalizeText(serviceName);
  for (let i = 1; i < servicesData.length; i++) {
    const name = servicesData[i][2];
    if (normalizeText(name) === target) {
      return servicesData[i][0];
    }
  }
  return null;
}

async function buildOutOfHoursMessage(targetMoment, calendarNumber, serviceNumber, configData) {
  const baseMessage = '🚫 Ese horario no está disponible.\n\n🕒 Horario de atención: Lunes a viernes 10:00 a 18:00, sábados 10:00 a 14:00.';

  if (!targetMoment || !configData || !serviceNumber) {
    return `${baseMessage}\n\n🔍 ¿Quieres que te muestre las fechas disponibles más cercanas?`;
  }

  try {
    const alternativeDays = await findAlternativeDaysWithAvailability(
      targetMoment,
      calendarNumber,
      serviceNumber,
      configData
    );

    if (!alternativeDays || alternativeDays.length === 0) {
      return `${baseMessage}\n\n🔍 Te recomiendo consultar disponibilidad para otra fecha.`;
    }

    let message = `${baseMessage}\n\n📅 Fechas disponibles recomendadas:\n`;
    alternativeDays.forEach((day) => {
      const dayLabel = formatDateToSpanishPremium(day.date);
      const times = (day.slots || []).map((slot) => formatTimeTo12Hour(slot)).join(', ');
      message += `• ${dayLabel}: ${times}\n`;
    });
    return message.trim();
  } catch (error) {
    console.error('❌ Error generando recomendaciones:', error.message);
    return `${baseMessage}\n\n🔍 Te recomiendo consultar disponibilidad para otra fecha.`;
  }
}

function getLetterEmoji(index) {
  const letterEmojis = [
    'Ⓐ', 'Ⓑ', 'Ⓒ', 'Ⓓ', 'Ⓔ', 'Ⓕ', 'Ⓖ', 'Ⓗ', 'Ⓘ', 'Ⓙ',
    'Ⓚ', 'Ⓛ', 'Ⓜ', 'Ⓝ', 'Ⓞ', 'Ⓟ', 'Ⓠ', 'Ⓡ', 'Ⓢ', 'Ⓣ',
    'Ⓤ', 'Ⓥ', 'Ⓦ', 'Ⓧ', 'Ⓨ', 'Ⓩ'
  ];
  
  return letterEmojis[index] || `${index + 1}️⃣`;
}

function getOccupationEmoji(percentage) {
  if (percentage >= 80) return '🔴';
  if (percentage >= 60) return '🟡';
  if (percentage >= 40) return '🟢';
  return '✅';
}

function getUrgencyText(percentage) {
  if (percentage >= 80) return '¡AGENDA YA!';
  if (percentage >= 60) return '¡Reserva pronto!';
  if (percentage >= 40) return '';
  return '¡Gran disponibilidad!';
}

// Nueva función: Buscar días alternativos con disponibilidad
async function findAlternativeDaysWithAvailability(targetMoment, calendarNumber, serviceNumber, configData, maxDaysToSearch = 14) {
  try {
    console.log(`🔍 === BUSCANDO DÍAS ALTERNATIVOS ===`);
    console.log(`📅 Fecha objetivo: ${targetMoment.format('YYYY-MM-DD')} (${targetMoment.format('dddd')})`);
    
    const today = moment().tz(config.timezone.default).startOf('day');
    const alternativeDays = [];
    const serviceDuration = findData(serviceNumber, configData.services, 0, 1);
    const calendarId = findData(calendarNumber, configData.calendars, 0, 1);
    
    // 🎯 ESTRATEGIA: Buscar 1 día anterior + días posteriores hasta completar 2 días
    console.log(`📉 Buscando 1 día anterior con disponibilidad...`);
    
    // Buscar hacia atrás (máximo 1 día anterior)
    for (let dayOffset = 1; dayOffset <= 3; dayOffset++) {
      const previousDay = targetMoment.clone().subtract(dayOffset, 'days');
      
      console.log(`   🔍 Evaluando día anterior: ${previousDay.format('YYYY-MM-DD')} (${previousDay.format('dddd')})`);
      
      // 🚫 PROHIBICIÓN: Saltar domingos
      const prevDayOfWeek = previousDay.toDate().getDay();
      if (prevDayOfWeek === 0) {
        console.log(`   🚫 DOMINGO - Saltando día anterior (domingo)`);
        continue;
      }
      
      if (previousDay.isSameOrAfter(today, 'day')) {
        const prevResult = await checkDayAvailability(previousDay, calendarNumber, serviceNumber, configData, calendarId, serviceDuration);
        
        if (prevResult && prevResult.hasAvailability && prevResult.stats.availableSlots >= 1) {
          console.log(`   📊 Día anterior evaluado: ${prevResult.dateStr} (${prevResult.dayName}) - ${prevResult.stats.availableSlots} slots`);
          console.log(`      Slots: [${prevResult.slots?.join(', ') || 'ninguno'}]`);
          
          alternativeDays.push({
            ...prevResult,
            distance: dayOffset,
            direction: 'anterior',
            priority: -dayOffset // Prioridad negativa para que aparezca primero
          });
          
          console.log(`   ✅ Día anterior INCLUIDO: ${prevResult.dateStr}`);
          break; // Solo 1 día anterior
        } else {
          console.log(`   ❌ Sin disponibilidad anterior: ${previousDay.format('YYYY-MM-DD')}`);
        }
      }
    }
    
    // Buscar hacia adelante hasta completar 2 días en total
    const daysNeeded = 2 - alternativeDays.length;
    console.log(`📈 Buscando ${daysNeeded} días posteriores con disponibilidad...`);
    
    for (let dayOffset = 1; dayOffset <= maxDaysToSearch && alternativeDays.length < 2; dayOffset++) {
      const nextDay = targetMoment.clone().add(dayOffset, 'days');
      
      // 🚫 PROHIBICIÓN: Saltar domingos
      const nextDayOfWeek = nextDay.toDate().getDay();
      if (nextDayOfWeek === 0) {
        console.log(`   🚫 DOMINGO - Saltando día posterior (domingo)`);
        continue;
      }
      
      const nextResult = await checkDayAvailability(nextDay, calendarNumber, serviceNumber, configData, calendarId, serviceDuration);
      
      if (nextResult && nextResult.hasAvailability && nextResult.stats.availableSlots >= 1) {
        console.log(`   📊 Día posterior evaluado: ${nextResult.dateStr} (${nextResult.dayName}) - ${nextResult.stats.availableSlots} slots`);
        console.log(`      Slots: [${nextResult.slots?.join(', ') || 'ninguno'}]`);
        
        alternativeDays.push({
          ...nextResult,
          distance: dayOffset,
          direction: 'posterior',
          priority: dayOffset
        });
        
        console.log(`   ✅ Día posterior INCLUIDO: ${nextResult.dateStr}`);
      } else {
        console.log(`   ❌ Sin disponibilidad: ${nextDay.format('YYYY-MM-DD')} (${nextDay.format('dddd')})`);
      }
    }
    
    // Ordenar por prioridad (anterior primero, luego posteriores por cercanía)
    alternativeDays.sort((a, b) => a.priority - b.priority);
    
    console.log(`🎯 RESULTADO FINAL: ${alternativeDays.length} días alternativos encontrados`);
    alternativeDays.forEach(day => {
      console.log(`   - ${day.dateStr} (${day.dayName}, ${day.direction}, ${day.distance} días): ${day.stats.availableSlots} slots`);
    });
    
    return alternativeDays; // Máximo 2 días alternativos
    
  } catch (error) {
    console.error('❌ Error buscando días alternativos:', error.message);
    return [];
  }
}

// Función auxiliar para verificar disponibilidad de un día específico
async function checkDayAvailability(dayMoment, calendarNumber, serviceNumber, configData, calendarId, serviceDuration) {
  try {
    const dateStr = dayMoment.format('YYYY-MM-DD');
    const jsDay = dayMoment.toDate().getDay();
    const dayNumber = (jsDay === 0) ? 7 : jsDay;
    let workingHours = findWorkingHours(calendarNumber, dayNumber, configData.hours);
    const hoursInvalid = !workingHours ||
      !Number.isFinite(workingHours.start) ||
      !Number.isFinite(workingHours.end) ||
      workingHours.start >= workingHours.end;
    if (hoursInvalid) {
      const fallbackHours = getBusinessHoursForDay(jsDay);
      if (!fallbackHours) {
        console.log(`   ❌ No es día laboral (sin horarios y domingo)` );
        return null;
      }
      workingHours = {
        start: fallbackHours.start,
        end: fallbackHours.end,
        dayName: dayMoment.clone().tz(config.timezone.default).format('dddd')
      };
      console.log(`   ⚠️ Horarios inválidos/no definidos en DB, usando horario fijo: ${workingHours.start}:00 - ${workingHours.end}:00`);
    }

    if (config.workingHours.forceFixedSchedule) {
      const fixedHours = getBusinessHoursForDay(jsDay);
      if (!fixedHours) {
        console.log(`   ❌ No es día laboral (domingo)`);
        return null;
      }
      workingHours = {
        start: fixedHours.start,
        end: fixedHours.end,
        dayName: dayMoment.clone().tz(config.timezone.default).format('dddd')
      };
      console.log(`   🔧 Horario forzado por configuración: ${workingHours.start}:00 - ${workingHours.end}:00`);
    }

    console.log(`🔍 Verificando día ${dateStr} (${moment(dayMoment).format('dddd')})`);

    if (!workingHours) {
      console.log(`   ❌ No es día laboral`);
      return null; // No es día laboral
    }

    // CORRECCIÓN: Validar que no sea domingo (prohibido agendar)
    const dayOfWeek = dayMoment.toDate().getDay();
    const isSaturday = dayOfWeek === 6;
    const isSunday = dayOfWeek === 0;
    
    // 🚫 PROHIBICIÓN: No permitir domingos
    if (isSunday) {
      console.log(`   🚫 DOMINGO - No se permite agendar domingos`);
      return null;
    }
    
    // CORRECCIÓN: Horario según el día de la semana
    let correctedHours;
    if (isSaturday) {
      // SÁBADO: Horario especial fijo 10 AM - 2 PM (última sesión: 2 PM - 3 PM)
      correctedHours = {
        start: config.workingHours.saturday.startHour || 10,
        end: config.workingHours.saturday.endHour || 14, // 2 PM (14:00)
        dayName: workingHours.dayName,
        hasLunch: false, // Sábados no tienen horario de comida
        lunchStart: null,
        lunchEnd: null
      };
      console.log(`   📅 SÁBADO - Horario especial: ${correctedHours.start}:00 - ${correctedHours.end}:00 (última sesión: ${correctedHours.end}:00)`);
    } else {
      // DÍAS NORMALES: Horario de 10 AM a 6 PM
      correctedHours = {
        start: Math.max(workingHours.start, 10), // Mínimo 10 AM
        end: Math.min(workingHours.end, 18), // Máximo 6 PM (18:00)
        dayName: workingHours.dayName,
        hasLunch: true,
        lunchStart: config.workingHours.lunchStartHour || 14, // 2 PM
        lunchEnd: config.workingHours.lunchEndHour || 15     // 3 PM
      };
    }

    console.log(`   ⏰ Horario: ${correctedHours.start}:00 - ${correctedHours.end}:00`);
    console.log(`   🍽️ Horario comida: ${correctedHours.hasLunch ? `${correctedHours.lunchStart}:00 - ${correctedHours.lunchEnd}:00` : 'No aplica'}`);

    // CORRECCIÓN: Calcular total slots posibles (horario laboral completo)
    // Incluir el slot de la última hora como última sesión
    const totalPossibleSlots = correctedHours.end - correctedHours.start + 1;
    
    console.log(`   📊 Total slots posibles: ${totalPossibleSlots} (${correctedHours.start}:00-${correctedHours.end}:00)`);
    
    let availableSlots = [];
    let dataSource = 'unknown';
    
    try {
      console.log(`   🔗 Intentando Google Calendar API para ${dateStr}...`);
      // 🆕 PARA DÍAS ALTERNATIVOS: Usar lógica simplificada sin mensajes especiales
      const slotResult = await findAvailableSlots(calendarId, dayMoment.toDate(), parseInt(serviceDuration), correctedHours);
      
      if (typeof slotResult === 'object' && slotResult.slots !== undefined) {
        availableSlots = slotResult.slots;
        dataSource = 'google-calendar-api';
        // 🚫 IGNORAR mensajes especiales en búsqueda alternativa
      } else {
        availableSlots = slotResult;
        dataSource = 'google-calendar-api';
      }
      
      console.log(`   ✅ Google Calendar API exitosa - ${availableSlots.length} slots`);
      
    } catch (error) {
      console.log(`   ⚠️ Error Google Calendar (${error.message}), usando mock...`);
      // Usar mock simplificado solo para verificar disponibilidad
      availableSlots = mockGenerateSlotsForDay(dayMoment, correctedHours);
      dataSource = 'mock-fallback';
      console.log(`   ⚠️ USANDO DATOS SIMULADOS - ${availableSlots.length} slots`);
    }

    console.log(`   📊 Slots encontrados: ${availableSlots.length} (fuente: ${dataSource})`);
    console.log(`   📝 Slots: [${availableSlots.join(', ')}]`);


    if (availableSlots.length > 0) {
      const occupiedSlots = totalPossibleSlots - availableSlots.length;
      const occupationPercentage = totalPossibleSlots > 0 ? Math.round((occupiedSlots / totalPossibleSlots) * 100) : 0;
      
      console.log(`   ✅ Día viable: ${availableSlots.length} slots disponibles (fuente: ${dataSource})`);
      
      // CORRECCIÓN: Usar zona horaria correcta para formatear el día de la semana
      const dayNameFormatted = dayMoment.clone().tz(config.timezone.default).format('dddd');
      
      return {
        date: dayMoment.toDate(),
        dateStr: dateStr,
        slots: availableSlots,
        hasAvailability: true,
        dayName: dayNameFormatted, // Usar formato con zona horaria correcta
        dataSource: dataSource,
        stats: {
          totalSlots: totalPossibleSlots,
          availableSlots: availableSlots.length,
          occupiedSlots: occupiedSlots,
          occupationPercentage: occupationPercentage
        }
      };
    }
    
    console.log(`   ❌ Sin disponibilidad`);
    return null; // No hay disponibilidad
  } catch (error) {
    console.error(`❌ Error verificando día ${dayMoment.format('YYYY-MM-DD')}:`, error.message);
    return null;
  }
}

// Nueva función: Encontrar el siguiente día hábil
function findNextWorkingDay(calendarNumber, startDate, hoursData) {
  try {
    console.log(`🔍 === BUSCANDO SIGUIENTE DÍA HÁBIL ===`);
    console.log(`   - Calendar: ${calendarNumber}`);
    console.log(`   - Fecha inicio: ${startDate.format('YYYY-MM-DD')}`);
    
    let nextDay = startDate.clone().add(1, 'day').startOf('day');
    let maxDays = 14; // Buscar hasta 14 días adelante
    let attempts = 0;
    
    while (attempts < maxDays) {
      const jsDay = nextDay.toDate().getDay();
      const dayNum = (jsDay === 0) ? 7 : jsDay; // Convertir domingo de 0 a 7
      
      console.log(`   - Evaluando: ${nextDay.format('YYYY-MM-DD')} (JS day: ${jsDay}, Day number: ${dayNum})`);
      
      // Buscar horarios para este día
      const workingHours = findWorkingHours(calendarNumber, dayNum, hoursData);
      
      if (workingHours) {
        console.log(`   ✅ Día hábil encontrado: ${nextDay.format('YYYY-MM-DD')}`);
        console.log(`      - Horario: ${workingHours.start}:00 - ${workingHours.end}:00`);
        return nextDay;
      } else {
        console.log(`   ❌ No es día hábil: ${nextDay.format('YYYY-MM-DD')}`);
      }
      
      nextDay.add(1, 'day');
      attempts++;
    }
    
    // Si no encontró ningún día hábil en 14 días, retornar mañana como fallback
    console.log(`⚠️ No se encontró día hábil en ${maxDays} días, usando mañana como fallback`);
    return startDate.clone().add(1, 'day').startOf('day');
    
  } catch (error) {
    console.error('❌ Error buscando siguiente día hábil:', error.message);
    // Fallback: retornar mañana
    return startDate.clone().add(1, 'day').startOf('day');
  }
}

// Nueva función: Buscar la próxima fecha disponible con slots disponibles
async function findNextAvailableDateWithSlots(startDate, calendarNumber, serviceNumber, configData, calendarId, serviceDuration, maxDaysToSearch = 30) {
  try {
    console.log(`🔍 === BUSCANDO PRÓXIMA FECHA DISPONIBLE ===`);
    console.log(`   - Fecha inicio: ${startDate.format('YYYY-MM-DD')}`);
    console.log(`   - Máximo días a buscar: ${maxDaysToSearch}`);
    
    const today = moment().tz(config.timezone.default).startOf('day');
    let currentDay = startDate.clone().add(1, 'day').startOf('day');
    let attempts = 0;
    
    while (attempts < maxDaysToSearch) {
      const jsDay = currentDay.toDate().getDay();
      
      // Saltar domingos
      if (jsDay === 0) {
        console.log(`   ⏭️ Saltando domingo: ${currentDay.format('YYYY-MM-DD')}`);
        currentDay.add(1, 'day');
        attempts++;
        continue;
      }
      
      // Solo buscar días futuros o de hoy
      if (currentDay.isBefore(today, 'day')) {
        currentDay.add(1, 'day');
        attempts++;
        continue;
      }
      
      console.log(`   🔍 Evaluando: ${currentDay.format('YYYY-MM-DD')} (${currentDay.format('dddd')})`);
      
      try {
        const dayResult = await checkDayAvailability(currentDay, calendarNumber, serviceNumber, configData, calendarId, serviceDuration);
        
        if (dayResult && dayResult.hasAvailability && dayResult.slots && dayResult.slots.length > 0) {
          console.log(`   ✅ Fecha disponible encontrada: ${currentDay.format('YYYY-MM-DD')}`);
          console.log(`      - Slots disponibles: ${dayResult.slots.length}`);
          console.log(`      - Primer slot: ${dayResult.slots[0]}`);
          
          return {
            date: dayResult.date,
            dateStr: dayResult.dateStr,
            dayName: dayResult.dayName,
            firstSlot: dayResult.slots[0],
            totalSlots: dayResult.slots.length,
            slots: dayResult.slots
          };
        } else {
          console.log(`   ❌ Sin disponibilidad: ${currentDay.format('YYYY-MM-DD')}`);
        }
      } catch (dayError) {
        console.error(`   ⚠️ Error evaluando día ${currentDay.format('YYYY-MM-DD')}:`, dayError.message);
      }
      
      currentDay.add(1, 'day');
      attempts++;
    }
    
    console.log(`⚠️ No se encontró fecha disponible en ${maxDaysToSearch} días`);
    return null;
    
  } catch (error) {
    console.error('❌ Error buscando próxima fecha disponible:', error.message);
    return null;
  }
}

// =================================================================
// 📡 DATOS DE RESPALDO PARA DESARROLLO
// =================================================================

// Datos mock solo para desarrollo cuando no hay credenciales configuradas
const developmentMockData = {
  calendars: [
    ['Número', 'Calendar ID', 'Especialista'],
    ['1', 'calendario1@gmail.com', 'Dr. García'],
    ['2', 'calendario2@gmail.com', 'Dra. López']
  ],
  services: [
    ['Número', 'Duración (min)'],
    ['1', '30'],
    ['2', '45']
  ],
  hours: [
    ['Calendar', 'Día', 'Hora Inicio', 'Hora Fin'],
    ['1', '1', '10', '18'],
    ['1', '2', '10', '18'],
    ['1', '3', '10', '18'],
    ['1', '4', '10', '18'],
    ['1', '5', '10', '18'],
    ['1', '6', '10', '14'],
    ['2', '1', '10', '18']
  ]
};

// Función auxiliar para desarrollo sin credenciales
function mockFindAvailableSlots(calendarId, date, durationMinutes, hours) {
  console.log('⚠️ Usando datos simulados - configurar credenciales de Google para producción');
  console.log(`🌍 Zona horaria configurada: ${config.timezone.default}`);
  console.log(`🔧 Modo forzado: ${config.workingHours.forceFixedSchedule}`);
  
  // Crear momento para obtener el día de la semana
  const dateMoment = moment(date).tz(config.timezone.default);
  const dayOfWeek = dateMoment.day(); // 0 = Domingo, 1 = Lunes, ..., 6 = Sábado
  const dayNames = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];
  
  console.log(`📅 Mock - Día de la semana: ${dayNames[dayOfWeek]} (${dayOfWeek})`);
  
  // VALIDACIÓN: DOMINGO - No se trabaja
  if (dayOfWeek === 0) { // Domingo
    console.log(`🚫 Mock - DOMINGO - No hay servicio los domingos`);
    return {
      slots: [],
      message: '🚫 No hay servicio los domingos. Por favor, selecciona otro día de la semana.',
      dayType: 'sunday-closed'
    };
  }
  
  // VALIDACIÓN: SÁBADO - Horario especial (10 AM - 2 PM)
  if (dayOfWeek === 6) { // Sábado
    console.log(`📅 Mock - SÁBADO - Horario especial: 10:00 AM - 2:00 PM`);
    const saturdaySlots = generateHourlySlots(dateMoment, {
      start: config.workingHours.saturday.startHour,
      end: config.workingHours.saturday.endHour,
      hasLunch: false,
      lunchStart: null,
      lunchEnd: null
    });
    
    if (saturdaySlots.length === 0) {
      return {
        slots: [],
        message: '📅 Sábados trabajamos de 10:00 AM a 2:00 PM, pero no hay espacios disponibles.',
        dayType: 'saturday-full'
      };
    }
    
    return {
      slots: saturdaySlots,
      message: null,
      dayType: 'saturday-special'
    };
  }
  
  // HORARIOS NORMALES (Lunes a Viernes): SI O SI 10 AM a 6 PM
  const workingHours = {
    start: 10,  // FORZADO: Siempre 10 AM
    end: 18,    // FORZADO: Siempre 6 PM (18:00)
    lunchStart: config.workingHours.lunchStartHour || 14,  // 2 PM
    lunchEnd: config.workingHours.lunchEndHour || 15,      // 3 PM
    hasLunch: true
  };
  
  console.log(`⚙️ Mock - Horarios de trabajo (${dayNames[dayOfWeek]}):`);
  console.log(`   - Inicio: ${workingHours.start}:00`);
  console.log(`   - Fin: ${workingHours.end}:00`);
  console.log(`   - Comida: ${workingHours.lunchStart}:00 - ${workingHours.lunchEnd}:00`);
  
  const slots = generateHourlySlots(dateMoment, workingHours);
  
  return {
    slots: slots,
    message: null,
    dayType: 'weekday-normal'
  };
}

// Función mejorada para generar slots de tiempo de manera más robusta
function generateHourlySlots(dateMoment, workingHours) {
  const availableSlots = [];
  const now = moment().tz(config.timezone.default);
  const minimumBookingTime = now.clone().add(1, 'hours');
  const isToday = dateMoment.isSame(now, 'day');
  
  console.log(`📅 === GENERANDO SLOTS ROBUSTOS ===`);
  console.log(`📅 Fecha: ${dateMoment.format('YYYY-MM-DD dddd')}`);
  console.log(`⏰ Horario laboral: ${workingHours.start}:00 - ${workingHours.end}:00`);
  console.log(`🍽️ Horario comida: ${workingHours.hasLunch ? `${workingHours.lunchStart}:00 - ${workingHours.lunchEnd}:00` : 'No aplica'}`);
  console.log(`🕐 Es hoy: ${isToday}`);
  if (isToday) {
    console.log(`⏰ Hora actual: ${now.format('HH:mm')}, mínimo booking: ${minimumBookingTime.format('HH:mm')}`);
  }
  
  // Generar todos los slots posibles de hora en hora (incluye última cita)
  for (let hour = workingHours.start; hour <= workingHours.end; hour++) {
    console.log(`\n🔍 === EVALUANDO SLOT ${hour}:00 ===`);
    
    // 1. Verificar si es horario de comida
    if (workingHours.hasLunch && hour >= workingHours.lunchStart && hour < workingHours.lunchEnd) {
      console.log(`❌ EXCLUIDO: Horario de comida (${workingHours.lunchStart}:00-${workingHours.lunchEnd}:00)`);
      continue;
    }
    
    // 2. Crear momento para este slot
    const slotTime = dateMoment.clone().hour(hour).minute(0).second(0);
    
    // 3. Verificar anticipación mínima (solo para hoy)
    if (isToday && slotTime.isBefore(minimumBookingTime)) {
      console.log(`❌ EXCLUIDO: Muy pronto para agendar (requiere 1h anticipación)`);
      console.log(`   Slot: ${slotTime.format('HH:mm')}, Mínimo: ${minimumBookingTime.format('HH:mm')}`);
      continue;
    }
    
    // 4. Si llegamos aquí, el slot es válido
    const timeSlot = `${hour.toString().padStart(2, '0')}:00`;
    availableSlots.push(timeSlot);
    console.log(`✅ INCLUIDO: ${timeSlot}`);
  }
  
  console.log(`\n📊 === RESUMEN SLOTS ===`);
  console.log(`Total slots evaluados: ${workingHours.end - workingHours.start + 1}`);
  console.log(`Slots válidos generados: ${availableSlots.length}`);
  console.log(`Slots: [${availableSlots.join(', ')}]`);
  
  return availableSlots;
}

// Función auxiliar para generar slots mock (backward compatibility)
function mockGenerateSlotsForDay(dateMoment, workingHours) {
  console.log(`🚨 USANDO FUNCIÓN MOCK - NO Google Calendar real`);
  return generateHourlySlots(dateMoment, workingHours);
}

// =================================================================
// 🌐 ENDPOINTS DE LA API
// =================================================================

/**
 * ENDPOINT: Health Check para Railway
 */
app.get('/health', (req, res) => {
  const healthData = {
    status: 'OK',
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV || 'development',
    port: PORT,
    services: {
      googleAuth: config.google.clientEmail ? 'configured' : 'missing',
      database: config.postgres.host ? 'configured' : 'missing'
    },
    version: '1.0.0'
  };
  
  res.status(200).json(healthData);
});

/**
 * ENDPOINT: Root - Información de la API
 */
app.get('/', (req, res) => {
  const serverUrl = getServerUrl();
  res.json({
    message: '🚀 Demo Asistente Fisio API - Sistema de Gestión de Citas',
    version: '1.0.0',
    environment: process.env.NODE_ENV || 'development',
    documentation: `${serverUrl}/api-docs`,
    endpoints: {
      consulta_disponibilidad: `GET ${serverUrl}/api/consulta-disponibilidad`,
      agenda_cita: `POST ${serverUrl}/api/agenda-cita`,
      cancela_cita: `POST ${serverUrl}/api/cancela-cita`,
      reagenda_cita: `POST ${serverUrl}/api/reagenda-cita`,
      confirma_cita: `POST ${serverUrl}/api/confirma-cita`,
      carga_datos_iniciales: `GET ${serverUrl}/api/carga-datos-iniciales?celular={numero}`,
      consulta_datos_paciente: `GET ${serverUrl}/api/consulta-datos-paciente`
    },
    status: 'operational'
  });
});

/**
 * ENDPOINT 1: ConsultaDisponibilidad (GET)
 * Consulta horarios disponibles con 3 días + estadísticas
 */
app.get('/api/consulta-disponibilidad', async (req, res) => {
  try {
    console.log('🔍 === CONSULTA DISPONIBILIDAD ===');
    const { service: serviceNumber, date: targetDateStr, days: daysParam } = req.query;
    const calendarNumber = '1'; // Hardcodeado: siempre usar calendario 1

    console.log('Parámetros recibidos:', { calendarNumber: calendarNumber + ' (hardcodeado)', serviceNumber, targetDateStr, daysParam });

    const daysRequested = parseInt(daysParam, 10);
    const hasDaysParam = Number.isFinite(daysRequested) && daysRequested > 0;

    if (!serviceNumber || (!targetDateStr && !hasDaysParam)) {
      return res.json(createJsonResponse({ 
        respuesta: '⚠️ Error: Faltan parámetros. Se requiere "service" y "date".' 
      }));
    }
    
    // Parsear fecha directamente en zona horaria de México para evitar desajustes
    const targetMoment = targetDateStr
      ? moment.tz(targetDateStr, 'YYYY-MM-DD', config.timezone.default)
      : null;
    if (targetDateStr && !targetMoment.isValid()) {
      return res.json(createJsonResponse({ 
        respuesta: '⚠️ Error: Formato de fecha inválido. Por favor, usa el formato YYYY-MM-DD.' 
      }));
    }
    
    const targetDate = targetMoment ? targetMoment.toDate() : null;

    // Obtener datos de PostgreSQL
    let configData;
    try {
      configData = await getConfigData();
    } catch (error) {
      console.log('⚠️ Error obteniendo datos de PostgreSQL, usando mock data:', error.message);
      configData = developmentMockData;
    }

    const calendarId = findData(calendarNumber, configData.calendars, 0, 1);
    if (!calendarId) { 
      console.log(`❌ Calendario no encontrado: ${calendarNumber}`);
      return res.json(createJsonResponse({ 
        respuesta: '🚫 Error: El calendario solicitado no fue encontrado.' 
      })); 
    }

    const serviceDuration = findData(serviceNumber, configData.services, 0, 1);
    if (!serviceDuration) { 
      console.log(`❌ Servicio no encontrado: ${serviceNumber}`);
      return res.json(createJsonResponse({ 
        respuesta: '🚫 Error: El servicio solicitado no fue encontrado.' 
      })); 
    }

    console.log(`✅ Calendar ID: ${calendarId}, Service Duration: ${serviceDuration} min`);
    
    // LÓGICA MEJORADA: Consultar múltiples días
    const today = moment().tz(config.timezone.default).startOf('day');
    
    console.log(`📅 === CONSULTA DE MÚLTIPLES DÍAS ===`);
    console.log(`   - Hoy: ${today.format('YYYY-MM-DD')}`);
    if (targetMoment) {
      console.log(`   - Fecha solicitada: ${targetMoment.format('YYYY-MM-DD')}`);
    }
    
    if (!hasDaysParam && targetMoment) {
      // Validar que no sea una fecha en el pasado
      if (targetMoment.isBefore(today, 'day')) {
        return res.json(createJsonResponse({ 
          respuesta: '⚠️ No puedes consultar fechas en el pasado. Por favor, selecciona una fecha futura.' 
        }));
      }
      
      // Ajustar fecha de inicio: usar hoy si la fecha solicitada es en el pasado relativo
      const jsDay = targetDate.getDay();
      const dayNumber = (jsDay === 0) ? 7 : jsDay;
      
      // CORRECCIÓN: Si es domingo, buscar próxima fecha disponible y mostrar mensaje
      if (jsDay === 0) {
        console.log(`🚫 DOMINGO detectado - Buscando próxima fecha disponible`);
        console.log(`🔍 Buscando próxima fecha disponible con slots...`);
        
        // Buscar la próxima fecha disponible con slots
        const nextAvailable = await findNextAvailableDateWithSlots(
          targetMoment,
          calendarNumber,
          serviceNumber,
          configData,
          calendarId,
          serviceDuration
        );
        
        if (nextAvailable) {
          const dayNameFormatted = formatDateToSpanishPremium(nextAvailable.date);
          const time12h = formatTimeTo12Hour(nextAvailable.firstSlot);
          return res.json(createJsonResponse({ 
            respuesta: `😔 Los días domingos no contamos con servicio, puedes consultar el día **${dayNameFormatted}** (${nextAvailable.dateStr}) a las **${time12h}**.\n\n🔍 Esta es la próxima fecha y hora más cercana disponible en el calendario.` 
          }));
        } else {
          return res.json(createJsonResponse({ 
            respuesta: `😔 Los días domingos no contamos con servicio.\n\n🔍 Por favor, intenta con otra fecha o contacta directamente.` 
          }));
        }
      }
      
      const workingHours = findWorkingHours(calendarNumber, dayNumber, configData.hours);
      
      if (!workingHours) {
        return res.json(createJsonResponse({ 
          respuesta: '🚫 No hay servicio para la fecha seleccionada. Por favor, elige otra fecha.' 
        }));
      }
    }
    
    // NUEVA LÓGICA: Consultar días con disponibilidad real (hasta llenar el cupo)
    // Si hay "days", empezar desde HOY y tomar N días hábiles con slots
    // Si NO hay "days", usar fecha solicitada y buscar los 2 días más cercanos con slots
    const totalDaysRequired = hasDaysParam ? Math.min(daysRequested, 7) : 2;
    const maxDaysToCheck = hasDaysParam ? 30 : 10; // margen para encontrar días con disponibilidad
    const startDate = hasDaysParam
      ? today.clone()
      : (targetMoment.isBefore(today, 'day') ? today : targetMoment);
    
    const daysWithSlots = [];
    const datesChecked = [];
    
    console.log(`📊 === CONSULTA DE ${totalDaysRequired} DÍAS CON DISPONIBILIDAD (${hasDaysParam ? `MODE=days:${totalDaysRequired}` : 'CERCANOS A FECHA SOLICITADA'}) ===`);
    console.log(`📅 Fecha inicial: ${startDate.format('YYYY-MM-DD')} (${startDate.format('dddd')})`);
    
    for (let i = 0; i < maxDaysToCheck && daysWithSlots.length < totalDaysRequired; i++) {
      const checkDate = startDate.clone().add(i, 'days');
      const jsDay = checkDate.toDate().getDay();
      
      // Saltar domingos (día 0)
      if (jsDay === 0) {
        continue;
      }
      
      datesChecked.push(checkDate.toDate());
      
      const dayInfo = {
        date: checkDate.toDate(),
        label: hasDaysParam ? 'menu' : (i === 0 ? 'solicitado' : 'siguiente'),
        emoji: hasDaysParam ? '📅' : (i === 0 ? '📅' : '📆'),
        priority: datesChecked.length
      };
      const dayMoment = moment(dayInfo.date).tz(config.timezone.default);
      const dateStr = dayMoment.format('YYYY-MM-DD');
      
      console.log(`🔍 Evaluando día ${dayInfo.label}: ${dateStr} (hoy: ${today.format('YYYY-MM-DD')})`);
      
      // Solo procesar días que no sean en el pasado
      if (dayMoment.isSameOrAfter(today, 'day')) {
        try {
          if (hasDaysParam) {
            const dayResult = await checkDayAvailability(
              dayMoment,
              calendarNumber,
              serviceNumber,
              configData,
              calendarId,
              serviceDuration
            );
            if (dayResult && dayResult.hasAvailability && dayResult.slots && dayResult.slots.length > 0) {
              daysWithSlots.push({
                ...dayResult,
                label: 'menu',
                emoji: '📅',
                priority: daysWithSlots.length + 1
              });
            }
            continue;
          }
          const jsDay = dayInfo.date.getDay();
          const dayNumber = (jsDay === 0) ? 7 : jsDay;
          const workingHours = findWorkingHours(calendarNumber, dayNumber, configData.hours);

          if (!workingHours) {
            console.log(`   ⚠️ No se encontraron horarios laborales para ${dateStr} (día ${dayNumber})`);
            continue;
          }

          if (workingHours) {
          // CORRECCIÓN: Validar que no sea domingo (prohibido agendar)
          const isSaturday = jsDay === 6;
          const isSunday = jsDay === 0;
          
          // 🚫 PROHIBICIÓN: No permitir domingos
          if (isSunday) {
            console.log(`   🚫 DOMINGO - Saltando día (domingo no permitido)`);
            continue;
          }
          
          // CORRECCIÓN: Horario según el día de la semana
          let correctedHours;
          if (isSaturday) {
            // SÁBADO: Horario especial fijo 10 AM - 2 PM (última sesión: 2 PM - 3 PM)
            correctedHours = {
              start: config.workingHours.saturday.startHour || 10,
              end: config.workingHours.saturday.endHour || 14, // 2 PM (14:00)
              dayName: workingHours.dayName,
              ignoreMinimumBookingTime: true
            };
            console.log(`   📅 SÁBADO - Horario especial: ${correctedHours.start}:00 - ${correctedHours.end}:00 (última sesión: ${correctedHours.end}:00)`);
          } else {
            // DÍAS NORMALES: SI O SI 10 AM a 6 PM
            correctedHours = {
              start: 10, // FORZADO: Siempre 10 AM
              end: 18,   // FORZADO: Siempre 6 PM (18:00)
              dayName: workingHours.dayName,
              ignoreMinimumBookingTime: true
            };
          }
          
          console.log(`📅 Procesando día ${dayInfo.label}: ${dateStr}`);
          console.log(`   - Horario original: ${workingHours.start}:00 - ${workingHours.end}:00`);
          console.log(`   - Horario corregido: ${correctedHours.start}:00 - ${correctedHours.end}:00`);
          console.log(`   - Horario comida: Flexible según eventos del calendario`);
          
          // CORRECCIÓN: Calcular total slots posibles (horario laboral completo)
          // Incluir el slot de la última hora (6 PM) como última sesión
          const totalPossibleSlots = correctedHours.end - correctedHours.start + 1;
          
          console.log(`   📊 Total slots posibles: ${totalPossibleSlots} (de ${correctedHours.start}:00 a ${correctedHours.end}:00)`);
          
          let availableSlots = [];
          
          try {
            
            // Intentar usar Google Calendar API real
            const slotResult = await findAvailableSlots(calendarId, dayInfo.date, parseInt(serviceDuration), correctedHours);
            
            if (typeof slotResult === 'object' && slotResult.slots !== undefined) {
              availableSlots = slotResult.slots;
            } else {
              availableSlots = slotResult;
            }
          } catch (error) {
            console.error(`   ❌ ERROR consultando calendar real:`, error.message);
            console.error(`   Stack:`, error.stack);
            console.log(`⚠️ Error consultando calendar real, usando mock: ${error.message}`);
            const mockResult = mockFindAvailableSlots(calendarId, dayInfo.date, parseInt(serviceDuration), correctedHours);
            
            if (typeof mockResult === 'object' && mockResult.slots !== undefined) {
              availableSlots = mockResult.slots;
            } else {
              availableSlots = mockResult;
            }
          }
          
          // CORRECCIÓN CRÍTICA: Validar que el resultado sea válido
          if (!Array.isArray(availableSlots)) {
            console.error(`   ⚠️ ADVERTENCIA: availableSlots no es un array, es: ${typeof availableSlots}`);
            console.error(`   ⚠️ Valor recibido:`, availableSlots);
            availableSlots = [];
          }
          
          const occupiedSlots = totalPossibleSlots - availableSlots.length;
          const occupationPercentage = totalPossibleSlots > 0 ? Math.round((occupiedSlots / totalPossibleSlots) * 100) : 0;
          
          console.log(`   - Total slots posibles: ${totalPossibleSlots}, Disponibles: ${availableSlots.length}, Ocupación: ${occupationPercentage}%`);
          console.log(`   - Slots encontrados: [${availableSlots.join(', ')}]`);
          
          // CORRECCIÓN CRÍTICA: Si no hay slots pero debería haber, investigar
          if (availableSlots.length === 0 && totalPossibleSlots > 0) {
            console.error(`   ⚠️ ADVERTENCIA: No se encontraron slots disponibles pero hay ${totalPossibleSlots} slots posibles`);
            console.error(`   ⚠️ Esto puede indicar un problema con la detección de conflictos o con la generación de slots`);
            console.error(`   ⚠️ Revisar logs anteriores para identificar la causa`);
          }
          
          if (availableSlots.length > 0) {
            const dayWithSlots = {
              date: dayInfo.date,
              dateStr: dateStr,
              slots: availableSlots,
              label: dayInfo.label,
              emoji: dayInfo.emoji,
              priority: dayInfo.priority,
              stats: {
                totalSlots: totalPossibleSlots,
                availableSlots: availableSlots.length,
                occupiedSlots: occupiedSlots,
                occupationPercentage: occupationPercentage
              }
            };
            
            daysWithSlots.push(dayWithSlots);
            console.log(`   ✅ Día agregado a daysWithSlots: ${dayInfo.label} con ${availableSlots.length} slots`);
            console.log(`      Slots agregados: [${availableSlots.join(', ')}]`);
          } else {
            console.log(`   ❌ Día NO agregado: ${dayInfo.label} - availableSlots.length = 0`);
          }
        } else {
          console.log(`   ⚠️ No se encontraron horarios laborales para ${dateStr}`);
        }
        } catch (dayError) {
          console.error(`   ❌ Error procesando día ${dateStr}:`, dayError.message);
          console.error(`   Stack:`, dayError.stack);
          // Continuar con el siguiente día en lugar de fallar completamente
          continue;
        }
      }
    }
    
    console.log(`\n📊 === RESUMEN DÍAS PROCESADOS ===`);
    console.log(`Días con slots encontrados: ${daysWithSlots.length}`);
    daysWithSlots.forEach(day => {
      console.log(`   ✅ ${day.label}: ${day.slots.length} slots [${day.slots.join(', ')}]`);
    });
    
    if (daysWithSlots.length === 0) {
      if (hasDaysParam || !targetMoment) {
        return res.json(createJsonResponse({ 
          respuesta: '😔 No encontré horarios disponibles en los próximos días. Intenta con otra fecha o contáctanos directamente.' 
        }));
      }
      // CORRECCIÓN: Solo buscar el día específico solicitado, NO días alternativos
      console.log(`\n🔍 === NO HAY DISPONIBILIDAD EN ${targetDateStr} ===`);
      console.log(`📅 Buscando únicamente el día solicitado: ${targetMoment.format('YYYY-MM-DD')} (${targetMoment.format('dddd')})`);
      
      // Verificar el día solicitado específicamente
      const jsDay = targetDate.getDay();
      const dayNumber = (jsDay === 0) ? 7 : jsDay;
      
      // 🚫 PROHIBICIÓN: No permitir domingos
      if (jsDay === 0) {
        console.log(`🚫 DOMINGO - No se permite agendar domingos`);
        console.log(`🔍 Buscando próxima fecha disponible...`);
        
        // Buscar la próxima fecha disponible con slots
        const nextAvailable = await findNextAvailableDateWithSlots(
          targetMoment,
          calendarNumber,
          serviceNumber,
          configData,
          calendarId,
          serviceDuration
        );
        
        if (nextAvailable) {
          const dayNameFormatted = formatDateToSpanishPremium(nextAvailable.date);
          const time12h = formatTimeTo12Hour(nextAvailable.firstSlot);
          return res.json(createJsonResponse({ 
            respuesta: `😔 Los días domingos no contamos con servicio, puedes consultar el día **${dayNameFormatted}** (${nextAvailable.dateStr}) a las **${time12h}**.\n\n🔍 Esta es la próxima fecha y hora más cercana disponible en el calendario.` 
          }));
        } else {
          return res.json(createJsonResponse({ 
            respuesta: `😔 Los días domingos no contamos con servicio.\n\n🔍 Por favor, intenta con otra fecha o contacta directamente.` 
          }));
        }
      }
      
      const workingHours = findWorkingHours(calendarNumber, dayNumber, configData.hours);
      
      if (!workingHours) {
        return res.json(createJsonResponse({ 
          respuesta: `🚫 No hay servicio para ${formatDateToSpanishPremium(targetDate)}. Por favor, elige otra fecha.` 
        }));
      }
      
      // CORRECCIÓN: Horario según el día de la semana
      const jsDayForHours = targetDate.getDay();
      const isSaturdayForHours = jsDayForHours === 6;
      
      let correctedHours;
      if (isSaturdayForHours) {
        // SÁBADO: Horario especial fijo 10 AM - 2 PM (última sesión: 2 PM - 3 PM)
        correctedHours = {
          start: config.workingHours.saturday.startHour || 10,
          end: config.workingHours.saturday.endHour || 14, // 2 PM (14:00)
          dayName: workingHours.dayName
        };
        console.log(`   📅 SÁBADO - Horario especial: ${correctedHours.start}:00 - ${correctedHours.end}:00 (última sesión: ${correctedHours.end}:00)`);
      } else {
        // DÍAS NORMALES: SI O SI 10 AM a 6 PM
        correctedHours = {
          start: 10, // FORZADO: Siempre 10 AM
          end: 18,   // FORZADO: Siempre 6 PM (18:00)
          dayName: workingHours.dayName
        };
      }
      
        // Intentar obtener slots del día específico
      try {
        const slotResult = await findAvailableSlots(calendarId, targetDate, parseInt(serviceDuration), correctedHours);
        
        let availableSlots = [];
        if (typeof slotResult === 'object' && slotResult.slots !== undefined) {
          availableSlots = slotResult.slots;
        } else if (Array.isArray(slotResult)) {
          availableSlots = slotResult;
        } else {
          console.warn(`⚠️ Resultado inesperado de findAvailableSlots:`, typeof slotResult);
          console.warn(`⚠️ Valor recibido:`, slotResult);
          availableSlots = [];
        }
        
        // CORRECCIÓN CRÍTICA: Validar que el resultado sea válido
        if (!Array.isArray(availableSlots)) {
          console.error(`   ⚠️ ADVERTENCIA: availableSlots no es un array, es: ${typeof availableSlots}`);
          console.error(`   ⚠️ Valor recibido:`, availableSlots);
          availableSlots = [];
        }
        
        const totalPossibleSlotsFallback = correctedHours.end - correctedHours.start + 1;
        
        // CORRECCIÓN CRÍTICA: Si no hay slots pero debería haber, investigar antes de retornar error
        if (availableSlots.length === 0 && totalPossibleSlotsFallback > 0) {
          console.error(`\n⚠️ === ADVERTENCIA CRÍTICA: NO SE ENCONTRARON SLOTS PARA ${targetDateStr} ===`);
          console.error(`   📋 Total slots posibles: ${totalPossibleSlotsFallback}`);
          console.error(`   📋 Horario: ${correctedHours.start}:00 - ${correctedHours.end}:00`);
          console.error(`   📋 Slots encontrados: ${availableSlots.length}`);
          console.error(`   ⚠️ Esto puede indicar un problema con la detección de conflictos o con la generación de slots`);
          console.error(`   ⚠️ Revisar logs anteriores para identificar la causa`);
          console.error(`   ⚠️ NO se retornará error inmediatamente - se intentará regenerar`);
          
          // Intentar una segunda vez con logging más detallado
          try {
            console.log(`   🔄 Intentando regenerar slots con logging detallado...`);
            const retryResult = await findAvailableSlots(calendarId, targetDate, parseInt(serviceDuration), correctedHours);
            
            let retrySlots = [];
            if (typeof retryResult === 'object' && retryResult.slots !== undefined) {
              retrySlots = retryResult.slots;
            } else if (Array.isArray(retryResult)) {
              retrySlots = retryResult;
            }
            
            if (retrySlots.length > 0) {
              console.log(`   ✅ Reintento exitoso: ${retrySlots.length} slots encontrados`);
              availableSlots = retrySlots;
            } else {
              console.error(`   ❌ Reintento también falló - no se encontraron slots`);
            }
          } catch (retryError) {
            console.error(`   ❌ Error en reintento:`, retryError.message);
          }
        }
        
        if (availableSlots.length === 0) {
          const dayName = formatDateToSpanishPremium(targetDate);
          console.error(`   ❌ Finalmente no hay slots disponibles para ${targetDateStr}`);
          console.log(`🔍 Día sin disponibilidad - Buscando próxima fecha disponible...`);
          
          // Buscar la próxima fecha disponible con slots
          const nextAvailable = await findNextAvailableDateWithSlots(
            targetMoment,
            calendarNumber,
            serviceNumber,
            configData,
            calendarId,
            serviceDuration
          );
          
          if (nextAvailable) {
            const nextDayNameFormatted = formatDateToSpanishPremium(nextAvailable.date);
            const time12h = formatTimeTo12Hour(nextAvailable.firstSlot);
            return res.json(createJsonResponse({ 
              respuesta: `😔 No tengo horarios disponibles para *${dayName}* (${targetDateStr}).\n\n🔍 Te recomiendo el día **${nextDayNameFormatted}** (${nextAvailable.dateStr}) a las **${time12h}**.\n\n📅 Esta es la próxima fecha y hora más cercana disponible en el calendario.` 
            }));
          } else {
            return res.json(createJsonResponse({ 
              respuesta: `😔 No tengo horarios disponibles para *${dayName}* (${targetDateStr}).\n\n🔍 Te sugerimos elegir otra fecha o contactarnos directamente.` 
            }));
          }
        }
        
        // Si hay slots disponibles, agregarlos a daysWithSlots
        const totalPossibleSlots = correctedHours.end - correctedHours.start + 1;
        const dayWithSlots = {
          date: targetDate,
          dateStr: targetDateStr,
          slots: availableSlots,
          label: 'solicitado',
          emoji: '📅',
          priority: 1,
          stats: {
            totalSlots: totalPossibleSlots,
            availableSlots: availableSlots.length,
            occupiedSlots: totalPossibleSlots - availableSlots.length,
            occupationPercentage: totalPossibleSlots > 0 ? Math.round(((totalPossibleSlots - availableSlots.length) / totalPossibleSlots) * 100) : 0
          }
        };
        
        daysWithSlots.push(dayWithSlots);
        console.log(`✅ Día solicitado agregado con ${availableSlots.length} slots disponibles`);
      } catch (error) {
        console.error(`⚠️ Error consultando disponibilidad para ${targetDateStr}:`, error.message);
        console.error(`   Stack:`, error.stack);
        try {
          const dayName = formatDateToSpanishPremium(targetDate);
          return res.json(createJsonResponse({ 
            respuesta: `😔 No pude consultar los horarios disponibles para *${dayName}* (${targetDateStr}).\n\n🔍 Te sugerimos elegir otra fecha o contactarnos directamente.` 
          }));
        } catch (formatError) {
          return res.json(createJsonResponse({ 
            respuesta: `😔 No pude consultar los horarios disponibles para ${targetDateStr}.\n\n🔍 Te sugerimos elegir otra fecha o contactarnos directamente.` 
          }));
        }
      }
    }
    
    daysWithSlots.sort((a, b) => a.priority - b.priority);
    
    //let responseText = `🔥 ¡${daysWithSlots.length} ${daysWithSlots.length === 1 ? 'día' : 'días'} con disponibilidad encontrada!\n\n`;
    let responseText = '📅 *Estas son las fechas que tenemos disponibles:*\n\n';
    
    const totalSlotsAvailable = daysWithSlots.reduce((sum, day) => sum + day.stats.availableSlots, 0);
    const avgOccupation = Math.round(daysWithSlots.reduce((sum, day) => sum + day.stats.occupationPercentage, 0) / daysWithSlots.length);
    
    //responseText += `📊 *Resumen:* ${totalSlotsAvailable} horarios disponibles • ${avgOccupation}% ocupación promedio\n\n`;
    
    let letterIndex = 0;
    let dateMapping = {};
    
    // Formatear mensaje con todos los días en formato más visual
    for (const dayData of daysWithSlots) {
      // CORRECCIÓN: Asegurar que se use la fecha correcta con zona horaria
      const correctDateStr = dayData.dateStr;
      const dayMoment = moment.tz(correctDateStr, 'YYYY-MM-DD', config.timezone.default);
      const dayName = formatDateToSpanishPremium(correctDateStr);

      const dayLabelRaw = dayMoment.format('dddd D [de] MMMM');
      const dayLabel = dayLabelRaw.charAt(0).toUpperCase() + dayLabelRaw.slice(1);

      responseText += '━━━━━━━━━━━━━━━━━━━━━\n\n';
      responseText += `🗓️ *${dayLabel}*\n`;

      const formattedSlots = dayData.slots.map((slot) => {
        const letter = String.fromCharCode(65 + letterIndex); // A, B, C, etc.
        const time12h = formatTimeTo12Hour(slot);
        
        dateMapping[letter] = {
          date: correctDateStr, // Usar fecha corregida
          time: slot,
          dayName: dayName
        };
        
        letterIndex++;
        return {
          display: `${getCircledLetter(letter)} ${time12h}`
        };
      });

      responseText += `${formatSlotsForWhatsApp(formattedSlots)}\n\n`;
    }
    
    const hasEarlierDay = daysWithSlots.some(day => day.label === 'anterior');
    const hasHighDemandDay = daysWithSlots.some(day => day.stats.occupationPercentage >= 70);
    const hasLowDemandDay = daysWithSlots.some(day => day.stats.occupationPercentage <= 30);
    
    /*
    if (hasEarlierDay) {
      responseText += `⚡ *¡Oportunidad!* Hay espacios anteriores disponibles - ¡agenda antes! 💰\n`;
    }
    
    if (hasHighDemandDay) {
      responseText += `🔥 *¡Urgente!* Algunos días tienen alta demanda - ¡reserva rápido!\n`;
    }
    
    if (hasLowDemandDay) {
      responseText += `✈️ *¡Perfecto!* Algunos días tienen excelente disponibilidad\n`;
    }
      */
    
    responseText += `💡 Escribe la letra del horario que prefieras`;
    
    return res.json(createJsonResponse({ 
      respuesta: responseText,
      metadata: {
        totalDays: daysWithSlots.length,
        totalSlots: totalSlotsAvailable,
        averageOccupation: avgOccupation,
        dateMapping: dateMapping,
        recommendations: {
          hasEarlierDay: hasEarlierDay,
          hasHighDemandDay: hasHighDemandDay,
          hasLowDemandDay: hasLowDemandDay
        }
      }
    }));

  } catch (error) {
    console.error('❌ === ERROR EN CONSULTA DISPONIBILIDAD ===');
    console.error('Error message:', error.message);
    console.error('Error stack:', error.stack);
    console.error('Fecha solicitada:', req.query?.date);
    console.error('Servicio:', req.query?.service);
    
    // Intentar retornar un mensaje más específico si es posible
    try {
      const targetDateStr = req.query?.date;
      if (targetDateStr) {
        const targetMoment = moment.tz(targetDateStr, 'YYYY-MM-DD', config.timezone.default);
        if (targetMoment.isValid()) {
          const jsDay = targetMoment.toDate().getDay();
          const dayName = formatDateToSpanishPremium(targetMoment.toDate());
          
          // Si es domingo, buscar próxima fecha disponible
          if (jsDay === 0) {
            try {
              const configData = await getConfigData();
              const calendarId = findData('1', configData.calendars, 0, 1);
              const serviceDuration = findData(req.query?.service || '1', configData.services, 0, 1);
              
              const nextAvailable = await findNextAvailableDateWithSlots(
                targetMoment,
                '1',
                req.query?.service || '1',
                configData,
                calendarId,
                serviceDuration
              );
              
              if (nextAvailable) {
                const nextDayNameFormatted = formatDateToSpanishPremium(nextAvailable.date);
                const time12h = formatTimeTo12Hour(nextAvailable.firstSlot);
                return res.json(createJsonResponse({ 
                  respuesta: `😔 Los días domingos no contamos con servicio, puedes consultar el día **${nextDayNameFormatted}** (${nextAvailable.dateStr}) a las **${time12h}**.\n\n🔍 Esta es la próxima fecha y hora más cercana disponible en el calendario.` 
                }));
              }
            } catch (searchError) {
              console.error('Error buscando próxima fecha disponible:', searchError.message);
            }
            
            return res.json(createJsonResponse({ 
              respuesta: `😔 Los días domingos no contamos con servicio.\n\n🔍 Por favor, intenta con otra fecha o contacta directamente.` 
            }));
          }
          
          // Para otros días, intentar buscar próxima fecha disponible
          try {
            const configData = await getConfigData();
            const calendarId = findData('1', configData.calendars, 0, 1);
            const serviceDuration = findData(req.query?.service || '1', configData.services, 0, 1);
            
            const nextAvailable = await findNextAvailableDateWithSlots(
              targetMoment,
              '1',
              req.query?.service || '1',
              configData,
              calendarId,
              serviceDuration
            );
            
            if (nextAvailable) {
              const nextDayNameFormatted = formatDateToSpanishPremium(nextAvailable.date);
              const time12h = formatTimeTo12Hour(nextAvailable.firstSlot);
              return res.json(createJsonResponse({ 
                respuesta: `😔 No pude consultar la disponibilidad para *${dayName}* (${targetDateStr}).\n\n🔍 Te recomiendo el día **${nextDayNameFormatted}** (${nextAvailable.dateStr}) a las **${time12h}**.\n\n📅 Esta es la próxima fecha y hora más cercana disponible en el calendario.` 
              }));
            }
          } catch (searchError) {
            console.error('Error buscando próxima fecha disponible:', searchError.message);
          }
          
          return res.json(createJsonResponse({ 
            respuesta: `😔 No pude consultar la disponibilidad para *${dayName}* (${targetDateStr}).\n\n🔍 Por favor, intenta con otra fecha o contacta directamente.` 
          }));
        }
      }
    } catch (formatError) {
      console.error('Error al formatear fecha en catch:', formatError.message);
    }
    
    return res.json(createJsonResponse({ 
      respuesta: '🤖 Ha ocurrido un error inesperado al consultar la disponibilidad.' 
    }));
  }
});

/**
 * ENDPOINT: Cancelar cita (LÓGICA ORIGINAL)
 */
app.post('/api/cancela-cita', async (req, res) => {
  try {
    console.log('🗑️ === INICIO CANCELACIÓN ORIGINAL ===');
    console.log('Body recibido:', JSON.stringify(req.body, null, 2));
    
    const {
      action,
      calendar: calendarNumberRaw,
      eventId,
      codigo_reserva,
      codigoReserva
    } = req.body;
    const codigoReservaFinal = (eventId || codigo_reserva || codigoReserva || '').toString().trim();
    const calendarNumber = (calendarNumberRaw || '1').toString().trim();

    // Validar parámetros
    if (!action || action !== 'cancel') {
      return res.json({ respuesta: '⚠️ Error: Se requiere action: "cancel"' });
    }

    if (!codigoReservaFinal) {
      return res.json({ respuesta: '⚠️ Error de cancelación: Falta el código de reserva (eventId/codigo_reserva).' });
    }

    console.log(`📊 Parámetros: calendar=${calendarNumber}, código=${codigoReservaFinal}`);

    // Obtener datos de configuración
    let configData;
    try {
      configData = await getConfigData();
      console.log('✅ Configuración obtenida correctamente');
    } catch (error) {
      console.error('❌ Error obteniendo configuración:', error.message);
      return res.json({ respuesta: `❌ Error obteniendo configuración: ${error.message}` });
    }

    // Obtener calendar ID
    const calendarId = findData(calendarNumber, configData.calendars, 0, 1);
    if (!calendarId) {
      console.log(`❌ Calendario ${calendarNumber} no encontrado. Intentando cancelar en todos los calendarios...`);
    } else {
      console.log(`📅 Calendar ID: ${calendarId}`);
    }

    const attemptedCalendarIds = new Set();
    const tryCancelInCalendar = async (targetCalendarId) => {
      if (!targetCalendarId || attemptedCalendarIds.has(targetCalendarId)) return null;
      attemptedCalendarIds.add(targetCalendarId);
      return cancelEventByReservationCodeOriginal(targetCalendarId, codigoReservaFinal);
    };

    // Intentar primero con el calendario solicitado (si existe)
    let cancelResult = calendarId ? await tryCancelInCalendar(calendarId) : null;

    // Si no existe el calendario o falló, intentar en todos los calendarios configurados
    if (!cancelResult || !cancelResult.success) {
      const calendarRows = Array.isArray(configData.calendars) ? configData.calendars.slice(1) : [];
      for (const row of calendarRows) {
        const candidateCalendarId = row && row[1] ? row[1].toString().trim() : '';
        const result = await tryCancelInCalendar(candidateCalendarId);
        if (result && result.success) {
          cancelResult = result;
          console.log(`✅ Cancelación encontrada en calendario alterno: ${candidateCalendarId}`);
          break;
        }
      }
    }
    
    if (cancelResult && cancelResult.success) {
      // Actualizar estado en base de datos
      try {
        await updateClientStatus(codigoReservaFinal, 'CANCELADA');
        console.log(`✅ Estado actualizado en PostgreSQL: ${codigoReservaFinal} -> CANCELADA`);
      } catch (updateError) {
        console.error('❌ Error actualizando PostgreSQL:', updateError.message);
        // No fallar la cancelación por este error
      }
      
      console.log('🎉 Cancelación exitosa');
      return res.json({ respuesta: cancelResult.message });
      
    } else {
      console.log('❌ Cancelación fallida');
      const fallbackMessage = cancelResult && cancelResult.message
        ? cancelResult.message
        : `🤷‍♀️ No se encontró ninguna cita con el código de reserva ${codigoReservaFinal.toUpperCase()} en ningún calendario. Verifica que el código sea correcto.`;
      return res.json({ respuesta: fallbackMessage });
    }

  } catch (error) {
    console.error('💥 Error en cancelación:', error.message);
    return res.json({ respuesta: '🤖 Ha ocurrido un error inesperado al cancelar la cita.' });
  }
});

/**
 * ENDPOINT: Reagendar cita
 */
app.post('/api/reagenda-cita', async (req, res) => {
  try {
    console.log('🔄 === INICIO REAGENDAMIENTO ===');
    console.log('Body recibido:', JSON.stringify(req.body, null, 2));
    
    const { codigo_reserva, fecha_reagendada, hora_reagendada } = req.body;

    // PASO 1: Validar parámetros
    if (!codigo_reserva || !fecha_reagendada || !hora_reagendada) {
      return res.json({ 
        respuesta: '⚠️ Error: Faltan datos. Se requiere codigo_reserva, fecha_reagendada y hora_reagendada.' 
      });
    }

    console.log(`📊 Parámetros: código=${codigo_reserva}, fecha=${fecha_reagendada}, hora=${hora_reagendada}`);

    // PASO 2: Obtener información de la cita desde PostgreSQL
    console.log('📋 Obteniendo información de la cita...');
    const clientData = await getClientDataByReservationCode(codigo_reserva);
    
    if (!clientData) {
      console.log(`❌ No se encontró cita con código: ${codigo_reserva}`);
      return res.json({ 
        respuesta: `❌ No se encontró ninguna cita con el código de reserva ${codigo_reserva.toUpperCase()}. Verifica que el código sea correcto.` 
      });
    }

    console.log('✅ Información de la cita obtenida:', clientData);

    // Guardar información antigua para el correo
    const oldDate = clientData.date;
    const oldTime = clientData.time;

    // PASO 3: Obtener configuración de calendario y servicio
    let configData;
    try {
      configData = await getConfigData();
      console.log('✅ Configuración obtenida correctamente');
    } catch (error) {
      console.error('❌ Error obteniendo configuración:', error.message);
      return res.json({ respuesta: `❌ Error obteniendo configuración: ${error.message}` });
    }

    const calendarId = findData('1', configData.calendars, 0, 1);
    if (!calendarId) {
      console.log('❌ Calendario no encontrado');
      return res.json({ respuesta: '🚫 Error: El calendario solicitado no fue encontrado.' });
    }

    console.log(`📅 Calendar ID: ${calendarId}`);

    // PASO 4: Eliminar evento antiguo del calendario
    console.log('🗑️ Eliminando evento antiguo del calendario...');
    console.log(`   - Código de reserva: ${codigo_reserva}`);
    console.log(`   - Calendar ID: ${calendarId}`);
    
    const cancelResult = await cancelEventByReservationCodeOriginal(calendarId, codigo_reserva);
    
    if (cancelResult.success) {
      console.log('✅ Evento antiguo eliminado exitosamente del calendario');
    } else {
      console.log('⚠️ No se pudo eliminar el evento antiguo');
      console.log(`   - Mensaje: ${cancelResult.message || 'No se encontró el evento'}`);
      console.log('   - Continuando con la creación del nuevo evento...');
    }

    // PASO 5: Validar nueva fecha/hora (igual que en agenda-cita)
    const now = moment().tz(config.timezone.default);
    const startTimeMoment = moment.tz(`${fecha_reagendada} ${hora_reagendada}`, 'YYYY-MM-DD HH:mm', config.timezone.default);
    const endTimeMoment = startTimeMoment.clone().add(1, 'hour');
    const minimumBookingTime = moment(now).add(1, 'hours');

    console.log('=== VALIDACIÓN DE FECHA Y TIEMPO (ZONA HORARIA MÉXICO) ===');
    console.log('now:', now.format('YYYY-MM-DD HH:mm:ss z'));
    console.log('startTime:', startTimeMoment.format('YYYY-MM-DD HH:mm:ss z'));
    console.log('minimumBookingTime:', minimumBookingTime.format('YYYY-MM-DD HH:mm:ss z'));

    if (!startTimeMoment.isValid()) {
      console.log('❌ ERROR: Formato de fecha/hora inválido');
      return res.json({ 
        respuesta: '⚠️ Error: Formato de fecha u hora inválido. Usa formato YYYY-MM-DD para fecha y HH:MM para hora.' 
      });
    }

    if (startTimeMoment.minute() !== 0) {
      console.log('❌ ERROR: Horario con minutos no permitidos');
      return res.json({ 
        respuesta: '⚠️ Solo se permiten horarios en punto (por ejemplo: 10:00, 11:00, 12:00). Por favor elige una hora completa.'
      });
    }

    // VALIDACIÓN 1: No permitir fechas en el pasado
    const startOfToday = now.clone().startOf('day');
    const requestedDate = startTimeMoment.clone().startOf('day');
    
    if (requestedDate.isBefore(startOfToday)) {
      console.log('❌ ERROR: Fecha en el pasado');
      console.log(`   - Fecha solicitada: ${requestedDate.format('YYYY-MM-DD')}`);
      console.log(`   - Hoy: ${startOfToday.format('YYYY-MM-DD')}`);
      
      return res.json({ 
        respuesta: '❌ No puedes reagendar citas para fechas pasadas.\n\n🔍 Por favor, selecciona una fecha de hoy en adelante.' 
      });
    }

    // VALIDACIÓN 2: Verificar día de la semana (Domingo no se trabaja)
    const dayOfWeek = startTimeMoment.day(); // 0 = Domingo, 1 = Lunes, ..., 6 = Sábado
    const dayNames = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];
    
    console.log(`📅 Día de la semana: ${dayNames[dayOfWeek]} (${dayOfWeek})`);
    
    if (dayOfWeek === 0) { // Domingo
      console.log(`🚫 DOMINGO - No hay servicio los domingos`);
      return res.json({ 
        respuesta: '🚫 No hay servicio los domingos. Por favor, selecciona otro día de la semana (Lunes a Sábado).' 
      });
    }

    // VALIDACIÓN 3: Horario especial de Sábado (10:00 AM - 2:00 PM)
    if (dayOfWeek === 6) { // Sábado
      const hour = startTimeMoment.hour();
      console.log(`📅 SÁBADO - Verificando horario especial (hora: ${hour})`);
      
      if (hour < config.workingHours.saturday.startHour || hour >= config.workingHours.saturday.endHour) {
        const saturdayStart = config.workingHours.saturday.startHour;
        const saturdayEnd = config.workingHours.saturday.endHour;
        const saturdayStartLabel = formatTimeTo12Hour(`${saturdayStart.toString().padStart(2, '0')}:00`);
        const saturdayEndLabel = formatTimeTo12Hour(`${saturdayEnd.toString().padStart(2, '0')}:00`);
        
        return res.json({ 
          respuesta: `⚠️ Los sábados solo se atiende de ${saturdayStartLabel} a ${saturdayEndLabel}.\n\n🔍 Por favor, selecciona un horario dentro de este rango o elige otro día.` 
        });
      }
      console.log('✅ Horario válido para sábado');
    }

    // VALIDACIÓN 4: Tiempo mínimo de anticipación para el mismo día
    const isToday = startTimeMoment.isSame(now, 'day');
    console.log('isToday:', isToday);
    console.log('startTime < minimumBookingTime:', startTimeMoment.isBefore(minimumBookingTime));
    
    if (isToday && startTimeMoment.isBefore(minimumBookingTime)) {
      const time12h = formatTimeTo12Hour(hora_reagendada);
      console.log('❌ ERROR: Cita demasiado pronto (menos de 1 hora)');
      
      // Encontrar siguiente día hábil
      const nextWorkingDay = findNextWorkingDay('1', now, configData.hours);
      const nextWorkingDayName = formatDateToSpanishPremium(nextWorkingDay.toDate());
      const nextWorkingDateStr = nextWorkingDay.format('YYYY-MM-DD');
      
      return res.json({ 
        respuesta: `🤚 Debes reagendar con al menos una hora de anticipación. No puedes reservar para las ${time12h} de hoy.\n\n📅 El siguiente día hábil es: ${nextWorkingDayName} (${nextWorkingDateStr})\n\n🔍 Te recomiendo consultar la disponibilidad para esa fecha antes de reagendar tu cita.` 
      });
    }

    // VALIDACIÓN 5: Horario laboral normal (Lunes a Viernes: 10 AM - 6 PM)
    if (dayOfWeek >= 1 && dayOfWeek <= 5) { // Lunes a Viernes
      const hour = startTimeMoment.hour();
      console.log(`📅 DÍA LABORAL - Verificando horario (hora: ${hour})`);
      
      if (hour < config.workingHours.startHour || hour >= config.workingHours.endHour) {
        const startHour = config.workingHours.startHour;
        const endHour = config.workingHours.endHour;
        const startLabel = formatTimeTo12Hour(`${startHour.toString().padStart(2, '0')}:00`);
        const endLabel = formatTimeTo12Hour(`${endHour.toString().padStart(2, '0')}:00`);
        return res.json({ 
          respuesta: `⚠️ El horario de atención es de ${startLabel} a ${endLabel}.\n\n🔍 Por favor, selecciona un horario dentro de este rango.` 
        });
      }
      console.log('✅ Horario válido para día laboral');
    }

    console.log('✅ VALIDACIONES COMPLETADAS - Fecha y hora válidas');
    console.log(`📅 Nueva fecha/hora: ${startTimeMoment.format('YYYY-MM-DD HH:mm')}`);

    // PASO 6: Crear evento con ID personalizado en Google Calendar
    console.log('📝 === CREACIÓN DE EVENTO EN CALENDARIO ===');
    console.log(`📅 Calendar ID: ${calendarId}`);
    console.log(`🎟️ Código de reserva: ${codigo_reserva}`);
    console.log(`📊 Nueva fecha/hora:`);
    console.log(`   - Fecha: ${fecha_reagendada}`);
    console.log(`   - Hora: ${hora_reagendada}`);
    console.log(`   - StartTime (moment): ${startTimeMoment.format('YYYY-MM-DD HH:mm:ss z')}`);
    console.log(`   - EndTime (moment): ${endTimeMoment.format('YYYY-MM-DD HH:mm:ss z')}`);
    console.log(`   - StartTime (Date): ${startTimeMoment.toDate().toISOString()}`);
    console.log(`   - EndTime (Date): ${endTimeMoment.toDate().toISOString()}`);
    
    const eventTitle = `Cita: ${clientData.clientName} (${codigo_reserva})`;
    const eventDescription = `
Cliente: ${clientData.clientName}
Teléfono: ${clientData.clientPhone}
Email: ${clientData.clientEmail}
Servicio: ${clientData.serviceName}
Especialista: ${clientData.profesionalName}
Duración: 60 min.
Estado: REAGENDADA
Agendado por: Agente de WhatsApp`;

    const eventData = {
      title: eventTitle,
      description: eventDescription,
      startTime: startTimeMoment.toDate(),
      endTime: endTimeMoment.toDate()
    };
    
    console.log(`📋 Datos del evento:`);
    console.log(`   - Título: ${eventTitle}`);
    console.log(`   - Cliente: ${clientData.clientName}`);

    // Usar createEventWithCustomId para crear el nuevo evento con el código como ID
    console.log('🔄 Intentando crear evento en calendario...');
    console.log(`   - Calendar ID: ${calendarId}`);
    console.log(`   - Fecha: ${fecha_reagendada}`);
    console.log(`   - Hora: ${hora_reagendada}`);
    console.log(`   - StartTime: ${startTimeMoment.format('YYYY-MM-DD HH:mm:ss z')}`);
    console.log(`   - EndTime: ${endTimeMoment.format('YYYY-MM-DD HH:mm:ss z')}`);
    
    const createResult = await createEventWithCustomId(calendarId, eventData, codigo_reserva);

    if (!createResult.success) {
      console.log('❌ Error creando evento en calendario');
      console.log('❌ Detalle del error:', createResult.error);
      console.log('❌ Mensaje:', createResult.message);
      return res.json({ 
        respuesta: `❌ Error reagendando la cita en el calendario: ${createResult.error || createResult.message || 'El horario podría estar ocupado'}` 
      });
    }

    // Verificar que el evento realmente se creó
    if (!createResult.event || !createResult.event.id) {
      console.log('❌ ERROR CRÍTICO: createResult.success es true pero no hay evento creado');
      console.log('❌ createResult completo:', JSON.stringify(createResult, null, 2));
      return res.json({ 
        respuesta: `❌ Error: La cita se procesó pero no se pudo crear en el calendario. Por favor, contacta al soporte.` 
      });
    }

    console.log('✅ Evento creado exitosamente en calendario');
    console.log(`   - Event ID: ${createResult.event.id}`);
    console.log(`   - Event Summary: ${createResult.event.summary}`);
    console.log(`   - Event Start: ${createResult.event.start?.dateTime || createResult.event.start?.date}`);
    console.log(`   - Event End: ${createResult.event.end?.dateTime || createResult.event.end?.date}`);
    
    // Verificación adicional: Confirmar que el evento existe en el calendario
    try {
      const calendar = await getCalendarInstance();
      const verifyEvent = await calendar.events.get({
        calendarId: calendarId,
        eventId: createResult.event.id
      });
      
      if (verifyEvent.data) {
        console.log('✅ VERIFICACIÓN: Evento confirmado en calendario');
        console.log(`   - Título verificado: ${verifyEvent.data.summary}`);
        console.log(`   - Fecha/hora verificada: ${verifyEvent.data.start?.dateTime || verifyEvent.data.start?.date}`);
      } else {
        console.log('⚠️ ADVERTENCIA: No se pudo verificar el evento en el calendario');
      }
    } catch (verifyError) {
      console.log('⚠️ ADVERTENCIA: Error al verificar evento en calendario:', verifyError.message);
      // No fallar el proceso por esto, solo registrar la advertencia
    }

    // PASO 7: Actualizar fecha y hora en PostgreSQL
    console.log('📝 Actualizando fecha y hora en PostgreSQL...');
    const updateDateTimeResult = await updateClientAppointmentDateTime(
      codigo_reserva, 
      fecha_reagendada, 
      hora_reagendada
    );

    if (!updateDateTimeResult) {
      console.log('⚠️ No se pudo actualizar fecha/hora en PostgreSQL');
    } else {
      console.log('✅ Fecha y hora actualizadas en PostgreSQL');
    }

    // PASO 8: Cambiar estado a REAGENDADA
    console.log('📝 Actualizando estado a REAGENDADA...');
    try {
      await updateClientStatus(codigo_reserva, 'REAGENDADA');
      console.log('✅ Estado actualizado a REAGENDADA');
    } catch (updateError) {
      console.error('⚠️ Error actualizando estado:', updateError.message);
    }

    // PASO 9: Enviar correo electrónico de confirmación
    console.log('📧 === ENVÍO DE EMAIL ===');
    try {
      if (emailServiceReady && clientData.clientEmail && clientData.clientEmail !== 'Sin Email') {
        const emailData = {
          clientName: clientData.clientName,
          clientEmail: clientData.clientEmail,
          oldDate: oldDate,
          oldTime: oldTime,
          newDate: fecha_reagendada,
          newTime: hora_reagendada,
          serviceName: clientData.serviceName,
          profesionalName: clientData.profesionalName,
          codigoReserva: codigo_reserva.toUpperCase()
        };
        
        console.log('📧 Enviando confirmación de reagendamiento al cliente...');
        const emailResult = await sendRescheduledAppointmentConfirmation(emailData);
        
        if (emailResult.success) {
          console.log('✅ Email de reagendamiento enviado exitosamente');
        } else {
          console.log('⚠️ Email no enviado:', emailResult.reason || emailResult.error);
        }
      } else {
        console.log('⚠️ Email saltado - SMTP no configurado o email inválido');
      }
    } catch (emailError) {
      console.error('❌ Error enviando email (no crítico):', emailError.message);
    }

    // PASO 10: Preparar respuesta con resumen
    const time12h = formatTimeTo12Hour(hora_reagendada);
    const fechaFormateada = moment.tz(fecha_reagendada, config.timezone.default).format('dddd, D [de] MMMM [de] YYYY');

    const finalResponse = {
      respuesta: `🔄 ¡Cita reagendada exitosamente! ✨

📅 Detalles de tu nueva cita:
• Fecha: ${fechaFormateada}
• Hora: ${time12h}
• Cliente: ${clientData.clientName}
• Servicio: ${clientData.serviceName}
• Especialista: ${clientData.profesionalName}

🎟️ TU CÓDIGO DE RESERVA: ${codigo_reserva.toUpperCase()}

✅ Tu cita ha sido reagendada correctamente.
📧 Recibirás un correo de confirmación.

¡Gracias por confiar en nosotros! 🌟`
    };

    console.log('🎉 === REAGENDAMIENTO EXITOSO ===');
    return res.json(finalResponse);

  } catch (error) {
    console.error('💥 Error en reagendamiento:', error.message);
    console.error('Stack:', error.stack);
    return res.json({ respuesta: '🤖 Ha ocurrido un error inesperado al reagendar la cita.' });
  }
});

/**
 * ENDPOINT: Confirmar cita
 */
app.post('/api/confirma-cita', async (req, res) => {
  try {
    console.log('✅ === CONFIRMACIÓN DE CITA ===');
    console.log('Body recibido:', JSON.stringify(req.body, null, 2));
    
    const { codigo_reserva } = req.body;

    // PASO 1: Validar parámetros
    if (!codigo_reserva) {
      return res.json({ 
        respuesta: '⚠️ Error: Se requiere el codigo_reserva.' 
      });
    }

    console.log(`📊 Código de reserva: ${codigo_reserva}`);

    // PASO 2: Obtener información de la cita desde PostgreSQL
    console.log('📋 Obteniendo información de la cita...');
    const clientData = await getClientDataByReservationCode(codigo_reserva);
    
    if (!clientData) {
      console.log(`❌ No se encontró cita con código: ${codigo_reserva}`);
      return res.json({ 
        respuesta: `❌ No se encontró ninguna cita con el código de reserva ${codigo_reserva.toUpperCase()}. Verifica que el código sea correcto.` 
      });
    }

    console.log('✅ Información de la cita obtenida:', clientData);

    // PASO 3: Verificar estado actual
    if (clientData.estado === 'CANCELADA') {
      return res.json({ 
        respuesta: `⚠️ Esta cita ya fue cancelada. Si deseas agendar nuevamente, por favor comunícate con nosotros.` 
      });
    }

    if (clientData.estado === 'CONFIRMADA') {
      return res.json({ 
        respuesta: `✅ Tu cita ya estaba confirmada previamente.\n\n📅 Detalles:\n• Fecha: ${clientData.date}\n• Hora: ${clientData.time}\n• Con: ${clientData.profesionalName}\n\n¡Te esperamos! 🌟` 
      });
    }

    // PASO 4: Actualizar estado a CONFIRMADA
    console.log('📝 Actualizando estado a CONFIRMADA...');
    try {
      await updateClientStatus(codigo_reserva, 'CONFIRMADA');
      console.log('✅ Estado actualizado a CONFIRMADA');
    } catch (updateError) {
      console.error('⚠️ Error actualizando estado:', updateError.message);
      return res.json({ 
        respuesta: '❌ Error al confirmar la cita. Por favor, intenta nuevamente.' 
      });
    }

    // PASO 5: Preparar respuesta con confirmación
    const finalResponse = {
      respuesta: `✅ ¡Tu asistencia ha sido confirmada! 🎉

Nos alegra saber que nos visitarás pronto. ¡Te esperamos en tu sesión! 🌟`
    };

    console.log('🎉 === CONFIRMACIÓN EXITOSA ===');
    return res.json(finalResponse);

  } catch (error) {
    console.error('💥 Error en confirmación:', error.message);
    console.error('Stack:', error.stack);
    return res.json({ respuesta: '🤖 Ha ocurrido un error inesperado al confirmar la cita.' });
  }
});

/**
 * ENDPOINT DE DEBUG: Verificar datos de una cita específica
 */
app.get('/api/debug-cita/:codigo', async (req, res) => {
  try {
    const codigoReserva = req.params.codigo;
    console.log(`🔍 === DEBUG DE CITA: ${codigoReserva} ===`);
    
    // PASO 1: Verificar datos en PostgreSQL
    let clientData = null;
    try {
      clientData = await getClientDataByReservationCode(codigoReserva);
    } catch (error) {
      console.log(`❌ Error obteniendo datos del cliente: ${error.message}`);
    }
    
    let response = `🔍 DEBUG: ${codigoReserva}\n\n`;
    
    if (!clientData) {
      response += `❌ PASO 1: No se encontró el código ${codigoReserva} en la base de datos\n`;
      response += `   - Verifica que el código exista en la hoja CLIENTES\n`;
      response += `   - Verifica los permisos de la cuenta de servicio\n`;
      return res.json({ respuesta: response });
    }
    
    response += `✅ PASO 1: Código encontrado en la base de datos\n`;
    response += `   - Cliente: ${clientData.clientName}\n`;
    response += `   - Fecha: ${clientData.date}\n`;
    response += `   - Hora: ${clientData.time}\n`;
    response += `   - Estado: ${clientData.estado}\n\n`;
    
    // PASO 2: Obtener datos del calendario
    let configData;
    try {
      configData = await getConfigData();
    } catch (error) {
      response += `❌ PASO 2: Error obteniendo configuración: ${error.message}\n`;
      return res.json({ respuesta: response });
    }
    
    const calendarId = findData('1', configData.calendars, 0, 1);
    response += `✅ PASO 2: Calendar ID obtenido: ${calendarId}\n\n`;
    
    // PASO 3: Verificar eventos en la fecha específica
    try {
      const calendar = await getCalendarInstance();
      const startOfDay = new Date(clientData.date + 'T00:00:00');
      const endOfDay = new Date(clientData.date + 'T23:59:59');
      
      const eventsResponse = await calendar.events.list({
        calendarId: calendarId,
        timeMin: startOfDay.toISOString(),
        timeMax: endOfDay.toISOString(),
        singleEvents: true,
        orderBy: 'startTime'
      });
      
      const events = eventsResponse.data.items || [];
      
      response += `✅ PASO 3: Eventos en ${clientData.date}: ${events.length}\n\n`;
      
      if (events.length > 0) {
        response += `📅 EVENTOS ENCONTRADOS:\n`;
        events.forEach((event, index) => {
          const eventStart = new Date(event.start?.dateTime || event.start?.date);
          const eventTimeStr = `${eventStart.getHours().toString().padStart(2, '0')}:${eventStart.getMinutes().toString().padStart(2, '0')}`;
          response += `   ${index + 1}. ${eventTimeStr}: "${event.summary}"\n`;
        });
        
        // PASO 4: Verificar evento específico en la hora
        const targetHour = parseInt(clientData.time.split(':')[0]);
        const candidateEvents = events.filter(event => {
          const eventStart = new Date(event.start?.dateTime || event.start?.date);
          return eventStart.getHours() === targetHour;
        });
        
        response += `\n🎯 EVENTOS A LAS ${clientData.time}:\n`;
        if (candidateEvents.length > 0) {
          candidateEvents.forEach((event, index) => {
            response += `   ${index + 1}. "${event.summary}"\n`;
          });
          response += `\n✅ RESULTADO: Se puede eliminar el evento\n`;
        } else {
          response += `   ❌ No hay eventos a las ${clientData.time}\n`;
          response += `\n❌ RESULTADO: No se encontró evento para eliminar\n`;
        }
      } else {
        response += `❌ PASO 3: No hay eventos en la fecha ${clientData.date}\n`;
        response += `   - El calendario podría estar vacío\n`;
        response += `   - Verifica el Calendar ID\n`;
        response += `   - Verifica los permisos de la cuenta de servicio\n`;
      }
      
    } catch (error) {
      response += `❌ PASO 3: Error consultando Google Calendar: ${error.message}\n`;
    }
    
    return res.json({ respuesta: response });
    
  } catch (error) {
    console.error('Error en debug:', error.message);
    return res.json({ respuesta: `❌ Error general en debug: ${error.message}` });
  }
});

/**
 * ENDPOINT: Ver todos los eventos de una fecha específica
 */
app.get('/api/eventos/:fecha', async (req, res) => {
  try {
    const fecha = req.params.fecha; // formato: YYYY-MM-DD
    console.log(`📅 Consultando eventos del ${fecha}`);
    
    // Obtener calendar ID
    let configData;
    try {
      configData = await getConfigData();
    } catch (error) {
      return res.json({ respuesta: `❌ Error obteniendo configuración: ${error.message}` });
    }
    
    const calendarId = findData('1', configData.calendars, 0, 1);
    console.log(`📅 Calendar ID: ${calendarId}`);
    
    // Consultar eventos
    const calendar = await getCalendarInstance();
    const startOfDay = new Date(fecha + 'T00:00:00');
    const endOfDay = new Date(fecha + 'T23:59:59');
    
    const response = await calendar.events.list({
      calendarId: calendarId,
      timeMin: startOfDay.toISOString(),
      timeMax: endOfDay.toISOString(),
      singleEvents: true,
      orderBy: 'startTime'
    });
    
    const events = response.data.items || [];
    
    let resultado = `📅 EVENTOS DEL ${fecha}\n`;
    resultado += `📊 Calendar: ${calendarId.substring(0, 30)}...\n`;
    resultado += `🔢 Total eventos: ${events.length}\n\n`;
    
    if (events.length > 0) {
      resultado += `📋 LISTA DE EVENTOS:\n`;
      events.forEach((event, index) => {
        const eventStart = new Date(event.start?.dateTime || event.start?.date);
        const hora = eventStart.getHours().toString().padStart(2, '0');
        const minuto = eventStart.getMinutes().toString().padStart(2, '0');
        const horaStr = `${hora}:${minuto}`;
        
        resultado += `\n${index + 1}. ${horaStr} - "${event.summary}"\n`;
        resultado += `   ID: ${event.id.substring(0, 20)}...\n`;
        resultado += `   Creador: ${event.creator?.email || 'Desconocido'}\n`;
        if (event.description) {
          resultado += `   Desc: ${event.description.substring(0, 50)}...\n`;
        }
      });
      
      // Buscar específicamente eventos a las 18:00
      const eventosA18 = events.filter(event => {
        const eventStart = new Date(event.start?.dateTime || event.start?.date);
        return eventStart.getHours() === 18;
      });
      
      resultado += `\n🎯 EVENTOS A LAS 18:00: ${eventosA18.length}\n`;
      eventosA18.forEach(event => {
        resultado += `   - "${event.summary}"\n`;
      });
      
    } else {
      resultado += `❌ NO HAY EVENTOS en esta fecha\n`;
      resultado += `\nPosibles causas:\n`;
      resultado += `- El Calendar ID no es correcto\n`;
      resultado += `- Los permisos no permiten ver eventos\n`;
      resultado += `- No hay eventos creados en esta fecha\n`;
    }
    
    // Formatear respuesta con datos estructurados también
    const eventosFormateados = events.map(event => ({
      id: event.id,
      summary: event.summary,
      start: event.start?.dateTime || event.start?.date,
      end: event.end?.dateTime || event.end?.date,
      creator: event.creator?.email
    }));
    
    return res.json({ 
      respuesta: resultado,
      eventos: eventosFormateados,
      total: events.length,
      fecha: fecha,
      calendarId: calendarId
    });
    
  } catch (error) {
    console.error('Error consultando eventos:', error.message);
    return res.json({ respuesta: `❌ Error: ${error.message}` });
  }
});

/**
 * ENDPOINT 3: CargaDatosIniciales (GET)
 * Obtiene la fecha/hora actual y datos del cliente si existe
 * @param {string} celular - Número de celular del cliente (obligatorio)
 */
app.get('/api/carga-datos-iniciales', async (req, res) => {
  try {
    console.log('📋 === CARGA DATOS INICIALES ===');
    
    const { celular } = req.query;
    
    // Validar parámetro obligatorio
    if (!celular) {
      return res.status(400).json({
        error: 'Parámetro "celular" es obligatorio',
        ejemplo: '/api/carga-datos-iniciales?celular=5551234567'
      });
    }

    console.log(`📞 Celular recibido: ${celular}`);
    const celularNormalizado = normalizePhone(celular);

    // Obtener fecha y hora actual (funcionalidad original)
    const now = moment().tz(config.timezone.default);
    
    // Buscar cliente por celular
    let clienteData = await getClienteByCelular(celular);

    // Fallback: si no se encuentra por clientes, buscar por historial de citas
    if (!clienteData.existe) {
      try {
        const pacientesEncontrados = await consultaDatosPacientePorTelefono(celular);
        if (pacientesEncontrados && pacientesEncontrados.length > 0) {
          const pacienteMasReciente = pacientesEncontrados[0];
          const nombreCompleto = pacienteMasReciente.nombreCompleto || '';
          const primerNombre = nombreCompleto.split(' ')[0] || nombreCompleto;
          const telefonoNormalizado = normalizePhone(pacienteMasReciente.telefono || celular) || celularNormalizado || pacienteMasReciente.telefono;
          clienteData = {
            existe: true,
            nombreCompleto: nombreCompleto,
            primerNombre: primerNombre,
            celular: telefonoNormalizado,
            correo: pacienteMasReciente.correoElectronico
          };
          console.log('✅ Cliente encontrado por historial de citas');
        }
      } catch (error) {
        console.log('⚠️ No se pudo usar fallback de historial de citas:', error.message);
      }
    }

    // Fallback final: usar caché en memoria si existe
    if (!clienteData.existe) {
      const cachedInfo = getPatientInfo(celular);
      if (cachedInfo && cachedInfo.name) {
        clienteData = {
          existe: true,
          nombreCompleto: cachedInfo.name,
          primerNombre: cachedInfo.name.split(' ')[0] || cachedInfo.name,
          celular: normalizePhone(celular) || celularNormalizado || celular,
          correo: cachedInfo.email || null
        };
        console.log('✅ Cliente encontrado en caché');
      }
    }
    
    // Construir informacionClientePrompt
    let informacionClientePrompt = null;
    
    const nombreDisponible = (clienteData.primerNombre || clienteData.nombreCompleto || '').trim();
    const esClienteConNombre = clienteData.existe && nombreDisponible.length > 0;

    if (esClienteConNombre) {
      const telefonoParaPrompt = normalizePhone(clienteData.celular) || celularNormalizado || clienteData.celular;
      const nombreCompletoParaPrompt = clienteData.nombreCompleto || clienteData.primerNombre;
      const nombreParaSaludo = clienteData.primerNombre || clienteData.nombreCompleto;
      const correoParaPrompt = clienteData.correo;
      informacionClientePrompt = [
        ' INFORMACION CRITICA A CONSIDERAR:',
        '### **Saludo Inicial y Menu Principal (Personalizado)**',
        '',
        '**MENSAJE DE BIENVENIDA, ES ALTAMENTE IMPORTANTE REALIZAR ESTE DETALLE PARA QUE EL PACIENTE SE SIENTA ACOJIDO:**',
        '',
        `**OBLIGATORIO:** El primer mensaje DEBE ser exactamente:`,
        `"¡Hola, ${nombreParaSaludo}! 👋 Que gusto volver a verte de nuevo por acá 😊`,
        '',
        `**NUNCA usar:** "¡Hola! 👋 Soy Valeria Gopar..." o cualquier saludo genérico.`,
        `**SIEMPRE usar:** El nombre "${nombreParaSaludo}" en el saludo.`,
        '',
        '¿Que necesitas? Te puedo ayudar con:',
        '',
        '📅 1️⃣ **Consultar calendario** - Ver disponibilidad en calendario  ',
        '➕ 2️⃣ **Agendar cita** - Programar una nueva cita  ',
        '❌ 3️⃣ **Cancelar cita** - Cancelar alguna cita  ',
        '💰 4️⃣ **Ver precios** - Conocer nuestros paquetes  ',
        '📍 5️⃣ **Ubicacion** - Saber donde estamos  ',
        '📱 6️⃣ **Contacto** - Telefonos y redes sociales  ',
        '🕒 7️⃣ **Horarios** - Nuestros horarios de atencion',
        '👩‍⚕️ 8️⃣ **Especialidades** - En que nos especializamos',
        '🏥 9️⃣ **Padecimientos** - Que condiciones tratamos',
        '💡 10⃣  **Info Tratamientos** - Detalles sobre las terapias',
        '',
        'Solo escribe el numero de lo que necesitas o cuentame directamente que quieres hacer 👍"',
        '',
        'Si no entiende la solicitud:  ',
        `"¡Hola, ${nombreParaSaludo}! 😄 `,
        '',
        'No logre entender bien lo que necesitas. ¿Me puedes decir que quieres hacer? Por ejemplo:',
        '',
        '📅 1️⃣ **Consultar calendario**  ',
        '➕ 2️⃣ **Agendar cita**  ',
        '❌ 3️⃣ **Cancelar cita**  ',
        '💰 4️⃣ **Ver precios**  ',
        '📍 5️⃣ **Ubicacion**  ',
        '📱 6️⃣ **Contacto**  ',
        '🕒 7️⃣ **Horarios**',
        '👩‍⚕️ 8️⃣ **Especialidades**',
        '🏥 9️⃣ **Padecimientos**',
        '💡 10⃣  **Info Tratamientos**',
        '',
        'Puedes escribir el numero o contarme directamente que necesitas"',
        '',
        '— CLIENTE EXISTENTE',
        '(NO debe pedir nombre ni correo)',
        '',
        '🗓️ PROCESO DE AGENDAMIENTO — CLIENTE EXISTENTE',
        '',
        '🚨 REGLA ABSOLUTA',
        'En este modo:',
        'El backend ya cargó:',
        '✅ nombre',
        '✅ email',
        'Está PROHIBIDO pedir nuevamente estos datos.',
        'Se debe confiar 100% en los datos precargados por la API alterna.',
        'Si existen variables precargadas, usarlas directamente sin validación adicional.',
        '',
        '📋 DATOS NECESARIOS',
        '',
        'Antes de ejecutar AGREGAR_AGENDA deben existir:',
        '✅ calendar = 1',
        '✅ service',
        '✅ fecha',
        '✅ hora',
        `✅ nombre (precargado: ${nombreCompletoParaPrompt})`,
        `✅ email (precargado: ${correoParaPrompt})`,
        'Si nombre y email ya están presentes, NO preguntar nada adicional.',
        '',
        '🔎 FLUJO OBLIGATORIO',
        '1️⃣ Mostrar disponibilidad (CONSULTA_AGENDA).',
        '2️⃣ Usuario selecciona horario.',
        '3️⃣ Confirmar selección:',
        '"¡Perfecto! Elegiste las 10:00 AM del jueves 19 de febrero 👍"',
        '4️⃣ Generar resumen directamente SIN pedir datos.',
        '',
        '🧾 RESUMEN OBLIGATORIO',
        '"✨ Confirma tu cita por favor:',
        '',
        `👤 Nombre: ${nombreCompletoParaPrompt}`,
        `📧 Correo: ${correoParaPrompt}`,
        '📅 Fecha: jueves 19 de febrero de 2026',
        '🕐 Hora: 10:00 AM',
        '👩‍⚕️ Especialista: Lic. Iris Valeria Gopar',
        '📋 Servicio: Consulta presencial',
        '',
        '¿Todo correcto? Escribe "sí" para confirmar o "no" para ajustar algo."',
        '',
        'Aceptar como confirmación afirmativa:',
        'sí, si, ok, listo, perfecto, correcto, confirmo, dale',
        '',
        '🚀 EJECUCIÓN FINAL',
        'Después de confirmación enviar inmediatamente:',
        '',
        'AGREGAR_AGENDA_INTELIGENTE',
        '{',
        '  "action": "schedule",',
        '  "calendar": 1,',
        '  "service": [CODIGO_SERVICIO],',
        '  "serviceName": "[NOMBRE_SERVICIO]",',
        '  "date": "[YYYY-MM-DD]",',
        '  "time": "[HH:MM]",',
        `  "clientName": "${nombreCompletoParaPrompt}",`,
        `  "clientEmail": "${correoParaPrompt}",`,
        `  "clientPhone": "${telefonoParaPrompt}"`,
        '}',
        '',
        '🚨 Usar exactamente los datos precargados por backend. NO cambiar los nombres de los campos.'
      ].join('\n');
      console.log(`✅ informacionClientePrompt: ${informacionClientePrompt}`);
    } else {
      // Cliente no existe - flujo normal (bienvenida + agendar)
      informacionClientePrompt = [
        ' INFORMACION CRITICA A CONSIDERAR:',
        '### **Saludo Inicial y Menú Principal**',
        '',
        '**MENSAJE DE BIENVENIDA:**',
        '"¡Hey! 👋 Soy Valeria Gopar de Clínica ValGop. Me da mucho gusto poder ayudarte hoy 😊',
        '',
        '¿Qué necesitas? Te puedo ayudar con:',
        '',
        '📅 1️⃣ **Consultar calendario** - Ver disponibilidad en calendario  ',
        '➕ 2️⃣ **Agendar cita** - Programar una nueva cita  ',
        '❌ 3️⃣ **Cancelar cita** - Cancelar alguna cita  ',
        '💰 4️⃣ **Ver precios** - Conocer nuestros paquetes  ',
        '📍 5️⃣ **Ubicación** - Saber dónde estamos  ',
        '📱 6️⃣ **Contacto** - Teléfonos y redes sociales  ',
        '🕒 7️⃣ **Horarios** - Nuestros horarios de atención',
        '👩‍⚕️ 8️⃣ **Especialidades** - En qué nos especializamos',
        '🏥 9️⃣ **Padecimientos** - Qué condiciones tratamos',
        '💡 10⃣  **Info Tratamientos** - Detalles sobre las terapias',
        '',
        'Solo escribe el número de lo que necesitas o cuéntame directamente qué quieres hacer 👍"',
        '',
        'Si no entiende la solicitud:  ',
        '"¡Hola! Soy Valeria Gopar de Clínica ValGop 😄 ',
        '',
        'No logré entender bien lo que necesitas. ¿Me puedes decir qué quieres hacer? Por ejemplo:',
        '',
        '📅 1️⃣ **Consultar calendario**  ',
        '➕ 2️⃣ **Agendar cita**  ',
        '❌ 3️⃣ **Cancelar cita**  ',
        '💰 4️⃣ **Ver precios**  ',
        '📍 5️⃣ **Ubicación**  ',
        '📱 6️⃣ **Contacto**  ',
        '🕒 7️⃣ **Horarios**',
        '👩‍⚕️ 8️⃣ **Especialidades**',
        '🏥 9️⃣ **Padecimientos**',
        '💡 10⃣  **Info Tratamientos**',
        '',
        'Puedes escribir el número o contarme directamente qué necesitas"',
        '',
        '### **➕ Proceso para Agendar una Cita (Opción 2️⃣) - Cliente Nuevo**',
        '',
        '**ORDEN OBLIGATORIO:** Servicio → Consulta automática multi-día → Selección de hora → Verificación de cliente → Email → Confirmación → Agendar',
        '**NOTA INTERNA**: Especialista siempre es Lic. Iris Valeria Gopar (calendar=1) - no preguntar.',
        '',
        '1. **ESPECIALISTA**: NUNCA preguntar. Siempre asumir Lic. Iris Valeria Gopar.',
        '2. Si menciona fecha específica: Guardar fecha y continuar con servicio. Si NO menciona fecha: Consultar automáticamente próximos 4 días hábiles.',
        '   - Si además menciona HORA específica, SIEMPRE consultar disponibilidad para esa fecha y validar que la hora esté en la lista.',
        '   - Si la hora NO está disponible: responder "Ese horario está ocupado" y pedir que elija otra hora o día. NO confirmar.',
        '3. Si falta servicio: "¿Qué servicio requieres? 📅',
        '',
        '1️⃣ **Consulta presencial**',
        '2️⃣ **Consulta en linea**"',
        '',
        '4. **CONSULTA AUTOMÁTICA MULTI-DÍA OBLIGATORIA DESPUÉS DE SERVICIO:**',
        '   - Si NO especificó fecha: ⏳ Consultando disponibilidad para los próximos días...',
        '   - Si especificó fecha: ⏳ Consultando disponibilidad para [FECHA ESPECÍFICA]...',
        '',
        '5. **SELECCIÓN DE HORA POR LETRA:** Usuario elige letra (A, B, C...) → Confirmar hora y fecha.',
        '   - Si el usuario escribe una hora en texto (ej: "lunes a las 10") en lugar de letra:',
        '     - Solo aceptar si esa hora aparece EXACTAMENTE en la lista mostrada para ese día.',
        '     - Si NO aparece: responder "Ese horario está ocupado", mostrar horarios disponibles y pedir que elija otra hora o día.',
        '     - NO confirmar ni avanzar si no coincide con la lista.',
        '6. **VERIFICACIÓN AUTOMÁTICA DE CLIENTE:** Llamar a `/api/verificar-cliente-seleccion-hora` con teléfono, hora, fecha y servicio.',
        '   - Mostrar el mensaje del endpoint (pide nombre si es nuevo).',
        '7. **PASO OBLIGATORIO - EMAIL:** "¿Cuál es tu email? 📧 (Necesario para enviarte la confirmación de tu cita)"',
        '   - Validar formato con @ y .; si es inválido, volver a pedir.',
        '8. **Confirmación final:**',
        '"¡Excelente! 🎉 Antes de agendar, confirmemos:',
        '',
        '📅 **Fecha**: [fecha natural con día de la semana]  ',
        '🕐 **Hora**: [hora en formato 12h]  ',
        '👩‍⚕️ **Especialista**: Lic. Iris Valeria Gopar  ',
        '📅 **Servicio**: [Servicio SIN emoji] - $800  ',
        '👤 **Nombre**: [Nombre del cliente]  ',
        '📧 **Email**: [Email del cliente VALIDADO]  ',
        '📱 **Teléfono**: [Extraído automáticamente de {from}]',
        '',
        "¿Está todo perfecto? Escribe 'sí' para agendar o 'no' para ajustar algo\"",
        '',
        '### **Construcción de JSON (Cliente Nuevo)**',
        '**Enviar EXACTAMENTE (sin placeholders, usando los datos reales):**',
        '```',
        'AGREGAR_AGENDA_INTELIGENTE',
        '{',
        '  "action": "schedule",',
        '  "calendar": 1,',
        '  "service": [CODIGO_SERVICIO],',
        '  "serviceName": "[NOMBRE_SERVICIO]",',
        '  "date": "[YYYY-MM-DD]",',
        '  "time": "[HH:MM]",',
        '  "clientName": "NOMBRE_REAL_DEL_CLIENTE",',
        '  "clientEmail": "EMAIL_REAL_DEL_CLIENTE",',
        '  "clientPhone": "{from}"',
        '}',
        '```'
      ].join('\n');
      console.log(`⚠️ Cliente no encontrado - informacionClientePrompt: ${informacionClientePrompt}`);
    }

    const nombreSaludo = esClienteConNombre ? (clienteData.primerNombre || clienteData.nombreCompleto) : null;
    const mensajeBienvenida = nombreSaludo
      ? `¡Hola, ${nombreSaludo}! 👋 Que gusto volver a verte de nuevo por acá 😊

¿Qué necesitas? Te puedo ayudar con:

📅 1️⃣ *Consultar calendario* - Ver disponibilidad en calendario  
➕ 2️⃣ *Agendar cita* - Programar una nueva cita  
❌ 3️⃣ *Cancelar cita* - Cancelar alguna cita  
💰 4️⃣ *Ver precios* - Conocer nuestros paquetes  
📍 5️⃣ *Ubicación* - Saber dónde estamos  
📱 6️⃣ *Contacto* - Teléfonos y redes sociales  
🕒 7️⃣ *Horarios* - Nuestros horarios de atención  
👩‍⚕️ 8️⃣ *Especialidades* - En qué nos especializamos  
🏥 9️⃣ *Padecimientos* - Qué condiciones tratamos  
💡 10⃣ *Info Tratamientos* - Detalles sobre las terapias  

Solo escribe el número de lo que necesitas o cuéntame directamente qué quieres hacer 👍`
      : `¡Hola! 👋 Me da mucho gusto poder ayudarte hoy 😊

¿Qué necesitas? Te puedo ayudar con:

📅 1️⃣ *Consultar calendario* - Ver disponibilidad en calendario  
➕ 2️⃣ *Agendar cita* - Programar una nueva cita  
❌ 3️⃣ *Cancelar cita* - Cancelar alguna cita  
💰 4️⃣ *Ver precios* - Conocer nuestros paquetes  
📍 5️⃣ *Ubicación* - Saber dónde estamos  
📱 6️⃣ *Contacto* - Teléfonos y redes sociales  
🕒 7️⃣ *Horarios* - Nuestros horarios de atención  
👩‍⚕️ 8️⃣ *Especialidades* - En qué nos especializamos  
🏥 9️⃣ *Padecimientos* - Qué condiciones tratamos  
💡 10⃣ *Info Tratamientos* - Detalles sobre las terapias  

Solo escribe el número de lo que necesitas o cuéntame directamente qué quieres hacer 👍`;

    const response = {
      // Datos originales de fecha/hora
      fechaHora: now.format('dddd, DD [de] MMMM [de] YYYY, HH:mm:ss [GMT]Z'),
      timestamp: now.valueOf(),
      isoString: now.toISOString(),
      // Nuevo: información del cliente para prompt
      informacionClientePrompt: informacionClientePrompt,
      mensajeBienvenida: mensajeBienvenida,
      // Atajos para prompts dinámicos (mismo nombre que en secciones-dinamicas)
      patientName: clienteData.existe ? (clienteData.primerNombre || clienteData.nombreCompleto) : null,
      patientEmail: clienteData.existe ? clienteData.correo : null,
      patientPhone: clienteData.existe ? (normalizePhone(clienteData.celular) || celularNormalizado || clienteData.celular) : (celularNormalizado || null),
      // Metadata del cliente (para uso interno si se necesita)
      clienteExiste: clienteData.existe,
      datosCliente: clienteData.existe ? {
        nombreCompleto: clienteData.nombreCompleto,
        primerNombre: clienteData.primerNombre,
        correo: clienteData.correo,
        celular: normalizePhone(clienteData.celular) || celularNormalizado || clienteData.celular
      } : null
    };
    
    console.log('✅ Fecha actual:', response.fechaHora);
    console.log('✅ Cliente existe:', response.clienteExiste);
    return res.json(response);
    
  } catch (error) {
    console.error('❌ Error en carga datos iniciales:', error);
    console.error('❌ Stack:', error.stack);
    return res.status(500).json({ 
      error: 'Error al cargar datos iniciales',
      detalle: error.message || error.toString() || 'Error desconocido',
      stack: process.env.NODE_ENV !== 'production' ? error.stack : undefined
    });
  }
});

/**
 * ENDPOINT: Reconocer cliente (reconocimiento silencioso)
 * Verifica si un teléfono existe en la base de datos sin revelar el proceso
 */
app.post('/api/reconocer-cliente', async (req, res) => {
  try {
    console.log('🔍 === RECONOCIMIENTO SILENCIOSO DE CLIENTE ===');
    console.log('Body recibido:', JSON.stringify(req.body, null, 2));

    const { telefono } = req.body;

    if (!telefono) {
      return res.json({
        success: false,
        existeCliente: false,
        datosCliente: null,
        error: 'Teléfono no proporcionado'
      });
    }

    console.log(`📞 Buscando cliente con teléfono: ${telefono}`);

    // Buscar en PostgreSQL (la función ya normaliza el número)
    const pacientesEncontrados = await consultaDatosPacientePorTelefono(telefono);
    
    console.log(`✅ Resultados encontrados: ${pacientesEncontrados.length}`);

    if (pacientesEncontrados && pacientesEncontrados.length > 0) {
      const pacienteMasReciente = pacientesEncontrados[0];
      const telefonoNormalizado = normalizePhone(pacienteMasReciente.telefono || telefono);
      
      console.log('✅ Cliente existente reconocido silenciosamente');
      console.log(`   - Nombre: ${pacienteMasReciente.nombreCompleto}`);
      console.log(`   - Email: ${pacienteMasReciente.correoElectronico}`);
      console.log(`   - Teléfono normalizado: ${telefonoNormalizado}`);
      
      // Guardar en caché para uso futuro
      savePatientInfo(telefonoNormalizado || telefono, pacienteMasReciente.nombreCompleto, pacienteMasReciente.correoElectronico);
      
      return res.json({
        success: true,
        existeCliente: true,
        datosCliente: {
          nombreCompleto: pacienteMasReciente.nombreCompleto,
          correoElectronico: pacienteMasReciente.correoElectronico,
          telefono: telefonoNormalizado || pacienteMasReciente.telefono || telefono
        }
      });
    } else {
      console.log('⚠️ Cliente nuevo no encontrado en la base de datos');
      
      return res.json({
        success: true,
        existeCliente: false,
        datosCliente: null
      });
    }

  } catch (error) {
    console.error('❌ Error en reconocimiento de cliente:', error.message);
    return res.json({
      success: false,
      existeCliente: false,
      datosCliente: null,
      error: error.message
    });
  }
});

/**
 * ENDPOINT: Verificar cliente recurrente
 */
app.post('/api/verificar-cliente', async (req, res) => {
  try {
    console.log('🔍 === VERIFICACIÓN DE CLIENTE RECURRENTE ===');
    console.log('Body recibido:', JSON.stringify(req.body, null, 2));

    const { telefono } = req.body;

    if (!telefono) {
      return res.json({
        success: false,
        error: 'Teléfono no proporcionado',
        pacientes: []
      });
    }

    console.log(`📞 Buscando cliente con teléfono: ${telefono}`);

    // Buscar en PostgreSQL (la función ya normaliza el número)
    const pacientesEncontrados = await consultaDatosPacientePorTelefono(telefono);
    
    console.log(`✅ Resultados encontrados: ${pacientesEncontrados.length}`);

    return res.json({
      success: true,
      pacientes: pacientesEncontrados,
      cantidad: pacientesEncontrados.length
    });

  } catch (error) {
    console.error('❌ Error verificando cliente:', error.message);
    return res.json({
      success: false,
      error: error.message,
      pacientes: []
    });
  }
});

/**
 * ENDPOINT GET: Verificar que el endpoint está disponible
 */
app.get('/api/verificar-cliente-seleccion-hora', (req, res) => {
  return res.json({
    success: true,
    message: 'Endpoint disponible. Usa POST para verificar cliente.',
    metodo: 'POST',
    ejemplo: {
      telefono: '+5214495847679',
      horaSeleccionada: '10:00 AM',
      fechaSeleccionada: 'lunes 25 de enero',
      servicio: 'Consulta presencial'
    }
  });
});

/**
 * ENDPOINT: Verificar cliente después de seleccionar hora
 * Detecta si es recurrente o nuevo y genera el mensaje apropiado
 */
app.post('/api/verificar-cliente-seleccion-hora', async (req, res) => {
  try {
    console.log('🔍 === VERIFICACIÓN DE CLIENTE DESPUÉS DE SELECCIÓN DE HORA ===');
    console.log('Body recibido:', JSON.stringify(req.body, null, 2));

    const { telefono, horaSeleccionada, fechaSeleccionada, servicio } = req.body;

    if (!telefono) {
      return res.json({
        success: false,
        error: 'Teléfono no proporcionado',
        tipoCliente: 'desconocido'
      });
    }

    console.log(`📞 Buscando cliente con teléfono: ${telefono}`);
    console.log(`⏰ Hora seleccionada: ${horaSeleccionada}`);
    console.log(`📅 Fecha seleccionada: ${fechaSeleccionada}`);

    // VALIDACIÓN CRÍTICA: Prohibir horarios fuera de atención
    const parsedTime = parseTimeTo24Hour(horaSeleccionada);
    const parsedDate = parseSpanishDateToMoment(fechaSeleccionada);
    const calendarNumber = '1';

    const businessHours = parsedDate ? getBusinessHoursForDay(parsedDate.day()) : null;
    const isWithinBusinessHours = parsedTime &&
      parsedTime.minute === 0 &&
      businessHours &&
      parsedTime.hour >= businessHours.start &&
      parsedTime.hour <= businessHours.end;

    if (!parsedTime || !parsedDate) {
      return res.json({
        success: false,
        tipoCliente: 'horario_invalido',
        mensaje: '🚫 No pude validar la fecha u hora seleccionada. Por favor elige una opción disponible del listado.'
      });
    }

    if (!isWithinBusinessHours) {
      let configData;
      try {
        configData = await getConfigData();
      } catch (error) {
        console.log('⚠️ No se pudo obtener configuración para recomendaciones:', error.message);
      }

      const serviceNumber = configData
        ? (findServiceNumberByName(servicio, configData.services) || '1')
        : null;

      const outOfHoursMessage = await buildOutOfHoursMessage(
        parsedDate,
        calendarNumber,
        serviceNumber,
        configData
      );

      return res.json({
        success: false,
        tipoCliente: 'fuera_horario',
        mensaje: outOfHoursMessage
      });
    }

    // VALIDACIÓN CRÍTICA: Verificar disponibilidad real del horario seleccionado
    let configData;
    try {
      configData = await getConfigData();
    } catch (error) {
      console.log('⚠️ No se pudo obtener configuración para validar disponibilidad:', error.message);
    }

    if (configData) {
      const calendarId = findData(calendarNumber, configData.calendars, 0, 1);
      const serviceNumber = findServiceNumberByName(servicio, configData.services) || 1;
      const serviceDuration = findData(serviceNumber, configData.services, 0, 1);
      const isSaturday = parsedDate.day() === 6;
      const workingHours = {
        start: businessHours.start,
        end: businessHours.end,
        hasLunch: !isSaturday,
        lunchStart: config.workingHours.lunchStartHour || 14,
        lunchEnd: config.workingHours.lunchEndHour || 15
      };

      if (calendarId && serviceDuration) {
        const availableSlots = await findAvailableSlots(
          calendarId,
          parsedDate.toDate(),
          parseInt(serviceDuration, 10),
          workingHours
        );
        const requestedSlot = `${parsedTime.hour.toString().padStart(2, '0')}:${parsedTime.minute.toString().padStart(2, '0')}`;
        const slotList = Array.isArray(availableSlots) ? availableSlots : [];
        if (!slotList.includes(requestedSlot)) {
          let suggestion = '\n\n🔍 Te recomiendo elegir otra fecha u horario disponible.';
          if (slotList.length === 0) {
            const alternativeDays = await findAlternativeDaysWithAvailability(
              parsedDate,
              calendarNumber,
              serviceNumber,
              configData
            );
            if (alternativeDays.length > 0) {
              suggestion = '\n\n📅 Fechas disponibles recomendadas:\n';
              alternativeDays.forEach((day) => {
                const dayLabel = formatDateToSpanishPremium(day.date);
                const times = (day.slots || []).map((slot) => formatTimeTo12Hour(slot)).join(', ');
                suggestion += `• ${dayLabel}: ${times}\n`;
              });
              suggestion = suggestion.trim();
            }
          }
          const slotsLabel = slotList.length > 0
            ? `Horarios disponibles ese día: ${formatSlotsShort(slotList)}.`
            : 'No hay horarios disponibles ese día.';
          return res.json({
            success: false,
            tipoCliente: 'horario_no_disponible',
            mensaje: `🚫 Ese horario no está disponible.\n\n${slotsLabel}${suggestion}`
          });
        }
      }
    }

    // Buscar en PostgreSQL
    const pacientesEncontrados = await consultaDatosPacientePorTelefono(telefono);
    
    console.log(`✅ Resultados encontrados: ${pacientesEncontrados.length}`);

    if (pacientesEncontrados && pacientesEncontrados.length > 0) {
      const pacienteMasReciente = pacientesEncontrados[0];
      const telefonoNormalizado = normalizePhone(pacienteMasReciente.telefono || telefono);
      const nombreCompleto = (pacienteMasReciente.nombreCompleto || '').trim();
      const saludoNombre = nombreCompleto.length > 0 ? `, ${nombreCompleto}` : '';

      console.log('✅ Cliente recurrente detectado');

      const mensajeExistente = `¡Perfecto${saludoNombre}! Ya tengo tus datos 😊

📅 Fecha: ${fechaSeleccionada}
⏰ Hora: ${horaSeleccionada}
🩺 Servicio: ${servicio}

¿Está todo perfecto? Escribe "sí" para agendar o "no" para ajustar algo.`;

      return res.json({
        success: true,
        tipoCliente: 'existente',
        datosCliente: {
          nombreCompleto: pacienteMasReciente.nombreCompleto,
          correoElectronico: pacienteMasReciente.correoElectronico,
          telefono: telefonoNormalizado || pacienteMasReciente.telefono || telefono
        },
        mensaje: mensajeExistente,
        requiereDatosAdicionales: false
      });
    }

    console.log('⚠️ Cliente nuevo detectado');

    // Cliente nuevo: pedir nombre
    const mensajeNuevo = `¡Perfecto! Elegiste las ${horaSeleccionada} del ${fechaSeleccionada} 👍

¿Me puedes decir tu nombre para la reserva? 😊`;

    return res.json({
      success: true,
      tipoCliente: 'nuevo',
      datosCliente: null,
      mensaje: mensajeNuevo,
      requiereDatosAdicionales: true
    });

  } catch (error) {
    console.error('❌ Error en verificación de cliente:', error.message);
    return res.json({
      success: false,
      error: error.message,
      tipoCliente: 'desconocido',
      mensaje: 'Ocurrió un error al verificar tus datos. Por favor, proporciona tu nombre para continuar 😊'
    });
  }
});

/**
 * ENDPOINT: Agendar cita con reconocimiento inteligente
 * Reconoce clientes existentes y no pide datos que ya tiene
 */
app.post('/api/agenda-cita-inteligente', async (req, res) => {
  try {
    console.log('📝 === INICIO AGENDAMIENTO INTELIGENTE ===');
    console.log('Body recibido:', JSON.stringify(req.body, null, 2));
    console.log('Timestamp:', new Date().toISOString());

    const { 
      action, 
      calendar: calendarNumber, 
      service: serviceNumber, 
      serviceName: serviceNameFromBot, 
      date, 
      time, 
      clientPhone: clientPhoneFromRequest,
      clientName: clientNameFromRequest,
      clientEmail: clientEmailFromRequest
    } = req.body;

    // PASO 0: RECONOCIMIENTO INTELIGENTE DEL CLIENTE
    let clientName = clientNameFromRequest;
    let clientEmail = clientEmailFromRequest;
    let clientPhone = clientPhoneFromRequest;
    let esClienteExistente = false;
    
    if (clientPhone && clientPhone !== 'Sin Teléfono') {
      const normalizedPhone = normalizePhone(clientPhone);
      if (normalizedPhone) {
        clientPhone = normalizedPhone;
      }

      console.log('🔍 === RECONOCIENDO CLIENTE ===');
      
      try {
        const pacientesEncontrados = await consultaDatosPacientePorTelefono(clientPhone);
        
        if (pacientesEncontrados && pacientesEncontrados.length > 0) {
          const pacienteMasReciente = pacientesEncontrados[0];
          esClienteExistente = true;
          
          console.log('✅ Cliente existente reconocido');
          console.log(`   - Nombre: ${pacienteMasReciente.nombreCompleto}`);
          console.log(`   - Email: ${pacienteMasReciente.correoElectronico}`);
          
          // Usar datos existentes si no se proporcionaron nuevos
          if (!clientName || clientName === '') {
            clientName = pacienteMasReciente.nombreCompleto;
            console.log('   → Usando nombre existente');
          }
          
          if (!clientEmail || clientEmail === 'Sin Email' || clientEmail === '') {
            clientEmail = pacienteMasReciente.correoElectronico;
            console.log('   → Usando email existente');
          }
          
          // Guardar en caché
          savePatientInfo(clientPhone, clientName, clientEmail);
        } else {
          console.log('⚠️ Cliente nuevo, se solicitarán todos los datos');
        }
      } catch (error) {
        console.error('❌ Error en reconocimiento:', error.message);
      }
    }

    // PASO 1: VALIDACIONES BÁSICAS
    if (!action || !calendarNumber || !serviceNumber || !date || !time) {
      return res.json({
        success: false,
        error: 'Faltan datos requeridos para agendar',
        requiresData: !esClienteExistente,
        message: esClienteExistente 
          ? 'Por favor confirma los datos para tu cita'
          : 'Por favor proporciona tu nombre y correo para agendar'
      });
    }

    // PASO 1.5: VALIDAR DATOS DEL CLIENTE
    const missingFields = [];
    const invalidFields = [];

    if (!clientName || clientName === '') {
      missingFields.push('clientName');
    }

    if (!clientEmail || clientEmail === '' || clientEmail === 'Sin Email') {
      missingFields.push('clientEmail');
    } else {
      const emailRegex = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
      if (!emailRegex.test(clientEmail)) {
        invalidFields.push('clientEmail (formato inválido)');
      }
    }

    if (!clientPhone || clientPhone === '' || clientPhone === 'Sin Teléfono') {
      missingFields.push('clientPhone');
    } else if (clientPhone.length < 10) {
      invalidFields.push('clientPhone (muy corto)');
    }

    if (missingFields.length > 0 || invalidFields.length > 0) {
      let errorMessage = '⚠️ Error: Faltan o son inválidos los siguientes datos obligatorios:\n\n';
      missingFields.forEach(field => {
        errorMessage += `❌ ${field}\n`;
      });
      invalidFields.forEach(field => {
        errorMessage += `❌ ${field}\n`;
      });
      errorMessage += '\nEl bot debe recopilar TODOS los datos antes de enviar la solicitud.';
      
      return res.json({
        success: false,
        error: errorMessage,
        missingFields: missingFields,
        invalidFields: invalidFields,
        requiresData: true
      });
    }

    // PASO 2: OBTENER CONFIGURACIÓN (lógica original)
    let configData;
    try {
      configData = await getConfigData();
      console.log('✅ Configuración obtenida correctamente');
    } catch (error) {
      console.error('❌ Error obteniendo configuración:', error.message);
      return res.json({
        success: false,
        error: 'Error obteniendo configuración: ' + error.message,
        requiresData: !esClienteExistente
      });
    }

    console.log('=== BÚSQUEDA EN BASE DE DATOS ===');
    const calendarId = findData(calendarNumber, configData.calendars, 0, 1);
    console.log('calendarId encontrado:', calendarId);
    if (!calendarId) {
      console.log(`❌ ERROR: Calendario no encontrado para número: ${calendarNumber}`);
      return res.json({
        success: false,
        error: 'El calendario solicitado no fue encontrado',
        requiresData: !esClienteExistente
      });
    }

    const profesionalName = findData(calendarNumber, configData.calendars, 0, 2);
    const serviceDuration = findData(serviceNumber, configData.services, 0, 1);

    // Obtener nombre del servicio (lógica original)
    let serviceName = serviceNameFromBot;
    if (!serviceName) {
      const serviceMap = {
        1: 'Consulta de valoración',
        2: 'Cita de seguimiento'
      };
      serviceName = serviceMap[serviceNumber] || 'Servicio Desconocido';
      console.log('⚠️ Bot no envió serviceName, usando mapeo backup:', serviceName);
    } else {
      console.log('✅ Bot envió serviceName:', serviceName);
    }

    if (!serviceDuration) {
      console.log(`❌ ERROR: Servicio no encontrado para número: ${serviceNumber}`);
      return res.json({
        success: false,
        error: 'El servicio solicitado no fue encontrado',
        requiresData: !esClienteExistente
      });
    }

    console.log(`✅ Calendar ID: ${calendarId}, Service Duration: ${serviceDuration} min, Service: ${serviceName}`);

    // PASO 4: VERIFICAR DISPONIBILIDAD DEL HORARIO
    console.log('=== VERIFICANDO DISPONIBILIDAD DEL HORARIO ===');
    
    try {
      // Parsear la fecha y hora para verificar disponibilidad
      const appointmentDateTime = moment.tz(`${date} ${time}`, 'YYYY-MM-DD HH:mm', config.timezone.default);

    if (appointmentDateTime.minute() !== 0) {
      console.log('❌ ERROR: Horario con minutos no permitidos');
      return res.json({
        success: false,
        error: 'Solo se permiten horarios en punto (por ejemplo: 10:00, 11:00, 12:00).',
        requiresData: !esClienteExistente
      });
    }
      
      // Obtener horarios laborales para ese día
      const dayOfWeek = appointmentDateTime.day(); // 0 = Domingo, 1 = Lunes, etc.
    if (dayOfWeek === 0) {
      console.log('🚫 DOMINGO - No hay servicio');
      return res.json({
        success: false,
        error: 'No hay servicio los domingos. Por favor selecciona otro día (Lunes a Sábado).',
        requiresData: !esClienteExistente
      });
    }
      const dayNum = (dayOfWeek === 0) ? 7 : dayOfWeek; // Convertir domingo de 0 a 7
      const workingHours = findWorkingHours(calendarNumber, dayNum, configData.hours);
      
      if (!workingHours) {
        console.log(`❌ ERROR: No hay horarios laborales para el día ${dayNum}`);
        return res.json({
          success: false,
          error: 'No hay horarios laborales para el día seleccionado',
          requiresData: !esClienteExistente
        });
      }

      // Verificar si el horario solicitado está dentro del rango laboral
      const requestedHour = parseInt(time.split(':')[0]);
      if (requestedHour < workingHours.start || requestedHour >= workingHours.end) {
        console.log(`❌ ERROR: Horario solicitado (${requestedHour}) fuera de rango laboral (${workingHours.start}-${workingHours.end})`);
        return res.json({
          success: false,
          error: `El horario solicitado no está dentro del horario laboral (${workingHours.start}:00 - ${workingHours.end}:00)`,
          requiresData: !esClienteExistente
        });
      }

      // Verificar disponibilidad real en Google Calendar
      const availableSlots = await findAvailableSlots(calendarId, appointmentDateTime.toDate(), parseInt(serviceDuration), workingHours);
      
      if (!availableSlots.includes(time)) {
        console.log(`❌ ERROR: Horario ${time} no disponible`);
        console.log(`   Slots disponibles: [${availableSlots.join(', ')}]`);
        return res.json({
          success: false,
          error: `El horario ${time} ya no está disponible. Horarios disponibles: ${availableSlots.join(', ')}`,
          requiresData: !esClienteExistente
        });
      }

      console.log(`✅ Horario ${time} disponible para agendar`);

    } catch (availabilityError) {
      console.error('❌ Error verificando disponibilidad:', availabilityError.message);
      return res.json({
        success: false,
        error: 'Error verificando disponibilidad: ' + availabilityError.message,
        requiresData: !esClienteExistente
      });
    }

    // PASO 5: CREAR EVENTO EN GOOGLE CALENDAR
    console.log('=== CREANDO EVENTO EN GOOGLE CALENDAR ===');
    let eventId;
    let reservationCode;
    
    try {
      // Generar código de reserva único
      reservationCode = generateUniqueReservationCode();
      console.log(`🎟️ Código de reserva generado: ${reservationCode}`);
      
      // Crear evento en Google Calendar
      const eventResult = await createEventOriginal(
        calendarId,
        date,
        time,
        parseInt(serviceDuration),
        clientName,
        clientPhone,
        clientEmail,
        serviceName,
        reservationCode
      );
      
      eventId = eventResult.eventId;
      console.log(`✅ Evento creado en Google Calendar con ID: ${eventId}`);

    } catch (calendarError) {
      console.error('❌ Error creando evento en Google Calendar:', calendarError.message);
      return res.json({
        success: false,
        error: 'Error creando evento en calendario: ' + calendarError.message,
        requiresData: !esClienteExistente
      });
    }

    // PASO 6: GUARDAR EN POSTGRESQL
    console.log('=== GUARDANDO DATOS EN POSTGRESQL ===');
    
    try {
      await saveClientDataOriginal(
        clientName,
        clientPhone,
        clientEmail,
        date,
        time,
        serviceName,
        profesionalName,
        reservationCode,
        eventId,
        calendarId
      );
      console.log('✅ Datos guardados en PostgreSQL');

    } catch (dbError) {
      console.error('❌ Error guardando en PostgreSQL:', dbError.message);
      
      // Intentar eliminar el evento del calendario ya que no se pudo guardar en la base de datos
      try {
        await cancelEventByReservationCodeOriginal(reservationCode, calendarId);
        console.log('🧹 Evento eliminado del calendario debido a fallo en base de datos');
      } catch (rollbackError) {
        console.error('❌ Error eliminando evento del calendario:', rollbackError.message);
      }
      
      return res.json({
        success: false,
        error: 'Error guardando datos: ' + dbError.message,
        requiresData: !esClienteExistente
      });
    }

    // PASO 7: ENVIAR CORREO DE CONFIRMACIÓN
    console.log('=== ENVIANDO CORREO DE CONFIRMACIÓN ===');
    
    try {
      await sendAppointmentConfirmation(
        clientName,
        clientEmail,
        date,
        time,
        serviceName,
        profesionalName,
        reservationCode
      );
      console.log('✅ Correo de confirmación enviado');

    } catch (emailError) {
      console.error('⚠️ Error enviando correo de confirmación:', emailError.message);
      // No fallar el proceso si el correo no se envía
    }

    // PASO 8: RESPUESTA EXITOSA
    console.log('=== CITA AGENDADA EXITOSAMENTE ===');
    
    const time12h = formatTimeTo12Hour(time);
    const dateFormatted = formatDateToSpanishPremium(appointmentDateTime.toDate());
    
    const successMessage = esClienteExistente
      ? `✅ ¡Cita agendada exitosamente! ✈️\n\n📅 Detalles de tu cita:\n• Fecha: ${dateFormatted}\n• Hora: ${time12h}\n• Profesional: ${profesionalName}\n• Servicio: ${serviceName}\n\n🎟️ TU CÓDIGO DE RESERVA ES: ${reservationCode}\n\n¡Gracias por confiar en nosotros! Te esperamos 🌟`
      : `✅ ¡Cita confirmada! ✈️\n\n📅 Detalles de tu cita:\n• Fecha: ${dateFormatted}\n• Hora: ${time12h}\n• Profesional: ${profesionalName}\n• Servicio: ${serviceName}\n\n🎟️ TU CÓDIGO DE RESERVA ES: ${reservationCode}\n\n¡Gracias por confiar en nosotros! 🌟`;

    return res.json({
      success: true,
      respuesta: successMessage,
      id_cita: reservationCode,
      esClienteExistente: esClienteExistente,
      clientName: clientName,
      clientEmail: clientEmail,
      clientPhone: clientPhone,
      fecha: date,
      hora: time12h,
      profesional: profesionalName,
      servicio: serviceName
    });

  } catch (error) {
    console.error('❌ Error en agendamiento inteligente:', error.message);
    return res.json({
      success: false,
      error: error.message,
      requiresData: true
    });
  }
});

/**
 * ENDPOINT: Agendar cita (LÓGICA ORIGINAL)
 * Migrado desde handleSchedule del código de Google Apps Script
 */
app.post('/api/agenda-cita', async (req, res) => {
  try {
    console.log('📝 === INICIO AGENDAMIENTO ORIGINAL ===');
    console.log('Body recibido:', JSON.stringify(req.body, null, 2));
    console.log('Timestamp:', new Date().toISOString());

    const { 
      action, 
      calendar: calendarNumber, 
      service: serviceNumber, 
      serviceName: serviceNameFromBot, 
      date, 
      time, 
      clientName: clientNameFromRequest, 
      clientEmail: clientEmailFromRequest, 
      clientPhone: clientPhoneFromRequest 
    } = req.body;

    // PASO 0: INTENTAR OBTENER INFORMACIÓN DEL PACIENTE DEL CACHÉ O POSTGRESQL
    let clientName = clientNameFromRequest;
    let clientEmail = clientEmailFromRequest;
    let clientPhone = clientPhoneFromRequest;
    
    if (clientPhone && (clientPhone !== 'Sin Teléfono')) {
      const normalizedPhone = normalizePhone(clientPhone);
      if (normalizedPhone) {
        clientPhone = normalizedPhone;
      }

      console.log('🔍 === BUSCANDO INFORMACIÓN DEL PACIENTE ===');
      
      // Primero intentar del caché
      const cachedInfo = getPatientInfo(clientPhone);
      if (cachedInfo) {
        console.log('✅ Información encontrada en caché');
        if (!clientName || clientName === '') {
          clientName = cachedInfo.name || clientName;
          console.log(`   - Nombre actualizado desde caché: ${clientName}`);
        }
        if (!clientEmail || clientEmail === 'Sin Email' || clientEmail === '') {
          clientEmail = cachedInfo.email || clientEmail;
          console.log(`   - Email actualizado desde caché: ${clientEmail}`);
        }
      } else {
        // Si no está en caché, intentar desde PostgreSQL
        console.log('📋 Buscando información en PostgreSQL...');
        try {
          const pacientesEncontrados = await consultaDatosPacientePorTelefono(clientPhone);
          if (pacientesEncontrados && pacientesEncontrados.length > 0) {
            const pacienteMasReciente = pacientesEncontrados[0]; // Ya viene ordenado por más reciente
            console.log('✅ Información encontrada en PostgreSQL');
            if (!clientName || clientName === '') {
              clientName = pacienteMasReciente.nombreCompleto || clientName;
              console.log(`   - Nombre actualizado desde PostgreSQL: ${clientName}`);
            }
            if (!clientEmail || clientEmail === 'Sin Email' || clientEmail === '') {
              clientEmail = pacienteMasReciente.correoElectronico || clientEmail;
              console.log(`   - Email actualizado desde PostgreSQL: ${clientEmail}`);
            }
            // Guardar en caché para próximas consultas
            savePatientInfo(clientPhone, clientName, clientEmail);
          }
        } catch (error) {
          console.log('⚠️ Error buscando en PostgreSQL:', error.message);
        }
      }
    }

    // PASO 1: VALIDACIONES ULTRA-ESTRICTAS (lógica original)
    console.log('=== VALIDACIÓN DE CAMPOS INDIVIDUALES ===');
    console.log(`action: "${action}" (válido: ${action === 'schedule' ? '✅' : '❌'})`);
    console.log(`calendarNumber: "${calendarNumber}" (válido: ${calendarNumber ? '✅' : '❌'})`);
    console.log(`serviceNumber: "${serviceNumber}" (válido: ${serviceNumber ? '✅' : '❌'})`);
    console.log(`date: "${date}" (válido: ${date ? '✅' : '❌'})`);
    console.log(`time: "${time}" (válido: ${time ? '✅' : '❌'})`);
    console.log(`clientName: "${clientName}" (válido: ${clientName ? '✅' : '❌'})`);
    console.log(`clientEmail: "${clientEmail}" (válido: ${clientEmail && clientEmail !== 'Sin Email' ? '✅' : '❌'})`);
    console.log(`clientPhone: "${clientPhone}" (válido: ${clientPhone && clientPhone !== 'Sin Teléfono' ? '✅' : '❌'})`);

    // Validar action
    if (!action || action !== 'schedule') {
      return res.json({ respuesta: '⚠️ Error: Se requiere action: "schedule"' });
    }

    // Validar campos críticos
    const missingFields = [];
    const invalidFields = [];

    if (!calendarNumber || calendarNumber === '') missingFields.push('calendar');
    if (!serviceNumber || serviceNumber === '') missingFields.push('service');
    if (!date || date === '') missingFields.push('date');
    if (!time || time === '') missingFields.push('time');
    if (!clientName || clientName === '') missingFields.push('clientName');

    // Validación de email (lógica original)
    if (!clientEmail || clientEmail === '' || clientEmail === 'Sin Email') {
      missingFields.push('clientEmail');
      console.log('❌ EMAIL FALTANTE: El bot no envió el email del cliente');
    } else {
      const emailRegex = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
      if (!emailRegex.test(clientEmail)) {
        invalidFields.push('clientEmail (formato inválido: ' + clientEmail + ')');
        console.log('❌ EMAIL INVÁLIDO: No cumple con el formato esperado');
      } else {
        console.log('✅ EMAIL VÁLIDO:', clientEmail);
      }
    }

    // Validación de teléfono (lógica original)
    if (!clientPhone || clientPhone === '' || clientPhone === 'Sin Teléfono') {
      missingFields.push('clientPhone');
      console.log('❌ TELÉFONO FALTANTE: El bot no envió el teléfono del cliente');
    } else if (clientPhone.length < 10) {
      invalidFields.push('clientPhone (muy corto: ' + clientPhone + ')');
      console.log('❌ TELÉFONO INVÁLIDO: Muy corto para ser válido');
    } else {
      console.log('✅ TELÉFONO VÁLIDO:', clientPhone);
    }

    // Si hay errores de validación
    if (missingFields.length > 0 || invalidFields.length > 0) {
      console.log('❌ VALIDACIÓN FALLIDA - DETALLES:');
      console.log('   Campos faltantes:', missingFields.join(', '));
      console.log('   Campos inválidos:', invalidFields.join(', '));

      let errorMessage = '⚠️ Error: Faltan o son inválidos los siguientes datos obligatorios:\n\n';
      errorMessage += '❌ ' + missingFields.concat(invalidFields.map(f => f.split(' ')[0])).join('\n❌ ');
      errorMessage += '\n\nEl bot debe recopilar TODOS los datos antes de enviar la solicitud.';

      return res.json({ respuesta: errorMessage });
    }

    console.log('✅ VALIDACIÓN EXITOSA - Todos los campos críticos presentes');

    // PASO 2: VALIDACIÓN DE FECHA Y TIEMPO (mejorada)
    const now = moment().tz(config.timezone.default);
    const startTime = moment.tz(`${date} ${time}`, 'YYYY-MM-DD HH:mm', config.timezone.default);
    const minimumBookingTime = moment(now).add(1, 'hours');

    console.log('=== VALIDACIÓN DE FECHA Y TIEMPO (ZONA HORARIA MÉXICO) ===');
    console.log('now:', now.format('YYYY-MM-DD HH:mm:ss z'));
    console.log('startTime:', startTime.format('YYYY-MM-DD HH:mm:ss z'));
    console.log('minimumBookingTime:', minimumBookingTime.format('YYYY-MM-DD HH:mm:ss z'));

    if (!startTime.isValid()) {
      console.log('❌ ERROR: Formato de fecha/hora inválido');
      return res.json({ respuesta: '⚠️ Error: El formato de fecha o hora es inválido.' });
    }

    if (startTime.minute() !== 0) {
      console.log('❌ ERROR: Horario con minutos no permitidos');
      return res.json({
        respuesta: '⚠️ Solo se permiten horarios en punto (por ejemplo: 10:00, 11:00, 12:00).'
      });
    }

    // NUEVA VALIDACIÓN: No permitir fechas en el pasado
    const startOfToday = now.clone().startOf('day');
    const requestedDate = startTime.clone().startOf('day');
    
    if (requestedDate.isBefore(startOfToday)) {
      console.log('❌ ERROR: Fecha en el pasado');
      console.log(`   - Fecha solicitada: ${requestedDate.format('YYYY-MM-DD')}`);
      console.log(`   - Hoy: ${startOfToday.format('YYYY-MM-DD')}`);
      
      return res.json({ 
        respuesta: '❌ No puedes agendar citas para fechas pasadas.\n\n🔍 Para agendar una cita, primero consulta la disponibilidad para hoy o fechas futuras.' 
      });
    }

    const isToday = startTime.isSame(now, 'day');
    console.log('isToday:', isToday);
    console.log('startTime < minimumBookingTime:', startTime.isBefore(minimumBookingTime));
    
    if (isToday && startTime.isBefore(minimumBookingTime)) {
      const time12h = formatTimeTo12Hour(time);
      console.log('❌ ERROR: Cita demasiado pronto (menos de 2 horas)');
      
      // Obtener datos de configuración para sugerir siguiente día hábil
      let configDataForSuggestion;
      try {
        configDataForSuggestion = await getConfigData();
      } catch (error) {
        console.log('⚠️ No se pudo obtener configuración para sugerencia');
        return res.json({ 
          respuesta: `🤚 Debes agendar con al menos dos horas de anticipación. No puedes reservar para las ${time12h} de hoy.\n\n🔍 Consulta disponibilidad para mañana en adelante.` 
        });
      }
      
      // Encontrar siguiente día hábil
      const nextWorkingDay = findNextWorkingDay(calendarNumber, now, configDataForSuggestion.hours);
      const nextWorkingDayName = formatDateToSpanishPremium(nextWorkingDay.toDate());
      const nextWorkingDateStr = nextWorkingDay.format('YYYY-MM-DD');
      
      return res.json({ 
          respuesta: `🤚 Debes agendar con al menos una hora de anticipación. No puedes reservar para las ${time12h} de hoy.\n\n📅 El siguiente día hábil es: ${nextWorkingDayName} (${nextWorkingDateStr})\n\n🔍 Te recomiendo consultar la disponibilidad para esa fecha antes de agendar tu cita.` 
      });
    }

    // PASO 3: OBTENER CONFIGURACIÓN (lógica original)
    let configData;
    try {
      configData = await getConfigData();
      console.log('✅ Configuración obtenida correctamente');
    } catch (error) {
      console.error('❌ Error obteniendo configuración:', error.message);
      return res.json({ respuesta: `❌ Error obteniendo configuración: ${error.message}` });
    }

    // VALIDACIÓN CRÍTICA: Prohibir horarios fuera de atención
    const businessHours = getBusinessHoursForDay(startTime.day());
    const requestedHour = startTime.hour();
    if (!businessHours || requestedHour < businessHours.start || requestedHour > businessHours.end) {
      const outOfHoursMessage = await buildOutOfHoursMessage(
        startTime,
        calendarNumber,
        serviceNumber,
        configData
      );
      return res.json({ respuesta: outOfHoursMessage });
    }

    console.log('=== BÚSQUEDA EN BASE DE DATOS ===');
    const calendarId = findData(calendarNumber, configData.calendars, 0, 1);
    console.log('calendarId encontrado:', calendarId);
    if (!calendarId) {
      console.log(`❌ ERROR: Calendario no encontrado para número: ${calendarNumber}`);
      return res.json({ respuesta: '🚫 Error: El calendario solicitado no fue encontrado.' });
    }

    const profesionalName = findData(calendarNumber, configData.calendars, 0, 2);
    const serviceDuration = findData(serviceNumber, configData.services, 0, 1);

    // Obtener nombre del servicio (lógica original)
    let serviceName = serviceNameFromBot;
    if (!serviceName) {
      const serviceMap = {
        1: 'Consulta de valoración',
        2: 'Cita de seguimiento'
      };
      serviceName = serviceMap[serviceNumber] || 'Servicio Desconocido';
      console.log('⚠️ Bot no envió serviceName, usando mapeo backup:', serviceName);
    } else {
      console.log('✅ Bot envió serviceName:', serviceName);
    }

    console.log('profesionalName:', profesionalName);
    console.log('serviceDuration:', serviceDuration);
    console.log('serviceName final:', serviceName);

    if (!serviceDuration) {
      console.log(`❌ ERROR: Servicio no encontrado para número: ${serviceNumber}`);
      return res.json({ respuesta: '🚫 Error: El servicio solicitado no fue encontrado.' });
    }

    // PASO 4: GENERAR CÓDIGO DE RESERVA ÚNICO
    const codigoReserva = generateUniqueReservationCode();
    console.log('🎟️ Código de reserva generado:', codigoReserva);

    // PASO 5: CREAR EVENTO CON ID PERSONALIZADO
    const endTime = moment(startTime).add(parseInt(serviceDuration), 'minutes');
    
    console.log('=== DATOS DEL EVENTO ===');
    console.log('startTime final:', startTime.format('YYYY-MM-DD HH:mm:ss z'));
    console.log('endTime final:', endTime.format('YYYY-MM-DD HH:mm:ss z'));
    console.log('serviceDuration:', serviceDuration, 'minutos');
    console.log('codigoReserva (ID del evento):', codigoReserva);
    
    const eventTitle = `Cita: ${clientName} (${codigoReserva})`;
    const eventDescription = `Cliente: ${clientName}
Email: ${clientEmail}
Teléfono: ${clientPhone}
Servicio: ${serviceName}
Duración: ${serviceDuration} min.
Agendado por: Agente de WhatsApp`;

    const eventData = {
      title: eventTitle,
      description: eventDescription,
      startTime: startTime.toDate(), // Convertir moment a Date
      endTime: endTime.toDate()       // Convertir moment a Date
    };

    console.log('=== CREACIÓN DE EVENTO CON ID PERSONALIZADO ===');
    console.log('eventTitle:', eventTitle);
    
    // Usar createEventWithCustomId para que el evento tenga el código como ID
    const createResult = await createEventWithCustomId(calendarId, eventData, codigoReserva);

    if (!createResult.success) {
      if (createResult.error === 'CONFLICTO') {
        return res.json({ 
          respuesta: `❌ ¡Demasiado tarde! El horario de las ${formatTimeTo12Hour(time)} ya fue reservado.` 
        });
      } else {
        return res.json({ respuesta: '❌ Error creando la cita. Inténtalo de nuevo.' });
      }
    }

    console.log('✅ Evento creado exitosamente con código:', codigoReserva);

    // PASO 6: GUARDAR DATOS DEL CLIENTE (lógica original)
    console.log('🔥 INICIANDO GUARDADO DE DATOS DEL CLIENTE');
    
    const clientData = {
      codigoReserva: codigoReserva || 'ERROR',
      clientName: clientName || 'Cliente Sin Nombre',
      clientPhone: clientPhone || 'Sin Teléfono',
      clientEmail: clientEmail || 'Sin Email',
      profesionalName: profesionalName || 'Sin Especialista',
      date: date || 'Sin Fecha',
      time: time || 'Sin Hora',
      serviceName: serviceName || 'Sin Servicio'
    };

    const saveResult = await saveClientDataOriginal(clientData);
    if (saveResult) {
      console.log('🎉 ÉXITO: Datos guardados correctamente en hoja CLIENTES');
      
      // Guardar información del paciente en caché para próximas citas
      if (clientPhone && clientPhone !== 'Sin Teléfono') {
        savePatientInfo(clientPhone, clientName, clientEmail);
        console.log('💾 Información del paciente guardada en caché para futuras citas');
      }
    } else {
      console.log('💥 FALLO: No se pudieron guardar los datos del cliente');
    }

    // PASO 7: ENVÍO DE EMAILS (CONFIRMACIÓN AL CLIENTE + NOTIFICACIÓN AL NEGOCIO)
    console.log('📧 === ENVÍO DE EMAILS ===');
    try {
      if (emailServiceReady) {
        const emailData = {
          clientName,
          clientEmail,
          clientPhone,
          date,
          time,
          serviceName,
          profesionalName: profesionalName || 'Especialista',
          codigoReserva
        };
        
        // 1. Email de confirmación al cliente
        if (clientEmail && clientEmail !== 'Sin Email') {
          console.log('📧 Enviando confirmación al cliente...');
          const clientEmailResult = await sendAppointmentConfirmation(emailData);
          if (clientEmailResult.success) {
            console.log('✅ Email de confirmación enviado al cliente exitosamente');
          } else {
            console.log('⚠️ Email de confirmación no enviado:', clientEmailResult.reason || clientEmailResult.error);
          }
        } else {
          console.log('⚠️ Email de confirmación saltado - email del cliente inválido');
        }
        
        // 2. Email de notificación al negocio (NUEVO)
        console.log('📧 Enviando notificación al negocio...');
        const businessEmailResult = await sendNewAppointmentNotification(emailData);
        if (businessEmailResult.success) {
          console.log('✅ Notificación enviada al negocio exitosamente');
        } else {
          console.log('⚠️ Notificación al negocio no enviada:', businessEmailResult.reason || businessEmailResult.error);
        }
        
      } else {
        console.log('⚠️ Emails saltados - SMTP no configurado');
      }
    } catch (emailError) {
      console.error('❌ Error enviando emails (no crítico):', emailError.message);
    }

    // PASO 8: RESPUESTA FINAL (lógica original)
    const time12h = formatTimeTo12Hour(time);
    console.log('=== RESPUESTA FINAL ===');
    console.log('time12h:', time12h);

    const finalResponse = {
        respuesta: `✅ ¡Cita confirmada! ✈️\n\nDetalles de tu cita:\n📅 Fecha: ${date}\n⏰ Hora: ${time12h}\n👨‍⚕️ Especialista: ${profesionalName || 'el especialista'}\n\n🎟️ TU CÓDIGO DE RESERVA ES: ${codigoReserva}\n\n¡Gracias por confiar en nosotros! 🌟`,
      id_cita: codigoReserva
    };

    console.log('Respuesta final:', JSON.stringify(finalResponse, null, 2));
    console.log('🔥 FIN AGENDAMIENTO ORIGINAL');

    return res.json(finalResponse);

  } catch (error) {
    console.error('💥 Error en agendamiento:', error.message);
    return res.json({ respuesta: '🤖 Ha ocurrido un error inesperado al agendar la cita.' });
  }
});

/**
 * ENDPOINT: Debug Agendamiento
 * Para diagnosticar problemas paso a paso
 */
app.post('/api/debug-agenda', async (req, res) => {
  const debug = [];
  
  try {
    debug.push('🔍 INICIANDO DEBUG DE AGENDAMIENTO');
    debug.push(`⏰ Timestamp: ${new Date().toISOString()}`);
    
    const { 
      action = "schedule", 
      calendar = "1", 
      service = "1",
      date = "2025-12-01", 
      time = "15:00",
      clientName = "Debug Test",
      clientEmail = "debug@test.com",
      clientPhone = "1234567890"
    } = req.body;
    
    debug.push(`📥 Body recibido: ${JSON.stringify(req.body, null, 2)}`);
    
    // PASO 1: Validaciones básicas
    debug.push('\n📋 PASO 1: VALIDACIONES BÁSICAS');
    if (!action || action !== 'schedule') {
      debug.push('❌ Action inválida');
      return res.json({ debug: debug.join('\n') });
    }
    debug.push('✅ Action válida: schedule');
    debug.push(`✅ Datos básicos: calendar=${calendar}, service=${service}, date=${date}, time=${time}`);
    
    // PASO 2: Configuración de base de datos
    debug.push('\n📊 PASO 2: BASE DE DATOS (PostgreSQL)');
    let configData;
    try {
      configData = await getConfigData();
      debug.push('✅ PostgreSQL conectado correctamente');
      debug.push(`📊 Calendarios encontrados: ${configData.calendars ? configData.calendars.length : 0}`);
      debug.push(`📊 Servicios encontrados: ${configData.services ? configData.services.length : 0}`);
    } catch (error) {
      debug.push(`❌ Error en PostgreSQL: ${error.message}`);
      return res.json({ debug: debug.join('\n') });
    }
    
    // PASO 3: Buscar Calendar ID
    debug.push('\n📅 PASO 3: CALENDAR ID');
    const calendarId = findData(calendar, configData.calendars, 0, 1);
    if (!calendarId) {
      debug.push(`❌ Calendar ID no encontrado para: ${calendar}`);
      return res.json({ debug: debug.join('\n') });
    }
    debug.push(`✅ Calendar ID encontrado: ${calendarId.substring(0, 30)}...`);
    
    // PASO 4: Datos del servicio
    debug.push('\n⚕️ PASO 4: SERVICIO');
    const serviceDuration = findData(service, configData.services, 0, 1);
    if (!serviceDuration) {
      debug.push(`❌ Servicio no encontrado para: ${service}`);
      return res.json({ debug: debug.join('\n') });
    }
    debug.push(`✅ Duración del servicio: ${serviceDuration} minutos`);
    
    // PASO 5: Preparar evento
    debug.push('\n📝 PASO 5: PREPARAR EVENTO');
    const startTime = new Date(`${date}T${time}:00`);
    const endTime = new Date(startTime.getTime() + parseInt(serviceDuration) * 60000);
    
    debug.push(`✅ Hora inicio: ${startTime.toISOString()}`);
    debug.push(`✅ Hora fin: ${endTime.toISOString()}`);
    
    const eventData = {
      title: `Debug: ${clientName}`,
      description: `Email: ${clientEmail}\nTeléfono: ${clientPhone}`,
      startTime: startTime,
      endTime: endTime
    };
    
    // PASO 6: Intentar crear evento
    debug.push('\n📅 PASO 6: CREAR EVENTO EN GOOGLE CALENDAR');
    try {
      debug.push('🔄 Llamando a createEventOriginal...');
      const createResult = await createEventOriginal(calendarId, eventData);
      
      if (createResult.success) {
        debug.push('✅ Evento creado exitosamente!');
        debug.push(`🎟️ Código generado: ${createResult.codigoReserva}`);
        debug.push('\n🎉 DEBUG COMPLETO - TODO FUNCIONA CORRECTAMENTE');
        return res.json({ 
          debug: debug.join('\n'),
          success: true,
          codigo: createResult.codigoReserva 
        });
      } else {
        debug.push(`❌ Error creando evento: ${createResult.error}`);
        debug.push(`📝 Mensaje: ${createResult.message}`);
        return res.json({ debug: debug.join('\n') });
      }
      
    } catch (createError) {
      debug.push(`💥 Excepción creando evento: ${createError.message}`);
      debug.push(`📚 Stack: ${createError.stack}`);
      return res.json({ debug: debug.join('\n') });
    }
    
  } catch (error) {
    debug.push(`💥 ERROR CRÍTICO: ${error.message}`);
    debug.push(`📚 Stack: ${error.stack}`);
    return res.json({ debug: debug.join('\n') });
  }
});

/**
 * ENDPOINT: Test Email - Probar envío de email
 */
app.post('/api/test-email', async (req, res) => {
  try {
    console.log('📧 === TEST DE EMAIL ===');
    
    const { email } = req.body;
    const testEmail = email || 'goparirisvaleria@gmail.com';
    
    console.log('Enviando email de prueba a:', testEmail);
    
    const testData = {
      clientName: 'Usuario Test',
      clientEmail: testEmail,
      date: '2025-09-01',
      time: '15:00',
      serviceName: 'Test de Email',
      profesionalName: 'Lic. Iris Valeria Gopar',
      codigoReserva: 'TEST123'
    };
    
    const result = await sendAppointmentConfirmation(testData);
    
    if (result.success) {
      return res.json({
        success: true,
        message: '✅ Email enviado exitosamente',
        details: result
      });
    } else {
      return res.json({
        success: false,
        message: '❌ Error enviando email',
        error: result.error || result.reason,
        details: result
      });
    }
    
  } catch (error) {
    console.error('Error en test de email:', error);
    return res.json({
      success: false,
      message: '💥 Error interno',
      error: error.message
    });
  }
});

/**
 * ENDPOINT: Diagnóstico de base de datos (PostgreSQL)
 */
app.post('/api/debug-mysql', async (req, res) => {
  const debug = [];

  try {
    debug.push('🔍 === DIAGNÓSTICO POSTGRESQL ===');
    debug.push(`⏰ Timestamp: ${new Date().toISOString()}`);

    debug.push('\n📋 PASO 1: VERIFICAR CONFIGURACIÓN');
    debug.push(`🖥️ PGHOST: ${config.postgres.host ? '✅ Configurado' : '❌ Falta'}`);
    debug.push(`🔌 PGPORT: ${config.postgres.port ? '✅ Configurado' : '❌ Falta'}`);
    debug.push(`👤 PGUSER/POSTGRES_USER: ${config.postgres.user ? '✅ Configurado' : '❌ Falta'}`);
    debug.push(`🔑 POSTGRES_PASSWORD: ${config.postgres.password ? '✅ Configurado' : '❌ Falta'}`);
    debug.push(`📊 POSTGRES_DB: ${config.postgres.database || '(vacío)'}`);

    if (!config.postgres.host || !config.postgres.user || !config.postgres.password || !config.postgres.database) {
      debug.push('\n❌ CONFIGURACIÓN INCOMPLETA - Falta información en .env');
      return res.json({ debug: debug.join('\n') });
    }

    debug.push('\n📊 PASO 2: CONEXIÓN POSTGRESQL');
    try {
      const connectionSuccess = await testConnection();
      if (connectionSuccess) {
        debug.push('✅ Conexión a PostgreSQL exitosa');
      } else {
        debug.push('❌ Error conectando a PostgreSQL');
        return res.json({ debug: debug.join('\n') });
      }
    } catch (error) {
      debug.push(`❌ Error conectando a PostgreSQL: ${error.message}`);
      return res.json({ debug: debug.join('\n') });
    }

    debug.push('\n📋 PASO 3: VERIFICAR TABLAS');
    try {
      const { query } = require('./services/postgresService');
      const { rows: tablesRows } = await query("SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename");
      const tableNames = tablesRows.map(t => t.tablename);
      debug.push(`✅ Tablas encontradas: ${tableNames.join(', ')}`);

      const requiredTables = ['clientes', 'especialistas', 'servicios', 'horarios', 'calendario', 'citas'];
      const missingTables = requiredTables.filter(t => !tableNames.includes(t));

      if (missingTables.length > 0) {
        debug.push(`⚠️ Tablas faltantes: ${missingTables.join(', ')}`);
      } else {
        debug.push('✅ Todas las tablas requeridas existen');
      }
    } catch (error) {
      debug.push(`❌ Error verificando tablas: ${error.message}`);
      return res.json({ debug: debug.join('\n') });
    }

    debug.push('\n📊 PASO 4: CONTAR REGISTROS');
    try {
      const { query } = require('./services/postgresService');

      const clientesRes = await query('SELECT COUNT(*)::int AS count FROM "clientes"');
      const especialistasRes = await query('SELECT COUNT(*)::int AS count FROM "especialistas"');
      const serviciosRes = await query('SELECT COUNT(*)::int AS count FROM "servicios"');
      const horariosRes = await query('SELECT COUNT(*)::int AS count FROM "horarios"');
      const calendariosRes = await query('SELECT COUNT(*)::int AS count FROM "calendario"');
      const citasRes = await query('SELECT COUNT(*)::int AS count FROM "citas"');

      const clientes = clientesRes.rows[0];
      const especialistas = especialistasRes.rows[0];
      const servicios = serviciosRes.rows[0];
      const horarios = horariosRes.rows[0];
      const calendarios = calendariosRes.rows[0];
      const citas = citasRes.rows[0];

      debug.push(`   - Clientes: ${clientes.count} registros`);
      debug.push(`   - Especialistas: ${especialistas.count} registros`);
      debug.push(`   - Servicios: ${servicios.count} registros`);
      debug.push(`   - Horarios: ${horarios.count} registros`);
      debug.push(`   - Calendarios: ${calendarios.count} registros`);
      debug.push(`   - Citas: ${citas.count} registros`);

      debug.push('\n🎉 ¡POSTGRESQL FUNCIONA COMPLETAMENTE!');

      return res.json({
        debug: debug.join('\n'),
        success: true,
        stats: {
          clientes: clientes.count,
          especialistas: especialistas.count,
          servicios: servicios.count,
          horarios: horarios.count,
          calendarios: calendarios.count,
          citas: citas.count
        }
      });

    } catch (error) {
      debug.push(`❌ Error contando registros: ${error.message}`);
      return res.json({ debug: debug.join('\n') });
    }

  } catch (error) {
    debug.push(`💥 ERROR CRÍTICO: ${error.message}`);
    return res.json({ debug: debug.join('\n') });
  }
});

/**
 * ENDPOINT: Debug ULTRA específico para martes 30 septiembre
 */
app.get('/api/debug-martes-30', async (req, res) => {
  try {
    const fecha = '2025-09-30'; // MARTES PROBLEMÁTICO
    const calendarNumber = '1';
    const serviceNumber = '1';
    
    console.log(`🔥 === DEBUG ULTRA ESPECÍFICO: MARTES 30 SEPTIEMBRE ===`);
    
    let debug = [];
    debug.push(`🔥 DEBUG MARTES 30 SEPTIEMBRE (2025-09-30)`);
    debug.push(`================================`);
    
    // Parsear fecha
    const targetMoment = moment.tz(fecha, 'YYYY-MM-DD', config.timezone.default);
    debug.push(`📅 Fecha objetivo: ${targetMoment.format('YYYY-MM-DD dddd')}`);
    debug.push(`🌍 Zona horaria: ${config.timezone.default}`);
    debug.push(`⏰ Hora actual: ${moment().tz(config.timezone.default).format('YYYY-MM-DD HH:mm')}`);
    
    // Obtener datos
    let configData;
    try {
      configData = await getConfigData();
      debug.push(`✅ PostgreSQL: CONECTADO`);
    } catch (error) {
      configData = developmentMockData;
      debug.push(`⚠️ PostgreSQL: ERROR - Usando Mock`);
      debug.push(`   Error: ${error.message}`);
    }
    
    const serviceDuration = findData(serviceNumber, configData.services, 0, 1);
    const calendarId = findData(calendarNumber, configData.calendars, 0, 1);
    
    debug.push(`📊 Configuración obtenida:`);
    debug.push(`   - Calendar ID: ${calendarId?.substring(0, 40)}...`);
    debug.push(`   - Duración servicio: ${serviceDuration} min`);
    
    // Verificar día laboral
    const jsDay = targetMoment.toDate().getDay();
    const dayNumber = (jsDay === 0) ? 7 : jsDay;
    const workingHours = findWorkingHours(calendarNumber, dayNumber, configData.hours);
    
    debug.push(`\n🕒 Verificación día laboral:`);
    debug.push(`   - JS Day: ${jsDay} (0=Dom, 1=Lun, 2=Mar, 3=Mié, 4=Jue, 5=Vie, 6=Sáb)`);
    debug.push(`   - Day Number: ${dayNumber}`);
    debug.push(`   - Working Hours encontrado: ${workingHours ? 'SÍ' : 'NO'}`);
    
    if (!workingHours) {
      debug.push(`❌ PROBLEMA: No es día laboral`);
      return res.json({ debug: debug.join('\n') });
    }
    
    debug.push(`   - Horario original: ${workingHours.start}:00 - ${workingHours.end}:00`);
    
    // Aplicar correcciones
    const dayOfWeek = targetMoment.toDate().getDay();
    const isSaturday = dayOfWeek === 6;
    const isSunday = dayOfWeek === 0;
    
    const correctedHours = {
      start: Math.max(workingHours.start, 10),
      end: workingHours.end,
      dayName: workingHours.dayName,
      lunchStart: isSaturday ? null : (workingHours.lunchStart || 14),
      lunchEnd: isSaturday ? null : (workingHours.lunchEnd || 15),
      hasLunch: !isSaturday && !isSunday
    };
    
    debug.push(`\n🔧 Horario corregido:`);
    debug.push(`   - Inicio: ${correctedHours.start}:00`);
    debug.push(`   - Fin: ${correctedHours.end}:00`);
    debug.push(`   - Comida: ${correctedHours.hasLunch ? `${correctedHours.lunchStart}:00-${correctedHours.lunchEnd}:00` : 'No aplica'}`);
    
    // PASO CRÍTICO: Llamar a checkDayAvailability
    debug.push(`\n🎯 === LLAMANDO A checkDayAvailability ===`);
    
    try {
      const dayResult = await checkDayAvailability(targetMoment, calendarNumber, serviceNumber, configData, calendarId, serviceDuration);
      
      debug.push(`📊 Resultado checkDayAvailability:`);
      if (dayResult && dayResult.hasAvailability) {
        debug.push(`   ✅ TIENE disponibilidad`);
        debug.push(`   - Slots disponibles: ${dayResult.stats.availableSlots}`);
        debug.push(`   - Slots totales: ${dayResult.stats.totalSlots}`);
        debug.push(`   - Ocupación: ${dayResult.stats.occupationPercentage}%`);
        debug.push(`   - Fuente datos: ${dayResult.dataSource}`);
        debug.push(`   - Horarios: [${dayResult.slots?.join(', ')}]`);
        debug.push(`   - ¿Cumple filtro >= 2? ${dayResult.stats.availableSlots >= 2 ? 'SÍ' : 'NO'}`);
      } else {
        debug.push(`   ❌ NO tiene disponibilidad`);
        debug.push(`   - Resultado: ${dayResult ? 'objeto sin hasAvailability' : 'null'}`);
      }
      
      // TAMBIÉN generar slots directamente con nueva función
      debug.push(`\n🔧 === GENERANDO SLOTS DIRECTAMENTE ===`);
      const directSlots = generateHourlySlots(targetMoment, correctedHours);
      debug.push(`📊 Slots generación directa:`);
      debug.push(`   - Slots generados: ${directSlots.length}`);
      debug.push(`   - Horarios: [${directSlots.join(', ')}]`);
      
      return res.json({
        debug: debug.join('\n'),
        fecha: fecha,
        dayResult: dayResult,
        directSlots: directSlots,
        hasAvailabilityInResult: dayResult && dayResult.hasAvailability,
        meetsMinimumSlots: dayResult ? dayResult.stats?.availableSlots >= 2 : false
      });
      
    } catch (error) {
      debug.push(`💥 ERROR en checkDayAvailability: ${error.message}`);
      debug.push(`   Stack: ${error.stack}`);
      return res.json({ debug: debug.join('\n'), error: error.message });
    }
    
  } catch (error) {
    console.error(`❌ Error en debug martes 30:`, error.message);
    return res.json({
      error: error.message,
      debug: `Error general: ${error.message}`
    });
  }
});

/**
 * ENDPOINT: Debug genérico para cualquier día
 */
app.get('/api/debug-dia/:fecha', async (req, res) => {
  try {
    const fecha = req.params.fecha; // formato: YYYY-MM-DD
    const calendarNumber = '1';
    const serviceNumber = '1';
    
    console.log(`🔥 === DEBUG DÍA GENÉRICO: ${fecha} ===`);
    
    // Parsear fecha
    const targetMoment = moment.tz(fecha, 'YYYY-MM-DD', config.timezone.default);
    
    if (!targetMoment.isValid()) {
      return res.json({ error: 'Fecha inválida. Usar formato YYYY-MM-DD' });
    }
    
    // Verificar que no sea domingo
    const dayOfWeek = targetMoment.day();
    if (dayOfWeek === 0) {
      return res.json({ 
        error: 'Domingos no tienen servicio',
        fecha: fecha,
        dayName: 'Domingo'
      });
    }
    
    let debug = [];
    debug.push(`🔥 DEBUG DÍA GENÉRICO: ${fecha}`);
    debug.push(`📅 ${targetMoment.format('dddd DD [de] MMMM [de] YYYY')}`);
    debug.push(`================================`);
    
    // Obtener datos
    let configData;
    try {
      configData = await getConfigData();
      debug.push(`✅ PostgreSQL: CONECTADO`);
    } catch (error) {
      configData = developmentMockData;
      debug.push(`⚠️ PostgreSQL: ERROR - Usando Mock`);
    }
    
    const serviceDuration = findData(serviceNumber, configData.services, 0, 1);
    const calendarId = findData(calendarNumber, configData.calendars, 0, 1);
    
    debug.push(`📊 Configuración:`);
    debug.push(`   - Calendar ID: ${calendarId?.substring(0, 40)}...`);
    debug.push(`   - Duración servicio: ${serviceDuration} min`);
    
    // Verificar día laboral
    const jsDay = targetMoment.toDate().getDay();
    const dayNumber = (jsDay === 0) ? 7 : jsDay;
    const workingHours = findWorkingHours(calendarNumber, dayNumber, configData.hours);
    
    debug.push(`\n🕒 Verificación día laboral:`);
    debug.push(`   - Día de semana: ${targetMoment.format('dddd')} (${dayOfWeek})`);
    debug.push(`   - Working Hours: ${workingHours ? 'ENCONTRADO' : 'NO ENCONTRADO'}`);
    
    if (!workingHours) {
      debug.push(`❌ PROBLEMA: No es día laboral`);
      return res.json({ 
        debug: debug.join('\n'),
        error: 'No es día laboral',
        fecha: fecha 
      });
    }
    
    debug.push(`   - Horario original: ${workingHours.start}:00 - ${workingHours.end}:00`);
    
    // Aplicar correcciones
    const isSaturday = dayOfWeek === 6;
    const isSunday = dayOfWeek === 0;
    
    const correctedHours = {
      start: Math.max(workingHours.start, 10),
      end: workingHours.end,
      dayName: workingHours.dayName,
      lunchStart: isSaturday ? null : (workingHours.lunchStart || 14),
      lunchEnd: isSaturday ? null : (workingHours.lunchEnd || 15),
      hasLunch: !isSaturday && !isSunday
    };
    
    debug.push(`\n🔧 Horario corregido:`);
    debug.push(`   - Inicio: ${correctedHours.start}:00`);
    debug.push(`   - Fin: ${correctedHours.end}:00`);
    debug.push(`   - Comida: ${correctedHours.hasLunch ? `${correctedHours.lunchStart}:00-${correctedHours.lunchEnd}:00` : 'No aplica'}`);
    
    // PASO CRÍTICO: Llamar a checkDayAvailability
    debug.push(`\n🎯 === LLAMANDO A checkDayAvailability ===`);
    
    try {
      const dayResult = await checkDayAvailability(targetMoment, calendarNumber, serviceNumber, configData, calendarId, serviceDuration);
      
      debug.push(`📊 Resultado checkDayAvailability:`);
      if (dayResult && dayResult.hasAvailability) {
        debug.push(`   ✅ TIENE disponibilidad`);
        debug.push(`   - Slots disponibles: ${dayResult.stats.availableSlots}`);
        debug.push(`   - Slots totales: ${dayResult.stats.totalSlots}`);
        debug.push(`   - Ocupación: ${dayResult.stats.occupationPercentage}%`);
        debug.push(`   - Fuente datos: ${dayResult.dataSource}`);
        debug.push(`   - Horarios: [${dayResult.slots?.join(', ')}]`);
        debug.push(`   - ¿Cumple filtro >= 2? ${dayResult.stats.availableSlots >= 2 ? 'SÍ' : 'NO'}`);
        
        if (dayResult.stats.availableSlots >= 2) {
          debug.push(`   🎯 DEBERÍA aparecer en días alternativos`);
        } else {
          debug.push(`   ⚠️ NO cumple filtro mínimo para días alternativos`);
        }
      } else {
        debug.push(`   ❌ NO tiene disponibilidad`);
        debug.push(`   - Resultado: ${dayResult ? 'objeto sin hasAvailability' : 'null'}`);
      }
      
      // Generar slots directamente para comparar
      debug.push(`\n🔧 === GENERANDO SLOTS DIRECTAMENTE ===`);
      const directSlots = generateHourlySlots(targetMoment, correctedHours);
      debug.push(`📊 Slots generación directa:`);
      debug.push(`   - Slots generados: ${directSlots.length}`);
      debug.push(`   - Horarios: [${directSlots.join(', ')}]`);
      
      const slotsMatch = JSON.stringify(dayResult?.slots || []) === JSON.stringify(directSlots);
      debug.push(`   - ¿Coinciden con checkDayAvailability? ${slotsMatch ? 'SÍ' : 'NO'}`);
      
      return res.json({
        debug: debug.join('\n'),
        fecha: fecha,
        dayName: targetMoment.format('dddd'),
        dayResult: dayResult,
        directSlots: directSlots,
        hasAvailabilityInResult: dayResult && dayResult.hasAvailability,
        meetsMinimumSlots: dayResult ? dayResult.stats?.availableSlots >= 2 : false,
        slotsMatch: slotsMatch,
        shouldAppearInAlternatives: dayResult && dayResult.hasAvailability && dayResult.stats?.availableSlots >= 2
      });
      
    } catch (error) {
      debug.push(`💥 ERROR en checkDayAvailability: ${error.message}`);
      return res.json({ debug: debug.join('\n'), error: error.message });
    }
    
  } catch (error) {
    console.error(`❌ Error en debug día ${req.params.fecha}:`, error.message);
    return res.json({
      error: error.message,
      fecha: req.params.fecha
    });
  }
});

/**
 * ENDPOINT: Debug mejorado de slots
 */
app.get('/api/debug-slots/:fecha', async (req, res) => {
  try {
    const fecha = req.params.fecha; // formato: YYYY-MM-DD
    const calendarNumber = '1';
    const serviceNumber = '1';
    
    console.log(`🔧 === DEBUG SLOTS MEJORADO: ${fecha} ===`);
    
    // Parsear fecha
    const targetMoment = moment.tz(fecha, 'YYYY-MM-DD', config.timezone.default);
    
    if (!targetMoment.isValid()) {
      return res.json({ error: 'Fecha inválida. Usar formato YYYY-MM-DD' });
    }
    
    let resultado = `🔧 DEBUG SLOTS MEJORADO: ${fecha}\n\n`;
    
    // Obtener datos
    let configData;
    try {
      configData = await getConfigData();
      resultado += `✅ PostgreSQL conectado\n`;
    } catch (error) {
      configData = developmentMockData;
      resultado += `⚠️ Usando datos simulados\n`;
    }
    
    // Obtener configuración
    const jsDay = targetMoment.toDate().getDay();
    const dayNumber = (jsDay === 0) ? 7 : jsDay;
    const workingHours = findWorkingHours(calendarNumber, dayNumber, configData.hours);
    
    if (!workingHours) {
      return res.json({ 
        debug: resultado + '❌ No es día laboral',
        fecha: fecha 
      });
    }
    
    // Aplicar corrección de horario + horario comida
    const dayOfWeek = targetMoment.toDate().getDay();
    const isSaturday = dayOfWeek === 6;
    const isSunday = dayOfWeek === 0;
    
    const correctedHours = {
      start: Math.max(workingHours.start, 10),
      end: workingHours.end,
      dayName: workingHours.dayName,
      lunchStart: isSaturday ? null : (workingHours.lunchStart || 14),
      lunchEnd: isSaturday ? null : (workingHours.lunchEnd || 15),
      hasLunch: !isSaturday && !isSunday
    };
    
    resultado += `📅 Día: ${targetMoment.format('dddd')} (${dayOfWeek})\n`;
    resultado += `⏰ Horario: ${correctedHours.start}:00 - ${correctedHours.end}:00\n`;
    resultado += `🍽️ Comida: ${correctedHours.hasLunch ? `${correctedHours.lunchStart}:00-${correctedHours.lunchEnd}:00` : 'No aplica'}\n\n`;
    
    // Generar slots con función mejorada
    console.log(`🔧 Generando slots con función mejorada...`);
    const slots = generateHourlySlots(targetMoment, correctedHours);
    
    resultado += `📊 RESULTADO:\n`;
    resultado += `   Slots totales posibles: ${correctedHours.end - correctedHours.start}\n`;
    resultado += `   Slots generados: ${slots.length}\n`;
    resultado += `   Horarios: [${slots.join(', ')}]\n\n`;
    
    resultado += `✅ ¿Cumple filtro alternativos? ${slots.length >= 2 ? 'SÍ' : 'NO'} (mínimo 2)\n`;
    
    return res.json({
      debug: resultado,
      fecha: fecha,
      dayName: targetMoment.format('dddd'),
      slotsGenerated: slots.length,
      slots: slots,
      meetsMinimum: slots.length >= 2,
      workingHours: correctedHours
    });
    
  } catch (error) {
    console.error(`❌ Error en debug slots ${req.params.fecha}:`, error.message);
    return res.json({
      error: error.message,
      fecha: req.params.fecha
    });
  }
});

/**
 * ENDPOINT: Debug búsqueda días alternativos paso a paso
 */
app.get('/api/debug-busqueda-alternativos/:fechaObjetivo', async (req, res) => {
  try {
    const fechaObjetivo = req.params.fechaObjetivo; // FECHA SIN DISPONIBILIDAD
    const calendarNumber = '1';
    const serviceNumber = '1';
    
    console.log(`🔍 === DEBUG BÚSQUEDA DÍAS ALTERNATIVOS ===`);
    console.log(`📅 Fecha objetivo (sin disponibilidad): ${fechaObjetivo}`);
    
    const targetMoment = moment.tz(fechaObjetivo, 'YYYY-MM-DD', config.timezone.default);
    
    if (!targetMoment.isValid()) {
      return res.json({ error: 'Fecha inválida. Usar formato YYYY-MM-DD' });
    }
    
    let debug = [];
    debug.push(`🔍 DEBUG BÚSQUEDA DÍAS ALTERNATIVOS`);
    debug.push(`📅 Fecha objetivo: ${fechaObjetivo} (${targetMoment.format('dddd')})`);
    debug.push(`🎯 Objetivo: Encontrar 2+ días con >= 2 slots cada uno`);
    debug.push(`================================\n`);
    
    // Obtener datos
    let configData;
    try {
      configData = await getConfigData();
      debug.push(`✅ PostgreSQL conectado`);
    } catch (error) {
      configData = developmentMockData;
      debug.push(`⚠️ Usando Mock data`);
    }
    
    const today = moment().tz(config.timezone.default).startOf('day');
    const serviceDuration = findData(serviceNumber, configData.services, 0, 1);
    const calendarId = findData(calendarNumber, configData.calendars, 0, 1);
    
    debug.push(`📊 Configuración:`);
    debug.push(`   - Hoy: ${today.format('YYYY-MM-DD')}`);
    debug.push(`   - Servicio duración: ${serviceDuration} min`);
    debug.push(`   - Calendar ID: ${calendarId?.substring(0, 30)}...`);
    debug.push(``);
    
    const alternativeDays = [];
    
    // SIMULAR LÓGICA DE findAlternativeDaysWithAvailability
    debug.push(`🔍 === BUSCANDO DÍAS POSTERIORES (1-14 días) ===`);
    
    for (let dayOffset = 1; dayOffset <= 14; dayOffset++) {
      const nextDay = targetMoment.clone().add(dayOffset, 'days');
      debug.push(`\n📅 Evaluando día +${dayOffset}: ${nextDay.format('YYYY-MM-DD')} (${nextDay.format('dddd')})`);
      
      try {
        const nextResult = await checkDayAvailability(nextDay, calendarNumber, serviceNumber, configData, calendarId, serviceDuration);
        
        if (nextResult && nextResult.hasAvailability) {
          debug.push(`   ✅ TIENE disponibilidad:`);
          debug.push(`      - Slots: ${nextResult.stats.availableSlots}`);
          debug.push(`      - Horarios: [${nextResult.slots?.join(', ')}]`);
          debug.push(`      - Fuente: ${nextResult.dataSource}`);
          
          if (nextResult.stats.availableSlots >= 2) {
            alternativeDays.push({
              ...nextResult,
              distance: dayOffset,
              direction: 'posterior',
              priority: dayOffset
            });
            debug.push(`      🎯 INCLUIDO en alternativas (>= 2 slots)`);
          } else {
            debug.push(`      ❌ EXCLUIDO (< 2 slots requeridos)`);
          }
          
        } else {
          debug.push(`   ❌ Sin disponibilidad`);
        }
        
        // Parar si ya encontramos 2 días
        if (alternativeDays.length >= 2) {
          debug.push(`\n🛑 DETENIENDO BÚSQUEDA: Ya encontramos ${alternativeDays.length} días válidos`);
          break;
        }
        
      } catch (error) {
        debug.push(`   💥 ERROR: ${error.message}`);
      }
    }
    
    debug.push(`\n📊 === RESULTADO BÚSQUEDA POSTERIOR ===`);
    debug.push(`Días encontrados: ${alternativeDays.length}`);
    
    // Si necesitamos más, buscar hacia atrás
    if (alternativeDays.length < 2) {
      debug.push(`\n🔍 === BUSCANDO DÍAS ANTERIORES (1-7 días) ===`);
      
      for (let dayOffset = 1; dayOffset <= 7; dayOffset++) {
        const previousDay = targetMoment.clone().subtract(dayOffset, 'days');
        debug.push(`\n📅 Evaluando día -${dayOffset}: ${previousDay.format('YYYY-MM-DD')} (${previousDay.format('dddd')})`);
        
        if (previousDay.isSameOrAfter(today, 'day')) {
          try {
            const prevResult = await checkDayAvailability(previousDay, calendarNumber, serviceNumber, configData, calendarId, serviceDuration);
            
            if (prevResult && prevResult.hasAvailability && prevResult.stats.availableSlots >= 2) {
              alternativeDays.push({
                ...prevResult,
                distance: dayOffset,
                direction: 'anterior',
                priority: dayOffset + 100
              });
              debug.push(`   ✅ INCLUIDO: ${prevResult.stats.availableSlots} slots`);
            } else {
              debug.push(`   ❌ No cumple filtros`);
            }
            
          } catch (error) {
            debug.push(`   💥 ERROR: ${error.message}`);
          }
        } else {
          debug.push(`   ⏰ Muy en el pasado (antes de hoy)`);
        }
        
        if (alternativeDays.length >= 2) break;
      }
    }
    
    debug.push(`\n🎯 === RESULTADO FINAL ===`);
    debug.push(`Total días alternativos: ${alternativeDays.length}`);
    
    alternativeDays.forEach((day, index) => {
      debug.push(`${index + 1}. ${day.dateStr} (${day.dayName}): ${day.stats.availableSlots} slots`);
    });
    
    return res.json({
      debug: debug.join('\n'),
      fechaObjetivo: fechaObjetivo,
      diasEncontrados: alternativeDays.length,
      alternativeDays: alternativeDays,
      success: alternativeDays.length > 0
    });
    
  } catch (error) {
    console.error(`❌ Error en debug búsqueda alternativos:`, error.message);
    return res.json({
      error: error.message,
      fechaObjetivo: req.params.fechaObjetivo
    });
  }
});

/**
 * ENDPOINT: Test de días alternativos
 */
app.get('/api/test-alternativos/:fecha', async (req, res) => {
  try {
    const fecha = req.params.fecha; // formato: YYYY-MM-DD
    console.log(`🧪 === TEST DÍAS ALTERNATIVOS: ${fecha} ===`);
    
    // Simular la llamada principal con parámetros fijos
    const calendarNumber = '1';
    const serviceNumber = '1';
    const targetDateStr = fecha;
    
    // Parsear fecha
    const targetMoment = moment.tz(targetDateStr, 'YYYY-MM-DD', config.timezone.default);
    const targetDate = targetMoment.toDate();
    
    // Obtener datos
    let configData;
    try {
      configData = await getConfigData();
    } catch (error) {
      configData = developmentMockData;
    }
    
    console.log(`🔍 Llamando directamente a findAlternativeDaysWithAvailability...`);
    const alternativeDays = await findAlternativeDaysWithAvailability(
      targetMoment, 
      calendarNumber, 
      serviceNumber, 
      configData
    );
    
    if (alternativeDays.length === 0) {
      return res.json({ 
        test: "❌ NO se encontraron días alternativos",
        fechaConsultada: fecha,
        resultado: "Sin alternativas"
      });
    }
    
    // Generar respuesta como lo haría el sistema real
    const originalDayName = formatDateToSpanishPremium(targetDateStr);
    let alternativeResponse = `😔 No tengo disponibilidad para *${originalDayName}* (${targetDateStr}), pero sí tengo para estos días:\n\n`;
    
    let letterIndex = 0;
    let dateMapping = {};
    
    for (const dayData of alternativeDays) {
      const dayName = formatDateToSpanishPremium(dayData.dateStr);
      const occupationEmoji = getOccupationEmoji(dayData.stats.occupationPercentage);
      
      let distanceText = '';
      if (dayData.direction === 'anterior') {
        distanceText = dayData.distance === 1 ? '📅 1 día antes' : `📅 ${dayData.distance} días antes`;
      } else {
        distanceText = dayData.distance === 1 ? '📅 1 día después' : `📅 ${dayData.distance} días después`;
      }
      
      alternativeResponse += `${occupationEmoji} *${dayName.toUpperCase()}* (${dayData.dateStr})\n`;
      alternativeResponse += `${distanceText} • ${dayData.stats.availableSlots} horarios disponibles`;
      
      // 🔧 DEBUG: Mostrar fuente de datos en modo desarrollo
      if (process.env.NODE_ENV === 'development' && dayData.dataSource) {
        alternativeResponse += ` [${dayData.dataSource}]`;
      }
      
      alternativeResponse += `\n\n`;
      
      const formattedSlots = dayData.slots.map((slot) => {
        const letterEmoji = getLetterEmoji(letterIndex);
        const time12h = formatTimeTo12Hour(slot);
        
        dateMapping[String.fromCharCode(65 + letterIndex)] = {
          date: dayData.dateStr,
          time: slot,
          dayName: dayName
        };
        
        letterIndex++;
        return `${letterEmoji} ${time12h}`;
      }).join('\n');
      
      alternativeResponse += formattedSlots + '\n\n';
    }
    
    alternativeResponse += `💡 Escribe la letra del horario que prefieras (A, B, C...) ✈️`;
    
    return res.json({
      test: "✅ DÍAS ALTERNATIVOS ENCONTRADOS",
      fechaConsultada: fecha,
      diasEncontrados: alternativeDays.length,
      respuesta: alternativeResponse,
      metadata: {
        originalDate: targetDateStr,
        alternativeDaysFound: alternativeDays.length,
        totalAlternativeSlots: alternativeDays.reduce((sum, day) => sum + day.stats.availableSlots, 0),
        dateMapping: dateMapping,
        isAlternativeSearch: true
      }
    });
    
  } catch (error) {
    console.error('Error en test alternativo:', error.message);
    return res.json({ error: `💥 Error: ${error.message}` });
  }
});

/**
 * ENDPOINT: Debug específico para diagnosticar problemas de horarios
 */
app.get('/api/debug-horarios/:fecha', async (req, res) => {
  try {
    const fecha = req.params.fecha; // formato: YYYY-MM-DD
    console.log(`🔍 === DEBUG DETALLADO HORARIOS: ${fecha} ===`);
    
    // Obtener datos de configuración
    let configData;
    try {
      configData = await getConfigData();
    } catch (error) {
      return res.json({ error: `❌ Error obteniendo configuración: ${error.message}` });
    }
    
    const calendarId = findData('1', configData.calendars, 0, 1);
    const serviceDuration = findData('1', configData.services, 0, 1);
    
    console.log(`📊 Calendar ID: ${calendarId}`);
    console.log(`⏱️ Duración servicio: ${serviceDuration} minutos`);
    
    // Crear moment para la fecha
    const targetMoment = moment.tz(fecha, 'YYYY-MM-DD', config.timezone.default);
    const jsDay = targetMoment.toDate().getDay();
    const dayNumber = (jsDay === 0) ? 7 : jsDay;
    const workingHours = findWorkingHours('1', dayNumber, configData.hours);
    
    let resultado = `🔍 DEBUG HORARIOS: ${fecha}\n\n`;
    resultado += `📅 Día de la semana: ${targetMoment.format('dddd')} (JS: ${jsDay}, DB: ${dayNumber})\n`;
    resultado += `⏰ Horario laboral: ${workingHours ? workingHours.start + ':00 - ' + workingHours.end + ':00' : 'No definido'}\n\n`;
    
    if (!workingHours) {
      return res.json({ debug: resultado + '❌ No es día laboral' });
    }
    
    // Aplicar corrección de horario mínimo + horario comida
    const targetDayOfWeek = targetMoment.toDate().getDay();
    const isSaturday = targetDayOfWeek === 6;
    const isSunday = targetDayOfWeek === 0;
    
    const correctedHours = {
      start: Math.max(workingHours.start, 10),
      end: workingHours.end,
      dayName: workingHours.dayName,
      // 🔧 CONSISTENCIA: Incluir horario de comida
      lunchStart: isSaturday ? null : (workingHours.lunchStart || 14),
      lunchEnd: isSaturday ? null : (workingHours.lunchEnd || 15),
      hasLunch: !isSaturday && !isSunday
    };
    
    resultado += `🔧 Horario corregido: ${correctedHours.start}:00 - ${correctedHours.end}:00\n`;
    resultado += `🍽️ Horario comida: ${correctedHours.hasLunch ? `${correctedHours.lunchStart}:00 - ${correctedHours.lunchEnd}:00` : 'No aplica'}\n\n`;
    
    // Obtener slots disponibles
    try {
      console.log(`🔍 Llamando a findAvailableSlots...`);
      const slotResult = await findAvailableSlots(calendarId, targetMoment.toDate(), parseInt(serviceDuration), correctedHours);
      
      let availableSlots = [];
      if (typeof slotResult === 'object' && slotResult.slots !== undefined) {
        availableSlots = slotResult.slots;
        resultado += `📊 Resultado tipo objeto: ${slotResult.slots.length} slots\n`;
        if (slotResult.message) {
          resultado += `📝 Mensaje: ${slotResult.message}\n`;
        }
      } else {
        availableSlots = slotResult;
        resultado += `📊 Resultado array directo: ${slotResult.length} slots\n`;
      }
      
      resultado += `\n✅ SLOTS DISPONIBLES (${availableSlots.length}):\n`;
      if (availableSlots.length > 0) {
        availableSlots.forEach(slot => {
          resultado += `   - ${slot}\n`;
        });
      } else {
        resultado += `   (Ninguno)\n`;
      }
      
      // Verificar específicamente 11 AM y 12 PM
      resultado += `\n🔍 ANÁLISIS ESPECÍFICO:\n`;
      resultado += `   - ¿11:00 disponible? ${availableSlots.includes('11:00') ? '✅ SÍ' : '❌ NO'}\n`;
      resultado += `   - ¿12:00 disponible? ${availableSlots.includes('12:00') ? '✅ SÍ' : '❌ NO'}\n`;
      
      return res.json({ 
        debug: resultado,
        availableSlots: availableSlots,
        totalSlots: availableSlots.length,
        fecha: fecha,
        calendarId: calendarId.substring(0, 30) + '...',
        workingHours: correctedHours
      });
      
    } catch (error) {
      console.log(`⚠️ Error con Google Calendar, probando mock...`);
      const mockResult = mockFindAvailableSlots(calendarId, targetMoment.toDate(), parseInt(serviceDuration), correctedHours);
      
      let availableSlots = [];
      if (typeof mockResult === 'object' && mockResult.slots !== undefined) {
        availableSlots = mockResult.slots;
      } else {
        availableSlots = mockResult;
      }
      
      resultado += `⚠️ USANDO DATOS MOCK (Error Google Calendar)\n`;
      resultado += `📊 Mock slots: ${availableSlots.length}\n\n`;
      
      resultado += `✅ SLOTS MOCK (${availableSlots.length}):\n`;
      availableSlots.forEach(slot => {
        resultado += `   - ${slot}\n`;
      });
      
      return res.json({ 
        debug: resultado,
        availableSlots: availableSlots,
        totalSlots: availableSlots.length,
        fecha: fecha,
        usingMock: true,
        error: error.message
      });
    }
    
  } catch (error) {
    console.error('Error en debug horarios:', error.message);
    return res.json({ error: `💥 Error: ${error.message}` });
  }
});

/**
 * ENDPOINT: Consultar datos de paciente por número telefónico
 * Busca información del paciente en PostgreSQL usando el número de teléfono
 */
app.get('/api/consulta-datos-paciente', async (req, res) => {
  try {
    console.log('🔍 === CONSULTA DATOS PACIENTE ===');
    const { telefono } = req.query;

    console.log('Parámetros recibidos:', { telefono });

    // Validación de parámetros
    if (!telefono) {
      return res.json({
        success: false,
        message: '⚠️ Error: Se requiere el parámetro "telefono" para realizar la búsqueda.',
        data: []
      });
    }

    // Validación básica del formato de teléfono
    const telefonoLimpio = telefono.replace(/[\s\-\(\)\.]/g, '');
    if (telefonoLimpio.length < 8) {
      return res.json({
        success: false,
        message: '⚠️ Error: El número de teléfono debe tener al menos 8 dígitos.',
        data: []
      });
    }

    console.log(`🔍 Buscando paciente con teléfono: ${telefono}`);
    console.log(`📞 Teléfono normalizado: ${telefonoLimpio}`);

    // Buscar datos del paciente en PostgreSQL
    let pacientesEncontrados;
    try {
      pacientesEncontrados = await consultaDatosPacientePorTelefono(telefono);
    } catch (error) {
      console.error('❌ Error consultando PostgreSQL:', error.message);
      const isTableMissing = error.code === '42P01' || (error.message && error.message.includes('does not exist'));
      const message = isTableMissing
        ? '❌ Las tablas no existen en la base de datos. Ejecute el script base.sql en su PostgreSQL (Railway: Data > Query, o con psql/cliente SQL).'
        : '❌ Error interno: No se pudieron consultar los datos. Verifique la configuración de PostgreSQL.';
      return res.json({
        success: false,
        message,
        data: []
      });
    }

    // Si no se encontraron pacientes
    if (!pacientesEncontrados || pacientesEncontrados.length === 0) {
      console.log(`❌ No se encontraron pacientes con el teléfono: ${telefono}`);
      return res.json({
        success: false,
        message: `❌ No se encontraron registros para el número de teléfono: ${telefono}`,
        data: []
      });
    }

    // Formatear datos de respuesta - nombre completo y correo electrónico
    const datosFormateados = pacientesEncontrados.map(paciente => {
      const nombreCompleto = paciente.nombreCompleto || '';
      const correoElectronico = paciente.correoElectronico || '';
      
      return {
        nombreCompleto: nombreCompleto,
        primerNombre: nombreCompleto.split(' ')[0] || '',
        correoElectronico: correoElectronico,
        telefono: paciente.telefono,
        fechaUltimaRegistro: paciente.fechaRegistro
      };
    });

    // Filtrar solo registros que tengan al menos nombre o correo
    const datosValidos = datosFormateados.filter(paciente => 
      paciente.nombreCompleto.trim() !== '' || paciente.correoElectronico.trim() !== ''
    );

    if (datosValidos.length === 0) {
      return res.json({
        success: false,
        message: `⚠️ Se encontraron registros para el teléfono ${telefono}, pero no contienen nombre completo ni correo electrónico.`,
        data: []
      });
    }

    console.log(`✅ Pacientes encontrados: ${datosValidos.length}`);
    datosValidos.forEach((paciente, index) => {
      console.log(`   ${index + 1}. ${paciente.nombreCompleto} - ${paciente.correoElectronico}`);
    });

    // Respuesta exitosa
    return res.json({
      success: true,
      message: `✅ Se ${datosValidos.length === 1 ? 'encontró' : 'encontraron'} ${datosValidos.length} ${datosValidos.length === 1 ? 'registro' : 'registros'} para el teléfono ${telefono}`,
      data: datosValidos,
      totalRegistros: datosValidos.length
    });

  } catch (error) {
    console.error('💥 Error en consulta de datos del paciente:', error.message);
    return res.json({
      success: false,
      message: '🤖 Ha ocurrido un error inesperado al consultar los datos del paciente.',
      data: []
    });
  }
});

// =================================================================
// 📚 DOCUMENTACIÓN SWAGGER
// =================================================================

const swaggerDocument = {
  openapi: '3.0.0',
  info: {
    title: 'Demo Asistente Fisio API - Sistema de Gestión de Citas',
    description: 'API migrada de Google Apps Script para gestión de citas médicas',
    version: '1.0.0',
    contact: {
      email: 'goparirisvaleria@gmail.com'
    }
  },
  servers: [
    {
      url: 'https://demoasistentefisiodes-production.up.railway.app',
      description: 'Servidor de producción (Railway)'
    },
    {
      url: `http://localhost:${PORT}`,
      description: 'Servidor de desarrollo local'
    }
  ],
  paths: {
    '/api/consulta-disponibilidad': {
      get: {
        summary: 'Consulta disponibilidad de horarios',
        description: 'Consulta horarios disponibles de los próximos 4-5 días en un solo mensaje. Muestra todos los horarios disponibles de forma compacta para facilitar la selección.',
        parameters: [
          {
            name: 'calendar',
            in: 'query',
            required: true,
            description: 'Número identificador del calendario',
            schema: { type: 'integer', example: 1 }
          },
          {
            name: 'service',
            in: 'query',
            required: true,
            description: 'Número identificador del servicio',
            schema: { type: 'integer', example: 1 }
          },
          {
            name: 'date',
            in: 'query',
            required: true,
            description: 'Fecha en formato YYYY-MM-DD',
            schema: { type: 'string', example: '2025-08-26' }
          }
        ],
        responses: {
          '200': {
            description: 'Respuesta exitosa con horarios disponibles',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    respuesta: { type: 'string' },
                    metadata: {
                      type: 'object',
                      properties: {
                        totalDays: { type: 'integer' },
                        totalSlots: { type: 'integer' },
                        averageOccupation: { type: 'integer' },
                        dateMapping: { type: 'object' },
                        recommendations: { type: 'object' }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    },
    '/api/agenda-cita': {
      post: {
        summary: 'Agenda una nueva cita',
        description: 'Agenda una nueva cita médica con validaciones completas y generación automática de código de reserva',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['action', 'date', 'time', 'calendar', 'service', 'clientName', 'clientPhone', 'clientEmail'],
                properties: {
                  action: { 
                    type: 'string', 
                    example: 'schedule',
                    description: 'Acción a realizar (debe ser "schedule")'
                  },
                  date: { 
                    type: 'string', 
                    example: '2025-08-27',
                    description: 'Fecha de la cita en formato YYYY-MM-DD'
                  },
                  time: { 
                    type: 'string', 
                    example: '14:00',
                    description: 'Hora de la cita en formato HH:MM (24h)'
                  },
                  calendar: { 
                    type: 'string', 
                    example: '1',
                    description: 'Número identificador del calendario'
                  },
                  service: { 
                    type: 'string', 
                    example: '1',
                    description: 'Número identificador del servicio'
                  },
                  serviceName: { 
                    type: 'string', 
                    example: 'Consulta de valoración',
                    description: 'Nombre descriptivo del servicio (opcional)'
                  },
                  clientName: { 
                    type: 'string', 
                    example: 'Juan Pérez',
                    description: 'Nombre completo del cliente'
                  },
                  clientPhone: { 
                    type: 'string', 
                    example: '5551234567',
                    description: 'Teléfono del cliente (mínimo 10 dígitos)'
                  },
                  clientEmail: { 
                    type: 'string', 
                    example: 'juan.perez@ejemplo.com',
                    description: 'Email del cliente (formato válido)'
                  }
                }
              }
            }
          }
        },
        responses: {
          '200': {
            description: 'Respuesta del agendamiento',
            content: {
              'application/json': {
                schema: {
                  oneOf: [
                    {
                      title: 'Cita Confirmada',
                      type: 'object',
                      properties: {
                        respuesta: { 
                          type: 'string',
                          example: '✅ ¡Cita confirmada! ✈️\n\nDetalles de tu cita:\n📅 Fecha: 2025-08-27\n⏰ Hora: 2:00 PM\n👨‍⚕️ Especialista: Dr. Juan\n\n🎟️ TU CÓDIGO DE RESERVA ES: ABC123\n\n¡Gracias por confiar en nosotros! 🌟'
                        },
                        id_cita: { 
                          type: 'string',
                          example: 'ABC123',
                          description: 'Código de reserva generado'
                        }
                      }
                    },
                    {
                      title: 'Error de Validación Campos',
                      type: 'object', 
                      properties: {
                        respuesta: { 
                          type: 'string',
                          example: '⚠️ Error: Faltan o son inválidos los siguientes datos obligatorios:\n\n❌ clientEmail\n❌ clientPhone\n\nEl bot debe recopilar TODOS los datos antes de enviar la solicitud.'
                        }
                      }
                    },
                    {
                      title: 'Error Fecha Pasada',
                      type: 'object',
                      properties: {
                        respuesta: { 
                          type: 'string',
                          example: '❌ No puedes agendar citas para fechas pasadas.\n\n🔍 Para agendar una cita, primero consulta la disponibilidad para hoy o fechas futuras.'
                        }
                      }
                    },
                    {
                      title: 'Error Menos de 2 Horas',
                      type: 'object',
                      properties: {
                        respuesta: { 
                          type: 'string',
                          example: '🤚 Debes agendar con al menos dos horas de anticipación. No puedes reservar para las 2:00 PM de hoy.\n\n📅 El siguiente día hábil es: Mañana (2025-08-28)\n\n🔍 Te recomiendo consultar la disponibilidad para esa fecha antes de agendar tu cita.'
                        }
                      }
                    },
                    {
                      title: 'Conflicto de Horario',
                      type: 'object',
                      properties: {
                        respuesta: { 
                          type: 'string',
                          example: '❌ ¡Demasiado tarde! El horario de las 2:00 PM ya fue reservado.'
                        }
                      }
                    }
                  ]
                }
              }
            }
          }
        }
      }
    },
    '/api/cancela-cita': {
      post: {
        summary: 'Cancela una cita existente',
        description: 'Cancela una cita usando el código de reserva',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['action', 'eventId'],
                properties: {
                  action: { type: 'string', example: 'cancel' },
                  calendar: { type: 'string', example: '1', description: 'Opcional. Por defecto: 1' },
                  eventId: { type: 'string', example: 'ABC123' },
                  codigo_reserva: { type: 'string', example: 'ABC123', description: 'Alias de eventId' },
                  codigoReserva: { type: 'string', example: 'ABC123', description: 'Alias de eventId' }
                }
              }
            }
          }
        },
        responses: {
          '200': {
            description: 'Respuesta de cancelación',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    respuesta: { type: 'string' }
                  }
                }
              }
            }
          }
        }
      }
    },
    '/api/reagenda-cita': {
      post: {
        summary: 'Reagenda una cita existente',
        description: 'Reagenda una cita a una nueva fecha y hora usando el código de reserva. Elimina el evento anterior del calendario, crea uno nuevo, actualiza los datos en PostgreSQL y envía correo de confirmación.',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['codigo_reserva', 'fecha_reagendada', 'hora_reagendada'],
                properties: {
                  codigo_reserva: { 
                    type: 'string', 
                    example: 'ABC123',
                    description: 'Código de reserva de la cita a reagendar'
                  },
                  fecha_reagendada: { 
                    type: 'string', 
                    example: '2025-10-20',
                    description: 'Nueva fecha en formato YYYY-MM-DD'
                  },
                  hora_reagendada: { 
                    type: 'string', 
                    example: '15:00',
                    description: 'Nueva hora en formato HH:MM (24h)'
                  }
                }
              }
            }
          }
        },
        responses: {
          '200': {
            description: 'Respuesta de reagendamiento',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    respuesta: { 
                      type: 'string',
                      example: '🔄 ¡Cita reagendada exitosamente! ✨\n\n📅 Detalles de tu nueva cita:\n• Fecha: lunes, 20 de octubre de 2025\n• Hora: 3:00 PM\n• Cliente: Juan Pérez\n• Servicio: Consulta de valoración\n• Especialista: Dr. Juan\n\n🎟️ TU CÓDIGO DE RESERVA: ABC123'
                    }
                  }
                }
              }
            }
          }
        }
      }
    },
    '/api/confirma-cita': {
      post: {
        summary: 'Confirma una cita existente',
        description: 'Confirma la asistencia del cliente a una cita programada usando el código de reserva. Actualiza el estado de la cita a CONFIRMADA en PostgreSQL.',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['codigo_reserva'],
                properties: {
                  codigo_reserva: { 
                    type: 'string', 
                    example: 'ABC123',
                    description: 'Código de reserva de la cita a confirmar'
                  }
                }
              }
            }
          }
        },
        responses: {
          '200': {
            description: 'Respuesta de confirmación',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    respuesta: { 
                      type: 'string',
                      example: '✅ ¡Cita confirmada exitosamente! 🎉\n\n📅 Detalles de tu cita:\n• Fecha: lunes, 20 de octubre de 2025\n• Hora: 3:00 PM\n• Cliente: Juan Pérez\n• Servicio: Consulta de valoración\n• Especialista: Dr. Juan\n\n🎟️ Código de reserva: ABC123'
                    }
                  }
                }
              }
            }
          }
        },
        tags: ['Citas']
      }
    },
    '/api/carga-datos-iniciales': {
      get: {
        summary: 'Carga datos iniciales y busca cliente',
        description: 'Devuelve fecha/hora actual e información del cliente si existe en la base de datos',
        parameters: [
          {
            name: 'celular',
            in: 'query',
            required: true,
            description: 'Número de celular del cliente',
            schema: { type: 'string', example: '5551234567' }
          }
        ],
        responses: {
          '200': {
            description: 'Datos iniciales cargados',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    fechaHora: { type: 'string', example: 'martes, 26 de agosto de 2025, 17:25:48 GMT-5' },
                    timestamp: { type: 'integer', example: 1756247148133 },
                    isoString: { type: 'string', example: '2025-08-26T22:25:48.133Z' },
                    informacionClientePrompt: { type: 'string', example: 'El cliente se llama Juan, su correo electrónico es juan@ejemplo.com y su número de celular es 5551234567', nullable: true },
                    clienteExiste: { type: 'boolean', example: true },
                    datosCliente: { 
                      type: 'object',
                      nullable: true,
                      properties: {
                        primerNombre: { type: 'string', example: 'Juan' },
                        correo: { type: 'string', example: 'juan@ejemplo.com' },
                        celular: { type: 'string', example: '5551234567' }
                      }
                    }
                  }
                }
              }
            }
          },
          '400': {
            description: 'Parámetro celular faltante',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    error: { type: 'string', example: 'Parámetro "celular" es obligatorio' },
                    ejemplo: { type: 'string', example: '/api/carga-datos-iniciales?celular=5551234567' }
                  }
                }
              }
            }
          }
        }
      }
    },
    '/api/eventos/{fecha}': {
      get: {
        summary: 'Lista eventos de una fecha específica',
        description: 'Muestra todos los eventos del calendario para una fecha específica (útil para debug)',
        parameters: [
          {
            name: 'fecha',
            in: 'path',
            required: true,
            description: 'Fecha a consultar en formato YYYY-MM-DD',
            schema: { type: 'string', example: '2025-08-26' }
          }
        ],
        responses: {
          '200': {
            description: 'Lista de eventos encontrados',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    respuesta: { 
                      type: 'string',
                      example: '📅 EVENTOS DEL 2025-08-26\n📊 Calendar: 8cd456ed37480f3eb747c5bc0eb4c9...\n🔢 Total eventos: 2\n\n📋 LISTA DE EVENTOS:\n\n1. 14:00 - "Cita: Juan Pérez"\n   ID: abc123...\n   Creador: servicio@ejemplo.com\n\n🎯 EVENTOS A LAS 18:00: 0'
                    }
                  }
                }
              }
            }
          }
        }
      }
    },
    '/api/debug-agenda': {
      post: {
        summary: 'Debug del proceso de agendamiento',
        description: 'Endpoint de diagnóstico para identificar problemas paso a paso en el proceso de agendamiento',
        requestBody: {
          required: false,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  date: { 
                    type: 'string', 
                    example: '2025-12-01',
                    description: 'Fecha de prueba (opcional, por defecto: 2025-12-01)'
                  },
                  time: { 
                    type: 'string', 
                    example: '15:00',
                    description: 'Hora de prueba (opcional, por defecto: 15:00)'
                  },
                  calendar: { 
                    type: 'string', 
                    example: '1',
                    description: 'Calendario de prueba (opcional, por defecto: 1)'
                  },
                  service: { 
                    type: 'string', 
                    example: '1',
                    description: 'Servicio de prueba (opcional, por defecto: 1)'
                  }
                }
              }
            }
          }
        },
        responses: {
          '200': {
            description: 'Respuesta de debug detallada',
            content: {
              'application/json': {
                schema: {
                  oneOf: [
                    {
                      title: 'Debug Exitoso',
                      type: 'object',
                      properties: {
                        debug: { 
                          type: 'string',
                          description: 'Log detallado de cada paso del proceso'
                        },
                        success: { 
                          type: 'boolean',
                          example: true 
                        },
                        codigo: { 
                          type: 'string',
                          example: 'ABC123',
                          description: 'Código de prueba generado'
                        }
                      }
                    },
                    {
                      title: 'Debug con Error',
                      type: 'object',
                      properties: {
                        debug: { 
                          type: 'string',
                          description: 'Log detallado mostrando dónde falló el proceso'
                        }
                      }
                    }
                  ]
                }
              }
            }
          }
        }
      }
    },
    '/api/debug-mysql': {
      post: {
        summary: 'Diagnóstico de base de datos (PostgreSQL)',
        description: 'Endpoint para verificar la conexión y configuración de PostgreSQL',
        requestBody: {
          required: false,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  // No se requieren parámetros para el diagnóstico básico
                }
              }
            }
          }
        },
        responses: {
          '200': {
            description: 'Respuesta de diagnóstico de PostgreSQL',
            content: {
              'application/json': {
                schema: {
                  oneOf: [
                    {
                      title: 'PostgreSQL Funcionando',
                      type: 'object',
                      properties: {
                        debug: { 
                          type: 'string',
                          description: 'Log detallado de la conexión y verificación'
                        },
                        success: { 
                          type: 'boolean',
                          example: true 
                        }
                      }
                    },
                    {
                      title: 'PostgreSQL con Problemas',
                      type: 'object',
                      properties: {
                        debug: { 
                          type: 'string',
                          description: 'Log detallado mostrando dónde falló la conexión'
                        }
                      }
                    }
                  ]
                }
              }
            }
          }
        }
      }
    },
    '/api/consulta-datos-paciente': {
      get: {
        summary: 'Consultar datos de paciente por número telefónico',
        description: 'Busca información del paciente en PostgreSQL usando el número de teléfono. Devuelve solo el primer nombre del cliente.',
        parameters: [
          {
            name: 'telefono',
            in: 'query',
            required: true,
            description: 'Número de teléfono del paciente',
            schema: { type: 'string', example: '5551234567' }
          }
        ],
        responses: {
          '200': {
            description: 'Respuesta exitosa con datos del paciente',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    success: { type: 'boolean', example: true },
                    message: { type: 'string', example: '✅ Se encontró 1 registro para el teléfono 5551234567' },
                    data: {
                      type: 'array',
                      items: {
                        type: 'object',
                        properties: {
                          primerNombre: { type: 'string', example: 'Juan' },
                          correoElectronico: { type: 'string', example: 'juan.perez@ejemplo.com' },
                          telefono: { type: 'string', example: '5551234567' },
                          fechaUltimaRegistro: { type: 'string', example: '2026-02-08T03:17:19.000Z' }
                        }
                      }
                    },
                    totalRegistros: { type: 'integer', example: 1 }
                  }
                }
              }
            }
          }
        }
      }
    },
    '/api/test-alternativos/{fecha}': {
      get: {
        summary: 'Probar búsqueda de días alternativos',
        description: 'Endpoint de prueba para verificar el comportamiento de la búsqueda de días alternativos cuando no hay disponibilidad para la fecha solicitada',
        parameters: [
          {
            name: 'fecha',
            in: 'path',
            required: true,
            description: 'Fecha en formato YYYY-MM-DD para probar días alternativos',
            schema: { type: 'string', example: '2025-09-26' }
          },
          {
            name: 'calendar',
            in: 'query',
            required: false,
            description: 'Número identificador del calendario (por defecto: 1)',
            schema: { type: 'integer', example: 1, default: 1 }
          },
          {
            name: 'service',
            in: 'query',
            required: false,
            description: 'Número identificador del servicio (por defecto: 1)',
            schema: { type: 'integer', example: 1, default: 1 }
          }
        ],
        responses: {
          '200': {
            description: 'Respuesta exitosa con días alternativos encontrados',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    test: { type: 'string', example: '✅ DÍAS ALTERNATIVOS ENCONTRADOS' },
                    fechaObjetivo: { type: 'string', example: '2025-09-26' },
                    diasEncontrados: { type: 'integer', example: 2 },
                    respuesta: { type: 'string', example: 'No tengo disponibilidad para *Jueves 26 De Septiembre De 2025* (2025-09-26), pero sí tengo para estos días:\n\n🟢 *VIERNES* (2025-09-27)\n📅 1 día después • 5 horarios disponibles\n\nⒶ 10:00 AM\nⒷ 11:00 AM\nⒸ 12:00 PM\nⒹ 4:00 PM\nⒺ 5:00 PM' },
                    debug: { type: 'object' },
                    dateMapping: { type: 'object' }
                  }
                }
              }
            }
          },
          '400': {
            description: 'Fecha inválida',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    error: { type: 'string', example: 'Fecha inválida. Usar formato YYYY-MM-DD' }
                  }
                }
              }
            }
          }
        },
        tags: ['Debug/Testing']
      }
    },
    '/api/debug-martes-30': {
      get: {
        summary: 'Debug ultra específico para martes 30 septiembre',
        description: 'Endpoint de debug enfocado específicamente en diagnosticar por qué el martes 30 de septiembre no aparece en días alternativos. Compara checkDayAvailability vs generateHourlySlots y identifica problemas en la lógica.',
        responses: {
          '200': {
            description: 'Debug completo del martes 30 septiembre',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    debug: { type: 'string', example: '🔥 DEBUG MARTES 30 SEPTIEMBRE (2025-09-30)\n================================\n📅 Fecha objetivo: 2025-09-30 martes\n🌍 Zona horaria: America/Mexico_City\n...' },
                    fecha: { type: 'string', example: '2025-09-30' },
                    dayResult: { type: 'object', description: 'Resultado de checkDayAvailability' },
                    directSlots: { type: 'array', items: { type: 'string' }, example: ['10:00', '11:00', '16:00'] },
                    hasAvailabilityInResult: { type: 'boolean', example: true },
                    meetsMinimumSlots: { type: 'boolean', example: true }
                  }
                }
              }
            }
          }
        },
        tags: ['Debug/Testing']
      }
    }
  }
};

app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerDocument));

// =================================================================
// 🚀 INICIO DEL SERVIDOR
// =================================================================

// =================================================================
// 🔧 UTILIDADES PARA RAILWAY
// =================================================================

// Detectar URL de Railway automáticamente
const getServerUrl = () => {
  if (process.env.NODE_ENV === 'production') {
    if (process.env.RAILWAY_STATIC_URL) {
      return `https://${process.env.RAILWAY_STATIC_URL}`;
    } else if (process.env.RAILWAY_PUBLIC_DOMAIN) {
      return `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`;
    } else {
      return 'https://your-app.railway.app';
    }
  }
  return `http://localhost:${PORT}`;
};

// =================================================================
// ⏰ CRON JOBS - RECORDATORIOS AUTOMÁTICOS
// =================================================================

/**
 * Cron Job: Verificar citas próximas en 24 horas
 * Se ejecuta una vez al día a las 9 AM
 * Envía notificación 24h antes y permite confirmación
 */
cron.schedule('0 9 * * *', async () => {
  try {
    console.log('⏰ === CRON: VERIFICANDO CITAS PRÓXIMAS (24H) ===');
    console.log(`🕒 Ejecutado a las: ${moment().tz(config.timezone.default).format('YYYY-MM-DD HH:mm:ss')}`);
    
    const appointments = await getUpcomingAppointments24h();
    
    if (appointments.length === 0) {
      console.log('✅ No hay citas próximas en las siguientes 24 horas');
      return;
    }
    
    console.log(`📊 Citas encontradas: ${appointments.length}`);
    
    // Enviar recordatorios solo por WhatsApp
    for (const appointment of appointments) {
      console.log(`\n📤 Enviando recordatorio 24h a: ${appointment.clientName}`);
      console.log(`🎟️ Código de reserva: ${appointment.codigoReserva}`);

      // Enviar WhatsApp
      if (appointment.clientPhone) {
        const whatsappResult = await sendWhatsAppReminder24h(appointment);
        
        // Si WhatsApp se envió exitosamente, actualizar estado a RECORDADA
        if (whatsappResult.success) {
          console.log(`✅ WhatsApp enviado exitosamente. Actualizando estado a RECORDADA...`);
          await updateClientStatus(appointment.codigoReserva, 'RECORDADA');
          console.log(`✅ Estado actualizado: ${appointment.codigoReserva} -> RECORDADA`);
        } else {
          console.log(`⚠️ Error enviando WhatsApp: ${whatsappResult.error}`);
        }
      }
    }
    
    console.log('✅ Recordatorios de 24h enviados exitosamente');
    
  } catch (error) {
    console.error('❌ Error en cron de 24h:', error.message);
  }
});

/**
 * Cron Job: Verificar citas próximas en 15 minutos
 * Se ejecuta cada 5 minutos
 * Envía notificación 15 minutos antes de la cita
 */
cron.schedule('*/5 * * * *', async () => {
  try {
    console.log('⏰ === CRON: VERIFICANDO CITAS PRÓXIMAS (15 MIN) ===');
    console.log(`🕒 Ejecutado a las: ${moment().tz(config.timezone.default).format('YYYY-MM-DD HH:mm:ss')}`);
    
    const appointments = await getUpcomingAppointments15min();
    
    if (appointments.length === 0) {
      console.log('✅ No hay citas en los próximos 15 minutos');
      return;
    }
    
    console.log(`📊 Citas encontradas: ${appointments.length}`);
    
    // Enviar recordatorios por WhatsApp y Email
    for (const appointment of appointments) {
      console.log(`\n📤 Enviando recordatorio 15min a: ${appointment.clientName}`);
      console.log(`🎟️ Código de reserva: ${appointment.codigoReserva}`);

      // Enviar WhatsApp
      if (appointment.clientPhone) {
        const { generateWhatsAppMessage15min } = require('./services/reminderService');
        const message = generateWhatsAppMessage15min(appointment);
        const { sendWhatsAppMessage } = require('./services/whatsappService');
        const whatsappResult = await sendWhatsAppMessage(appointment.clientPhone, message);
        
        if (whatsappResult.success) {
          console.log(`✅ WhatsApp 15min enviado exitosamente a ${appointment.clientPhone}`);
        } else {
          console.log(`⚠️ Error enviando WhatsApp 15min: ${whatsappResult.error}`);
        }
      }

      // Enviar Email
      if (appointment.clientEmail) {
        try {
          const { sendReminder15min } = require('./services/emailService');
          if (sendReminder15min) {
            const emailResult = await sendReminder15min(appointment);
            if (emailResult && emailResult.success) {
              console.log(`✅ Email 15min enviado exitosamente a ${appointment.clientEmail}`);
            }
          }
        } catch (emailError) {
          console.log(`⚠️ Error enviando email 15min: ${emailError.message}`);
        }
      }
    }
    
    console.log('✅ Recordatorios de 15 minutos enviados');
    
  } catch (error) {
    console.error('❌ Error en cron de 15min:', error.message);
  }
});

console.log('✅ Cron jobs de recordatorios ACTIVADOS');
console.log('   - Recordatorio 24h: ACTIVADO (una vez al día a las 9 AM)');
console.log('   - Recordatorio 15min: ACTIVADO (cada 5 minutos)');

app.listen(PORT, () => {
  const serverUrl = getServerUrl();
  const isProduction = process.env.NODE_ENV === 'production';
  
  console.log(`🚀 Demo Asistente Fisio API ejecutándose en puerto ${PORT}`);
  console.log(`🌍 Entorno: ${isProduction ? 'PRODUCCIÓN (Railway)' : 'DESARROLLO'}`);
  console.log(`📚 Documentación disponible en: ${serverUrl}/api-docs`);
  console.log(`🌐 Endpoints disponibles:`);
  console.log(`   GET  ${serverUrl}/api/consulta-disponibilidad`);
  console.log(`   POST ${serverUrl}/api/agenda-cita`);
  console.log(`   POST ${serverUrl}/api/cancela-cita`);
  console.log(`   POST ${serverUrl}/api/reagenda-cita`);
  console.log(`   POST ${serverUrl}/api/confirma-cita`);
  console.log(`   GET  ${serverUrl}/api/carga-datos-iniciales?celular={numero}`);
  console.log(`   GET  ${serverUrl}/api/eventos/:fecha`);
  console.log(`   POST ${serverUrl}/api/debug-agenda`);
  console.log(`   POST ${serverUrl}/api/debug-mysql`);
  console.log(`   POST ${serverUrl}/api/test-email`);
      console.log(`   GET  ${serverUrl}/api/consulta-datos-paciente`);
  console.log(`   GET  ${serverUrl}/api/test-alternativos/:fecha`);
  console.log(`   GET  ${serverUrl}/api/debug-martes-30`);
  console.log(`   GET  ${serverUrl}/api/debug-dia/:fecha`);
  console.log(`   GET  ${serverUrl}/api/debug-busqueda-alternativos/:fecha`);
  console.log(`   GET  ${serverUrl}/api/debug-slots/:fecha`);
    console.log(`   GET  ${serverUrl}/api/debug-horarios/:fecha`);
  console.log(`\n🔧 Configuración:`);
  console.log(`   - Timezone: ${config.timezone.default}`);
  console.log(`   - PostgreSQL Database: ${config.postgres.database}`);
  console.log(`   - Google Auth: ${config.google.clientEmail ? '✅ Configurado' : '❌ Pendiente'}`);
  
  if (isProduction) {
    console.log(`\n⚠️  IMPORTANTE: Si ves "Failed to fetch" en Swagger:`);
    console.log(`   1. Verifica que NODE_ENV=production esté configurado en Railway`);
    console.log(`   2. Configura las variables de entorno de Google APIs`);
    console.log(`   3. Revisa los logs de Railway para más detalles`);
  }
}); 