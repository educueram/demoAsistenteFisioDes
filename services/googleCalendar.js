const { getCalendarInstance } = require('./googleAuth');
const config = require('../config');
const moment = require('moment-timezone');
const crypto = require('crypto');

/**
 * Servicio para manejo de Google Calendar
 * Migrado desde Google Apps Script
 */

  /**
   * Encontrar slots disponibles en un calendario
   * Horario: 10 AM a 6 PM, excluyendo horario de comida (2 PM a 3 PM)
   */
async function findAvailableSlots(calendarId, date, durationMinutes, hours) {
  try {
    console.log(`📅 Buscando slots para ${calendarId} el ${date.toISOString().split('T')[0]}`);

    const calendar = await getCalendarInstance();
    const dateMoment = moment.tz(date.toISOString().split('T')[0], 'YYYY-MM-DD', config.timezone.default);
    const dayOfWeek = dateMoment.day();

    // Validación: Domingo cerrado
    if (dayOfWeek === 0) {
      return [];
    }

    // Definir horario según día (usar "hours" si viene del caller)
    let workingHours;
    if (hours && typeof hours === 'object') {
      const isSaturday = dayOfWeek === 6;
      const defaultStart = isSaturday ? 10 : 10;
      const defaultEnd = isSaturday ? 14 : 18;
      const start = Number.isFinite(hours.start) ? hours.start : defaultStart;
      const end = Number.isFinite(hours.end) ? hours.end : defaultEnd;
      const hasLunch = typeof hours.hasLunch === 'boolean'
        ? hours.hasLunch
        : (hours.lunchStart !== undefined && hours.lunchEnd !== undefined) || !isSaturday;

      workingHours = {
        start,
        end,
        hasLunch,
        lunchStart: hours.lunchStart,
        lunchEnd: hours.lunchEnd
      };
    } else if (dayOfWeek === 6) { // Sábado
      workingHours = { start: 10, end: 14, hasLunch: false }; // 10 AM - 2 PM
    } else { // Lunes a viernes
      workingHours = { start: 10, end: 18, hasLunch: true, lunchStart: 14, lunchEnd: 15 }; // 10 AM - 6 PM
    }

    // Completar horario de comida si está habilitado pero no se definió
    if (workingHours.hasLunch) {
      if (!Number.isFinite(workingHours.lunchStart)) {
        workingHours.lunchStart = config.workingHours.lunchStartHour || 14;
      }
      if (!Number.isFinite(workingHours.lunchEnd)) {
        workingHours.lunchEnd = config.workingHours.lunchEndHour || 15;
      }
    }

    console.log(`📅 Horario: ${workingHours.start}:00 - ${workingHours.end}:00`);
    if (workingHours.hasLunch) {
      console.log(`🍽️ Horario comida: ${workingHours.lunchStart}:00 - ${workingHours.lunchEnd}:00`);
    }

    // Usar la lógica robusta de generación con solapamientos reales
    const availableSlots = await generateSlotsForDay(
      calendar,
      calendarId,
      dateMoment,
      workingHours,
      durationMinutes
    );

    console.log(`📊 Total slots disponibles: ${availableSlots.length}`);
    return availableSlots;

  } catch (error) {
    console.error('❌ Error en findAvailableSlots:', error.message);
    return [];
  }
}

/**
 * Función auxiliar para generar slots para un día específico
 */
async function generateSlotsForDay(calendar, calendarId, dateMoment, workingHours, durationMinutes) {
  try {
    const dayOfWeek = dateMoment.day(); // 0 = Domingo, 1 = Lunes, ..., 6 = Sábado
    const startOfDay = dateMoment.clone().hour(workingHours.start).minute(0).second(0);
    // CORRECCIÓN: El timeMax debe incluir el final del último slot
    // Para sábados (10 AM - 2 PM), el último slot es 2 PM - 3 PM, así que timeMax debe ser 15:00 (3 PM)
    // Para días normales (10 AM - 6 PM), el último slot es 6 PM - 7 PM, así que timeMax debe ser 19:00 (7 PM)
    const endOfDay = dateMoment.clone().hour(workingHours.end + 1).minute(0).second(0);
    
    console.log(`📅 === CONFIGURACIÓN DE SLOTS ===`);
    console.log(`   - Horario laboral: ${workingHours.start}:00 - ${workingHours.end}:00`);
    console.log(`   - Última sesión: ${workingHours.end}:00 - ${workingHours.end + 1}:00`);
    console.log(`   - Rango de consulta al calendario: ${startOfDay.format('HH:mm')} a ${endOfDay.format('HH:mm')}`);
    
    console.log(`📅 Fechas calculadas en ${config.timezone.default}:`);
    console.log(`   - Inicio del día: ${startOfDay.format('YYYY-MM-DD HH:mm:ss z')}`);
    console.log(`   - Fin del día: ${endOfDay.format('YYYY-MM-DD HH:mm:ss z')} (incluye último slot hasta ${workingHours.end + 1}:00)`);
    console.log(`   - Horario de trabajo: ${workingHours.start}:00 - ${workingHours.end}:00`);
    console.log(`   - Horario de comida: Flexible según eventos del calendario`);
    
    const now = moment().tz(config.timezone.default);
    const minimumBookingTime = now.clone().add(1, 'hours');
    const ignoreMinimumBookingTime = workingHours && workingHours.ignoreMinimumBookingTime === true;
    
    const isToday = dateMoment.isSame(now, 'day');

    console.log(`   - Duración del servicio: ${durationMinutes} minutos`);
    console.log(`   - Es hoy: ${isToday}`);
    console.log(`   - Hora actual: ${now.format('HH:mm')}`);
    console.log(`   - Mínimo para agendar: ${minimumBookingTime.format('HH:mm')}`);
    if (ignoreMinimumBookingTime) {
      console.log(`   - Mínimo para agendar: ignorado (modo listado completo)`);
    }

    // CORRECCIÓN: Obtener eventos existentes en el calendario
    // timeMax debe ser hasta el final del último slot posible (8 PM)
    const response = await calendar.events.list({
      calendarId: calendarId,
      timeMin: startOfDay.toISOString(),
      timeMax: endOfDay.toISOString(),
      singleEvents: true,
      orderBy: 'startTime'
    });

    const events = response.data.items || [];
    console.log(`   - Eventos encontrados en calendario: ${events.length}`);
    console.log(`   - Rango consultado: ${startOfDay.format('YYYY-MM-DD HH:mm')} a ${endOfDay.format('YYYY-MM-DD HH:mm')}`);

    // 🔍 LOGGING DETALLADO: Mostrar todos los eventos encontrados
    if (events.length === 0) {
      console.log(`   ✅ No hay eventos ocupados en este día - todos los slots deberían estar disponibles`);
    } else {
      console.log(`   📋 === EVENTOS ENCONTRADOS EN EL CALENDARIO ===`);
      events.forEach((event, index) => {
        const eventStartRaw = moment(event.start.dateTime || event.start.date).tz(config.timezone.default);
        const eventEndRaw = moment(event.end.dateTime || event.end.date).tz(config.timezone.default);
        console.log(`   📅 Evento ${index + 1}: "${event.summary || 'Sin título'}"`);
        console.log(`      - Inicio RAW: ${eventStartRaw.format('YYYY-MM-DD HH:mm:ss.SSS z')}`);
        console.log(`      - Fin RAW: ${eventEndRaw.format('YYYY-MM-DD HH:mm:ss.SSS z')}`);
        console.log(`      - Hora inicio: ${eventStartRaw.format('HH:mm')}`);
        console.log(`      - Hora fin: ${eventEndRaw.format('HH:mm')}`);
        console.log(`      - Duración: ${eventEndRaw.diff(eventStartRaw, 'minutes')} minutos`);
      });
    }

    // Crear lista de slots ocupados solo con eventos del calendario
    // CORRECCIÓN CRÍTICA: Parsear y normalizar eventos de forma consistente para TODOS los días
    const targetDateStr = dateMoment.format('YYYY-MM-DD');
    const busySlots = events.map(event => {
      let eventStart, eventEnd;
      
      try {
        // Parsear fecha de inicio
        if (event.start.dateTime) {
          // CORRECCIÓN CRÍTICA: Respetar el offset/zonahoraria del evento y convertir a MX
          eventStart = moment.parseZone(event.start.dateTime).tz(config.timezone.default);
          if (!eventStart.isValid()) {
            console.warn(`⚠️ Evento "${event.summary}" tiene fecha de inicio inválida: ${event.start.dateTime}`);
            return null;
          }
        } else if (event.start.date) {
          // Evento de día completo - convertir a inicio del día
          eventStart = moment.tz(event.start.date, 'YYYY-MM-DD', config.timezone.default).startOf('day');
          if (!eventStart.isValid()) {
            console.warn(`⚠️ Evento "${event.summary}" tiene fecha de inicio inválida: ${event.start.date}`);
            return null;
          }
        } else {
          console.warn(`⚠️ Evento sin fecha de inicio válida: ${event.summary}`);
          return null;
        }
        
        // Parsear fecha de fin
        if (event.end.dateTime) {
          // CORRECCIÓN CRÍTICA: Respetar el offset/zonahoraria del evento y convertir a MX
          eventEnd = moment.parseZone(event.end.dateTime).tz(config.timezone.default);
          if (!eventEnd.isValid()) {
            console.warn(`⚠️ Evento "${event.summary}" tiene fecha de fin inválida: ${event.end.dateTime}`);
            return null;
          }
        } else if (event.end.date) {
          // Evento de día completo - convertir a fin del día
          eventEnd = moment.tz(event.end.date, 'YYYY-MM-DD', config.timezone.default).endOf('day');
          if (!eventEnd.isValid()) {
            console.warn(`⚠️ Evento "${event.summary}" tiene fecha de fin inválida: ${event.end.date}`);
            return null;
          }
        } else {
          console.warn(`⚠️ Evento sin fecha de fin válida: ${event.summary}`);
          return null;
        }
        
        // CORRECCIÓN CRÍTICA: Normalizar a minutos exactos (sin segundos/milisegundos) para comparaciones precisas
        // IMPORTANTE: Normalizar AMBOS inicio y fin a minutos exactos para comparaciones precisas
        eventStart = eventStart.clone().second(0).millisecond(0);
        eventEnd = eventEnd.clone().second(0).millisecond(0);
        
        // CORRECCIÓN CRÍTICA: Filtrar eventos que NO están en el día objetivo
        // Esto es crucial para evitar que eventos de otros días afecten los slots
        const eventDate = eventStart.format('YYYY-MM-DD');
        if (eventDate !== targetDateStr) {
          // Silenciosamente ignorar eventos de otros días
          return null;
        }
      } catch (parseError) {
        console.error(`❌ Error parseando evento "${event.summary}":`, parseError.message);
        return null;
      }
      
      // CORRECCIÓN CRÍTICA: Logging detallado para verificar el parseo
      const eventHour = eventStart.hour();
      const eventMinute = eventStart.minute();
      const eventEndHour = eventEnd.hour();
      const eventEndMinute = eventEnd.minute();
      const eventDateFormatted = eventStart.format('YYYY-MM-DD');
      
      console.log(`      🔍 Evento parseado: "${event.summary || 'Sin título'}"`);
      console.log(`         - Fecha: ${eventDateFormatted}`);
      console.log(`         - Inicio normalizado: ${eventStart.format('YYYY-MM-DD HH:mm:ss z')} (hora ${eventHour}:${eventMinute.toString().padStart(2, '0')})`);
      console.log(`         - Fin normalizado: ${eventEnd.format('YYYY-MM-DD HH:mm:ss z')} (hora ${eventEndHour}:${eventEndMinute.toString().padStart(2, '0')})`);
      console.log(`         - Este evento DEBERÍA bloquear slots de ${eventHour}:00 a ${eventEndHour}:00`);
      
      return {
        start: eventStart,
        end: eventEnd,
        type: `appointment: ${event.summary || 'Sin título'}`,
        originalSummary: event.summary || 'Sin título'
      };
    }).filter(slot => slot !== null); // Filtrar eventos inválidos y eventos de otros días

    // CORRECCIÓN CRÍTICA: Los eventos ya fueron filtrados por fecha en el map (línea 240)
    // Solo necesitamos ordenarlos
    // Ordenar slots ocupados por hora de inicio
    busySlots.sort((a, b) => a.start.valueOf() - b.start.valueOf());
    
    // Usar eventos ya filtrados
    const busySlotsFinal = busySlots;

    // SOLUCIÓN DEFINITIVA: Crear un mapa de horas ocupadas ANTES de generar slots
    // Esto detecta TODOS los eventos simultáneos de una vez
    const occupiedHoursMap = new Map(); // Map<hour, count>
    const eventsByHourMap = new Map(); // Map<hour, events[]>
    
    busySlotsFinal.forEach(event => {
      const eventHour = event.start.hour();
      const eventMinute = event.start.minute();
      const hourKey = `${eventHour}:${eventMinute.toString().padStart(2, '0')}`;
      
      // Contar eventos por hora
      const currentCount = occupiedHoursMap.get(eventHour) || 0;
      occupiedHoursMap.set(eventHour, currentCount + 1);
      
      // Agrupar eventos por hora exacta
      if (!eventsByHourMap.has(hourKey)) {
        eventsByHourMap.set(hourKey, []);
      }
      eventsByHourMap.get(hourKey).push(event);
    });
    
    // Identificar horas con múltiples eventos simultáneos
    const simultaneousHours = new Set();
    occupiedHoursMap.forEach((count, hour) => {
      if (count >= 2) {
        simultaneousHours.add(hour);
        console.log(`   🚫 HORA CON MÚLTIPLES EVENTOS: ${hour}:00 tiene ${count} evento(s) simultáneo(s)`);
        const hourKey = `${hour}:00`;
        const events = eventsByHourMap.get(hourKey) || [];
        events.forEach((evt, idx) => {
          console.log(`      ${idx + 1}. "${evt.originalSummary || evt.type}" (${evt.start.format('HH:mm')}-${evt.end.format('HH:mm')})`);
        });
      }
    });

    console.log(`   - Slots ocupados por eventos (del día ${targetDateStr}): ${busySlotsFinal.length}`);
    console.log(`   - Horas con eventos simultáneos: ${simultaneousHours.size} (${Array.from(simultaneousHours).join(', ')})`);
    console.log(`   📋 === RESUMEN DE EVENTOS QUE DEBERÍAN BLOQUEAR SLOTS ===`);
    if (busySlotsFinal.length === 0) {
      console.log(`      ⚠️ No se encontraron eventos ocupados en este día`);
      console.log(`      ✅ Todos los slots deberían estar disponibles`);
    } else {
      console.log(`      📊 Total eventos encontrados: ${busySlotsFinal.length}`);
      busySlotsFinal.forEach((slot, index) => {
        const durationHours = slot.end.diff(slot.start, 'hours', true);
        const eventHour = slot.start.hour();
        const eventMin = slot.start.minute();
        const isSimultaneous = simultaneousHours.has(eventHour);
        
        console.log(`      ${index + 1}. ${slot.start.format('HH:mm')}-${slot.end.format('HH:mm')} (${durationHours.toFixed(2)} horas) - ${slot.type} ${isSimultaneous ? '⚠️ SIMULTÁNEO' : ''}`);
        console.log(`         📅 Fecha: ${slot.start.format('YYYY-MM-DD')}`);
        console.log(`         ⏰ Hora inicio: ${eventHour}:${eventMin.toString().padStart(2, '0')}`);
        console.log(`         🚫 Este evento DEBERÍA bloquear el slot ${eventHour}:00-${eventHour + 1}:00`);
        console.log(`         (${slot.start.format('YYYY-MM-DD HH:mm:ss z')} → ${slot.end.format('YYYY-MM-DD HH:mm:ss z')})`);
      });
    }

    // Función auxiliar para verificar si un horario está fuera del horario laboral
    // CORRECCIÓN: Permitir hasta la última hora (6 PM) como inicio de sesión
    const isOutsideWorkingHours = (time) => {
      const hour = time.hour();
      return hour < workingHours.start || hour > workingHours.end;
    };

    // Generar slots hora por hora y verificar disponibilidad individualmente
    const availableSlots = [];
    
    // Función auxiliar para verificar si un slot específico está ocupado
    // CORRECCIÓN CRÍTICA: Cada slot se evalúa INDEPENDIENTEMENTE
    // Un slot está ocupado SOLO si hay un evento que solapa con ese slot específico
    const isSlotOccupied = (slotTime) => {
      const slotEnd = slotTime.clone().add(1, 'hour');
      const slotHour = slotTime.hour();
      const slotDate = slotTime.format('YYYY-MM-DD');
      
      // CORRECCIÓN CRÍTICA: Usar solo eventos del día objetivo (ya filtrados arriba)
      // Si no hay eventos ocupados, el slot está disponible
      if (busySlotsFinal.length === 0) {
        return false;
      }
      
      console.log(`      🔎 Verificando overlap para slot ${slotTime.format('HH:mm')}-${slotEnd.format('HH:mm')} (hora ${slotHour}):`);
      console.log(`         Total eventos a verificar: ${busySlotsFinal.length}`);
      console.log(`         Slot inicio: ${slotTime.format('YYYY-MM-DD HH:mm:ss z')}`);
      console.log(`         Slot fin: ${slotEnd.format('YYYY-MM-DD HH:mm:ss z')}`);
      console.log(`         Slot fecha: ${slotDate}`);
      
      // CORRECCIÓN CRÍTICA: Identificar eventos que empiezan exactamente a la misma hora del slot
      // Esto es importante para detectar eventos duplicados/simultáneos
      // NUEVA FUNCIONALIDAD: Si hay 2 o más eventos a la misma hora, el slot se marca como NO disponible
      // Normalizar slotTime para comparación precisa
      const slotTimeNormalized = slotTime.clone().second(0).millisecond(0);
      const slotEndNormalized = slotTimeNormalized.clone().add(1, 'hour');
      const slotStartHour = slotTimeNormalized.hour();
      const slotStartMin = slotTimeNormalized.minute();
      
      // SOLUCIÓN DEFINITIVA: Usar el mapa pre-construido para verificación rápida
      // Esto es más eficiente y garantiza que TODOS los eventos simultáneos se detecten
      const eventCount = occupiedHoursMap.get(slotStartHour) || 0;
      const hourKey = `${slotStartHour}:${slotStartMin.toString().padStart(2, '0')}`;
      const eventsAtThisHour = eventsByHourMap.get(hourKey) || [];
      
      let slotIsOccupied = false;
      let blockingEvent = null;
      let blockingEventsCount = 0;
      
      // CORRECCIÓN CRÍTICA: Si hay eventos que empiezan exactamente a esta hora, el slot está OCUPADO
      // Un evento que empieza a las 13:00 bloquea el slot 13:00-14:00
      if (eventCount >= 1) {
        console.log(`         🔍 Verificando eventos a la hora ${slotStartHour}:${slotStartMin.toString().padStart(2, '0')}`);
        console.log(`         📊 Total eventos encontrados a esta hora: ${eventsAtThisHour.length}`);
        
        // Verificar que el evento realmente empieza exactamente cuando el slot empieza
        const eventsAtExactTime = eventsAtThisHour.filter(evt => {
          const evtStartHour = evt.start.hour();
          const evtStartMin = evt.start.minute();
          const matches = evtStartHour === slotStartHour && evtStartMin === slotStartMin;
          
          console.log(`            🔎 Evento: "${evt.originalSummary || evt.type}"`);
          console.log(`               - Hora inicio evento: ${evtStartHour}:${evtStartMin.toString().padStart(2, '0')}`);
          console.log(`               - Hora inicio slot: ${slotStartHour}:${slotStartMin.toString().padStart(2, '0')}`);
          console.log(`               - ¿Coinciden exactamente? ${matches ? '✅ SÍ - BLOQUEA SLOT' : '❌ NO'}`);
          
          return matches;
        });
        
        if (eventsAtExactTime.length > 0) {
          // HAY EVENTOS QUE EMPIEZAN EXACTAMENTE A ESTA HORA - Slot OCUPADO
          slotIsOccupied = true;
          blockingEvent = eventsAtExactTime[0];
          blockingEventsCount = eventsAtExactTime.length;
          
          console.log(`         🚫 EVENTO(S) QUE EMPIEZA(N) EXACTAMENTE A LAS ${slotStartHour}:${slotStartMin.toString().padStart(2, '0')} - Slot OCUPADO`);
          eventsAtExactTime.forEach((evt, idx) => {
            console.log(`            ${idx + 1}. "${evt.originalSummary || evt.type}" (${evt.start.format('HH:mm')}-${evt.end.format('HH:mm')})`);
            console.log(`               📅 Fecha evento: ${evt.start.format('YYYY-MM-DD')}`);
            console.log(`               📅 Fecha slot: ${slotDate}`);
          });
          
          // Retornar inmediatamente - no necesitamos verificar más
          // Si un evento empieza exactamente cuando el slot empieza, definitivamente lo bloquea
          console.log(`         ❌ RETORNANDO TRUE - Slot está OCUPADO por evento(s) que empiezan exactamente a esta hora`);
          return true;
        } else {
          console.log(`         ℹ️ No hay eventos que empiecen exactamente a las ${slotStartHour}:${slotStartMin.toString().padStart(2, '0')}, continuando verificación de solapamiento...`);
        }
      }
      
      // CORRECCIÓN: Verificar cada evento individualmente
      // Si UN evento solapa con el slot, el slot está ocupado
      // Pero cada slot se evalúa INDEPENDIENTEMENTE - un evento a las 10 AM NO debe bloquear el slot de 11 AM
      // NOTA: Si ya detectamos eventos simultáneos, seguimos verificando para contar todos los conflictos
      
      // Usar solo eventos del día objetivo (ya filtrados)
      const eventsToCheck = busySlotsFinal;
      
      for (const busySlot of eventsToCheck) {
        // CORRECCIÓN CRÍTICA: Verificar si hay solapamiento entre el slot propuesto y el evento ocupado
        // 
        // REGLAS DE SOLAPAMIENTO:
        // 1. Si el evento TERMINA exactamente cuando el slot EMPIEZA → NO hay solapamiento (slot disponible)
        //    Ejemplo: Evento 12:00-13:00 NO bloquea slot 13:00-14:00
        // 2. Si el evento EMPIEZA exactamente cuando el slot EMPIEZA → SÍ hay solapamiento (slot ocupado)
        //    Ejemplo: Evento 13:00-14:00 SÍ bloquea slot 13:00-14:00
        // 3. Si el evento SOLAPA con el slot → SÍ hay solapamiento (slot ocupado)
        //    Ejemplo: Evento 12:30-13:30 SÍ bloquea slot 13:00-14:00
        //
        // SOLAPAMIENTO REAL ocurre cuando:
        // - El slot empieza ANTES de que termine el evento Y
        // - El slot termina DESPUÉS de que empiece el evento
        // - EXCEPTO cuando el evento termina exactamente cuando el slot empieza
        
        // CORRECCIÓN CRÍTICA: Lógica de solapamiento simplificada y más robusta
        // 
        // REGLAS DE SOLAPAMIENTO:
        // 1. Si el evento TERMINA exactamente cuando el slot EMPIEZA → NO hay solapamiento
        //    Ejemplo: Evento 12:00-13:00 NO bloquea slot 13:00-14:00
        // 2. Si el evento EMPIEZA exactamente cuando el slot EMPIEZA → SÍ hay solapamiento
        //    Ejemplo: Evento 10:00-11:00 SÍ bloquea slot 10:00-11:00
        // 3. Si el evento SOLAPA con el slot → SÍ hay solapamiento
        //    Ejemplo: Evento 10:00-11:00 SÍ bloquea slot 10:00-11:00
        //
        // SOLAPAMIENTO ocurre cuando:
        // - El slot empieza ANTES de que termine el evento Y
        // - El slot termina DESPUÉS de que empiece el evento
        // - EXCEPTO cuando el evento termina exactamente cuando el slot empieza
        
        // CORRECCIÓN CRÍTICA: Verificar que el evento esté en el mismo día que el slot
        // (Los eventos ya fueron filtrados por fecha arriba, pero verificamos de nuevo por seguridad)
        const eventDate = busySlot.start.format('YYYY-MM-DD');
        if (eventDate !== slotDate) {
          console.log(`         ⏭️ Saltando evento: está en fecha ${eventDate} pero el slot está en ${slotDate}`);
          continue;
        }
        
        // CORRECCIÓN CRÍTICA: Normalizar ambos para comparación precisa
        // Los eventos ya están normalizados arriba, pero normalizamos de nuevo para asegurar consistencia
        // NOTA: slotTimeNormalized y slotEndNormalized ya están definidos arriba, no redefinirlos aquí
        const eventStartNormalized = busySlot.start.clone().second(0).millisecond(0);
        const eventEndNormalized = busySlot.end.clone().second(0).millisecond(0);
        
        // CORRECCIÓN CRÍTICA: Comparación directa de horas y minutos para mayor precisión
        const eventStartHour = eventStartNormalized.hour();
        const eventStartMin = eventStartNormalized.minute();
        const eventEndHour = eventEndNormalized.hour();
        const eventEndMin = eventEndNormalized.minute();
        const slotStartHour = slotTimeNormalized.hour();
        const slotStartMin = slotTimeNormalized.minute();
        
        // Caso 1: Si el evento TERMINA exactamente cuando el slot EMPIEZA → NO hay solapamiento
        // Ejemplo: Evento 12:00-13:00 NO bloquea slot 13:00-14:00
        if (eventEndHour === slotStartHour && eventEndMin === slotStartMin) {
          console.log(`         ✅ CASO LÍMITE: Evento termina exactamente cuando slot empieza (${eventEndNormalized.format('HH:mm')} = ${slotTimeNormalized.format('HH:mm')}) - NO hay solapamiento`);
          continue; // Continuar con el siguiente evento
        }
        
        // Caso 1.5: Si el evento EMPIEZA exactamente cuando el slot TERMINA → NO hay solapamiento
        // Ejemplo: Evento 14:00-15:00 NO bloquea slot 13:00-14:00
        const slotEndHour = slotEndNormalized.hour();
        const slotEndMin = slotEndNormalized.minute();
        if (eventStartHour === slotEndHour && eventStartMin === slotEndMin) {
          console.log(`         ✅ CASO LÍMITE: Evento empieza exactamente cuando slot termina (${eventStartNormalized.format('HH:mm')} = ${slotEndNormalized.format('HH:mm')}) - NO hay solapamiento`);
          continue; // Continuar con el siguiente evento
        }
        
        // Caso 2: Si el evento EMPIEZA exactamente cuando el slot EMPIEZA → SÍ hay solapamiento
        // Ejemplo: Evento 10:00-11:00 SÍ bloquea slot 10:00-11:00
        // NOTA: Si ya detectamos eventos simultáneos arriba (eventsAtThisHour), este caso ya fue manejado
        // Solo procesar aquí si NO fue detectado arriba (caso raro pero posible)
        if (eventStartHour === slotStartHour && eventStartMin === slotStartMin) {
          // Si ya detectamos eventos simultáneos arriba, este evento ya fue contado
          // Verificar si este evento específico ya fue contado en eventsAtThisHour
          const wasAlreadyCounted = eventsAtThisHour.length > 0 && 
                                   eventsAtThisHour.some(evt => 
                                     evt.start.isSame(busySlot.start, 'minute') &&
                                     evt.originalSummary === busySlot.originalSummary
                                   );
          
          if (wasAlreadyCounted) {
            // Este evento ya fue contado arriba en eventsAtThisHour
            console.log(`         ℹ️ Evento ya contado arriba (eventos simultáneos): "${busySlot.originalSummary || busySlot.type}"`);
            continue; // Saltar este evento, ya fue procesado
          }
          
          // Si llegamos aquí, este evento empieza a la misma hora pero no fue detectado arriba
          // (caso raro, pero manejarlo por seguridad)
          console.log(`         ⚠️ Evento empieza exactamente cuando slot empieza (${eventStartNormalized.format('HH:mm')} = ${slotTimeNormalized.format('HH:mm')}) - SÍ hay solapamiento`);
          console.log(`         📋 Evento: "${busySlot.originalSummary || busySlot.type}" de ${eventStartNormalized.format('HH:mm')} a ${eventEndNormalized.format('HH:mm')}`);
          
          if (!slotIsOccupied) {
            // Este es el primer evento que detectamos en el loop (caso raro)
            blockingEvent = busySlot;
            slotIsOccupied = true;
            blockingEventsCount = 1;
          } else {
            // Ya estaba ocupado, agregar este evento al conteo
            blockingEventsCount++;
            console.log(`         ⚠️ EVENTO ADICIONAL detectado: "${busySlot.originalSummary || busySlot.type}" - Total eventos bloqueando: ${blockingEventsCount}`);
          }
          // Continuar verificando otros eventos para logging, pero el slot ya está marcado como ocupado
          continue;
        }
        
        // Caso 3: Verificar solapamiento general
        // CORRECCIÓN CRÍTICA: Lógica simplificada y robusta que captura TODOS los casos de solapamiento
        // 
        // Regla general de solapamiento de intervalos [a1, a2] y [b1, b2]:
        // Hay solapamiento si: a1 < b2 AND a2 > b1
        //
        // En nuestro caso:
        // - Slot: [slotTimeNormalized, slotEndNormalized]
        // - Evento: [eventStartNormalized, eventEndNormalized]
        //
        // Hay solapamiento si:
        // - slotTimeNormalized < eventEndNormalized AND slotEndNormalized > eventStartNormalized
        //
        // EXCEPCIÓN: Si eventEndNormalized == slotTimeNormalized (evento termina exactamente cuando slot empieza),
        // NO hay solapamiento (ya manejado en Caso 1)
        
        // CORRECCIÓN: Verificar solapamiento usando la regla general
        // Esto captura TODOS los casos de solapamiento excepto el caso límite ya excluido
        const slotStartsBeforeEventEnds = slotTimeNormalized.isBefore(eventEndNormalized);
        const slotEndsAfterEventStarts = slotEndNormalized.isAfter(eventStartNormalized);
        
        // Verificar solapamiento básico
        let hasOverlap = slotStartsBeforeEventEnds && slotEndsAfterEventStarts;
        
        // CORRECCIÓN CRÍTICA: La verificación básica ya captura todos los casos de solapamiento real
        // NO usar comparaciones inclusivas porque pueden marcar incorrectamente como solapados
        // los slots que solo se tocan en un punto (ej: slot 13:00-14:00 y evento 14:00-15:00)
        // El Caso 1 ya maneja correctamente cuando evento termina exactamente cuando slot empieza
        
        // CORRECCIÓN ADICIONAL: Verificación explícita de casos específicos para asegurar que no se nos escape ningún solapamiento
        // Esto es una verificación de seguridad adicional
        // IMPORTANTE: Excluir casos donde los intervalos solo se tocan en un punto
        if (!hasOverlap) {
          // Verificar casos específicos que podrían no ser capturados por la condición general
          
          // Caso A: Evento empieza dentro del slot (después del inicio, antes o igual al fin)
          // EXCLUIR: Si evento empieza exactamente cuando slot termina → NO hay solapamiento
          const eventStartsDuringSlot = eventStartNormalized.isAfter(slotTimeNormalized, 'minute') && 
                                       eventStartNormalized.isBefore(slotEndNormalized, 'minute');
          
          // Caso B: Evento termina dentro del slot (después del inicio, antes del fin)
          // EXCLUIR: Si evento termina exactamente cuando slot empieza → NO hay solapamiento (ya manejado en Caso 1)
          const eventEndsDuringSlot = eventEndNormalized.isAfter(slotTimeNormalized, 'minute') && 
                                     eventEndNormalized.isBefore(slotEndNormalized, 'minute');
          
          // Caso C: Evento contiene completamente el slot
          // EXCLUIR: Si evento empieza cuando slot empieza y termina cuando slot termina → ya manejado en Caso 2
          const eventContainsSlot = eventStartNormalized.isBefore(slotTimeNormalized, 'minute') && 
                                   eventEndNormalized.isAfter(slotEndNormalized, 'minute');
          
          // Caso D: Slot contiene completamente el evento
          // EXCLUIR: Si slot empieza cuando evento empieza → ya manejado en Caso 2
          const slotContainsEvent = slotTimeNormalized.isBefore(eventStartNormalized, 'minute') && 
                                   slotEndNormalized.isAfter(eventEndNormalized, 'minute');
          
          // Si alguno de estos casos se cumple, definitivamente hay solapamiento
          if (eventStartsDuringSlot || eventEndsDuringSlot || eventContainsSlot || slotContainsEvent) {
            hasOverlap = true;
            console.log(`         ⚠️ Solapamiento detectado por verificación adicional:`);
            if (eventStartsDuringSlot) console.log(`            - Evento empieza dentro del slot (${eventStartNormalized.format('HH:mm')})`);
            if (eventEndsDuringSlot) console.log(`            - Evento termina dentro del slot (${eventEndNormalized.format('HH:mm')})`);
            if (eventContainsSlot) console.log(`            - Evento contiene completamente el slot`);
            if (slotContainsEvent) console.log(`            - Slot contiene completamente el evento`);
          }
        }
        
        // Logging específico para el slot de 1 PM en sábados
        const isSaturday1PM = slotTime.hour() === 13 && dateMoment.day() === 6;
        if (isSaturday1PM) {
          console.log(`         🔍 === VERIFICACIÓN ESPECIAL SLOT 1 PM (SÁBADO) ===`);
          console.log(`         Evento: ${busySlot.start.format('HH:mm')}-${busySlot.end.format('HH:mm')} (${busySlot.type})`);
          console.log(`         Slot: ${slotTime.format('HH:mm')}-${slotEnd.format('HH:mm')}`);
          console.log(`         ¿Evento empieza a la 1 PM? ${busySlot.start.isSame(slotTime, 'minute') ? 'SÍ - Slot DEBE estar ocupado' : 'NO'}`);
          console.log(`         ¿Evento termina exactamente cuando slot empieza? ${busySlot.end.isSame(slotTime, 'minute') ? 'SÍ - Slot DEBE estar disponible' : 'NO'}`);
          console.log(`         Slot inicio (${slotTime.format('HH:mm:ss')}) < Evento fin (${busySlot.end.format('HH:mm:ss')}): ${slotStartsBeforeEventEnds}`);
          console.log(`         Slot fin (${slotEnd.format('HH:mm:ss')}) > Evento inicio (${busySlot.start.format('HH:mm:ss')}): ${slotEndsAfterEventStarts}`);
          console.log(`         Overlap: ${hasOverlap ? 'SÍ ❌ - Slot OCUPADO' : 'NO ✓ - Slot DISPONIBLE'}`);
        } else {
          console.log(`         Evento: ${busySlot.start.format('HH:mm')}-${busySlot.end.format('HH:mm')} (${busySlot.type})`);
          console.log(`            Evento inicio: ${busySlot.start.format('YYYY-MM-DD HH:mm:ss z')}`);
          console.log(`            Evento fin: ${busySlot.end.format('YYYY-MM-DD HH:mm:ss z')}`);
          console.log(`            Slot: ${slotTime.format('HH:mm')}-${slotEnd.format('HH:mm')}`);
          console.log(`            Slot inicio (${slotTime.format('HH:mm')}) < Evento fin (${busySlot.end.format('HH:mm')}): ${slotStartsBeforeEventEnds}`);
          console.log(`            Slot fin (${slotEnd.format('HH:mm')}) > Evento inicio (${busySlot.start.format('HH:mm')}): ${slotEndsAfterEventStarts}`);
          console.log(`            Overlap: ${hasOverlap ? 'SÍ ❌ - Slot DEBE estar OCUPADO' : 'NO ✓ - Slot DISPONIBLE'}`);
          
          // CORRECCIÓN CRÍTICA: Validación de seguridad para eventos que empiezan a la misma hora
          // Esta validación solo se ejecuta si NO detectamos el solapamiento en el Caso 2
          // Si un evento empieza exactamente cuando el slot empieza, DEBE haber solapamiento
          // NOTA: Esta validación solo se ejecuta si no entramos al Caso 2 (línea 423)
          // porque si entramos al Caso 2, hacemos continue y nunca llegamos aquí
          if (eventStartHour === slotStartHour && eventStartMin === slotStartMin && !slotIsOccupied) {
            console.error(`            ❌ ERROR CRÍTICO: Evento empieza a la misma hora que el slot pero no se detectó solapamiento en Caso 2!`);
            console.error(`            ❌ Esto NO debería suceder - el Caso 2 debería haberlo detectado`);
            console.error(`            ❌ Evento: ${eventStartNormalized.format('YYYY-MM-DD HH:mm:ss')} - ${eventEndNormalized.format('YYYY-MM-DD HH:mm:ss')}`);
            console.error(`            ❌ Slot: ${slotTimeNormalized.format('YYYY-MM-DD HH:mm:ss')} - ${slotEndNormalized.format('YYYY-MM-DD HH:mm:ss')}`);
            console.error(`            ❌ FORZANDO slot como ocupado debido a error de detección`);
            // FORZAR el slot como ocupado si hay un error de detección
            blockingEvent = busySlot;
            slotIsOccupied = true;
            blockingEventsCount = 1;
            // Continuar para detectar otros eventos potenciales
          }
        }
        
        if (hasOverlap) {
          // CORRECCIÓN: No hacer break aquí para detectar TODOS los eventos que bloquean este slot
          // Esto es especialmente importante para eventos simultáneos
          if (!slotIsOccupied) {
            blockingEvent = busySlot;
            slotIsOccupied = true;
            blockingEventsCount = 1;
          } else {
            blockingEventsCount++;
            console.log(`         ⚠️ EVENTO ADICIONAL BLOQUEANDO: "${busySlot.originalSummary || busySlot.type}" - Total: ${blockingEventsCount}`);
          }
          
          if (isSaturday1PM) {
            console.log(`         🔒 CONFLICTO DETECTADO con slot de 1 PM: ${busySlot.type}`);
            console.log(`         ⚠️ ADVERTENCIA: El slot de 1 PM está siendo marcado como ocupado`);
          } else {
            console.log(`         🔒 CONFLICTO DETECTADO con: ${busySlot.type}`);
          }
          // Continuar verificando otros eventos para logging completo
          // El slot ya está marcado como ocupado, pero queremos registrar todos los conflictos
        }
      }
      
      // Retornar el resultado después de verificar TODOS los eventos
      if (slotIsOccupied) {
        if (blockingEventsCount >= 2) {
          // Caso especial: Múltiples eventos simultáneos a la misma hora
          console.log(`         ❌ Slot OCUPADO - Bloqueado por ${blockingEventsCount} evento(s) simultáneo(s) a las ${slotStartHour}:${slotStartMin.toString().padStart(2, '0')}`);
          console.log(`            🚫 Esta hora NO está disponible debido a múltiples eventos simultáneos`);
          console.log(`            Primer evento bloqueador: ${blockingEvent ? `${blockingEvent.start.format('HH:mm')}-${blockingEvent.end.format('HH:mm')} - "${blockingEvent.originalSummary || blockingEvent.type}"` : 'N/A'}`);
          console.log(`            ⚠️ IMPORTANTE: Hay ${blockingEventsCount} evento(s) que empiezan a la misma hora - el slot está ocupado`);
        } else {
          console.log(`         ❌ Slot OCUPADO - Bloqueado por: ${blockingEvent ? blockingEvent.type : 'evento desconocido'}`);
          console.log(`            Evento bloqueador: ${blockingEvent ? `${blockingEvent.start.format('HH:mm')}-${blockingEvent.end.format('HH:mm')} - "${blockingEvent.originalSummary || blockingEvent.type}"` : 'N/A'}`);
        }
        return true;
      } else {
        console.log(`         ✅ Sin conflictos - Slot DISPONIBLE`);
        console.log(`            Ningún evento solapa con este slot específico`);
        // Verificación adicional de seguridad: confirmar que no hay eventos que empiecen exactamente a esta hora
        // Esta es una verificación de seguridad para detectar posibles errores en la lógica
        // NOTA: Usar slotStartHour que está definido arriba, no slotHour
        const eventsAtSlotStartTimeFinal = busySlotsFinal.filter(event => {
          const eventStartNormalized = event.start.clone().second(0).millisecond(0);
          const eventStartHour = eventStartNormalized.hour();
          const eventStartMin = eventStartNormalized.minute();
          // Verificar si el evento empieza exactamente cuando el slot empieza (misma hora y minutos)
          return eventStartHour === slotStartHour && eventStartMin === slotStartMin;
        });
        if (eventsAtSlotStartTimeFinal.length > 0) {
          console.error(`         ❌ ERROR CRÍTICO: Se encontraron ${eventsAtSlotStartTimeFinal.length} evento(s) que empiezan exactamente a las ${slotStartHour}:${slotStartMin.toString().padStart(2, '0')} pero NO se detectó solapamiento!`);
          console.error(`         ❌ Esto NO debería suceder - debería haberse detectado arriba o en el Caso 2`);
          eventsAtSlotStartTimeFinal.forEach(evt => {
            console.error(`            - ${evt.start.format('HH:mm')}-${evt.end.format('HH:mm')} - "${evt.originalSummary || evt.type}"`);
            const evtStartNorm = evt.start.clone().second(0).millisecond(0);
            console.error(`              Evento normalizado: ${evtStartNorm.format('YYYY-MM-DD HH:mm:ss')} (hora: ${evtStartNorm.hour()}, min: ${evtStartNorm.minute()})`);
            console.error(`              Slot normalizado: ${slotTimeNormalized.format('YYYY-MM-DD HH:mm:ss')} (hora: ${slotStartHour}, min: ${slotStartMin})`);
          });
          console.error(`         ❌ FORZANDO slot como ocupado por seguridad debido a error de detección`);
          // Si encontramos eventos que empiezan exactamente a esta hora pero no detectamos solapamiento,
          // algo está mal. Marcar el slot como ocupado por seguridad.
          return true;
        }
        return false;
      }
    };

    // SOLUCIÓN DEFINITIVA: Forzar horario de inicio a 10 AM y fin a 6 PM antes de generar slots
    if (dayOfWeek !== 6) {
      if (workingHours.start < 10) {
        console.warn(`   ⚠️ CORRIGIENDO: Horario de inicio era ${workingHours.start}:00, forzando a 10:00`);
        workingHours.start = 10;
      }
      if (workingHours.end > 18) {
        console.warn(`   ⚠️ CORRIGIENDO: Horario de fin era ${workingHours.end}:00, forzando a 18:00 (6 PM)`);
        workingHours.end = 18;
      }
    }
    
    // CORRECCIÓN: Generar slots de hora en hora desde el inicio hasta el fin del día laboral
    // Incluir el slot de la última hora como última sesión del día
    // Para sábados: 10 AM - 2 PM (última sesión: 2 PM - 3 PM)
    // Para días normales: 10 AM - 6 PM (última sesión: 6 PM - 7 PM)
    console.log(`\n🔄 === GENERANDO SLOTS DE ${workingHours.start}:00 A ${workingHours.end}:00 ===`);
    console.log(`   ✅ Horario de inicio: ${workingHours.start}:00 ${workingHours.start === 10 ? '(CORRECTO)' : '(VERIFICAR)'}`);
    console.log(`   📋 Rango completo: ${workingHours.start}:00 - ${workingHours.end}:00`);
    const totalPossibleSlots = workingHours.end - workingHours.start + 1;
    console.log(`   📋 Total slots posibles: ${totalPossibleSlots}`);
    const slotsToGenerate = Array.from({length: totalPossibleSlots}, (_, i) => workingHours.start + i);
    console.log(`   📋 Slots a generar: ${slotsToGenerate.join(', ')}`);
    console.log(`   📋 Eventos ocupados encontrados: ${busySlots.length}`);
    if (busySlots.length > 0) {
      console.log(`   📋 Eventos que podrían bloquear slots:`);
      busySlots.forEach((slot, idx) => {
        const durationHours = slot.end.diff(slot.start, 'hours', true);
        console.log(`      ${idx + 1}. ${slot.start.format('HH:mm')}-${slot.end.format('HH:mm')} (${durationHours.toFixed(2)} horas) - ${slot.type}`);
      });
    }
    
    // CORRECCIÓN CRÍTICA: Rastrear qué slots se evaluaron y por qué fueron rechazados
    const slotsEvaluated = [];
    const slotsRejected = [];
    
    // SOLUCIÓN DEFINITIVA: Asegurar que el bucle empiece desde 10 AM (excepto sábados)
    const startHour = (dayOfWeek !== 6 && workingHours.start < 10) ? 10 : workingHours.start;
    
    for (let hour = startHour; hour <= workingHours.end; hour++) {
      // SOLUCIÓN DEFINITIVA: Verificar que no se generen slots antes de las 10 AM
      if (dayOfWeek !== 6 && hour < 10) {
        console.log(`      ❌ RECHAZADO: Hora ${hour}:00 es antes de las 10:00 AM (forzado)`);
        slotsRejected.push({ hour, reason: 'antes_de_10am' });
        continue;
      }
      
      // Normalizar a minutos exactos (sin segundos/milisegundos) para comparaciones precisas
      const slotTime = dateMoment.clone().hour(hour).minute(0).second(0).millisecond(0);
      const slotEnd = slotTime.clone().add(1, 'hour');
      
      // Logging específico para sábados
      const isSaturday = workingHours.end === 13;
      const isSaturdaySlot = isSaturday && hour === 13;
      const isSaturday10AM = isSaturday && hour === 10;
      const isSaturday12PM = isSaturday && hour === 12;
      
      if (isSaturdaySlot) {
        console.log(`\n   🔍 === EVALUANDO SLOT DE 1 PM (SÁBADO) ===`);
        console.log(`   📅 Slot: ${slotTime.format('HH:mm')}-${slotEnd.format('HH:mm')}`);
        console.log(`   📅 Este es el último slot del sábado - DEBE estar disponible si no hay conflicto`);
      } else if (isSaturday10AM) {
        console.log(`\n   🔍 === EVALUANDO SLOT DE 10 AM (SÁBADO) ===`);
        console.log(`   📅 Slot: ${slotTime.format('HH:mm')}-${slotEnd.format('HH:mm')}`);
        console.log(`   📅 Este slot DEBE estar ocupado si hay eventos a las 10 AM`);
        console.log(`   📅 Eventos encontrados: ${busySlots.length}`);
        busySlots.forEach((slot, idx) => {
          if (slot.start.hour() === 10 && slot.start.minute() === 0) {
            console.log(`      ${idx + 1}. Evento a las 10 AM: ${slot.start.format('HH:mm')}-${slot.end.format('HH:mm')} - ${slot.type}`);
          }
        });
      } else if (isSaturday12PM) {
        console.log(`\n   🔍 === EVALUANDO SLOT DE 12 PM (SÁBADO) ===`);
        console.log(`   📅 Slot: ${slotTime.format('HH:mm')}-${slotEnd.format('HH:mm')}`);
        console.log(`   📅 Este slot DEBE estar disponible si no hay eventos que lo bloqueen`);
      } else {
        console.log(`\n   🔍 Evaluando slot ${hour}: ${slotTime.format('HH:mm')}-${slotEnd.format('HH:mm')}`);
      }
      
      // CORRECCIÓN CRÍTICA: Rastrear cada slot evaluado
      slotsEvaluated.push(hour);
      
      // Verificar restricciones básicas
      // CORRECCIÓN: Permitir el slot de la última hora (2 PM para sábados, 6 PM para días normales)
      if (hour > workingHours.end) {
        console.log(`      ❌ RECHAZADO: fuera de horario laboral (hora ${hour} > ${workingHours.end})`);
        slotsRejected.push({ hour, reason: 'fuera_horario_laboral' });
        continue;
      }
      
      // CORRECCIÓN: Verificar si es horario de comida (excluir slots durante el horario de comida)
      if (workingHours.hasLunch && workingHours.lunchStart !== undefined && workingHours.lunchEnd !== undefined) {
        if (hour >= workingHours.lunchStart && hour < workingHours.lunchEnd) {
          console.log(`      ❌ RECHAZADO: Horario de comida (${workingHours.lunchStart}:00-${workingHours.lunchEnd}:00)`);
          slotsRejected.push({ hour, reason: 'horario_comida' });
          continue;
        }
      }
      
      if (isToday && !ignoreMinimumBookingTime && slotTime.isBefore(minimumBookingTime)) {
        console.log(`      ❌ RECHAZADO: muy pronto (hora actual: ${now.format('HH:mm')}, mínimo: ${minimumBookingTime.format('HH:mm')})`);
        slotsRejected.push({ hour, reason: 'muy_pronto' });
        continue;
      }
      
      // CORRECCIÓN CRÍTICA: Verificar si el slot está ocupado por algún evento (incluyendo comida)
      // Envolver en try-catch para evitar que un error en un slot afecte a los demás
      let slotIsOccupied = false;
      try {
        slotIsOccupied = isSlotOccupied(slotTime);
      } catch (slotError) {
        console.error(`      ⚠️ ERROR verificando slot ${hour}:00:`, slotError.message);
        console.error(`      ⚠️ Continuando con el siguiente slot...`);
        // Si hay un error verificando el slot, asumir que está disponible (mejor mostrar que ocultar)
        slotIsOccupied = false;
      }
      
      if (slotIsOccupied) {
        if (isSaturdaySlot) {
          console.log(`      ❌ RECHAZADO: Slot de 1 PM ocupado por evento`);
          console.log(`      ⚠️ ADVERTENCIA: El slot de 1 PM debería estar disponible para sábados`);
        } else {
          console.log(`      ❌ RECHAZADO: ocupado por evento`);
        }
        slotsRejected.push({ hour, reason: 'ocupado_por_evento' });
        continue;
      }
      
      // Si llegamos aquí, el slot está disponible
      const timeSlot = slotTime.format('HH:mm');
      availableSlots.push(timeSlot);
      if (isSaturdaySlot) {
        console.log(`      ✅ DISPONIBLE - Slot de 1 PM agregado correctamente`);
      } else {
        console.log(`      ✅ DISPONIBLE - Agregado a la lista`);
      }
    }
    
    // CORRECCIÓN CRÍTICA: Validar que se evaluaron todos los slots esperados
    console.log(`\n🔍 === VALIDACIÓN DE SLOTS EVALUADOS ===`);
    console.log(`   📋 Slots esperados: ${slotsToGenerate.length} (${slotsToGenerate.join(', ')})`);
    console.log(`   📋 Slots evaluados: ${slotsEvaluated.length} (${slotsEvaluated.join(', ')})`);
    console.log(`   📋 Slots disponibles: ${availableSlots.length} (${availableSlots.join(', ')})`);
    console.log(`   📋 Slots rechazados: ${slotsRejected.length}`);
    
    if (slotsEvaluated.length !== slotsToGenerate.length) {
      console.error(`   ⚠️ ADVERTENCIA: No se evaluaron todos los slots esperados!`);
      console.error(`      Esperados: ${slotsToGenerate.length}, Evaluados: ${slotsEvaluated.length}`);
      const missingSlots = slotsToGenerate.filter(h => !slotsEvaluated.includes(h));
      console.error(`      Slots no evaluados: [${missingSlots.join(', ')}]`);
    }
    
    if (slotsRejected.length > 0) {
      console.log(`   📋 Razones de rechazo:`);
      const reasonsCount = {};
      slotsRejected.forEach(rej => {
        reasonsCount[rej.reason] = (reasonsCount[rej.reason] || 0) + 1;
      });
      Object.entries(reasonsCount).forEach(([reason, count]) => {
        console.log(`      - ${reason}: ${count} slot(s)`);
      });
    }
    
    // CORRECCIÓN CRÍTICA: Si no se generaron slots pero deberían haber, investigar
    if (availableSlots.length === 0 && totalPossibleSlotsCalc > 0) {
      console.error(`\n⚠️ === ADVERTENCIA CRÍTICA: NO SE GENERARON SLOTS DISPONIBLES ===`);
      console.error(`   📋 Total slots posibles: ${totalPossibleSlotsCalc}`);
      console.error(`   📋 Slots evaluados: ${slotsEvaluated.length}`);
      console.error(`   📋 Slots rechazados: ${slotsRejected.length}`);
      console.error(`   📋 Eventos encontrados: ${busySlots.length}`);
      
      if (busySlots.length > 0) {
        console.error(`   🔍 Eventos que podrían estar bloqueando todos los slots:`);
        busySlots.forEach((slot, idx) => {
          const durationHours = slot.end.diff(slot.start, 'hours', true);
          console.error(`      ${idx + 1}. ${slot.start.format('HH:mm')}-${slot.end.format('HH:mm')} (${durationHours.toFixed(2)} horas) - ${slot.type}`);
        });
      }
      
      // Si hay menos eventos que slots posibles, algo está mal
      if (busySlots.length < totalPossibleSlotsCalc) {
        console.error(`   ⚠️ PROBLEMA DETECTADO: Hay ${busySlots.length} eventos pero ${totalPossibleSlotsCalc} slots posibles`);
        console.error(`   ⚠️ Esto sugiere que la lógica de detección de conflictos está marcando incorrectamente slots como ocupados`);
      }
    }

    console.log(`\n📊 === RESUMEN DE SLOTS GENERADOS ===`);
    console.log(`   - Horario laboral: ${workingHours.start}:00 - ${workingHours.end}:00`);
    const totalPossibleSlotsFinal = workingHours.end - workingHours.start + 1;
    console.log(`   - Total slots posibles: ${totalPossibleSlotsFinal}`);
    console.log(`   - Eventos ocupados encontrados: ${busySlots.length}`);
    console.log(`   - Slots disponibles: ${availableSlots.length}`);
    console.log(`   - Slots ocupados: ${totalPossibleSlotsFinal - availableSlots.length}`);
    
    // CORRECCIÓN: Verificar que todos los slots esperados se evaluaron
    const expectedSlotsList = Array.from({length: totalPossibleSlotsFinal}, (_, i) => {
      const hour = workingHours.start + i;
      return hour.toString().padStart(2, '0') + ':00';
    });
    const missingSlots = expectedSlotsList.filter(slot => !availableSlots.includes(slot));
    if (missingSlots.length > 0) {
      console.log(`   ⚠️ Slots que NO están disponibles pero deberían evaluarse: [${missingSlots.join(', ')}]`);
      console.log(`   🔍 Esto puede indicar que estos slots están ocupados o fueron rechazados por otra razón`);
    }
    
    // Verificación específica para sábados
    const isSaturday = dateMoment.day() === 6;
    if (isSaturday) {
      console.log(`\n📅 === VERIFICACIÓN ESPECIAL PARA SÁBADO ===`);
      console.log(`   - Horario sábado: 10:00 - 13:00 (última sesión: 13:00-14:00)`);
      console.log(`   - Slots esperados: 10:00, 11:00, 12:00, 13:00`);
      console.log(`   - Slots disponibles: [${availableSlots.join(', ')}]`);
      console.log(`   - Slots rechazados: ${slotsRejected.length}`);
      
      // CORRECCIÓN CRÍTICA: Verificar cada slot esperado
      const expectedSaturdaySlots = ['10:00', '11:00', '12:00', '13:00'];
      expectedSaturdaySlots.forEach(expectedSlot => {
        const isAvailable = availableSlots.includes(expectedSlot);
        const wasRejected = slotsRejected.some(rej => {
          const rejectedSlot = `${rej.hour.toString().padStart(2, '0')}:00`;
          return rejectedSlot === expectedSlot;
        });
        const wasEvaluated = slotsEvaluated.includes(parseInt(expectedSlot.split(':')[0]));
        
        console.log(`   - Slot ${expectedSlot}:`);
        console.log(`      ¿Está disponible? ${isAvailable ? '✅ SÍ' : '❌ NO'}`);
        console.log(`      ¿Fue evaluado? ${wasEvaluated ? '✅ SÍ' : '❌ NO'}`);
        if (wasRejected) {
          const rejection = slotsRejected.find(rej => `${rej.hour.toString().padStart(2, '0')}:00` === expectedSlot);
          console.log(`      ¿Fue rechazado? ❌ SÍ - Razón: ${rejection ? rejection.reason : 'desconocida'}`);
        } else {
          console.log(`      ¿Fue rechazado? ✅ NO`);
        }
      });
      
      console.log(`   - ¿Incluye slot de 1 PM (13:00)? ${availableSlots.includes('13:00') ? '✅ SÍ' : '❌ NO'}`);
      if (!availableSlots.includes('13:00')) {
        console.log(`   ⚠️ PROBLEMA: El slot de 1 PM NO está en la lista de disponibles`);
        console.log(`   🔍 Revisar logs anteriores para ver por qué el slot de 1 PM fue rechazado`);
      }
      
      // CORRECCIÓN CRÍTICA: Verificar si el slot de 10 AM está disponible cuando debería estar ocupado
      if (availableSlots.includes('10:00') && busySlots.length > 0) {
        console.log(`   ⚠️ ADVERTENCIA: El slot de 10 AM está disponible pero hay eventos en el calendario`);
        console.log(`   🔍 Eventos que podrían estar bloqueando el slot de 10 AM:`);
        busySlots.forEach((slot, idx) => {
          if (slot.start.hour() === 10 && slot.start.minute() === 0) {
            console.log(`      ${idx + 1}. ${slot.start.format('HH:mm')}-${slot.end.format('HH:mm')} - ${slot.type}`);
            console.log(`         ⚠️ Este evento DEBERÍA bloquear el slot de 10 AM`);
          }
        });
      }
    }
    
    if (availableSlots.length > 0) {
      console.log(`   ✅ Slots disponibles: [${availableSlots.join(', ')}]`);
    } else {
      console.log(`   ⚠️ ADVERTENCIA: No se generaron slots disponibles`);
      console.log(`   🔍 Posibles causas:`);
      console.log(`      - Todos los slots están ocupados`);
      console.log(`      - Problema con la detección de eventos`);
      console.log(`      - Problema con el rango de horarios`);
      console.log(`   🔍 Eventos encontrados que podrían estar bloqueando todos los slots:`);
      busySlots.forEach((slot, idx) => {
        console.log(`      ${idx + 1}. ${slot.start.format('HH:mm')}-${slot.end.format('HH:mm')} - ${slot.type}`);
      });
    }

    return availableSlots;
  } catch (error) {
    console.error('❌ Error generando slots para el día:', error.message);
    throw error;
  }
}

/**
 * Verificar si hay conflictos en un horario específico
 */
async function checkTimeConflict(calendarId, startTime, endTime) {
  try {
    console.log(`🔍 Verificando conflictos para ${calendarId} de ${startTime.toISOString()} a ${endTime.toISOString()}`);
    
    const calendar = await getCalendarInstance();
    
    const response = await calendar.events.list({
      calendarId: calendarId,
      timeMin: startTime.toISOString(),
      timeMax: endTime.toISOString(),
      singleEvents: true
    });

    const conflictingEvents = response.data.items || [];
    
    console.log(`   - Eventos conflictivos: ${conflictingEvents.length}`);
    
    return conflictingEvents;
  } catch (error) {
    console.error('❌ Error verificando conflictos:', error.message);
    throw error;
  }
}

/**
 * Crear un evento en Google Calendar
 */
async function createEvent(calendarId, eventData) {
  try {
    console.log(`📝 Creando evento en calendar ${calendarId}`);
    console.log('Datos del evento:', eventData);
    
    const calendar = await getCalendarInstance();
    
    const event = {
      summary: eventData.title,
      description: eventData.description,
      start: {
        dateTime: eventData.startTime.toISOString(),
        timeZone: config.timezone.default
      },
      end: {
        dateTime: eventData.endTime.toISOString(),
        timeZone: config.timezone.default
      }
    };

    const response = await calendar.events.insert({
      calendarId: calendarId,
      resource: event
    });

    console.log('✅ Evento creado exitosamente:', response.data.id);
    return response.data;
  } catch (error) {
    console.error('❌ Error creando evento:', error.message);
    throw error;
  }
}

/**
 * Buscar evento por nombre de cliente (alternativa cuando no hay código en el evento)
 */
async function findEventByClientName(calendarId, clientName, targetDate) {
  try {
    console.log(`🔍 Buscando evento por nombre: "${clientName}" en fecha: ${targetDate}`);
    
    const calendar = await getCalendarInstance();
    
    // Buscar solo en el día específico
    const startOfDay = new Date(targetDate + 'T00:00:00');
    const endOfDay = new Date(targetDate + 'T23:59:59');
    
    const response = await calendar.events.list({
      calendarId: calendarId,
      timeMin: startOfDay.toISOString(),
      timeMax: endOfDay.toISOString(),
      singleEvents: true,
      orderBy: 'startTime'
    });

    const events = response.data.items || [];
    console.log(`📅 Eventos encontrados en ${targetDate}: ${events.length}`);
    
    // Buscar por nombre en el título
    const targetEvent = events.find(event => {
      const title = event.summary || '';
      const normalizedTitle = title.toUpperCase();
      const normalizedClientName = clientName.toUpperCase();
      
      // Buscar nombre exacto o parcial en el título
      if (normalizedTitle.includes(normalizedClientName) || 
          normalizedClientName.includes(normalizedTitle.replace('CITA: ', '').split(' (')[0])) {
        console.log(`✅ Evento encontrado por nombre: "${title}"`);
        return true;
      }
      return false;
    });

    return targetEvent;
  } catch (error) {
    console.error('❌ Error buscando por nombre:', error.message);
    return null;
  }
}

/**
 * Cancelar evento por datos específicos (fecha, hora, calendario)
 * Usa datos del cliente para encontrar evento exacto
 */
async function cancelEventByDateAndTime(calendarId, targetDate, targetTime, clientName = null) {
  try {
    console.log(`🗑️ === CANCELACIÓN POR FECHA/HORA ===`);
    console.log(`📅 Calendario: ${calendarId}`);
    console.log(`📅 Fecha: ${targetDate}`);
    console.log(`⏰ Hora: ${targetTime}`);
    console.log(`👤 Cliente: ${clientName || 'No especificado'}`);
    
    const calendar = await getCalendarInstance();
    
    // Buscar solo en el día específico
    const startOfDay = new Date(targetDate + 'T00:00:00');
    const endOfDay = new Date(targetDate + 'T23:59:59');
    
    console.log(`🔍 Buscando eventos en ${targetDate}...`);
    
    const response = await calendar.events.list({
      calendarId: calendarId,
      timeMin: startOfDay.toISOString(),
      timeMax: endOfDay.toISOString(),
      singleEvents: true,
      orderBy: 'startTime'
    });

    const events = response.data.items || [];
    console.log(`📊 Eventos encontrados en ${targetDate}: ${events.length}`);
    
    if (events.length === 0) {
      console.log(`❌ No hay eventos en el día ${targetDate}`);
      return false;
    }

    // Mostrar todos los eventos del día para análisis
    console.log(`\n🔍 === EVENTOS DEL DÍA ${targetDate} ===`);
    events.forEach((event, index) => {
      const eventStart = new Date(event.start?.dateTime || event.start?.date);
      const eventHour = eventStart.getHours().toString().padStart(2, '0');
      const eventMinute = eventStart.getMinutes().toString().padStart(2, '0');
      const eventTimeStr = `${eventHour}:${eventMinute}`;
      
      console.log(`   ${index + 1}. "${event.summary}"`);
      console.log(`      ├─ Hora: ${eventTimeStr}`);
      console.log(`      ├─ ID: ${event.id.split('@')[0].substring(0, 8)}...`);
      console.log(`      └─ Fecha completa: ${event.start?.dateTime || event.start?.date}`);
    });

    // PASO 1: Buscar por hora exacta
    const targetHour = parseInt(targetTime.split(':')[0]);
    const targetMinute = parseInt(targetTime.split(':')[1] || '0');
    
    console.log(`\n🎯 === BUSCANDO EVENTO EN HORA ${targetTime} ===`);
    console.log(`   - Hora objetivo: ${targetHour}:${targetMinute.toString().padStart(2, '0')}`);
    
    let candidateEvents = events.filter(event => {
      const eventStart = new Date(event.start?.dateTime || event.start?.date);
      const eventHour = eventStart.getHours();
      const eventMinute = eventStart.getMinutes();
      
      // Coincidencia exacta de hora y minuto
      const hourMatch = eventHour === targetHour;
      const minuteMatch = Math.abs(eventMinute - targetMinute) <= 5; // Tolerancia de 5 minutos
      
      console.log(`      🔍 "${event.summary}" - ${eventHour}:${eventMinute.toString().padStart(2, '0')}`);
      console.log(`         ├─ Hora coincide: ${hourMatch} (${eventHour} vs ${targetHour})`);
      console.log(`         └─ Minuto coincide: ${minuteMatch} (${eventMinute} vs ${targetMinute})`);
      
      return hourMatch && minuteMatch;
    });
    
    console.log(`✅ Eventos candidatos por hora: ${candidateEvents.length}`);

    // PASO 2: Si hay múltiples candidatos, filtrar por nombre de cliente
    if (candidateEvents.length > 1 && clientName) {
      console.log(`\n🎯 === FILTRANDO POR NOMBRE DEL CLIENTE: ${clientName} ===`);
      
      const eventsByName = candidateEvents.filter(event => {
        const title = (event.summary || '').toUpperCase();
        const normalizedClientName = clientName.toUpperCase();
        const nameMatch = title.includes(normalizedClientName);
        
        console.log(`      🔍 "${event.summary}"`);
        console.log(`         └─ Contiene "${clientName}": ${nameMatch}`);
        
        return nameMatch;
      });
      
      if (eventsByName.length > 0) {
        candidateEvents = eventsByName;
        console.log(`✅ Eventos filtrados por nombre: ${candidateEvents.length}`);
      }
    }

    // PASO 3: Seleccionar el evento para eliminar
    if (candidateEvents.length === 1) {
      const targetEvent = candidateEvents[0];
      console.log(`\n✅ === EVENTO ENCONTRADO ===`);
      console.log(`📋 Título: ${targetEvent.summary}`);
      console.log(`📅 Fecha/Hora: ${targetEvent.start?.dateTime || targetEvent.start?.date}`);
      console.log(`🆔 ID: ${targetEvent.id}`);
      
      console.log(`\n🗑️ Procediendo a ELIMINAR evento...`);
      
      try {
        await calendar.events.delete({
          calendarId: calendarId,
          eventId: targetEvent.id
        });

        console.log(`✅ ¡EVENTO ELIMINADO EXITOSAMENTE!`);
        console.log(`📤 "${targetEvent.summary}" eliminado del calendario`);
        return true;
        
      } catch (deleteError) {
        console.error(`❌ ERROR eliminando evento:`, deleteError.message);
        return false;
      }
      
    } else if (candidateEvents.length === 0) {
      console.log(`\n❌ === NO SE ENCONTRÓ EVENTO ===`);
      console.log(`🔍 No hay eventos a las ${targetTime} el ${targetDate}`);
      
      // Mostrar horarios cercanos como sugerencia
      const nearbyEvents = events.filter(event => {
        const eventStart = new Date(event.start?.dateTime || event.start?.date);
        const eventHour = eventStart.getHours();
        return Math.abs(eventHour - targetHour) <= 2; // Eventos dentro de 2 horas
      });
      
      if (nearbyEvents.length > 0) {
        console.log(`\n💡 === EVENTOS CERCANOS EN HORARIO ===`);
        nearbyEvents.forEach(event => {
          const eventStart = new Date(event.start?.dateTime || event.start?.date);
          const eventTimeStr = `${eventStart.getHours().toString().padStart(2, '0')}:${eventStart.getMinutes().toString().padStart(2, '0')}`;
          console.log(`   - ${eventTimeStr}: "${event.summary}"`);
        });
      }
      
      return false;
      
    } else {
      console.log(`\n⚠️ === MÚLTIPLES EVENTOS ENCONTRADOS ===`);
      console.log(`🔍 ${candidateEvents.length} eventos coinciden con los criterios:`);
      
      candidateEvents.forEach((event, index) => {
        const eventStart = new Date(event.start?.dateTime || event.start?.date);
        const eventTimeStr = `${eventStart.getHours().toString().padStart(2, '0')}:${eventStart.getMinutes().toString().padStart(2, '0')}`;
        console.log(`   ${index + 1}. ${eventTimeStr}: "${event.summary}"`);
      });
      
      console.log(`❌ No se puede eliminar automáticamente - criterios ambiguos`);
      return false;
    }
    
  } catch (error) {
    console.error('💥 ERROR en cancelación por fecha/hora:', error.message);
    return false;
  }
}

/**
 * Cancela evento usando la lógica ORIGINAL de Google Apps Script
 * Busca evento por ID del evento (código de reserva)
 */
async function cancelEventByReservationCodeOriginal(calendarId, codigoReserva) {
  try {
    console.log(`🗑️ === CANCELACIÓN MÉTODO ORIGINAL ===`);
    console.log(`🔍 Código: ${codigoReserva}`);
    console.log(`📅 Calendar: ${calendarId}`);

    const calendar = await getCalendarInstance();
    
    // LÓGICA ORIGINAL: Buscar en rango de 30 días atrás y 90 días adelante
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - 30);
    const endDate = new Date();
    endDate.setDate(endDate.getDate() + 90);
    
    console.log(`📊 Buscando eventos desde ${startDate.toISOString().split('T')[0]} hasta ${endDate.toISOString().split('T')[0]}`);
    
    // Listar todos los eventos en el rango
    const response = await calendar.events.list({
      calendarId: calendarId,
      timeMin: startDate.toISOString(),
      timeMax: endDate.toISOString(),
      singleEvents: true,
      orderBy: 'startTime'
    });
    
    const allEvents = response.data.items || [];
    console.log(`📋 Total eventos encontrados: ${allEvents.length}`);
    
    // NUEVA LÓGICA: Buscar evento por TÍTULO (contiene código de reserva)
    // Ya que ahora usamos UUID puro, no podemos buscar por prefijo del ID
    console.log(`\n🔍 === ANÁLISIS DE EVENTOS POR TÍTULO ===`);
    const targetEvent = allEvents.find(event => {
      const eventTitle = event.summary || '';
      const codigoUpper = codigoReserva.toUpperCase();
      
      // Buscar el código en el título del evento
      // Formato esperado: "Cita: Nombre Cliente (CODIGO)"
      const matches = eventTitle.includes(`(${codigoUpper})`);
      
      console.log(`📄 Evento: "${eventTitle}"`);
      console.log(`   🆔 ID: ${event.id}`);
      console.log(`   🎯 Contiene código ${codigoUpper}: ${matches ? '✅' : '❌'}`);
      
      return matches;
    });
    
    if (targetEvent) {
      console.log(`\n✅ EVENTO ENCONTRADO PARA ELIMINAR:`);
      console.log(`   📅 Título: ${targetEvent.summary}`);
      console.log(`   🆔 ID: ${targetEvent.id}`);
      console.log(`   📊 Fecha: ${targetEvent.start?.dateTime || targetEvent.start?.date}`);
      
      // Eliminar el evento
      await calendar.events.delete({
        calendarId: calendarId,
        eventId: targetEvent.id
      });
      
      console.log(`🗑️ Evento eliminado exitosamente del Google Calendar`);
      return {
        success: true,
        message: `✅ La cita con código de reserva ${codigoReserva.toUpperCase()} ha sido cancelada exitosamente.`
      };
      
    } else {
      console.log(`\n❌ NO SE ENCONTRÓ EVENTO CON CÓDIGO: ${codigoReserva}`);
      console.log(`\n📋 IDs de eventos disponibles:`);
      allEvents.forEach((event, index) => {
        const shortId = event.id.split('@')[0].substring(0, 6).toUpperCase();
        console.log(`   ${index + 1}. ${shortId} - "${event.summary}"`);
      });
      
      return {
        success: false,
        message: `🤷‍♀️ No se encontró ninguna cita con el código de reserva ${codigoReserva.toUpperCase()} en este calendario. Verifica que el código sea correcto.`
      };
    }
    
  } catch (error) {
    console.error(`❌ Error en cancelación por código: ${error.message}`);
    return {
      success: false,
      message: `🤷‍♀️ No se encontró ninguna cita con el código de reserva ${codigoReserva.toUpperCase()}. Verifica que el código sea correcto.`
    };
  }
}

/**
 * Función principal de cancelación usando la lógica correcta
 */
async function cancelEventUsingClientData(calendarId, codigoReserva, clientData) {
  try {
    console.log(`🔧 === CANCELACIÓN CON LÓGICA CORRECTA ===`);
    console.log(`📋 Código de reserva: ${codigoReserva}`);
    
    if (!clientData) {
      console.log(`❌ No hay datos del cliente para proceder con la cancelación`);
      return false;
    }
    
    console.log(`📊 Datos obtenidos de PostgreSQL:`);
    console.log(`   - Cliente: ${clientData.clientName}`);
    console.log(`   - Fecha: ${clientData.date}`);
    console.log(`   - Hora: ${clientData.time}`);
    console.log(`   - Estado actual: ${clientData.estado}`);
    
    if (clientData.estado === 'CANCELADA') {
      console.log(`⚠️ La cita ya está marcada como CANCELADA en PostgreSQL`);
      console.log(`🔄 Pero continuaremos verificando si el evento aún existe en Google Calendar...`);
    }
    
    // Usar los datos del cliente para buscar el evento específico
    const success = await cancelEventByDateAndTime(
      calendarId,
      clientData.date,
      clientData.time,
      clientData.clientName
    );
    
    return success;
    
  } catch (error) {
    console.error('💥 Error en cancelación con datos de PostgreSQL:', error.message);
    return false;
  }
}

/**
 * Crear evento en Google Calendar (LÓGICA ORIGINAL)
 * Incluye validación de conflictos y generación de código
 */
async function createEventOriginal(calendarId, eventData) {
  try {
    console.log(`📝 === CREANDO EVENTO ORIGINAL ===`);
    console.log(`📅 Calendar: ${calendarId}`);
    console.log(`📊 Datos:`, eventData);

    const calendar = await getCalendarInstance();

    // PASO 1: Verificar conflictos (lógica original)
    const conflictingEventsResponse = await calendar.events.list({
      calendarId: calendarId,
      timeMin: eventData.startTime.toISOString(),
      timeMax: eventData.endTime.toISOString(),
      singleEvents: true
    });

    const conflictingEvents = conflictingEventsResponse.data.items || [];
    console.log(`🔍 Eventos conflictivos: ${conflictingEvents.length}`);

    if (conflictingEvents.length > 0) {
      console.log(`❌ CONFLICTO: Horario ya ocupado`);
      return {
        success: false,
        error: 'CONFLICTO',
        conflictingEvents: conflictingEvents.length,
        message: `❌ ¡Demasiado tarde! El horario ya fue reservado.`
      };
    }

    // PASO 2: Crear evento (lógica original con zona horaria corregida)
    console.log('🕒 === ZONA HORARIA DEBUG ===');
    console.log('eventData.startTime:', eventData.startTime);
    console.log('eventData.endTime:', eventData.endTime);
    console.log('timezone configurado:', config.timezone.default);
    
    // Asegurar que las fechas estén en la zona horaria correcta
    const startTimeFormatted = moment(eventData.startTime).tz(config.timezone.default).format();
    const endTimeFormatted = moment(eventData.endTime).tz(config.timezone.default).format();
    
    console.log('startTimeFormatted:', startTimeFormatted);
    console.log('endTimeFormatted:', endTimeFormatted);

    const event = {
      summary: eventData.title,
      description: eventData.description,
      start: {
        dateTime: startTimeFormatted,
        timeZone: config.timezone.default
      },
      end: {
        dateTime: endTimeFormatted,
        timeZone: config.timezone.default
      }
    };

    console.log(`📝 Creando evento: "${event.summary}"`);

    const response = await calendar.events.insert({
      calendarId: calendarId,
      resource: event
    });

    const newEvent = response.data;
    console.log(`✅ Evento creado con ID: ${newEvent.id}`);

    // PASO 3: Generar código de reserva (LÓGICA ORIGINAL)
    const codigoReserva = generateReservationCodeOriginal(newEvent.id);
    console.log(`🎟️ Código de reserva generado: ${codigoReserva}`);

    return {
      success: true,
      event: newEvent,
      codigoReserva: codigoReserva,
      message: '✅ Evento creado exitosamente'
    };

  } catch (error) {
    console.error(`❌ Error creando evento: ${error.message}`);
    return {
      success: false,
      error: error.message,
      message: '❌ Error creando evento en el calendario'
    };
  }
}

/**
 * Crear o actualizar evento en Google Calendar con ID personalizado (para reagendamiento)
 * Usa el código de reserva original como ID del evento
 */
async function createEventWithCustomId(calendarId, eventData, customEventId) {
  try {
    console.log(`📝 === CREANDO/ACTUALIZANDO EVENTO CON ID PERSONALIZADO ===`);
    console.log(`📅 Calendar: ${calendarId}`);
    console.log(`🎟️ Custom Event ID: ${customEventId}`);
    console.log(`📊 Datos:`, eventData);
    console.log(`📊 startTime type:`, typeof eventData.startTime, eventData.startTime);
    console.log(`📊 endTime type:`, typeof eventData.endTime, eventData.endTime);

    const calendar = await getCalendarInstance();
    
    if (!calendar) {
      throw new Error('No se pudo obtener la instancia del calendario');
    }
    console.log('✅ Instancia de calendario obtenida correctamente');

    // Generar ID válido para Google Calendar usando SOLO UUID v4
    // PROBLEMA: Google Calendar rechaza ciertos patrones de ID mixtos (código + UUID)
    // SOLUCIÓN DEFINITIVA: Usar SOLO UUID sin modificaciones (formato más confiable)
    
    // Generar UUID v4 y convertir a formato aceptado por Google Calendar
    // (solo letras minúsculas y números, sin guiones)
    const uuid = crypto.randomUUID().replace(/-/g, '').toLowerCase();
    
    // Usar SOLO el UUID como ID (32 caracteres hexadecimales)
    // Este formato es universalmente aceptado por Google Calendar
    let eventId = uuid;
    
    console.log(`🔑 Código de reserva (usuario): ${customEventId}`);
    console.log(`🔑 UUID generado (ID interno): ${uuid}`);
    console.log(`🔑 ID del evento final: ${eventId} (longitud: ${eventId.length})`);
    console.log(`🔑 Formato UUID puro: ✅`);

    // PASO 1: Buscar si ya existe un evento con el mismo código de reserva en el calendario
    // Esto es importante para reagendamiento - si existe, lo actualizamos en lugar de crear uno nuevo
    let existingEvent = null;
    let existingEventId = null;
    
    console.log(`🔍 Buscando evento existente con código de reserva: ${customEventId}`);
    try {
      // Buscar en un rango amplio (30 días atrás, 90 días adelante) para encontrar el evento
      const searchStartDate = new Date();
      searchStartDate.setDate(searchStartDate.getDate() - 30);
      const searchEndDate = new Date();
      searchEndDate.setDate(searchEndDate.getDate() + 90);
      
      const searchResponse = await calendar.events.list({
        calendarId: calendarId,
        timeMin: searchStartDate.toISOString(),
        timeMax: searchEndDate.toISOString(),
        singleEvents: true,
        orderBy: 'startTime'
      });
      
      const codeUpper = customEventId.toUpperCase();
      const allEvents = searchResponse.data.items || [];
      
      // Buscar evento con el código de reserva en el título
      const foundEvent = allEvents.find(evt => {
        const eventTitle = evt.summary || '';
        return eventTitle.includes(`(${codeUpper})`);
      });
      
      if (foundEvent) {
        existingEvent = foundEvent;
        existingEventId = foundEvent.id;
        console.log(`✅ Evento existente encontrado con código ${customEventId}:`);
        console.log(`   - ID: ${existingEventId}`);
        console.log(`   - Título: ${existingEvent.summary}`);
        console.log(`   - Fecha actual: ${existingEvent.start?.dateTime || existingEvent.start?.date}`);
        console.log(`   ⚠️ Este evento será actualizado con la nueva fecha/hora`);
        // Usar el ID del evento existente para actualizarlo
        eventId = existingEventId;
      } else {
        console.log(`📋 No se encontró evento existente con código ${customEventId}, se creará uno nuevo`);
      }
    } catch (searchError) {
      console.log(`⚠️ Error buscando evento existente: ${searchError.message}`);
      console.log(`   Continuando con creación de nuevo evento...`);
    }

    // PASO 2: Verificar conflictos (excluyendo el evento actual si existe)
    console.log('📋 Verificando conflictos de horario...');
    console.log(`   - timeMin: ${eventData.startTime.toISOString()}`);
    console.log(`   - timeMax: ${eventData.endTime.toISOString()}`);
    console.log(`   - Excluyendo evento ID: ${eventId || 'ninguno'}`);
    
    const conflictingEventsResponse = await calendar.events.list({
      calendarId: calendarId,
      timeMin: eventData.startTime.toISOString(),
      timeMax: eventData.endTime.toISOString(),
      singleEvents: true
    });
    
    console.log('✅ Consulta de conflictos completada');

    const allEvents = conflictingEventsResponse.data.items || [];
    // Filtrar el evento actual (si existe) de los conflictos
    // Si estamos actualizando un evento existente, excluirlo de los conflictos
    const conflictingEvents = allEvents.filter(event => {
      // Excluir el evento que estamos actualizando
      if (existingEventId && event.id === existingEventId) {
        return false;
      }
      // Excluir eventos con el mismo código de reserva (por si acaso)
      const codeUpper = customEventId.toUpperCase();
      const eventTitle = event.summary || '';
      if (eventTitle.includes(`(${codeUpper})`)) {
        return false;
      }
      return true;
    });
    
    console.log(`🔍 Total eventos en el horario: ${allEvents.length}`);
    console.log(`🔍 Eventos conflictivos (excluyendo el actual): ${conflictingEvents.length}`);

    if (conflictingEvents.length > 0) {
      console.log(`❌ CONFLICTO: Horario ya ocupado por otro evento`);
      conflictingEvents.forEach(evt => {
        console.log(`   - Conflicto con: "${evt.summary}" (ID: ${evt.id})`);
      });
      return {
        success: false,
        error: 'CONFLICTO',
        conflictingEvents: conflictingEvents.length,
        message: `❌ ¡Demasiado tarde! El horario ya fue reservado.`
      };
    }

    // PASO 3: Preparar datos del evento
    const startTimeFormatted = moment(eventData.startTime).tz(config.timezone.default).format();
    const endTimeFormatted = moment(eventData.endTime).tz(config.timezone.default).format();

    const event = {
      summary: eventData.title,
      description: eventData.description,
      start: {
        dateTime: startTimeFormatted,
        timeZone: config.timezone.default
      },
      end: {
        dateTime: endTimeFormatted,
        timeZone: config.timezone.default
      }
    };

    let response;
    if (existingEvent) {
      // ACTUALIZAR evento existente
      console.log(`🔄 Actualizando evento existente: "${event.summary}"`);
      try {
        response = await calendar.events.update({
          calendarId: calendarId,
          eventId: eventId,
          resource: event
        });
        console.log(`✅ Evento actualizado con ID: ${response.data.id}`);
      } catch (updateError) {
        console.error(`❌ Error al actualizar evento:`, updateError.message);
        console.error(`📋 EventId usado: ${eventId}`);
        throw updateError;
      }
    } else {
      // CREAR nuevo evento con ID personalizado
      event.id = eventId;
      console.log(`📝 Creando nuevo evento: "${event.summary}"`);
      console.log(`📋 Con ID personalizado: ${eventId}`);
      console.log(`📋 Evento a insertar:`, JSON.stringify(event, null, 2));
      
      try {
        console.log('🔄 Ejecutando calendar.events.insert...');
        response = await calendar.events.insert({
          calendarId: calendarId,
          resource: event
        });
        console.log(`✅ Evento creado con ID personalizado: ${response.data.id}`);
      } catch (insertError) {
        console.error(`❌ Error al insertar evento:`, insertError.message);
        console.error(`📋 EventId intentado: ${eventId}`);
        console.error(`📋 Longitud del ID: ${eventId.length}`);
        console.error(`📋 Caracteres válidos: ${/^[a-z0-9]+$/.test(eventId)}`);
        console.error(`📋 Error completo:`, JSON.stringify(insertError, null, 2));
        console.error(`📋 Error response:`, insertError.response?.data);
        throw insertError;
      }
    }

    return {
      success: true,
      event: response.data,
      codigoReserva: customEventId.toUpperCase(),
      message: '✅ Evento creado/actualizado exitosamente'
    };

  } catch (error) {
    console.error(`❌ Error creando/actualizando evento: ${error.message}`);
    console.error(`📚 Stack:`, error.stack);
    console.error(`📚 Response data:`, error.response?.data);
    return {
      success: false,
      error: error.message,
      message: '❌ Error creando evento en el calendario'
    };
  }
}

/**
 * Generar código de reserva único (6 caracteres alfanuméricos)
 */
function generateUniqueReservationCode() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
}

/**
 * Formatear tiempo en formato HH:MM
 */
function formatTime(date) {
  return moment(date).tz(config.timezone.default).format('HH:mm');
}

/**
 * Genera código de reserva basado en el Event ID (LÓGICA ORIGINAL)
 * Toma los primeros 6 caracteres del Event ID como el código original
 */
function generateReservationCodeOriginal(eventId) {
  try {
    // LÓGICA ORIGINAL: shortEventId.substring(0, 6).toUpperCase()
    const fullEventId = eventId;
    const shortEventId = fullEventId.split('@')[0];
    const codigoReserva = shortEventId.substring(0, 6).toUpperCase();
    
    console.log(`🎟️ === GENERACIÓN CÓDIGO ORIGINAL ===`);
    console.log(`   📄 Event ID completo: ${fullEventId}`);
    console.log(`   🔢 Event ID corto: ${shortEventId}`);
    console.log(`   🎯 Código generado: ${codigoReserva}`);
    
    return codigoReserva;
  } catch (error) {
    console.error('Error generando código de reserva:', error);
    return 'ERROR' + Date.now().toString().slice(-4);
  }
}

/**
 * Formatear tiempo a 12 horas (lógica original)
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
  findAvailableSlots,
  checkTimeConflict,
  createEvent,
  cancelEventByDateAndTime,
  cancelEventUsingClientData,
  findEventByClientName,
  formatTime,
  generateReservationCodeOriginal,
  generateUniqueReservationCode,
  cancelEventByReservationCodeOriginal,
  createEventOriginal,
  createEventWithCustomId,
  formatTimeTo12Hour
}; 