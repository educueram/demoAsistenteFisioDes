# Implementación de Reconocimiento Inteligente de Clientes

## Resumen
Se ha implementado un sistema de reconocimiento silencioso de clientes que permite al chatbot identificar a los clientes existentes mediante su número de teléfono sin revelar que los ha reconocido.

## Nuevos Endpoints

### 1. `/api/reconocer-cliente` (POST)
**Propósito:** Verificar silenciosamente si un teléfono existe en la base de datos.

**Request:**
```json
{
  "telefono": "+5214495847679"
}
```

**Response (Cliente Existente):**
```json
{
  "success": true,
  "existeCliente": true,
  "datosCliente": {
    "nombreCompleto": "Juan Pérez",
    "correoElectronico": "juan@email.com",
    "telefono": "+5214495847679"
  }
}
```

**Response (Cliente Nuevo):**
```json
{
  "success": true,
  "existeCliente": false,
  "datosCliente": null
}
```

### 2. `/api/agenda-cita-inteligente` (POST)
**Propósito:** Agendar cita con reconocimiento inteligente de clientes.

**Request:**
```json
{
  "action": "schedule",
  "calendar": "1",
  "service": "1",
  "serviceName": "Consulta Presencial",
  "date": "2024-01-25",
  "time": "10:00",
  "clientPhone": "+5214495847679",
  "clientName": "",  // Opcional si es cliente existente
  "clientEmail": ""  // Opcional si es cliente existente
}
```

**Response:**
```json
{
  "success": true,
  "message": "Cita agendada usando tus datos existentes",
  "esClienteExistente": true,
  "clientName": "Juan Pérez",
  "clientEmail": "juan@email.com",
  "clientPhone": "+5214495847679"
}
```

## Flujo de Conversación Recomendado

### Para Clientes Existentes:
1. **Chatbot:** "¿Para qué fecha te gustaría agendar tu cita?"
2. **Usuario:** Proporciona fecha
3. **Chatbot:** "¿Qué tipo de consulta prefieres?"
4. **Usuario:** Elige servicio
5. **Chatbot:** Muestra horarios disponibles
6. **Usuario:** Elige horario
7. **Chatbot:** Llama a `/api/agenda-cita-inteligente` con el teléfono del usuario
8. **Sistema:** Reconoce al cliente y usa sus datos existentes
9. **Chatbot:** "¡Perfecto! Tu cita ha quedado agendada para el [fecha] a las [hora]."

### Para Clientes Nuevos:
1. **Chatbot:** "¿Para qué fecha te gustaría agendar tu cita?"
2. **Usuario:** Proporciona fecha
3. **Chatbot:** "¿Qué tipo de consulta prefieres?"
4. **Usuario:** Elige servicio
5. **Chatbot:** Muestra horarios disponibles
6. **Usuario:** Elige horario
7. **Chatbot:** "Por favor, proporciona tu nombre completo y correo electrónico para agendar tu cita."
8. **Usuario:** Proporciona datos
9. **Chatbot:** Llama a `/api/agenda-cita-inteligente` con todos los datos
10. **Chatbot:** "¡Perfecto! Tu cita ha quedado agendada para el [fecha] a las [hora]."

## Ventajas

1. **Experiencia fluida:** Los clientes existentes no necesitan repetir sus datos
2. **Reconocimiento silencioso:** El chatbot sabe quién es el cliente pero no lo revela explícitamente
3. **Menor fricción:** Reduce los pasos necesarios para clientes recurrentes
4. **Mantiene datos actualizados:** Usa la información más reciente del Google Sheets

## Implementación Técnica

- **Normalización de teléfonos:** Maneja diferentes formatos (+521, 52, 10 dígitos)
- **Caché en memoria:** Almacena información de pacientes para acceso rápido
- **Búsqueda inteligente:** Prioriza registros con nombre completo si hay duplicados
- **Integración con Google Sheets:** Usa la función existente `consultaDatosPacientePorTelefono`

## Notas Importantes

- El reconocimiento es completamente silencioso, el usuario no sabe que fue reconocido
- Si el cliente proporciona nuevos datos, estos sobrescriben los existentes
- El sistema funciona con la estructura actual de Google Sheets sin modificaciones
- Se mantiene compatibilidad con el endpoint original `/api/agenda-cita`
