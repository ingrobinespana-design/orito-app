from fastapi import FastAPI, Depends, HTTPException, File, UploadFile, BackgroundTasks
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy.orm import Session
from sqlalchemy import func
from database import SessionLocal, crear_tablas, Restaurante, Pedido, Usuario, Plato, Carrera, Lugar, Config, Municipio, Tarifa, Oferta
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

@app.get("/municipios")
def obtener_municipios(db: Session = Depends(get_db)):
    """La app arma con esto las opciones del registro: en Orito no debe
    aparecer la opcion de moto porque alla todavia no hay mototaxi, y solo
    donde usa_gps esta prendido se pide ubicacion y se sugiere tarifa."""
    return [municipio_dict(m, db)
            for m in db.query(Municipio).filter(Municipio.activo == "si").order_by(Municipio.nombre).all()]

def tarifa_sugerida(municipio: str, vehiculo: str, km, db: Session):
    """Sugerencia segun el pueblo, el vehiculo y los km. Solo orienta la oferta
    del cliente; el precio de verdad lo negocian las partes."""
    if km is None or not vehiculo:
        return None
    t = db.query(Tarifa).filter(Tarifa.municipio == municipio, Tarifa.vehiculo == vehiculo).first()
    if not t:
        return None
    return tarifas.calcular_tarifa(km, t.base, t.valor_km, t.minima)

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
                      minima: int = None, db: Session = Depends(get_db)):
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
        "conductor_pagos": medios_pago(conductor) if conductor else None,
        "conductor_foto": conductor.foto_conductor if conductor else None,
        "conductor_foto_vehiculo": conductor.foto_vehiculo if conductor else None,
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
def obtener_config(db: Session = Depends(get_db)):
    return {c.clave: c.valor for c in db.query(Config).all()}

@app.put("/config")
def actualizar_config(clave: str, valor: str, db: Session = Depends(get_db)):
    permitidas = ("cobro_activo", "valor_mensual_moto", "valor_mensual_carro", "nequi_pagos")
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
                lat: float = None, lon: float = None, db: Session = Depends(get_db)):
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
                 activo: str = None, db: Session = Depends(get_db)):
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
    # el municipio viene de donde ESTA el cliente (GPS o manual), no de su registro
    municipio = municipio or cliente.municipio or "Orito"
    permitidos = vehiculos_de(municipio, db)
    if vehiculo_pedido not in permitidos:
        raise HTTPException(
            status_code=400,
            detail=f"En {municipio} solo hay servicio de {' o '.join(permitidos) or 'ninguno'}")
    if tarifa_ofrecida is not None and tarifa_ofrecida <= 0:
        raise HTTPException(status_code=400, detail="La oferta debe ser mayor que cero")
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
    )
    db.add(carrera)
    registrar_lugar(origen, municipio, db, origen_lat, origen_lon)
    registrar_lugar(destino, municipio, db, destino_lat, destino_lon)
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
                  db: Session = Depends(get_db)):
    """El conductor propone otro precio. La carrera sigue 'buscando' hasta que el
    cliente elija. No pisa la asignacion: si ya la tomaron, no deja ofertar."""
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
def aceptar_oferta(carrera_id: int, oferta_id: int, tareas: BackgroundTasks, db: Session = Depends(get_db)):
    """El cliente acepta la contraoferta de un conductor. Update condicional para
    no chocar con un conductor que justo acepte el precio original."""
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
def estadisticas_globales(db: Session = Depends(get_db)):
    """Para el dueño: pulso del negocio. Volumen de carreras y plata movida por
    periodo, mas conteos utiles para medir el desempeño de la app."""
    finalizadas = db.query(Carrera).filter(Carrera.estado == "finalizada").all()
    periodos = _periodos_desde()
    resumen = {p: _resumen(finalizadas, desde) for p, desde in periodos.items()}
    todas = db.query(Carrera).all()
    conductores = db.query(Usuario).filter(Usuario.rol == "conductor").all()
    return {
        **resumen,
        "clientes": db.query(Usuario).filter(Usuario.rol == "cliente").count(),
        "conductores": len(conductores),
        "conductores_al_dia": sum(1 for c in conductores if suscripcion_al_dia(c, db)),
        "carreras_totales": len(todas),
        "canceladas": sum(1 for c in todas if c.estado == "cancelada"),
        "en_curso": sum(1 for c in todas if c.estado in ("buscando", "aceptada", "en_camino")),
    }

@app.get("/carreras")
def todas_las_carreras(db: Session = Depends(get_db)):
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
                               db: Session = Depends(get_db)):
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
                  bancolombia: str = None, breb: str = None, db: Session = Depends(get_db)):
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