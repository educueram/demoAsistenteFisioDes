const moment = require('moment-timezone');
const config = require('../config');
const { getUpcomingAppointments24h, getUpcomingAppointments15min } = require('./dataService');
const { sendReminder24h } = require('./emailService');

/**
 * Servicio de Recordatorios Automáticos
 * Envía notificaciones de citas próximas por email y WhatsApp
 */

/**
 * Enviar recordatorio por email (24 horas antes)
 */
async function sendEmailReminder24h(appointment) {
  try {
    console.log(`📧 Enviando recordatorio 24h a: ${appointment.clientEmail}`);
    
    const result = await sendReminder24h(appointment);
    
    if (result.success) {
      console.log(`✅ Email de recordatorio 24h enviado exitosamente a: ${appointment.clientEmail}`);
      return true;
    } else {
      console.log(`⚠️ No se pudo enviar recordatorio 24h: ${result.reason || result.error}`);
      return false;
    }

  } catch (error) {
    console.error(`❌ Error enviando email 24h:`, error.message);
    return false;
  }
}

/**
 * Formatear hora a formato 12 horas
 */
function formatTimeTo12Hour(timeString) {
  if (!timeString || typeof timeString !== 'string') {
    return timeString;
  }
  
  const parts = timeString.split(':');
  if (parts.length < 2) {
    return timeString;
  }
  
  const hour24 = parseInt(parts[0]);
  const minutes = parts[1];
  
  if (isNaN(hour24)) {
    return timeString;
  }
  
  if (hour24 === 0) {
    return `12:${minutes} AM`;
  } else if (hour24 < 12) {
    return `${hour24}:${minutes} AM`;
  } else if (hour24 === 12) {
    return `12:${minutes} PM`;
  } else {
    return `${hour24 - 12}:${minutes} PM`;
  }
}

/**
 * Generar mensaje de WhatsApp para recordatorio de 24h
 */
function generateWhatsAppMessage24h(appointment) {
  const fechaFormateada = moment.tz(appointment.fechaCita, config.timezone.default).format('dddd, D [de] MMMM [de] YYYY');
  const horaFormateada = formatTimeTo12Hour(appointment.horaCita);
  
  return `🔔 *Recordatorio de Cita*

Hola *${appointment.clientName}*,

Te recordamos que tienes una cita programada para *mañana*:

📅 *Fecha:* ${fechaFormateada}
⏰ *Hora:* ${horaFormateada}
👨‍⚕️ *Con:* ${appointment.profesionalName}
🩺 *Servicio:* ${appointment.serviceName}
🎟️ *Código:* ${appointment.codigoReserva}

⚠️ *¿Deseas confirmar tu asistencia?*

Responde con:
• 1️⃣ *CONFIRMAR* - Para confirmar tu asistencia
• 2️⃣ *REAGENDAR* - Si necesitas cambiar la fecha/hora

📍 ${config.business.address}

¡Te esperamos! 🌟`;
}

/**
 * Generar mensaje de WhatsApp para recordatorio de 15 minutos
 */
function generateWhatsAppMessage15min(appointment) {
  const horaFormateada = formatTimeTo12Hour(appointment.horaCita);
  
  return `⏰ *¡Tu cita es en 15 minutos!*

Hola *${appointment.clientName}*,

Te recordamos que tu cita está por comenzar:

⏰ *Hora:* ${horaFormateada}
👨‍⚕️ *Con:* ${appointment.profesionalName}
🩺 *Servicio:* ${appointment.serviceName}
🎟️ *Código:* ${appointment.codigoReserva}

📍 ${config.business.address}

¡Te esperamos! 🌟`;
}

module.exports = {
  getUpcomingAppointments24h,
  getUpcomingAppointments15min,
  sendEmailReminder24h,
  generateWhatsAppMessage24h,
  generateWhatsAppMessage15min
};
