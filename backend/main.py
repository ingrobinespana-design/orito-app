from fastapi import FastAPI, Depends, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy.orm import Session
from database import SessionLocal, crear_tablas, Restaurante, Pedido, Usuario
from passlib.context import CryptContext

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
    return {"mensaje": "Bienvenido a Orito App 🛵"}

@app.post("/registro")
def registrar_usuario(nombre: str, telefono: str, password: str, db: Session = Depends(get_db)):
    usuario_existe = db.query(Usuario).filter(Usuario.telefono == telefono).first()
    if usuario_existe:
        raise HTTPException(status_code=400, detail="Este telefono ya esta registrado")
    password_hash = pwd_context.hash(password)
    usuario = Usuario(nombre=nombre, telefono=telefono, password=password_hash)
    db.add(usuario)
    db.commit()
    db.refresh(usuario)
    return {"id": usuario.id, "nombre": usuario.nombre, "telefono": usuario.telefono, "rol": usuario.rol}

@app.post("/login")
def login(telefono: str, password: str, db: Session = Depends(get_db)):
    usuario = db.query(Usuario).filter(Usuario.telefono == telefono).first()
    if not usuario or not pwd_context.verify(password, usuario.password):
        raise HTTPException(status_code=400, detail="Telefono o contraseña incorrectos")
    return {"id": usuario.id, "nombre": usuario.nombre, "telefono": usuario.telefono, "rol": usuario.rol}

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

@app.post("/pedidos")
def crear_pedido(cliente_nombre: str, cliente_direccion: str, cliente_telefono: str, restaurante_id: int, plato: str, total: int, db: Session = Depends(get_db)):
    pedido = Pedido(cliente_nombre=cliente_nombre, cliente_direccion=cliente_direccion, cliente_telefono=cliente_telefono, restaurante_id=restaurante_id, plato=plato, total=total)
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