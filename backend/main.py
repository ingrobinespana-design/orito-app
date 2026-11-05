from fastapi import FastAPI, Depends, HTTPException, File, UploadFile, BackgroundTasks, Request, Header
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy.orm import Session
from sqlalchemy import func
from database import SessionLocal, crear_tablas, Restaurante, Pedido, Usuario, Plato, Carrera, Lugar, Config, Municipio, Tarifa, Oferta, Evento, EventoCiudad, Expreso, OfertaExpreso, LugarGuardado, CodigoVerificacion, VEHICULOS_VALIDOS, VEHICULOS_CARGA
from datetime import datetime, timedelta
from passlib.context import CryptContext
from dotenv import load_dotenv
import logging
import push
import tarifas
import legal
import nomenclatura
nomenclatura.tiene_malla("Cali")   # carga la malla de calles al arrancar (no en la 1a busqueda)
import cloudinary
import cloudinary.uploader
import os
import secrets
import hmac
import hashlib

load_dotenv()

# ---- Monitoreo de errores (Sentry). Inerte si no hay SENTRY_DSN: en ese caso
# no envia nada y la app arranca EXACTAMENTE igual que siempre. Se activa poniendo
# la variable SENTRY_DSN en Railway (cuenta gratis en sentry.io). No manda datos
# personales de los usuarios (send_default_pii=False), respetando Habeas Data.
SENTRY_DSN = os.environ.get("SENTRY_DSN", "").strip()
if SENTRY_DSN:
    try:
        import sentry_sdk
        sentry_sdk.init(
            dsn=SENTRY_DSN,
            environment=os.environ.get("RAILWAY_ENVIRONMENT_NAME", "production"),
            traces_sample_rate=0.0,   # solo errores, sin trazas de rendimiento (cupo gratis dura mas)
            send_default_pii=False,   # NO enviar datos personales de usuarios
        )
        logging.info("Sentry activado")
    except Exception as e:
        logging.warning(f"Sentry no se pudo iniciar, la app sigue normal: {e}")

cloudinary.config(
    cloud_name=os.environ.get("CLOUDINARY_CLOUD_NAME"),
    api_key=os.environ.get("CLOUDINARY_API_KEY"),
    api_secret=os.environ.get("CLOUDINARY_API_SECRET")
)

app = FastAPI(title="Tukan - API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

crear_tablas()

pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")

# ---- freno anti-abuso (en memoria; el instance pago de Railway no se duerme,
# asi que el conteo se mantiene). Solo se limita lo sensible: crear cuentas y
# adivinar contraseñas. NO se limita lo de lectura/polling, y NO se pone un tope
# global por IP: en el pueblo mucha gente comparte la misma IP del operador
# (CGNAT) y un tope global tumbaria a usuarios legitimos.
import time as _time
import threading
from collections import defaultdict, deque
_conteos = defaultdict(deque)

def paso_del_limite(clave, maximo, ventana_seg):
    """True si 'clave' ya hizo 'maximo' intentos en la ventana. Sliding window."""
    ahora = _time.time()
    q = _conteos[clave]
    while q and ahora - q[0] > ventana_seg:
        q.popleft()
    if len(q) >= maximo:
        return True
    q.append(ahora)
    return False

def limpiar_limite(clave):
    _conteos.pop(clave, None)

def ip_de(request: Request):
    """IP real del cliente detras del proxy de Railway."""
    fwd = request.headers.get("x-forwarded-for")
    return (fwd.split(",")[0].strip() if fwd else (request.client.host if request.client else "?"))

def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()

@app.get("/salud")
def salud():
    """Latido para monitores de disponibilidad (UptimeRobot y similares).
    Barato y sin tocar la base: solo confirma que el servidor responde."""
    return {"ok": True, "servicio": "tukan"}

@app.get("/respaldo")
def respaldo(clave: str = None, x_admin_token: str = Header(None), db: Session = Depends(get_db)):
    """Copia completa de la base en JSON, para respaldo. El servidor la genera
    (esta pegado a la base). Autoriza con una clave dedicada RESPALDO_CLAVE (para
    automatizar la descarga diaria) o con la sesion del admin. Si la clave no
    esta configurada, el endpoint queda apagado — nunca abierto por accidente."""
    from fastapi.responses import Response
    esperada = os.environ.get("RESPALDO_CLAVE")
    if not esperada:
        raise HTTPException(status_code=503, detail="Respaldo no configurado")
    ok = bool(clave) and secrets.compare_digest(clave, esperada)
    if not ok and x_admin_token:
        u = db.query(Usuario).filter(Usuario.token == x_admin_token).first()
        ok = bool(u and u.rol == "admin")
    if not ok:
        raise HTTPException(status_code=403, detail="Clave de respaldo invalida")
    modelos = [Restaurante, Pedido, Usuario, Plato, Carrera, Lugar, Config, Municipio, Tarifa, Oferta, Evento]
    tablas = {}
    for M in modelos:
        tablas[M.__tablename__] = [
            {c.name: getattr(fila, c.name) for c in M.__table__.columns}
            for fila in db.query(M).all()
        ]
    import json as _json
    cuerpo = _json.dumps({"generado": datetime.now().isoformat(), "tablas": tablas},
                         default=str, ensure_ascii=False)
    nombre = f"tukan-respaldo-{datetime.now():%Y%m%d-%H%M}.json"
    return Response(content=cuerpo, media_type="application/json",
                    headers={"Content-Disposition": f'attachment; filename="{nombre}"'})

@app.get("/respaldo-usuarios")
def respaldo_usuarios(clave: str = None, x_admin_token: str = Header(None), db: Session = Depends(get_db)):
    """La base del PERSONAL inscrito (clientes y conductores) en Excel (CSV), para
    tenerla y respaldarla. Incluye ciudad y departamento. Mismo permiso que
    /respaldo: RESPALDO_CLAVE (link en el navegador) o la sesion del admin."""
    from fastapi.responses import Response
    import csv, io
    esperada = os.environ.get("RESPALDO_CLAVE")
    if not esperada:
        raise HTTPException(status_code=503, detail="Respaldo no configurado")
    ok = bool(clave) and secrets.compare_digest(clave, esperada)
    if not ok and x_admin_token:
        u = db.query(Usuario).filter(Usuario.token == x_admin_token).first()
        ok = bool(u and u.rol == "admin")
    if not ok:
        raise HTTPException(status_code=403, detail="Clave de respaldo invalida")
    deptos = {m.nombre: (m.departamento or "") for m in db.query(Municipio).all()}
    usuarios = db.query(Usuario).order_by(Usuario.rol, Usuario.municipio, Usuario.id).all()
    buf = io.StringIO()
    buf.write("﻿")   # BOM: para que Excel muestre bien las tildes
    w = csv.writer(buf)
    w.writerow(["ID", "Nombre", "Telefono", "Rol", "Ciudad", "Departamento",
                "Tipo vehiculo", "Placa", "Vehiculo", "Calificacion",
                "Disponible", "Estado", "Suscripcion hasta", "Nequi"])
    for u in usuarios:
        w.writerow([u.id, u.nombre, u.telefono, u.rol, u.municipio or "",
                    deptos.get(u.municipio, ""), u.tipo_vehiculo or "", u.placa or "",
                    u.vehiculo or "", u.calificacion if u.calificacion is not None else "",
                    u.disponible, u.activo or "si",
                    u.suscripcion_hasta.strftime("%Y-%m-%d") if u.suscripcion_hasta else "",
                    u.pago_nequi or ""])
    nombre = f"tukan-usuarios-{datetime.now():%Y%m%d}.csv"
    return Response(content=buf.getvalue(), media_type="text/csv; charset=utf-8",
                    headers={"Content-Disposition": f'attachment; filename="{nombre}"'})

@app.put("/apk-url")
def actualizar_apk_url(clave: str, valor: str, db: Session = Depends(get_db)):
    """Apunta el enlace publico (/apk) a un APK nuevo. Autorizado SOLO con la
    clave dedicada RESPALDO_CLAVE (la misma del respaldo). Alcance minimo: solo
    toca apk_url, nada mas. Sirve para actualizar el link tras compilar sin
    depender de la sesion viva del admin."""
    esperada = os.environ.get("RESPALDO_CLAVE")
    if not esperada or not (clave and secrets.compare_digest(clave, esperada)):
        raise HTTPException(status_code=403, detail="Clave invalida")
    if not valor.startswith("https://"):
        raise HTTPException(status_code=400, detail="El valor debe ser una URL https")
    fila = db.query(Config).filter(Config.clave == "apk_url").first()
    if fila:
        fila.valor = valor
    else:
        db.add(Config(clave="apk_url", valor=valor))
    db.commit()
    return {"ok": True, "apk_url": valor}

@app.get("/diag/push")
def diagnostico_push(clave: str, tel: str, probar: str = "no", db: Session = Depends(get_db)):
    """Diagnostico de avisos de un conductor (clave RESPALDO_CLAVE): como quedo
    registrado su telefono y, con probar=si, le manda un aviso de PRUEBA por el
    mismo camino que una solicitud real (push normal + push de datos)."""
    esperada = os.environ.get("RESPALDO_CLAVE")
    if not esperada or not (clave and secrets.compare_digest(clave, esperada)):
        raise HTTPException(status_code=403, detail="Clave invalida")
    u = db.query(Usuario).filter(Usuario.telefono.like(f"%{_digitos(tel)[-10:]}")).first()
    if not u:
        raise HTTPException(status_code=404, detail="No existe")
    info = {"id": u.id, "nombre": u.nombre, "rol": u.rol, "disponible": u.disponible,
            "tiene_token": bool(u.push_token), "token_inicio": (u.push_token or "")[:28],
            "push_modo": u.push_modo, "push_canal": u.push_canal or "carreras3 (tono viejo)", "ubic_fecha": u.ubic_fecha, "municipio": u.municipio}
    if probar == "si" and u.push_token:
        msgs = push_conductor(u, "🔔 Prueba de solicitud", "Aviso de prueba desde el servidor",
                              {"tipo": "carrera_nueva", "carrera_id": 0})
        info["envio"] = push.enviar(msgs)
    return info

_DIAG_EVENTOS = []   # ultimos reportes de la app (en memoria, se borran al reiniciar)

@app.post("/diag/evento")
async def diag_evento(request: Request):
    """La app reporta que paso con un aviso en segundo plano (para depurar)."""
    try:
        cuerpo = (await request.body())[:2000].decode("utf-8", "replace")
    except Exception:
        cuerpo = ""
    _DIAG_EVENTOS.append({"t": datetime.now().isoformat(timespec="seconds"), "e": cuerpo})
    del _DIAG_EVENTOS[:-60]
    return {"ok": True}

@app.get("/diag/eventos")
def diag_eventos(clave: str):
    esperada = os.environ.get("RESPALDO_CLAVE")
    if not esperada or not (clave and secrets.compare_digest(clave, esperada)):
        raise HTTPException(status_code=403, detail="Clave invalida")
    return _DIAG_EVENTOS

@app.put("/verificar-con-clave")
def verificar_con_clave(clave: str, tel: str, valor: str = "si", db: Session = Depends(get_db)):
    """Verifica (habilita) un conductor por telefono con la clave RESPALDO_CLAVE,
    sin la sesion del admin (p. ej. las cuentas de prueba para Google Play)."""
    esperada = os.environ.get("RESPALDO_CLAVE")
    if not esperada or not (clave and secrets.compare_digest(clave, esperada)):
        raise HTTPException(status_code=403, detail="Clave invalida")
    u = db.query(Usuario).filter(Usuario.telefono == _digitos(tel), Usuario.rol == "conductor").first()
    if not u:
        raise HTTPException(status_code=404, detail="Conductor no encontrado")
    u.verificado = "si" if valor == "si" else "no"
    db.commit()
    return {"ok": True, "id": u.id, "verificado": u.verificado}

@app.put("/fundador-con-clave")
def fundador_con_clave(clave: str, tel: str, valor: str = "si", db: Session = Depends(get_db)):
    """Marca/quita la insignia de Conductor Fundador por telefono con RESPALDO_CLAVE."""
    esperada = os.environ.get("RESPALDO_CLAVE")
    if not esperada or not (clave and secrets.compare_digest(clave, esperada)):
        raise HTTPException(status_code=403, detail="Clave invalida")
    u = db.query(Usuario).filter(Usuario.telefono == _digitos(tel), Usuario.rol == "conductor").first()
    if not u:
        raise HTTPException(status_code=404, detail="Conductor no encontrado")
    u.fundador = "si" if valor == "si" else "no"
    db.commit()
    return {"ok": True, "nombre": u.nombre, "fundador": u.fundador}

@app.put("/municipio-tarifa/{nombre}")
def actualizar_tarifa_municipio(nombre: str, clave: str, valor_km: int = None,
                                tarifa_minima: int = None, tarifa_base: int = None,
                                db: Session = Depends(get_db)):
    """Ajusta SOLO la tarifa de una ciudad (valor por km, minima, base) con la clave
    dedicada RESPALDO_CLAVE, sin depender de la sesion viva del admin. Alcance minimo:
    no toca vehiculos, centro, ni activa/desactiva nada. El ajuste manual del admin
    (PUT /municipios/{nombre}) sigue intacto en paralelo."""
    esperada = os.environ.get("RESPALDO_CLAVE")
    if not esperada or not (clave and secrets.compare_digest(clave, esperada)):
        raise HTTPException(status_code=403, detail="Clave invalida")
    m = db.query(Municipio).filter(Municipio.nombre == nombre).first()
    if not m:
        raise HTTPException(status_code=404, detail="Municipio no encontrado")
    for campo, valor in (("tarifa_base", tarifa_base), ("valor_km", valor_km), ("tarifa_minima", tarifa_minima)):
        if valor is not None:
            if valor < 0:
                raise HTTPException(status_code=400, detail=f"{campo} no puede ser negativo")
            setattr(m, campo, valor)
    # si se le pone un $/km, que mida la distancia por GPS (igual que el panel admin)
    if (valor_km or 0) > 0:
        m.usa_gps = "si"
    db.commit()
    db.refresh(m)
    return {"ok": True, "municipio": m.nombre, "tarifa_base": m.tarifa_base or 0,
            "valor_km": m.valor_km or 0, "tarifa_minima": m.tarifa_minima or 0}

@app.put("/tarifa-vehiculo")
def tarifa_por_vehiculo(clave: str, municipio: str, vehiculo: str, valor_km: int,
                        minima: int = 0, base: int = 0, db: Session = Depends(get_db)):
    """Crea o actualiza la tarifa de UN vehiculo en una ciudad (ej. moto en Cali),
    con RESPALDO_CLAVE. Tiene prioridad sobre la tarifa general de la ciudad."""
    esperada = os.environ.get("RESPALDO_CLAVE")
    if not esperada or not (clave and secrets.compare_digest(clave, esperada)):
        raise HTTPException(status_code=403, detail="Clave invalida")
    if not db.query(Municipio).filter(Municipio.nombre == municipio).first():
        raise HTTPException(status_code=404, detail="Municipio no encontrado")
    if min(valor_km, minima, base) < 0:
        raise HTTPException(status_code=400, detail="Los valores no pueden ser negativos")
    t = db.query(Tarifa).filter(Tarifa.municipio == municipio, Tarifa.vehiculo == vehiculo).first()
    if not t:
        t = Tarifa(municipio=municipio, vehiculo=vehiculo)
        db.add(t)
    t.base, t.valor_km, t.minima = base, valor_km, minima
    db.commit()
    return {"ok": True, "municipio": municipio, "vehiculo": vehiculo,
            "base": t.base, "valor_km": t.valor_km, "minima": t.minima}

@app.put("/promo")
def configurar_promo(clave: str, activa: str = None, pct: int = None,
                     ciudad: str = None, texto: str = None, dias: int = None,
                     hasta: str = None, tema: str = None, db: Session = Depends(get_db)):
    """Prende/apaga la promo de lanzamiento (SOLO carreras de pasajeros) con la
    clave RESPALDO_CLAVE. activa: 'si'/'no'; pct: % de descuento (0-99);
    ciudad: nombre exacto o 'todas'; texto: etiqueta que ve el cliente;
    dias: a cuantos dias se apaga SOLA (0 o vacio = sin limite)."""
    esperada = os.environ.get("RESPALDO_CLAVE")
    if not esperada or not (clave and secrets.compare_digest(clave, esperada)):
        raise HTTPException(status_code=403, detail="Clave invalida")
    def _set(k, v):
        fila = db.query(Config).filter(Config.clave == k).first()
        if fila:
            fila.valor = str(v)
        else:
            db.add(Config(clave=k, valor=str(v)))
    if activa is not None:
        if activa not in ("si", "no"):
            raise HTTPException(status_code=400, detail="activa solo acepta si o no")
        _set("promo_activa", activa)
    if pct is not None:
        if pct < 0 or pct >= 100:
            raise HTTPException(status_code=400, detail="pct debe estar entre 0 y 99")
        _set("promo_pct", pct)
    if ciudad is not None:
        _set("promo_ciudad", ciudad)
    if texto is not None:
        _set("promo_texto", texto)
    if dias is not None:
        _set("promo_hasta", "" if dias <= 0 else (datetime.now() + timedelta(days=dias)).isoformat())
    if tema is not None:
        _set("promo_tema", tema.strip().lower())   # motivo del anuncio: navidad, lanzamiento...
    if hasta:
        # fecha exacta (AAAA-MM-DD): vale hasta las 11:59 p. m. de ese dia en Colombia
        try:
            fin = datetime.fromisoformat(hasta[:10]) + timedelta(hours=23, minutes=59, seconds=59) + timedelta(hours=5)
        except ValueError:
            raise HTTPException(status_code=400, detail="hasta: usa AAAA-MM-DD")
        _set("promo_hasta", fin.isoformat())
    db.commit()
    return {"ok": True,
            "promo_activa": leer_config("promo_activa", db, "no"),
            "promo_pct": leer_config("promo_pct", db, "0"),
            "promo_ciudad": leer_config("promo_ciudad", db, ""),
            "promo_texto": leer_config("promo_texto", db, ""),
            "promo_hasta": leer_config("promo_hasta", db, ""),
            "promo_tema": leer_config("promo_tema", db, "navidad")}

@app.put("/exclusivo")
def configurar_exclusivo(clave: str, tel: str = None, radio_km: float = None,
                         db: Session = Depends(get_db)):
    """Ruta exclusiva del dueño (aeropuerto + radio). Con RESPALDO_CLAVE.
    tel vacio ('') = apagar la regla. Sin parametros = solo consulta el estado."""
    esperada = os.environ.get("RESPALDO_CLAVE")
    if not esperada or not (clave and secrets.compare_digest(clave, esperada)):
        raise HTTPException(status_code=403, detail="Clave invalida")
    def _set(k, v):
        fila = db.query(Config).filter(Config.clave == k).first()
        if fila:
            fila.valor = str(v)
        else:
            db.add(Config(clave=k, valor=str(v)))
    if tel is not None:
        _set("exclusivo_aeropuerto_tel", _digitos(tel))
    if radio_km is not None:
        if radio_km < 0 or radio_km > 50:
            raise HTTPException(status_code=400, detail="radio_km entre 0 y 50 (0 = sin limite)")
        _set("exclusivo_radio_km", radio_km)
    db.commit()
    _cache_excl["t"] = 0.0   # que tome el cambio ya, sin esperar el cache
    t, r, tipo = _cfg_exclusivo()
    dueno = next((u for u in db.query(Usuario).filter(Usuario.rol == "conductor").all()
                  if t and _digitos(u.telefono)[-10:] == t), None)
    return {"activa": bool(t), "telefono_config": leer_config("exclusivo_aeropuerto_tel", db, ""),
            "conductor": dueno.nombre if dueno else None, "tipo_vehiculo": tipo,
            "municipio": dueno.municipio if dueno else None, "radio_km": r}

@app.get("/diag-push")
def diag_push(clave: str = None, telefono: str = None,
              x_admin_token: str = Header(None), db: Session = Depends(get_db)):
    """Diagnostico: dice el estado real de un conductor y le manda un push directo
    SALTANDOSE todos los filtros (disponible/vehiculo/municipio/suscripcion).
    Sirve para aislar si el problema es la ENTREGA del push o los FILTROS.
    Autoriza con RESPALDO_CLAVE (link en navegador) o con la sesion del admin
    (boton del panel — no hace falta la clave)."""
    esperada = os.environ.get("RESPALDO_CLAVE")
    ok = bool(esperada) and bool(clave) and secrets.compare_digest(clave, esperada)
    if not ok and x_admin_token:
        adm = db.query(Usuario).filter(Usuario.token == x_admin_token).first()
        ok = bool(adm and adm.rol == "admin")
    if not ok:
        raise HTTPException(status_code=403, detail="No autorizado")
    u = db.query(Usuario).filter(Usuario.telefono == telefono).first()
    if not u:
        raise HTTPException(status_code=404, detail="No hay usuario con ese telefono")
    estado = {
        "id": u.id, "nombre": u.nombre, "rol": u.rol,
        "disponible": u.disponible, "municipio": u.municipio,
        "tipo_vehiculo": u.tipo_vehiculo,
        "tiene_token": bool(u.push_token),
        "token_preview": (u.push_token[:28] + "...") if u.push_token else None,
        "cobro_activo": leer_config("cobro_activo", db, "no"),
        "suscripcion_al_dia": suscripcion_al_dia(u, db),
    }
    if not u.push_token:
        return {"estado": estado, "enviado": False, "motivo": "sin push_token"}
    muertos = push.enviar([push.mensaje(
        u.push_token, "🔔 Prueba directa",
        "Si suena, la entrega funciona. El problema serian los filtros.",
        {"tipo": "diag"})])
    return {"estado": estado, "enviado": True, "token_muerto": bool(muertos)}

@app.get("/soporte/contacto")
def contacto_soporte(db: Session = Depends(get_db)):
    """Numero de WhatsApp de soporte, para que la app muestre el boton de ayuda.
    Publico y configurable desde el panel (whatsapp_soporte) — el dia que cambie
    el numero no hay que actualizar la app."""
    return {"whatsapp": leer_config("whatsapp_soporte", db, "3133714915")}

@app.get("/soporte/liberar")
def liberar_usuario(clave: str = None, telefono: str = None,
                    x_admin_token: str = Header(None), db: Session = Depends(get_db)):
    """Soporte: cancela las carreras activas atascadas de un usuario (por telefono)
    para desbloquearlo cuando quedo con una 'en curso' que no cerro y no puede
    pedir otra. Autoriza con RESPALDO_CLAVE (para abrir el link en el navegador) o
    con la sesion del admin (para el boton del panel). Es GET a proposito."""
    esperada = os.environ.get("RESPALDO_CLAVE")
    ok = bool(esperada) and bool(clave) and secrets.compare_digest(clave, esperada)
    if not ok and x_admin_token:
        adm = db.query(Usuario).filter(Usuario.token == x_admin_token).first()
        ok = bool(adm and adm.rol == "admin")
    if not ok:
        raise HTTPException(status_code=403, detail="No autorizado")
    u = db.query(Usuario).filter(Usuario.telefono == telefono).first()
    if not u:
        raise HTTPException(status_code=404, detail="No hay usuario con ese telefono")
    activas = db.query(Carrera).filter(
        Carrera.cliente_id == u.id,
        Carrera.estado.in_(["buscando", "aceptada", "en_sitio", "en_camino"])).all()
    ids = [a.id for a in activas]
    for a in activas:
        a.estado = "cancelada"
    db.commit()
    return {"ok": True, "usuario": u.nombre, "telefono": u.telefono, "canceladas": ids}

def solo_admin(x_admin_token: str = Header(None), db: Session = Depends(get_db)):
    """Candado del panel: sin la llave de sesion de un usuario con rol admin,
    nadie toca config, precios, usuarios ni roles. Se usa como Depends()."""
    if not x_admin_token:
        raise HTTPException(status_code=401, detail="Necesitas entrar como administrador")
    usuario = db.query(Usuario).filter(Usuario.token == x_admin_token).first()
    if not usuario or usuario.rol != "admin":
        raise HTTPException(status_code=403, detail="Solo el administrador puede hacer esto")
    return usuario

def usuario_actual(x_user_token: str = Header(None), db: Session = Depends(get_db)):
    """Identifica QUIEN esta haciendo la peticion por su llave de sesion. Con
    esto el servidor exige que solo puedas tocar TUS cosas: tu carrera, tu
    perfil. Un admin tambien es un usuario valido."""
    if not x_user_token:
        raise HTTPException(status_code=401, detail="Sesion no valida. Vuelve a entrar.")
    usuario = db.query(Usuario).filter(Usuario.token == x_user_token).first()
    if not usuario:
        raise HTTPException(status_code=401, detail="Sesion vencida. Vuelve a entrar.")
    return usuario

def exigir_dueño(actual: Usuario, id_dueño: int):
    """Corta si el que pide no es el dueño del recurso (ni admin)."""
    if actual.rol != "admin" and actual.id != id_dueño:
        raise HTTPException(status_code=403, detail="No puedes tocar algo que no es tuyo")

@app.get("/")
def inicio():
    return {"mensaje": "Bienvenido a Tukan"}

# ---------------------------------------------------------------- DESCARGA
# Pagina publica para masificar la app: el QR del flyer y los mensajes de
# WhatsApp/Facebook apuntan a /app (enlace FIJO). El boton baja el APK vigente
# via /apk, que se cambia por config sin reimprimir nada.
from fastapi.responses import HTMLResponse, RedirectResponse, FileResponse

@app.get("/logo.png")
def logo():
    return FileResponse("logo_tukan.png", media_type="image/png")

# los robots que generan la vista previa del link (WhatsApp, Facebook, etc.)
# visitan la pagina cada vez que alguien COMPARTE el link; no son personas
_BOTS = ("whatsapp", "facebookexternalhit", "facebot", "telegrambot", "twitterbot",
         "bot", "crawler", "spider", "preview", "curl", "python")

def registrar_evento(tipo: str, request: Request, db: Session):
    try:
        ua = (request.headers.get("user-agent") or "").lower()
        if any(b in ua for b in _BOTS):
            return
        db.add(Evento(tipo=tipo))
        db.commit()
    except Exception:
        pass   # una metrica jamas puede tumbar la pagina

@app.get("/apk")
def descargar_apk(request: Request, db: Session = Depends(get_db)):
    url = leer_config("apk_url", db, "")
    if not url:
        raise HTTPException(status_code=404, detail="APK no disponible todavia")
    registrar_evento("descarga_apk", request, db)
    return RedirectResponse(url)

@app.get("/app", response_class=HTMLResponse)
def pagina_descarga(request: Request, db: Session = Depends(get_db)):
    registrar_evento("visita_pagina", request, db)
    base = str(request.base_url).rstrip("/")
    return f"""<!DOCTYPE html>
<html lang="es"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Tukán — Descarga la app</title>
<meta property="og:title" content="Tukán — Movilidad y acarreos">
<meta property="og:description" content="Carreras, acarreos y mudanzas. Tú pones el precio y pagas directo al conductor. Descarga la app gratis.">
<meta property="og:image" content="{base}/logo.png">
<meta property="og:type" content="website">
<style>
  body{{margin:0;font-family:-apple-system,Roboto,'Segoe UI',sans-serif;background:#0E3D1E;color:#fff}}
  .caja{{max-width:430px;margin:0 auto;padding:28px 20px;text-align:center}}
  img.logo{{width:150px;height:150px;border-radius:32px;box-shadow:0 6px 24px rgba(0,0,0,.4)}}
  h1{{font-size:42px;margin:14px 0 2px;color:#F6F1E6}}
  h1 span{{color:#F06000}}
  .sub{{color:#A9CBB4;font-size:15px;margin-bottom:22px}}
  .boton{{display:block;background:#F06000;color:#fff;text-decoration:none;font-size:21px;font-weight:800;
    padding:17px;border-radius:14px;box-shadow:0 4px 14px rgba(240,96,0,.45);margin:6px 0 8px}}
  .mini{{color:#A9CBB4;font-size:12px;margin-bottom:24px}}
  .paso{{background:rgba(255,255,255,.07);border-radius:12px;padding:13px 15px;margin:9px 0;text-align:left;font-size:14px;line-height:1.45}}
  .paso b{{color:#FFB36B}}
  .promo{{background:#F06000;border-radius:12px;padding:12px;margin:20px 0 6px;font-weight:700;font-size:15px}}
  a.wa{{color:#7BE2A0;font-weight:600;text-decoration:none}}
  .pie{{color:#6E9880;font-size:11px;margin-top:26px}}
</style></head><body><div class="caja">
  <img class="logo" src="/logo.png" alt="Tukán">
  <h1>Tuk<span>án</span></h1>
  <div class="sub">Movilidad y acarreos<br>Carreras · Acarreos · Mudanzas · Viajes</div>

  <a class="boton" id="btn-descarga" href="/apk">⬇️ Descargar Tukán</a>
  <div class="mini" id="nota-android">App para Android · Descarga directa, no necesita Play Store</div>
  <div id="aviso-iphone" style="display:none;background:rgba(255,255,255,.1);border-radius:12px;padding:14px;font-size:14px;line-height:1.5">
    🍎 Parece que tienes iPhone. Por ahora Tukán está disponible <b>solo para Android</b>
    (Apple no permite instalar apps por fuera de su tienda).<br><br>
    Déjanos tu número por WhatsApp y te avisamos cuando llegue a iPhone 👇
  </div>
  <script>
    if (/iPhone|iPad|iPod/.test(navigator.userAgent)) {{
      document.getElementById('btn-descarga').style.display = 'none';
      document.getElementById('nota-android').style.display = 'none';
      document.getElementById('aviso-iphone').style.display = 'block';
    }}
  </script>

  <div class="paso"><b>1. Descarga</b> — toca el botón naranja y espera a que baje el archivo.</div>
  <div class="paso"><b>2. Instala</b> — abre el archivo descargado. Si el teléfono pregunta, permite
    <b>"instalar aplicaciones desconocidas"</b> (es normal en apps fuera de Play Store).</div>
  <div class="paso"><b>3. Regístrate</b> — abre Tukán, pon tu nombre y teléfono. Si eres mototaxista
    o conductor, elige tu vehículo y ¡empieza a recibir carreras!</div>

  <div class="promo">🎉 GRATIS por lanzamiento — regístrate y empieza sin pagar</div>

  <div style="margin-top:18px;font-size:14px">¿Dudas o ayuda para instalar?<br>
  <a class="wa" href="https://wa.me/573156009728">💬 Escríbenos al WhatsApp 315 600 9728</a></div>

  <div style="margin-top:16px;font-size:12px">
    <a href="/terminos" style="color:#A9CBB4">Términos</a> ·
    <a href="/privacidad" style="color:#A9CBB4">Privacidad y Habeas Data</a>
  </div>
  <div class="pie">Tukán · Movilidad y acarreos · Colombia</div>
</div></body></html>"""

@app.get("/terminos", response_class=HTMLResponse)
def pagina_terminos():
    return legal.terminos_html()

@app.get("/privacidad", response_class=HTMLResponse)
def pagina_privacidad():
    return legal.privacidad_html()

@app.get("/eliminar-cuenta", response_class=HTMLResponse)
def pagina_eliminar_cuenta():
    """Pagina publica de borrado de cuenta (requisito de Google Play)."""
    return legal.eliminar_cuenta_html()

@app.get("/viaje", response_class=HTMLResponse)
def viaje_compartido(con: str = "", pla: str = "", tel: str = "", veh: str = "",
                     o: str = "", d: str = "", dlat: float = None, dlon: float = None,
                     olat: float = None, olon: float = None,
                     c: int = None, t: str = "", db: Session = Depends(get_db)):
    """Pagina publica de 'viaje compartido' (como el link que comparte Uber): la
    vista previa muestra el logo de Tukan y al abrirla hay un mapa con el recorrido
    y los datos del conductor.

    Dos modos:
      - EN VIVO: con ?c=<id>&t=<token> valido, la pagina lee la carrera y se
        actualiza sola cada pocos segundos (mueve el vehiculo, muestra el estado).
      - Estatico (compat): si vienen los datos sueltos por la URL, solo dibuja la
        ruta planeada. Los links viejos siguen funcionando.
    El token (HMAC con clave del servidor) evita que se pueda 'adivinar' otro viaje."""
    import html as _h
    e = lambda s: _h.escape(s or "")
    og = "https://tukan-landing.vercel.app/assets/og-image.png"
    # --- modo EN VIVO: los datos se toman de la base (y se validan con el token)
    live = False
    tipo = ""
    if c is not None and t and hmac.compare_digest(t, _token_viaje(c)):
        car = db.query(Carrera).filter(Carrera.id == c).first()
        if car:
            live = True
            cond = db.query(Usuario).filter(Usuario.id == car.conductor_id).first() if car.conductor_id else None
            con = (cond.nombre if cond else "") or ""
            pla = (cond.placa if cond else "") or ""
            tel = (cond.telefono if cond else "") or ""
            veh = (cond.vehiculo if cond else "") or ""
            tipo = (cond.tipo_vehiculo if cond else "") or ""
            o = car.origen or ""
            d = car.destino or ""
            olat, olon = car.origen_lat, car.origen_lon
            dlat, dlon = car.destino_lat, car.destino_lon
    desc = (f"De {o} hacia {d}" if (o or d) else "Sigue mi viaje en vivo") + " · Tukán"
    dest_js = f"[{dlat},{dlon}]" if (dlat is not None and dlon is not None) else "null"
    ori_js = f"[{olat},{olon}]" if (olat is not None and olon is not None) else "null"
    filas = ""
    if con: filas += f'<div class="row"><span class="k">Conductor</span><span class="v">{e(con)}</span></div>'
    placa_val = (pla + (" · " + veh if veh else "")) if pla else veh
    if placa_val: filas += f'<div class="row"><span class="k">Vehículo</span><span class="v">{e(placa_val)}</span></div>'
    if tel: filas += f'<div class="row"><span class="k">Teléfono</span><span class="v"><a href="tel:{e(tel)}" style="color:#187830">{e(tel)}</a></span></div>'
    ruta = ""
    if o or d:
        ruta = (f'<div class="ruta"><div class="pt"><span class="dot g"></span><div><div class="kk">RECOGIDA</div>'
                f'<div class="vv">{e(o or "—")}</div></div></div><div class="ln"></div>'
                f'<div class="pt"><span class="dot r"></span><div><div class="kk">DESTINO</div>'
                f'<div class="vv">{e(d or "—")}</div></div></div></div>')
    botones = ""
    if tel:
        _dig = "".join(ch for ch in tel if ch.isdigit())
        _wa = ("57" + _dig) if len(_dig) == 10 else _dig
        botones += f'<a class="btn wa" href="https://wa.me/{_wa}">💬 WhatsApp al conductor</a>'
    if dlat is not None and dlon is not None:
        botones += f'<a class="btn gm" href="https://www.google.com/maps/dir/?api=1&destination={dlat},{dlon}">🧭 Abrir en Google Maps</a>'
    estado_bar = '<div class="estado" id="estado"><span class="dotlive"></span>Conectando con el viaje…</div>' if live else ""
    estado_url = f"/viaje/{c}/estado?t={t}" if live else ""
    tpl = """<!doctype html><html lang="es"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Tukán · Viaje compartido</title>
<meta property="og:title" content="Voy en un viaje con Tukán">
<meta property="og:description" content="__DESC__">
<meta property="og:image" content="__OG__">
<meta property="og:type" content="website">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:image" content="__OG__">
<link rel="icon" href="/logo.png">
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"/>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,Roboto,'Segoe UI',sans-serif;background:#F6F1E6;color:#1C2B22}
.top{background:#187830;color:#fff;padding:16px 18px;display:flex;align-items:center;gap:10px}
.top img{width:40px;height:40px;border-radius:11px;background:#F6F1E6}
.top b{font-size:19px;font-weight:800}.top small{display:block;color:rgba(255,255,255,.8);font-size:12px}
#map{height:320px;width:100%}
.wrap{max-width:560px;margin:0 auto}
.card{background:#fff;margin:-18px 14px 16px;border-radius:16px;padding:16px;box-shadow:0 8px 22px rgba(0,0,0,.08);position:relative}
.estado{display:flex;align-items:center;gap:9px;background:#EAF6EE;color:#136b2e;font-weight:800;font-size:14.5px;border-radius:12px;padding:12px 14px;margin-bottom:14px}
.dotlive{width:10px;height:10px;border-radius:50%;background:#1E8A3E;flex:none;box-shadow:0 0 0 0 rgba(30,138,62,.6);animation:latir 1.4s infinite}
@keyframes latir{0%{box-shadow:0 0 0 0 rgba(30,138,62,.55)}70%{box-shadow:0 0 0 10px rgba(30,138,62,0)}100%{box-shadow:0 0 0 0 rgba(30,138,62,0)}}
.ruta{margin-bottom:12px}
.pt{display:flex;gap:12px;align-items:flex-start}
.dot{width:12px;height:12px;border-radius:50%;margin-top:4px;flex:none}
.dot.g{background:#187830}.dot.r{background:#F06000;border-radius:3px}
.ln{width:2px;height:16px;background:#E2DED3;margin:2px 0 2px 5px}
.kk{font-size:10.5px;color:#9A948A;font-weight:800;letter-spacing:.5px}
.vv{font-size:15px;color:#1C2B22;font-weight:600}
.row{display:flex;justify-content:space-between;padding:9px 0;border-top:1px solid #f0ece0;font-size:14.5px}
.k{color:#888}.v{font-weight:600}
.btn{display:block;text-align:center;text-decoration:none;font-weight:800;border-radius:12px;padding:14px;margin-top:10px;font-size:15px}
.btn.wa{background:#25D366;color:#08351d}.btn.gm{background:#187830;color:#fff}
.pie{text-align:center;color:#9A948A;font-size:12px;padding:6px 0 24px}
</style></head><body>
<div class="top"><img src="/logo.png" alt="Tukán"><div><b>Tukán</b><small>Viaje compartido</small></div></div>
<div id="map"></div>
<div class="wrap"><div class="card">__ESTADOBAR____RUTA____FILAS____BOTONES__</div>
<div class="pie">Compartido por seguridad desde la app Tukán</div></div>
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
<script>
var map=L.map('map',{zoomControl:false,attributionControl:false}).setView([1.0,-77.0],12);
L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png',{maxZoom:19}).addTo(map);
var icoG=L.divIcon({html:'<div style="font-size:30px">\U0001F4CD</div>',className:'',iconSize:[30,30],iconAnchor:[8,28]});
var icoR=L.divIcon({html:'<div style="font-size:28px">\U0001F3C1</div>',className:'',iconSize:[28,28],iconAnchor:[6,26]});
var dest=__DEST__,ori=__ORI__,pts=[];
if(ori){L.marker(ori,{icon:icoG}).addTo(map);pts.push(ori);}
if(dest){L.marker(dest,{icon:icoR}).addTo(map);pts.push(dest);}
if(pts.length>=2){map.fitBounds(pts,{padding:[45,45]});}else if(pts.length===1){map.setView(pts[0],15);}
if(ori&&dest){fetch('https://router.project-osrm.org/route/v1/driving/'+ori[1]+','+ori[0]+';'+dest[1]+','+dest[0]+'?overview=full&geometries=geojson').then(function(r){return r.json();}).then(function(j){if(j.routes&&j.routes[0]){var p=j.routes[0].geometry.coordinates.map(function(c){return [c[1],c[0]];});L.polyline(p,{color:'#F06000',weight:6,opacity:.9}).addTo(map);}}).catch(function(){});}
// ---- seguimiento EN VIVO (solo si viene ESTADO_URL)
var ESTADO_URL="__ESTADOURL__", TIPO="__TIPO__";
function icoVeh(){var em=TIPO==='moto'?'\U0001F3CD️':(TIPO==='carro'||TIPO==='auto')?'\U0001F697':'\U0001F690';
  return L.divIcon({html:'<div style="font-size:30px;filter:drop-shadow(0 2px 3px rgba(0,0,0,.45))">'+em+'</div>',className:'',iconSize:[34,34],iconAnchor:[17,17]});}
var veh=null,vehPos=null,anim=null,primero=true;
function moverVeh(la,lo){
  if(veh===null){veh=L.marker([la,lo],{icon:icoVeh(),zIndexOffset:1000}).addTo(map);vehPos=[la,lo];
    if(primero){primero=false;var b=[[la,lo]];if(ori)b.push(ori);if(dest)b.push(dest);map.fitBounds(b,{padding:[55,55],maxZoom:16});}return;}
  var from=vehPos.slice(),to=[la,lo],t0=Date.now(),dur=1100;
  if(anim)cancelAnimationFrame(anim);
  (function paso(){var k=Math.min(1,(Date.now()-t0)/dur);
    var cla=from[0]+(to[0]-from[0])*k,clo=from[1]+(to[1]-from[1])*k;
    veh.setLatLng([cla,clo]);vehPos=[cla,clo];
    if(k<1)anim=requestAnimationFrame(paso);})();
}
function etiqueta(s){
  if(s==='buscando')return '\U0001F50E Buscando conductor…';
  if(s==='aceptada')return '\U0001F697 El conductor va en camino a recoger';
  if(s==='en_sitio')return '\U0001F4CD El conductor llegó al punto de recogida';
  if(s==='en_camino')return '\U0001F9ED En viaje hacia el destino';
  if(s==='finalizada')return '✅ Viaje finalizado';
  if(s==='cancelada')return '❌ Viaje cancelado';
  return 'Siguiendo el viaje…';
}
function pintarEstado(s){var el=document.getElementById('estado');if(!el)return;
  el.innerHTML='<span class="dotlive"></span>'+etiqueta(s);
  if(s==='finalizada'||s==='cancelada'){el.style.background='#F3F0E8';el.style.color='#6b6354';
    el.querySelector('.dotlive').style.animation='none';el.querySelector('.dotlive').style.background='#b7b0a2';}}
function tic(){
  fetch(ESTADO_URL).then(function(r){return r.json();}).then(function(j){
    if(j&&j.estado){pintarEstado(j.estado);
      if(j.clat!=null&&j.clon!=null){moverVeh(j.clat,j.clon);}
      if(j.estado==='finalizada'||j.estado==='cancelada'){return;}}
    setTimeout(tic,5000);
  }).catch(function(){setTimeout(tic,9000);});
}
if(ESTADO_URL){tic();}
</script></body></html>"""
    out = (tpl.replace("__OG__", og).replace("__DESC__", e(desc))
           .replace("__ESTADOBAR__", estado_bar)
           .replace("__RUTA__", ruta).replace("__FILAS__", filas)
           .replace("__BOTONES__", botones)
           .replace("__DEST__", dest_js).replace("__ORI__", ori_js)
           .replace("__ESTADOURL__", estado_url).replace("__TIPO__", tipo))
    return out

@app.get("/viaje/{cid}/estado")
def viaje_estado(cid: int, t: str = "", db: Session = Depends(get_db)):
    """Estado + posicion en vivo del conductor para la pagina publica /viaje.
    Protegido por el token HMAC: sin token valido, 404 (como si no existiera)."""
    if not (t and hmac.compare_digest(t, _token_viaje(cid))):
        raise HTTPException(status_code=404, detail="No encontrado")
    car = db.query(Carrera).filter(Carrera.id == cid).first()
    if not car:
        raise HTTPException(status_code=404, detail="No encontrado")
    cond = db.query(Usuario).filter(Usuario.id == car.conductor_id).first() if car.conductor_id else None
    # la ubicacion del conductor solo se expone mientras el viaje esta activo
    activo = car.estado in ("aceptada", "en_sitio", "en_camino")
    clat = cond.ubic_lat if (cond and activo) else None
    clon = cond.ubic_lon if (cond and activo) else None
    return {
        "estado": car.estado,
        "recogido": car.llego_recogida is not None,
        "clat": clat, "clon": clon,
        "olat": car.origen_lat, "olon": car.origen_lon,
        "dlat": car.destino_lat, "dlon": car.destino_lon,
    }

def generar_codigo_referido(u):
    """Codigo corto y legible para invitar: 4 letras del nombre + id (unico)."""
    base = "".join(ch for ch in (u.nombre or "") if ch.isalpha())[:4].upper() or "TKN"
    return f"{base}{u.id}"

# Codigos que se publican en los grupos de WhatsApp de la comunidad. Mayusculas.
CODIGOS_COMUNIDAD = {
    "CALI20": {"rol": "cliente", "pct": 20, "dias": 7,
               "mensaje": "🎁 ¡Bienvenido! Tienes 20% de descuento en tus carreras durante 7 días."},
    "REDCALI": {"rol": "conductor", "fundador": True,
                "mensaje": "🏅 ¡Eres Conductor Fundador! Usas Tukán gratis durante todo el lanzamiento."},
}

def _validar_nombre(nombre: str) -> str:
    nombre = " ".join((nombre or "").split())
    letras = sum(1 for ch in nombre if ch.isalpha())
    if letras < 3 or "@" in nombre or len(nombre) > 60:
        raise HTTPException(status_code=400, detail="Escribe tu nombre y apellido (sin correo ni números).")
    if any(ch.isdigit() for ch in nombre):
        raise HTTPException(status_code=400, detail="Tu nombre no debe llevar números.")
    return nombre

def _validar_celular(telefono: str) -> str:
    t = "".join(ch for ch in (telefono or "") if ch.isdigit())
    if t.startswith("57") and len(t) == 12:
        t = t[2:]
    if len(t) != 10 or not t.startswith("3"):
        raise HTTPException(status_code=400, detail="Escribe un número de celular válido de 10 dígitos (ej: 3001234567).")
    return t

def _registro_incompleto(u: Usuario) -> bool:
    n = (u.nombre or "").strip()
    t = "".join(ch for ch in (u.telefono or "") if ch.isdigit())
    return (sum(1 for ch in n if ch.isalpha()) < 3 or "@" in n or any(ch.isdigit() for ch in n)
            or len(t) != 10 or not t.startswith("3") or (u.telefono or "").startswith("ELIMINADO-"))

@app.put("/usuarios/{usuario_id}/completar")
def completar_registro(usuario_id: int, nombre: str, telefono: str = None, db: Session = Depends(get_db),
                       actual: Usuario = Depends(usuario_actual)):
    """La persona completa su propio registro (nombre y, si le falta, celular)."""
    exigir_dueño(actual, usuario_id)
    u = db.query(Usuario).filter(Usuario.id == usuario_id).first()
    if not u:
        raise HTTPException(status_code=404, detail="Usuario no encontrado")
    u.nombre = _validar_nombre(nombre)
    if telefono:
        t = _validar_celular(telefono)
        if t != u.telefono and db.query(Usuario).filter(Usuario.telefono == t, Usuario.id != u.id).first():
            raise HTTPException(status_code=400, detail="Ese número ya está registrado en otra cuenta.")
        u.telefono = t
    db.commit()
    return {"ok": True, "nombre": u.nombre, "telefono": u.telefono, "completo": not _registro_incompleto(u)}

@app.post("/admin/incompletos/avisar")
def avisar_incompletos(db: Session = Depends(get_db), admin: Usuario = Depends(solo_admin)):
    """Notificacion a quienes tienen el registro incompleto para que lo completen."""
    gente = [u for u in db.query(Usuario).filter(Usuario.rol.in_(["cliente", "conductor"]), Usuario.activo != "no").all()
             if _registro_incompleto(u)]
    con_token = [u for u in gente if u.push_token]
    mensajes = [push.mensaje(u.push_token, "👋 Completa tu registro en Tukán",
                             "A tu cuenta le falta tu nombre o tu celular. Abre la app y complétalo en un minuto.",
                             {"tipo": "completar_registro"}) for u in con_token]
    limpiar_tokens_muertos(push.enviar(mensajes))
    return {"incompletos": len(gente), "avisados": len(con_token), "sin_notificaciones": len(gente) - len(con_token)}

@app.post("/registro")
def registrar_usuario(request: Request, nombre: str, telefono: str, password: str, municipio: str = "Orito",
                      tipo_vehiculo: str = None, placa: str = None, vehiculo: str = None,
                      codigo: str = None, db: Session = Depends(get_db)):
    """Si viene tipo_vehiculo (moto o carro) se registra como conductor.
    Sin eso queda de cliente. No hay valor por defecto: quien maneja lo declara."""
    # freno anti-spam: nadie crea decenas de cuentas desde la misma IP. Generoso
    # para tolerar un lanzamiento donde varios se registran en la misma red.
    if paso_del_limite(("registro", ip_de(request)), 25, 3600):
        raise HTTPException(status_code=429, detail="Demasiados registros desde aqui. Intenta en un rato.")
    # ---- datos completos y validos: sin esto NO se crea la cuenta ----
    nombre = " ".join((nombre or "").split())
    letras = sum(1 for ch in nombre if ch.isalpha())
    if letras < 3 or "@" in nombre or len(nombre) > 60:
        raise HTTPException(status_code=400, detail="Escribe tu nombre y apellido (sin correo ni números).")
    if sum(1 for ch in nombre if ch.isdigit()) > 0:
        raise HTTPException(status_code=400, detail="Tu nombre no debe llevar números.")
    telefono = _digitos(telefono)
    if telefono.startswith("57") and len(telefono) == 12:
        telefono = telefono[2:]
    if len(telefono) != 10 or not telefono.startswith("3"):
        raise HTTPException(status_code=400, detail="Escribe un número de celular válido de 10 dígitos (ej: 3001234567).")
    if len((password or "").strip()) < 6:
        raise HTTPException(status_code=400, detail="La contraseña debe tener al menos 6 caracteres.")
    if not (municipio or "").strip():
        raise HTTPException(status_code=400, detail="Escoge tu zona (la ciudad donde usarás Tukán).")
    if tipo_vehiculo is not None and len(_digitos(placa or "") + "".join(ch for ch in (placa or "") if ch.isalpha())) < 5:
        raise HTTPException(status_code=400, detail="Escribe la placa de tu vehículo (ej: ABC123).")
    usuario_existe = db.query(Usuario).filter(Usuario.telefono == telefono).first()
    if usuario_existe:
        raise HTTPException(status_code=400, detail="Este telefono ya esta registrado")
    permitidos = vehiculos_de(municipio, db)
    if not permitidos:
        raise HTTPException(status_code=400, detail=f"Todavia no operamos en {municipio}")
    if tipo_vehiculo is not None and tipo_vehiculo not in permitidos:
        raise HTTPException(
            status_code=400,
            detail=f"En {municipio} solo se puede trabajar en {' o '.join(permitidos)}")
    password_hash = pwd_context.hash(password)
    usuario = Usuario(
        nombre=nombre, telefono=telefono, password=password_hash, municipio=municipio,
        rol="conductor" if tipo_vehiculo else "cliente",
        tipo_vehiculo=tipo_vehiculo, placa=placa, vehiculo=vehiculo,
        token=secrets.token_urlsafe(32),   # entra directo, ya autenticado
    )
    db.add(usuario)
    db.commit()
    db.refresh(usuario)
    # referidos: codigo propio + registrar quien lo invito (si vino un codigo valido)
    usuario.codigo_referido = generar_codigo_referido(usuario)
    beneficio = None
    if codigo:
        cod = codigo.strip().upper()
        if cod in CODIGOS_COMUNIDAD:
            # codigo de un grupo de la comunidad: se registra de donde llego y,
            # si le corresponde por su rol, se le da el beneficio
            usuario.referido_por = cod
            regla = CODIGOS_COMUNIDAD[cod]
            if regla["rol"] == usuario.rol:
                if regla.get("pct"):
                    usuario.promo_bienvenida_pct = regla["pct"]
                    usuario.promo_bienvenida_hasta = datetime.now() + timedelta(days=regla["dias"])
                if regla.get("fundador"):
                    usuario.fundador = "si"
                beneficio = regla["mensaje"]
        else:
            ref = db.query(Usuario).filter(Usuario.codigo_referido == cod).first()
            if ref and ref.id != usuario.id:
                usuario.referido_por = ref.codigo_referido
    db.commit()
    return {"id": usuario.id, "nombre": usuario.nombre, "telefono": usuario.telefono,
            "rol": usuario.rol, "restaurante_id": usuario.restaurante_id,
            "municipio": usuario.municipio, "tipo_vehiculo": usuario.tipo_vehiculo,
            "placa": usuario.placa, "vehiculo": usuario.vehiculo, "disponible": usuario.disponible,
            "codigo_referido": usuario.codigo_referido, "token": usuario.token,
            "fundador": usuario.fundador, "beneficio": beneficio}

def vehiculos_de(municipio: str, db: Session):
    """Que vehiculos se permiten en ese pueblo. Lista vacia = municipio desconocido."""
    m = db.query(Municipio).filter(Municipio.nombre == municipio, Municipio.activo == "si").first()
    if not m:
        return []
    return [v.strip() for v in (m.vehiculos or "").split(",") if v.strip()]

def municipio_dict(m: Municipio, db: Session):
    return {
        "nombre": m.nombre,
        "departamento": m.departamento or "Putumayo",
        "vehiculos": vehiculos_de(m.nombre, db),
        "usa_gps": m.usa_gps == "si",
        "activo": m.activo,
        "tarifa_base": m.tarifa_base or 0,
        "valor_km": m.valor_km or 0,
        "tarifa_minima": m.tarifa_minima or 0,
        "centro_lat": m.centro_lat,
        "centro_lon": m.centro_lon,
        "promo": promo_de(m.nombre, db),
        # recargo que aplica AHORA (la app lo vuelve a pedir cada rato)
        "recargo": recargo_actual(m.nombre, db),
        # tarifa propia por vehiculo (ej. moto mas barata que carro). Si un vehiculo
        # no aparece aqui, usa la tarifa general de la ciudad (valor_km / minima)
        "tarifas_vehiculo": {t.vehiculo: {"base": t.base or 0, "valor_km": t.valor_km or 0, "minima": t.minima or 0}
                             for t in db.query(Tarifa).filter(Tarifa.municipio == m.nombre).all() if t.valor_km},
    }

@app.get("/ubicacion/municipio")
def municipio_por_ubicacion(lat: float, lon: float, db: Session = Depends(get_db)):
    """Dice en que pueblo estas segun tu GPS: el centro mas cercano dentro de un
    radio razonable. Asi las opciones (solo carro en Orito, moto+carro en Puerto
    Asis) salen de donde estas, no de donde te registraste."""
    activos = db.query(Municipio).filter(Municipio.activo == "si").all()
    mejor, mejor_km = None, None
    for m in activos:
        if m.centro_lat is None or m.centro_lon is None:
            continue
        km = tarifas.distancia_km(lat, lon, m.centro_lat, m.centro_lon)
        if km is not None and (mejor_km is None or km < mejor_km):
            mejor, mejor_km = m, km
    # 40 km cubre el casco urbano y sus veredas sin confundir un pueblo con otro
    if not mejor or mejor_km > 40:
        raise HTTPException(status_code=404, detail="No pudimos ubicar tu municipio. Selecciónalo manualmente.")
    return municipio_dict(mejor, db)

@app.get("/ubicacion/direccion")
def direccion_de_punto(lat: float, lon: float, municipio: str = None, db: Session = Depends(get_db)):
    """Nombre legible para un pin del mapa: primero un sitio conocido de nuestra
    base a <=120m (ej. 'Gimnasio X'); si no, la nomenclatura via Nominatim
    (OpenStreetMap, gratis). Si nada responde, la app deja su etiqueta generica."""
    q = db.query(Lugar).filter(Lugar.activo == "si", Lugar.lat.isnot(None))
    if municipio:
        q = q.filter(Lugar.municipio == municipio)
    mejor, mejor_km = None, None
    for l in q.all():
        km = tarifas.distancia_km(lat, lon, l.lat, l.lon)
        if km is not None and (mejor_km is None or km < mejor_km):
            mejor, mejor_km = l, km
    if mejor and mejor_km is not None and mejor_km <= 0.12:
        return {"nombre": mejor.nombre, "fuente": "lugar"}
    try:
        import urllib.request as _ur, json as _json
        url = (f"https://nominatim.openstreetmap.org/reverse?lat={lat}&lon={lon}"
               f"&format=jsonv2&zoom=18&accept-language=es")
        req = _ur.Request(url, headers={"User-Agent": "tukan-app/1.0 (ingrobinespana@gmail.com)"})
        with _ur.urlopen(req, timeout=5) as r:
            d = _json.loads(r.read().decode("utf-8"))
        a = d.get("address", {})
        nombre = (d.get("name") or "").strip()
        via = a.get("road") or ""
        numero = a.get("house_number") or ""
        # se amplia lo que sirve de referencia: en pueblo y vereda casi nunca hay
        # nomenclatura, pero si suele haber barrio, caserio o vereda
        barrio = (a.get("neighbourhood") or a.get("suburb") or a.get("quarter")
                  or a.get("residential") or a.get("hamlet") or a.get("village")
                  or a.get("town") or "")
        sitio = a.get("amenity") or a.get("shop") or a.get("building") or ""
        partes = []
        if nombre:
            partes.append(nombre)
        elif sitio:
            partes.append(sitio)
        elif via:
            partes.append(f"{via} # {numero}" if numero else via)
        if barrio and barrio not in partes:
            partes.append(barrio)
        etiqueta = ", ".join(partes[:2]).strip()
        if etiqueta:
            return {"nombre": etiqueta, "fuente": "direccion"}
    except Exception:
        pass
    # ultimo recurso: referenciarlo contra el sitio conocido mas cercano. En zona
    # sin mapear "Cerca de la Alcaldia" le sirve mucho mas al conductor que
    # "Punto marcado en el mapa"
    if mejor and mejor_km is not None and mejor_km <= 1.5:
        cerca = f"Cerca de {mejor.nombre}"
        if mejor_km >= 0.3:
            cerca += f" (~{int(round(mejor_km * 1000, -1))} m)"
        return {"nombre": cerca, "fuente": "cercano"}
    return {"nombre": None, "fuente": None}

@app.get("/municipios")
def obtener_municipios(todos: bool = False, db: Session = Depends(get_db)):
    """La app arma con esto las opciones del registro: en Orito no debe
    aparecer la opcion de moto porque alla todavia no hay mototaxi, y solo
    donde usa_gps esta prendido se pide ubicacion y se sugiere tarifa.
    'todos=1' (panel admin) incluye tambien las ciudades desactivadas."""
    q = db.query(Municipio)
    if not todos:
        q = q.filter(Municipio.activo == "si")
    return [municipio_dict(m, db) for m in q.order_by(Municipio.nombre).all()]

def _con_descuento(valor: int, pct: int) -> int:
    """Aplica % de descuento y redondea a $50 para que quede un numero bonito."""
    neto = (valor or 0) * (100 - pct) / 100.0
    return int(round(neto / 50.0)) * 50

def promo_de(municipio: str, db: Session):
    """Promo de lanzamiento para CARRERAS de pasajeros (NO acarreos). Devuelve
    pct>0 solo si esta activa y aplica a esta ciudad. Nunca lanza error."""
    apagada = {"activa": False, "pct": 0, "texto": ""}
    try:
        if leer_config("promo_activa", db, "no") != "si":
            return apagada
        # red de seguridad: si tiene fecha de vencimiento y ya paso, se apaga sola
        hasta = (leer_config("promo_hasta", db, "") or "").strip()
        if hasta:
            try:
                if datetime.now() > datetime.fromisoformat(hasta):
                    return apagada
            except Exception:
                pass
        pct = int(leer_config("promo_pct", db, "0") or 0)
        if pct <= 0 or pct >= 100:
            return apagada
        ciudad = (leer_config("promo_ciudad", db, "") or "").strip().lower()
        if ciudad and ciudad not in ("todas", "todos") and ciudad != (municipio or "").strip().lower():
            return apagada
        hasta_txt = ""
        if hasta:
            try:
                f = datetime.fromisoformat(hasta) - timedelta(hours=5)   # a hora de Colombia
                meses = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto",
                         "septiembre", "octubre", "noviembre", "diciembre"]
                hasta_txt = f"{f.day} de {meses[f.month - 1]}"
            except Exception:
                pass
        return {"activa": True, "pct": pct, "texto": leer_config("promo_texto", db, ""), "hasta": hasta_txt,
                "tema": leer_config("promo_tema", db, "navidad") or "navidad"}
    except Exception:
        return apagada

def promo_para(municipio: str, usuario, db: Session):
    """La promo que le toca a ESTE cliente: la mayor entre la general de la ciudad y
    su bienvenida personal (codigo CALI20). No se suman."""
    general = promo_de(municipio, db)
    if usuario is not None and usuario.promo_bienvenida_pct and usuario.promo_bienvenida_hasta \
            and usuario.promo_bienvenida_hasta > datetime.now() \
            and usuario.promo_bienvenida_pct > (general["pct"] if general["activa"] else 0):
        return {"activa": True, "pct": int(usuario.promo_bienvenida_pct), "texto": "Bienvenida comunidad"}
    return general

# ---------------- RECARGO POR HORARIO (hora pico y madrugada) ----------------
# Solo sube el precio SUGERIDO de carreras de pasajeros (acarreos no llevan
# sugerido). No se muestra etiqueta: el pasajero ve el precio y ofrece lo que
# quiera. Se lee de Config "recargo_horario" (JSON) para cambiarlo sin desplegar;
# si no existe usa RECARGO_DEFECTO. Apagado general: Config recargo_activo=no.
import json as _json_rec

RECARGO_DEFECTO = {
    "ciudades": ["cali"],
    "franjas": [
        # pico: lunes a viernes que no sean festivo
        {"nombre": "pico", "desde": "06:00", "hasta": "08:30", "dias": "habiles", "km": 400, "minima": 1000},
        {"nombre": "pico", "desde": "17:00", "hasta": "19:30", "dias": "habiles", "km": 400, "minima": 1000},
        # madrugada: todos los dias (cruza la medianoche)
        {"nombre": "madrugada", "desde": "22:00", "hasta": "05:00", "dias": "todos", "km": 500, "minima": 3000},
    ],
    # festivos de Colombia (ese dia no hay hora pico; la madrugada si aplica)
    "festivos": [
        "2026-11-16", "2026-12-08", "2026-12-25",
        "2027-01-01", "2027-01-11", "2027-03-22", "2027-03-25", "2027-03-26", "2027-05-01",
        "2027-05-10", "2027-05-31", "2027-06-07", "2027-07-05", "2027-07-20", "2027-08-07",
        "2027-08-16", "2027-10-18", "2027-11-01", "2027-11-15", "2027-12-08", "2027-12-25",
    ],
}

def ahora_colombia():
    """Hora de Colombia (UTC-5, sin horario de verano). El servidor corre en UTC."""
    return datetime.utcnow() - timedelta(hours=5)

def recargo_config(db: Session):
    try:
        if leer_config("recargo_activo", db, "si") != "si":
            return None
        crudo = (leer_config("recargo_horario", db, "") or "").strip()
        return _json_rec.loads(crudo) if crudo else RECARGO_DEFECTO
    except Exception:
        return RECARGO_DEFECTO

def _min_del_dia(hhmm: str) -> int:
    h, m = hhmm.split(":")
    return int(h) * 60 + int(m)

def recargo_actual(municipio: str, db: Session, ahora: datetime = None):
    """{"nombre","km","minima"} de la franja que aplica ahora en esa ciudad, o None."""
    try:
        cfg = recargo_config(db)
        if not cfg:
            return None
        ciudades = [c.strip().lower() for c in cfg.get("ciudades", [])]
        if (municipio or "").strip().lower() not in ciudades and "todas" not in ciudades:
            return None
        t = ahora or ahora_colombia()
        minuto = t.hour * 60 + t.minute
        habil = t.weekday() < 5 and t.strftime("%Y-%m-%d") not in cfg.get("festivos", [])
        for f in cfg.get("franjas", []):
            if f.get("dias") == "habiles" and not habil:
                continue
            ini, fin = _min_del_dia(f["desde"]), _min_del_dia(f["hasta"])
            dentro = (ini <= minuto < fin) if ini < fin else (minuto >= ini or minuto < fin)
            if dentro:
                return {"nombre": f.get("nombre", ""), "km": int(f.get("km", 0)), "minima": int(f.get("minima", 0))}
        return None
    except Exception:
        return None

def _calcular_con_recargo(km, base, valor_km, minima, rec):
    if rec:
        valor_km = (valor_km or 0) + rec["km"]
        minima = (minima or 0) + rec["minima"]
    return tarifas.calcular_tarifa(km, base, valor_km, minima)

@app.get("/recargo")
def ver_recargo(municipio: str = "Cali", db: Session = Depends(get_db)):
    """Que recargo aplica ahora (para revisar). Publico: no expone nada sensible."""
    return {"hora_colombia": ahora_colombia().strftime("%Y-%m-%d %H:%M"),
            "recargo": recargo_actual(municipio, db), "config": recargo_config(db)}

@app.put("/recargo")
def configurar_recargo(clave: str, activa: str = None, horario: str = None, db: Session = Depends(get_db)):
    """Prender/apagar (activa=si|no) o reemplazar el horario (JSON con la forma de
    RECARGO_DEFECTO; horario=defecto vuelve al de fabrica)."""
    if not os.environ.get("RESPALDO_CLAVE") or not hmac.compare_digest(clave, os.environ["RESPALDO_CLAVE"]):
        raise HTTPException(status_code=403, detail="Clave incorrecta")
    def poner(k, v):
        fila = db.query(Config).filter(Config.clave == k).first()
        if fila:
            fila.valor = v
        else:
            db.add(Config(clave=k, valor=v))
    if activa is not None:
        if activa not in ("si", "no"):
            raise HTTPException(status_code=400, detail="activa: si o no")
        poner("recargo_activo", activa)
    if horario is not None:
        if horario == "defecto":
            poner("recargo_horario", "")
        else:
            try:
                cfg = _json_rec.loads(horario)
                for f in cfg["franjas"]:
                    _min_del_dia(f["desde"]); _min_del_dia(f["hasta"]); int(f["km"]); int(f["minima"])
            except Exception:
                raise HTTPException(status_code=400, detail="horario: JSON invalido")
            poner("recargo_horario", _json_rec.dumps(cfg))
    db.commit()
    return ver_recargo("Cali", db)

def tarifa_sugerida(municipio: str, vehiculo: str, km, db: Session):
    """Sugerencia segun el pueblo, el vehiculo y los km. Solo orienta la oferta
    del cliente; el precio de verdad lo negocian las partes."""
    if km is None:
        return None
    # los ACARREOS no llevan sugerido: el precio lo pone el cliente y el
    # transportador contraoferta (depende del peso, la ayuda, los pisos, etc.)
    if vehiculo in VEHICULOS_CARGA:
        return None
    # hora pico / madrugada: suma $/km y a la minima (sin etiqueta al pasajero)
    rec = recargo_actual(municipio, db)
    # 1) tarifa por VEHICULO si el pueblo la tiene (donde moto y carro cobran distinto)
    if vehiculo:
        t = db.query(Tarifa).filter(Tarifa.municipio == municipio, Tarifa.vehiculo == vehiculo).first()
        if t and t.valor_km:
            return _calcular_con_recargo(km, t.base, t.valor_km, t.minima, rec)
    # 2) respaldo: el $/km de la CIUDAD (el que se pone en el panel "Ciudades").
    #    Asi Pasto/Cali/Florencia muestran el sugerido al cliente aunque no tengan
    #    tarifa por vehiculo; es la MISMA base que ve el conductor (solo viaje aca).
    m = db.query(Municipio).filter(Municipio.nombre == municipio).first()
    if m and m.valor_km:
        return _calcular_con_recargo(km, m.tarifa_base or 0, m.valor_km, m.tarifa_minima or 0, rec)
    return None

@app.get("/tarifa")
def estimar_tarifa(municipio: str, vehiculo: str, origen_lat: float, origen_lon: float,
                   destino_lat: float, destino_lon: float, usuario_id: int = None,
                   db: Session = Depends(get_db)):
    """Lo que la app muestra para orientar la oferta: 'son ~3.2 km, en carro la
    gente suele pagar ~$8.000'. El cliente ofrece lo que quiera desde ahi."""
    m = db.query(Municipio).filter(Municipio.nombre == municipio).first()
    if not m:
        raise HTTPException(status_code=404, detail="Municipio no encontrado")
    km = tarifas.distancia_por_calle(origen_lat, origen_lon, destino_lat, destino_lon)
    sug = tarifa_sugerida(municipio, vehiculo, km, db)
    cliente = db.query(Usuario).filter(Usuario.id == usuario_id).first() if usuario_id else None
    prom = promo_para(municipio, cliente, db)
    # el descuento SOLO aplica a carreras de pasajeros (las de carga no llevan sugerido)
    aplica = bool(prom["activa"]) and sug is not None and vehiculo not in VEHICULOS_CARGA
    sug_promo = _con_descuento(sug, prom["pct"]) if aplica else None
    return {
        "distancia_km": km,
        # lo que el cliente ofrece por defecto: con descuento si hay promo
        "tarifa_sugerida": sug_promo if aplica else sug,
        "tarifa_normal": sug,                 # precio sin descuento (para tacharlo)
        "promo": {**prom, "aplica": aplica},
        "es_sugerencia": True,
    }

@app.get("/tarifas")
def listar_tarifas(db: Session = Depends(get_db)):
    return [{"id": t.id, "municipio": t.municipio, "vehiculo": t.vehiculo,
             "base": t.base, "valor_km": t.valor_km, "minima": t.minima}
            for t in db.query(Tarifa).order_by(Tarifa.municipio, Tarifa.vehiculo).all()]

@app.put("/tarifas/{tarifa_id}")
def actualizar_tarifa(tarifa_id: int, base: int = None, valor_km: int = None,
                      minima: int = None, db: Session = Depends(get_db),
                      admin: Usuario = Depends(solo_admin)):
    t = db.query(Tarifa).filter(Tarifa.id == tarifa_id).first()
    if not t:
        raise HTTPException(status_code=404, detail="Tarifa no encontrada")
    for campo, valor in (("base", base), ("valor_km", valor_km), ("minima", minima)):
        if valor is not None:
            if valor < 0:
                raise HTTPException(status_code=400, detail=f"{campo} no puede ser negativo")
            setattr(t, campo, valor)
    db.commit()
    return {"id": t.id, "municipio": t.municipio, "vehiculo": t.vehiculo,
            "base": t.base, "valor_km": t.valor_km, "minima": t.minima}

@app.post("/municipios")
def crear_municipio(nombre: str, centro_lat: float, centro_lon: float,
                    departamento: str = "Putumayo", vehiculos: str = "carro", usa_gps: str = "si",
                    tarifa_base: int = 0, valor_km: int = 0, tarifa_minima: int = 0,
                    db: Session = Depends(get_db), admin: Usuario = Depends(solo_admin)):
    """Abre una ciudad nueva (expansion): nombre + centro en el mapa + que
    vehiculos se permiten. Con esto la app ya la detecta por GPS y los conductores
    de ahi ven sus carreras. Sin recompilar nada."""
    nombre = (nombre or "").strip()
    if len(nombre) < 3:
        raise HTTPException(status_code=400, detail="El nombre de la ciudad es muy corto")
    if db.query(Municipio).filter(func.lower(Municipio.nombre) == nombre.lower()).first():
        raise HTTPException(status_code=400, detail="Ya existe una ciudad con ese nombre")
    pedidos = [v.strip() for v in vehiculos.split(",") if v.strip()]
    if not pedidos or any(v not in VEHICULOS_VALIDOS for v in pedidos):
        raise HTTPException(status_code=400, detail=f"Vehiculos validos: {', '.join(VEHICULOS_VALIDOS)}")
    if usa_gps not in ("si", "no"):
        raise HTTPException(status_code=400, detail="usa_gps solo acepta si o no")
    m = Municipio(nombre=nombre, departamento=(departamento or "Putumayo").strip(),
                  vehiculos=",".join(pedidos), activo="si", usa_gps=usa_gps,
                  tarifa_base=max(0, tarifa_base or 0), valor_km=max(0, valor_km or 0),
                  tarifa_minima=max(0, tarifa_minima or 0),
                  centro_lat=centro_lat, centro_lon=centro_lon)
    db.add(m)
    db.commit()
    db.refresh(m)
    return {**municipio_dict(m, db), "activo": m.activo}

@app.put("/municipios/{nombre}")
def actualizar_municipio(nombre: str, vehiculos: str = None, activo: str = None,
                         usa_gps: str = None, tarifa_base: int = None, valor_km: int = None,
                         tarifa_minima: int = None, departamento: str = None,
                         centro_lat: float = None, centro_lon: float = None,
                         db: Session = Depends(get_db),
                         admin: Usuario = Depends(solo_admin)):
    """Para habilitar moto en Orito cuando lleguen, prender el GPS en un pueblo,
    ajustar tarifas o corregir el CENTRO de la ciudad — todo sin publicar app nueva."""
    m = db.query(Municipio).filter(Municipio.nombre == nombre).first()
    if not m:
        raise HTTPException(status_code=404, detail="Municipio no encontrado")
    if centro_lat is not None and centro_lon is not None:
        m.centro_lat, m.centro_lon = centro_lat, centro_lon
    if departamento is not None and departamento.strip():
        m.departamento = departamento.strip()
    if vehiculos is not None:
        pedidos = [v.strip() for v in vehiculos.split(",") if v.strip()]
        if not pedidos or any(v not in VEHICULOS_VALIDOS for v in pedidos):
            raise HTTPException(status_code=400, detail=f"Vehiculos validos: {', '.join(VEHICULOS_VALIDOS)}")
        m.vehiculos = ",".join(pedidos)
    for campo, valor in (("activo", activo), ("usa_gps", usa_gps)):
        if valor is not None:
            if valor not in ("si", "no"):
                raise HTTPException(status_code=400, detail=f"{campo} solo acepta si o no")
            setattr(m, campo, valor)
    for campo, valor in (("tarifa_base", tarifa_base), ("valor_km", valor_km), ("tarifa_minima", tarifa_minima)):
        if valor is not None:
            if valor < 0:
                raise HTTPException(status_code=400, detail=f"{campo} no puede ser negativo")
            setattr(m, campo, valor)
    db.commit()
    db.refresh(m)
    return {**municipio_dict(m, db), "activo": m.activo}

@app.get("/admin/demanda")
def demanda_por_zona(db: Session = Depends(get_db), admin: Usuario = Depends(solo_admin)):
    """Demanda por CIUDAD y DEPARTAMENTO: carreras, clientes y conductores de cada
    zona, para ver donde esta pegando la app y donde reforzar conductores."""
    ahora = datetime.now()
    hoy0 = ahora.replace(hour=0, minute=0, second=0, microsecond=0)
    semana0 = hoy0 - timedelta(days=hoy0.weekday())
    munis = db.query(Municipio).order_by(Municipio.nombre).all()
    carreras = db.query(Carrera).all()
    usuarios = db.query(Usuario).all()
    activos = ("buscando", "aceptada", "en_sitio", "en_camino")
    ciudades = []
    for m in munis:
        cs = [c for c in carreras if (c.municipio or "Orito") == m.nombre]
        cli = [u for u in usuarios if u.rol == "cliente" and (u.municipio or "Orito") == m.nombre]
        con = [u for u in usuarios if u.rol == "conductor" and (u.municipio or "Orito") == m.nombre]
        ciudades.append({
            "nombre": m.nombre,
            "departamento": m.departamento or "Putumayo",
            "activo": m.activo,
            "carreras_total": len(cs),
            "carreras_finalizadas": sum(1 for c in cs if c.estado == "finalizada"),
            "carreras_hoy": sum(1 for c in cs if c.fecha and c.fecha >= hoy0),
            "carreras_semana": sum(1 for c in cs if c.fecha and c.fecha >= semana0),
            "en_curso": sum(1 for c in cs if c.estado in activos),
            "clientes": len(cli),
            "conductores": len(con),
            "conductores_disponibles": sum(1 for u in con if u.disponible == "si"),
        })
    deptos = {}
    for c in ciudades:
        d = deptos.setdefault(c["departamento"], {
            "departamento": c["departamento"], "ciudades": 0,
            "carreras_total": 0, "carreras_hoy": 0, "clientes": 0, "conductores": 0})
        d["ciudades"] += 1
        for k in ("carreras_total", "carreras_hoy", "clientes", "conductores"):
            d[k] += c[k]
    return {"ciudades": ciudades,
            "departamentos": sorted(deptos.values(), key=lambda x: -x["carreras_total"])}

@app.get("/admin/usuarios")
def buscar_usuarios(buscar: str = "", rol: str = "", db: Session = Depends(get_db), admin: Usuario = Depends(solo_admin)):
    """Busca/lista usuarios, para soporte y para el registro. Con 'rol' filtra
    (cliente/conductor); con 'buscar' filtra por telefono o nombre. Sin buscar,
    devuelve los mas recientes de ese rol."""
    q = (buscar or "").strip()
    consulta = db.query(Usuario)
    if rol in ("cliente", "conductor", "domiciliario"):
        consulta = consulta.filter(Usuario.rol == rol)
    if q:
        like = f"%{q}%"
        consulta = consulta.filter(Usuario.telefono.ilike(like) | Usuario.nombre.ilike(like))
    usuarios = consulta.order_by(Usuario.id.desc()).limit(200).all()
    activos = ["buscando", "aceptada", "en_sitio", "en_camino"]
    salida = []
    for u in usuarios:
        salida.append({
            "id": u.id, "nombre": u.nombre, "telefono": u.telefono, "rol": u.rol,
            "municipio": u.municipio, "calificacion": u.calificacion, "disponible": u.disponible,
            "activo": u.activo or "si", "fundador": u.fundador or "no",
            "carreras_cliente": db.query(Carrera).filter(Carrera.cliente_id == u.id).count(),
            "carreras_conductor": db.query(Carrera).filter(Carrera.conductor_id == u.id).count(),
            "activas": db.query(Carrera).filter(
                ((Carrera.cliente_id == u.id) | (Carrera.conductor_id == u.id)),
                Carrera.estado.in_(activos)).count(),
        })
    return salida

@app.delete("/admin/usuarios/{usuario_id}")
def eliminar_usuario(usuario_id: int, db: Session = Depends(get_db), admin: Usuario = Depends(solo_admin)):
    """Elimina o bloquea un usuario (reportado, retirado o mal registrado). Si NO
    tiene carreras (registro malo/duplicado) se borra de verdad. Si tiene
    historial, se BLOQUEA (no entra ni trabaja) pero se conservan sus carreras
    para las estadisticas. Nunca se elimina a un admin."""
    u = db.query(Usuario).filter(Usuario.id == usuario_id).first()
    if not u:
        raise HTTPException(status_code=404, detail="Usuario no encontrado")
    if u.rol == "admin":
        raise HTTPException(status_code=400, detail="No se puede eliminar una cuenta de administrador")
    # cancela lo que tenga en curso para no dejar carreras colgadas
    db.query(Carrera).filter(
        ((Carrera.cliente_id == u.id) | (Carrera.conductor_id == u.id)),
        Carrera.estado.in_(["buscando", "aceptada", "en_sitio", "en_camino"])
    ).update({"estado": "cancelada"}, synchronize_session=False)
    tiene_historial = db.query(Carrera).filter(
        (Carrera.cliente_id == u.id) | (Carrera.conductor_id == u.id)).count() > 0
    nombre = u.nombre
    if tiene_historial:
        u.activo = "no"
        u.disponible = "no"
        u.push_token = None
        u.token = None   # lo saca de cualquier sesion abierta
        modo = "bloqueado"
    else:
        db.delete(u)
        modo = "eliminado"
    db.commit()
    return {"ok": True, "modo": modo, "nombre": nombre}

@app.put("/admin/usuarios/{usuario_id}/fundador")
def marcar_fundador(usuario_id: int, valor: str, db: Session = Depends(get_db), admin: Usuario = Depends(solo_admin)):
    """Marca o quita la insignia 🏅 Conductor Fundador (los primeros de la Red)."""
    if valor not in ("si", "no"):
        raise HTTPException(status_code=400, detail="valor: si o no")
    u = db.query(Usuario).filter(Usuario.id == usuario_id).first()
    if not u:
        raise HTTPException(status_code=404, detail="Usuario no encontrado")
    if u.rol != "conductor":
        raise HTTPException(status_code=400, detail="Solo los conductores pueden ser fundadores")
    u.fundador = valor
    db.commit()
    return {"ok": True, "nombre": u.nombre, "fundador": u.fundador}

@app.post("/admin/usuarios/{usuario_id}/reactivar")
def reactivar_usuario(usuario_id: int, db: Session = Depends(get_db), admin: Usuario = Depends(solo_admin)):
    """Reactiva una cuenta que se habia bloqueado."""
    u = db.query(Usuario).filter(Usuario.id == usuario_id).first()
    if not u:
        raise HTTPException(status_code=404, detail="Usuario no encontrado")
    u.activo = "si"
    db.commit()
    limpiar_limite(("login", u.telefono))
    return {"ok": True, "nombre": u.nombre}

@app.delete("/usuarios/{usuario_id}")
def eliminar_mi_cuenta(usuario_id: int, db: Session = Depends(get_db),
                       actual: Usuario = Depends(usuario_actual)):
    """Habeas Data (Ley 1581): el usuario borra SU PROPIA cuenta y sus datos
    personales. Sin historial -> se elimina por completo. Con historial -> se
    ANONIMIZA (se borran nombre, telefono, fotos, vehiculo, lugares y claves) y se
    bloquea, conservando solo el registro anonimo para las estadisticas agregadas."""
    exigir_dueño(actual, usuario_id)
    u = db.query(Usuario).filter(Usuario.id == usuario_id).first()
    if not u:
        raise HTTPException(status_code=404, detail="Usuario no encontrado")
    if u.rol == "admin":
        raise HTTPException(status_code=400, detail="Una cuenta de administrador no se elimina desde la app")
    # cancela lo que tenga en curso para no dejar viajes colgados
    db.query(Carrera).filter(
        ((Carrera.cliente_id == u.id) | (Carrera.conductor_id == u.id)),
        Carrera.estado.in_(["buscando", "aceptada", "en_sitio", "en_camino"])
    ).update({"estado": "cancelada"}, synchronize_session=False)
    db.query(Expreso).filter(
        ((Expreso.cliente_id == u.id) | (Expreso.conductor_id == u.id)),
        Expreso.estado.in_(["buscando", "aceptado", "en_camino"])
    ).update({"estado": "cancelado"}, synchronize_session=False)
    # sus lugares guardados (casa/trabajo) son datos personales: se borran
    try:
        db.query(LugarGuardado).filter(LugarGuardado.usuario_id == u.id).delete(synchronize_session=False)
    except Exception:
        pass
    tiene_historial = (
        db.query(Carrera).filter((Carrera.cliente_id == u.id) | (Carrera.conductor_id == u.id)).count() > 0 or
        db.query(Expreso).filter((Expreso.cliente_id == u.id) | (Expreso.conductor_id == u.id)).count() > 0
    )
    if tiene_historial:
        _anonimizar_usuario(u)
        modo = "anonimizado"
    else:
        db.delete(u)
        modo = "eliminado"
    db.commit()
    return {"ok": True, "modo": modo}

def _anonimizar_usuario(u: Usuario):
    """Borra los datos personales y LIBERA el telefono (se puede volver a registrar).
    El registro anonimo queda solo para las estadisticas de carreras."""
    u.nombre = "Cuenta eliminada"
    u.telefono = f"ELIMINADO-{u.id}"      # unico, ya no es un telefono real
    u.password = pwd_context.hash(secrets.token_urlsafe(24))   # clave inservible
    u.token = None
    u.push_token = None
    u.placa = None
    u.vehiculo = None
    u.veh_color = None
    u.veh_modelo = None
    for campo in ("foto_conductor", "foto_vehiculo", "foto_tarjeta", "foto_licencia", "foto_cedula", "foto_soat", "foto_perfil"):
        if hasattr(u, campo):
            setattr(u, campo, None)
    u.activo = "no"
    u.disponible = "no"

def _cancelar_en_curso(u: Usuario, db: Session):
    db.query(Carrera).filter(
        ((Carrera.cliente_id == u.id) | (Carrera.conductor_id == u.id)),
        Carrera.estado.in_(["buscando", "aceptada", "en_sitio", "en_camino"])
    ).update({"estado": "cancelada"}, synchronize_session=False)
    db.query(Expreso).filter(
        ((Expreso.cliente_id == u.id) | (Expreso.conductor_id == u.id)),
        Expreso.estado.in_(["buscando", "aceptado", "en_camino"])
    ).update({"estado": "cancelado"}, synchronize_session=False)

@app.delete("/admin/usuarios/{usuario_id}/raiz")
def eliminar_usuario_de_raiz(usuario_id: int, db: Session = Depends(get_db), admin: Usuario = Depends(solo_admin)):
    """Soporte: elimina a la persona DE RAIZ. Sin historial se borra; con historial
    se anonimiza (igual que cuando el usuario borra su cuenta): sus datos se van y
    su NUMERO QUEDA LIBRE para registrarse de nuevo. Nunca a un admin."""
    u = db.query(Usuario).filter(Usuario.id == usuario_id).first()
    if not u:
        raise HTTPException(status_code=404, detail="Usuario no encontrado")
    if u.rol == "admin":
        raise HTTPException(status_code=400, detail="No se puede eliminar una cuenta de administrador")
    nombre, tel = u.nombre, u.telefono
    _cancelar_en_curso(u, db)
    try:
        db.query(LugarGuardado).filter(LugarGuardado.usuario_id == u.id).delete(synchronize_session=False)
    except Exception:
        pass
    tiene_historial = (
        db.query(Carrera).filter((Carrera.cliente_id == u.id) | (Carrera.conductor_id == u.id)).count() > 0 or
        db.query(Expreso).filter((Expreso.cliente_id == u.id) | (Expreso.conductor_id == u.id)).count() > 0)
    if tiene_historial:
        _anonimizar_usuario(u)
        modo = "anonimizado"
    else:
        db.delete(u)
        modo = "eliminado"
    db.commit()
    limpiar_limite(("login", tel))
    return {"ok": True, "modo": modo, "nombre": nombre, "telefono_liberado": tel}

@app.post("/admin/usuarios/{usuario_id}/clave")
def restablecer_clave(usuario_id: int, db: Session = Depends(get_db), admin: Usuario = Depends(solo_admin)):
    """Soporte "olvide mi contraseña": le pone una clave TEMPORAL de 6 numeros,
    reactiva la cuenta y le quita el bloqueo por intentos. El admin se la manda por
    WhatsApp; la persona entra y la cambia en Configuracion."""
    u = db.query(Usuario).filter(Usuario.id == usuario_id).first()
    if not u:
        raise HTTPException(status_code=404, detail="Usuario no encontrado")
    if u.rol == "admin":
        raise HTTPException(status_code=400, detail="La clave del administrador no se cambia desde aqui")
    if (u.telefono or "").startswith("ELIMINADO-"):
        raise HTTPException(status_code=400, detail="Esa cuenta fue eliminada: la persona debe registrarse de nuevo")
    temporal = "".join(secrets.choice("0123456789") for _ in range(6))
    u.password = pwd_context.hash(temporal)
    u.activo = "si"
    u.token = None          # cierra cualquier sesion vieja
    db.commit()
    limpiar_limite(("login", u.telefono))
    return {"ok": True, "nombre": u.nombre, "telefono": u.telefono, "clave_temporal": temporal}

@app.put("/usuarios/{usuario_id}/clave")
def cambiar_mi_clave(usuario_id: int, actual: str, nueva: str, db: Session = Depends(get_db),
                     yo: Usuario = Depends(usuario_actual)):
    """El usuario cambia su contraseña (por ejemplo la temporal que le dio soporte)."""
    exigir_dueño(yo, usuario_id)
    u = db.query(Usuario).filter(Usuario.id == usuario_id).first()
    if not u or not pwd_context.verify(actual, u.password):
        raise HTTPException(status_code=400, detail="La contraseña actual no es correcta")
    nueva = (nueva or "").strip()
    if len(nueva) < 6:
        raise HTTPException(status_code=400, detail="La nueva contraseña debe tener al menos 6 caracteres")
    u.password = pwd_context.hash(nueva)
    db.commit()
    return {"ok": True}

@app.post("/login")
def login(telefono: str, password: str, db: Session = Depends(get_db)):
    # anti-fuerza-bruta: se limita por telefono (no por IP, que la comparte medio
    # pueblo). Nadie adivina una contraseña a punta de miles de intentos.
    clave = ("login", telefono)
    if paso_del_limite(clave, 10, 900):
        raise HTTPException(status_code=429, detail="Demasiados intentos. Espera unos minutos e intenta de nuevo.")
    usuario = db.query(Usuario).filter(Usuario.telefono == telefono).first()
    if not usuario:
        # tolerante: con +57, espacios o guiones igual encuentra la cuenta (ultimos 10 digitos)
        dig = "".join(ch for ch in (telefono or "") if ch.isdigit())[-10:]
        if len(dig) == 10:
            usuario = next((x for x in db.query(Usuario).filter(Usuario.telefono.like(f"%{dig[-4:]}")).all()
                            if "".join(ch for ch in (x.telefono or "") if ch.isdigit())[-10:] == dig), None)
    def _clave_ok(u):
        if pwd_context.verify(password, u.password):
            return True
        # espacio de mas al final (teclado del celular): se perdona
        return bool(password) and password.strip() != password and pwd_context.verify(password.strip(), u.password)
    if not usuario or not _clave_ok(usuario):
        raise HTTPException(status_code=400, detail="Telefono o contraseña incorrectos")
    if usuario.activo == "no":
        raise HTTPException(status_code=403, detail="Tu cuenta está desactivada. Comunícate con el soporte.")
    limpiar_limite(clave)   # entro bien: se le perdonan los intentos previos
    # llave de sesion nueva en cada entrada: si alguien se quedo con la vieja,
    # deja de servirle apenas el dueño vuelve a entrar
    usuario.token = secrets.token_urlsafe(32)
    db.commit()
    return {"id": usuario.id, "nombre": usuario.nombre, "telefono": usuario.telefono, "rol": usuario.rol,
            "restaurante_id": usuario.restaurante_id, "placa": usuario.placa,
            "vehiculo": usuario.vehiculo, "disponible": usuario.disponible,
            "municipio": usuario.municipio, "tipo_vehiculo": usuario.tipo_vehiculo,
            "token": usuario.token, "fundador": usuario.fundador, "foto_perfil": usuario.foto_perfil}

# ===================== FASE 2 — Login por codigo (OTP) =====================
# ADITIVO e INERTE. No toca /login ni /registro. Si no hay proveedor de
# SMS/WhatsApp en variables de entorno, /auth/otp/estado da activo:false y
# enviar/verificar responden 503. Se "prende" poniendo las llaves del proveedor.
def _otp_proveedor():
    if os.environ.get("TWILIO_ACCOUNT_SID") and os.environ.get("TWILIO_AUTH_TOKEN") and os.environ.get("TWILIO_FROM"):
        return "twilio"
    if os.environ.get("WHATSAPP_TOKEN") and os.environ.get("WHATSAPP_PHONE_ID"):
        return "whatsapp"
    if os.environ.get("OTP_DEV") == "1":   # SOLO pruebas locales: el codigo va al log
        return "dev"
    return None

def _dict_sesion(u: Usuario):
    """La MISMA sesion que devuelve /login (para que el OTP entre igual)."""
    return {"id": u.id, "nombre": u.nombre, "telefono": u.telefono, "rol": u.rol,
            "restaurante_id": u.restaurante_id, "placa": u.placa, "vehiculo": u.vehiculo,
            "disponible": u.disponible, "municipio": u.municipio,
            "tipo_vehiculo": u.tipo_vehiculo, "token": u.token, "fundador": u.fundador, "foto_perfil": u.foto_perfil}

def _otp_norm(telefono: str):
    return "".join(ch for ch in (telefono or "") if ch.isdigit() or ch == "+")

def _otp_e164(telefono: str):
    """Para el envio: sin indicativo asume Colombia (+57)."""
    t = _otp_norm(telefono)
    if t.startswith("+"):
        return t
    t = t.lstrip("0")
    return f"+57{t}" if len(t) == 10 else f"+{t}"

def _token_registro(telefono: str):
    """Token de un solo uso que certifica 'este numero ya verifico por OTP'."""
    clave = (os.environ.get("SECRET_KEY") or os.environ.get("RESPALDO_CLAVE") or "tukan-otp").encode()
    ts = str(int(datetime.now().timestamp()))
    firma = hmac.new(clave, f"{_otp_norm(telefono)}|{ts}".encode(), hashlib.sha256).hexdigest()[:24]
    return f"{ts}.{firma}"

def verificar_token_registro(telefono: str, token: str, max_seg: int = 1800):
    """Lo usara el registro-por-OTP cuando se construya la app (aun no se llama)."""
    try:
        ts, firma = (token or "").split(".")
        clave = (os.environ.get("SECRET_KEY") or os.environ.get("RESPALDO_CLAVE") or "tukan-otp").encode()
        esperada = hmac.new(clave, f"{_otp_norm(telefono)}|{ts}".encode(), hashlib.sha256).hexdigest()[:24]
        return hmac.compare_digest(firma, esperada) and (datetime.now().timestamp() - int(ts)) <= max_seg
    except Exception:
        return False

def _enviar_codigo_otp(telefono: str, codigo: str) -> bool:
    prov = _otp_proveedor()
    if prov == "dev":
        logging.info(f"[OTP DEV] codigo para {telefono}: {codigo}")
        return True
    msg = f"Tu codigo Tukan es {codigo}. Vence en 10 minutos. No lo compartas."
    if prov == "twilio":
        try:
            import urllib.request as _ur, urllib.parse as _up, base64 as _b64
            sid = os.environ["TWILIO_ACCOUNT_SID"]; tok = os.environ["TWILIO_AUTH_TOKEN"]
            data = _up.urlencode({"To": _otp_e164(telefono), "From": os.environ["TWILIO_FROM"], "Body": msg}).encode()
            req = _ur.Request(f"https://api.twilio.com/2010-04-01/Accounts/{sid}/Messages.json", data=data)
            req.add_header("Authorization", "Basic " + _b64.b64encode(f"{sid}:{tok}".encode()).decode())
            _ur.urlopen(req, timeout=10)
            return True
        except Exception as e:
            logging.warning(f"OTP twilio fallo: {e}"); return False
    if prov == "whatsapp":
        try:
            import urllib.request as _ur, json as _json
            tok = os.environ["WHATSAPP_TOKEN"]; pid = os.environ["WHATSAPP_PHONE_ID"]
            # OJO: WhatsApp Cloud API exige PLANTILLA aprobada para iniciar la conversacion.
            # Al activar, cambiar a type:"template"; aqui va la estructura base.
            payload = {"messaging_product": "whatsapp", "to": _otp_norm(telefono).lstrip("+"),
                       "type": "text", "text": {"body": msg}}
            req = _ur.Request(f"https://graph.facebook.com/v18.0/{pid}/messages",
                              data=_json.dumps(payload).encode(),
                              headers={"Authorization": f"Bearer {tok}", "Content-Type": "application/json"})
            _ur.urlopen(req, timeout=10)
            return True
        except Exception as e:
            logging.warning(f"OTP whatsapp fallo: {e}"); return False
    return False

@app.get("/auth/otp/estado")
def otp_estado():
    """La app lo consulta al abrir Login: si es false, todo sigue igual (solo clave)."""
    return {"activo": _otp_proveedor() is not None}

@app.post("/auth/otp/enviar")
def otp_enviar(request: Request, telefono: str, db: Session = Depends(get_db)):
    if _otp_proveedor() is None:
        raise HTTPException(status_code=503, detail="Canal de verificacion no configurado")
    tel = _otp_norm(telefono)
    if len(tel.lstrip("+")) < 7:
        raise HTTPException(status_code=400, detail="Numero invalido")
    # anti-abuso y anti-gasto: por numero y por IP
    if paso_del_limite(("otp_num", tel), 3, 900):
        raise HTTPException(status_code=429, detail="Demasiados codigos. Espera unos minutos.")
    if paso_del_limite(("otp_ip", ip_de(request)), 20, 900):
        raise HTTPException(status_code=429, detail="Demasiados intentos. Espera unos minutos.")
    codigo = f"{secrets.randbelow(1000000):06d}"
    db.query(CodigoVerificacion).filter(CodigoVerificacion.telefono == tel,
                                         CodigoVerificacion.usado == "no").update({"usado": "si"})
    cv = CodigoVerificacion(telefono=tel, codigo_hash=pwd_context.hash(codigo),
                            expira=datetime.now() + timedelta(minutes=10), intentos=0, usado="no")
    db.add(cv); db.commit()
    if not _enviar_codigo_otp(tel, codigo):
        raise HTTPException(status_code=502, detail="No pudimos enviar el codigo, intenta de nuevo")
    return {"ok": True}

@app.post("/auth/otp/verificar")
def otp_verificar(telefono: str, codigo: str, db: Session = Depends(get_db)):
    if _otp_proveedor() is None:
        raise HTTPException(status_code=503, detail="Canal de verificacion no configurado")
    tel = _otp_norm(telefono); cod = (codigo or "").strip()
    cv = db.query(CodigoVerificacion).filter(CodigoVerificacion.telefono == tel,
                                             CodigoVerificacion.usado == "no").order_by(CodigoVerificacion.id.desc()).first()
    invalido = HTTPException(status_code=400, detail="Codigo incorrecto o vencido")
    if not cv or cv.expira < datetime.now() or (cv.intentos or 0) >= 5:
        raise invalido
    if not pwd_context.verify(cod, cv.codigo_hash):
        cv.intentos = (cv.intentos or 0) + 1; db.commit()
        raise invalido
    cv.usado = "si"; db.commit()
    u = db.query(Usuario).filter(Usuario.telefono == tel).first()
    if u:
        if u.activo == "no":
            raise HTTPException(status_code=403, detail="Tu cuenta está desactivada. Comunícate con el soporte.")
        u.token = secrets.token_urlsafe(32); db.commit()   # rota la sesion, igual que /login
        return {"nuevo": False, **_dict_sesion(u)}
    # numero verificado sin cuenta -> token de un solo uso para completar el registro
    return {"nuevo": True, "telefono": tel, "token_registro": _token_registro(tel)}

@app.get("/restaurantes")
def obtener_restaurantes(db: Session = Depends(get_db)):
    return db.query(Restaurante).all()

@app.post("/restaurantes")
def crear_restaurante(nombre: str, categoria: str, calificacion: float, tiempo: str, domicilio: int, db: Session = Depends(get_db)):
    restaurante = Restaurante(nombre=nombre, categoria=categoria, calificacion=calificacion, tiempo=tiempo, domicilio=domicilio)
    db.add(restaurante)
    db.commit()
    db.refresh(restaurante)
    return restaurante

@app.delete("/restaurantes/{restaurante_id}")
def eliminar_restaurante(restaurante_id: int, db: Session = Depends(get_db)):
    restaurante = db.query(Restaurante).filter(Restaurante.id == restaurante_id).first()
    if not restaurante:
        raise HTTPException(status_code=404, detail="Restaurante no encontrado")
    db.query(Plato).filter(Plato.restaurante_id == restaurante_id).delete()
    db.delete(restaurante)
    db.commit()
    return {"mensaje": f"Restaurante {restaurante.nombre} eliminado"}

@app.get("/restaurantes/{restaurante_id}/platos")
def obtener_platos(restaurante_id: int, db: Session = Depends(get_db)):
    return db.query(Plato).filter(Plato.restaurante_id == restaurante_id, Plato.disponible == "si").all()

@app.post("/platos")
def crear_plato(restaurante_id: int, nombre: str, descripcion: str, precio: int, db: Session = Depends(get_db)):
    plato = Plato(restaurante_id=restaurante_id, nombre=nombre, descripcion=descripcion, precio=precio)
    db.add(plato)
    db.commit()
    db.refresh(plato)
    return plato

@app.post("/platos/imagen/{plato_id}")
async def subir_imagen_plato(plato_id: int, file: UploadFile = File(...), db: Session = Depends(get_db)):
    plato = db.query(Plato).filter(Plato.id == plato_id).first()
    if not plato:
        raise HTTPException(status_code=404, detail="Plato no encontrado")
    contenido = await file.read()
    resultado = cloudinary.uploader.upload(
        contenido,
        folder="orito-app/platos",
        public_id=f"plato_{plato_id}",
        overwrite=True
    )
    plato.imagen_url = resultado["secure_url"]
    db.commit()
    return {"url": resultado["secure_url"]}

@app.post("/restaurantes/imagen/{restaurante_id}")
async def subir_imagen_restaurante(restaurante_id: int, file: UploadFile = File(...), db: Session = Depends(get_db)):
    restaurante = db.query(Restaurante).filter(Restaurante.id == restaurante_id).first()
    if not restaurante:
        raise HTTPException(status_code=404, detail="Restaurante no encontrado")
    contenido = await file.read()
    resultado = cloudinary.uploader.upload(
        contenido,
        folder="orito-app/restaurantes",
        public_id=f"restaurante_{restaurante_id}",
        overwrite=True
    )
    restaurante.imagen_url = resultado["secure_url"]
    db.commit()
    return {"url": resultado["secure_url"]}

@app.post("/menu/leer")
async def leer_menu_foto(file: UploadFile = File(...)):
    contenido = await file.read()
    resultado = cloudinary.uploader.upload(
        contenido,
        folder="orito-app/menus",
        overwrite=False
    )
    return {"url": resultado["secure_url"], "mensaje": "Imagen subida correctamente"}

@app.put("/platos/{plato_id}/disponible")
def cambiar_disponible(plato_id: int, disponible: str, db: Session = Depends(get_db)):
    plato = db.query(Plato).filter(Plato.id == plato_id).first()
    if not plato:
        raise HTTPException(status_code=404, detail="Plato no encontrado")
    plato.disponible = disponible
    db.commit()
    return plato

@app.get("/pedidos/restaurante/{restaurante_id}")
def obtener_pedidos_restaurante(restaurante_id: int, db: Session = Depends(get_db)):
    return db.query(Pedido).filter(Pedido.restaurante_id == restaurante_id).all()

@app.get("/pedidos")
def obtener_pedidos(db: Session = Depends(get_db)):
    return db.query(Pedido).all()

@app.post("/pedidos")
def crear_pedido(cliente_nombre: str, cliente_direccion: str, cliente_telefono: str, restaurante_id: int, plato: str, total: int, metodo_pago: str = "efectivo", db: Session = Depends(get_db)):
    pedido = Pedido(cliente_nombre=cliente_nombre, cliente_direccion=cliente_direccion, cliente_telefono=cliente_telefono, restaurante_id=restaurante_id, plato=plato, total=total, metodo_pago=metodo_pago)
    db.add(pedido)
    db.commit()
    db.refresh(pedido)
    return pedido

@app.put("/pedidos/{pedido_id}/estado")
def actualizar_estado(pedido_id: int, estado: str, db: Session = Depends(get_db)):
    pedido = db.query(Pedido).filter(Pedido.id == pedido_id).first()
    if not pedido:
        raise HTTPException(status_code=404, detail="Pedido no encontrado")
    pedido.estado = estado
    if estado == "listo":
        domiciliarios = db.query(Usuario).filter(Usuario.rol == "domiciliario").all()
        if domiciliarios:
            pedidos_activos = {}
            for domi in domiciliarios:
                activos = db.query(Pedido).filter(
                    Pedido.domiciliario_id == domi.id,
                    Pedido.estado.in_(["asignado", "en camino"])
                ).count()
                pedidos_activos[domi.id] = activos
            domi_asignado = min(pedidos_activos, key=pedidos_activos.get)
            pedido.domiciliario_id = domi_asignado
            pedido.estado = "asignado"
    db.commit()
    return pedido

@app.put("/pedidos/{pedido_id}/asignar")
def asignar_domiciliario(pedido_id: int, domiciliario_id: int, db: Session = Depends(get_db)):
    pedido = db.query(Pedido).filter(Pedido.id == pedido_id).first()
    if not pedido:
        raise HTTPException(status_code=404, detail="Pedido no encontrado")
    pedido.domiciliario_id = domiciliario_id
    pedido.estado = "asignado"
    db.commit()
    return pedido

@app.put("/usuarios/{telefono}/rol")
def cambiar_rol(telefono: str, rol: str, restaurante_id: int = None,
                tipo_vehiculo: str = None, db: Session = Depends(get_db),
                admin: Usuario = Depends(solo_admin)):
    # el rol admin NO se entrega por API bajo ninguna circunstancia: se otorga a
    # mano en la base. Asi nadie puede volverse dueño de la app desde afuera.
    if rol == "admin":
        raise HTTPException(status_code=403, detail="El rol de administrador no se puede asignar desde la app")
    usuario = db.query(Usuario).filter(Usuario.telefono == telefono).first()
    if not usuario:
        raise HTTPException(status_code=404, detail="Usuario no encontrado")
    if usuario.rol == "admin":
        raise HTTPException(status_code=403, detail="No se puede cambiar el rol de un administrador")
    # un conductor sin vehiculo declarado no le sirve a nadie: no veria ni una carrera
    if rol == "conductor":
        elegido = tipo_vehiculo or usuario.tipo_vehiculo
        permitidos = vehiculos_de(usuario.municipio or "Orito", db)
        if elegido not in VEHICULOS_VALIDOS:
            raise HTTPException(status_code=400, detail="Para hacerlo conductor tienes que indicar que vehiculo maneja")
        if elegido not in permitidos:
            raise HTTPException(
                status_code=400,
                detail=f"En {usuario.municipio} solo se permite {' o '.join(permitidos)}")
        usuario.tipo_vehiculo = elegido
    usuario.rol = rol
    if restaurante_id:
        usuario.restaurante_id = restaurante_id
    db.commit()
    return {"nombre": usuario.nombre, "telefono": usuario.telefono, "rol": usuario.rol,
            "restaurante_id": usuario.restaurante_id, "tipo_vehiculo": usuario.tipo_vehiculo}

@app.get("/usuarios")
def obtener_usuarios(db: Session = Depends(get_db), admin: Usuario = Depends(solo_admin)):
    usuarios = db.query(Usuario).all()
    return [{"id": u.id, "nombre": u.nombre, "telefono": u.telefono, "rol": u.rol, "restaurante_id": u.restaurante_id} for u in usuarios]

@app.get("/domiciliarios")
def obtener_domiciliarios(db: Session = Depends(get_db)):
    domiciliarios = db.query(Usuario).filter(Usuario.rol == "domiciliario").all()
    return [{"id": u.id, "nombre": u.nombre, "telefono": u.telefono} for u in domiciliarios]


# ---------------------------------------------------------------- CARRERAS
# Seccion de transporte. Independiente de domicilios: solo comparte los usuarios.

def _token_viaje(cid: int) -> str:
    """Token corto e imposible de adivinar para el link publico de seguimiento en
    vivo (/viaje?c=..&t=..). Se deriva por HMAC de una clave del servidor, asi no
    hace falta guardarlo en la base y nadie puede 'adivinar' el viaje de otro."""
    clave = (os.environ.get("RESPALDO_CLAVE") or "tukan-seguimiento").encode()
    return hmac.new(clave, f"viaje:{int(cid)}".encode(), hashlib.sha256).hexdigest()[:16]

def carrera_dict(c: Carrera, conductor: Usuario = None):
    return {
        "id": c.id,
        "cliente_id": c.cliente_id,
        "cliente_nombre": c.cliente_nombre,
        "cliente_telefono": c.cliente_telefono,
        "origen": c.origen,
        "origen_detalle": c.origen_detalle,
        "destino": c.destino,
        "destino_detalle": c.destino_detalle,
        "conductor_id": c.conductor_id,
        "conductor_nombre": conductor.nombre if conductor else None,
        "conductor_telefono": conductor.telefono if conductor else None,
        "conductor_placa": conductor.placa if conductor else None,
        "conductor_vehiculo": conductor.vehiculo if conductor else None,
        "conductor_tipo_vehiculo": conductor.tipo_vehiculo if conductor else None,
        "conductor_veh_color": conductor.veh_color if conductor else None,
        "conductor_pagos": medios_pago(conductor) if conductor else None,
        "conductor_foto": conductor.foto_conductor if conductor else None,
        "conductor_foto_vehiculo": conductor.foto_vehiculo if conductor else None,
        "conductor_fundador": (conductor.fundador or "no") if conductor else "no",
        "conductor_lat": conductor.ubic_lat if conductor else None,
        "conductor_lon": conductor.ubic_lon if conductor else None,
        "conductor_ubic_fecha": conductor.ubic_fecha if conductor else None,
        "estado": c.estado,
        "zona": c.zona,
        "municipio": c.municipio,
        "vehiculo_pedido": c.vehiculo_pedido,
        "origen_lat": c.origen_lat,
        "origen_lon": c.origen_lon,
        "destino_lat": c.destino_lat,
        "destino_lon": c.destino_lon,
        "distancia_km": c.distancia_km,
        "tarifa_sugerida": c.tarifa_sugerida,
        "tarifa_ofrecida": c.tarifa_ofrecida,
        "tarifa": c.tarifa,
        "notas": c.notas,
        "recogida": c.recogida,
        "llego_recogida": c.llego_recogida,
        "estrellas_conductor": c.estrellas_conductor,
        "estrellas_cliente": c.estrellas_cliente,
        "comentario_conductor": c.comentario_conductor,
        "comentario_cliente": c.comentario_cliente,
        "conductor_calificacion": conductor.calificacion if conductor else None,
        "fecha": c.fecha,
        "token_viaje": _token_viaje(c.id),   # para el link publico de seguimiento en vivo
        "aceptada_en": c.aceptada_en,
        "segundos_para_cancelar": _segundos_para_cancelar(c),   # None = no aplica; 0 = ya no
        "cancelada_por": c.cancelada_por,
        "cancelada_en": c.cancelada_en,
        "motivo_cancelacion": c.motivo_cancelacion,
        # acarreo
        "tipo_carga": c.tipo_carga, "tamano_carga": c.tamano_carga,
        "fotos_carga": [u for u in (c.fotos_carga or "").split(",") if u],
        "ayudantes": c.ayudantes, "piso_origen": c.piso_origen, "piso_destino": c.piso_destino,
        "ascensor_origen": c.ascensor_origen, "ascensor_destino": c.ascensor_destino,
        "recibe_nombre": c.recibe_nombre, "recibe_telefono": c.recibe_telefono,
        "entrega_foto": c.entrega_foto, "entrega_recibio": c.entrega_recibio,
        "entregada_en": c.entregada_en,
    }

def con_conductor(carreras, db: Session):
    ids = {c.conductor_id for c in carreras if c.conductor_id}
    conductores = {u.id: u for u in db.query(Usuario).filter(Usuario.id.in_(ids)).all()} if ids else {}
    return [carrera_dict(c, conductores.get(c.conductor_id)) for c in carreras]

# ---- suscripcion de conductores
# El dueño cobra un fijo mensual por dejarlos recibir carreras. Mientras
# cobro_activo este en "no" todos trabajan gratis (periodo de arranque).

def leer_config(clave: str, db: Session, defecto: str = ""):
    fila = db.query(Config).filter(Config.clave == clave).first()
    return fila.valor if fila else defecto

def suscripcion_al_dia(conductor: Usuario, db: Session):
    """True si puede recibir carreras. Si el cobro esta apagado, todos pueden."""
    if leer_config("cobro_activo", db, "no") != "si":
        return True
    return bool(conductor.suscripcion_hasta) and conductor.suscripcion_hasta >= datetime.now()

def dias_restantes(conductor: Usuario):
    if not conductor.suscripcion_hasta:
        return 0
    return max(0, (conductor.suscripcion_hasta - datetime.now()).days)

def valor_mensual_de(conductor: Usuario, db: Session):
    """La suscripcion vale distinto por vehiculo: carro mas que moto."""
    clave = "valor_mensual_moto" if (conductor.tipo_vehiculo == "moto") else "valor_mensual_carro"
    return int(leer_config(clave, db, "0") or 0)

@app.get("/config")
def obtener_config(db: Session = Depends(get_db), admin: Usuario = Depends(solo_admin)):
    return {c.clave: c.valor for c in db.query(Config).all()}

@app.put("/config")
def actualizar_config(clave: str, valor: str, db: Session = Depends(get_db),
                      admin: Usuario = Depends(solo_admin)):
    permitidas = ("cobro_activo", "valor_mensual_moto", "valor_mensual_carro", "nequi_pagos", "apk_url", "whatsapp_soporte",
                  "llave_pagos", "banco_pagos", "banco_tipo", "banco_numero", "banco_titular",
                  "promo_activa", "promo_pct", "promo_ciudad", "promo_texto", "promo_hasta",
                  "exclusivo_aeropuerto_tel", "exclusivo_radio_km")
    if clave not in permitidas:
        raise HTTPException(status_code=400, detail="Ajuste no permitido")
    if clave == "cobro_activo" and valor not in ("si", "no"):
        raise HTTPException(status_code=400, detail="cobro_activo solo acepta si o no")
    if clave.startswith("valor_mensual") and not valor.isdigit():
        raise HTTPException(status_code=400, detail="El valor mensual debe ser un numero")
    fila = db.query(Config).filter(Config.clave == clave).first()
    if fila:
        fila.valor = valor
    else:
        db.add(Config(clave=clave, valor=valor))
    db.commit()
    return {"clave": clave, "valor": valor}

@app.put("/conductores/{conductor_id}/suscripcion")
def registrar_pago(conductor_id: int, meses: int = 1, db: Session = Depends(get_db),
                   admin: Usuario = Depends(solo_admin)):
    """El dueño confirma que el conductor le pago y le suma meses.
    Si todavia le quedaban dias, se le suman encima en vez de perderlos."""
    if meses < 1 or meses > 12:
        raise HTTPException(status_code=400, detail="Los meses van de 1 a 12")
    conductor = db.query(Usuario).filter(Usuario.id == conductor_id, Usuario.rol == "conductor").first()
    if not conductor:
        raise HTTPException(status_code=404, detail="Conductor no encontrado")
    desde = conductor.suscripcion_hasta if (conductor.suscripcion_hasta and conductor.suscripcion_hasta > datetime.now()) else datetime.now()
    conductor.suscripcion_hasta = desde + timedelta(days=30 * meses)
    db.commit()
    db.refresh(conductor)
    return {"id": conductor.id, "nombre": conductor.nombre,
            "suscripcion_hasta": conductor.suscripcion_hasta,
            "dias_restantes": dias_restantes(conductor)}

@app.delete("/conductores/{conductor_id}/suscripcion")
def cancelar_suscripcion(conductor_id: int, db: Session = Depends(get_db),
                         admin: Usuario = Depends(solo_admin)):
    conductor = db.query(Usuario).filter(Usuario.id == conductor_id, Usuario.rol == "conductor").first()
    if not conductor:
        raise HTTPException(status_code=404, detail="Conductor no encontrado")
    conductor.suscripcion_hasta = None
    conductor.disponible = "no"
    db.commit()
    return {"ok": True}


# ---- notificaciones
# Corren en segundo plano (BackgroundTasks): el cliente no espera a que Expo
# responda para que su carrera quede registrada.

def nunca_falla(fn):
    """Una notificacion que se cae no puede tumbar una carrera. Todo lo de push
    va envuelto aca: si algo revienta se anota en el log y la vida sigue."""
    def envoltura(*args, **kwargs):
        try:
            return fn(*args, **kwargs)
        except Exception as e:
            logging.getLogger("push").warning("Fallo %s: %s", fn.__name__, e)
    envoltura.__name__ = fn.__name__
    return envoltura

def limpiar_tokens_muertos(muertos):
    if not muertos:
        return
    db = SessionLocal()
    try:
        db.query(Usuario).filter(Usuario.push_token.in_(muertos)).update(
            {"push_token": None}, synchronize_session=False)
        db.commit()
    finally:
        db.close()

# ---- prioridad por cercania: al cliente lo atiende primero quien esta cerca ----
# Una solicitud nueva primero le suena SOLO a los conductores a <=1.5 km del punto
# de recogida (los que de verdad pueden llegar rapido, incluido el que va pasando).
# Si en 30s nadie la toma, se le abre a TODOS los disponibles. La solicitud SIEMPRE
# esta visible para todos en la lista; lo unico que se prioriza es a quien se le
# avisa fuerte primero, asi nunca se oculta ni se queda sin quien la tome.
RADIO_CERCANIA_KM = 1.5      # que cuenta como "cerca" del cliente
VENTANA_CERCANIA_SEG = 30    # ventaja de arranque de los cercanos antes de abrir a todos
UBIC_FRESCA_SEG = 180        # la ubicacion del conductor sirve si es de hace <3 min

def _ubicacion_fresca(u, ahora):
    return (u.ubic_lat is not None and u.ubic_lon is not None and u.ubic_fecha is not None
            and (ahora - u.ubic_fecha).total_seconds() <= UBIC_FRESCA_SEG)

def km_conductor_a_recogida(u, carrera, ahora):
    """Km en linea recta del conductor al punto de recogida, o None si no sabemos
    donde esta (sin GPS reciente) o la carrera no tiene coordenadas."""
    if carrera.origen_lat is None or not _ubicacion_fresca(u, ahora):
        return None
    return tarifas.distancia_km(u.ubic_lat, u.ubic_lon, carrera.origen_lat, carrera.origen_lon)

def le_toca_aviso(u, carrera, ahora):
    """¿A este conductor ya le corresponde el aviso fuerte de esta carrera?
    Primeros 30s: solo los cercanos (<=1.5 km con GPS reciente). Pasada la ventana:
    todos. Asi el de al lado tiene ventaja, pero si no responde no se pierde."""
    if not carrera.fecha or (ahora - carrera.fecha).total_seconds() >= VENTANA_CERCANIA_SEG:
        return True
    d = km_conductor_a_recogida(u, carrera, ahora)
    return d is not None and d <= RADIO_CERCANIA_KM

def _candidatos_carrera(carrera, db):
    """Conductores conectados, al dia y con el vehiculo/municipio que aplica."""
    return [
        c for c in db.query(Usuario).filter(
            Usuario.rol == "conductor",
            Usuario.disponible == "si",
            Usuario.push_token.isnot(None),
            Usuario.activo != "no",
        ).all()
        if le_sirve_la_carrera(c, carrera) and suscripcion_al_dia(c, db)
    ]

def _canales_de_tokens(tokens):
    """{token: canal} para los celulares cuya app usa un canal propio (tono Selva)."""
    if not tokens:
        return {}
    db = SessionLocal()
    try:
        filas = db.query(Usuario.push_token, Usuario.push_canal).filter(
            Usuario.push_token.in_(list(set(tokens))), Usuario.push_canal.isnot(None)).all()
        return {t: c for t, c in filas if c}
    finally:
        db.close()

push.resolver_canal = _canales_de_tokens

def push_conductor(u: Usuario, titulo: str, cuerpo: str, datos: dict):
    """Si la app del conductor sabe hacer avisos a pantalla completa, se le manda un
    push SOLO DE DATOS (sin titulo): la app lo recibe aunque este bloqueada o cerrada
    y lo convierte en aviso tipo llamada + Tukan al frente. Si no, el push normal."""
    normal = push.mensaje(u.push_token, titulo, cuerpo, datos)
    # se puede apagar sin redesplegar codigo poniendo PUSH_DATOS=no en Railway
    if u.push_modo == "datos" and os.environ.get("PUSH_DATOS") != "no":
        # van los DOS: el normal es la red de seguridad (nunca se queda sin aviso)
        return [normal, {"to": u.push_token, "priority": "high", "_contentAvailable": True,
                         "data": {**datos, "titulo": titulo, "cuerpo": cuerpo}}]
    return [normal]

def _mensajes_carrera(carrera, conductores, titulo):
    aviso_zona = " (fuera del pueblo)" if carrera.zona == "rural" else ""
    oferta = f" · ofrece ${carrera.tarifa_ofrecida:,}".replace(",", ".") if carrera.tarifa_ofrecida else ""
    carga = carrera.vehiculo_pedido in VEHICULOS_CARGA
    tit = ("🚚 Nuevo acarreo" if carga else f"🔔 {titulo}") + aviso_zona
    return [m for c in conductores
            for m in push_conductor(c, tit, f"De {carrera.origen} a {carrera.destino}{oferta}",
                                    {"tipo": "carrera_nueva", "carrera_id": carrera.id})]

@nunca_falla
def avisar_carrera_nueva(carrera_id: int):
    """Ola 1: le suena SOLO a los conductores cerca del cliente (<=1.5 km). Si hay
    cercanos, programa abrir a todos en 30s por si nadie la toma."""
    db = SessionLocal()
    hay_cercanos = False
    mensajes = []
    tel_excl, dueno_avisado = "", False
    try:
        carrera = db.query(Carrera).filter(Carrera.id == carrera_id).first()
        if not carrera or carrera.estado != "buscando":
            return
        ahora = datetime.now()
        # (aunque no haya candidatos se sigue: puede faltar programar el aviso al dueño)
        candidatos = _candidatos_carrera(carrera, db)
        cercanos = [c for c in candidatos
                    if (km_conductor_a_recogida(c, carrera, ahora) or 1e9) <= RADIO_CERCANIA_KM]
        hay_cercanos = len(cercanos) > 0
        # si no hay ninguno cerca (o sin GPS reciente), no tiene sentido esperar:
        # se le avisa a todos de una
        objetivo = cercanos if hay_cercanos else candidatos
        mensajes = _mensajes_carrera(carrera, objetivo, "Nueva carrera")
        # ¿el dueño (ruta exclusiva) quedo por fuera por su radio? -> al minuto se le avisa
        tel_excl = _cfg_exclusivo()[0]
        dueno_avisado = bool(tel_excl) and any(_digitos(c.telefono)[-10:] == tel_excl for c in objetivo)
    finally:
        db.close()
    limpiar_tokens_muertos(push.enviar(mensajes))
    if tel_excl and not dueno_avisado:
        threading.Timer(EXCLUSIVO_ESPERA_SEG + 1, avisar_dueno_si_sigue_libre, args=[carrera_id]).start()
    # arrancamos solo con los cercanos: si en 30s sigue libre, se abre a TODOS
    if hay_cercanos:
        threading.Timer(VENTANA_CERCANIA_SEG, avisar_carrera_a_todos, args=[carrera_id]).start()

@nunca_falla
def avisar_carrera_a_todos(carrera_id: int):
    """Ola 2: pasada la ventana, si NADIE la tomo, se le avisa a todos los
    disponibles (tambien a los que no estaban cerca)."""
    db = SessionLocal()
    mensajes = []
    try:
        carrera = db.query(Carrera).filter(Carrera.id == carrera_id).first()
        if not carrera or carrera.estado != "buscando":
            return   # ya la tomaron: no molestamos a nadie mas
        # NO se le reofrece a quien ya contraoferto: esta esperando la respuesta
        # del cliente. Reofrecersela lo hacia tomarla al precio original y pisar
        # su propia oferta.
        con_oferta = {o.conductor_id for o in db.query(Oferta).filter(
            Oferta.carrera_id == carrera_id, Oferta.estado == "pendiente").all()}
        destinatarios = [c for c in _candidatos_carrera(carrera, db) if c.id not in con_oferta]
        mensajes = _mensajes_carrera(carrera, destinatarios, "Carrera libre")
    finally:
        db.close()
    limpiar_tokens_muertos(push.enviar(mensajes))

@nunca_falla
def avisar_carrera_aceptada(carrera_id: int):
    """Le avisa al cliente que ya tiene conductor, con placa y telefono."""
    db = SessionLocal()
    try:
        carrera = db.query(Carrera).filter(Carrera.id == carrera_id).first()
        if not carrera:
            return
        cliente = db.query(Usuario).filter(Usuario.id == carrera.cliente_id).first()
        conductor = db.query(Usuario).filter(Usuario.id == carrera.conductor_id).first()
        if not cliente or not cliente.push_token or not conductor:
            return
        placa = f" - {conductor.placa}" if conductor.placa else ""
        mensajes = [push.mensaje(
            cliente.push_token,
            "Ya tienes transportador",
            f"{conductor.nombre}{placa} va en camino",
            {"tipo": "carrera_aceptada", "carrera_id": carrera.id},
        )]
    finally:
        db.close()
    limpiar_tokens_muertos(push.enviar(mensajes))

@nunca_falla
def avisar_contraoferta(carrera_id: int, conductor_id: int, monto: int):
    """Le avisa al cliente que un conductor propuso un precio."""
    db = SessionLocal()
    try:
        carrera = db.query(Carrera).filter(Carrera.id == carrera_id).first()
        if not carrera:
            return
        cliente = db.query(Usuario).filter(Usuario.id == carrera.cliente_id).first()
        conductor = db.query(Usuario).filter(Usuario.id == conductor_id).first()
        if not cliente or not cliente.push_token or not conductor:
            return
        mensajes = [push.mensaje(
            cliente.push_token,
            "Un conductor te propone un precio",
            f"{conductor.nombre} ofrece hacerla por ${monto:,}".replace(",", "."),
            {"tipo": "contraoferta", "carrera_id": carrera_id},
        )]
    finally:
        db.close()
    limpiar_tokens_muertos(push.enviar(mensajes))

@nunca_falla
def avisar_oferta_aceptada(conductor_id: int, carrera_id: int):
    """Le avisa al conductor que el cliente acepto su contraoferta."""
    db = SessionLocal()
    try:
        conductor = db.query(Usuario).filter(Usuario.id == conductor_id).first()
        carrera = db.query(Carrera).filter(Carrera.id == carrera_id).first()
        if not conductor or not conductor.push_token or not carrera:
            return
        mensajes = [push.mensaje(
            conductor.push_token,
            "Te aceptaron la carrera",
            f"Recoge en {carrera.origen}",
            {"tipo": "oferta_aceptada", "carrera_id": carrera_id},
        )]
    finally:
        db.close()
    limpiar_tokens_muertos(push.enviar(mensajes))

@nunca_falla
def avisar_conductor_llego(carrera_id: int):
    """Le avisa al cliente que el conductor YA esta en el punto de recogida."""
    db = SessionLocal()
    try:
        carrera = db.query(Carrera).filter(Carrera.id == carrera_id).first()
        if not carrera:
            return
        cliente = db.query(Usuario).filter(Usuario.id == carrera.cliente_id).first()
        conductor = db.query(Usuario).filter(Usuario.id == carrera.conductor_id).first()
        if not cliente or not cliente.push_token or not conductor:
            return
        placa = f" ({conductor.placa})" if conductor.placa else ""
        mensajes = [push.mensaje(
            cliente.push_token,
            "Tu conductor llego",
            f"{conductor.nombre}{placa} ya esta en el punto de recogida. Sal a encontrarlo.",
            {"tipo": "conductor_llego", "carrera_id": carrera_id},
        )]
    finally:
        db.close()
    limpiar_tokens_muertos(push.enviar(mensajes))

@nunca_falla
def avisar_carrera_cancelada(carrera_id: int):
    """Avisa a la OTRA parte que la carrera se cancelo, con el motivo. Si cancela el
    pasajero -> al conductor; si cancela el conductor -> al pasajero; admin -> a ambos."""
    db = SessionLocal()
    mensajes = []
    try:
        c = db.query(Carrera).filter(Carrera.id == carrera_id).first()
        if not c or c.estado != "cancelada":
            return
        motivo = c.motivo_cancelacion or "Sin motivo"
        datos = {"tipo": "carrera_cancelada", "carrera_id": c.id}
        conductor = db.query(Usuario).filter(Usuario.id == c.conductor_id).first() if c.conductor_id else None
        cliente = db.query(Usuario).filter(Usuario.id == c.cliente_id).first()
        if c.cancelada_por in ("cliente", "admin") and conductor and conductor.push_token:
            mensajes.extend(push_conductor(conductor, "❌ El pasajero canceló la carrera",
                                           f"{c.origen} → {c.destino}. Motivo: {motivo}", datos))
        if c.cancelada_por in ("conductor", "admin") and cliente and cliente.push_token:
            mensajes.append(push.mensaje(cliente.push_token, "❌ Tu conductor canceló la carrera",
                                         f"Motivo: {motivo}. Puedes volver a pedir tu carrera.", datos))
    finally:
        db.close()
    limpiar_tokens_muertos(push.enviar(mensajes))

@app.put("/usuarios/{usuario_id}/push-token")
def guardar_push_token(usuario_id: int, token: str, pantalla_completa: str = None, canal: str = None,
                       db: Session = Depends(get_db), actual: Usuario = Depends(usuario_actual)):
    exigir_dueño(actual, usuario_id)
    """La app manda esto al entrar. Si el token ya estaba en otro usuario (celular
    prestado o compartido) se lo quita, para que los avisos no le lleguen al anterior."""
    usuario = db.query(Usuario).filter(Usuario.id == usuario_id).first()
    if not usuario:
        raise HTTPException(status_code=404, detail="Usuario no encontrado")
    db.query(Usuario).filter(Usuario.push_token == token, Usuario.id != usuario_id).update(
        {"push_token": None}, synchronize_session=False)
    usuario.push_token = token
    if pantalla_completa is not None:
        usuario.push_modo = "datos" if pantalla_completa == "si" else None
    # el APK nuevo (tono Selva) usa "carreras4"; los viejos no mandan nada -> carreras3
    usuario.push_canal = canal if canal in ("carreras3", "carreras4") else None
    db.commit()
    return {"ok": True}

def buscar_lugar(nombre: str, municipio: str, db: Session):
    return db.query(Lugar).filter(
        func.lower(Lugar.nombre) == (nombre or "").strip().lower(),
        Lugar.municipio == municipio,
    ).first()

def registrar_lugar(nombre: str, municipio: str, db: Session, lat=None, lon=None):
    """Guarda lo que escribio el usuario para sugerirselo al siguiente, dentro de
    su municipio. Si viene con coordenadas y el lugar aun no las tiene, las
    aprende: asi el proximo que lo elija de la lista no necesita marcar el mapa."""
    nombre = (nombre or "").strip()
    if len(nombre) < 3:
        return
    lugar = buscar_lugar(nombre, municipio, db)
    if lugar:
        lugar.usos = (lugar.usos or 0) + 1
        if lat is not None and lon is not None and lugar.lat is None:
            lugar.lat, lugar.lon = lat, lon
    else:
        # lo escrito a mano entra como urbano; si es vereda el admin lo corrige
        db.add(Lugar(nombre=nombre, municipio=municipio, usos=1, lat=lat, lon=lon))

def geocodificar_texto(nombre: str, municipio: str, db: Session):
    """Texto libre -> coordenadas (geocoding DIRECTO), gratis via Nominatim.
    Sirve para cuando el cliente escribe el destino sin marcar el pin: asi la
    carrera igual tiene ubicacion y, ya con el pasajero a bordo, el mapa puede
    trazar la ruta al destino (antes se quedaba clavado en la recogida).
    Se acota al municipio (viewbox + Colombia) y se valida que caiga cerca del
    pueblo, para no traer un resultado del otro lado del mundo. (lat, lon) o None."""
    nombre = (nombre or "").strip()
    if len(nombre) < 3:
        return None
    if any(g in nombre.lower() for g in ("punto marcado", "mi ubicacion", "ubicacion actual")):
        return None
    m = db.query(Municipio).filter(Municipio.nombre == municipio).first()
    clat = m.centro_lat if m else None
    clon = m.centro_lon if m else None
    depto = (m.departamento if m else None) or "Colombia"   # departamento REAL (no hardcodeado)
    try:
        import urllib.request as _ur, urllib.parse as _up, json as _json
        params = {
            "q": f"{nombre}, {municipio}, {depto}, Colombia",
            "format": "jsonv2", "limit": "1",
            "countrycodes": "co", "accept-language": "es",
        }
        if clat is not None and clon is not None:
            # caja ACOTADA a la ciudad: asi 'Carrera 11' cae en ESTA ciudad y no
            # en Bogota. ~44 km cubre una ciudad grande + su area
            d = 0.4
            params["viewbox"] = f"{clon - d},{clat - d},{clon + d},{clat + d}"
            params["bounded"] = "1"
        url = "https://nominatim.openstreetmap.org/search?" + _up.urlencode(params)
        req = _ur.Request(url, headers={"User-Agent": "tukan-app/1.0 (ingrobinespana@gmail.com)"})
        with _ur.urlopen(req, timeout=4) as r:
            arr = _json.loads(r.read().decode("utf-8"))
        if not arr:
            return None
        lat = float(arr[0]["lat"]); lon = float(arr[0]["lon"])
        # cordura: debe caer cerca de la ciudad (<=40 km) si sabemos el centro
        if clat is not None and clon is not None:
            km = tarifas.distancia_km(clat, clon, lat, lon)
            if km is not None and km > 40:
                return None
        return (lat, lon, arr[0].get("display_name"))
    except Exception:
        return None

def geocodificar_amplio(nombre: str, lat=None, lon=None, acotado=False):
    """Geocoding en toda Colombia sesgado hacia (lat,lon). Si 'acotado' es True,
    RESTRINGE los resultados a la caja alrededor de ese punto (para nomenclatura de
    una ciudad); si no, solo sesga y elige el mas cercano. Devuelve (lat, lon)."""
    nombre = (nombre or "").strip()
    if len(nombre) < 3:
        return None
    try:
        import urllib.request as _ur, urllib.parse as _up, json as _json
        params = {"q": f"{nombre}, Colombia", "format": "jsonv2", "limit": "6",
                  "countrycodes": "co", "accept-language": "es"}
        if lat is not None and lon is not None:
            d = 0.4   # ~44 km alrededor del punto
            params["viewbox"] = f"{lon - d},{lat - d},{lon + d},{lat + d}"
            if acotado:
                params["bounded"] = "1"   # SOLO dentro de la caja (esta ciudad)
        url = "https://nominatim.openstreetmap.org/search?" + _up.urlencode(params)
        req = _ur.Request(url, headers={"User-Agent": "tukan-app/1.0 (ingrobinespana@gmail.com)"})
        with _ur.urlopen(req, timeout=5) as r:
            arr = _json.loads(r.read().decode("utf-8"))
        if not arr:
            return None
        if lat is not None and lon is not None:
            def cerca(item):
                return tarifas.distancia_km(lat, lon, float(item["lat"]), float(item["lon"])) or 1e9
            mejor = min(arr, key=cerca)
        else:
            mejor = arr[0]
        return (float(mejor["lat"]), float(mejor["lon"]), mejor.get("display_name"))
    except Exception:
        return None

# Buscador Mapbox mediado por el backend: el token del usuario esta RESTRINGIDO por
# URL (permite orito.app), asi que las peticiones se mandan con ese Referer. Vive en
# el servidor para poder cambiar de proveedor sin publicar app nueva (expansion).
# El token 'pk.' es publico por diseno; se puede sobreescribir por env sin tocar codigo.
MAPBOX_TOKEN = os.environ.get(
    "MAPBOX_TOKEN",
    "pk.eyJ1IjoiZGFyd2luZSIsImEiOiJjbXNkenQ2Ym4wMDN3MnhxMGoxZGlyN3R2In0.WwBcBvXWmpy-I55Ceud-Lg")
MAPBOX_REFERER = os.environ.get("MAPBOX_REFERER", "https://orito.app/")

def _mapbox_geo(t, cerca_lat, cerca_lon):
    """Mapbox Geocoding v6: FUERTE en nomenclatura (Carrera 15, Calle 18), calles,
    barrios y lugares. Se SESGA por cercania (proximity) pero NO se encierra en una
    caja rigida: asi en ciudades grandes (Cali, Barranquilla) sugiere bien. El filtro
    por distancia (generoso) se aplica despues, en autocompletar()."""
    import urllib.request as _ur, urllib.parse as _up, json as _json
    params = {"q": t, "access_token": MAPBOX_TOKEN, "country": "co", "language": "es",
              "limit": "8", "autocomplete": "true",
              "types": "address,street,place,locality,neighborhood"}
    if cerca_lat is not None and cerca_lon is not None:
        params["proximity"] = f"{cerca_lon},{cerca_lat}"   # solo sesgo, sin recorte
    url = "https://api.mapbox.com/search/geocode/v6/forward?" + _up.urlencode(params)
    req = _ur.Request(url, headers={"Referer": MAPBOX_REFERER, "User-Agent": "tukan-app/1.0"})
    with _ur.urlopen(req, timeout=5) as r:
        data = _json.loads(r.read().decode("utf-8"))
    out = []
    for f in data.get("features", []):
        props = f.get("properties", {}) or {}
        geom = f.get("geometry", {}) or {}
        c = geom.get("coordinates")
        if not (c and len(c) == 2):
            co = props.get("coordinates") or {}
            if "longitude" in co and "latitude" in co:
                c = [co["longitude"], co["latitude"]]
        if c and len(c) == 2:
            nombre = props.get("full_address") or props.get("name") or props.get("name_preferred")
            if nombre:
                out.append({"nombre": nombre, "lat": c[1], "lon": c[0]})
    return out

def _mapbox_searchbox(t, cerca_lat, cerca_lon):
    """Mapbox Search Box /forward: MEJOR que Geocoding v6 en vias con nombre (Avenida
    Roosevelt), POIs/negocios (Unicentro, centros comerciales) y nomenclatura. Mismo
    token (con Referer) y sesgo por proximity. Devuelve [{nombre,lat,lon}]. Si falla,
    el que lo llama cae a v6/OSM (no se rompe el buscador)."""
    import urllib.request as _ur, urllib.parse as _up, json as _json
    params = {"q": t, "access_token": MAPBOX_TOKEN, "country": "co", "language": "es",
              "limit": "8", "types": "address,street,place,locality,neighborhood,poi"}
    if cerca_lat is not None and cerca_lon is not None:
        params["proximity"] = f"{cerca_lon},{cerca_lat}"   # solo sesgo, sin recorte
    url = "https://api.mapbox.com/search/searchbox/v1/forward?" + _up.urlencode(params)
    req = _ur.Request(url, headers={"Referer": MAPBOX_REFERER, "User-Agent": "tukan-app/1.0"})
    with _ur.urlopen(req, timeout=5) as r:
        data = _json.loads(r.read().decode("utf-8"))
    out = []
    for f in data.get("features", []):
        props = f.get("properties", {}) or {}
        geom = f.get("geometry", {}) or {}
        c = geom.get("coordinates")
        if not (c and len(c) == 2):
            co = props.get("coordinates") or {}
            if "longitude" in co and "latitude" in co:
                c = [co["longitude"], co["latitude"]]
        if c and len(c) == 2:
            nom = (props.get("name_preferred") or props.get("name") or "").strip()
            direccion = (props.get("full_address") or props.get("place_formatted") or "").strip()
            if props.get("feature_type") == "poi" and nom:
                # sitio con nombre (Unicentro, Univalle): el NOMBRE va primero y la
                # direccion de detalle. Antes solo salia "Cra. 100 #5-169" y la gente
                # creia que no lo habia encontrado.
                titulo, detalle = nom, direccion
            else:
                titulo = direccion or nom
                detalle = ""
                if "," in titulo:
                    titulo, detalle = titulo.split(",", 1)
                    titulo, detalle = titulo.strip(), detalle.strip()
            if titulo:
                nombre = f"{titulo}, {detalle}" if detalle else titulo
                out.append({"nombre": nombre, "titulo": titulo, "detalle": detalle,
                            "lat": c[1], "lon": c[0]})
    return out

def _nominatim_geo(t, cerca_lat, cerca_lon):
    """OpenStreetMap: FUERTE en sitios/negocios (Unicentro, terminal, parque,
    hospital). Acotado a la zona (bounded). Gratis. Complementa a Mapbox."""
    import urllib.request as _ur, urllib.parse as _up, json as _json
    params = {"q": t, "format": "jsonv2", "limit": "6",
              "countrycodes": "co", "accept-language": "es"}
    if cerca_lat is not None and cerca_lon is not None:
        # viewbox amplio (~65 km) solo como SESGO, sin bounded=1: en metros grandes
        # (Cali, Barranquilla) un recuadro chico borraba sitios validos.
        d = 0.6
        params["viewbox"] = f"{cerca_lon - d},{cerca_lat - d},{cerca_lon + d},{cerca_lat + d}"
    url = "https://nominatim.openstreetmap.org/search?" + _up.urlencode(params)
    req = _ur.Request(url, headers={"User-Agent": "tukan-app/1.0 (ingrobinespana@gmail.com)"})
    with _ur.urlopen(req, timeout=3) as r:
        arr = _json.loads(r.read().decode("utf-8"))
    out = []
    for x in arr:
        try:
            lat, lon = float(x["lat"]), float(x["lon"])
        except (KeyError, ValueError, TypeError):
            continue
        nombre = ", ".join([p.strip() for p in (x.get("display_name") or "").split(",")[:3]])
        out.append({"nombre": nombre, "lat": lat, "lon": lon})
    return out

import re as _re_bus
import unicodedata as _ud_bus

_VIAS = r"(calle|cl|cll|carrera|cra|cr|kr|kra|avenida|av|diagonal|dg|transversal|tv|tr)"
_RX_CRUCE = _re_bus.compile(
    r"^\s*" + _VIAS + r"\.?\s*(\d+\s*[a-z]?(?:\s*(?:bis|norte|sur|n|s|oeste|este))?)\s+(?:con|y|x|&|#|n[o°º]\.?)\s*"
    + r"(?:" + _VIAS + r"\.?\s*)?(\d+\s*[a-z]?)\s*(?:-\s*(\d+))?\s*$", _re_bus.I)

import difflib as _dl
import concurrent.futures as _cf

def _sin_tildes(t: str) -> str:
    return "".join(c for c in _ud_bus.normalize("NFD", t or "") if _ud_bus.category(c) != "Mn").lower()

# como la gente escribe el tipo de via (con errores) -> forma que entiende el mapa
_VIA_TYPOS = {
    "carrera": "Carrera", "carera": "Carrera", "carerra": "Carrera", "carrrera": "Carrera", "karrera": "Carrera",
    "carrea": "Carrera", "carreara": "Carrera", "cra": "Carrera", "cr": "Carrera", "kr": "Carrera", "kra": "Carrera",
    "crr": "Carrera", "carr": "Carrera", "cra.": "Carrera", "kra.": "Carrera",
    "calle": "Calle", "cale": "Calle", "cll": "Calle", "cl": "Calle", "clle": "Calle", "calel": "Calle", "cll.": "Calle", "cl.": "Calle",
    "avenida": "Avenida", "av": "Avenida", "av.": "Avenida", "ave": "Avenida", "avda": "Avenida", "aveneda": "Avenida", "avenid": "Avenida",
    "diagonal": "Diagonal", "dg": "Diagonal", "diag": "Diagonal", "diagonla": "Diagonal",
    "transversal": "Transversal", "tv": "Transversal", "tr": "Transversal", "transv": "Transversal", "trasversal": "Transversal",
}
# palabras comunes de sitios: se corrigen si estan mal escritas (plasa -> plaza)
_VOCAB = ["plaza", "centro", "comercial", "terminal", "transporte", "transportes", "hospital", "clinica",
          "universidad", "colegio", "escuela", "parque", "estadio", "iglesia", "barrio", "aeropuerto",
          "jardin", "unicentro", "chipichape", "cosmocentro", "imbanaco", "pasoancho", "palmetto",
          "mercado", "galeria", "estacion", "bomba", "supermercado", "drogueria", "farmacia", "banco",
          "alcaldia", "gobernacion", "batallon", "policia", "notaria", "registraduria", "gimnasio",
          "universitario", "valle", "norte", "sur", "oeste", "oriente", "principal", "puente", "glorieta",
          "condominio", "conjunto", "urbanizacion", "edificio", "torre", "hotel", "restaurante", "panaderia",
          "cementerio", "polideportivo", "coliseo", "biblioteca", "museo", "zoologico", "teatro", "plazoleta"]

def _corregir_vias(t: str) -> str:
    """Solo el tipo de via (cra, kra, carera, cll...): seguro, no toca nombres."""
    return " ".join(_VIA_TYPOS.get(_sin_tildes(w).strip(","), w) for w in (t or "").split())

def _corregir_palabras(t: str) -> str:
    """Palabras comunes mal escritas (plasa -> plaza). SOLO de respaldo, cuando la
    busqueda original trae poco: un nombre real (Centenario) no se debe 'corregir'."""
    salida = []
    for w in (t or "").split():
        base = _sin_tildes(w).strip(",.")
        if len(base) >= 4 and base.isalpha() and base not in _VOCAB:
            m = _dl.get_close_matches(base, _VOCAB, n=1, cutoff=0.8)
            if m:
                salida.append(m[0]); continue
        salida.append(w)
    return " ".join(salida)

def _lugares_conocidos(t: str, municipio: str, db: Session, lat=None, lon=None):
    """Sitios que Tukan ya aprendio en esa ciudad (con coordenadas), tolerando errores
    de escritura. Clave en pueblos donde el mapa tiene pocos datos (Putumayo)."""
    if not municipio:
        return []
    q = _sin_tildes(t).strip()
    if len(q) < 3:
        return []
    candidatos = []
    for l in db.query(Lugar).filter(Lugar.municipio == municipio, Lugar.lat.isnot(None)).all():
        n = _sin_tildes(l.nombre)
        if q in n:
            score = 1.0
        else:
            score = max(_dl.SequenceMatcher(None, q, n).ratio(),
                        _dl.SequenceMatcher(None, q, n[:len(q) + 2]).ratio())
        if score >= 0.78:
            candidatos.append((score, l.usos or 0, l))
    candidatos.sort(key=lambda x: (-x[0], -x[1]))
    return [{"nombre": f"{l.nombre}, {municipio}", "titulo": l.nombre, "detalle": municipio,
             "lat": l.lat, "lon": l.lon} for _, _, l in candidatos[:3]]

def _mapbox_suggest(t, cerca_lat, cerca_lon):
    """Search Box /suggest + /retrieve: el que MEJOR tolera errores ("imbanco" ->
    Imbanaco). Se usa solo de respaldo (cuando lo demas trae poco)."""
    import urllib.request as _ur, urllib.parse as _up, json as _json, uuid as _uuid
    sesion = str(_uuid.uuid4())
    params = {"q": t, "access_token": MAPBOX_TOKEN, "country": "co", "language": "es", "limit": "5",
              "session_token": sesion, "types": "poi,address,street,neighborhood,place,locality"}
    if cerca_lat is not None and cerca_lon is not None:
        params["proximity"] = f"{cerca_lon},{cerca_lat}"
    hdr = {"Referer": MAPBOX_REFERER, "User-Agent": "tukan-app/1.0"}
    req = _ur.Request("https://api.mapbox.com/search/searchbox/v1/suggest?" + _up.urlencode(params), headers=hdr)
    with _ur.urlopen(req, timeout=5) as r:
        sug = (_json.loads(r.read().decode("utf-8")).get("suggestions") or [])[:4]

    def traer(sg):
        try:
            u = ("https://api.mapbox.com/search/searchbox/v1/retrieve/" + _up.quote(sg["mapbox_id"]) + "?"
                 + _up.urlencode({"access_token": MAPBOX_TOKEN, "session_token": sesion}))
            with _ur.urlopen(_ur.Request(u, headers=hdr), timeout=5) as r:
                f = (_json.loads(r.read().decode("utf-8")).get("features") or [None])[0]
            c = (f or {}).get("geometry", {}).get("coordinates")
            if not (c and len(c) == 2):
                return None
            pr = f.get("properties", {}) or {}
            titulo = pr.get("name") or sg.get("name")
            detalle = pr.get("full_address") or pr.get("place_formatted") or ""
            return {"nombre": f"{titulo}, {detalle}" if detalle else titulo, "titulo": titulo,
                    "detalle": detalle, "lat": c[1], "lon": c[0]}
        except Exception:
            return None
    with _cf.ThreadPoolExecutor(max_workers=4) as ex:
        return [x for x in ex.map(traer, [g for g in sug if g.get("mapbox_id")]) if x]

def _normalizar_busqueda(t: str) -> str:
    """'barrio San Fernando' -> 'San Fernando'; 'Calle 5 con Carrera 66' (la forma
    como hablamos en Colombia) -> 'Calle 5 # 66-00', que Mapbox SI ubica en la esquina."""
    t = _corregir_vias((t or "").strip())
    t = _re_bus.sub(r"^(barrio|br|b/|urbanizacion|urbanización|conjunto)\s+", "", t, flags=_re_bus.I)
    m = _RX_CRUCE.match(t)
    if m:
        via, num, _via2, num2, placa = m.groups()
        via_l = via.lower()
        via = {"cl": "Calle", "cll": "Calle", "cra": "Carrera", "cr": "Carrera", "kr": "Carrera",
               "kra": "Carrera", "av": "Avenida", "dg": "Diagonal", "tv": "Transversal",
               "tr": "Transversal"}.get(via_l, via.capitalize())
        t = f"{via} {num.strip()} # {num2.replace(' ', '')}-{placa or '00'}"
    return t

def _es_basura(nombre: str) -> bool:
    """Resultados que confunden: letras de otros alfabetos (ቺፒቻፔ) o 'first floor'."""
    n = (nombre or "").strip()
    if not n:
        return True
    for ch in n:
        if ch.isalpha() and ord(ch) > 0x24F:
            return True
    return n.lower().split(",")[0].strip() in ("first floor", "ground floor", "second floor", "piso 1")

def _ciudad_cercana(lat, lon, db: Session):
    """Nombre de la ciudad (Municipio) cuyo centro esta mas cerca de (lat, lon)."""
    if lat is None or lon is None:
        return None
    mejor, dist = None, 1e9
    for m in db.query(Municipio).filter(Municipio.centro_lat.isnot(None)).all():
        d = tarifas.distancia_km(lat, lon, m.centro_lat, m.centro_lon) or 1e9
        if d < dist:
            mejor, dist = m.nombre, d
    return mejor if dist <= 60 else None

RADIO_BUSQUEDA_KM = 40   # area metropolitana (Cali-Jamundi-Yumbo-Palmira/aeropuerto)

@app.get("/ubicacion/autocompletar")
def autocompletar_direccion(texto: str, cerca_lat: float = None, cerca_lon: float = None,
                            municipio: str = None, db: Session = Depends(get_db)):
    """Autocompletar acotado a la ZONA: Search Box (sitios con nombre, vias) +
    Geocoding v6 (nomenclatura) + OpenStreetMap con la ciudad (terminal, parques).
    Devuelve [{nombre, titulo, detalle, lat, lon}]. Falla en silencio."""
    original = (texto or "").strip()
    if len(original) < 3:
        return []
    t = _normalizar_busqueda(original)
    es_cruce = t != original and "#" in t
    # red de seguridad: si el punto que manda la app esta lejos de la ciudad del
    # usuario (mapa abierto con el centro por defecto), se busca alrededor de la ciudad
    if municipio:
        mu = db.query(Municipio).filter(Municipio.nombre == municipio).first()
        if mu and mu.centro_lat is not None:
            lejos = cerca_lat is None or cerca_lon is None or                 (tarifas.distancia_km(cerca_lat, cerca_lon, mu.centro_lat, mu.centro_lon) or 0) > 60
            if lejos:
                cerca_lat, cerca_lon = mu.centro_lat, mu.centro_lon
    resultados, vistos = [], set()

    def agregar(items):
        for r in items:
            tit = (r.get("titulo") or r["nombre"].split(",")[0]).strip()
            # basura o solo codigo postal ("760041 Santiago de Cali"): no ubica nada
            if not r.get("nombre") or _es_basura(tit) or _re_bus.match(r"^\d{5,6}\s", tit):
                continue
            # solo la zona metropolitana: nada de otra ciudad/departamento
            if cerca_lat is not None and cerca_lon is not None:
                km = tarifas.distancia_km(cerca_lat, cerca_lon, r["lat"], r["lon"])
                if km is not None and km > RADIO_BUSQUEDA_KM:
                    continue
            k = (round(r["lat"], 4), round(r["lon"], 4))
            if k in vistos:
                continue
            vistos.add(k)
            if not r.get("titulo"):
                partes = [x.strip() for x in r["nombre"].split(",")]
                r = {**r, "titulo": partes[0], "detalle": ", ".join(partes[1:])}
            # detalle limpio: sin pedazos raros ("ቺፒቻፔ", "first floor"), sin codigos
            # postales (760035), sin "Colombia" ni el departamento; "Santiago de Cali" -> "Cali"
            partes = []
            for x in (r.get("detalle") or "").split(","):
                x = _re_bus.sub(r"\b\d{5,6}\b", "", x).replace("Santiago de Cali", "Cali").strip()
                if not x or _es_basura(x) or x in ("Colombia", "Valle del Cauca", "Cauca", "Nariño", "Putumayo",
                                                    "Caquetá", "Huila", "Cali ciudad") or x in partes:
                    continue
                partes.append(x)
            limpio = ", ".join(partes)
            r = {**r, "detalle": limpio, "nombre": f"{r['titulo']}, {limpio}" if limpio else r["titulo"]}
            # mismo nombre y misma direccion = repetido (aunque el punto varie unos metros)
            kn = r["nombre"].lower()
            if kn in vistos:
                continue
            vistos.add(kn)
            resultados.append(r)

    def intentar(fn, *a):
        try:
            agregar(fn(*a))
        except Exception:
            pass

    ciudad_q = municipio or _ciudad_cercana(cerca_lat, cerca_lon, db)
    # 0) DIRECCION colombiana calculada con la malla de calles (Calle 9 # 43-30, Cra 5 con 66):
    #    va de PRIMERA; si es direccion, las tiendas del Search Box solo de relleno
    es_direccion = False
    try:
        if nomenclatura.parsear(original):
            es_direccion = True
            cal = nomenclatura.ubicar(original, ciudad_q or "",
                                      (cerca_lat, cerca_lon) if cerca_lat is not None else None)
            if cal:
                agregar([{"nombre": f"{cal['titulo']}, {cal['detalle']}", "titulo": cal["titulo"],
                          "detalle": cal["detalle"], "lat": cal["lat"], "lon": cal["lon"]}])
    except Exception:
        pass
    # sitios que Tukan ya conoce en esa ciudad (tolera errores)
    try:
        agregar(_lugares_conocidos(original, ciudad_q, db))
    except Exception:
        pass
    # una esquina ("Calle 5 con 66") la ubica mejor la nomenclatura (v6); lo demas,
    # el Search Box. Cada fuente en try/except: si una falla, siguen las otras.
    if es_cruce or es_direccion:
        # de la nomenclatura solo sirven las que traen placa ("Calle 5 66-10"); un
        # "Calle 5" pelado de otro pueblo no ubica la esquina
        try:
            agregar([r for r in _mapbox_geo(t, cerca_lat, cerca_lon) if "-" in r["nombre"].split(",")[0]])
        except Exception:
            pass
        if len(resultados) < 3:   # tiendas solo de relleno cuando es una direccion
            intentar(_mapbox_searchbox, original, cerca_lat, cerca_lon)
    else:
        intentar(_mapbox_searchbox, t, cerca_lat, cerca_lon)
        if len(resultados) < 4:
            intentar(_mapbox_geo, t, cerca_lat, cerca_lon)
    if len(resultados) < 4:
        ciudad = municipio or _ciudad_cercana(cerca_lat, cerca_lon, db)
        # OSM encuentra mejor los sitios si se le dice la ciudad ("Terminal ... Cali")
        intentar(_nominatim_geo, f"{t}, {ciudad}" if ciudad else t, cerca_lat, cerca_lon)
    # respaldo 1: palabras comunes mal escritas (jardin plasa -> jardin plaza)
    if len(resultados) < 3:
        corregido = _corregir_palabras(t)
        if corregido.lower() != t.lower():
            intentar(_mapbox_searchbox, corregido, cerca_lat, cerca_lon)
    # respaldo 2: el mas tolerante a errores de escritura (imbanco -> Imbanaco)
    if len(resultados) < 3:
        intentar(_mapbox_suggest, original, cerca_lat, cerca_lon)
    return resultados[:7]

@app.get("/ubicacion/buscar")
def buscar_coordenadas(texto: str, municipio: str = "Orito",
                       cerca_lat: float = None, cerca_lon: float = None,
                       db: Session = Depends(get_db)):
    """Texto -> coordenadas para el buscador. Primero busca ACOTADO a la ciudad
    (con su departamento real y una caja alrededor del centro): asi la nomenclatura
    ('Carrera 11', 'Calle 18') cae en ESA ciudad, no en otra. Si no encuentra y hay
    'cerca_lat/lon', cae al modo AMPLIO (sesgado) como respaldo."""
    # 1) lugar aprendido de esa ciudad
    conocido = buscar_lugar(texto, municipio, db)
    if conocido and conocido.lat is not None:
        return {"lat": conocido.lat, "lon": conocido.lon, "fuente": "lugar"}
    # 2) lo mismo que muestra el autocompletar (primera sugerencia): asi "Buscar" y
    #    la lista nunca se contradicen. Si no trae nada, siguen los respaldos de OSM.
    if cerca_lat is not None and cerca_lon is not None:
        try:
            cand = autocompletar_direccion(texto, cerca_lat, cerca_lon, municipio, db)
        except Exception:
            cand = []
        if cand:
            m = cand[0]
            return {"lat": m["lat"], "lon": m["lon"], "nombre": m["nombre"], "fuente": "mapbox"}
    # 3) acotado a DONDE MIRA el usuario (lo mas confiable: su GPS/centro del mapa;
    #    no depende de que el centro de la ciudad este bien configurado)
    if cerca_lat is not None and cerca_lon is not None:
        g = geocodificar_amplio(texto, cerca_lat, cerca_lon, acotado=True)
        if g:
            return {"lat": g[0], "lon": g[1], "nombre": g[2], "fuente": "cerca"}
    # 3) acotado a la ciudad configurada (por su centro), si no vino 'cerca'
    g = geocodificar_texto(texto, municipio, db)
    if g:
        return {"lat": g[0], "lon": g[1], "nombre": g[2], "fuente": "ciudad"}
    # 4) ultimo respaldo: amplio en toda Colombia, solo sesgado
    if cerca_lat is not None and cerca_lon is not None:
        g = geocodificar_amplio(texto, cerca_lat, cerca_lon)
        if g:
            return {"lat": g[0], "lon": g[1], "nombre": g[2], "fuente": "geocode"}
    return {"lat": None, "lon": None}

def zona_de_la_carrera(origen: str, destino: str, municipio: str, db: Session):
    """Si cualquiera de las dos puntas es vereda, la carrera es rural."""
    for punta in (origen, destino):
        lugar = buscar_lugar(punta, municipio, db)
        if lugar and lugar.zona == "rural":
            return "rural"
    return "urbano"

# ---- RUTA EXCLUSIVA DEL DUEÑO (fase de arranque) ----
# Las carreras de/al aeropuerto de Cali (Alfonso Bonilla Aragon, en Palmira) le
# llegan SOLO a un conductor (el dueño), y sus otras solicitudes se limitan a las
# que estan cerca de el. Se controla por config: telefono vacio = apagado.
AEROPUERTO_CALI = (3.5432, -76.3816)
AEROPUERTO_RADIO_KM = 3.0
_cache_excl = {"t": 0.0, "val": ("", 0.0, None)}

def _digitos(s):
    return "".join(ch for ch in (s or "") if ch.isdigit())

def _cfg_exclusivo():
    """(telefono del dueño, radio km para sus demas carreras, su tipo de vehiculo).
    Cache de 30 s: esto se consulta por cada carrera y cada conductor."""
    if _time.time() - _cache_excl["t"] < 30:
        return _cache_excl["val"]
    db = SessionLocal()
    try:
        tel = _digitos(leer_config("exclusivo_aeropuerto_tel", db, ""))[-10:]
        try:
            radio = float(leer_config("exclusivo_radio_km", db, "0") or 0)
        except Exception:
            radio = 0.0
        dueno = None
        if tel:
            dueno = next((u for u in db.query(Usuario).filter(Usuario.rol == "conductor").all()
                          if _digitos(u.telefono)[-10:] == tel), None)
        val = (tel if dueno else "", radio, dueno.tipo_vehiculo if dueno else None)
    except Exception:
        val = ("", 0.0, None)
    finally:
        db.close()
    _cache_excl.update(t=_time.time(), val=val)
    return val

def es_carrera_aeropuerto(c: Carrera):
    """Origen o destino a <= 3 km del aeropuerto, o (solo en Cali) el texto dice
    'aeropuerto' — en otros pueblos tambien hay aeropuerto y esos no cuentan."""
    for lat, lon in ((c.origen_lat, c.origen_lon), (c.destino_lat, c.destino_lon)):
        if lat is not None and lon is not None:
            d = tarifas.distancia_km(lat, lon, *AEROPUERTO_CALI)
            if d is not None and d <= AEROPUERTO_RADIO_KM:
                return True
    if c.municipio == "Cali":
        import unicodedata
        txt = unicodedata.normalize("NFD", f"{c.origen or ''} {c.destino or ''}").encode("ascii", "ignore").decode().lower()
        return "aeropuerto" in txt or "bonilla aragon" in txt
    return False

def le_sirve_la_carrera(conductor: Usuario, carrera: Carrera, con_radio: bool = True):
    """Mismo municipio y el vehiculo exacto que pidio el cliente.
    Si pidio carro es porque una moto no le sirve: no se le manda una moto.
    + Ruta exclusiva del dueño: aeropuerto solo para el; y a el (si con_radio) sus
    demas solicitudes solo si la recogida esta cerca. Al aceptar/contraofertar no
    se exige el radio (pudo moverse un poco desde que la vio)."""
    tel_excl, radio, tipo_dueno = _cfg_exclusivo()
    es_dueno = bool(tel_excl) and _digitos(conductor.telefono)[-10:] == tel_excl
    if tel_excl and carrera.vehiculo_pedido == tipo_dueno and es_carrera_aeropuerto(carrera):
        return es_dueno
    if conductor.municipio != carrera.municipio:
        return False
    if not conductor.tipo_vehiculo or not carrera.vehiculo_pedido:
        return False
    if conductor.tipo_vehiculo != carrera.vehiculo_pedido:
        return False
    if es_dueno and con_radio and radio > 0:
        ahora = datetime.now()
        # el radio solo vale el PRIMER MINUTO: si nadie la toma, tambien es para el
        edad = (ahora - carrera.fecha).total_seconds() if carrera.fecha else 1e9
        if edad < EXCLUSIVO_ESPERA_SEG:
            km = km_conductor_a_recogida(conductor, carrera, ahora)
            # solo se le oculta si SABEMOS que esta lejos (GPS reciente). Sin GPS reciente
            # (app en segundo plano) se le muestra de una: estaba a 244 m y le llegaba al minuto
            if km is not None and km > radio:
                return False
    return True

EXCLUSIVO_ESPERA_SEG = 60   # tras 1 min sin que nadie la tome, el dueño tambien la recibe

@nunca_falla
def avisar_dueno_si_sigue_libre(carrera_id: int):
    """Al minuto: si la carrera sigue buscando y el dueño no la recibio por el radio,
    se le avisa ahora (push normal, igual que a cualquier conductor)."""
    db = SessionLocal()
    mensajes = []
    try:
        carrera = db.query(Carrera).filter(Carrera.id == carrera_id).first()
        if not carrera or carrera.estado != "buscando":
            return
        tel_excl, _r, _t = _cfg_exclusivo()
        if not tel_excl:
            return
        con_oferta = {o.conductor_id for o in db.query(Oferta).filter(
            Oferta.carrera_id == carrera_id, Oferta.estado == "pendiente").all()}
        duenos = [c for c in _candidatos_carrera(carrera, db)
                  if _digitos(c.telefono)[-10:] == tel_excl and c.id not in con_oferta]
        mensajes = _mensajes_carrera(carrera, duenos, "Carrera libre")
    finally:
        db.close()
    limpiar_tokens_muertos(push.enviar(mensajes))

@app.get("/lugares")
def obtener_lugares(buscar: str = None, zona: str = None, municipio: str = None,
                    db: Session = Depends(get_db)):
    """Sugerencias para el campo de origen/destino, las mas usadas primero.
    No es una lista cerrada: el cliente puede escribir cualquier cosa."""
    q = db.query(Lugar).filter(Lugar.activo == "si")
    if buscar:
        q = q.filter(Lugar.nombre.ilike(f"%{buscar.strip()}%"))
    if zona:
        q = q.filter(Lugar.zona == zona)
    if municipio:
        q = q.filter(Lugar.municipio == municipio)
    return q.order_by(Lugar.usos.desc(), Lugar.nombre).limit(15).all()

@app.put("/lugares/{lugar_id}/zona")
def cambiar_zona_lugar(lugar_id: int, zona: str, db: Session = Depends(get_db)):
    """Para corregir desde el panel admin lo que la gente escribio a mano."""
    if zona not in ("urbano", "rural"):
        raise HTTPException(status_code=400, detail="Zona invalida: urbano o rural")
    lugar = db.query(Lugar).filter(Lugar.id == lugar_id).first()
    if not lugar:
        raise HTTPException(status_code=404, detail="Lugar no encontrado")
    lugar.zona = zona
    db.commit()
    db.refresh(lugar)
    return {"id": lugar.id, "nombre": lugar.nombre, "zona": lugar.zona,
            "usos": lugar.usos, "activo": lugar.activo}

@app.post("/lugares")
def crear_lugar(nombre: str, municipio: str = "Orito", zona: str = "urbano",
                lat: float = None, lon: float = None, db: Session = Depends(get_db),
                admin: Usuario = Depends(solo_admin)):
    """Alta de lugares (tambien para importar puntos de OpenStreetMap con coordenadas)."""
    if zona not in ("urbano", "rural"):
        raise HTTPException(status_code=400, detail="Zona invalida: urbano o rural")
    if buscar_lugar(nombre, municipio, db):
        raise HTTPException(status_code=400, detail="Ese lugar ya existe en ese municipio")
    lugar = Lugar(nombre=nombre.strip(), municipio=municipio, zona=zona, lat=lat, lon=lon)
    db.add(lugar)
    db.commit()
    db.refresh(lugar)
    return lugar

@app.put("/lugares/{lugar_id}")
def editar_lugar(lugar_id: int, zona: str = None, lat: float = None, lon: float = None,
                 activo: str = None, db: Session = Depends(get_db),
                 admin: Usuario = Depends(solo_admin)):
    """Corregir un lugar: zona, coordenadas o desactivarlo."""
    lugar = db.query(Lugar).filter(Lugar.id == lugar_id).first()
    if not lugar:
        raise HTTPException(status_code=404, detail="Lugar no encontrado")
    if zona is not None:
        if zona not in ("urbano", "rural"):
            raise HTTPException(status_code=400, detail="Zona invalida: urbano o rural")
        lugar.zona = zona
    if activo is not None:
        if activo not in ("si", "no"):
            raise HTTPException(status_code=400, detail="activo solo acepta si o no")
        lugar.activo = activo
    if lat is not None: lugar.lat = lat
    if lon is not None: lugar.lon = lon
    db.commit()
    db.refresh(lugar)
    return {"id": lugar.id, "nombre": lugar.nombre, "municipio": lugar.municipio,
            "zona": lugar.zona, "lat": lugar.lat, "lon": lugar.lon, "activo": lugar.activo}

@app.delete("/lugares/{lugar_id}")
def eliminar_lugar(lugar_id: int, db: Session = Depends(get_db)):
    lugar = db.query(Lugar).filter(Lugar.id == lugar_id).first()
    if not lugar:
        raise HTTPException(status_code=404, detail="Lugar no encontrado")
    lugar.activo = "no"
    db.commit()
    return {"ok": True}

TIPOS_CARGA = ("trasteo", "mercancia", "materiales", "objeto", "otro")
TAMANOS_CARGA = ("pequena", "mediana", "grande", "muy_grande")

def _datos_acarreo(c: Carrera, tipo, tamano, fotos, ayudantes, piso_o, piso_d, asc_o, asc_d,
                   recibe_nombre, recibe_tel):
    """Valida y guarda los detalles del acarreo. Lo raro se ignora (no tumba el pedido)."""
    c.tipo_carga = tipo if tipo in TIPOS_CARGA else None
    c.tamano_carga = tamano if tamano in TAMANOS_CARGA else None
    # solo fotos subidas por nosotros a Cloudinary, maximo 3
    urls = [u.strip() for u in (fotos or "").split(",") if u.strip().startswith("https://res.cloudinary.com/")]
    c.fotos_carga = ",".join(urls[:3]) or None
    c.ayudantes = max(0, min(int(ayudantes), 3)) if ayudantes is not None else None
    c.piso_origen = max(0, min(int(piso_o), 60)) if piso_o is not None else None
    c.piso_destino = max(0, min(int(piso_d), 60)) if piso_d is not None else None
    c.ascensor_origen = asc_o if asc_o in ("si", "no") else None
    c.ascensor_destino = asc_d if asc_d in ("si", "no") else None
    c.recibe_nombre = (recibe_nombre or "").strip()[:80] or None
    c.recibe_telefono = _digitos(recibe_tel)[:15] or None

# ======================= EVENTOS DE CADA CIUDAD =======================
# Se muestran en el inicio del pasajero ("Eventos en Cali") con "Ir en Tukan".
# Fechas en hora de Colombia tal cual las escribe el admin ("2026-12-25 19:00").

def _fecha_evento(t: str):
    t = (t or "").strip().replace("T", " ")
    if not t:
        return None
    for f in ("%Y-%m-%d %H:%M", "%Y-%m-%d"):
        try:
            return datetime.strptime(t[:16] if f.endswith("%M") else t[:10], f)
        except ValueError:
            pass
    raise HTTPException(status_code=400, detail="Fecha invalida: usa AAAA-MM-DD HH:MM (ej. 2026-12-25 19:00)")

def _evento_dict(e: EventoCiudad):
    return {"id": e.id, "municipio": e.municipio, "titulo": e.titulo, "descripcion": e.descripcion or "",
            "lugar": e.lugar, "lat": e.lat, "lon": e.lon,
            "inicio": e.inicio.strftime("%Y-%m-%d %H:%M") if e.inicio else None,
            "fin": e.fin.strftime("%Y-%m-%d %H:%M") if e.fin else None,
            "imagen": e.imagen, "enlace": e.enlace, "activo": e.activo or "si"}

def _evento_vigente(e: EventoCiudad, ahora: datetime):
    termina = e.fin or (e.inicio.replace(hour=23, minute=59) if e.inicio else None)
    return termina is None or termina >= ahora

@app.get("/eventos")
def eventos_de_ciudad(municipio: str, db: Session = Depends(get_db)):
    """Eventos activos y vigentes de la ciudad, del mas proximo al mas lejano."""
    ahora = ahora_colombia()
    filas = db.query(EventoCiudad).filter(EventoCiudad.municipio == municipio,
                                          EventoCiudad.activo == "si").all()
    vigentes = [e for e in filas if _evento_vigente(e, ahora)]
    vigentes.sort(key=lambda e: e.inicio or ahora)
    return [_evento_dict(e) for e in vigentes[:20]]

@app.post("/eventos/importar")
async def importar_eventos(clave: str, request: Request, db: Session = Depends(get_db)):
    """Carga varios eventos de una (lista JSON) con RESPALDO_CLAVE. No duplica: si ya
    existe uno con la misma ciudad, titulo e inicio, lo deja como esta."""
    esperada = os.environ.get("RESPALDO_CLAVE")
    if not esperada or not (clave and secrets.compare_digest(clave, esperada)):
        raise HTTPException(status_code=403, detail="Clave invalida")
    lista = await request.json()
    creados, saltados = [], 0
    for x in lista if isinstance(lista, list) else []:
        ini = _fecha_evento(x.get("inicio"))
        ya = db.query(EventoCiudad).filter(EventoCiudad.municipio == x.get("municipio"),
                                           EventoCiudad.titulo == x.get("titulo"), EventoCiudad.inicio == ini).first()
        if ya:
            saltados += 1
            continue
        e = EventoCiudad(municipio=x["municipio"], titulo=x["titulo"][:120], lugar=x["lugar"][:160],
                         lat=x.get("lat"), lon=x.get("lon"), inicio=ini,
                         fin=_fecha_evento(x.get("fin")) if x.get("fin") else None,
                         descripcion=(x.get("descripcion") or "")[:600] or None,
                         imagen=x.get("imagen") or None, enlace=x.get("enlace") or None, activo="si")
        db.add(e)
        creados.append(e.titulo)
    db.commit()
    return {"creados": creados, "ya_existian": saltados}

@app.get("/admin/eventos")
def eventos_admin(db: Session = Depends(get_db), admin: Usuario = Depends(solo_admin)):
    ahora = ahora_colombia()
    filas = db.query(EventoCiudad).order_by(EventoCiudad.inicio.desc()).limit(200).all()
    return [{**_evento_dict(e), "vigente": _evento_vigente(e, ahora)} for e in filas]

@app.post("/admin/eventos")
def crear_evento(municipio: str, titulo: str, lugar: str, inicio: str, fin: str = None,
                 lat: float = None, lon: float = None, descripcion: str = None,
                 imagen: str = None, enlace: str = None,
                 db: Session = Depends(get_db), admin: Usuario = Depends(solo_admin)):
    if not (titulo or "").strip() or not (lugar or "").strip():
        raise HTTPException(status_code=400, detail="Falta el nombre del evento o el lugar")
    e = EventoCiudad(municipio=municipio.strip(), titulo=titulo.strip()[:120], lugar=lugar.strip()[:160],
                     lat=lat, lon=lon, inicio=_fecha_evento(inicio), fin=_fecha_evento(fin) if fin else None,
                     descripcion=(descripcion or "").strip()[:600] or None,
                     imagen=(imagen or "").strip() or None, enlace=(enlace or "").strip() or None, activo="si")
    if not e.inicio:
        raise HTTPException(status_code=400, detail="Falta la fecha de inicio")
    db.add(e)
    db.commit()
    db.refresh(e)
    return _evento_dict(e)

@app.put("/admin/eventos/{evento_id}")
def editar_evento(evento_id: int, activo: str = None, titulo: str = None, lugar: str = None,
                  inicio: str = None, fin: str = None, lat: float = None, lon: float = None,
                  descripcion: str = None, imagen: str = None, enlace: str = None,
                  db: Session = Depends(get_db), admin: Usuario = Depends(solo_admin)):
    e = db.query(EventoCiudad).filter(EventoCiudad.id == evento_id).first()
    if not e:
        raise HTTPException(status_code=404, detail="Evento no encontrado")
    if activo in ("si", "no"):
        e.activo = activo
    if titulo:
        e.titulo = titulo.strip()[:120]
    if lugar:
        e.lugar = lugar.strip()[:160]
    if inicio:
        e.inicio = _fecha_evento(inicio)
    if fin is not None:
        e.fin = _fecha_evento(fin) if fin.strip() else None
    if lat is not None and lon is not None:
        e.lat, e.lon = lat, lon
    if descripcion is not None:
        e.descripcion = descripcion.strip()[:600] or None
    if imagen is not None:
        e.imagen = imagen.strip() or None
    if enlace is not None:
        e.enlace = enlace.strip() or None
    db.commit()
    return _evento_dict(e)

@app.delete("/admin/eventos/{evento_id}")
def borrar_evento(evento_id: int, db: Session = Depends(get_db), admin: Usuario = Depends(solo_admin)):
    e = db.query(EventoCiudad).filter(EventoCiudad.id == evento_id).first()
    if not e:
        raise HTTPException(status_code=404, detail="Evento no encontrado")
    db.delete(e)
    db.commit()
    return {"ok": True}

@app.post("/admin/eventos/imagen")
async def subir_imagen_evento(file: UploadFile = File(...), admin: Usuario = Depends(solo_admin)):
    contenido = await file.read()
    if len(contenido) > 8 * 1024 * 1024:
        raise HTTPException(status_code=400, detail="La imagen es muy pesada (máx 8 MB)")
    r = cloudinary.uploader.upload(contenido, folder="orito-app/eventos",
                                   public_id=f"evento_{secrets.token_hex(6)}")
    return {"url": r["secure_url"]}

@app.post("/cargas/foto")
async def subir_foto_carga(file: UploadFile = File(...), actual: Usuario = Depends(usuario_actual)):
    """Foto de lo que se va a mover, ANTES de pedir el acarreo. Devuelve la URL que
    luego se manda en fotos_carga."""
    contenido = await file.read()
    if len(contenido) > 8 * 1024 * 1024:
        raise HTTPException(status_code=400, detail="La foto es muy pesada (máx 8 MB)")
    r = cloudinary.uploader.upload(contenido, folder="orito-app/cargas",
                                   public_id=f"carga_{actual.id}_{secrets.token_hex(6)}")
    return {"url": r["secure_url"]}

@app.post("/carreras/{carrera_id}/entrega")
async def registrar_entrega(carrera_id: int, tareas: BackgroundTasks, recibio: str,
                            file: UploadFile = File(None), db: Session = Depends(get_db),
                            actual: Usuario = Depends(usuario_actual)):
    """Prueba de entrega del acarreo: quien recibio + foto (opcional). La pone el
    transportador al terminar y al cliente le llega el aviso."""
    c = db.query(Carrera).filter(Carrera.id == carrera_id).first()
    if not c:
        raise HTTPException(status_code=404, detail="Carrera no encontrada")
    if actual.id != c.conductor_id and actual.rol != "admin":
        raise HTTPException(status_code=403, detail="Esta carrera no es tuya")
    nombre = (recibio or "").strip()[:80]
    if not nombre:
        raise HTTPException(status_code=400, detail="Escribe el nombre de quien recibió")
    if file is not None:
        contenido = await file.read()
        if contenido:
            r = cloudinary.uploader.upload(contenido, folder="orito-app/entregas",
                                           public_id=f"entrega_{carrera_id}_{secrets.token_hex(4)}")
            c.entrega_foto = r["secure_url"]
    c.entrega_recibio = nombre
    c.entregada_en = datetime.now()
    db.commit()
    tareas.add_task(avisar_entrega, c.id)
    return {"ok": True, "entrega_foto": c.entrega_foto, "entrega_recibio": c.entrega_recibio}

@nunca_falla
def avisar_entrega(carrera_id: int):
    db = SessionLocal()
    mensajes = []
    try:
        c = db.query(Carrera).filter(Carrera.id == carrera_id).first()
        cli = db.query(Usuario).filter(Usuario.id == c.cliente_id).first() if c else None
        if cli and cli.push_token:
            extra = " Mira la foto de la entrega en la app." if c.entrega_foto else ""
            mensajes = [push.mensaje(cli.push_token, "📦 Tu acarreo fue entregado",
                                     f"Lo recibió {c.entrega_recibio} en {c.destino}.{extra}",
                                     {"tipo": "acarreo_entregado", "carrera_id": c.id})]
    finally:
        db.close()
    limpiar_tokens_muertos(push.enviar(mensajes))

@app.post("/carreras")
def pedir_carrera(cliente_id: int, origen: str, destino: str, tareas: BackgroundTasks,
                  origen_detalle: str = None, destino_detalle: str = None,
                  notas: str = None, vehiculo_pedido: str = None,
                  origen_lat: float = None, origen_lon: float = None,
                  destino_lat: float = None, destino_lon: float = None,
                  tarifa_ofrecida: int = None, municipio: str = None,
                  recogida: str = None,
                  tipo_carga: str = None, tamano_carga: str = None, fotos_carga: str = None,
                  ayudantes: int = None, piso_origen: int = None, piso_destino: int = None,
                  ascensor_origen: str = None, ascensor_destino: str = None,
                  recibe_nombre: str = None, recibe_telefono: str = None,
                  db: Session = Depends(get_db),
                  actual: Usuario = Depends(usuario_actual)):
    exigir_dueño(actual, cliente_id)   # solo pides carreras para ti mismo
    cliente = db.query(Usuario).filter(Usuario.id == cliente_id).first()
    if not cliente:
        raise HTTPException(status_code=404, detail="Usuario no encontrado")
    if cliente.activo == "no":
        raise HTTPException(status_code=403, detail="Tu cuenta está desactivada. Comunícate con el soporte.")
    # trasteos: hora agendada de recogida (texto ISO local). Si no viene o no
    # se puede leer, queda "lo antes posible" (None) sin tumbar la carrera
    recogida_dt = None
    if recogida:
        try:
            recogida_dt = datetime.fromisoformat(recogida)
        except (ValueError, TypeError):
            recogida_dt = None
    # Una solicitud activa POR CATEGORIA: sigue sin poder pedir cinco taxis a la
    # vez, pero un acarreo (que puede quedar dias esperando, sobre todo si es
    # programado) ya no le bloquea pedir una carrera normal, ni al reves.
    es_carga_nueva = vehiculo_pedido in VEHICULOS_CARGA
    activas = db.query(Carrera).filter(
        Carrera.cliente_id == cliente_id,
        Carrera.estado.in_(["buscando", "aceptada", "en_sitio", "en_camino"])
    ).all()
    # auto-limpieza: una carrera NORMAL que quedo colgada (nadie la tomo, o el
    # conductor nunca la cerro) no debe bloquear al cliente para siempre. Pasado
    # cierto tiempo se da por abandonada y se cancela sola. Los trasteos NO se
    # tocan: pueden quedar dias esperando, sobre todo los programados.
    ahora = datetime.now()
    LIMITES = {"buscando": timedelta(minutes=30), "aceptada": timedelta(hours=2),
               "en_sitio": timedelta(hours=2), "en_camino": timedelta(hours=4)}
    libero = False
    vivas = []
    for a in activas:
        limite = None if (a.vehiculo_pedido in VEHICULOS_CARGA) else LIMITES.get(a.estado)
        if limite and a.fecha and (ahora - a.fecha) > limite:
            a.estado = "cancelada"   # abandonada: se libera
            libero = True
        else:
            vivas.append(a)
    if libero:
        db.commit()
    for a in vivas:
        if (a.vehiculo_pedido in VEHICULOS_CARGA) == es_carga_nueva:
            raise HTTPException(
                status_code=400,
                detail="Ya tienes un acarreo en curso. Espera a que lo tomen o cancelalo."
                if es_carga_nueva else "Ya tienes una carrera en curso. Termínala o cancélala para pedir otra.")
    # el municipio viene de donde ESTA el cliente (GPS o manual), no de su registro
    municipio = municipio or cliente.municipio or "Orito"
    permitidos = vehiculos_de(municipio, db)
    if vehiculo_pedido not in permitidos:
        raise HTTPException(
            status_code=400,
            detail=f"En {municipio} solo hay servicio de {' o '.join(permitidos) or 'ninguno'}")
    if tarifa_ofrecida is not None and tarifa_ofrecida <= 0:
        raise HTTPException(status_code=400, detail="La oferta debe ser mayor que cero")
    # si el punto vino de la lista o escrito (sin pin en el mapa), se heredan las
    # coordenadas que ese lugar ya aprendio: asi el seguimiento en vivo y la
    # tarifa sugerida funcionan igual que con pin
    if origen_lat is None:
        conocido = buscar_lugar(origen, municipio, db)
        if conocido and conocido.lat is not None:
            origen_lat, origen_lon = conocido.lat, conocido.lon
        else:
            g = geocodificar_texto(origen, municipio, db)
            if g:
                origen_lat, origen_lon = g[0], g[1]
    if destino_lat is None:
        conocido = buscar_lugar(destino, municipio, db)
        if conocido and conocido.lat is not None:
            destino_lat, destino_lon = conocido.lat, conocido.lon
        else:
            g = geocodificar_texto(destino, municipio, db)
            if g:
                destino_lat, destino_lon = g[0], g[1]
    # donde hay GPS se calcula distancia y tarifa sugerida; donde no, quedan vacias
    km = tarifas.distancia_por_calle(origen_lat, origen_lon, destino_lat, destino_lon)
    sugerida = tarifa_sugerida(municipio, vehiculo_pedido, km, db)
    # promo de lanzamiento (solo carreras de pasajeros): el minimo sugerido que se
    # guarda ya lleva el descuento, asi el cliente y el conductor ven lo mismo.
    _prom = promo_para(municipio, cliente, db)
    if _prom["activa"] and sugerida is not None and vehiculo_pedido not in VEHICULOS_CARGA:
        sugerida = _con_descuento(sugerida, _prom["pct"])

    carrera = Carrera(
        cliente_id=cliente.id, cliente_nombre=cliente.nombre, cliente_telefono=cliente.telefono,
        origen=origen, origen_detalle=origen_detalle, destino=destino,
        destino_detalle=destino_detalle, notas=notas,
        municipio=municipio, vehiculo_pedido=vehiculo_pedido,
        origen_lat=origen_lat, origen_lon=origen_lon,
        destino_lat=destino_lat, destino_lon=destino_lon,
        distancia_km=km, tarifa_sugerida=sugerida, tarifa_ofrecida=tarifa_ofrecida,
        zona=zona_de_la_carrera(origen, destino, municipio, db),
        recogida=recogida_dt,
    )
    if vehiculo_pedido in VEHICULOS_CARGA:
        _datos_acarreo(carrera, tipo_carga, tamano_carga, fotos_carga, ayudantes, piso_origen,
                       piso_destino, ascensor_origen, ascensor_destino, recibe_nombre, recibe_telefono)
    db.add(carrera)
    # ya no se graban lugares: origen y destino se fijan siempre por GPS/mapa,
    # asi que no hay lista pregrabada que alimentar (decision de precision)
    db.commit()
    db.refresh(carrera)
    tareas.add_task(avisar_carrera_nueva, carrera.id)
    return carrera_dict(carrera)

@app.get("/carreras/disponibles")
def carreras_disponibles(conductor_id: int = None, db: Session = Depends(get_db)):
    """Lo que ve el conductor: carreras libres de SU municipio y que le sirven
    segun su vehiculo. Sin conductor_id devuelve todas (para el panel admin).
    De la mas reciente a la mas antigua (feed en vivo tipo log)."""
    carreras = db.query(Carrera).filter(Carrera.estado == "buscando").order_by(Carrera.fecha.desc()).all()
    if conductor_id:
        conductor = db.query(Usuario).filter(Usuario.id == conductor_id).first()
        if not conductor:
            raise HTTPException(status_code=404, detail="Conductor no encontrado")
        carreras = [c for c in carreras if le_sirve_la_carrera(conductor, c)]
        # sus contraofertas pendientes: para mostrar "ya ofertaste $X" y no volver a
        # sonarle/saltarle por una carrera donde ya esta esperando al cliente
        mis_ofertas = {o.carrera_id: o.monto for o in db.query(Oferta).filter(
            Oferta.conductor_id == conductor_id, Oferta.estado == "pendiente").all()}
        # se anota, para ESTE conductor: a que distancia esta de cada recogida y si
        # ya le toca el aviso fuerte (cercano, o ya paso la ventana). La app ordena
        # por cercania y solo suena/salta por las que tienen 'alertar'.
        ahora = datetime.now()
        # pasajero: estrellas + foto de perfil (lo ve el conductor antes de aceptar)
        ids_cli = {c.cliente_id for c in carreras if c.cliente_id}
        rep = {}
        if ids_cli:
            for u in db.query(Usuario).filter(Usuario.id.in_(ids_cli)).all():
                rep[u.id] = (u.calificacion, u.foto_perfil)
        salida = []
        for c in carreras:
            d = carrera_dict(c)
            r = rep.get(c.cliente_id)
            d["cliente_calificacion"] = r[0] if r else None
            d["cliente_foto"] = r[1] if r else None
            km = km_conductor_a_recogida(conductor, c, ahora)
            d["km_a_recogida"] = round(km, 2) if km is not None else None
            d["mi_oferta"] = mis_ofertas.get(c.id)
            # si ya oferto en esta, no se le vuelve a alertar (espera al cliente)
            d["alertar"] = le_toca_aviso(conductor, c, ahora) and c.id not in mis_ofertas
            salida.append(d)
        return salida
    return [carrera_dict(c) for c in carreras]

@app.put("/carreras/{carrera_id}/aceptar")
def aceptar_carrera(carrera_id: int, conductor_id: int, tareas: BackgroundTasks, db: Session = Depends(get_db),
                    actual: Usuario = Depends(usuario_actual)):
    exigir_dueño(actual, conductor_id)
    conductor = db.query(Usuario).filter(Usuario.id == conductor_id, Usuario.rol == "conductor").first()
    if not conductor:
        raise HTTPException(status_code=404, detail="Conductor no encontrado")
    if not suscripcion_al_dia(conductor, db):
        raise HTTPException(status_code=402, detail="Tu suscripcion se vencio. Comunicate con el administrador para renovarla.")
    # una carrera a la vez: si ya tiene otra en curso (yendo a recoger, en el punto
    # o en viaje) no puede aceptar una segunda y quedar con dos en paralelo. La
    # solicitud NO desaparece: sigue en "buscando" para el (o para otro) hasta que
    # alguien la tome. Al terminar la suya, ya la puede aceptar.
    en_curso = db.query(Carrera).filter(
        Carrera.conductor_id == conductor_id,
        Carrera.estado.in_(["aceptada", "en_sitio", "en_camino"]),
        Carrera.id != carrera_id,
    ).first()
    if en_curso:
        raise HTTPException(status_code=409, detail="Ya tienes una carrera en curso. Termínala antes de aceptar otra.")
    pedida = db.query(Carrera).filter(Carrera.id == carrera_id).first()
    if pedida and not le_sirve_la_carrera(conductor, pedida, con_radio=False):
        raise HTTPException(status_code=403, detail="Esa carrera no es de tu municipio o pidieron otro tipo de vehiculo")
    # el conductor toma la carrera al precio que ofrecio el cliente (o sin precio
    # si no ofrecio nada). Update condicional: si dos aceptan a la vez, solo uno
    # encuentra la carrera en "buscando" y el otro recibe el 409.
    cambios = {"conductor_id": conductor_id, "estado": "aceptada", "aceptada_en": datetime.now()}
    if pedida and pedida.tarifa_ofrecida is not None:
        cambios["tarifa"] = pedida.tarifa_ofrecida
    tomada = db.query(Carrera).filter(
        Carrera.id == carrera_id,
        Carrera.estado == "buscando"
    ).update(cambios, synchronize_session=False)
    db.commit()
    if tomada == 0:
        raise HTTPException(status_code=409, detail="Esa carrera ya fue tomada por otro conductor")
    db.query(Oferta).filter(Oferta.carrera_id == carrera_id, Oferta.estado == "pendiente").update(
        {"estado": "descartada"}, synchronize_session=False)
    # ya quedo ocupado: se descartan TODAS sus ofertas pendientes en otras carreras,
    # asi ningun cliente puede aceptarle una vieja y dejarlo con dos en paralelo.
    db.query(Oferta).filter(Oferta.conductor_id == conductor_id, Oferta.estado == "pendiente").update(
        {"estado": "descartada"}, synchronize_session=False)
    db.commit()
    carrera = db.query(Carrera).filter(Carrera.id == carrera_id).first()
    tareas.add_task(avisar_carrera_aceptada, carrera_id)
    return carrera_dict(carrera, conductor)

# ---- negociacion tipo inDrive: el cliente ofrece, el conductor contraoferta,
#      el cliente elige. El que acepta el precio ofrecido se la lleva de una.

def oferta_dict(o: Oferta, conductor: Usuario = None):
    return {
        "id": o.id, "carrera_id": o.carrera_id, "conductor_id": o.conductor_id,
        "monto": o.monto, "estado": o.estado, "fecha": o.fecha,
        "conductor_nombre": conductor.nombre if conductor else None,
        "conductor_telefono": conductor.telefono if conductor else None,
        "conductor_placa": conductor.placa if conductor else None,
        "conductor_vehiculo": conductor.vehiculo if conductor else None,
        "conductor_tipo": conductor.tipo_vehiculo if conductor else None,
        # para que el pasajero decida con confianza (como en inDrive)
        "conductor_foto": conductor.foto_conductor if conductor else None,
        "conductor_calificacion": conductor.calificacion if conductor else None,
        "conductor_veh_color": conductor.veh_color if conductor else None,
        "conductor_fundador": (conductor.fundador or "no") if conductor else "no",
    }

@app.post("/carreras/{carrera_id}/ofertas")
def contraofertar(carrera_id: int, conductor_id: int, monto: int, tareas: BackgroundTasks,
                  db: Session = Depends(get_db), actual: Usuario = Depends(usuario_actual)):
    """El conductor propone otro precio. La carrera sigue 'buscando' hasta que el
    cliente elija. No pisa la asignacion: si ya la tomaron, no deja ofertar."""
    exigir_dueño(actual, conductor_id)
    if monto <= 0:
        raise HTTPException(status_code=400, detail="El monto debe ser mayor que cero")
    conductor = db.query(Usuario).filter(Usuario.id == conductor_id, Usuario.rol == "conductor").first()
    if not conductor:
        raise HTTPException(status_code=404, detail="Conductor no encontrado")
    if not suscripcion_al_dia(conductor, db):
        raise HTTPException(status_code=402, detail="Tu suscripcion se vencio. Comunicate con el administrador para renovarla.")
    # tampoco puede ofertar si ya va en otra carrera: si el cliente le aceptara la
    # oferta quedaria con dos en paralelo. Primero termina la que tiene.
    en_curso = db.query(Carrera).filter(
        Carrera.conductor_id == conductor_id,
        Carrera.estado.in_(["aceptada", "en_sitio", "en_camino"]),
    ).first()
    if en_curso:
        raise HTTPException(status_code=409, detail="Ya tienes una carrera en curso. Termínala antes de ofertar otra.")
    carrera = db.query(Carrera).filter(Carrera.id == carrera_id).first()
    if not carrera:
        raise HTTPException(status_code=404, detail="Carrera no encontrada")
    if carrera.estado != "buscando":
        raise HTTPException(status_code=409, detail="Esa carrera ya no esta disponible")
    if not le_sirve_la_carrera(conductor, carrera, con_radio=False):
        raise HTTPException(status_code=403, detail="Esa carrera no es de tu municipio o pidieron otro tipo de vehiculo")
    # una sola oferta por conductor: si ya habia, se actualiza el monto
    oferta = db.query(Oferta).filter(
        Oferta.carrera_id == carrera_id, Oferta.conductor_id == conductor_id,
        Oferta.estado == "pendiente").first()
    if oferta:
        oferta.monto = monto
    else:
        oferta = Oferta(carrera_id=carrera_id, conductor_id=conductor_id, monto=monto)
        db.add(oferta)
    db.commit()
    db.refresh(oferta)
    tareas.add_task(avisar_contraoferta, carrera_id, conductor_id, monto)
    return oferta_dict(oferta, conductor)

@app.get("/carreras/{carrera_id}/ofertas")
def ofertas_de_carrera(carrera_id: int, db: Session = Depends(get_db)):
    """Lo que ve el cliente: las contraofertas pendientes, mas barata primero."""
    ofertas = db.query(Oferta).filter(
        Oferta.carrera_id == carrera_id, Oferta.estado == "pendiente").order_by(Oferta.monto).all()
    ids = {o.conductor_id for o in ofertas}
    conductores = {u.id: u for u in db.query(Usuario).filter(Usuario.id.in_(ids)).all()} if ids else {}
    return [oferta_dict(o, conductores.get(o.conductor_id)) for o in ofertas]

@app.put("/carreras/{carrera_id}/aceptar-oferta")
def aceptar_oferta(carrera_id: int, oferta_id: int, tareas: BackgroundTasks, db: Session = Depends(get_db),
                   actual: Usuario = Depends(usuario_actual)):
    """El cliente acepta la contraoferta de un conductor. Update condicional para
    no chocar con un conductor que justo acepte el precio original."""
    duena = db.query(Carrera).filter(Carrera.id == carrera_id).first()
    if duena:
        exigir_dueño(actual, duena.cliente_id)
    oferta = db.query(Oferta).filter(Oferta.id == oferta_id, Oferta.carrera_id == carrera_id).first()
    if not oferta:
        raise HTTPException(status_code=404, detail="Oferta no encontrada")
    # el conductor pudo ocuparse entre que ofertó y que el cliente aceptó: si ya va
    # en otra carrera, no se le asigna esta (evita las dos en paralelo).
    ocupado = db.query(Carrera).filter(
        Carrera.conductor_id == oferta.conductor_id,
        Carrera.estado.in_(["aceptada", "en_sitio", "en_camino"]),
    ).first()
    if ocupado:
        oferta.estado = "descartada"
        db.commit()
        raise HTTPException(status_code=409, detail="Ese transportador ya está en otra carrera. Elige otra oferta o espera a que se desocupe.")
    tomada = db.query(Carrera).filter(
        Carrera.id == carrera_id, Carrera.estado == "buscando"
    ).update({"conductor_id": oferta.conductor_id, "estado": "aceptada", "tarifa": oferta.monto,
              "aceptada_en": datetime.now()},
             synchronize_session=False)
    db.commit()
    if tomada == 0:
        raise HTTPException(status_code=409, detail="Esa carrera ya fue tomada")
    oferta.estado = "aceptada"
    db.query(Oferta).filter(Oferta.carrera_id == carrera_id, Oferta.id != oferta_id,
                            Oferta.estado == "pendiente").update(
        {"estado": "descartada"}, synchronize_session=False)
    db.commit()
    carrera = db.query(Carrera).filter(Carrera.id == carrera_id).first()
    conductor = db.query(Usuario).filter(Usuario.id == oferta.conductor_id).first()
    tareas.add_task(avisar_oferta_aceptada, oferta.conductor_id, carrera_id)
    return carrera_dict(carrera, conductor)

# ==================== EXPRESOS: viajes ciudad a ciudad (por cupos) ====================
# El cliente publica un viaje intermunicipal (de su ciudad a otra), con N cupos a
# $X por cupo, punto de recogida y de entrega, y opcionalmente agendado. Los
# conductores de la ciudad de ORIGEN lo ven en "Otra ciudad", lo toman al precio
# del cliente o contraofertan (por cupo). Es un modulo aparte del transporte local.

def expreso_dict(e: Expreso, conductor: Usuario = None):
    return {
        "id": e.id, "cliente_id": e.cliente_id,
        "cliente_nombre": e.cliente_nombre, "cliente_telefono": e.cliente_telefono,
        "origen_municipio": e.origen_municipio, "destino_municipio": e.destino_municipio,
        "origen": e.origen, "origen_lat": e.origen_lat, "origen_lon": e.origen_lon,
        "destino_detalle": e.destino_detalle,
        "destino_lat": e.destino_lat, "destino_lon": e.destino_lon,
        "cupos": e.cupos, "precio_por_cupo": e.precio_por_cupo,
        "salida": e.salida, "notas": e.notas, "estado": e.estado,
        "conductor_id": e.conductor_id,
        "conductor_nombre": conductor.nombre if conductor else None,
        "conductor_telefono": conductor.telefono if conductor else None,
        "conductor_placa": conductor.placa if conductor else None,
        "conductor_vehiculo": conductor.vehiculo if conductor else None,
        "conductor_calificacion": conductor.calificacion if conductor else None,
        "conductor_lat": conductor.ubic_lat if conductor else None,
        "conductor_lon": conductor.ubic_lon if conductor else None,
        "conductor_ubic_fecha": conductor.ubic_fecha if conductor else None,
        "tarifa_cupo": e.tarifa_cupo, "fecha": e.fecha,
    }

def oferta_expreso_dict(o: OfertaExpreso, conductor: Usuario = None):
    return {
        "id": o.id, "expreso_id": o.expreso_id, "conductor_id": o.conductor_id,
        "monto": o.monto, "estado": o.estado,
        "conductor_nombre": conductor.nombre if conductor else None,
        "conductor_telefono": conductor.telefono if conductor else None,
        "conductor_placa": conductor.placa if conductor else None,
        "conductor_calificacion": conductor.calificacion if conductor else None,
    }

def _conductores_expreso(e: Expreso, db: Session):
    """Conductores de la ciudad de ORIGEN, conectados, con token y al dia."""
    return [
        c for c in db.query(Usuario).filter(
            Usuario.rol == "conductor",
            Usuario.municipio == e.origen_municipio,
            Usuario.disponible == "si",
            Usuario.push_token.isnot(None),
            Usuario.activo != "no",
        ).all()
        if suscripcion_al_dia(c, db)
    ]

@nunca_falla
def avisar_expreso_nuevo(expreso_id: int):
    """Le suena a los conductores de la ciudad de origen: hay un viaje a otra ciudad."""
    db = SessionLocal()
    mensajes = []
    try:
        e = db.query(Expreso).filter(Expreso.id == expreso_id).first()
        if not e or e.estado != "buscando":
            return
        cuando = "lo antes posible" if not e.salida else e.salida.strftime("%d/%m %I:%M %p")
        cuerpo = f"{e.origen_municipio} → {e.destino_municipio} · {e.cupos} cupo(s) a ${e.precio_por_cupo:,}/cupo · {cuando}".replace(",", ".")
        mensajes = [push.mensaje(c.push_token, "🚌 Viaje a otra ciudad", cuerpo,
                                 {"tipo": "expreso_nuevo", "expreso_id": e.id}) for c in _conductores_expreso(e, db)]
    finally:
        db.close()
    limpiar_tokens_muertos(push.enviar(mensajes))

@nunca_falla
def avisar_expreso_contraoferta(expreso_id: int, conductor_id: int, monto: int):
    db = SessionLocal()
    mensajes = []
    try:
        e = db.query(Expreso).filter(Expreso.id == expreso_id).first()
        if not e:
            return
        cliente = db.query(Usuario).filter(Usuario.id == e.cliente_id).first()
        conductor = db.query(Usuario).filter(Usuario.id == conductor_id).first()
        if not cliente or not cliente.push_token or not conductor:
            return
        mensajes = [push.mensaje(cliente.push_token, "Te proponen un precio (otra ciudad)",
                                 f"{conductor.nombre}: ${monto:,}/cupo".replace(",", "."),
                                 {"tipo": "expreso_contraoferta", "expreso_id": e.id})]
    finally:
        db.close()
    limpiar_tokens_muertos(push.enviar(mensajes))

@nunca_falla
def avisar_expreso_asignado(expreso_id: int, a_conductor: bool):
    """Avisa al conductor (si a_conductor) o al cliente que el expreso quedo asignado."""
    db = SessionLocal()
    mensajes = []
    try:
        e = db.query(Expreso).filter(Expreso.id == expreso_id).first()
        if not e:
            return
        conductor = db.query(Usuario).filter(Usuario.id == e.conductor_id).first() if e.conductor_id else None
        cliente = db.query(Usuario).filter(Usuario.id == e.cliente_id).first()
        destino = conductor if a_conductor else cliente
        if not destino or not destino.push_token:
            return
        if a_conductor:
            titulo, cuerpo = "Te aceptaron el viaje", f"Recoge en {e.origen} · {e.origen_municipio} → {e.destino_municipio}"
        else:
            titulo = "Ya tienes transportador"
            cuerpo = f"{conductor.nombre if conductor else ''} hará tu viaje a {e.destino_municipio}"
        mensajes = [push.mensaje(destino.push_token, titulo, cuerpo,
                                 {"tipo": "expreso_asignado", "expreso_id": e.id})]
    finally:
        db.close()
    limpiar_tokens_muertos(push.enviar(mensajes))

@app.post("/expresos")
def crear_expreso(cliente_id: int, destino_municipio: str, origen: str,
                  cupos: int, precio_por_cupo: int, tareas: BackgroundTasks,
                  origen_lat: float = None, origen_lon: float = None,
                  destino_detalle: str = None, destino_lat: float = None, destino_lon: float = None,
                  salida: str = None, notas: str = None,
                  db: Session = Depends(get_db), actual: Usuario = Depends(usuario_actual)):
    exigir_dueño(actual, cliente_id)
    cliente = db.query(Usuario).filter(Usuario.id == cliente_id).first()
    if not cliente:
        raise HTTPException(status_code=404, detail="Cliente no encontrado")
    if (cliente.activo or "si") == "no":
        raise HTTPException(status_code=403, detail="Tu cuenta está bloqueada. Comunícate con soporte.")
    origen_mun = cliente.municipio or "Orito"
    destino_municipio = (destino_municipio or "").strip()
    if not destino_municipio:
        raise HTTPException(status_code=400, detail="Elige la ciudad de destino")
    if destino_municipio == origen_mun:
        raise HTTPException(status_code=400, detail="El destino debe ser OTRA ciudad")
    if cupos <= 0 or cupos > 20:
        raise HTTPException(status_code=400, detail="Número de cupos inválido")
    if precio_por_cupo <= 0:
        raise HTTPException(status_code=400, detail="El valor por cupo debe ser mayor que cero")
    salida_dt = None
    if salida:
        try:
            salida_dt = datetime.fromisoformat(salida)
        except (ValueError, TypeError):
            salida_dt = None
    e = Expreso(
        cliente_id=cliente.id, cliente_nombre=cliente.nombre, cliente_telefono=cliente.telefono,
        origen_municipio=origen_mun, destino_municipio=destino_municipio, origen=origen,
        origen_lat=origen_lat, origen_lon=origen_lon, destino_detalle=destino_detalle,
        destino_lat=destino_lat, destino_lon=destino_lon,
        cupos=cupos, precio_por_cupo=precio_por_cupo, salida=salida_dt, notas=notas)
    db.add(e)
    db.commit()
    db.refresh(e)
    tareas.add_task(avisar_expreso_nuevo, e.id)
    return expreso_dict(e)

@app.get("/expresos/disponibles")
def expresos_disponibles(conductor_id: int = None, db: Session = Depends(get_db)):
    """Lo que ve el conductor en 'Otra ciudad': viajes que SALEN de su ciudad. Sin
    conductor_id devuelve todos los que estan buscando (para el panel)."""
    # NO ofrecer los VENCIDOS: si tienen fecha de salida y ya paso (con ~3h de gracia
    # por si el viaje arranca tarde), se consideran colgados y no se muestran. Los "lo
    # antes posible" (salida = None) siempre se ven. El cliente los maneja desde su
    # lista con Reprogramar / Ejecutado / Cancelar.
    limite = datetime.now() - timedelta(hours=3)
    q = (db.query(Expreso)
         .filter(Expreso.estado == "buscando")
         .filter((Expreso.salida.is_(None)) | (Expreso.salida >= limite))
         .order_by(Expreso.fecha.desc()))
    if conductor_id:
        conductor = db.query(Usuario).filter(Usuario.id == conductor_id).first()
        if not conductor:
            raise HTTPException(status_code=404, detail="Conductor no encontrado")
        q = q.filter(Expreso.origen_municipio == conductor.municipio)
        expresos = q.all()
        mis = {o.expreso_id: o.monto for o in db.query(OfertaExpreso).filter(
            OfertaExpreso.conductor_id == conductor_id, OfertaExpreso.estado == "pendiente").all()}
        salida = []
        for e in expresos:
            d = expreso_dict(e)
            d["mi_oferta"] = mis.get(e.id)
            salida.append(d)
        return salida
    return [expreso_dict(e) for e in q.all()]

@app.get("/expresos/cliente/{cliente_id}")
def expresos_del_cliente(cliente_id: int, db: Session = Depends(get_db)):
    expresos = db.query(Expreso).filter(Expreso.cliente_id == cliente_id).order_by(Expreso.fecha.desc()).limit(20).all()
    res = []
    for e in expresos:
        conductor = db.query(Usuario).filter(Usuario.id == e.conductor_id).first() if e.conductor_id else None
        res.append(expreso_dict(e, conductor))
    return res

@app.get("/expresos/conductor/{conductor_id}")
def expresos_del_conductor(conductor_id: int, db: Session = Depends(get_db)):
    expresos = db.query(Expreso).filter(
        Expreso.conductor_id == conductor_id,
        Expreso.estado.in_(["aceptado", "en_camino"])).order_by(Expreso.fecha.desc()).all()
    return [expreso_dict(e, db.query(Usuario).filter(Usuario.id == conductor_id).first()) for e in expresos]

@nunca_falla
def avisar_expreso_estado(expreso_id: int, estado: str):
    """Le avisa al cliente cuando el viaje ARRANCA (recogida hecha) o finaliza."""
    db = SessionLocal()
    mensajes = []
    try:
        e = db.query(Expreso).filter(Expreso.id == expreso_id).first()
        if not e:
            return
        cliente = db.query(Usuario).filter(Usuario.id == e.cliente_id).first()
        if not cliente or not cliente.push_token:
            return
        if estado == "en_camino":
            titulo, cuerpo = "🚗 Tu viaje empezó", f"Vas en camino a {e.destino_municipio}"
        elif estado == "finalizado":
            titulo, cuerpo = "🏁 Viaje finalizado", f"Llegaste a {e.destino_municipio}. ¡Buen viaje!"
        else:
            return
        mensajes = [push.mensaje(cliente.push_token, titulo, cuerpo, {"tipo": "expreso_estado", "expreso_id": e.id})]
    finally:
        db.close()
    limpiar_tokens_muertos(push.enviar(mensajes))

@app.put("/expresos/{expreso_id}/aceptar")
def aceptar_expreso(expreso_id: int, conductor_id: int, tareas: BackgroundTasks,
                    db: Session = Depends(get_db), actual: Usuario = Depends(usuario_actual)):
    exigir_dueño(actual, conductor_id)
    conductor = db.query(Usuario).filter(Usuario.id == conductor_id, Usuario.rol == "conductor").first()
    if not conductor:
        raise HTTPException(status_code=404, detail="Conductor no encontrado")
    if not suscripcion_al_dia(conductor, db):
        raise HTTPException(status_code=402, detail="Tu suscripcion se vencio. Renuevala para tomar viajes.")
    e = db.query(Expreso).filter(Expreso.id == expreso_id).first()
    if e and e.origen_municipio != conductor.municipio:
        raise HTTPException(status_code=403, detail="Ese viaje sale de otra ciudad")
    tomado = db.query(Expreso).filter(Expreso.id == expreso_id, Expreso.estado == "buscando").update(
        {"conductor_id": conductor_id, "estado": "aceptado", "tarifa_cupo": e.precio_por_cupo if e else None},
        synchronize_session=False)
    db.commit()
    if tomado == 0:
        raise HTTPException(status_code=409, detail="Ese viaje ya fue tomado por otro conductor")
    db.query(OfertaExpreso).filter(OfertaExpreso.expreso_id == expreso_id, OfertaExpreso.estado == "pendiente").update(
        {"estado": "descartada"}, synchronize_session=False)
    db.commit()
    tareas.add_task(avisar_expreso_asignado, expreso_id, False)   # avisa al cliente
    return expreso_dict(db.query(Expreso).filter(Expreso.id == expreso_id).first(), conductor)

@app.post("/expresos/{expreso_id}/ofertas")
def contraofertar_expreso(expreso_id: int, conductor_id: int, monto: int, tareas: BackgroundTasks,
                          db: Session = Depends(get_db), actual: Usuario = Depends(usuario_actual)):
    exigir_dueño(actual, conductor_id)
    if monto <= 0:
        raise HTTPException(status_code=400, detail="El monto por cupo debe ser mayor que cero")
    conductor = db.query(Usuario).filter(Usuario.id == conductor_id, Usuario.rol == "conductor").first()
    if not conductor:
        raise HTTPException(status_code=404, detail="Conductor no encontrado")
    if not suscripcion_al_dia(conductor, db):
        raise HTTPException(status_code=402, detail="Tu suscripcion se vencio.")
    e = db.query(Expreso).filter(Expreso.id == expreso_id).first()
    if not e:
        raise HTTPException(status_code=404, detail="Viaje no encontrado")
    if e.estado != "buscando":
        raise HTTPException(status_code=409, detail="Ese viaje ya no esta disponible")
    if e.origen_municipio != conductor.municipio:
        raise HTTPException(status_code=403, detail="Ese viaje sale de otra ciudad")
    oferta = db.query(OfertaExpreso).filter(
        OfertaExpreso.expreso_id == expreso_id, OfertaExpreso.conductor_id == conductor_id,
        OfertaExpreso.estado == "pendiente").first()
    if oferta:
        oferta.monto = monto
    else:
        oferta = OfertaExpreso(expreso_id=expreso_id, conductor_id=conductor_id, monto=monto)
        db.add(oferta)
    db.commit()
    db.refresh(oferta)
    tareas.add_task(avisar_expreso_contraoferta, expreso_id, conductor_id, monto)
    return oferta_expreso_dict(oferta, conductor)

@app.get("/expresos/{expreso_id}/ofertas")
def ofertas_de_expreso(expreso_id: int, db: Session = Depends(get_db)):
    ofertas = db.query(OfertaExpreso).filter(
        OfertaExpreso.expreso_id == expreso_id, OfertaExpreso.estado == "pendiente").order_by(OfertaExpreso.monto).all()
    ids = {o.conductor_id for o in ofertas}
    conductores = {u.id: u for u in db.query(Usuario).filter(Usuario.id.in_(ids)).all()} if ids else {}
    return [oferta_expreso_dict(o, conductores.get(o.conductor_id)) for o in ofertas]

@app.put("/expresos/{expreso_id}/aceptar-oferta")
def aceptar_oferta_expreso(expreso_id: int, oferta_id: int, tareas: BackgroundTasks,
                           db: Session = Depends(get_db), actual: Usuario = Depends(usuario_actual)):
    duena = db.query(Expreso).filter(Expreso.id == expreso_id).first()
    if duena:
        exigir_dueño(actual, duena.cliente_id)
    oferta = db.query(OfertaExpreso).filter(OfertaExpreso.id == oferta_id, OfertaExpreso.expreso_id == expreso_id).first()
    if not oferta:
        raise HTTPException(status_code=404, detail="Oferta no encontrada")
    tomado = db.query(Expreso).filter(Expreso.id == expreso_id, Expreso.estado == "buscando").update(
        {"conductor_id": oferta.conductor_id, "estado": "aceptado", "tarifa_cupo": oferta.monto},
        synchronize_session=False)
    db.commit()
    if tomado == 0:
        raise HTTPException(status_code=409, detail="Ese viaje ya fue tomado")
    oferta.estado = "aceptada"
    db.query(OfertaExpreso).filter(OfertaExpreso.expreso_id == expreso_id, OfertaExpreso.id != oferta_id,
                                   OfertaExpreso.estado == "pendiente").update({"estado": "descartada"}, synchronize_session=False)
    db.commit()
    tareas.add_task(avisar_expreso_asignado, expreso_id, True)   # avisa al conductor
    e = db.query(Expreso).filter(Expreso.id == expreso_id).first()
    conductor = db.query(Usuario).filter(Usuario.id == oferta.conductor_id).first()
    return expreso_dict(e, conductor)

@app.put("/expresos/{expreso_id}/estado")
def actualizar_estado_expreso(expreso_id: int, estado: str, tareas: BackgroundTasks,
                              db: Session = Depends(get_db), actual: Usuario = Depends(usuario_actual)):
    # en_camino = la SECUENCIA arranca al recoger al pasajero (no antes: el viaje
    # puede estar agendado). Luego finalizado. Cancelado en cualquier momento.
    if estado not in ("en_camino", "finalizado", "cancelado"):
        raise HTTPException(status_code=400, detail="Estado inválido para expreso")
    e = db.query(Expreso).filter(Expreso.id == expreso_id).first()
    if not e:
        raise HTTPException(status_code=404, detail="Viaje no encontrado")
    # lo maneja el cliente dueño o el conductor asignado
    if actual.id not in (e.cliente_id, e.conductor_id) and actual.rol != "admin":
        raise HTTPException(status_code=403, detail="No es tu viaje")
    e.estado = estado
    if estado == "cancelado":
        db.query(OfertaExpreso).filter(OfertaExpreso.expreso_id == expreso_id, OfertaExpreso.estado == "pendiente").update(
            {"estado": "descartada"}, synchronize_session=False)
    db.commit()
    if estado in ("en_camino", "finalizado"):
        tareas.add_task(avisar_expreso_estado, expreso_id, estado)
    return expreso_dict(e)

@app.put("/expresos/{expreso_id}/reprogramar")
def reprogramar_expreso(expreso_id: int, salida: str = None, db: Session = Depends(get_db),
                        actual: Usuario = Depends(usuario_actual)):
    """El cliente dueno cambia la FECHA de salida de su viaje (reprogramar). Lo deja
    de nuevo 'buscando' con la nueva fecha para que los conductores lo vean. Util para
    los viajes que se vencieron y quedaron colgados."""
    e = db.query(Expreso).filter(Expreso.id == expreso_id).first()
    if not e:
        raise HTTPException(status_code=404, detail="Viaje no encontrado")
    if actual.id != e.cliente_id and actual.rol != "admin":
        raise HTTPException(status_code=403, detail="No es tu viaje")
    if e.estado in ("en_camino", "finalizado"):
        raise HTTPException(status_code=400, detail="Un viaje en curso o terminado no se reprograma")
    nueva = None
    if salida:
        try:
            nueva = datetime.fromisoformat(salida)
        except ValueError:
            nueva = None
    e.salida = nueva
    e.estado = "buscando"      # vuelve a quedar disponible con la nueva fecha
    e.conductor_id = None      # reprograma de cero: si alguien lo habia tomado, se libera
    db.query(OfertaExpreso).filter(OfertaExpreso.expreso_id == expreso_id, OfertaExpreso.estado == "pendiente").update(
        {"estado": "descartada"}, synchronize_session=False)
    db.commit()
    db.refresh(e)
    return expreso_dict(e)

VENTANA_CANCELAR_SEG = 90   # el cliente cancela gratis hasta 1,5 min despues de que lo aceptan

def _segundos_para_cancelar(c: Carrera):
    """Cuanto le queda al cliente para cancelar. None = no aplica (aun buscando,
    o carrera vieja sin hora de aceptacion); 0 = ya se le paso el tiempo."""
    # el conductor ya llego al punto: se acabo el tiempo de cancelar, aunque no
    # hayan pasado los 1,5 min (p. ej. la carrera estaba a 20 m)
    if c.estado == "en_sitio":
        return 0
    if c.estado != "aceptada" or not c.aceptada_en:
        return None
    pasados = (datetime.now() - c.aceptada_en).total_seconds()
    return max(0, int(VENTANA_CANCELAR_SEG - pasados))

@app.put("/carreras/{carrera_id}/estado")
def actualizar_estado_carrera(carrera_id: int, estado: str, tareas: BackgroundTasks,
                              tarifa: int = None, motivo: str = None, db: Session = Depends(get_db),
                              actual: Usuario = Depends(usuario_actual)):
    validos = ["buscando", "aceptada", "en_sitio", "en_camino", "finalizada", "cancelada"]
    if estado not in validos:
        raise HTTPException(status_code=400, detail=f"Estado invalido. Validos: {', '.join(validos)}")
    carrera = db.query(Carrera).filter(Carrera.id == carrera_id).first()
    if not carrera:
        raise HTTPException(status_code=404, detail="Carrera no encontrada")
    if actual.rol != "admin" and actual.id not in (carrera.cliente_id, carrera.conductor_id):
        raise HTTPException(status_code=403, detail="Esta carrera no es tuya")
    # con el pasajero a bordo ya no se cancela: se finaliza o se resuelve hablando
    if estado == "cancelada" and carrera.estado == "en_camino":
        raise HTTPException(status_code=400, detail="El viaje ya esta en curso y no se puede cancelar. Si hay un problema, llama al conductor.")
    if estado == "cancelada":
        quien = "admin" if actual.rol == "admin" else ("cliente" if actual.id == carrera.cliente_id else "conductor")
        # el cliente tiene 1,5 min para arrepentirse despues de que lo aceptan; pasado
        # eso el conductor ya va en camino y cancelar le cuesta. Se resuelve hablando.
        if quien == "cliente" and carrera.estado == "en_sitio":
            raise HTTPException(status_code=409, detail="FUERA_DE_TIEMPO: El conductor ya está en el punto de recogida, ya no se puede cancelar. Comunícate con él o con soporte. Puede aplicar una penalidad.")
        if quien == "cliente" and _segundos_para_cancelar(carrera) == 0:
            raise HTTPException(status_code=409, detail="FUERA_DE_TIEMPO: Ya pasó el tiempo para cancelar (1,5 min). El conductor va en camino; comunícate con él o con soporte. Puede aplicar una penalidad.")
        carrera.cancelada_en = datetime.now()
        carrera.cancelada_por = quien
        carrera.motivo_cancelacion = (motivo or "").strip()[:300] or None
        # si ya habia conductor asignado, la otra parte se entera al instante
        if carrera.conductor_id:
            tareas.add_task(avisar_carrera_cancelada, carrera.id)
    # llegada al punto de recogida: se guarda el momento y se avisa al cliente
    if estado == "en_sitio" and carrera.llego_recogida is None:
        carrera.llego_recogida = datetime.now()
        tareas.add_task(avisar_conductor_llego, carrera.id)
    carrera.estado = estado
    if tarifa is not None:
        carrera.tarifa = tarifa
    db.commit()
    db.refresh(carrera)
    conductor = db.query(Usuario).filter(Usuario.id == carrera.conductor_id).first() if carrera.conductor_id else None
    return carrera_dict(carrera, conductor)

@app.put("/carreras/{carrera_id}/calificar")
def calificar_carrera(carrera_id: int, estrellas: int, comentario: str = None,
                      db: Session = Depends(get_db), actual: Usuario = Depends(usuario_actual)):
    """Calificacion mutua al terminar (1 a 5) con comentario opcional. El cliente
    califica al conductor y el conductor al cliente; segun quien llama se guarda en
    el campo que toca y se recalcula el promedio del usuario calificado."""
    if estrellas < 1 or estrellas > 5:
        raise HTTPException(status_code=400, detail="Las estrellas van de 1 a 5")
    carrera = db.query(Carrera).filter(Carrera.id == carrera_id).first()
    if not carrera:
        raise HTTPException(status_code=404, detail="Carrera no encontrada")
    coment = (comentario or "").strip()[:500] or None
    if actual.id == carrera.cliente_id:
        carrera.estrellas_conductor = estrellas        # el cliente califica al conductor
        carrera.comentario_conductor = coment
        calificado_id, campo = carrera.conductor_id, "conductor"
    elif actual.id == carrera.conductor_id:
        carrera.estrellas_cliente = estrellas          # el conductor califica al cliente
        carrera.comentario_cliente = coment
        calificado_id, campo = carrera.cliente_id, "cliente"
    else:
        raise HTTPException(status_code=403, detail="Esta carrera no es tuya")
    db.commit()
    _recalcular_calificacion(calificado_id, campo, db)
    db.commit()
    return {"ok": True}

def _recalcular_calificacion(usuario_id, campo, db):
    """Promedio de estrellas que ha recibido un usuario (como conductor o cliente),
    guardado en Usuario.calificacion para mostrarlo sin recalcular cada vez."""
    if not usuario_id:
        return
    if campo == "conductor":
        vals = [c.estrellas_conductor for c in db.query(Carrera).filter(
            Carrera.conductor_id == usuario_id, Carrera.estrellas_conductor.isnot(None)).all()]
    else:
        vals = [c.estrellas_cliente for c in db.query(Carrera).filter(
            Carrera.cliente_id == usuario_id, Carrera.estrellas_cliente.isnot(None)).all()]
    if vals:
        u = db.query(Usuario).filter(Usuario.id == usuario_id).first()
        if u:
            u.calificacion = round(sum(vals) / len(vals), 2)

@app.get("/conductores/{conductor_id}/reputacion")
def reputacion_conductor(conductor_id: int, db: Session = Depends(get_db)):
    """Lo que el pasajero ve antes de subirse y lo que el admin usa para tomar
    accion: promedio, comentarios recientes (sin nombre del cliente) y cancelaciones."""
    u = db.query(Usuario).filter(Usuario.id == conductor_id).first()
    if not u:
        raise HTTPException(status_code=404, detail="Conductor no encontrado")
    suyas = db.query(Carrera).filter(Carrera.conductor_id == conductor_id).order_by(Carrera.fecha.desc()).all()
    calificadas = [c for c in suyas if c.estrellas_conductor is not None]
    comentarios = [{"estrellas": c.estrellas_conductor, "comentario": c.comentario_conductor,
                    "fecha": c.fecha} for c in calificadas if c.comentario_conductor][:15]
    dist = {i: sum(1 for c in calificadas if c.estrellas_conductor == i) for i in range(1, 6)}
    return {
        "conductor_id": u.id, "nombre": u.nombre,
        "calificacion": u.calificacion,
        "total_calificaciones": len(calificadas),
        "distribucion": dist,
        "finalizadas": sum(1 for c in suyas if c.estado == "finalizada"),
        "canceladas_por_conductor": sum(1 for c in suyas if c.estado == "cancelada" and c.cancelada_por == "conductor"),
        "canceladas_por_cliente": sum(1 for c in suyas if c.estado == "cancelada" and c.cancelada_por == "cliente"),
        "comentarios": comentarios,
    }

@app.get("/carreras/cliente/{cliente_id}")
def carreras_del_cliente(cliente_id: int, db: Session = Depends(get_db)):
    carreras = db.query(Carrera).filter(Carrera.cliente_id == cliente_id).order_by(Carrera.fecha.desc()).all()
    return con_conductor(carreras, db)

@app.get("/carreras/conductor/{conductor_id}")
def carreras_del_conductor(conductor_id: int, db: Session = Depends(get_db)):
    carreras = db.query(Carrera).filter(Carrera.conductor_id == conductor_id).order_by(Carrera.fecha.desc()).all()
    return con_conductor(carreras, db)

def _periodos_desde():
    """Inicios de dia, semana (lunes), mes y año para agrupar."""
    ahora = datetime.now()
    dia = ahora.replace(hour=0, minute=0, second=0, microsecond=0)
    return {
        "hoy": dia,
        "semana": dia - timedelta(days=dia.weekday()),
        "mes": dia.replace(day=1),
        "anio": dia.replace(month=1, day=1),
        "total": datetime.min,
    }

def _resumen(carreras, desde):
    """Cuenta carreras y suma lo ganado (tarifa) desde una fecha."""
    hechas = [c for c in carreras if c.fecha and c.fecha >= desde]
    return {"carreras": len(hechas), "ganado": sum((c.tarifa or 0) for c in hechas)}

@app.get("/conductores/{conductor_id}/estadisticas")
def estadisticas_conductor(conductor_id: int, db: Session = Depends(get_db)):
    """Dashboard del conductor: carreras y ganancias por dia/semana/mes/año.
    Solo cuenta las finalizadas (las que de verdad hizo y cobro)."""
    conductor = db.query(Usuario).filter(Usuario.id == conductor_id, Usuario.rol == "conductor").first()
    if not conductor:
        raise HTTPException(status_code=404, detail="Conductor no encontrado")
    finalizadas = db.query(Carrera).filter(
        Carrera.conductor_id == conductor_id, Carrera.estado == "finalizada").all()
    periodos = _periodos_desde()
    return {p: _resumen(finalizadas, desde) for p, desde in periodos.items()}

@app.get("/estadisticas")
def estadisticas_globales(db: Session = Depends(get_db), admin: Usuario = Depends(solo_admin)):
    """Para el dueño: pulso del negocio. Volumen de carreras y plata movida por
    periodo, mas conteos utiles para medir el desempeño de la app."""
    finalizadas = db.query(Carrera).filter(Carrera.estado == "finalizada").all()
    periodos = _periodos_desde()
    resumen = {p: _resumen(finalizadas, desde) for p, desde in periodos.items()}
    todas = db.query(Carrera).all()
    conductores = db.query(Usuario).filter(Usuario.rol == "conductor").all()
    # embudo de difusion: visitas a /app y descargas del APK, hoy y total
    hoy = periodos["hoy"]
    eventos = db.query(Evento).all()
    def cuenta(tipo, desde):
        return sum(1 for e in eventos if e.tipo == tipo and e.fecha and e.fecha >= desde)
    return {
        **resumen,
        "clientes": db.query(Usuario).filter(Usuario.rol == "cliente").count(),
        "conductores": len(conductores),
        "conductores_al_dia": sum(1 for c in conductores if suscripcion_al_dia(c, db)),
        "carreras_totales": len(todas),
        "canceladas": sum(1 for c in todas if c.estado == "cancelada"),
        "en_curso": sum(1 for c in todas if c.estado in ("buscando", "aceptada", "en_sitio", "en_camino")),
        "visitas_hoy": cuenta("visita_pagina", hoy),
        "visitas_total": cuenta("visita_pagina", datetime.min),
        "descargas_hoy": cuenta("descarga_apk", hoy),
        "descargas_total": cuenta("descarga_apk", datetime.min),
        # cuantos se registraron con cada codigo de grupo (mide si los grupos funcionan)
        "comunidad": {cod: db.query(Usuario).filter(Usuario.referido_por == cod).count()
                      for cod in CODIGOS_COMUNIDAD},
    }

@app.get("/carreras")
def todas_las_carreras(db: Session = Depends(get_db), admin: Usuario = Depends(solo_admin)):
    carreras = db.query(Carrera).order_by(Carrera.fecha.desc()).all()
    return con_conductor(carreras, db)

def medios_pago(u: Usuario):
    """Los medios de pago que el conductor acepta, para mostrarle al cliente."""
    return {
        "efectivo": (u.pago_efectivo or "si") == "si",
        "nequi": u.pago_nequi or "",
        "daviplata": u.pago_daviplata or "",
        "bancolombia": u.pago_bancolombia or "",
        "breb": u.pago_breb or "",
    }

def fotos_de(u: Usuario):
    return {"conductor": u.foto_conductor, "vehiculo": u.foto_vehiculo,
            "tarjeta": u.foto_tarjeta, "licencia": u.foto_licencia,
            "cedula": u.foto_cedula, "soat": u.foto_soat, "perfil": u.foto_perfil}

# tipos de foto/documento validos para el endpoint de subida
TIPOS_FOTO = ("conductor", "vehiculo", "tarjeta", "licencia", "cedula", "soat", "perfil")

@app.get("/usuarios/{usuario_id}/perfil")
def obtener_perfil(usuario_id: int, db: Session = Depends(get_db)):
    u = db.query(Usuario).filter(Usuario.id == usuario_id).first()
    if not u:
        raise HTTPException(status_code=404, detail="Usuario no encontrado")
    return {"id": u.id, "nombre": u.nombre, "telefono": u.telefono, "rol": u.rol,
            "municipio": u.municipio, "tipo_vehiculo": u.tipo_vehiculo, "placa": u.placa,
            "vehiculo": u.vehiculo, "veh_color": u.veh_color, "veh_modelo": u.veh_modelo,
            "verificado": u.verificado or "no", "disponible": u.disponible,
            "calificacion": u.calificacion, "suscripcion_hasta": u.suscripcion_hasta,
            "dias_restantes": dias_restantes(u), "al_dia": suscripcion_al_dia(u, db),
            "pagos": medios_pago(u), "fotos": fotos_de(u), "fundador": u.fundador or "no"}

@app.get("/usuarios/{usuario_id}/lugares")
def listar_lugares_guardados(usuario_id: int, db: Session = Depends(get_db)):
    """Lugares guardados del usuario (Casa, Trabajo, favoritos) para pedir rapido."""
    ls = db.query(LugarGuardado).filter(LugarGuardado.usuario_id == usuario_id).order_by(LugarGuardado.fecha.desc()).all()
    return [{"id": l.id, "etiqueta": l.etiqueta, "direccion": l.direccion, "lat": l.lat, "lon": l.lon} for l in ls]

@app.post("/usuarios/{usuario_id}/lugares")
def guardar_lugar(usuario_id: int, etiqueta: str, direccion: str = "", lat: float = None, lon: float = None,
                  db: Session = Depends(get_db), actual: Usuario = Depends(usuario_actual)):
    """Guarda (o actualiza) un lugar. Casa y Trabajo son unicos por usuario."""
    exigir_dueño(actual, usuario_id)
    et = (etiqueta or "").strip() or "Favorito"
    existente = None
    if et.lower() in ("casa", "trabajo"):
        existente = db.query(LugarGuardado).filter(
            LugarGuardado.usuario_id == usuario_id, LugarGuardado.etiqueta.ilike(et)).first()
    if existente:
        existente.direccion, existente.lat, existente.lon = direccion, lat, lon
        db.commit(); db.refresh(existente); l = existente
    else:
        l = LugarGuardado(usuario_id=usuario_id, etiqueta=et, direccion=direccion, lat=lat, lon=lon)
        db.add(l); db.commit(); db.refresh(l)
    return {"id": l.id, "etiqueta": l.etiqueta, "direccion": l.direccion, "lat": l.lat, "lon": l.lon}

@app.delete("/lugares-guardados/{lugar_id}")
def borrar_lugar_guardado(lugar_id: int, db: Session = Depends(get_db), actual: Usuario = Depends(usuario_actual)):
    l = db.query(LugarGuardado).filter(LugarGuardado.id == lugar_id).first()
    if l:
        exigir_dueño(actual, l.usuario_id)
        db.delete(l); db.commit()
    return {"ok": True}

@app.get("/usuarios/{usuario_id}/referidos")
def mis_referidos(usuario_id: int, db: Session = Depends(get_db)):
    """Codigo propio para invitar + a cuantos ha invitado (y sus nombres)."""
    u = db.query(Usuario).filter(Usuario.id == usuario_id).first()
    if not u:
        raise HTTPException(status_code=404, detail="Usuario no encontrado")
    if not u.codigo_referido:   # usuarios viejos: se les genera al primer vistazo
        u.codigo_referido = generar_codigo_referido(u); db.commit()
    invitados = db.query(Usuario).filter(Usuario.referido_por == u.codigo_referido).order_by(Usuario.id.desc()).all()
    # cuantos de los invitados ya PIDIERON al menos una carrera (premio por uso real)
    ids = [x.id for x in invitados]
    con_carrera = 0
    if ids:
        pedidores = {cid for (cid,) in db.query(Carrera.cliente_id)
                     .filter(Carrera.cliente_id.in_(ids)).distinct().all()}
        con_carrera = len(pedidores)
    META_REFERIDOS = 10
    return {"codigo": u.codigo_referido, "total": len(invitados),
            "con_carrera": con_carrera, "meta": META_REFERIDOS,
            "premio_listo": con_carrera >= META_REFERIDOS,
            "nombres": [x.nombre for x in invitados[:20]]}

@app.post("/usuarios/{usuario_id}/foto")
async def subir_foto_conductor(usuario_id: int, tipo: str, file: UploadFile = File(...),
                               db: Session = Depends(get_db),
                               actual: Usuario = Depends(usuario_actual)):
    exigir_dueño(actual, usuario_id)
    """Sube foto del conductor, del vehiculo, o un documento (tarjeta, licencia, cedula, soat)."""
    if tipo not in TIPOS_FOTO:
        raise HTTPException(status_code=400, detail=f"tipo invalido; use uno de {', '.join(TIPOS_FOTO)}")
    u = db.query(Usuario).filter(Usuario.id == usuario_id).first()
    if not u:
        raise HTTPException(status_code=404, detail="Usuario no encontrado")
    contenido = await file.read()
    resultado = cloudinary.uploader.upload(
        contenido, folder="orito-app/conductores",
        public_id=f"{tipo}_{usuario_id}", overwrite=True)
    url = resultado["secure_url"]
    setattr(u, f"foto_{tipo}", url)
    db.commit()
    return {"url": url}

@app.put("/usuarios/{usuario_id}/vehiculo")
def guardar_vehiculo(usuario_id: int, placa: str = None, vehiculo: str = None,
                     veh_color: str = None, veh_modelo: str = None,
                     db: Session = Depends(get_db), actual: Usuario = Depends(usuario_actual)):
    """El conductor completa/corrige los datos de su vehiculo (placa, color, modelo).
    Al cambiarlos vuelve a quedar 'sin verificar' para que el admin revise de nuevo."""
    exigir_dueño(actual, usuario_id)
    u = db.query(Usuario).filter(Usuario.id == usuario_id).first()
    if not u:
        raise HTTPException(status_code=404, detail="Usuario no encontrado")
    if placa is not None: u.placa = (placa.strip().upper() or None)
    if vehiculo is not None: u.vehiculo = (vehiculo.strip() or None)
    if veh_color is not None: u.veh_color = (veh_color.strip() or None)
    if veh_modelo is not None: u.veh_modelo = (veh_modelo.strip() or None)
    u.verificado = "no"   # cambio los datos: hay que re-verificar
    db.commit()
    db.refresh(u)
    return {"ok": True, "placa": u.placa, "vehiculo": u.vehiculo,
            "veh_color": u.veh_color, "veh_modelo": u.veh_modelo, "verificado": u.verificado}

@app.put("/usuarios/{usuario_id}/pagos")
def guardar_pagos(usuario_id: int, efectivo: str = None, nequi: str = None, daviplata: str = None,
                  bancolombia: str = None, breb: str = None, db: Session = Depends(get_db),
                  actual: Usuario = Depends(usuario_actual)):
    exigir_dueño(actual, usuario_id)
    """El conductor configura como quiere que le paguen (efectivo, Nequi, etc.).
    Se manda solo lo que cambia; lo demas queda igual."""
    u = db.query(Usuario).filter(Usuario.id == usuario_id).first()
    if not u:
        raise HTTPException(status_code=404, detail="Usuario no encontrado")
    if efectivo is not None:
        if efectivo not in ("si", "no"):
            raise HTTPException(status_code=400, detail="efectivo solo acepta si o no")
        u.pago_efectivo = efectivo
    if nequi is not None: u.pago_nequi = nequi.strip() or None
    if daviplata is not None: u.pago_daviplata = daviplata.strip() or None
    if bancolombia is not None: u.pago_bancolombia = bancolombia.strip() or None
    if breb is not None: u.pago_breb = breb.strip() or None
    db.commit()
    db.refresh(u)
    return {"ok": True, "pagos": medios_pago(u)}

@app.get("/conductores")
def obtener_conductores(db: Session = Depends(get_db), admin: Usuario = Depends(solo_admin)):
    """SOLO admin: trae telefonos y fotos de documentos (antes era publica)."""
    conductores = db.query(Usuario).filter(Usuario.rol == "conductor").all()
    hechas = dict(db.query(Carrera.conductor_id, func.count(Carrera.id)).filter(
        Carrera.estado == "finalizada").group_by(Carrera.conductor_id).all())
    return [{"id": u.id, "nombre": u.nombre, "telefono": u.telefono, "placa": u.placa,
             "fundador": u.fundador or "no", "activo": u.activo or "si", "calificacion": u.calificacion,
             "carreras_conductor": hechas.get(u.id, 0), "creado": getattr(u, "fecha_registro", None),
             "vehiculo": u.vehiculo, "disponible": u.disponible,
             "tipo_vehiculo": u.tipo_vehiculo, "municipio": u.municipio,
             "veh_color": u.veh_color, "veh_modelo": u.veh_modelo,
             "verificado": u.verificado or "no",
             "suscripcion_hasta": u.suscripcion_hasta,
             "dias_restantes": dias_restantes(u),
             "al_dia": suscripcion_al_dia(u, db),
             "fotos": fotos_de(u)} for u in conductores]

@app.put("/conductores/{conductor_id}/verificar")
def verificar_conductor(conductor_id: int, valor: str = "si",
                        db: Session = Depends(get_db),
                        admin: Usuario = Depends(solo_admin)):
    """El admin habilita (verificado='si') o quita la habilitacion despues de
    revisar los documentos del conductor."""
    u = db.query(Usuario).filter(Usuario.id == conductor_id, Usuario.rol == "conductor").first()
    if not u:
        raise HTTPException(status_code=404, detail="Conductor no encontrado")
    u.verificado = "si" if valor == "si" else "no"
    db.commit()
    return {"ok": True, "verificado": u.verificado}

@app.put("/conductores/{conductor_id}/ubicacion")
def reportar_ubicacion(conductor_id: int, lat: float, lon: float, tareas: BackgroundTasks,
                       db: Session = Depends(get_db)):
    """El conductor reporta donde va (cada pocos segundos mientras tiene carrera
    activa, incluso con la app en segundo plano). El cliente lo ve venir en el
    mapa. La respuesta avisa si aun tiene carrera activa: cuando ya no, el
    servicio de rastreo del telefono se apaga solo y no gasta bateria."""
    u = db.query(Usuario).filter(Usuario.id == conductor_id, Usuario.rol == "conductor").first()
    if not u:
        raise HTTPException(status_code=404, detail="Conductor no encontrado")
    u.ubic_lat, u.ubic_lon, u.ubic_fecha = lat, lon, datetime.now()
    db.commit()
    # auto-llegada: si va a recoger (aceptada) y ya esta encima del punto (<130 m),
    # pasa solo a "en_sitio" y le avisa al cliente, sin que tenga que tocar nada
    car = db.query(Carrera).filter(
        Carrera.conductor_id == conductor_id, Carrera.estado == "aceptada").first()
    if car and car.origen_lat is not None and car.llego_recogida is None:
        d = tarifas.distancia_km(lat, lon, car.origen_lat, car.origen_lon)
        if d is not None and d <= 0.13:
            car.estado = "en_sitio"
            car.llego_recogida = datetime.now()
            db.commit()
            tareas.add_task(avisar_conductor_llego, car.id)
    activa = db.query(Carrera).filter(
        Carrera.conductor_id == conductor_id,
        Carrera.estado.in_(["aceptada", "en_sitio", "en_camino"])).first() is not None
    return {"ok": True, "carrera_activa": activa}

@app.get("/conductores/{conductor_id}/estado-cuenta")
def estado_cuenta(conductor_id: int, db: Session = Depends(get_db)):
    """Lo que el conductor ve en su pantalla sobre su suscripcion."""
    conductor = db.query(Usuario).filter(Usuario.id == conductor_id, Usuario.rol == "conductor").first()
    if not conductor:
        raise HTTPException(status_code=404, detail="Conductor no encontrado")
    return {
        "al_dia": suscripcion_al_dia(conductor, db),
        "dias_restantes": dias_restantes(conductor),
        "cobro_activo": leer_config("cobro_activo", db, "no") == "si",
        "valor_mensual": valor_mensual_de(conductor, db),   # segun su vehiculo
        "tipo_vehiculo": conductor.tipo_vehiculo,
        "nequi_pagos": leer_config("nequi_pagos", db, ""),
        # a donde le paga el conductor la suscripcion a Tukan (los que esten configurados)
        "pagos_tukan": {
            "llave": leer_config("llave_pagos", db, ""),
            "nequi": leer_config("nequi_pagos", db, ""),
            "banco": leer_config("banco_pagos", db, ""),
            "banco_tipo": leer_config("banco_tipo", db, ""),
            "banco_numero": leer_config("banco_numero", db, ""),
            "banco_titular": leer_config("banco_titular", db, ""),
        },
    }

@app.put("/conductores/{conductor_id}")
def actualizar_conductor(conductor_id: int, placa: str = None, vehiculo: str = None,
                         disponible: str = None, tipo_vehiculo: str = None,
                         municipio: str = None, db: Session = Depends(get_db),
                         actual: Usuario = Depends(usuario_actual)):
    exigir_dueño(actual, conductor_id)
    conductor = db.query(Usuario).filter(Usuario.id == conductor_id).first()
    if not conductor:
        raise HTTPException(status_code=404, detail="Conductor no encontrado")
    if tipo_vehiculo is not None and tipo_vehiculo not in VEHICULOS_VALIDOS:
        raise HTTPException(status_code=400, detail="Tipo de vehiculo invalido")
    # cambiar de pueblo solo sirve si alla se permite su vehiculo: un mototaxista
    # en Orito no veria ni una carrera, y creeria que la app esta dañada
    if municipio is not None:
        permitidos = vehiculos_de(municipio, db)
        if not permitidos:
            raise HTTPException(status_code=400, detail=f"Todavia no operamos en {municipio}")
        futuro = tipo_vehiculo or conductor.tipo_vehiculo
        if futuro and futuro not in permitidos:
            raise HTTPException(
                status_code=400,
                detail=f"En {municipio} todavia no hay servicio de {futuro}. No recibirias solicitudes alla.")
    if placa is not None:
        conductor.placa = placa
    if vehiculo is not None:
        conductor.vehiculo = vehiculo
    if disponible is not None:
        conductor.disponible = disponible
    if tipo_vehiculo is not None:
        conductor.tipo_vehiculo = tipo_vehiculo
    if municipio is not None:
        conductor.municipio = municipio
    db.commit()
    db.refresh(conductor)
    return {"id": conductor.id, "nombre": conductor.nombre, "telefono": conductor.telefono,
            "placa": conductor.placa, "vehiculo": conductor.vehiculo, "disponible": conductor.disponible,
            "tipo_vehiculo": conductor.tipo_vehiculo, "municipio": conductor.municipio}