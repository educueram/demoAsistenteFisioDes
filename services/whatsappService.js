const axios = require('axios');
const config = require('../config');

/**
 * Servicio de WhatsApp usando BuilderBot Cloud API
 */

/**
 * Enviar mensaje de WhatsApp
 * @param {string} phone - Número de teléfono (con código de país)
 * @param {string} message - Mensaje a enviar
 * @returns {Promise<{success: boolean, data?: any, error?: string}>}
 */
async function sendWhatsAppMessage(phone, message) {
  try {
    console.log('📱 === ENVIANDO MENSAJE DE WHATSAPP ===');
    console.log('📞 Teléfono:', phone);
    console.log('💬 Mensaje:', message.substring(0, 100) + '...');

    if (!config.whatsapp.apiUrl || !config.whatsapp.apiKey) {
      console.log('⚠️ API de WhatsApp no configurada');
      return { 
        success: false, 
        error: 'WhatsApp API no configurada' 
      };
    }

    // Limpiar y formatear número
    const numeroLimpio = phone.replace(/\D/g, '');
    console.log('📞 Número limpio:', numeroLimpio);

    let numeroFinal = numeroLimpio;
    if (!numeroFinal.startsWith('52') && numeroFinal.length === 10) {
      numeroFinal = '52' + numeroFinal;
    }
    console.log('📞 Número final:', numeroFinal);

    // Construir payload según el formato de BuilderBot
    const payload = {
      messages: { content: message },
      number: numeroFinal,
      checkIfExists: false
    };

    console.log('📦 Payload:', JSON.stringify(payload, null, 2));

    // Configurar opciones de la petición
    const options = {
      method: 'POST',
      url: config.whatsapp.apiUrl,
      headers: {
        'Content-Type': 'application/json',
        'x-api-builderbot': config.whatsapp.apiKey
      },
      data: payload,
      timeout: 30000 // 30 segundos timeout
    };

    console.log('📤 API URL:', config.whatsapp.apiUrl);
    console.log('🔑 API Key (primeros 10 chars):', config.whatsapp.apiKey ? config.whatsapp.apiKey.substring(0, 10) + '...' : 'NO CONFIGURADO');

    // Realizar petición
    console.log('🔄 Realizando petición HTTP...');
    const response = await axios(options);

    console.log('✅ Response Status:', response.status);
    console.log('📊 Response Data:', response.data);

    if (response.status === 200 || response.status === 201) {
      console.log('✅ Mensaje de WhatsApp enviado exitosamente');
      return { 
        success: true, 
        data: response.data,
        status: response.status
      };
    } else {
      console.error('❌ Error en petición');
      return { 
        success: false, 
        error: `Error ${response.status}: ${JSON.stringify(response.data)}`
      };
    }

  } catch (error) {
    console.error('❌ Error en sendWhatsAppMessage:', error);
    
    let errorMessage = 'Error de conexión';
    if (error.response) {
      errorMessage = `Error ${error.response.status}: ${JSON.stringify(error.response.data)}`;
      console.error('📛 Response error:', error.response.data);
    } else if (error.request) {
      errorMessage = 'No se recibió respuesta del servidor';
      console.error('📛 Request error: No response');
    } else {
      errorMessage = error.message;
      console.error('📛 Error:', error.message);
    }

    return { 
      success: false, 
      error: errorMessage,
      debug: {
        errorType: error.name,
        errorMessage: error.message,
        hasResponse: !!error.response,
        hasRequest: !!error.request
      }
    };
  }
}

/**
 * Enviar recordatorio de cita por WhatsApp (24 horas antes)
 */
async function sendWhatsAppReminder24h(appointment) {
  try {
    const message = generateWhatsAppMessage24h(appointment);
    return await sendWhatsAppMessage(appointment.clientPhone, message);
  } catch (error) {
    console.error('❌ Error enviando recordatorio WhatsApp 24h:', error.message);
    return { success: false, error: error.message };
  }
}

/**
 * Generar mensaje de WhatsApp para recordatorio de 24h
 */
function generateWhatsAppMessage24h(appointment) {
  const moment = require('moment-timezone');
  moment.locale('es');
  
  const fechaFormateada = moment.tz(appointment.fechaCita, config.timezone.default).format('dddd, D [de] MMMM [de] YYYY');
  const horaFormateada = formatTimeTo12Hour(appointment.horaCita);
  
  const serverUrl = process.env.NODE_ENV === 'production' ? 
                    (process.env.RAILWAY_STATIC_URL ? `https://${process.env.RAILWAY_STATIC_URL}` : `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`) : 
                    `http://localhost:${config.server.port}`;
  
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

module.exports = {
  sendWhatsAppMessage,
  sendWhatsAppReminder24h,
  generateWhatsAppMessage24h
};

