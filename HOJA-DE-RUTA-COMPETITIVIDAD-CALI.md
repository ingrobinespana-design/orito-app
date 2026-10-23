# Tukán — Hoja de ruta de competitividad (Cali) y seguridad de datos

_Creada 2026-10-23 · Darwin España_

## Veredicto estratégico
De frente contra Uber/DiDi/inDrive/Yango **no** se les gana (capital + liquidez). La jugada es ser
**"inDrive local + ACARREOS", con 0% comisión, "tú pones el precio" y confianza**, enfocado en
**una zona apretada** y en el **nicho de acarreos/trasteos** donde los gigantes son débiles.
Benchmark real = **inDrive**, no Uber. La clave no es tecnología (la app ya hace mucho), es
**liquidez + no romperse + confianza + recuperación de cuenta**.

---

## FASE 1 — Arreglar lo roto ✅ COMPLETA (2026-10-23)
- [x] **Subida de documentos/fotos del conductor** (Cloudinary) — HECHO: faltaban las variables
      `CLOUDINARY_*` en Railway; se pusieron, el `orito-app` redesplegó y la subida se verificó (HTTP 200).
- [x] **Notificaciones (FCM)** — revisadas: canal MAX + tono propio + bypassDnd + reintentos + aviso
      local con app abierta. Están bien. (Mejora futura opcional: full-screen tipo llamada = APK nuevo.)
- [x] **GPS en vivo del conductor disponible** — el carrito se mueve esperando carrera (OTA).
- [x] **Buscador de direcciones** → Mapbox **Search Box** (aditivo, con pruebas). Ahora encuentra
      POIs/negocios, vías con nombre y nomenclatura; pueblos chicos sin regresión. Buscador intacto.

## FASE 2 — Login por código (OTP) + recuperación de cuenta  ⭐ LA MÁS IMPORTANTE
> Hoy NO hay recuperación de cuenta: si olvidas la clave, quedas por fuera. Con miles de usuarios es un desastre.
> **DISEÑO LISTO (2026-10-23): ver `FASE-2-OTP-DISENO.md`. Se construye + prueba al ACTIVAR (proveedor + tarjeta + Railway). Decisión: no pre-escribir código de auth sin testear.**
- [ ] Elegir proveedor del código: **WhatsApp OTP (Meta)** / SMS (Twilio o pasarela colombiana).
- [ ] Backend: pedir número → enviar código → verificar → entrar/crear cuenta (reemplaza contraseña).
- [ ] App: pantallas de "entra con tu número" + "pon el código".
- [ ] Migración suave: los que ya tienen clave siguen pudiendo entrar; los nuevos van por OTP.
- [ ] Resultado: registro sin fricción + **recuperación de cuenta** + más seguridad, de un solo golpe.

## FASE 3 — Mapas y direcciones de nivel competencia ✅ COMPLETA (2026-10-23)
- [x] **Mapa a Mapbox GL JS (vectorial)** — gira 360° con 2 dedos (nombres derechos), 3D opcional,
      más fino, como Uber. Conserva carrito/ruta/cámara/preview. Probado en navegador antes de publicar.
- [x] **Buscador que "triangule" las direcciones** → Mapbox Search Box (ver Fase 1). Pendiente futuro:
      **híbrido con Google** (guardado, si se quiere cobertura total de direcciones; ver `tukan-mapas-geocoding`).

## FASE 4 — Confianza, seguridad del usuario y Habeas Data
- [ ] Hacer **visible** la seguridad en marketing: foto/placa/docs, ver y **compartir viaje en vivo**, **SOS**, calificaciones (ya existen).
- [ ] **Borrar cuenta/datos a pedido** (derecho Habeas Data, Ley 1581) + consentimiento claro + minimizar datos.
- [ ] Sellar el endpoint de ubicación (hoy abierto) y **rotar credenciales** que estuvieron en el repo público (Cloudinary).

## FASE 5 — Infraestructura para escalar  ✅ CÓDIGO/GUÍA LISTA (2026-10-23) · ver `FASE-5-INFRA.md`
- [x] **Monitoreo (Sentry)** — integrado en el backend, **inerte** hasta poner `SENTRY_DSN` en
      Railway (no manda datos personales; `send_default_pii=False`). Activación en `FASE-5-INFRA.md`.
- [x] **Backups** — script `backend/scripts/backup_db.ps1` (pg_dump, deja copia local) +
      guía para activar los **backups programados de Railway** (recomendado). Dumps fuera de git.
- [x] **Plan de escalado** documentado: cuándo subir recursos/réplicas/base gestionada; Cloudinary
      (CDN) ya escala. *(Pendiente al activar réplicas: mover el freno anti-abuso de memoria a BD/Redis.)*
- [ ] **Acción tuya:** crear cuenta Sentry → pegar `SENTRY_DSN` en Railway; activar backups en Railway.

## FASE 6 — Crecimiento (liquidez)
- [ ] **Sembrar conductores** en 1 zona con bonos/referidos (ya hay referidos) + foco en acarreos.
- [ ] Manejar para la competencia y recomendar la app a quienes movilizas (plan de Darwin).
- [ ] Promos de lanzamiento (primeras N carreras sin nada).

## FASE 7 — Pagos en la app (más adelante)
- [ ] Pago con tarjeta en la app — lo más complejo y regulado; solo cuando ya haya liquidez.

---

### Estado al 2026-10-23
- **HECHO:** Fase 1 ✅, Fase 3 ✅. Railway ya compila de nuevo.
- Extras de la sesión (fuera de las fases): tarifa de Cali 2.000/km + mín. 8.000 (+ endpoint de tarifa
  remota); conductor en carrera = mapa casi pantalla completa; conductor esperando = mapa grande sin
  "Solicitudes" redundante; cliente ve la marca del vehículo; botón Cerrar sesión en el Admin; compartir
  viaje EN VIVO; landing con descarga directa + pantallazos actualizados; **expresos vencidos**: botones
  Reprogramar/Ejecutado/Cancelar al cliente + ya no se muestran al conductor.
- **FALTA (lo grande para acercarnos a la competencia):** Fase 2 (OTP/recuperación) ⭐, Fase 4 (Habeas
  Data/seguridad de datos), Fase 5 (infra para escalar), Fase 6 (liquidez) y Fase 7 (pagos).
- Regla permanente del usuario: **no dañar el buscador** y no romper la app en producción.
