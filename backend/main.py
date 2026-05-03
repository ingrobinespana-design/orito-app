from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

app = FastAPI(title="Orito App - API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.get("/")
def inicio():
    return {"mensaje": "Bienvenido a Orito App 🛵"}

@app.get("/restaurantes")
def obtener_restaurantes():
    return [
        {
            "id": 1,
            "nombre": "Restaurante El Llanerito",
            "categoria": "Comidas",
            "calificacion": 4.8,
            "tiempo": "25-35 min",
            "domicilio": 3000
        },
        {
            "id": 2,
            "nombre": "Pizza Amazonas",
            "categoria": "Pizzas",
            "calificacion": 4.6,
            "tiempo": "30-40 min",
            "domicilio": 3000
        }
    ]