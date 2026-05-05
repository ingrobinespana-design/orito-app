from fastapi import FastAPI, Depends, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy.orm import Session
from database import SessionLocal, crear_tablas, Restaurante, Pedido, Usuario, Plato
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
    return {"mensaje": "Bienvenido a Orito App"}

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
    return {"id": usuario.id, "nombre": usuario.nombre, "telefono": usuario.telefono, "rol": usuario.rol, "restaurante_id": usuario.restaurante_id}

@app.post("/login")
def login(telefono: str, password: str, db: Session = Depends(get_db)):
    usuario = db.query(Usuario).filter(Usuario.telefono == telefono).first()
    if not usuario or not pwd_context.verify(password, usuario.password):
        raise HTTPException(status_code=400, detail="Telefono o contraseña incorrectos")
    return {"id": usuario.id, "nombre": usuario.nombre, "telefono": usuario.telefono, "rol": usuario.rol, "restaurante_id": usuario.restaurante_id}

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
    pedido.estado = estado
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
def cambiar_rol(telefono: str, rol: str, restaurante_id: int = None, db: Session = Depends(get_db)):
    usuario = db.query(Usuario).filter(Usuario.telefono == telefono).first()
    if not usuario:
        raise HTTPException(status_code=404, detail="Usuario no encontrado")
    usuario.rol = rol
    if restaurante_id:
        usuario.restaurante_id = restaurante_id
    db.commit()
    return {"nombre": usuario.nombre, "telefono": usuario.telefono, "rol": usuario.rol, "restaurante_id": usuario.restaurante_id}

@app.get("/usuarios")
def obtener_usuarios(db: Session = Depends(get_db)):
    usuarios = db.query(Usuario).all()
    return [{"id": u.id, "nombre": u.nombre, "telefono": u.telefono, "rol": u.rol, "restaurante_id": u.restaurante_id} for u in usuarios]

@app.get("/domiciliarios")
def obtener_domiciliarios(db: Session = Depends(get_db)):
    domiciliarios = db.query(Usuario).filter(Usuario.rol == "domiciliario").all()
    return [{"id": u.id, "nombre": u.nombre, "telefono": u.telefono} for u in domiciliarios]