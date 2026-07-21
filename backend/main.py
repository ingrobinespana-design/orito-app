from fastapi import FastAPI, Depends, HTTPException, File, UploadFile, BackgroundTasks
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy.orm import Session
from sqlalchemy import func
from database import SessionLocal, crear_tablas, Restaurante, Pedido, Usuario, Plato, Carrera, Lugar, Config, Municipio
from datetime import datetime, timedelta
from passlib.context import CryptContext
from dotenv import load_dotenv
import logging
import push
import tarifas
import cloudinary
import cloudinary.uploader
import os

load_dotenv()

cloudinary.config(
    cloud_name=os.environ.get("CLOUDINARY_CLOUD_NAME"),
    api_key=os.environ.get("CLOUDINARY_API_KEY"),
    api_secret=os.environ.get("CLOUDINARY_API_SECRET")
)

app = FastAPI(title="Orito App - API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

crear_tablas()

pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")

def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()

@app.get("/")
def inicio():
    return {"mensaje": "Bienvenido a Orito App"}

@app.post("/registro")
def registrar_usuario(nombre: str, telefono: str, password: str, municipio: str = "Orito",
                      tipo_vehiculo: str = None, placa: str = None, vehiculo: str = None,
                      db: Session = Depends(get_db)):
    """Si viene tipo_vehiculo (moto o carro) se registra como conductor.
    Sin eso queda de cliente. No hay valor por defecto: quien maneja lo declara."""
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
    )
    db.add(usuario)
    db.commit()
    db.refresh(usuario)
    return {"id": usuario.id, "nombre": usuario.nombre, "telefono": usuario.telefono,
            "rol": usuario.rol, "restaurante_id": usuario.restaurante_id,
            "municipio": usuario.municipio, "tipo_vehiculo": usuario.tipo_vehiculo,
            "placa": usuario.placa, "vehiculo": usuario.vehiculo, "disponible": usuario.disponible}

def vehiculos_de(municipio: str, db: Session):
    """Que vehiculos se permiten en ese pueblo. Lista vacia = municipio desconocido."""
    m = db.query(Municipio).filter(Municipio.nombre == municipio, Municipio.activo == "si").first()
    if not m:
        return []
    return [v.strip() for v in (m.vehiculos or "").split(",") if v.strip()]

def municipio_dict(m: Municipio, db: Session):
    return {
        "nombre": m.nombre,
        "vehiculos": vehiculos_de(m.nombre, db),
        "usa_gps": m.usa_gps == "si",
        "tarifa_base": m.tarifa_base or 0,
        "valor_km": m.valor_km or 0,
        "tarifa_minima": m.tarifa_minima or 0,
        "centro_lat": m.centro_lat,
        "centro_lon": m.centro_lon,
    }

@app.get("/municipios")
def obtener_municipios(db: Session = Depends(get_db)):
    """La app arma con esto las opciones del registro: en Orito no debe
    aparecer la opcion de moto porque alla todavia no hay mototaxi, y solo
    donde usa_gps esta prendido se pide ubicacion y se sugiere tarifa."""
    return [municipio_dict(m, db)
            for m in db.query(Municipio).filter(Municipio.activo == "si").order_by(Municipio.nombre).all()]

@app.get("/tarifa")
def estimar_tarifa(municipio: str, origen_lat: float, origen_lon: float,
                   destino_lat: float, destino_lon: float, db: Session = Depends(get_db)):
    """Lo que la app muestra ANTES de pedir: 'son como 3.2 km, aprox $8.000'."""
    m = db.query(Municipio).filter(Municipio.nombre == municipio).first()
    if not m:
        raise HTTPException(status_code=404, detail="Municipio no encontrado")
    km = tarifas.distancia_por_calle(origen_lat, origen_lon, destino_lat, destino_lon)
    return {
        "distancia_km": km,
        "tarifa_sugerida": tarifas.calcular_tarifa(km, m.tarifa_base, m.valor_km, m.tarifa_minima),
        "es_sugerencia": True,
    }

@app.put("/municipios/{nombre}")
def actualizar_municipio(nombre: str, vehiculos: str = None, activo: str = None,
                         usa_gps: str = None, tarifa_base: int = None, valor_km: int = None,
                         tarifa_minima: int = None, db: Session = Depends(get_db)):
    """Para habilitar moto en Orito cuando lleguen, prender el GPS en un pueblo
    o ajustar las tarifas — todo sin publicar app nueva."""
    m = db.query(Municipio).filter(Municipio.nombre == nombre).first()
    if not m:
        raise HTTPException(status_code=404, detail="Municipio no encontrado")
    if vehiculos is not None:
        pedidos = [v.strip() for v in vehiculos.split(",") if v.strip()]
        if not pedidos or any(v not in ("moto", "carro") for v in pedidos):
            raise HTTPException(status_code=400, detail="Vehiculos validos: moto, carro")
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

@app.post("/login")
def login(telefono: str, password: str, db: Session = Depends(get_db)):
    usuario = db.query(Usuario).filter(Usuario.telefono == telefono).first()
    if not usuario or not pwd_context.verify(password, usuario.password):
        raise HTTPException(status_code=400, detail="Telefono o contraseña incorrectos")
    return {"id": usuario.id, "nombre": usuario.nombre, "telefono": usuario.telefono, "rol": usuario.rol,
            "restaurante_id": usuario.restaurante_id, "placa": usuario.placa,
            "vehiculo": usuario.vehiculo, "disponible": usuario.disponible,
            "municipio": usuario.municipio, "tipo_vehiculo": usuario.tipo_vehiculo}

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
                tipo_vehiculo: str = None, db: Session = Depends(get_db)):
    usuario = db.query(Usuario).filter(Usuario.telefono == telefono).first()
    if not usuario:
        raise HTTPException(status_code=404, detail="Usuario no encontrado")
    # un conductor sin vehiculo declarado no le sirve a nadie: no veria ni una carrera
    if rol == "conductor":
        elegido = tipo_vehiculo or usuario.tipo_vehiculo
        permitidos = vehiculos_de(usuario.municipio or "Orito", db)
        if elegido not in ("moto", "carro"):
            raise HTTPException(status_code=400, detail="Para hacerlo conductor tienes que indicar si maneja moto o carro")
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
def obtener_usuarios(db: Session = Depends(get_db)):
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
        "tarifa": c.tarifa,
        "notas": c.notas,
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

@app.get("/config")
def obtener_config(db: Session = Depends(get_db)):
    return {c.clave: c.valor for c in db.query(Config).all()}

@app.put("/config")
def actualizar_config(clave: str, valor: str, db: Session = Depends(get_db)):
    if clave not in ("cobro_activo", "valor_mensual", "nequi_pagos"):
        raise HTTPException(status_code=400, detail="Ajuste no permitido")
    if clave == "cobro_activo" and valor not in ("si", "no"):
        raise HTTPException(status_code=400, detail="cobro_activo solo acepta si o no")
    if clave == "valor_mensual" and not valor.isdigit():
        raise HTTPException(status_code=400, detail="El valor mensual debe ser un numero")
    fila = db.query(Config).filter(Config.clave == clave).first()
    if fila:
        fila.valor = valor
    else:
        db.add(Config(clave=clave, valor=valor))
    db.commit()
    return {"clave": clave, "valor": valor}

@app.put("/conductores/{conductor_id}/suscripcion")
def registrar_pago(conductor_id: int, meses: int = 1, db: Session = Depends(get_db)):
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
def cancelar_suscripcion(conductor_id: int, db: Session = Depends(get_db)):
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
            ).all()
            # solo los del mismo municipio, con el vehiculo que pidieron y al dia
            if le_sirve_la_carrera(c, carrera) and suscripcion_al_dia(c, db)
        ]
        if not conductores:
            return
        aviso_zona = " (fuera del pueblo)" if carrera.zona == "rural" else ""
        mensajes = [
            push.mensaje(
                c.push_token,
                f"Nueva carrera{aviso_zona}",
                f"De {carrera.origen} a {carrera.destino}",
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

@app.put("/usuarios/{usuario_id}/push-token")
def guardar_push_token(usuario_id: int, token: str, db: Session = Depends(get_db)):
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

def registrar_lugar(nombre: str, municipio: str, db: Session):
    """Guarda lo que escribio el usuario para sugerirselo al siguiente, dentro de
    su municipio. Compara sin distinguir mayusculas para no duplicar."""
    nombre = (nombre or "").strip()
    if len(nombre) < 3:
        return
    lugar = buscar_lugar(nombre, municipio, db)
    if lugar:
        lugar.usos = (lugar.usos or 0) + 1
    else:
        # lo escrito a mano entra como urbano; si es vereda el admin lo corrige
        db.add(Lugar(nombre=nombre, municipio=municipio, usos=1))

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
def crear_lugar(nombre: str, db: Session = Depends(get_db)):
    if db.query(Lugar).filter(Lugar.nombre == nombre).first():
        raise HTTPException(status_code=400, detail="Ese lugar ya existe")
    lugar = Lugar(nombre=nombre)
    db.add(lugar)
    db.commit()
    db.refresh(lugar)
    return lugar

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
                  db: Session = Depends(get_db)):
    cliente = db.query(Usuario).filter(Usuario.id == cliente_id).first()
    if not cliente:
        raise HTTPException(status_code=404, detail="Usuario no encontrado")
    # una carrera activa a la vez, para que no pida cinco taxis al tiempo
    activa = db.query(Carrera).filter(
        Carrera.cliente_id == cliente_id,
        Carrera.estado.in_(["buscando", "aceptada", "en_camino"])
    ).first()
    if activa:
        raise HTTPException(status_code=400, detail="Ya tienes una carrera en curso")
    municipio = cliente.municipio or "Orito"
    permitidos = vehiculos_de(municipio, db)
    if vehiculo_pedido not in permitidos:
        raise HTTPException(
            status_code=400,
            detail=f"En {municipio} solo hay servicio de {' o '.join(permitidos) or 'ninguno'}")
    # donde hay GPS se calcula distancia y tarifa sugerida; donde no, quedan vacias
    m = db.query(Municipio).filter(Municipio.nombre == municipio).first()
    km = tarifas.distancia_por_calle(origen_lat, origen_lon, destino_lat, destino_lon)
    sugerida = tarifas.calcular_tarifa(km, m.tarifa_base, m.valor_km, m.tarifa_minima) if m else None

    carrera = Carrera(
        cliente_id=cliente.id, cliente_nombre=cliente.nombre, cliente_telefono=cliente.telefono,
        origen=origen, origen_detalle=origen_detalle, destino=destino,
        destino_detalle=destino_detalle, notas=notas,
        municipio=municipio, vehiculo_pedido=vehiculo_pedido,
        origen_lat=origen_lat, origen_lon=origen_lon,
        destino_lat=destino_lat, destino_lon=destino_lon,
        distancia_km=km, tarifa_sugerida=sugerida,
        zona=zona_de_la_carrera(origen, destino, municipio, db),
    )
    db.add(carrera)
    registrar_lugar(origen, municipio, db)
    registrar_lugar(destino, municipio, db)
    db.commit()
    db.refresh(carrera)
    tareas.add_task(avisar_carrera_nueva, carrera.id)
    return carrera_dict(carrera)

@app.get("/carreras/disponibles")
def carreras_disponibles(conductor_id: int = None, db: Session = Depends(get_db)):
    """Lo que ve el conductor: carreras libres de SU municipio y que le sirven
    segun su vehiculo. Sin conductor_id devuelve todas (para el panel admin)."""
    carreras = db.query(Carrera).filter(Carrera.estado == "buscando").order_by(Carrera.fecha).all()
    if conductor_id:
        conductor = db.query(Usuario).filter(Usuario.id == conductor_id).first()
        if not conductor:
            raise HTTPException(status_code=404, detail="Conductor no encontrado")
        carreras = [c for c in carreras if le_sirve_la_carrera(conductor, c)]
    return [carrera_dict(c) for c in carreras]

@app.put("/carreras/{carrera_id}/aceptar")
def aceptar_carrera(carrera_id: int, conductor_id: int, tareas: BackgroundTasks, db: Session = Depends(get_db)):
    conductor = db.query(Usuario).filter(Usuario.id == conductor_id, Usuario.rol == "conductor").first()
    if not conductor:
        raise HTTPException(status_code=404, detail="Conductor no encontrado")
    if not suscripcion_al_dia(conductor, db):
        raise HTTPException(status_code=402, detail="Tu suscripcion se vencio. Comunicate con el administrador para renovarla.")
    pedida = db.query(Carrera).filter(Carrera.id == carrera_id).first()
    if pedida and not le_sirve_la_carrera(conductor, pedida):
        raise HTTPException(status_code=403, detail="Esa carrera no es de tu municipio o pidieron otro tipo de vehiculo")
    # update condicional: si dos conductores aceptan al mismo tiempo, solo uno
    # encuentra la carrera en "buscando" y el otro recibe el 409
    tomada = db.query(Carrera).filter(
        Carrera.id == carrera_id,
        Carrera.estado == "buscando"
    ).update({"conductor_id": conductor_id, "estado": "aceptada"}, synchronize_session=False)
    db.commit()
    if tomada == 0:
        raise HTTPException(status_code=409, detail="Esa carrera ya fue tomada por otro conductor")
    carrera = db.query(Carrera).filter(Carrera.id == carrera_id).first()
    tareas.add_task(avisar_carrera_aceptada, carrera_id)
    return carrera_dict(carrera, conductor)

@app.put("/carreras/{carrera_id}/estado")
def actualizar_estado_carrera(carrera_id: int, estado: str, tarifa: int = None, db: Session = Depends(get_db)):
    validos = ["buscando", "aceptada", "en_camino", "finalizada", "cancelada"]
    if estado not in validos:
        raise HTTPException(status_code=400, detail=f"Estado invalido. Validos: {', '.join(validos)}")
    carrera = db.query(Carrera).filter(Carrera.id == carrera_id).first()
    if not carrera:
        raise HTTPException(status_code=404, detail="Carrera no encontrada")
    carrera.estado = estado
    if tarifa is not None:
        carrera.tarifa = tarifa
    db.commit()
    db.refresh(carrera)
    conductor = db.query(Usuario).filter(Usuario.id == carrera.conductor_id).first() if carrera.conductor_id else None
    return carrera_dict(carrera, conductor)

@app.get("/carreras/cliente/{cliente_id}")
def carreras_del_cliente(cliente_id: int, db: Session = Depends(get_db)):
    carreras = db.query(Carrera).filter(Carrera.cliente_id == cliente_id).order_by(Carrera.fecha.desc()).all()
    return con_conductor(carreras, db)

@app.get("/carreras/conductor/{conductor_id}")
def carreras_del_conductor(conductor_id: int, db: Session = Depends(get_db)):
    carreras = db.query(Carrera).filter(Carrera.conductor_id == conductor_id).order_by(Carrera.fecha.desc()).all()
    return con_conductor(carreras, db)

@app.get("/carreras")
def todas_las_carreras(db: Session = Depends(get_db)):
    carreras = db.query(Carrera).order_by(Carrera.fecha.desc()).all()
    return con_conductor(carreras, db)

@app.get("/conductores")
def obtener_conductores(db: Session = Depends(get_db)):
    conductores = db.query(Usuario).filter(Usuario.rol == "conductor").all()
    return [{"id": u.id, "nombre": u.nombre, "telefono": u.telefono, "placa": u.placa,
             "vehiculo": u.vehiculo, "disponible": u.disponible,
             "tipo_vehiculo": u.tipo_vehiculo, "municipio": u.municipio,
             "suscripcion_hasta": u.suscripcion_hasta,
             "dias_restantes": dias_restantes(u),
             "al_dia": suscripcion_al_dia(u, db)} for u in conductores]

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
        "valor_mensual": int(leer_config("valor_mensual", db, "0") or 0),
        "nequi_pagos": leer_config("nequi_pagos", db, ""),
    }

@app.put("/conductores/{conductor_id}")
def actualizar_conductor(conductor_id: int, placa: str = None, vehiculo: str = None,
                         disponible: str = None, tipo_vehiculo: str = None,
                         municipio: str = None, db: Session = Depends(get_db)):
    conductor = db.query(Usuario).filter(Usuario.id == conductor_id).first()
    if not conductor:
        raise HTTPException(status_code=404, detail="Conductor no encontrado")
    if tipo_vehiculo is not None and tipo_vehiculo not in ("moto", "carro"):
        raise HTTPException(status_code=400, detail="Tipo de vehiculo invalido: moto o carro")
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