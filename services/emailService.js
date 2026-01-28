const nodemailer = require('nodemailer');
const config = require('../config');
const moment = require('moment-timezone');
const { formatTimeTo12Hour } = require('./googleCalendar');

// Configurar moment en español
moment.locale('es');

/**
 * Servicio de envío de emails
 * Para confirmaciones de citas
 */

// Configurar transporter de nodemailer
let transporter = null;

function initializeEmailService() {
  try {
    console.log('🔧 === INICIALIZANDO SERVICIO DE EMAIL ===');
    console.log('SMTP_HOST:', config.smtp.host);
    console.log('SMTP_PORT:', config.smtp.port);
    console.log('SMTP_USER:', config.smtp.user ? '✅ Configurado' : '❌ Vacío');
    console.log('SMTP_USER_VALUE:', config.smtp.user); // Mostrar el valor exacto
    console.log('SMTP_PASS:', config.smtp.pass ? '✅ Configurado' : '❌ Vacío');
    console.log('SMTP_PASS_LENGTH:', config.smtp.pass ? config.smtp.pass.length + ' caracteres' : '0');
    console.log('SMTP_PASS_PREVIEW:', config.smtp.pass ? config.smtp.pass.substring(0, 4) + '****' + config.smtp.pass.substring(config.smtp.pass.length - 4) : 'VACÍO');

    // Validación más estricta
    if (!config.smtp.host || !config.smtp.user || !config.smtp.pass || 
        config.smtp.user.trim() === '' || config.smtp.pass.trim() === '') {
      console.log('⚠️ SMTP no configurado completamente - emails deshabilitados');
      console.log('💡 Para habilitar emails, configura:');
      console.log('   SMTP_USER=goparirisvaleria@gmail.com');
      console.log('   SMTP_PASS=tu-app-password-de-16-caracteres');
      return false;
    }

    transporter = nodemailer.createTransport({
      host: config.smtp.host,
      port: config.smtp.port,
      secure: config.smtp.port === 465, // true para puerto 465, false para otros
      auth: {
        user: config.smtp.user,
        pass: config.smtp.pass
      }
    });

    console.log('✅ Servicio de email inicializado correctamente');
    console.log('📧 Emails se enviarán desde:', config.smtp.user);

    // Test de conexión SMTP
    console.log('🔍 === PROBANDO CONEXIÓN SMTP ===');
    transporter.verify((error, success) => {
      if (error) {
        console.error('❌ ERROR DE CONEXIÓN SMTP:', error.message);
        if (error.message.includes('Username and Password not accepted')) {
          console.error('🚨 PROBLEMA: App Password de Gmail inválido');
          console.error('💡 SOLUCIÓN: Regenera el App Password en Gmail');
          console.error('   1. Ve a https://myaccount.google.com');
          console.error('   2. Seguridad → Contraseñas de aplicaciones');
          console.error('   3. ELIMINA la anterior y crea una NUEVA');
          console.error('   4. Usa los 16 caracteres SIN ESPACIOS');
        }
      } else {
        console.log('✅ CONEXIÓN SMTP EXITOSA - Ready to send emails');
      }
    });

    return true;
  } catch (error) {
    console.error('❌ Error inicializando servicio de email:', error.message);
    return false;
  }
}

/**
 * Enviar email de confirmación de cita
 */
async function sendAppointmentConfirmation(appointmentData) {
  try {
    if (!transporter) {
      console.log('📧 Email no configurado - saltando envío');
      return { success: false, reason: 'SMTP no configurado' };
    }

    // Verificar que tenemos credenciales válidas
    if (!config.smtp.pass || config.smtp.pass.trim() === '') {
      console.log('⚠️ SMTP_PASS vacío - necesitas configurar App Password de Gmail');
      return { success: false, reason: 'SMTP_PASS no configurado' };
    }

    const { 
      clientName, 
      clientEmail, 
      date, 
      time, 
      serviceName, 
      profesionalName, 
      codigoReserva 
    } = appointmentData;

    // Formatear fecha en español
    const fechaFormateada = moment.tz(date, config.timezone.default).format('dddd, D [de] MMMM [de] YYYY');
    const horaFormateada = formatTimeTo12Hour(time);

    const emailContent = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; background-color: #f8f9fa;">
      <div style="background-color: white; padding: 30px; border-radius: 10px; box-shadow: 0 2px 10px rgba(0,0,0,0.1);">
        
        <div style="text-align: center; margin-bottom: 30px;">
          <h1 style="color: #28a745; margin: 0;">✅ Cita Confirmada</h1>
          <p style="color: #6c757d; margin: 5px 0;">Tu cita ha sido agendada exitosamente</p>
        </div>

        <div style="background-color: #e8f5e9; padding: 20px; border-radius: 8px; margin-bottom: 20px;">
          <h2 style="color: #2e7d32; margin-top: 0;">📅 Detalles de tu Cita</h2>
          <p><strong>👤 Cliente:</strong> ${clientName}</p>
          <p><strong>📅 Fecha:</strong> ${fechaFormateada}</p>
          <p><strong>⏰ Hora:</strong> ${horaFormateada}</p>
          <p><strong>👨‍⚕️ Especialista:</strong> ${profesionalName}</p>
          <p><strong>🩺 Servicio:</strong> ${serviceName}</p>
          <p><strong>🎟️ Código de Reserva:</strong> <span style="font-size: 18px; font-weight: bold; color: #d32f2f;">${codigoReserva}</span></p>
        </div>

        <div style="background-color: #fff3e0; padding: 15px; border-radius: 8px; margin-bottom: 20px;">
          <h3 style="color: #ef6c00; margin-top: 0;">⚠️ Importante</h3>
          <ul style="margin: 0; padding-left: 20px;">
            <li>Llega 10 minutos antes de tu cita</li>
            <li>Guarda tu código de reserva: <strong>${codigoReserva}</strong></li>
            <li>Si necesitas cancelar, contacta con al menos 2 horas de anticipación</li>
          </ul>
        </div>

        <div style="text-align: center; margin-top: 30px;">
          <p style="color: #6c757d; margin: 0;">
            <strong>${config.business.name}</strong><br>
            📞 ${config.business.phone}<br>
            📧 ${config.business.email}<br>
            📍 ${config.business.address}
          </p>
        </div>

      </div>
    </div>
    `;

    const mailOptions = {
      from: `"${config.business.name}" <${config.smtp.user}>`,
      to: clientEmail,
      subject: `✅ Cita Confirmada - ${fechaFormateada} a las ${horaFormateada} - Código: ${codigoReserva}`,
      html: emailContent
    };

    console.log('📧 === ENVIANDO EMAIL DE CONFIRMACIÓN ===');
    console.log('Para:', clientEmail);
    console.log('Asunto:', mailOptions.subject);

    const result = await transporter.sendMail(mailOptions);
    console.log('✅ Email enviado exitosamente:', result.messageId);

    return { 
      success: true, 
      messageId: result.messageId,
      to: clientEmail 
    };

  } catch (error) {
    console.error('❌ Error enviando email:', error.message);
    
    // Errores específicos de Gmail
    if (error.message.includes('Username and Password not accepted')) {
      console.error('🔐 PROBLEMA DE CREDENCIALES:');
      console.error('   1. Verifica que SMTP_USER sea: goparirisvaleria@gmail.com');
      console.error('   2. SMTP_PASS debe ser un App Password de Gmail (16 caracteres)');
      console.error('   3. Ve a https://myaccount.google.com → Seguridad → Contraseñas de aplicaciones');
      console.error('   4. Genera una nueva contraseña de aplicación para "Mail"');
    }
    
    return { 
      success: false, 
      error: error.message 
    };
  }
}

/**
 * Enviar email de notificación de nueva cita al negocio
 */
async function sendNewAppointmentNotification(appointmentData) {
  try {
    if (!transporter) {
      console.log('📧 Email no configurado - saltando envío de notificación');
      return { success: false, reason: 'SMTP no configurado' };
    }

    // Verificar que tenemos credenciales válidas
    if (!config.smtp.pass || config.smtp.pass.trim() === '') {
      console.log('⚠️ SMTP_PASS vacío - necesitas configurar App Password de Gmail');
      return { success: false, reason: 'SMTP_PASS no configurado' };
    }

    const { 
      clientName, 
      clientEmail, 
      clientPhone,
      date, 
      time, 
      serviceName, 
      profesionalName, 
      codigoReserva 
    } = appointmentData;

    // Formatear fecha en español
    const fechaFormateada = moment.tz(date, config.timezone.default).format('dddd, D [de] MMMM [de] YYYY');
    const horaFormateada = formatTimeTo12Hour(time);

    // Email de notificación para el negocio (formato exacto como la imagen)
    const notificationContent = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; background-color: #f5f5f5;">
      
      <!-- Header azul -->
      <div style="background: linear-gradient(135deg, #2196f3, #1976d2); color: white; padding: 25px; text-align: center; border-radius: 12px 12px 0 0;">
        <div style="background: white; width: 50px; height: 50px; border-radius: 8px; margin: 0 auto 15px; display: inline-flex; align-items: center; justify-content: center; font-size: 24px;">
          📅
        </div>
        <h1 style="margin: 0; font-size: 24px; font-weight: 600;">Nueva Cita Agendada</h1>
        <p style="margin: 8px 0 0; font-size: 14px; opacity: 0.9;">Sistema de Agendamiento WhatsApp</p>
      </div>

      <!-- Contenido principal -->
      <div style="background-color: white; padding: 25px; border-radius: 0 0 12px 12px; box-shadow: 0 2px 8px rgba(0,0,0,0.1);">
        
        <!-- Nueva Reserva Confirmada -->
        <div style="background-color: #e3f2fd; padding: 15px 20px; border-radius: 8px; margin-bottom: 25px; border-left: 4px solid #2196f3;">
          <h2 style="color: #1565c0; margin: 0; font-size: 18px; font-weight: 600;">Nueva Reserva Confirmada 🎉</h2>
        </div>

        <!-- Información del Cliente -->
        <div style="margin-bottom: 25px;">
          <h3 style="color: #1565c0; margin: 0 0 15px 0; font-size: 16px; font-weight: 600;">
            👤 Información del Cliente
          </h3>
          <div style="background-color: #fafafa; padding: 15px; border-radius: 8px;">
            <div style="margin-bottom: 8px;">
              <span style="color: #666; font-weight: 500;">📝 Nombre:</span>
              <span style="margin-left: 8px; font-weight: 600;">${clientName}</span>
            </div>
            <div style="margin-bottom: 8px;">
              <span style="color: #666; font-weight: 500;">📧 Email:</span>
              <a href="mailto:${clientEmail}" style="margin-left: 8px; color: #1976d2; text-decoration: none;">${clientEmail}</a>
            </div>
            <div>
              <span style="color: #666; font-weight: 500;">📱 Teléfono:</span>
              <span style="margin-left: 8px; font-weight: 600;">${clientPhone}</span>
            </div>
          </div>
        </div>

        <!-- Detalles de la Cita -->
        <div style="margin-bottom: 25px;">
          <h3 style="color: #1565c0; margin: 0 0 15px 0; font-size: 16px; font-weight: 600;">
            📅 Detalles de la Cita
          </h3>
          <div style="background-color: #e8f5e9; padding: 15px; border-radius: 8px;">
            <div style="margin-bottom: 8px;">
              <span style="color: #2e7d32; font-weight: 500;">📅 Fecha:</span>
              <span style="margin-left: 8px; font-weight: 600;">${fechaFormateada}</span>
            </div>
            <div style="margin-bottom: 8px;">
              <span style="color: #2e7d32; font-weight: 500;">⏰ Hora:</span>
              <span style="margin-left: 8px; font-weight: 600;">${horaFormateada}</span>
            </div>
            <div style="margin-bottom: 8px;">
              <span style="color: #2e7d32; font-weight: 500;">👨‍⚕️ Especialista:</span>
              <span style="margin-left: 8px; font-weight: 600;">${profesionalName}</span>
            </div>
            <div style="margin-bottom: 8px;">
              <span style="color: #2e7d32; font-weight: 500;">⚖️ Servicio:</span>
              <span style="margin-left: 8px; font-weight: 600;">${serviceName}</span>
            </div>
            <div>
              <span style="color: #2e7d32; font-weight: 500;">🎟️ Código:</span>
              <span style="margin-left: 8px; background: #2196f3; color: white; padding: 4px 12px; border-radius: 20px; font-size: 12px; font-weight: 600;">${codigoReserva}</span>
            </div>
          </div>
        </div>

        <!-- Recordatorio -->
        <div style="background-color: #fff3e0; border: 1px solid #ffcc02; border-radius: 8px; padding: 15px; margin-bottom: 20px; border-left: 4px solid #ffcc02;">
          <div style="display: flex; align-items: center;">
            <span style="margin-right: 8px; font-size: 16px;">⚠️</span>
            <strong style="color: #f57f17; font-size: 14px;">Recordatorio</strong>
          </div>
          <p style="margin: 8px 0 0; color: #e65100; font-size: 14px; line-height: 1.4;">
            El cliente recibirá un recordatorio automático 24h antes de la cita.
          </p>
        </div>

        <!-- Footer -->
        <div style="text-align: center; padding: 15px 0; color: #999; font-size: 12px;">
          Agendado automáticamente vía WhatsApp • ${moment().tz(config.timezone.default).format('D/M/YYYY, H:mm:ss')} p. m.
        </div>

      </div>
    </div>
    `;

    const mailOptions = {
      from: `"${config.business.name}" <${config.smtp.user}>`,
      to: config.business.email, // Enviar al email del negocio
      subject: `Nueva Cita Agendada - ${clientName} - ${fechaFormateada} ${horaFormateada}`,
      html: notificationContent
    };

    console.log('📧 === ENVIANDO NOTIFICACIÓN DE NUEVA CITA ===');
    console.log('Para negocio:', config.business.email);
    console.log('Cliente:', clientName);
    console.log('Asunto:', mailOptions.subject);

    const result = await transporter.sendMail(mailOptions);
    console.log('✅ Notificación enviada exitosamente:', result.messageId);

    return { 
      success: true, 
      messageId: result.messageId,
      to: config.business.email 
    };

  } catch (error) {
    console.error('❌ Error enviando notificación:', error.message);
    
    return { 
      success: false, 
      error: error.message 
    };
  }
}


/**
 * Enviar email de confirmación de cita reagendada
 */
async function sendRescheduledAppointmentConfirmation(appointmentData) {
  try {
    if (!transporter) {
      console.log('📧 Email no configurado - saltando envío');
      return { success: false, reason: 'SMTP no configurado' };
    }

    if (!config.smtp.pass || config.smtp.pass.trim() === '') {
      console.log('⚠️ SMTP_PASS vacío - necesitas configurar App Password de Gmail');
      return { success: false, reason: 'SMTP_PASS no configurado' };
    }

    const { 
      clientName, 
      clientEmail, 
      oldDate,
      oldTime,
      newDate, 
      newTime, 
      serviceName, 
      profesionalName, 
      codigoReserva 
    } = appointmentData;

    // Formatear fechas en español
    const fechaAntiguaFormateada = moment.tz(oldDate, config.timezone.default).format('dddd, D [de] MMMM [de] YYYY');
    const fechaNuevaFormateada = moment.tz(newDate, config.timezone.default).format('dddd, D [de] MMMM [de] YYYY');
    
    const horaAntiguaFormateada = formatTimeTo12Hour(oldTime);
    const horaNuevaFormateada = formatTimeTo12Hour(newTime);

    const emailContent = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; background-color: #f8f9fa;">
      <div style="background-color: white; padding: 30px; border-radius: 10px; box-shadow: 0 2px 10px rgba(0,0,0,0.1);">
        
        <div style="text-align: center; margin-bottom: 30px;">
          <h1 style="color: #ff9800; margin: 0;">🔄 Cita Reagendada</h1>
          <p style="color: #6c757d; margin: 5px 0;">Tu cita ha sido reagendada exitosamente</p>
        </div>

        <!-- Cita Anterior (tachada) -->
        <div style="background-color: #ffebee; padding: 15px; border-radius: 8px; margin-bottom: 20px; opacity: 0.7;">
          <h3 style="color: #c62828; margin-top: 0; text-decoration: line-through;">📅 Cita Anterior (Cancelada)</h3>
          <p style="text-decoration: line-through;"><strong>📅 Fecha:</strong> ${fechaAntiguaFormateada}</p>
          <p style="text-decoration: line-through;"><strong>⏰ Hora:</strong> ${horaAntiguaFormateada}</p>
        </div>

        <!-- Nueva Cita -->
        <div style="background-color: #e8f5e9; padding: 20px; border-radius: 8px; margin-bottom: 20px;">
          <h2 style="color: #2e7d32; margin-top: 0;">📅 Nueva Cita Confirmada</h2>
          <p><strong>👤 Cliente:</strong> ${clientName}</p>
          <p><strong>📅 Nueva Fecha:</strong> ${fechaNuevaFormateada}</p>
          <p><strong>⏰ Nueva Hora:</strong> ${horaNuevaFormateada}</p>
          <p><strong>👨‍⚕️ Especialista:</strong> ${profesionalName}</p>
          <p><strong>🩺 Servicio:</strong> ${serviceName}</p>
          <p><strong>🎟️ Código de Reserva:</strong> <span style="font-size: 18px; font-weight: bold; color: #d32f2f;">${codigoReserva}</span></p>
        </div>

        <div style="background-color: #fff3e0; padding: 15px; border-radius: 8px; margin-bottom: 20px;">
          <h3 style="color: #ef6c00; margin-top: 0;">⚠️ Importante</h3>
          <ul style="margin: 0; padding-left: 20px;">
            <li>Llega 10 minutos antes de tu cita</li>
            <li>Guarda tu código de reserva: <strong>${codigoReserva}</strong></li>
            <li>Si necesitas cancelar o reagendar, contacta con al menos 2 horas de anticipación</li>
          </ul>
        </div>

        <div style="text-align: center; margin-top: 30px;">
          <p style="color: #6c757d; margin: 0;">
            <strong>${config.business.name}</strong><br>
            ${config.business.phone}<br>
            📧 ${config.business.email}<br>
            📍 ${config.business.address}
          </p>
        </div>

      </div>
    </div>
    `;

    const mailOptions = {
      from: `"${config.business.name}" <${config.smtp.user}>`,
      to: clientEmail,
      subject: `🔄 Cita Reagendada - ${fechaNuevaFormateada} a las ${horaNuevaFormateada} - Código: ${codigoReserva}`,
      html: emailContent
    };

    console.log('📧 === ENVIANDO EMAIL DE REAGENDAMIENTO ===');
    console.log('Para:', clientEmail);
    console.log('Asunto:', mailOptions.subject);

    const result = await transporter.sendMail(mailOptions);
    console.log('✅ Email de reagendamiento enviado exitosamente:', result.messageId);

    return { 
      success: true, 
      messageId: result.messageId,
      to: clientEmail 
    };

  } catch (error) {
    console.error('❌ Error enviando email de reagendamiento:', error.message);
    
    if (error.message.includes('Username and Password not accepted')) {
      console.error('🔐 PROBLEMA DE CREDENCIALES:');
      console.error('   1. Verifica que SMTP_USER sea: goparirisvaleria@gmail.com');
      console.error('   2. SMTP_PASS debe ser un App Password de Gmail (16 caracteres)');
      console.error('   3. Ve a https://myaccount.google.com → Seguridad → Contraseñas de aplicaciones');
      console.error('   4. Genera una nueva contraseña de aplicación para "Mail"');
    }
    
    return { 
      success: false, 
      error: error.message 
    };
  }
}

/**
 * Enviar recordatorio de cita (24 horas antes)
 */
async function sendReminder24h(appointmentData) {
  try {
    if (!transporter) {
      console.log('📧 Email no configurado - saltando envío');
      return { success: false, reason: 'SMTP no configurado' };
    }

    if (!config.smtp.pass || config.smtp.pass.trim() === '') {
      console.log('⚠️ SMTP_PASS vacío - necesitas configurar App Password de Gmail');
      return { success: false, reason: 'SMTP_PASS no configurado' };
    }

    const { 
      clientName, 
      clientEmail, 
      fechaCita,
      horaCita,
      serviceName, 
      profesionalName, 
      codigoReserva 
    } = appointmentData;

    const fechaFormateada = moment.tz(fechaCita, config.timezone.default).format('dddd, D [de] MMMM [de] YYYY');
    const horaFormateada = formatTimeTo12Hour(horaCita);

    const emailContent = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; background-color: #f8f9fa;">
      <div style="background-color: white; padding: 30px; border-radius: 10px; box-shadow: 0 2px 10px rgba(0,0,0,0.1);">
        
        <div style="text-align: center; margin-bottom: 30px;">
          <h1 style="color: #2196f3; margin: 0;">⏰ Recordatorio de Cita</h1>
          <p style="color: #6c757d; margin: 5px 0;">Tu cita es mañana</p>
        </div>

        <div style="background-color: #e3f2fd; padding: 20px; border-radius: 8px; margin-bottom: 20px;">
          <h2 style="color: #1565c0; margin-top: 0;">📅 Detalles de tu Cita</h2>
          <p><strong>👤 Paciente:</strong> ${clientName}</p>
          <p><strong>📅 Fecha:</strong> ${fechaFormateada}</p>
          <p><strong>⏰ Hora:</strong> ${horaFormateada}</p>
          <p><strong>👨‍⚕️ Especialista:</strong> ${profesionalName}</p>
          <p><strong>🩺 Servicio:</strong> ${serviceName}</p>
          <p><strong>🎟️ Código de Reserva:</strong> <span style="font-size: 18px; font-weight: bold; color: #d32f2f;">${codigoReserva}</span></p>
        </div>

        <div style="background-color: #e8f5e9; padding: 15px; border-radius: 8px; margin-bottom: 20px; border-left: 4px solid #4caf50;">
          <h3 style="color: #2e7d32; margin-top: 0;">✅ Confirma tu asistencia</h3>
          <p style="margin: 0;">Por favor, confirma tu asistencia respondiendo a este correo o contactándonos por WhatsApp usando tu código de reserva: <strong>${codigoReserva}</strong></p>
        </div>

        <div style="background-color: #fff3e0; padding: 15px; border-radius: 8px; margin-bottom: 20px;">
          <h3 style="color: #ef6c00; margin-top: 0;">⚠️ Importante</h3>
          <ul style="margin: 0; padding-left: 20px;">
            <li>Llega 10 minutos antes de tu cita</li>
            <li>Si necesitas cancelar o reagendar, contacta lo antes posible</li>
            <li>Guarda tu código de reserva: <strong>${codigoReserva}</strong></li>
          </ul>
        </div>

        <div style="text-align: center; margin-top: 30px;">
          <p style="color: #6c757d; margin: 0;">
            <strong>${config.business.name}</strong><br>
            ${config.business.phone}<br>
            📧 ${config.business.email}<br>
            📍 ${config.business.address}
          </p>
        </div>

      </div>
    </div>
    `;

    const mailOptions = {
      from: `"${config.business.name}" <${config.smtp.user}>`,
      to: clientEmail,
      subject: `⏰ Recordatorio: Tu cita es mañana - ${fechaFormateada} a las ${horaFormateada}`,
      html: emailContent
    };

    console.log(`📤 Enviando recordatorio 24h a ${clientEmail}...`);
    const result = await transporter.sendMail(mailOptions);
    console.log(`✅ Recordatorio 24h enviado exitosamente. MessageId: ${result.messageId}`);

    return { 
      success: true, 
      messageId: result.messageId, 
      to: clientEmail 
    };

  } catch (error) {
    console.error('❌ Error enviando recordatorio 24h:', error.message);
    return { 
      success: false, 
      error: error.message 
    };
  }
}

// Inicializar servicio al cargar el módulo
const emailServiceReady = initializeEmailService();

module.exports = { 
  sendAppointmentConfirmation, 
  sendNewAppointmentNotification,
  sendRescheduledAppointmentConfirmation,
  sendReminder24h,
  emailServiceReady,
  initializeEmailService 
};