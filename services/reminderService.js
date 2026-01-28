const moment = require('moment-timezone');
const config = require('../config');
const { getSheetsInstance } = require('./googleAuth');
const { sendReminder24h } = require('./emailService');

/**
 * Servicio de Recordatorios Automáticos
 * Envía notificaciones de citas próximas por email y WhatsApp
 */

/**
 * Obtener citas próximas en las siguientes 24 horas
 */
async function getUpcomingAppointments24h() {
  try {
    console.log('🔍 === BUSCANDO CITAS PRÓXIMAS (24 HORAS) ===');
    
    const sheets = await getSheetsInstance();
    const now = moment().tz(config.timezone.default);
    const in23Hours = now.clone().add(23, 'hours');
    const in25Hours = now.clone().add(25, 'hours');
    
    console.log(`⏰ Ahora: ${now.format('YYYY-MM-DD HH:mm')}`);
    console.log(`⏰ Ventana de recordatorio: ${in23Hours.format('YYYY-MM-DD HH:mm')} a ${in25Hours.format('YYYY-MM-DD HH:mm')}`);
    
    // Obtener todos los datos de la hoja CLIENTES
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: config.business.sheetId,
      range: config.sheets.clients
    });

    const data = response.data.values || [];
    
    if (data.length <= 1) {
      console.log('⚠️ No hay datos en la hoja CLIENTES');
      return [];
    }

    const upcomingAppointments = [];
    
    // Buscar citas próximas (excluir header)
    for (let i = 1; i < data.length; i++) {
      const row = data[i];
      const estado = row[9]; // ESTADO
      const fechaCita = row[6]; // FECHA_CITA
      const horaCita = row[7]; // HORA_CITA
      
      console.log(`🔍 Revisando fila ${i}: ${row[2]} - Fecha: ${fechaCita} Hora: ${horaCita} Estado: ${estado}`);
      
      // Solo enviar recordatorio de 24h si el estado es AGENDADA o REAGENDADA
      if (estado !== 'AGENDADA' && estado !== 'REAGENDADA') {
        console.log(`   ⏭️ Saltando: estado "${estado}" no válido para recordatorio 24h (solo AGENDADA o REAGENDADA)`);
        continue;
      }
      
      console.log(`   ✅ Estado válido para recordatorio: ${estado}`);
      
      // Verificar que tenga fecha y hora
      if (!fechaCita || !horaCita) {
        console.log(`   ⏭️ Saltando: falta fecha u hora`);
        continue;
      }
      
      // Crear momento de la cita
      const appointmentTime = moment.tz(`${fechaCita} ${horaCita}`, 'YYYY-MM-DD HH:mm', config.timezone.default);
      
      if (!appointmentTime.isValid()) {
        console.log(`   ⚠️ Fecha/hora inválida: ${fechaCita} ${horaCita}`);
        continue;
      }
      
      const hoursUntil = appointmentTime.diff(now, 'hours', true);
      console.log(`   ⏱️ Horas hasta la cita: ${hoursUntil.toFixed(2)}`);
      
      // Verificar si está entre 23 y 25 horas en el futuro (ventana de 24h)
      if (hoursUntil >= 23 && hoursUntil <= 25) {
        upcomingAppointments.push({
          codigoReserva: row[1],
          clientName: row[2],
          clientPhone: row[3],
          clientEmail: row[4],
          profesionalName: row[5],
          fechaCita: row[6],
          horaCita: row[7],
          serviceName: row[8],
          estado: row[9],
          appointmentTime: appointmentTime,
          hoursUntil: Math.round(hoursUntil)
        });
        
        console.log(`✅ ¡CITA ENCONTRADA! ${row[2]} - ${fechaCita} ${horaCita} (en ${hoursUntil.toFixed(1)} horas)`);
      } else if (hoursUntil > 0 && hoursUntil < 23) {
        console.log(`   ⏭️ Cita muy próxima (${hoursUntil.toFixed(1)}h) - recordatorio ya debió enviarse o se enviará el de 15min`);
      } else if (hoursUntil > 25) {
        console.log(`   ⏭️ Cita lejana (${hoursUntil.toFixed(1)}h) - aún no es tiempo de recordatorio de 24h`);
      } else {
        console.log(`   ⏭️ Cita en el pasado`);
      }
    }

    console.log(`\n📊 Total citas próximas (24h): ${upcomingAppointments.length}`);
    return upcomingAppointments;

  } catch (error) {
    console.error('❌ Error obteniendo citas próximas (24h):', error.message);
    return [];
  }
}


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

module.exports = {
  getUpcomingAppointments24h,
  sendEmailReminder24h,
  generateWhatsAppMessage24h
};

