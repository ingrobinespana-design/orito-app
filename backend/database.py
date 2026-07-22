from sqlalchemy import create_engine, Column, Integer, String, Float, ForeignKey, DateTime, Text, text
from sqlalchemy.ext.declarative import declarative_base
from sqlalchemy.orm import sessionmaker
from datetime import datetime
from dotenv import load_dotenv
import os

load_dotenv()

DATABASE_URL = os.environ.get("DATABASE_URL", "sqlite:///./orito.db")

engine = create_engine(DATABASE_URL)

SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)

Base = declarative_base()

class Usuario(Base):
    __tablename__ = "usuarios"
    id = Column(Integer, primary_key=True, index=True)
    nombre = Column(String)
    telefono = Column(String, unique=True)
    password = Column(String)
    rol = Column(String, default="cliente")
    restaurante_id = Column(Integer, ForeignKey("restaurantes.id"), nullable=True)
    # municipio donde trabaja/vive. Separa las carreras: un conductor de Orito
    # no puede ver ni recibir avisos de carreras de Puerto Asis.
    municipio = Column(String, default="Orito")
    # datos de conductor (solo para rol "conductor")
    placa = Column(String, nullable=True)
    vehiculo = Column(String, nullable=True)
    # "moto" o "carro". Obligatorio para conductores, vacio para clientes:
    # no hay valor por defecto a proposito, cada quien declara en que trabaja.
    tipo_vehiculo = Column(String, nullable=True)
    disponible = Column(String, default="no")
    # token de Expo para mandarle notificaciones al celular aunque tenga la app cerrada
    push_token = Column(String, nullable=True)
    # hasta cuando tiene paga la suscripcion. Vacio = nunca ha pagado.
    suscripcion_hasta = Column(DateTime, nullable=True)

class Restaurante(Base):
    __tablename__ = "restaurantes"
    id = Column(Integer, primary_key=True, index=True)
    nombre = Column(String)
    categoria = Column(String)
    calificacion = Column(Float)
    tiempo = Column(String)
    domicilio = Column(Integer)
    imagen_url = Column(String, nullable=True)

class Plato(Base):
    __tablename__ = "platos"
    id = Column(Integer, primary_key=True, index=True)
    restaurante_id = Column(Integer, ForeignKey("restaurantes.id"))
    nombre = Column(String)
    descripcion = Column(Text)
    precio = Column(Integer)
    disponible = Column(String, default="si")
    imagen_url = Column(String, nullable=True)

class Pedido(Base):
    __tablename__ = "pedidos"
    id = Column(Integer, primary_key=True, index=True)
    cliente_nombre = Column(String)
    cliente_direccion = Column(String)
    cliente_telefono = Column(String)
    restaurante_id = Column(Integer, ForeignKey("restaurantes.id"))
    domiciliario_id = Column(Integer, ForeignKey("usuarios.id"), nullable=True)
    plato = Column(String)
    total = Column(Integer)
    estado = Column(String, default="pendiente")
    metodo_pago = Column(String, default="efectivo")
    fecha = Column(DateTime, default=datetime.now)

class Lugar(Base):
    """Sugerencias de origen/destino. No es una lista cerrada: el cliente escribe
    libre (nomenclatura tipo "Calle 10 # 5-23" o el nombre de un negocio) y lo que
    escribe se guarda aca. La lista se va armando sola con las palabras del pueblo,
    y `usos` hace que lo mas pedido aparezca primero."""
    __tablename__ = "lugares"
    id = Column(Integer, primary_key=True, index=True)
    nombre = Column(String)
    municipio = Column(String, default="Orito")
    usos = Column(Integer, default=0)
    # la lista aprende ubicaciones: cuando alguien marca este sitio en el mapa se
    # guardan sus coordenadas, y el siguiente que lo elija ya no necesita el mapa.
    lat = Column(Float, nullable=True)
    lon = Column(Float, nullable=True)
    # "urbano" (casco del pueblo) o "rural" (veredas, a kilometros). El conductor
    # necesita saberlo ANTES de aceptar: no es lo mismo ir al parque que a una vereda.
    zona = Column(String, default="urbano")
    activo = Column(String, default="si")

class Tarifa(Base):
    """Tarifa sugerida por municipio Y tipo de vehiculo: la moto cobra distinto
    que el carro. Es solo una SUGERENCIA para orientar la oferta del cliente."""
    __tablename__ = "tarifas"
    id = Column(Integer, primary_key=True, index=True)
    municipio = Column(String)
    vehiculo = Column(String)   # "moto" o "carro"
    base = Column(Integer, default=0)
    valor_km = Column(Integer, default=0)
    minima = Column(Integer, default=0)

# (municipio, vehiculo, base, valor_km, minima). Ajustados a los precios reales
# de la zona: a 4 km moto ~7.000 y carro ~10.000. Editables desde el panel.
TARIFAS_INICIALES = [
    ("Orito", "carro", 5000, 1250, 6000),
    ("Puerto Asis", "moto", 3000, 1000, 4000),
    ("Puerto Asis", "carro", 5000, 1250, 6000),
]

class Oferta(Base):
    """Contraoferta de un conductor a una carrera. El cliente ofrece un precio;
    el conductor puede tomarla a ese precio o proponer otro, y el cliente elige."""
    __tablename__ = "ofertas"
    id = Column(Integer, primary_key=True, index=True)
    carrera_id = Column(Integer, ForeignKey("carreras.id"))
    conductor_id = Column(Integer, ForeignKey("usuarios.id"))
    monto = Column(Integer)
    estado = Column(String, default="pendiente")   # pendiente / aceptada / descartada
    fecha = Column(DateTime, default=datetime.now)

class Config(Base):
    """Ajustes que el dueño cambia desde el panel sin tocar codigo."""
    __tablename__ = "config"
    clave = Column(String, primary_key=True)
    valor = Column(String)

# Arranca SIN cobrar a proposito: primero hay que llenar la app de conductores y
# clientes. Cuando el servicio ya se gano solo, se prende desde el panel.
CONFIG_INICIAL = {
    "cobro_activo": "no",
    # suscripcion mensual por tipo de vehiculo
    "valor_mensual_moto": "39900",
    "valor_mensual_carro": "59900",
    "nequi_pagos": "",
}

class Carrera(Base):
    __tablename__ = "carreras"
    id = Column(Integer, primary_key=True, index=True)
    cliente_id = Column(Integer, ForeignKey("usuarios.id"))
    cliente_nombre = Column(String)
    cliente_telefono = Column(String)
    origen = Column(String)
    origen_detalle = Column(String, nullable=True)
    destino = Column(String)
    destino_detalle = Column(String, nullable=True)
    # coordenadas cuando el municipio usa GPS; vacias donde se trabaja por referencias
    origen_lat = Column(Float, nullable=True)
    origen_lon = Column(Float, nullable=True)
    destino_lat = Column(Float, nullable=True)
    destino_lon = Column(Float, nullable=True)
    distancia_km = Column(Float, nullable=True)
    tarifa_sugerida = Column(Integer, nullable=True)   # sugerencia, no obligacion
    conductor_id = Column(Integer, ForeignKey("usuarios.id"), nullable=True)
    municipio = Column(String, default="Orito")
    # que pidio el cliente: "moto" o "carro". Se respeta estricto — el que pide
    # carro puede ir con maletas o con la familia, una moto no le sirve.
    vehiculo_pedido = Column(String)
    # lo que el cliente ofrece pagar (modelo tipo inDrive: se negocia)
    tarifa_ofrecida = Column(Integer, nullable=True)
    # buscando -> aceptada -> en_camino -> finalizada  (o cancelada en cualquier punto)
    estado = Column(String, default="buscando")
    # "rural" si origen o destino es vereda: el conductor lo ve antes de aceptar
    zona = Column(String, default="urbano")
    tarifa = Column(Integer, nullable=True)
    notas = Column(Text, nullable=True)
    fecha = Column(DateTime, default=datetime.now)

class Municipio(Base):
    """Pueblos donde opera la app y que vehiculos se permiten en cada uno.
    En Orito todavia no hay mototaxi, asi que alla la opcion no debe aparecer;
    el dia que lleguen se habilita desde el panel, sin publicar app nueva."""
    __tablename__ = "municipios"
    nombre = Column(String, primary_key=True)
    vehiculos = Column(String, default="carro")   # separados por coma: "moto,carro"
    activo = Column(String, default="si")
    # con GPS y mapa (OpenStreetMap, gratis) se ubica y se sugiere tarifa por km
    usa_gps = Column(String, default="no")
    tarifa_base = Column(Integer, default=0)      # lo que vale arrancar
    valor_km = Column(Integer, default=0)         # por cada km recorrido
    tarifa_minima = Column(Integer, default=0)    # nunca cobra menos que esto
    # centro del pueblo: donde abre el mapa antes de que el usuario ubique
    centro_lat = Column(Float, nullable=True)
    centro_lon = Column(Float, nullable=True)

# (vehiculos, usa_gps, tarifa_base, valor_km, tarifa_minima, centro_lat, centro_lon)
# Los valores son un punto de partida: el dueño los ajusta desde el panel.
# Orito arranca sin tarifa por km (valor_km=0): el mapa ubica pero no sugiere
# precio hasta que se definan las tarifas de alla.
MUNICIPIOS_INICIALES = {
    "Orito": ("carro", "si", 0, 0, 0, 0.6668, -76.8719),
    "Puerto Asis": ("moto,carro", "si", 3000, 1500, 4000, 0.5083, -76.4972),
}

# Semilla minima de Puerto Asis: solo referencias obvias, sin inventar negocios.
# La lista buena se arma igual que en Orito, con lo que escriba la gente.
LUGARES_PUERTO_ASIS = [
    ("Parque principal", "urbano"),
    ("Hospital", "urbano"),
    ("Terminal de Transportes", "urbano"),
    ("Aeropuerto Tres de Mayo", "urbano"),
    ("Muelle", "urbano"),
    ("Malecon", "urbano"),
]

# Referencias visibles en el mapa de Orito. Es solo la semilla para que el campo
# no arranque vacio: la lista de verdad la va armando la gente al escribir.
LUGARES_ORITO = [
    # --- sitios publicos
    ("Parque Central", "urbano"),
    ("Parque Saludable", "urbano"),
    ("ESE Hospital Orito", "urbano"),
    ("Terminal de Transportes Orito", "urbano"),
    ("Parroquia San Martin", "urbano"),
    ("Acopio de Residuos", "urbano"),
    # --- deporte y recreacion
    ("Cancha de Baloncesto", "urbano"),
    ("Cancha de Futbol Colombia", "urbano"),
    ("Patinodromo de Orito", "urbano"),
    ("Club Rumiyaco", "urbano"),
    ("La Gran Esmeralda Oscura", "urbano"),
    # --- vias principales
    ("Avenida Colombia", "urbano"),
    ("Avenida La Union", "urbano"),
    ("Via La Hormiga - Orito", "urbano"),
    ("Via Puerto Asis", "urbano"),
    # --- barrios / sectores
    ("La Gaitana", "urbano"),
    ("Zona H", "urbano"),
    ("Puertas del Sol", "urbano"),
    # --- negocios conocidos
    ("Distrisur Orito", "urbano"),
    ("Super tienda La 33", "urbano"),
    ("Hotel La Esperanza", "urbano"),
    ("Cremhelado Heladeria", "urbano"),
    ("Restaurante El Sitio", "urbano"),
    ("Restaurante Manrique", "urbano"),
    ("Restaurante Sabor del Campo", "urbano"),
    ("Toque de Chef", "urbano"),
    ("Cevicheria Donde Juana", "urbano"),
    ("Hojarasca", "urbano"),
    ("Korunta", "urbano"),
    ("Losalpes", "urbano"),
    ("Integrar Services", "urbano"),
    ("Dorado Trip and Tours", "urbano"),
    ("Dulce Hogar Putumayo", "urbano"),
    ("Porteria Fullservices", "urbano"),
    ("SOSIP SAS", "urbano"),
    # --- veredas (carreras largas, fuera del casco urbano)
    ("Vereda Bellavista", "rural"),
    ("Vereda B. del Quebradon", "rural"),
    ("Vereda La Florida", "rural"),
    ("Vereda La Palmira", "rural"),
    ("Vereda La Paz", "rural"),
    ("Vereda La Sardina", "rural"),
    ("Vereda La Venada", "rural"),
    ("Vereda Monserrate", "rural"),
    ("Vereda Naranjito", "rural"),
    ("Vereda Simorna", "rural"),
    ("Resguardo Simorna", "rural"),
    ("Vereda San Andres", "rural"),
    ("Vereda San Juan de las Palmeras", "rural"),
    ("Vereda Silvania", "rural"),
    ("Vereda Treinta y Cinco", "rural"),
    ("Yarumo", "rural"),
    # --- sitios rurales de referencia
    ("Rio Blanco", "rural"),
    ("Centro Ecoturistico Corunta", "rural"),
    ("San Jeronimo", "rural"),
    ("Sagy Orito", "rural"),
    # --- pozos petroleros (se iran agregando mas)
    ("Pozo Orito 21", "rural"),
    ("Pozo Orito 35", "rural"),
    ("Pozo Orito 38", "rural"),
]

# (nombre, zona, municipio)
LUGARES_INICIALES = (
    [(n, z, "Orito") for n, z in LUGARES_ORITO] +
    [(n, z, "Puerto Asis") for n, z in LUGARES_PUERTO_ASIS]
)

def crear_tablas():
    Base.metadata.create_all(bind=engine)
    # las tablas ya creadas en produccion no reciben columnas nuevas de create_all
    for tabla in ("restaurantes", "platos"):
        try:
            with engine.begin() as conn:
                conn.execute(text(f"ALTER TABLE {tabla} ADD COLUMN imagen_url VARCHAR"))
        except Exception:
            pass
    for columna in ("placa VARCHAR", "vehiculo VARCHAR", "disponible VARCHAR", "push_token VARCHAR",
                    "suscripcion_hasta TIMESTAMP", "municipio VARCHAR DEFAULT 'Orito'",
                    "tipo_vehiculo VARCHAR DEFAULT 'carro'"):
        try:
            with engine.begin() as conn:
                conn.execute(text(f"ALTER TABLE usuarios ADD COLUMN {columna}"))
        except Exception:
            pass
    for columna in ("usos INTEGER DEFAULT 0", "zona VARCHAR DEFAULT 'urbano'",
                    "municipio VARCHAR DEFAULT 'Orito'", "lat FLOAT", "lon FLOAT"):
        try:
            with engine.begin() as conn:
                conn.execute(text(f"ALTER TABLE lugares ADD COLUMN {columna}"))
        except Exception:
            pass
    for columna in ("zona VARCHAR DEFAULT 'urbano'", "municipio VARCHAR DEFAULT 'Orito'",
                    "vehiculo_pedido VARCHAR", "origen_lat FLOAT", "origen_lon FLOAT",
                    "destino_lat FLOAT", "destino_lon FLOAT", "distancia_km FLOAT",
                    "tarifa_sugerida INTEGER", "tarifa_ofrecida INTEGER"):
        try:
            with engine.begin() as conn:
                conn.execute(text(f"ALTER TABLE carreras ADD COLUMN {columna}"))
        except Exception:
            pass
    for columna in ("usa_gps VARCHAR DEFAULT 'no'", "tarifa_base INTEGER DEFAULT 0",
                    "valor_km INTEGER DEFAULT 0", "tarifa_minima INTEGER DEFAULT 0",
                    "centro_lat FLOAT", "centro_lon FLOAT"):
        try:
            with engine.begin() as conn:
                conn.execute(text(f"ALTER TABLE municipios ADD COLUMN {columna}"))
        except Exception:
            pass
    # semilla para que el primer usuario no vea el campo vacio; de ahi en adelante
    # la lista crece sola. Agrega solo lo que falte, asi no pisa lo que ya escribio
    # la gente ni duplica en cada arranque del servidor.
    db = SessionLocal()
    try:
        # la clave es nombre+municipio: "Hospital" puede existir en los dos pueblos
        existentes = {(n.lower(), m) for n, m in db.query(Lugar.nombre, Lugar.municipio).all()}
        nuevos = [Lugar(nombre=n, zona=z, municipio=m) for n, z, m in LUGARES_INICIALES
                  if (n.lower(), m) not in existentes]
        if nuevos:
            db.add_all(nuevos)
        # los ajustes que falten toman su valor por defecto, sin pisar los ya guardados
        guardados = {c.clave for c in db.query(Config).all()}
        faltantes = [Config(clave=k, valor=v) for k, v in CONFIG_INICIAL.items() if k not in guardados]
        if faltantes:
            db.add_all(faltantes)
        # los municipios que falten; los ya guardados no se pisan porque el dueño
        # pudo haber habilitado moto en Orito desde el panel
        existentes_m = {m.nombre for m in db.query(Municipio).all()}
        nuevos_m = [Municipio(nombre=n, vehiculos=v, usa_gps=g, tarifa_base=tb, valor_km=vk,
                              tarifa_minima=tm, centro_lat=cla, centro_lon=clo)
                    for n, (v, g, tb, vk, tm, cla, clo) in MUNICIPIOS_INICIALES.items()
                    if n not in existentes_m]
        if nuevos_m:
            db.add_all(nuevos_m)
        # tarifas por municipio+vehiculo que falten
        existentes_t = {(t.municipio, t.vehiculo) for t in db.query(Tarifa).all()}
        nuevas_t = [Tarifa(municipio=mu, vehiculo=ve, base=b, valor_km=vk, minima=mi)
                    for mu, ve, b, vk, mi in TARIFAS_INICIALES if (mu, ve) not in existentes_t]
        if nuevas_t:
            db.add_all(nuevas_t)
        db.commit()
    finally:
        db.close()