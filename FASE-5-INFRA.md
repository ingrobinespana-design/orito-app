# Fase 5 — Infraestructura para escalar (Tukán)

_Creada 2026-10-23 · Darwin España_

El objetivo de esta fase es que, cuando lleguen muchos usuarios, **(1) te enteres si algo se
rompe antes que ellos, (2) nunca pierdas la base de datos, y (3) sepas cuándo y cómo crecer el
servidor.** Nada de esto cambia cómo se ve la app; es "el motor por debajo".

---

## 1) Monitoreo de errores — Sentry  ✅ código listo (inerte hasta activarlo)

Ya quedó integrado en el backend. **Mientras no pongas la clave, no hace absolutamente nada**
(la app arranca igual que siempre). Cuando lo actives, cada vez que algo falle en el servidor te
llega un correo con el error exacto, la línea y qué pasó — en vez de enterarte porque un usuario
se queja.

**Qué NO manda:** datos personales de los usuarios (quedó configurado `send_default_pii=False`),
así respetamos Habeas Data.

### Cómo activarlo (5 minutos, gratis)
1. Crea una cuenta gratis en **https://sentry.io** (plan Developer: gratis, suficiente de sobra).
2. Crea un proyecto nuevo → tipo **Python / FastAPI**.
3. Sentry te da un **DSN** (una URL larga que empieza por `https://...@...sentry.io/...`). Cópiala.
4. En **Railway → servicio `orito-app` → Variables**, agrega:
   - `SENTRY_DSN` = (pega el DSN)
5. Railway redespliega solo. Listo: desde ese momento se reportan los errores.

> Para desactivarlo: borra la variable `SENTRY_DSN` y la app vuelve a quedar como antes.

---

## 2) Backups automáticos de la base

Hoy el respaldo es manual. Dos capas, de más fácil a más completa:

### Opción A (recomendada): backups gestionados de Railway
1. En **Railway → tu base de datos PostgreSQL → pestaña "Backups"**.
2. Activa los **backups programados** (diarios). Railway los guarda por ti.
3. Ahí mismo puedes **restaurar** con un clic si algo pasa.
> Es la opción más segura porque no depende de que tú te acuerdes de hacerlo.

### Opción B (respaldo de tu lado): script manual
Dejé un script que baja una copia completa a tu PC cuando quieras:
```
backend\scripts\backup_db.ps1
```
- Requiere tener instaladas las **Command Line Tools de PostgreSQL** (traen `pg_dump`):
  https://www.postgresql.org/download/windows/
- Se corre así (desde la carpeta `backend`):
  ```
  powershell -ExecutionPolicy Bypass -File scripts\backup_db.ps1
  ```
- Guarda un archivo `tukan_FECHA.sql` en `backend\backups\` (esa carpeta **no** se sube a git,
  porque lleva datos reales).
- Mantiene automáticamente los últimos 30 backups.

> Buena práctica: una copia en tu PC + otra en un disco/USB o en la nube (Drive) de vez en cuando.

---

## 3) Plan de escalado (cuándo y cómo crecer)

No hay que hacer nada hoy. Esto es el **mapa de qué tocar cuando crezca**, en orden:

| Señal (cuando veas esto…) | Qué hacer |
|---|---|
| La app va lenta en horas pico | Subir recursos del servicio `orito-app` en Railway (más RAM/CPU). |
| Un solo servidor no alcanza | Activar **réplicas** (varias copias del backend) en Railway. *(Ojo: el freno anti-abuso hoy cuenta en memoria; con varias réplicas hay que moverlo a la base o a Redis — es un cambio chico, cuando toque.)* |
| La base empieza a sufrir | Pasar a un **plan de base gestionada** más grande (más conexiones, backups incluidos). |
| Muchas fotos / carga lenta de imágenes | Ya usamos **Cloudinary** (CDN), que escala solo. Revisar solo el plan si se llena el cupo. |
| Picos de tráfico en una zona | Nada especial: Railway + Cloudinary ya reparten carga. |

**Qué vigilar cada tanto (salud del sistema):**
- Uso de CPU/RAM del servicio en Railway (que no viva al 100%).
- Errores en Sentry (que no aparezcan errores repetidos).
- Tamaño de la base y número de conexiones.

---

### Resumen
- **Sentry:** código ✅ listo e inerte; se enciende poniendo `SENTRY_DSN` en Railway.
- **Backups:** activa los de Railway (Opción A) + script manual `backup_db.ps1` (Opción B).
- **Escalado:** nada hoy; subir recursos/réplicas/base **solo cuando las señales aparezcan**.
- Regla permanente: no romper el buscador ni la app en producción. Sentry es aditivo e inerte.
