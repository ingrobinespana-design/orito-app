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

def crear_tablas():
    Base.metadata.create_all(bind=engine)
    # las tablas ya creadas en produccion no reciben columnas nuevas de create_all
    for tabla in ("restaurantes", "platos"):
        try:
            with engine.begin() as conn:
                conn.execute(text(f"ALTER TABLE {tabla} ADD COLUMN imagen_url VARCHAR"))
        except Exception:
            pass