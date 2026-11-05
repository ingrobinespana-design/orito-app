# Tukán — Vales corporativos (diseño guardado, NO construido)

Decidido con Darwin el 2026-11-05. Se construye cuando él lo pida.

## Modelo (tipo valera)
1. Tukán (admin) crea la **empresa** (nombre, NIT, contacto, % de servicio, p. ej. 10%) y le agrega **empleados por celular**, cada uno con **cupo mensual** (y horario opcional).
2. El empleado pide su carrera y elige **"💼 Pagar con vale de [Empresa]"**.
   - **Aprobación AUTOMÁTICA con límites:** si la carrera cabe en su cupo del mes (y en el horario), sale de una a los conductores. Si no, se le avisa.
3. El conductor ve **"💼 VALE CORPORATIVO · No le cobres al pasajero"** (en la solicitud y durante el viaje).
4. **Código de 4 dígitos por carrera:** al aprobarse, el empleado ve su código; al terminar se lo dice al conductor, que lo escribe para cerrar la carrera. El precio queda **bloqueado** al valor aceptado (el conductor no lo cambia al cerrar).
5. **La empresa le paga a Tukán** cada mes: valor de las carreras **+ recargo de servicio** (el conductor recibe el 100%; se mantiene el "0% comisión").
6. **Tukán le paga al conductor SEMANAL** lo acumulado en vales (Nequi/transferencia).

## Lo que hay que construir
- **Base de datos:** tablas `empresas` (nombre, nit, contacto, telefono, correo, recargo_pct, activa) y `empleados_empresa` (empresa_id, usuario_id/telefono, cupo_mensual, horario_desde/hasta, activo). Columnas nuevas en `carreras`: `pago` (efectivo|vale), `empresa_id`, `vale_codigo`, `vale_validado`, `vale_pagado_conductor`, `vale_cobrado_empresa`.
- **Servidor:** en `POST /carreras` con `pago=vale` → verificar empleado activo, cupo del mes (finalizadas + en curso + esta) y horario; generar código. Revalidar cupo al aceptar una contraoferta. En `PUT /carreras/{id}/estado` con `finalizada` y vale → exigir `codigo` y fijar `tarifa` al valor aceptado.
- **App pasajero:** selector "Pagar con vale" (con cupo restante) en Pedir carrera; código visible durante el viaje.
- **App conductor:** etiqueta de vale en solicitud/viaje; al cobrar, pedir el código en vez del valor.
- **Admin:** pestaña "Empresas" (crear empresa, empleados y cupos), **reporte mensual por empresa** (carreras + recargo = total a cobrar, exportable) y **cuenta semanal por conductor** (lo que se le debe, botón "Pagado").
- **Pendiente relacionado:** factura electrónica DIAN para cobrarle a la empresa (Integrar Services, NIT 1061733315-3).
