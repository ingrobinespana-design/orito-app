from sqlalchemy import create_engine, Column, Integer, String, Float, ForeignKey, DateTime
from sqlalchemy.ext.declarative import declarative_base
from sqlalchemy.orm import sessionmaker
from datetime import datetime

SQLALCHEMY_DATABASE_URL = "sqlite:///./orito.db"

engine = create_engine(SQLALCHEMY_DATABASE_URL, connect_args={"check_same_thread": False})

SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)

Base = declarative_base()

class Usuario(Base):
    __tablename__ = "usuarios"

    id = Column(Integer, primary_key=True, index=True)
    nombre = Column(String)
    telefono = Column(String, unique=True)
    password = Column(String)
    rol = Column(String, default="cliente")

class Restaurante(Base):
    __tablename__ = "restaurantes"

    id = Column(Integer, primary_key=True, index=True)
    nombre = Column(String)
    categoria = Column(String)
    calificacion = Column(Float)
    tiempo = Column(String)
    domicilio = Column(Integer)

class Pedido(Base):
    __tablename__ = "pedidos"

    id = Column(Integer, primary_key=True, index=True)
    cliente_nombre = Column(String)
    cliente_direccion = Column(String)
    cliente_telefono = Column(String)
    restaurante_id = Column(Integer, ForeignKey("restaurantes.id"))
    plato = Column(String)
    total = Column(Integer)
    estado = Column(String, default="pendiente")
    fecha = Column(DateTime, default=datetime.now)

def crear_tablas():
    Base.metadata.create_all(bind=engine)