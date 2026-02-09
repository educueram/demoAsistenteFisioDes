const { google } = require('googleapis');
const config = require('../config');

/**
 * Servicio de autenticación con Google APIs
 * Solo para Google Calendar
 */

let auth = null;

/**
 * Inicializar autenticación con Google
 */
function initializeAuth() {
  try {
    if (!config.google.privateKey || !config.google.clientEmail) {
      throw new Error('Faltan credenciales de Google. Verificar variables de entorno GOOGLE_PRIVATE_KEY y GOOGLE_CLIENT_EMAIL');
    }

    // Debug: mostrar credenciales (sin la clave completa)
    console.log('🔑 === DEBUG GOOGLE AUTH ===');
    console.log(`   Client Email: ${config.google.clientEmail}`);
    console.log(`   Project ID: ${config.google.projectId}`);
    console.log(`   Private Key: ${config.google.privateKey ? '✅ Configurada (' + config.google.privateKey.length + ' chars)' : '❌ NO configurada'}`);
    console.log(`   Private Key Preview: ${config.google.privateKey ? config.google.privateKey.substring(0, 50) + '...' : 'N/A'}`);

    auth = new google.auth.GoogleAuth({
      credentials: {
        private_key: config.google.privateKey,
        client_email: config.google.clientEmail,
        project_id: config.google.projectId
      },
      scopes: [
        'https://www.googleapis.com/auth/calendar'
      ]
    });

    console.log('✅ Google Auth inicializado correctamente (solo Calendar)');
    return auth;
  } catch (error) {
    console.error('❌ Error inicializando Google Auth:', error.message);
    throw error;
  }
}

/**
 * Obtener cliente autenticado
 */
async function getAuthenticatedClient() {
  try {
    if (!auth) {
      auth = initializeAuth();
    }
    
    const authClient = await auth.getClient();
    return authClient;
  } catch (error) {
    console.error('❌ Error obteniendo cliente autenticado:', error.message);
    throw error;
  }
}

/**
 * Obtener instancia de Google Calendar
 */
async function getCalendarInstance() {
  try {
    const authClient = await getAuthenticatedClient();
    const calendar = google.calendar({ version: 'v3', auth: authClient });
    return calendar;
  } catch (error) {
    console.error('❌ Error obteniendo instancia de Calendar:', error.message);
    throw error;
  }
}

module.exports = {
  initializeAuth,
  getAuthenticatedClient,
  getCalendarInstance
};
