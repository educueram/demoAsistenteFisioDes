/**
 * Configuración centralizada de la aplicación Demo Asistente Fisio API
 */

// Cargar variables de entorno desde .env
require('dotenv').config();

const config = {
  // Configuración del servidor
  server: {
    port: process.env.PORT || 3000,
    host: process.env.HOST || 'localhost'
  },

  // Configuración de MySQL
  mysql: {
    host: process.env.MYSQLHOST || 'localhost',
    port: parseInt(process.env.MYSQLPORT) || 3306,
    user: process.env.MYSQLUSER || 'root',
    password: process.env.MYSQLPASSWORD || '',
    database: process.env.MYSQLDATABASE || process.env.MYSQL_DATABASE || 'railway'
  },

  // Configuración del negocio
  business: {
    email: process.env.BUSINESS_EMAIL || 'pruebasmiptech@gmail.com',
    name: process.env.BUSINESS_NAME || 'Demo Asistente Fisio',
    phone: process.env.BUSINESS_PHONE || '+52 5555555555',
    address: process.env.BUSINESS_ADDRESS || 'CDMX, México'
  },

  // Configuración de zona horaria
  timezone: {
    default: process.env.TIMEZONE || 'America/Mexico_City'
  },

  // Configuración de Google APIs (solo Calendar)
  google: {
    privateKey: process.env.GOOGLE_PRIVATE_KEY ? process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n') : '',
    clientEmail: process.env.GOOGLE_CLIENT_EMAIL || 'demosmiptech@demos-474116.iam.gserviceaccount.com',
    projectId: process.env.GOOGLE_PROJECT_ID || 'demos-474116',
    scopes: [
      'https://www.googleapis.com/auth/calendar'
    ]
  },

  // Configuración de email
  email: {
    smtp: {
      host: process.env.SMTP_HOST || 'smtp.gmail.com',
      port: parseInt(process.env.SMTP_PORT) || 587,
      secure: false,
      auth: {
        user: process.env.SMTP_USER || '',
        pass: process.env.SMTP_PASS || ''
      }
    }
  },

  // Nombres de tablas MySQL
  tables: {
    calendars: 'Calendario',
    hours: 'Horarios', 
    services: 'Servicios',
    clients: 'Clientes',
    appointments: 'Citas',
    specialists: 'Especialistas'
  },

  // Configuración de WhatsApp Bot (migrada desde BBC_CONFIG)
  whatsapp: {
    apiUrl: process.env.BBC_API_URL || 'https://app.builderbot.cloud/api/v2/549e20a4-3157-4f1a-b23a-f51b98052281/messages',
    apiKey: process.env.BBC_API_KEY || 'bb-61468363-0112-4d0d-8732-d2977c0c84ec'
  },

  // Configuración de SMTP para emails
  smtp: {
    host: process.env.SMTP_HOST || 'smtp.gmail.com',
    port: parseInt(process.env.SMTP_PORT) || 587,
    user: process.env.SMTP_USER || 'pruebasmiptech@gmail.com',
    pass: process.env.SMTP_PASS || '' // Debe ser App Password de Gmail
  },

  // Configuración de horarios de trabajo
  workingHours: {
    forceFixedSchedule: process.env.FORCE_FIXED_SCHEDULE === 'true' || process.env.NODE_ENV === 'production',
    startHour: parseInt(process.env.WORKING_START_HOUR) || 10,
    endHour: parseInt(process.env.WORKING_END_HOUR) || 18,
    lunchStartHour: parseInt(process.env.LUNCH_START_HOUR) || 14,
    lunchEndHour: parseInt(process.env.LUNCH_END_HOUR) || 15,
    slotIntervalMinutes: parseInt(process.env.SLOT_INTERVAL_MINUTES) || 60,
    
    saturday: {
      enabled: true,
      startHour: 10,
      endHour: 14,
      hasLunch: false
    },
    sunday: {
      enabled: process.env.SUNDAY_ENABLED === 'true' || false
    }
  },

  validation: {
    minBookingHours: 1,
    maxDaysAhead: 90,
    emailRegex: /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/,
    phoneMinLength: 10
  }
};

module.exports = config;
