# Regla de Negocio: Días Alternativos Inteligentes

## 🎯 Descripción
Cuando un paciente consulta disponibilidad para un día específico y **no hay horarios disponibles**, el sistema automáticamente busca y recomienda días cercanos que **SÍ tengan disponibilidad**.

## 🧠 Lógica Inteligente

### **Caso 1: Consulta para día futuro**
**Ejemplo**: Paciente busca disponibilidad para **Jueves 2 de Octubre** (hoy es 25 de Septiembre)

**Si no hay disponibilidad el 2 de Octubre:**
1. ✅ Busca **1 día antes** → **Miércoles 1 de Octubre**
2. ✅ Busca **1 día después** → **Viernes 3 de Octubre**  
3. ✅ Busca **2 días antes** → **Martes 30 de Septiembre**
4. ✅ Busca **2 días después** → **Sábado 4 de Octubre**
5. Y así sucesivamente hasta encontrar días con disponibilidad

### **Caso 2: Consulta para día cercano**
**Ejemplo**: Paciente busca disponibilidad para **Miércoles** (día actual: Lunes)

**Si no hay disponibilidad el Miércoles:**
1. ✅ Busca **1 día antes** → **Martes** (solo si no es pasado)
2. ✅ Busca **1 día después** → **Jueves**
3. ✅ Busca **2 días después** → **Viernes**
4. Y así sucesivamente

## 🔍 Algoritmo de Búsqueda

### **Priorización Inteligente**
1. **Días más cercanos** tienen prioridad sobre días lejanos
2. **Días anteriores** tienen ligera prioridad sobre días posteriores
3. **Máximo 7 días** de búsqueda hacia cada lado
4. **Máximo 3 días alternativos** en la respuesta

### **Validaciones**
- ❌ **No busca en el pasado** (fechas < hoy)
- ❌ **No incluye domingos** (día no laboral)
- ✅ **Verifica disponibilidad real** usando Google Calendar
- ✅ **Aplica horarios 10 AM - 6 PM** (respeta reglas de negocio)

## 📱 Experiencia del Usuario

### **Consulta Sin Disponibilidad - ANTES**
```
😔 No hay horarios disponibles en los 3 días alrededor de Jueves 2 de octubre.

🔍 Te sugerimos elegir otra fecha con mejor disponibilidad.
```

### **Consulta Sin Disponibilidad - DESPUÉS**
```
😔 No hay disponibilidad para Jueves 2 de octubre, pero encontré estas opciones cercanas:

🟢 MIÉRCOLES 1 DE OCTUBRE (2025-10-01)
📅 1 día antes • 4 horarios disponibles

Ⓐ 10:00 AM
Ⓑ 11:00 AM  
Ⓒ 3:00 PM
Ⓓ 4:00 PM

🟡 VIERNES 3 DE OCTUBRE (2025-10-03)  
📅 1 día después • 2 horarios disponibles

Ⓔ 2:00 PM
Ⓕ 5:00 PM

💡 Escribe la letra del horario que prefieras (A, B, C...) ✨
```

## 🎛️ Configuración

### **Parámetros Ajustables**
```javascript
// En la función findAlternativeDaysWithAvailability()
maxDaysToSearch = 7    // Máximo 7 días hacia cada lado
maxAlternatives = 3    // Máximo 3 días alternativos mostrados
```

### **Lógica de Prioridad**
```javascript
// Días anteriores: distancia * 10 + 1
// Días posteriores: distancia * 10 + 2

// Ejemplos:
// 1 día antes  = prioridad 11
// 1 día después = prioridad 12  
// 2 días antes  = prioridad 21
// 2 días después = prioridad 22
```

## 🧪 Casos de Prueba

### **Prueba 1: Día con disponibilidad**
```bash
GET /api/consulta-disponibilidad?calendar=1&service=1&date=2025-10-01
```
**Resultado esperado**: Muestra horarios normales del día solicitado

### **Prueba 2: Día sin disponibilidad**
```bash
GET /api/consulta-disponibilidad?calendar=1&service=1&date=2025-10-02  
```
**Resultado esperado**: Muestra días alternativos cercanos con disponibilidad

### **Prueba 3: Fecha en el pasado**
```bash
GET /api/consulta-disponibilidad?calendar=1&service=1&date=2025-09-20
```
**Resultado esperado**: Solo busca días alternativos >= hoy

## 🔧 Implementación Técnica

### **Funciones Principales**

1. **`findAlternativeDaysWithAvailability()`**
   - Busca días alternativos con disponibilidad
   - Implementa lógica de priorización
   - Limita búsqueda a 7 días por lado

2. **`checkDayAvailability()`**
   - Verifica disponibilidad real de un día específico
   - Usa Google Calendar API + fallback a mock
   - Aplica correcciones de horario (10 AM mínimo)

### **Integración**
- Se activa automáticamente cuando `daysWithSlots.length === 0`
- Compatible con el sistema de mapeo de letras (A, B, C...)
- Mantiene la estructura de respuesta existente

## ✅ Beneficios

1. **Mejor experiencia del usuario**: No se queda sin opciones
2. **Más conversiones**: Ofrece alternativas inmediatas
3. **Menos abandono**: Evita que el paciente se vaya sin agendar
4. **Inteligencia comercial**: Optimiza la ocupación del calendario

## 🚀 Activación

La funcionalidad está **activa automáticamente**. No requiere configuración adicional y se integra con:

- ✅ Sistema de horarios existente
- ✅ Validación de anticipación (1 hora)
- ✅ Reglas de días laborales
- ✅ Horario mínimo 10 AM
- ✅ Google Calendar API
- ✅ Sistema de mapeo de letras para agendamiento

¡La regla de negocio está lista para mejorar la experiencia de tus pacientes! 🎉 