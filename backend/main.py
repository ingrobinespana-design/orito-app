import os
PORT = int(os.environ.get("PORT", 8000))
from fastapi import FastAPI, Depends
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy.orm import Session
from database import SessionLocal, crear_tablas, Restaurante, Pedido

app = FastAPI(title="Orito App - API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

crear_tablas()

def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()

@app.get("/")
def inicio():
    return {"mensaje": "Bienvenido a Orito App 🛵"}

@app.get("/restaurantes")
def obtener_restaurantes(db: Session = Depends(get_db)):
    return db.query(Restaurante).all()

@app.post("/restaurantes")
def crear_restaurante(nombre: str, categoria: str, calificacion: float, tiempo: str, domicilio: int, db: Session = Depends(get_db)):
    restaurante = Restaurante(
        nombre=nombre,
        categoria=categoria,
        calificacion=calificacion,
        tiempo=tiempo,
        domicilio=domicilio
    )
    db.add(restaurante)
    db.commit()
    db.refresh(restaurante)
    return restaurante

@app.post("/pedidos")
def crear_pedido(cliente_nombre: str, cliente_direccion: str, cliente_telefono: str, restaurante_id: int, plato: str, total: int, db: Session = Depends(get_db)):
    pedido = Pedido(
        cliente_nombre=cliente_nombre,
        cliente_direccion=cliente_direccion,
        cliente_telefono=cliente_telefono,
        restaurante_id=restaurante_id,
        plato=plato,
        total=total
    )
    db.add(pedido)
    db.commit()
    db.refresh(pedido)
    return pedido

@app.get("/pedidos")
def obtener_pedidos(db: Session = Depends(get_db)):
    return db.query(Pedido).all()

@app.put("/pedidos/{pedido_id}/estado")
def actualizar_estado(pedido_id: int, estado: str, db: Session = Depends(get_db)):
    pedido = db.query(Pedido).filter(Pedido.id == pedido_id).first()
    pedido.estado = estado
    db.commit()
    return pedido