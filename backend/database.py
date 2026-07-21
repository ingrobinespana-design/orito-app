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
    # datos de conductor (solo para rol "conductor")
    placa = Column(String, nullable=True)
    vehiculo = Column(String, nullable=True)
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
    nombre = Column(String, unique=True)
    usos = Column(Integer, default=0)
    # "urbano" (casco del pueblo) o "rural" (veredas, a kilometros). El conductor
    # necesita saberlo ANTES de aceptar: no es lo mismo ir al parque que a una vereda.
    zona = Column(String, default="urbano")
    activo = Column(String, default="si")

class Config(Base):
    """Ajustes que el dueño cambia desde el panel sin tocar codigo."""
    __tablename__ = "config"
    clave = Column(String, primary_key=True)
    valor = Column(String)

# Arranca SIN cobrar a proposito: primero hay que llenar la app de conductores y
# clientes. Cuando el servicio ya se gano solo, se prende desde el panel.
CONFIG_INICIAL = {
    "cobro_activo": "no",
    "valor_mensual": "30000",
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
    conductor_id = Column(Integer, ForeignKey("usuarios.id"), nullable=True)
    # buscando -> aceptada -> en_camino -> finalizada  (o cancelada en cualquier punto)
    estado = Column(String, default="buscando")
    # "rural" si origen o destino es vereda: el conductor lo ve antes de aceptar
    zona = Column(String, default="urbano")
    tarifa = Column(Integer, nullable=True)
    notas = Column(Text, nullable=True)
    fecha = Column(DateTime, default=datetime.now)

# Referencias visibles en el mapa de Orito. Es solo la semilla para que el campo
# no arranque vacio: la lista de verdad la va armando la gente al escribir.
LUGARES_INICIALES = [
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
                    "suscripcion_hasta TIMESTAMP"):
        try:
            with engine.begin() as conn:
                conn.execute(text(f"ALTER TABLE usuarios ADD COLUMN {columna}"))
        except Exception:
            pass
    for columna in ("usos INTEGER DEFAULT 0", "zona VARCHAR DEFAULT 'urbano'"):
        try:
            with engine.begin() as conn:
                conn.execute(text(f"ALTER TABLE lugares ADD COLUMN {columna}"))
        except Exception:
            pass
    try:
        with engine.begin() as conn:
            conn.execute(text("ALTER TABLE carreras ADD COLUMN zona VARCHAR DEFAULT 'urbano'"))
    except Exception:
        pass
    # semilla para que el primer usuario no vea el campo vacio; de ahi en adelante
    # la lista crece sola. Agrega solo lo que falte, asi no pisa lo que ya escribio
    # la gente ni duplica en cada arranque del servidor.
    db = SessionLocal()
    try:
        existentes = {n.lower() for (n,) in db.query(Lugar.nombre).all()}
        nuevos = [Lugar(nombre=n, zona=z) for n, z in LUGARES_INICIALES if n.lower() not in existentes]
        if nuevos:
            db.add_all(nuevos)
        # los ajustes que falten toman su valor por defecto, sin pisar los ya guardados
        guardados = {c.clave for c in db.query(Config).all()}
        faltantes = [Config(clave=k, valor=v) for k, v in CONFIG_INICIAL.items() if k not in guardados]
        if faltantes:
            db.add_all(faltantes)
        db.commit()
    finally:
        db.close()