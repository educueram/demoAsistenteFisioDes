const { query } = require('./mysqlService');
const config = require('../config');
const moment = require('moment-timezone');

/**
 * Servicio de datos MySQL
 */

/**
 * Obtener datos de configuración (calendarios, horarios, servicios)
 */
async function getConfigData() {
  try {
    console.log('📊 Obteniendo datos de MySQL...');

    const [calendars, hours, services] = await Promise.all([
      getCalendars(),
      getHours(),
      getServices()
    ]);

    const configData = {
      calendars: calendars,
      hours: hours,
      services: services
    };

    console.log('✅ Datos obtenidos correctamente de MySQL:');
    console.log(`   - Calendarios: ${calendars.length - 1} registros`);
    console.log(`   - Horarios: ${hours.length - 1} registros`);
    console.log(`   - Servicios: ${services.length - 1} registros`);

    return configData;
  } catch (error) {
    console.error('❌ Error obteniendo datos de MySQL:', error.message);
    throw error;
  }
}

/**
 * Obtener calendarios de la base de datos
 * Formato compatible: [[numero, google_calendar_id, nombre], ...]
 */
async function getCalendars() {
  try {
    const results = await query(`
      SELECT id_calendario, google_calendar_id, nombre 
      FROM Calendario 
      WHERE activo = 1
      ORDER BY id_calendario
    `);

    // Convertir a formato compatible con el código existente
    // [['CALENDARIO', 'ID_CALENDARIO', 'NOMBRE'], [1, 'calendar_id@...', 'Dr. X'], ...]
    const formatted = [['CALENDARIO', 'ID_CALENDARIO', 'NOMBRE']];
    results.forEach(row => {
      formatted.push([
        row.id_calendario.toString(),
        row.google_calendar_id,
        row.nombre
      ]);
    });

    return formatted;
  } catch (error) {
    console.error('❌ Error obteniendo calendarios:', error.message);
    throw error;
  }
}

/**
 * Obtener horarios de la base de datos
 * Formato compatible: [[calendario, dia, hora_inicio, hora_fin], ...]
 */
async function getHours() {
  try {
    const results = await query(`
      SELECT IdCalendario, DiaSemana, 
             HOUR(HoraInicio) as HoraInicio, 
             HOUR(HoraFin) as HoraFin
      FROM Horarios 
      WHERE Activo = 1
      ORDER BY IdCalendario, DiaSemana
    `);

    // Convertir a formato compatible con el código existente
    // [['CALENDARIO', 'DIA', 'HORA_INICIO', 'HORA_FIN'], [1, 'LUNES', 10, 18], ...]
    const dayNames = { 1: 'LUNES', 2: 'MARTES', 3: 'MIERCOLES', 4: 'JUEVES', 5: 'VIERNES', 6: 'SABADO', 7: 'DOMINGO' };
    
    const formatted = [['CALENDARIO', 'DIA', 'HORA_INICIO', 'HORA_FIN']];
    results.forEach(row => {
      formatted.push([
        row.IdCalendario.toString(),
        dayNames[row.DiaSemana] || row.DiaSemana.toString(),
        row.HoraInicio,
        row.HoraFin
      ]);
    });

    return formatted;
  } catch (error) {
    console.error('❌ Error obteniendo horarios:', error.message);
    throw error;
  }
}

/**
 * Obtener servicios de la base de datos
 * Formato compatible: [[numero, duracion, nombre, precio], ...]
 */
async function getServices() {
  try {
    const results = await query(`
      SELECT IdServicio, NombreServicio, PrecioServicio, DuracionMinutos
      FROM Servicios
      ORDER BY IdServicio
    `);

    // Convertir a formato compatible con el código existente
    // [['SERVICIO', 'DURACION', 'NOMBRE', 'PRECIO'], [1, 60, 'Consulta', 500], ...]
    const formatted = [['SERVICIO', 'DURACION', 'NOMBRE', 'PRECIO']];
    results.forEach(row => {
      formatted.push([
        row.IdServicio.toString(),
        row.DuracionMinutos,
        row.NombreServicio,
        row.PrecioServicio
      ]);
    });

    return formatted;
  } catch (error) {
    console.error('❌ Error obteniendo servicios:', error.message);
    throw error;
  }
}

/**
 * Buscar datos en una matriz (equivalente a findData del código original)
 * Mantiene compatibilidad con el código existente
 */
function findData(queryValue, data, searchCol, returnCol) {
  for (let i = 1; i < data.length; i++) {
    if (data[i][searchCol] && data[i][searchCol].toString().trim() == queryValue) {
      return data[i][returnCol];
    }
  }
  return null;
}

/**
 * Buscar horarios de trabajo (equivalente a findWorkingHours del código original)
 * Mantiene compatibilidad con el código existente
 */
function findWorkingHours(calendarNumber, dayNumber, data) {
  const dayNames = { 1: "LUNES", 2: "MARTES", 3: "MIERCOLES", 4: "JUEVES", 5: "VIERNES", 6: "SABADO", 7: "DOMINGO" };
  const expectedDayName = dayNames[dayNumber];

  for (let i = 1; i < data.length; i++) {
    const dbCalendar = data[i][0] ? data[i][0].toString().trim() : '';
    if (dbCalendar === calendarNumber.toString()) {
      const dbDayValue = data[i][1] ? data[i][1].toString().trim() : '';
      const normalizedDbDay = dbDayValue.toUpperCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");

      if (dbDayValue === dayNumber.toString() || normalizedDbDay === expectedDayName) {
        return {
          start: parseInt(data[i][2]),
          end: parseInt(data[i][3]),
          dayName: dbDayValue
        };
      }
    }
  }
  return null;
}

/**
 * Guardar datos del cliente y cita en MySQL
 */
async function saveClientDataOriginal(clientData) {
  try {
    console.log('🔄 === INICIO saveClientData MySQL ===');
    console.log('Datos recibidos:', JSON.stringify(clientData, null, 2));

    const now = moment().tz(config.timezone.default);
    const timestamp = now.format('YYYY-MM-DD HH:mm:ss');

    // PASO 1: Buscar o crear cliente
    let clientId = await findOrCreateClient(
      clientData.clientName,
      clientData.clientPhone,
      clientData.clientEmail
    );

    // PASO 2: Obtener ID del especialista por nombre
    const especialistaId = await getEspecialistaIdByName(clientData.profesionalName);
    if (!especialistaId) {
      console.error(`❌ Especialista no encontrado: ${clientData.profesionalName}`);
      // Intentar usar ID 1 como fallback
      console.log('⚠️ Usando especialista ID 1 como fallback');
    }

    // PASO 3: Obtener ID del servicio por nombre
    const servicioId = await getServicioIdByName(clientData.serviceName);
    if (!servicioId) {
      console.error(`❌ Servicio no encontrado: ${clientData.serviceName}`);
      console.log('⚠️ Usando servicio ID 1 como fallback');
    }

    // PASO 4: Insertar cita
    const insertCitaSQL = `
      INSERT INTO Citas (
        FechaRegistro, CodigoReserva, IdCliente, IdEspecialista, 
        IdServicio, FechaCita, HoraCita, Estado, Observaciones
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;

    const citaParams = [
      timestamp,
      clientData.codigoReserva || '',
      clientId,
      especialistaId || 1,
      servicioId || 1,
      clientData.date || null,
      clientData.time || null,
      'AGENDADA',
      null
    ];

    await query(insertCitaSQL, citaParams);

    console.log('✅ Datos guardados exitosamente en MySQL');
    console.log(`📊 Cliente ${clientData.clientName} guardado con código ${clientData.codigoReserva}`);

    return true;

  } catch (error) {
    console.error('💥 ERROR CRÍTICO en saveClientData MySQL:', error.message);
    console.error('📚 Stack completo:', error.stack);
    return false;
  }
}

function normalizePhoneTo10Digits(phone) {
  if (!phone) return '';
  const digitsOnly = phone.toString().replace(/\D/g, '');
  if (!digitsOnly) return '';
  if (digitsOnly.startsWith('521') && digitsOnly.length >= 13) {
    return digitsOnly.substring(3, 13);
  }
  if (digitsOnly.startsWith('52') && digitsOnly.length >= 12) {
    return digitsOnly.substring(2, 12);
  }
  if (digitsOnly.length > 10) {
    return digitsOnly.substring(digitsOnly.length - 10);
  }
  return digitsOnly;
}

/**
 * Buscar cliente existente o crear uno nuevo
 * - Busca SOLO por número de celular (dato principal)
 * - Si existe, NO actualiza datos, solo devuelve el ID
 * - Si no existe, crea el nuevo cliente
 * - Si el email ya existe pero el teléfono es nuevo, crea cliente sin email
 */
async function findOrCreateClient(nombre, telefono, email) {
  try {
    // Normalizar teléfono para búsqueda
    const telefonoNormalizado = normalizePhoneTo10Digits(telefono);

    // Buscar cliente existente SOLO por número de celular (dato principal)
    const searchSQL = `
      SELECT IdCliente, NombreCompleto, CorreoElectronico 
      FROM Clientes 
      WHERE NumeroCelular = ?
      LIMIT 1
    `;
    const existingClients = await query(searchSQL, [telefonoNormalizado]);

    if (existingClients.length > 0) {
      const clienteExistente = existingClients[0];
      console.log(`✅ Cliente existente encontrado: ID ${clienteExistente.IdCliente}`);
      console.log(`   - Nombre en BD: ${clienteExistente.NombreCompleto}`);
      console.log(`   - Email en BD: ${clienteExistente.CorreoElectronico}`);
      console.log(`   - NO se actualizan datos del cliente existente`);
      
      // NO actualizar datos - solo devolver el ID existente
      return clienteExistente.IdCliente;
    }

    // Cliente no existe por teléfono - intentar crear nuevo cliente
    try {
      const insertSQL = `
        INSERT INTO Clientes (NombreCompleto, NumeroCelular, CorreoElectronico)
        VALUES (?, ?, ?)
      `;
      const result = await query(insertSQL, [nombre, telefonoNormalizado, email]);

      console.log(`✅ Nuevo cliente creado: ID ${result.insertId}`);
      console.log(`   - Nombre: ${nombre}`);
      console.log(`   - Teléfono: ${telefonoNormalizado}`);
      console.log(`   - Email: ${email}`);
      return result.insertId;

    } catch (insertError) {
      // Si hay error por email duplicado, crear cliente con email único basado en teléfono
      if (insertError.code === 'ER_DUP_ENTRY' && insertError.message.includes('CorreoElectronico')) {
        console.log('⚠️ Email duplicado pero teléfono es nuevo - creando cliente con email único...');
        
        // Generar email único usando el teléfono
        const emailUnico = `${telefonoNormalizado}@cliente.local`;
        
        const insertWithUniqueEmailSQL = `
          INSERT INTO Clientes (NombreCompleto, NumeroCelular, CorreoElectronico)
          VALUES (?, ?, ?)
        `;
        const resultUniqueEmail = await query(insertWithUniqueEmailSQL, [nombre, telefonoNormalizado, emailUnico]);
        
        console.log(`✅ Nuevo cliente creado (email único): ID ${resultUniqueEmail.insertId}`);
        console.log(`   - Nombre: ${nombre}`);
        console.log(`   - Teléfono: ${telefonoNormalizado}`);
        console.log(`   - Email: ${emailUnico} (original duplicado: ${email})`);
        return resultUniqueEmail.insertId;
      }
      throw insertError;
    }

  } catch (error) {
    console.error('❌ Error en findOrCreateClient:', error.message);
    throw error;
  }
}

/**
 * Obtener ID del especialista por nombre
 */
async function getEspecialistaIdByName(nombreEspecialista) {
  try {
    if (!nombreEspecialista) return null;

    const results = await query(
      'SELECT IdEspecialista FROM Especialistas WHERE NombreCompleto LIKE ?',
      [`%${nombreEspecialista}%`]
    );

    return results.length > 0 ? results[0].IdEspecialista : null;
  } catch (error) {
    console.error('❌ Error buscando especialista:', error.message);
    return null;
  }
}

/**
 * Obtener ID del servicio por nombre
 */
async function getServicioIdByName(nombreServicio) {
  try {
    if (!nombreServicio) return null;

    const results = await query(
      'SELECT IdServicio FROM Servicios WHERE NombreServicio LIKE ?',
      [`%${nombreServicio}%`]
    );

    return results.length > 0 ? results[0].IdServicio : null;
  } catch (error) {
    console.error('❌ Error buscando servicio:', error.message);
    return null;
  }
}

/**
 * Actualizar estado de una cita
 */
async function updateClientStatus(codigoReserva, newStatus) {
  try {
    console.log(`📝 Actualizando estado de cita ${codigoReserva} a ${newStatus}...`);

    const updateSQL = `
      UPDATE Citas 
      SET Estado = ?
      WHERE CodigoReserva = ?
    `;

    const result = await query(updateSQL, [newStatus, codigoReserva.toUpperCase()]);

    if (result.affectedRows > 0) {
      console.log(`✅ Estado actualizado: ${codigoReserva} -> ${newStatus}`);
      return true;
    }

    console.log(`⚠️ No se encontró la cita con código: ${codigoReserva}`);
    return false;

  } catch (error) {
    console.error('❌ Error actualizando estado:', error.message);
    return false;
  }
}

/**
 * Actualizar fecha y hora de una cita
 */
async function updateClientAppointmentDateTime(codigoReserva, newDate, newTime) {
  try {
    console.log(`📝 Actualizando fecha y hora de cita ${codigoReserva}...`);
    console.log(`   Nueva fecha: ${newDate}, Nueva hora: ${newTime}`);

    const updateSQL = `
      UPDATE Citas 
      SET FechaCita = ?, HoraCita = ?
      WHERE CodigoReserva = ?
    `;

    const result = await query(updateSQL, [newDate, newTime, codigoReserva.toUpperCase()]);

    if (result.affectedRows > 0) {
      console.log(`✅ Fecha y hora actualizadas: ${codigoReserva} -> ${newDate} ${newTime}`);
      return true;
    }

    console.log(`⚠️ No se encontró la cita con código: ${codigoReserva}`);
    return false;

  } catch (error) {
    console.error('❌ Error actualizando fecha y hora:', error.message);
    return false;
  }
}

/**
 * Obtener datos de un cliente por código de reserva
 */
async function getClientDataByReservationCode(codigoReserva) {
  try {
    console.log(`🔍 Buscando datos del cliente con código: ${codigoReserva}`);

    const selectSQL = `
      SELECT 
        c.FechaRegistro,
        c.CodigoReserva,
        cl.NombreCompleto as clientName,
        cl.NumeroCelular as clientPhone,
        cl.CorreoElectronico as clientEmail,
        e.NombreCompleto as profesionalName,
        DATE_FORMAT(c.FechaCita, '%Y-%m-%d') as date,
        TIME_FORMAT(c.HoraCita, '%H:%i') as time,
        s.NombreServicio as serviceName,
        c.Estado as estado
      FROM Citas c
      INNER JOIN Clientes cl ON c.IdCliente = cl.IdCliente
      INNER JOIN Especialistas e ON c.IdEspecialista = e.IdEspecialista
      INNER JOIN Servicios s ON c.IdServicio = s.IdServicio
      WHERE c.CodigoReserva = ?
    `;

    const results = await query(selectSQL, [codigoReserva.toUpperCase()]);

    if (results.length > 0) {
      const row = results[0];
      const clientData = {
        fechaRegistro: row.FechaRegistro,
        codigoReserva: row.CodigoReserva,
        clientName: row.clientName,
        clientPhone: row.clientPhone,
        clientEmail: row.clientEmail,
        profesionalName: row.profesionalName,
        date: row.date,
        time: row.time,
        serviceName: row.serviceName,
        estado: row.estado
      };

      console.log(`✅ Datos del cliente encontrados:`, clientData);
      return clientData;
    }

    console.log(`❌ No se encontraron datos para el código: ${codigoReserva}`);
    return null;

  } catch (error) {
    console.error('❌ Error obteniendo datos del cliente:', error.message);
    return null;
  }
}

/**
 * Consultar datos de paciente por número telefónico
 */
async function consultaDatosPacientePorTelefono(numeroTelefono) {
  try {
    console.log(`🔍 Buscando paciente con teléfono: ${numeroTelefono}`);

    // Normalizar el número de búsqueda
    const normalizedSearchPhone = normalizePhoneTo10Digits(numeroTelefono);
    const digitsOnly = numeroTelefono ? numeroTelefono.toString().replace(/\D/g, '') : '';

    // Preparar variantes de búsqueda
    let searchVariants = [];

    if (normalizedSearchPhone) {
      searchVariants.push(normalizedSearchPhone);
      if (normalizedSearchPhone.length === 10) {
        searchVariants.push('52' + normalizedSearchPhone);
        searchVariants.push('521' + normalizedSearchPhone);
      }
    }
    if (digitsOnly && digitsOnly !== normalizedSearchPhone) {
      searchVariants.push(digitsOnly);
    }

    searchVariants = [...new Set(searchVariants)];

    console.log(`📞 Variantes de búsqueda: ${searchVariants.join(', ')}`);

    // Construir query con múltiples variantes
    const placeholders = searchVariants.map(() => 'cl.NumeroCelular LIKE ?').join(' OR ');
    const params = searchVariants.map(v => `%${v.slice(-10)}%`);

    const selectSQL = `
      SELECT 
        c.FechaRegistro as fechaRegistro,
        c.CodigoReserva as codigoReserva,
        cl.NombreCompleto as nombreCompleto,
        cl.NumeroCelular as telefono,
        cl.CorreoElectronico as correoElectronico,
        e.NombreCompleto as profesionalName,
        DATE_FORMAT(c.FechaCita, '%Y-%m-%d') as fechaCita,
        TIME_FORMAT(c.HoraCita, '%H:%i') as horaCita,
        s.NombreServicio as servicio,
        c.Estado as estado
      FROM Citas c
      INNER JOIN Clientes cl ON c.IdCliente = cl.IdCliente
      INNER JOIN Especialistas e ON c.IdEspecialista = e.IdEspecialista
      INNER JOIN Servicios s ON c.IdServicio = s.IdServicio
      WHERE ${placeholders}
      ORDER BY c.FechaRegistro DESC
    `;

    const results = await query(selectSQL, params);

    if (results.length === 0) {
      console.log(`❌ No se encontraron pacientes con el teléfono: ${numeroTelefono}`);
      return [];
    }

    // Aplicar lógica de deduplicación similar a la original
    const pacientesEncontrados = results.map(row => ({
      fechaRegistro: row.fechaRegistro,
      codigoReserva: row.codigoReserva,
      nombreCompleto: row.nombreCompleto,
      telefono: row.telefono,
      correoElectronico: row.correoElectronico,
      profesionalName: row.profesionalName,
      fechaCita: row.fechaCita,
      horaCita: row.horaCita,
      servicio: row.servicio,
      estado: row.estado
    }));

    // Deduplicación: priorizar registros con nombre completo
    if (pacientesEncontrados.length > 1) {
      console.log(`📊 Se encontraron ${pacientesEncontrados.length} registros, aplicando deduplicación...`);

      const grupos = {};
      pacientesEncontrados.forEach(paciente => {
        const telNormalizado = normalizePhoneTo10Digits(paciente.telefono);
        if (!grupos[telNormalizado]) {
          grupos[telNormalizado] = [];
        }
        grupos[telNormalizado].push(paciente);
      });

      const pacientesDeduplicados = [];

      Object.keys(grupos).forEach(telefono => {
        const grupo = grupos[telefono];

        if (grupo.length === 1) {
          pacientesDeduplicados.push(grupo[0]);
        } else {
          // Priorizar el que tenga nombre completo más detallado
          const conNombreCompleto = grupo.filter(p =>
            p.nombreCompleto &&
            p.nombreCompleto.trim().length > 0 &&
            p.nombreCompleto.trim().split(' ').length >= 2
          );

          if (conNombreCompleto.length > 0) {
            conNombreCompleto.sort((a, b) => {
              const fechaA = new Date(a.fechaRegistro);
              const fechaB = new Date(b.fechaRegistro);
              return fechaB - fechaA;
            });
            pacientesDeduplicados.push(conNombreCompleto[0]);
          } else {
            grupo.sort((a, b) => {
              const fechaA = new Date(a.fechaRegistro);
              const fechaB = new Date(b.fechaRegistro);
              return fechaB - fechaA;
            });
            pacientesDeduplicados.push(grupo[0]);
          }
        }
      });

      console.log(`✅ Total de pacientes únicos encontrados: ${pacientesDeduplicados.length}`);
      return pacientesDeduplicados;
    }

    console.log(`✅ Paciente encontrado: ${pacientesEncontrados[0].nombreCompleto}`);
    return pacientesEncontrados;

  } catch (error) {
    console.error('❌ Error consultando datos del paciente:', error.message);
    throw error;
  }
}

/**
 * Obtener citas próximas en las siguientes 24 horas
 * Para el servicio de recordatorios
 */
async function getUpcomingAppointments24h() {
  try {
    console.log('🔍 === BUSCANDO CITAS PRÓXIMAS (24 HORAS) ===');

    const now = moment().tz(config.timezone.default);
    const in23Hours = now.clone().add(23, 'hours').format('YYYY-MM-DD HH:mm:ss');
    const in25Hours = now.clone().add(25, 'hours').format('YYYY-MM-DD HH:mm:ss');

    console.log(`⏰ Ahora: ${now.format('YYYY-MM-DD HH:mm')}`);
    console.log(`⏰ Ventana de recordatorio: ${in23Hours} a ${in25Hours}`);

    const selectSQL = `
      SELECT 
        c.CodigoReserva as codigoReserva,
        cl.NombreCompleto as clientName,
        cl.NumeroCelular as clientPhone,
        cl.CorreoElectronico as clientEmail,
        e.NombreCompleto as profesionalName,
        DATE_FORMAT(c.FechaCita, '%Y-%m-%d') as fechaCita,
        TIME_FORMAT(c.HoraCita, '%H:%i') as horaCita,
        s.NombreServicio as serviceName,
        c.Estado as estado
      FROM Citas c
      INNER JOIN Clientes cl ON c.IdCliente = cl.IdCliente
      INNER JOIN Especialistas e ON c.IdEspecialista = e.IdEspecialista
      INNER JOIN Servicios s ON c.IdServicio = s.IdServicio
      WHERE c.Estado IN ('AGENDADA', 'REAGENDADA')
        AND CONCAT(c.FechaCita, ' ', c.HoraCita) BETWEEN ? AND ?
      ORDER BY c.FechaCita, c.HoraCita
    `;

    const results = await query(selectSQL, [in23Hours, in25Hours]);

    const upcomingAppointments = results.map(row => {
      const appointmentTime = moment.tz(`${row.fechaCita} ${row.horaCita}`, 'YYYY-MM-DD HH:mm', config.timezone.default);
      const hoursUntil = appointmentTime.diff(now, 'hours', true);

      return {
        codigoReserva: row.codigoReserva,
        clientName: row.clientName,
        clientPhone: row.clientPhone,
        clientEmail: row.clientEmail,
        profesionalName: row.profesionalName,
        fechaCita: row.fechaCita,
        horaCita: row.horaCita,
        serviceName: row.serviceName,
        estado: row.estado,
        appointmentTime: appointmentTime,
        hoursUntil: Math.round(hoursUntil)
      };
    });

    console.log(`\n📊 Total citas próximas (24h): ${upcomingAppointments.length}`);
    return upcomingAppointments;

  } catch (error) {
    console.error('❌ Error obteniendo citas próximas (24h):', error.message);
    return [];
  }
}

/**
 * Obtener citas próximas en los siguientes 15 minutos
 * Para el servicio de recordatorios
 */
async function getUpcomingAppointments15min() {
  try {
    console.log('🔍 === BUSCANDO CITAS PRÓXIMAS (15 MINUTOS) ===');

    const now = moment().tz(config.timezone.default);
    const in13Minutes = now.clone().add(13, 'minutes').format('YYYY-MM-DD HH:mm:ss');
    const in17Minutes = now.clone().add(17, 'minutes').format('YYYY-MM-DD HH:mm:ss');

    console.log(`⏰ Ahora: ${now.format('YYYY-MM-DD HH:mm')}`);
    console.log(`⏰ Ventana de recordatorio: ${in13Minutes} a ${in17Minutes}`);

    const selectSQL = `
      SELECT 
        c.CodigoReserva as codigoReserva,
        cl.NombreCompleto as clientName,
        cl.NumeroCelular as clientPhone,
        cl.CorreoElectronico as clientEmail,
        e.NombreCompleto as profesionalName,
        DATE_FORMAT(c.FechaCita, '%Y-%m-%d') as fechaCita,
        TIME_FORMAT(c.HoraCita, '%H:%i') as horaCita,
        s.NombreServicio as serviceName,
        c.Estado as estado
      FROM Citas c
      INNER JOIN Clientes cl ON c.IdCliente = cl.IdCliente
      INNER JOIN Especialistas e ON c.IdEspecialista = e.IdEspecialista
      INNER JOIN Servicios s ON c.IdServicio = s.IdServicio
      WHERE c.Estado IN ('AGENDADA', 'REAGENDADA', 'CONFIRMADA')
        AND CONCAT(c.FechaCita, ' ', c.HoraCita) BETWEEN ? AND ?
      ORDER BY c.FechaCita, c.HoraCita
    `;

    const results = await query(selectSQL, [in13Minutes, in17Minutes]);

    const upcomingAppointments = results.map(row => {
      const appointmentTime = moment.tz(`${row.fechaCita} ${row.horaCita}`, 'YYYY-MM-DD HH:mm', config.timezone.default);
      const minutesUntil = appointmentTime.diff(now, 'minutes', true);

      return {
        codigoReserva: row.codigoReserva,
        clientName: row.clientName,
        clientPhone: row.clientPhone,
        clientEmail: row.clientEmail,
        profesionalName: row.profesionalName,
        fechaCita: row.fechaCita,
        horaCita: row.horaCita,
        serviceName: row.serviceName,
        estado: row.estado,
        appointmentTime: appointmentTime,
        minutesUntil: Math.round(minutesUntil)
      };
    });

    console.log(`\n📊 Total citas próximas (15min): ${upcomingAppointments.length}`);
    return upcomingAppointments;

  } catch (error) {
    console.error('❌ Error obteniendo citas próximas (15min):', error.message);
    return [];
  }
}

/**
 * Obtener cliente por número de celular para carga de datos iniciales
 * @param {string} celular - Número de celular a buscar
 * @returns {object|null} - Datos del cliente o null si no existe
 */
async function getClienteByCelular(celular) {
  try {
    console.log(`🔍 === BUSCANDO CLIENTE POR CELULAR ===`);
    console.log(`📞 Celular recibido: ${celular}`);

    // Normalizar teléfono
    const telefonoNormalizado = normalizePhoneTo10Digits(celular);
    const digitsOnly = celular ? celular.toString().replace(/\D/g, '') : '';
    const base10 = telefonoNormalizado || (digitsOnly.length >= 10 ? digitsOnly.substring(digitsOnly.length - 10) : digitsOnly);
    
    // Variantes de búsqueda (con y sin prefijos de país)
    const variantes = [
      base10,
      `52${base10}`,
      `521${base10}`,
      digitsOnly,
      telefonoNormalizado
    ].filter(Boolean);
    const variantesUnicas = [...new Set(variantes)];

    console.log(`📞 Variantes de búsqueda: ${variantesUnicas.join(', ')}`);

    const searchSQL = `
      SELECT IdCliente, NombreCompleto, NumeroCelular, CorreoElectronico
      FROM Clientes 
      WHERE NumeroCelular IN (${variantesUnicas.map(() => '?').join(', ')})
      LIMIT 1
    `;

    const results = await query(searchSQL, variantesUnicas);

    if (results.length > 0) {
      const cliente = results[0];
      
      // Extraer solo el primer nombre
      const nombreCompleto = cliente.NombreCompleto || '';
      const primerNombre = nombreCompleto.split(' ')[0];

      console.log(`✅ Cliente encontrado: ID ${cliente.IdCliente}`);
      console.log(`   - Nombre completo: ${nombreCompleto}`);
      console.log(`   - Primer nombre: ${primerNombre}`);
      console.log(`   - Celular: ${cliente.NumeroCelular}`);
      console.log(`   - Email: ${cliente.CorreoElectronico}`);

      return {
        idCliente: cliente.IdCliente,
        nombreCompleto: nombreCompleto,
        primerNombre: primerNombre,
        celular: cliente.NumeroCelular,
        correo: cliente.CorreoElectronico,
        existe: true
      };
    }

    console.log(`❌ Cliente NO encontrado con celular: ${celular}`);
    return {
      existe: false,
      celular: telefonoNormalizado
    };

  } catch (error) {
    console.error('❌ Error buscando cliente por celular:', error.message);
    throw error;
  }
}

module.exports = {
  getConfigData,
  findData,
  findWorkingHours,
  saveClientDataOriginal,
  updateClientStatus,
  updateClientAppointmentDateTime,
  getClientDataByReservationCode,
  consultaDatosPacientePorTelefono,
  getUpcomingAppointments24h,
  getUpcomingAppointments15min,
  getClienteByCelular,
  // Funciones adicionales para uso directo
  getCalendars,
  getHours,
  getServices,
  findOrCreateClient
};

