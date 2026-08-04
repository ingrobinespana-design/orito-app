from fastapi import FastAPI, Depends, HTTPException, File, UploadFile, BackgroundTasks, Request, Header
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy.orm import Session
from sqlalchemy import func
from database import SessionLocal, crear_tablas, Restaurante, Pedido, Usuario, Plato, Carrera, Lugar, Config, Municipio, Tarifa, Oferta, Evento, VEHICULOS_VALIDOS, VEHICULOS_CARGA
from datetime import datetime, timedelta
from passlib.context import CryptContext
from dotenv import load_dotenv
import logging
import push
import tarifas
import legal
import cloudinary
import cloudinary.uploader
import os
import secrets

load_dotenv()

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
    return {"whatsapp": leer_config("whatsapp_soporte", db, "")}

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
<meta property="og:title" content="Tukán 🦜 — Carreras y domicilios en Putumayo">
<meta property="og:description" content="Pide tu carrera en Puerto Asís y Orito. Descarga la app gratis. 1 mes gratis para los primeros 1.000.">
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
  <div class="sub">Carreras y domicilios amazónicos<br>Puerto Asís · Orito · Putumayo</div>

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

  <div class="promo">🎉 1 MES GRATIS para los primeros 1.000 registrados en Puerto Asís y Orito</div>

  <div style="margin-top:18px;font-size:14px">¿Dudas o ayuda para instalar?<br>
  <a class="wa" href="https://wa.me/573156009728">💬 Escríbenos al WhatsApp 315 600 9728</a></div>

  <div style="margin-top:16px;font-size:12px">
    <a href="/terminos" style="color:#A9CBB4">Términos</a> ·
    <a href="/privacidad" style="color:#A9CBB4">Privacidad y Habeas Data</a>
  </div>
  <div class="pie">Tukán · Delivery amazónico · Hecho en Putumayo 🦜</div>
</div></body></html>"""

@app.get("/terminos", response_class=HTMLResponse)
def pagina_terminos():
    return legal.terminos_html()

@app.get("/privacidad", response_class=HTMLResponse)
def pagina_privacidad():
    return legal.privacidad_html()

@app.post("/registro")
def registrar_usuario(request: Request, nombre: str, telefono: str, password: str, municipio: str = "Orito",
                      tipo_vehiculo: str = None, placa: str = None, vehiculo: str = None,
                      db: Session = Depends(get_db)):
    """Si viene tipo_vehiculo (moto o carro) se registra como conductor.
    Sin eso queda de cliente. No hay valor por defecto: quien maneja lo declara."""
    # freno anti-spam: nadie crea decenas de cuentas desde la misma IP. Generoso
    # para tolerar un lanzamiento donde varios se registran en la misma red.
    if paso_del_limite(("registro", ip_de(request)), 25, 3600):
        raise HTTPException(status_code=429, detail="Demasiados registros desde aqui. Intenta en un rato.")
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
    return {"id": usuario.id, "nombre": usuario.nombre, "telefono": usuario.telefono,
            "rol": usuario.rol, "restaurante_id": usuario.restaurante_id,
            "municipio": usuario.municipio, "tipo_vehiculo": usuario.tipo_vehiculo,
            "placa": usuario.placa, "vehiculo": usuario.vehiculo, "disponible": usuario.disponible,
            "token": usuario.token}

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

def tarifa_sugerida(municipio: str, vehiculo: str, km, db: Session):
    """Sugerencia segun el pueblo, el vehiculo y los km. Solo orienta la oferta
    del cliente; el precio de verdad lo negocian las partes."""
    if km is None:
        return None
    # 1) tarifa por VEHICULO si el pueblo la tiene (donde moto y carro cobran distinto)
    if vehiculo:
        t = db.query(Tarifa).filter(Tarifa.municipio == municipio, Tarifa.vehiculo == vehiculo).first()
        if t and t.valor_km:
            return tarifas.calcular_tarifa(km, t.base, t.valor_km, t.minima)
    # 2) respaldo: el $/km de la CIUDAD (el que se pone en el panel "Ciudades").
    #    Asi Pasto/Cali/Florencia muestran el sugerido al cliente aunque no tengan
    #    tarifa por vehiculo; es la MISMA base que ve el conductor (solo viaje aca).
    m = db.query(Municipio).filter(Municipio.nombre == municipio).first()
    if m and m.valor_km:
        return tarifas.calcular_tarifa(km, m.tarifa_base or 0, m.valor_km, m.tarifa_minima or 0)
    return None

@app.get("/tarifa")
def estimar_tarifa(municipio: str, vehiculo: str, origen_lat: float, origen_lon: float,
                   destino_lat: float, destino_lon: float, db: Session = Depends(get_db)):
    """Lo que la app muestra para orientar la oferta: 'son ~3.2 km, en carro la
    gente suele pagar ~$8.000'. El cliente ofrece lo que quiera desde ahi."""
    m = db.query(Municipio).filter(Municipio.nombre == municipio).first()
    if not m:
        raise HTTPException(status_code=404, detail="Municipio no encontrado")
    km = tarifas.distancia_por_calle(origen_lat, origen_lon, destino_lat, destino_lon)
    return {
        "distancia_km": km,
        "tarifa_sugerida": tarifa_sugerida(municipio, vehiculo, km, db),
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
def buscar_usuarios(buscar: str = "", db: Session = Depends(get_db), admin: Usuario = Depends(solo_admin)):
    """Busca usuarios por telefono o nombre, para soporte: identificar rapido a
    alguien y ver su actividad (carreras hechas y si tiene algo en curso)."""
    q = (buscar or "").strip()
    consulta = db.query(Usuario)
    if q:
        like = f"%{q}%"
        consulta = consulta.filter(Usuario.telefono.ilike(like) | Usuario.nombre.ilike(like))
    usuarios = consulta.order_by(Usuario.id.desc()).limit(25).all()
    activos = ["buscando", "aceptada", "en_sitio", "en_camino"]
    salida = []
    for u in usuarios:
        salida.append({
            "id": u.id, "nombre": u.nombre, "telefono": u.telefono, "rol": u.rol,
            "municipio": u.municipio, "calificacion": u.calificacion, "disponible": u.disponible,
            "activo": u.activo or "si",
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

@app.post("/admin/usuarios/{usuario_id}/reactivar")
def reactivar_usuario(usuario_id: int, db: Session = Depends(get_db), admin: Usuario = Depends(solo_admin)):
    """Reactiva una cuenta que se habia bloqueado."""
    u = db.query(Usuario).filter(Usuario.id == usuario_id).first()
    if not u:
        raise HTTPException(status_code=404, detail="Usuario no encontrado")
    u.activo = "si"
    db.commit()
    return {"ok": True, "nombre": u.nombre}

@app.post("/login")
def login(telefono: str, password: str, db: Session = Depends(get_db)):
    # anti-fuerza-bruta: se limita por telefono (no por IP, que la comparte medio
    # pueblo). Nadie adivina una contraseña a punta de miles de intentos.
    clave = ("login", telefono)
    if paso_del_limite(clave, 10, 900):
        raise HTTPException(status_code=429, detail="Demasiados intentos. Espera unos minutos e intenta de nuevo.")
    usuario = db.query(Usuario).filter(Usuario.telefono == telefono).first()
    if not usuario or not pwd_context.verify(password, usuario.password):
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
            "token": usuario.token}

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
        "conductor_pagos": medios_pago(conductor) if conductor else None,
        "conductor_foto": conductor.foto_conductor if conductor else None,
        "conductor_foto_vehiculo": conductor.foto_vehiculo if conductor else None,
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
        "conductor_calificacion": conductor.calificacion if conductor else None,
        "fecha": c.fecha,
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
    permitidas = ("cobro_activo", "valor_mensual_moto", "valor_mensual_carro", "nequi_pagos", "apk_url", "whatsapp_soporte")
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

@nunca_falla
def avisar_carrera_nueva(carrera_id: int):
    """Le suena el celular a todos los conductores conectados."""
    db = SessionLocal()
    try:
        carrera = db.query(Carrera).filter(Carrera.id == carrera_id).first()
        if not carrera or carrera.estado != "buscando":
            return
        conductores = [
            c for c in db.query(Usuario).filter(
                Usuario.rol == "conductor",
                Usuario.disponible == "si",
                Usuario.push_token.isnot(None),
                Usuario.activo != "no",
            ).all()
            # solo los del mismo municipio, con el vehiculo que pidieron y al dia
            if le_sirve_la_carrera(c, carrera) and suscripcion_al_dia(c, db)
        ]
        if not conductores:
            return
        aviso_zona = " (fuera del pueblo)" if carrera.zona == "rural" else ""
        oferta = f" · ofrece ${carrera.tarifa_ofrecida:,}".replace(",", ".") if carrera.tarifa_ofrecida else ""
        mensajes = [
            push.mensaje(
                c.push_token,
                f"Nueva carrera{aviso_zona}",
                f"De {carrera.origen} a {carrera.destino}{oferta}",
                {"tipo": "carrera_nueva", "carrera_id": carrera.id},
            )
            for c in conductores
        ]
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

@app.put("/usuarios/{usuario_id}/push-token")
def guardar_push_token(usuario_id: int, token: str, db: Session = Depends(get_db),
                       actual: Usuario = Depends(usuario_actual)):
    exigir_dueño(actual, usuario_id)
    """La app manda esto al entrar. Si el token ya estaba en otro usuario (celular
    prestado o compartido) se lo quita, para que los avisos no le lleguen al anterior."""
    usuario = db.query(Usuario).filter(Usuario.id == usuario_id).first()
    if not usuario:
        raise HTTPException(status_code=404, detail="Usuario no encontrado")
    db.query(Usuario).filter(Usuario.push_token == token, Usuario.id != usuario_id).update(
        {"push_token": None}, synchronize_session=False)
    usuario.push_token = token
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
    # 2) acotado a DONDE MIRA el usuario (lo mas confiable: su GPS/centro del mapa;
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

def le_sirve_la_carrera(conductor: Usuario, carrera: Carrera):
    """Mismo municipio y el vehiculo exacto que pidio el cliente.
    Si pidio carro es porque una moto no le sirve: no se le manda una moto."""
    if conductor.municipio != carrera.municipio:
        return False
    if not conductor.tipo_vehiculo or not carrera.vehiculo_pedido:
        return False
    return conductor.tipo_vehiculo == carrera.vehiculo_pedido

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

@app.post("/carreras")
def pedir_carrera(cliente_id: int, origen: str, destino: str, tareas: BackgroundTasks,
                  origen_detalle: str = None, destino_detalle: str = None,
                  notas: str = None, vehiculo_pedido: str = None,
                  origen_lat: float = None, origen_lon: float = None,
                  destino_lat: float = None, destino_lon: float = None,
                  tarifa_ofrecida: int = None, municipio: str = None,
                  recogida: str = None, db: Session = Depends(get_db),
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
    pedida = db.query(Carrera).filter(Carrera.id == carrera_id).first()
    if pedida and not le_sirve_la_carrera(conductor, pedida):
        raise HTTPException(status_code=403, detail="Esa carrera no es de tu municipio o pidieron otro tipo de vehiculo")
    # el conductor toma la carrera al precio que ofrecio el cliente (o sin precio
    # si no ofrecio nada). Update condicional: si dos aceptan a la vez, solo uno
    # encuentra la carrera en "buscando" y el otro recibe el 409.
    cambios = {"conductor_id": conductor_id, "estado": "aceptada"}
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
    carrera = db.query(Carrera).filter(Carrera.id == carrera_id).first()
    if not carrera:
        raise HTTPException(status_code=404, detail="Carrera no encontrada")
    if carrera.estado != "buscando":
        raise HTTPException(status_code=409, detail="Esa carrera ya no esta disponible")
    if not le_sirve_la_carrera(conductor, carrera):
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
    tomada = db.query(Carrera).filter(
        Carrera.id == carrera_id, Carrera.estado == "buscando"
    ).update({"conductor_id": oferta.conductor_id, "estado": "aceptada", "tarifa": oferta.monto},
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

@app.put("/carreras/{carrera_id}/estado")
def actualizar_estado_carrera(carrera_id: int, estado: str, tareas: BackgroundTasks,
                              tarifa: int = None, db: Session = Depends(get_db),
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
def calificar_carrera(carrera_id: int, estrellas: int, db: Session = Depends(get_db),
                      actual: Usuario = Depends(usuario_actual)):
    """Calificacion mutua al terminar (1 a 5). El cliente califica al conductor y
    el conductor al cliente; segun quien llama se guarda en el campo que toca y se
    recalcula el promedio del usuario calificado."""
    if estrellas < 1 or estrellas > 5:
        raise HTTPException(status_code=400, detail="Las estrellas van de 1 a 5")
    carrera = db.query(Carrera).filter(Carrera.id == carrera_id).first()
    if not carrera:
        raise HTTPException(status_code=404, detail="Carrera no encontrada")
    if actual.id == carrera.cliente_id:
        carrera.estrellas_conductor = estrellas        # el cliente califica al conductor
        calificado_id, campo = carrera.conductor_id, "conductor"
    elif actual.id == carrera.conductor_id:
        carrera.estrellas_cliente = estrellas          # el conductor califica al cliente
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
    return {"conductor": u.foto_conductor, "vehiculo": u.foto_vehiculo, "tarjeta": u.foto_tarjeta}

@app.get("/usuarios/{usuario_id}/perfil")
def obtener_perfil(usuario_id: int, db: Session = Depends(get_db)):
    u = db.query(Usuario).filter(Usuario.id == usuario_id).first()
    if not u:
        raise HTTPException(status_code=404, detail="Usuario no encontrado")
    return {"id": u.id, "nombre": u.nombre, "telefono": u.telefono, "rol": u.rol,
            "municipio": u.municipio, "tipo_vehiculo": u.tipo_vehiculo, "placa": u.placa,
            "vehiculo": u.vehiculo, "pagos": medios_pago(u), "fotos": fotos_de(u)}

@app.post("/usuarios/{usuario_id}/foto")
async def subir_foto_conductor(usuario_id: int, tipo: str, file: UploadFile = File(...),
                               db: Session = Depends(get_db),
                               actual: Usuario = Depends(usuario_actual)):
    exigir_dueño(actual, usuario_id)
    """Sube foto del conductor, del vehiculo o de la tarjeta de propiedad."""
    if tipo not in ("conductor", "vehiculo", "tarjeta"):
        raise HTTPException(status_code=400, detail="tipo debe ser conductor, vehiculo o tarjeta")
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
def obtener_conductores(db: Session = Depends(get_db)):
    conductores = db.query(Usuario).filter(Usuario.rol == "conductor").all()
    return [{"id": u.id, "nombre": u.nombre, "telefono": u.telefono, "placa": u.placa,
             "vehiculo": u.vehiculo, "disponible": u.disponible,
             "tipo_vehiculo": u.tipo_vehiculo, "municipio": u.municipio,
             "suscripcion_hasta": u.suscripcion_hasta,
             "dias_restantes": dias_restantes(u),
             "al_dia": suscripcion_al_dia(u, db),
             "fotos": fotos_de(u)} for u in conductores]

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