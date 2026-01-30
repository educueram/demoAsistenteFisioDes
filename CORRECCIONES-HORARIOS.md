# Correcciones de Horarios - Sistema de Citas

## Problemas Identificados y Corregidos

### ❌ **Problema 1**: Restricción de 2 horas de anticipación
**Problema**: El sistema requería 2 horas de anticipación para mostrar disponibilidad, cuando debería ser solo 1 hora.

**Ejemplo**: Si eran las 2:00 PM, no mostraba disponibilidad para las 3:00 PM del mismo día.

### ❌ **Problema 2**: Horario de inicio a las 9:00 AM
**Problema**: El sistema permitía agendar desde las 9:00 AM cuando el horario de servicio real es desde las 10:00 AM.

## ✅ Soluciones Aplicadas

### **Cambio 1**: Anticipación de 2 horas → 1 hora

#### `config.js`
```javascript
// ANTES
minBookingHours: 2, // Mínimo 2 horas de anticipación

// DESPUÉS
minBookingHours: 1, // Mínimo 1 hora de anticipación
```

#### `index.js` (múltiples funciones)
```javascript
// ANTES
const minimumBookingTime = now.clone().add(2, 'hours');
const minimumBookingTime = moment(now).add(2, 'hours');
const isWithinWorkingHours = isWorkingDay && currentHour < todayWorkingHours.end - 2;

// DESPUÉS
const minimumBookingTime = now.clone().add(1, 'hours');
const minimumBookingTime = moment(now).add(1, 'hours');
const isWithinWorkingHours = isWorkingDay && currentHour < todayWorkingHours.end - 1;
```

#### `services/googleCalendar.js`
```javascript
// ANTES
const minimumBookingTime = now.clone().add(2, 'hours');

// DESPUÉS
const minimumBookingTime = now.clone().add(1, 'hours');
```

#### Mensajes de Error
```javascript
// ANTES
"Debes agendar con al menos dos horas de anticipación"

// DESPUÉS
"Debes agendar con al menos una hora de anticipación"
```

### **Cambio 2**: Horario de inicio 9:00 AM → 10:00 AM

#### `config.js`
```javascript
// ANTES
startHour: parseInt(process.env.WORKING_START_HOUR) || 9,   // 9 AM

// DESPUÉS
startHour: parseInt(process.env.WORKING_START_HOUR) || 10,   // 10 AM
```

#### `index.js` (función mockFindAvailableSlots)
```javascript
// ANTES
start: hours?.start || 9,

// DESPUÉS
start: hours?.start || 10,
```

#### `services/googleCalendar.js` (función findAvailableSlots)
```javascript
// ANTES
start: hours?.start || 9,

// DESPUÉS
start: hours?.start || 10,
```

## 🧪 Escenarios de Prueba

### **Escenario 1**: Consulta de disponibilidad para hoy
- **Hora actual**: 2:00 PM
- **Antes**: No mostraba 3:00 PM como disponible
- **Después**: ✅ Muestra 3:00 PM como disponible

### **Escenario 2**: Horarios de servicio
- **Antes**: Mostraba disponibilidad desde 9:00 AM
- **Después**: ✅ Muestra disponibilidad desde 10:00 AM

### **Escenario 3**: Agendamiento con poca anticipación
- **Hora actual**: 2:30 PM
- **Intento agendar**: 3:00 PM
- **Antes**: ❌ "Debes agendar con al menos dos horas de anticipación"
- **Después**: ✅ Permite agendar

## 📊 Archivos Modificados

1. **`config.js`**
   - ✅ `minBookingHours: 2 → 1`
   - ✅ `startHour: 9 → 10`

2. **`index.js`**
   - ✅ Función `mockGenerateSlotsForDay`: anticipación 2h → 1h
   - ✅ Endpoint `/api/consulta-disponibilidad`: validación horario laboral
   - ✅ Endpoint `/api/agenda-cita`: validación anticipación
   - ✅ Valores por defecto: horario inicio 9 → 10

3. **`services/googleCalendar.js`**
   - ✅ Función `generateSlotsForDay`: anticipación 2h → 1h
   - ✅ Función `findAvailableSlots`: horario inicio 9 → 10

## 🔄 Comportamiento Actual

### **Consulta de Disponibilidad**
- **Anticipación mínima**: 1 hora
- **Horario de servicio**: 10:00 AM - 6:00 PM
- **Horario de comida**: 2:00 PM - 3:00 PM (no disponible)
- **Sábados**: 10:00 AM - 2:00 PM
- **Domingos**: Cerrado

### **Agendamiento**
- **Validación**: Mínimo 1 hora de anticipación
- **Horario permitido**: A partir de las 10:00 AM
- **Fechas**: No permite fechas pasadas

## ⚙️ Variables de Entorno (Opcional)

Para personalizar estos valores sin tocar el código:

```env
# Horario de inicio (por defecto: 10)
WORKING_START_HOUR=10

# Horario de fin (por defecto: 19)
WORKING_END_HOUR=18

# Anticipación mínima en horas (usado en config.js)
MIN_BOOKING_HOURS=1
```

## ✅ Estado Actual
- ✅ **Anticipación corregida**: 1 hora en lugar de 2 horas
- ✅ **Horario de inicio corregido**: 10:00 AM en lugar de 9:00 AM
- ✅ **Consistencia**: Cambios aplicados en todos los archivos
- ✅ **Mensajes actualizados**: Reflejan la nueva regla de 1 hora

## 🚀 Lista para Pruebas
El sistema está listo para probar con los nuevos horarios. Puedes verificar:

1. **Consulta disponibilidad para hoy** con 1 hora de anticipación
2. **Horarios mostrados** empiezan desde las 10:00 AM
3. **Agendamiento** permite reservar con 1 hora de anticipación 