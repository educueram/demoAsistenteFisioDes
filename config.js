/**
 * Configuración centralizada de la aplicación ValGop API
 * Migrada desde Google Apps Script
 */

// Cargar variables de entorno desde .env
require('dotenv').config();

const config = {
  // Configuración del servidor
  server: {
    port: process.env.PORT || 3000,
    host: process.env.HOST || 'localhost'
  },

  // Configuración del negocio (migrada desde BUSINESS_CONFIG)
  business: {
    sheetId: process.env.GOOGLE_SHEET_ID || '1zQpN_1MAQVx6DrYwbL8zK49Wv5xu4eDlGqTjKl9d-JU',
    email: process.env.BUSINESS_EMAIL || 'goparirisvaleria@gmail.com',
    name: process.env.BUSINESS_NAME || 'Clinica ValGop',
    phone: process.env.BUSINESS_PHONE || '+52 5555555555',
    address: process.env.BUSINESS_ADDRESS || 'CDMX, México'
  },

  // Configuración de zona horaria
  timezone: {
    default: process.env.TIMEZONE || 'America/Mexico_City'
  },

  // Configuración de Google APIs
  google: {
    privateKey: process.env.GOOGLE_PRIVATE_KEY ? process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n') : '',
    clientEmail: process.env.GOOGLE_CLIENT_EMAIL || '',
    projectId: process.env.GOOGLE_PROJECT_ID || '',
    scopes: [
      'https://www.googleapis.com/auth/spreadsheets',
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

  // Nombres de las hojas de Google Sheets (migrado desde SHEETS)
  sheets: {
    calendars: 'CALENDARIOS',
    hours: 'HORARIOS', 
    services: 'SERVICIOS',
    clients: 'CLIENTES'
  },

  // Configuración de WhatsApp Bot (migrada desde BBC_CONFIG)
  whatsapp: {
    apiUrl: process.env.BBC_API_URL || 'https://app.builderbot.cloud/api/v2/016cda39-512b-4e2a-a753-ae3bda6d0bd8/messages',
    apiKey: process.env.BBC_API_KEY || 'bb-19a33158-6305-4629-8405-1b2622e4d72e'
  },

  // Configuraciones de validación
  // Configuración de SMTP para emails
  smtp: {
    host: process.env.SMTP_HOST || 'smtp.gmail.com',
    port: parseInt(process.env.SMTP_PORT) || 587,
    user: process.env.SMTP_USER || 'goparirisvaleria@gmail.com',
    pass: process.env.SMTP_PASS || '' // Debe ser App Password de Gmail
  },

  // Configuración de horarios de trabajo (NUEVA)
  workingHours: {
    // Forzar horarios específicos (independiente de Google Sheets)
    forceFixedSchedule: process.env.FORCE_FIXED_SCHEDULE === 'true' || process.env.NODE_ENV === 'production',
    startHour: parseInt(process.env.WORKING_START_HOUR) || 10,   // 10 AM (SI O SI)
    endHour: parseInt(process.env.WORKING_END_HOUR) || 19,     // 7 PM (SI O SI)
    lunchStartHour: parseInt(process.env.LUNCH_START_HOUR) || 14, // 2 PM
    lunchEndHour: parseInt(process.env.LUNCH_END_HOUR) || 15,     // 3 PM
    slotIntervalMinutes: parseInt(process.env.SLOT_INTERVAL_MINUTES) || 60, // 1 hora (sesiones de hora por hora)
    
    // Horarios especiales por día de la semana
    saturday: {
      enabled: true,
      startHour: parseInt(process.env.SATURDAY_START_HOUR) || 10, // 10 AM (SI O SI)
      endHour: parseInt(process.env.SATURDAY_END_HOUR) || 13,     // 1 PM (13:00) (SI O SI)
      hasLunch: false // No hay horario de comida los sábados
    },
    sunday: {
      enabled: process.env.SUNDAY_ENABLED === 'true' || false // Domingos cerrado por defecto
    }
  },

  validation: {
    minBookingHours: 1, // Mínimo 1 hora de anticipación
    maxDaysAhead: 90,   // Máximo 90 días en el futuro
    emailRegex: /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/,
    phoneMinLength: 10
  }
};

module.exports = config; 