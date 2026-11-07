"""PRUEBA DE PUNTA A PUNTA de Tukan (no toca produccion ni avisa a nadie real).
Base de datos nueva en una carpeta temporal y avisos interceptados.
Correr desde backend/:   python pruebas/e2e_tukan.py
Recorre: carreras + contraofertas (vencen a 10 s), acarreos (vencen a 15 min), viajes y
acarreos a otra ciudad (exclusiva del dueno, Orito directo), bonos y admin."""
# Prueba de punta a punta de Tukan (servidor local, base nueva, avisos interceptados)
import os, sys, json, threading
from datetime import datetime, timedelta
import tempfile
BD = os.path.join(tempfile.gettempdir(), "tukan_e2e.db").replace(chr(92), "/")
if os.path.exists(BD):
    os.remove(BD)
os.environ["DATABASE_URL"] = "sqlite:///" + BD
os.environ["RESPALDO_CLAVE"] = "clave-e2e"
threading.Timer = lambda *a, **k: type("T", (), {"start": lambda s: None, "cancel": lambda s: None})()  # sin temporizadores
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import push
ENVIADOS = []
def _enviar(msgs):
    ENVIADOS.extend(msgs or []); return []
push.enviar = _enviar
import main
main.push.enviar = _enviar
from fastapi.testclient import TestClient
from database import SessionLocal, Usuario, Carrera, Expreso, Oferta, Config, Municipio
cli = TestClient(main.app)
db = SessionLocal()

OK, MAL = [], []
def chk(nombre, cond, extra=""):
    (OK if cond else MAL).append(nombre)
    print(("  OK   " if cond else "  FALLA ") + nombre + (("  -> " + str(extra)[:220]) if (extra and not cond) else ""))

def crear(nombre, tel, rol, muni, veh=None, lat=None, lon=None):
    u = Usuario(nombre=nombre, telefono=tel, rol=rol, municipio=muni, password=main.pwd_context.hash("clave123"),
                tipo_vehiculo=veh, placa="ABC123" if rol == "conductor" else None, vehiculo="Renault" if rol == "conductor" else None,
                verificado="si" if rol == "conductor" else None, disponible="si" if rol == "conductor" else None, activo="si",
                push_token=f"ExponentPushToken[{tel}]", push_modo="datos", ubic_lat=lat, ubic_lon=lon,
                ubic_fecha=datetime.now() if lat else None)
    db.add(u); db.commit(); db.refresh(u)
    r = cli.post(f"/login?telefono={tel}&password=clave123"); u_tok = r.json().get("token")
    return u.id, u_tok

def H(tok): return {"X-User-Token": tok}
def HA(tok): return {"X-Admin-Token": tok}
def avisos_a(tel): return [m for m in ENVIADOS if m.get("to") == f"ExponentPushToken[{tel}]"]
def limpiar(): ENVIADOS.clear()

# --- ciudades como en produccion
def ciudad(n, dep, lat, lon, vehs, km=0, minima=0):
    m = db.query(Municipio).filter(Municipio.nombre == n).first() or Municipio(nombre=n)
    m.departamento, m.centro_lat, m.centro_lon, m.vehiculos, m.activo, m.usa_gps = dep, lat, lon, vehs, "si", "si"
    m.valor_km, m.tarifa_minima, m.tarifa_base = km, minima, 0
    db.merge(m); db.commit()
ciudad("Cali", "Valle del Cauca", 3.4465, -76.5188, "carro,moto,motocarguero,camion,furgon,grua,planchon,camioneta", 2000, 8000)
ciudad("Orito", "Putumayo", 0.6668, -76.8719, "carro,motocarguero,camioneta,camion,furgon,planchon,grua,camion_pequeno")
ciudad("Popayán", "Cauca", 2.4419, -76.6063, "carro,moto")
for k, v in (("promo_activa_Cali", "si"), ("promo_pct_Cali", "20")):
    pass
# promo de Cali como en produccion (si el endpoint existe)
try:
    _r = TestClient(main.app).put("/promo?municipio=Cali&pct=20&activa=si&hasta=2026-12-31&clave=clave-e2e")
except Exception:
    pass

# --- gente
cli_id, cli_tok = crear("Ana Prueba", "3001110001", "cliente", "Cali")
cli2_id, cli2_tok = crear("Beto Orito", "3001110002", "cliente", "Orito")
juan_id, juan_tok = crear("Juan Dueno", "3117313685", "conductor", "Cali", "carro", 3.45, -76.53)
car_id, car_tok = crear("Carlos Carro", "3001110003", "conductor", "Cali", "carro", 3.451, -76.531)
cam_id, cam_tok = crear("Camilo Camion", "3001110004", "conductor", "Cali", "camion", 3.452, -76.532)
rob_id, rob_tok = crear("Roberto Orito", "3001110005", "conductor", "Orito", "carro", 0.67, -76.87)
adm_id, adm_tok = crear("Admin", "3001110009", "admin", "Cali")
_f = db.query(Config).filter(Config.clave == "exclusivo_aeropuerto_tel").first()
if _f: _f.valor = "3117313685"
else: db.add(Config(clave="exclusivo_aeropuerto_tel", valor="3117313685"))
db.commit()
main._cache_excl["t"] = 0
print("\n== Ubicacion y tarifas")
r = cli.get("/municipios"); chk("municipios", r.status_code == 200 and any(m["nombre"] == "Cali" for m in r.json()))
r = cli.get("/tarifa?municipio=Cali&vehiculo=carro&origen_lat=3.4516&origen_lon=-76.532&destino_lat=3.43&destino_lon=-76.52&usuario_id=%d" % cli_id)
chk("tarifa carro con sugerido", r.status_code == 200 and r.json().get("tarifa_sugerida"), r.text)
r = cli.get("/ubicacion/municipio?lat=3.45&lon=-76.53"); chk("municipio por GPS = Cali", r.json().get("nombre") == "Cali", r.text)

print("\n== Carrera normal: pedir, contraoferta, rechazo a los 10 s, aceptar, estados, finalizar")
limpiar()
q = dict(cliente_id=cli_id, origen="Calle 5", destino="Unicentro", vehiculo_pedido="carro", origen_lat=3.4516, origen_lon=-76.532,
         destino_lat=3.43, destino_lon=-76.52, tarifa_ofrecida=8000, municipio="Cali")
r = cli.post("/carreras", params=q, headers=H(cli_tok)); c = r.json(); cid = c.get("id")
chk("pedir carrera", r.status_code == 200 and c.get("estado") == "buscando", r.text)
chk("aviso a conductores de carro", len(avisos_a("3001110003")) > 0, ENVIADOS)
chk("NO le avisa al de camion", len(avisos_a("3001110004")) == 0)
r = cli.get(f"/carreras/disponibles?conductor_id={car_id}"); chk("conductor la ve", any(x["id"] == cid for x in r.json()))
r = cli.get(f"/carreras/disponibles?conductor_id={cam_id}"); chk("camion no la ve", not any(x["id"] == cid for x in r.json()))
limpiar()
r = cli.post(f"/carreras/{cid}/ofertas?conductor_id={car_id}&monto=10000", headers=H(car_tok)); of = r.json()
chk("contraoferta", r.status_code == 200 and of.get("monto") == 10000, r.text)
chk("aviso de contraoferta al pasajero", len(avisos_a("3001110001")) > 0)
r = cli.get(f"/carreras/{cid}/ofertas"); chk("pasajero ve la contraoferta", len(r.json()) == 1)
r = cli.get(f"/carreras/disponibles?conductor_id={car_id}"); chk("conductor ve 'ya ofertaste'", any(x["id"] == cid and x["mi_oferta"] == 10000 and x["alertar"] is False for x in r.json()))
limpiar()
r = cli.put(f"/carreras/{cid}/ofertas/{of['id']}/rechazar", headers=H(cli_tok)); chk("rechazo a los 10 s", r.status_code == 200)
chk("aviso 'no tomo tu precio' al conductor", any("no tomó" in (m.get("title") or "") for m in avisos_a("3001110003")))
r = cli.get(f"/carreras/{cid}/ofertas"); chk("ya no aparece al pasajero", len(r.json()) == 0)
r = cli.get(f"/carreras/disponibles?conductor_id={car_id}"); chk("conductor puede volver a ofertar", any(x["id"] == cid and x["mi_oferta"] is None for x in r.json()))
r = cli.post(f"/carreras/{cid}/ofertas?conductor_id={car_id}&monto=9500", headers=H(car_tok)); of2 = r.json()
limpiar()
r = cli.put(f"/carreras/{cid}/aceptar-oferta?oferta_id={of2['id']}", headers=H(cli_tok)); c = r.json()
chk("pasajero acepta", r.status_code == 200 and c.get("estado") == "aceptada" and c.get("tarifa") == 9500, r.text)
chk("aviso 'aceptó tu precio' al conductor", any("aceptó" in (m.get("title") or "") for m in avisos_a("3001110003")))
r = cli.get(f"/carreras/disponibles?conductor_id={juan_id}"); chk("desaparece para los demas", not any(x["id"] == cid for x in r.json()))
r = cli.put(f"/conductores/{car_id}/ubicacion?lat=3.445&lon=-76.528"); chk("reporte de ubicacion", r.status_code == 200, r.text)
r = cli.get(f"/carreras/cliente/{cli_id}"); cc = [x for x in r.json() if x["id"] == cid][0]
chk("pasajero ve ubicacion del conductor", cc.get("conductor_lat") == 3.445, cc)
for est in ("en_sitio", "en_camino"):
    r = cli.put(f"/carreras/{cid}/estado?estado={est}", headers=H(car_tok)); chk(f"estado {est}", r.json().get("estado") == est, r.text)
r = cli.put(f"/carreras/{cid}/estado?estado=cancelada", headers=H(cli_tok)); chk("en camino NO se cancela", r.status_code == 400)
r = cli.put(f"/carreras/{cid}/estado?estado=finalizada&tarifa=9500", headers=H(car_tok)); chk("finalizar", r.json().get("estado") == "finalizada", r.text)
r = cli.get(f"/diag/carrera/{cid}?clave=clave-e2e"); chk("diag linea de tiempo", r.status_code == 200 and len(r.json()["ofertas"]) == 2, r.text)

print("\n== Carrera: tomar al precio y cancelar")
q2 = dict(q, tarifa_ofrecida=8000)
r = cli.post("/carreras", params=q2, headers=H(cli_tok)); c2 = r.json()["id"]
r = cli.put(f"/carreras/{c2}/aceptar?conductor_id={car_id}", headers=H(car_tok)); chk("conductor toma al precio", r.json().get("estado") == "aceptada", r.text)
limpiar()
r = cli.put(f"/carreras/{c2}/estado?estado=cancelada&motivo=prueba", headers=H(cli_tok)); chk("pasajero cancela a tiempo", r.json().get("estado") == "cancelada", r.text)
chk("aviso de cancelacion al conductor", len(avisos_a("3001110003")) > 0)

print("\n== Acarreo en la ciudad: datos de camion, solo a carga, vence a 15 min")
limpiar()
qa = dict(cliente_id=cli_id, origen="Calle 5", destino="Bodega", vehiculo_pedido="camion", origen_lat=3.4516, origen_lon=-76.532,
          destino_lat=3.43, destino_lon=-76.52, tarifa_ofrecida=120000, municipio="Cali", tipo_carga="trasteo", tamano_carga="grande",
          ayudantes=2, piso_origen=3, ascensor_origen="no", recibe_nombre="Pedro", capacidad_carga="sencillo", carroceria="furgon", notas="nevera y cama")
r = cli.post("/carreras", params=qa, headers=H(cli_tok)); a = r.json(); aid = a.get("id")
chk("pedir acarreo", r.status_code == 200 and a.get("capacidad_carga") == "sencillo" and a.get("carroceria") == "furgon", r.text)
chk("aviso al de camion", len(avisos_a("3001110004")) > 0)
chk("NO al de carro", len(avisos_a("3001110003")) == 0)
r = cli.get(f"/carreras/disponibles?conductor_id={cam_id}"); x = [y for y in r.json() if y["id"] == aid]
chk("acarreo alerta a todos al instante", x and x[0]["alertar"] is True, x)
cc = db.query(Carrera).get(aid); cc.fecha = datetime.now() - timedelta(minutes=20); db.commit()
main._time.sleep = lambda s: (_ for _ in ()).throw(SystemExit)
try: main._revisar_acarreos_sin_tomar()
except SystemExit: pass
db.expire_all(); cc = db.query(Carrera).get(aid)
chk("acarreo sin tomar se cancela a los 15 min", cc.estado == "cancelada" and cc.cancelada_por == "sistema", cc.estado)

print("\n== Viaje a otra ciudad (pasajeros): exclusiva de Juan, descartar, oferta, aceptar, Recibido, liberar, reprogramar")
limpiar()
qe = dict(cliente_id=cli_id, destino_municipio="Popayán", origen="Calle 5", cupos=2, precio_por_cupo=30000,
          origen_lat=3.4516, origen_lon=-76.532, destino_lat=2.44, destino_lon=-76.61, origen_municipio="Cali")
r = cli.post("/expresos", params=qe, headers=H(cli_tok)); e = r.json(); eid = e.get("id")
chk("publicar viaje", r.status_code == 200 and e.get("origen_municipio") == "Cali" and e.get("tipo") == "pasajeros", r.text)
chk("en exclusiva solo a Juan", len(avisos_a("3117313685")) > 0 and len(avisos_a("3001110003")) == 0)
r = cli.get(f"/expresos/disponibles?conductor_id={car_id}"); chk("otro conductor aun no lo ve", not any(x["id"] == eid for x in r.json()))
r = cli.get(f"/expresos/disponibles?conductor_id={juan_id}"); chk("Juan lo ve marcado exclusivo", any(x["id"] == eid and x["exclusivo"] for x in r.json()))
limpiar()
r = cli.put(f"/expresos/{eid}/descartar", headers=H(juan_tok)); chk("Juan descarta -> se libera", r.json().get("liberado") is True, r.text)
chk("al liberarse les avisa a los demas", len(avisos_a("3001110003")) > 0)
chk("al liberarse NO al de camion", len(avisos_a("3001110004")) == 0)
r = cli.get(f"/expresos/disponibles?conductor_id={car_id}"); chk("ahora el otro lo ve", any(x["id"] == eid for x in r.json()))
limpiar()
r = cli.post(f"/expresos/{eid}/ofertas?conductor_id={car_id}&monto=35000", headers=H(car_tok)); oe = r.json()
chk("propuesta por cupo", r.status_code == 200, r.text)
chk("aviso de propuesta al pasajero", len(avisos_a("3001110001")) > 0)
limpiar()
r = cli.put(f"/expresos/{eid}/aceptar-oferta?oferta_id={oe['id']}", headers=H(cli_tok)); chk("pasajero acepta propuesta", r.status_code == 200, r.text)
r = cli.get(f"/expresos/conductor/{car_id}"); me = [x for x in r.json() if x["id"] == eid]
chk("conductor la tiene y pide 'Recibido'", me and me[0]["estado"] == "aceptado" and not me[0]["conductor_confirmo"], me)
limpiar()
r = cli.put(f"/expresos/{eid}/recibido", headers=H(car_tok)); chk("Recibido", r.json().get("conductor_confirmo"), r.text)
chk("aviso 'conductor confirmo' al pasajero", len(avisos_a("3001110001")) > 0)
limpiar()
r = cli.put(f"/expresos/{eid}/estado?estado=cancelado", headers=H(car_tok)); chk("conductor no puede -> vuelve a buscando", r.json().get("estado") == "buscando", r.text)
chk("aviso al pasajero", len(avisos_a("3001110001")) > 0)
r = cli.put(f"/expresos/{eid}/reprogramar?salida=" + (datetime.now() + timedelta(days=2)).strftime("%Y-%m-%dT08:00"), headers=H(cli_tok))
chk("reprogramar", r.json().get("estado") == "buscando" and r.json().get("salida"), r.text)
ee = db.query(Expreso).get(eid); ee.salida = None; ee.fecha = datetime.now() - timedelta(hours=2); ee.exclusivo_hasta = None; db.commit()
r = cli.get(f"/expresos/disponibles?conductor_id={car_id}"); chk("'lo antes posible' de 2 h ya no se ofrece", not any(x["id"] == eid for x in r.json()))
r = cli.get(f"/expresos/cliente/{cli_id}?tipo=pasajeros"); chk("pasajero lo ve vencido", any(x["id"] == eid and x["vencido"] for x in r.json()))

print("\n== Viaje desde Orito: sin exclusiva, directo a la zona")
limpiar()
qo = dict(cliente_id=cli2_id, destino_municipio="Cali", origen="Parque", cupos=1, precio_por_cupo=150000,
          origen_lat=0.67, origen_lon=-76.87, destino_lat=3.45, destino_lon=-76.53, origen_municipio="Orito")
r = cli.post("/expresos", params=qo, headers=H(cli2_tok)); eo = r.json()
chk("viaje Orito -> Cali", r.status_code == 200 and eo.get("origen_municipio") == "Orito", r.text)
chk("le avisa a Roberto (Orito)", len(avisos_a("3001110005")) > 0)
r = cli.get(f"/expresos/disponibles?conductor_id={rob_id}"); chk("Roberto lo ve", any(x["id"] == eo["id"] for x in r.json()))

print("\n== Acarreo a otra ciudad: datos de carga, solo a camion")
limpiar()
qc = dict(qe, tipo="carga", vehiculo="camion", precio_por_cupo=1500000, tipo_carga="trasteo", tamano_carga="grande", ayudantes=2,
          capacidad_carga="sencillo", carroceria="furgon", recibe_nombre="Pedro", notas="trasteo")
r = cli.post("/expresos", params=qc, headers=H(cli_tok)); ec = r.json()
chk("publicar acarreo a otra ciudad", r.status_code == 200 and ec.get("tipo") == "carga" and ec.get("cupos") == 1 and ec.get("tamano_carga") == "grande", r.text)
chk("aviso al de camion", len(avisos_a("3001110004")) > 0)
chk("NO a los de carro", len(avisos_a("3001110003")) == 0 and len(avisos_a("3117313685")) == 0)
r = cli.get(f"/expresos/disponibles?conductor_id={cam_id}"); chk("camion lo ve con detalles", any(x["id"] == ec["id"] and x.get("carroceria") == "furgon" for x in r.json()))
r = cli.get(f"/expresos/cliente/{cli_id}?tipo=carga"); chk("Mis acarreos solo trae carga", r.json() and all(x["tipo"] == "carga" for x in r.json()))
r = cli.get(f"/expresos/cliente/{cli_id}?tipo=pasajeros"); chk("Mis viajes solo trae pasajeros", all(x["tipo"] == "pasajeros" for x in r.json()))

print("\n== Admin")
for url in ("/admin/diagnostico", "/admin/difusion", "/admin/bonos", "/admin/expresos/config", "/admin/expresos", "/admin/recargo", "/conductores", "/admin/novedades?dias=7"):
    r = cli.get(url, headers=HA(adm_tok)); chk("admin " + url, r.status_code == 200, r.text)
r = cli.put("/admin/tarifas?municipio=Cali&vehiculo=camion&base=40000&valor_km=3000&minima=60000", headers=HA(adm_tok)); chk("precio guia acarreo", r.status_code == 200, r.text)
r = cli.get("/tarifa?municipio=Cali&vehiculo=camion&origen_lat=3.4516&origen_lon=-76.532&destino_lat=3.43&destino_lon=-76.52")
chk("tarifa camion con guia (sin promo)", r.json().get("tarifa_sugerida") and not r.json()["promo"]["aplica"], r.text)
r = cli.put("/admin/expresos/config?excluir=Orito,Neiva&minutos=10", headers=HA(adm_tok)); chk("config exclusiva", r.json().get("minutos") == 10 and "Neiva" in r.json().get("excluir"), r.text)
r = cli.get("/admin/difusion", headers={"X-Admin-Token": "malo"}); chk("admin protegido", r.status_code in (401, 403))

print("\n== Bonos")
limpiar()
r = cli.post("/admin/bonos/activar", headers=HA(adm_tok)); b = r.json(); chk("activar bonos", r.status_code == 200 and b.get("carrera", 0) >= 1 and b.get("suscripcion", 0) >= 1, b)
r = cli.get(f"/usuarios/{cli_id}/bono", headers=H(cli_tok)); chk("pasajero Cali: bono de carrera", r.json().get("tipo") == "carrera5000" and r.json().get("valor") == 2000, r.text)
r = cli.get(f"/usuarios/{cli2_id}/bono", headers=H(cli2_tok)); chk("pasajero Orito: bono Nequi", r.json().get("tipo") == "nequi2000", r.text)
r = cli.put(f"/usuarios/{cli2_id}/bono/reclamar?nequi=3001112222", headers=H(cli2_tok)); chk("reclamar Nequi", r.json().get("estado") == "reclamado", r.text)
r = cli.put(f"/admin/bonos/{cli2_id}/pagado", headers=HA(adm_tok)); chk("marcar pagado", r.status_code == 200, r.text)
r = cli.get("/tarifa?municipio=Cali&vehiculo=carro&origen_lat=3.4516&origen_lon=-76.532&destino_lat=3.43&destino_lon=-76.52&usuario_id=%d" % cli_id)
t = r.json(); chk("tarifa con bono = completa - 2000 (sin 20%)", t.get("bono") == 2000 and t["tarifa_sugerida"] == t["tarifa_normal"] - 2000, t)
r = cli.post("/carreras", params=q, headers=H(cli_tok)); cb = r.json(); chk("carrera lleva el bono", cb.get("bono") == 2000, r.text)
cli.put(f"/carreras/{cb['id']}/aceptar?conductor_id={car_id}", headers=H(car_tok))
for est in ("en_sitio", "en_camino", "finalizada"):
    cli.put(f"/carreras/{cb['id']}/estado?estado={est}", headers=H(car_tok))
r = cli.get(f"/usuarios/{cli_id}/bono", headers=H(cli_tok)); chk("bono usado al finalizar", r.json().get("tipo") is None, r.text)
r = cli.put(f"/conductores/{car_id}/suscripcion?meses=1", headers=HA(adm_tok)); chk("descuento en primer pago del conductor", r.json().get("descuento_bono") == 2000, r.text)
r = cli.put(f"/conductores/{car_id}/suscripcion?meses=1", headers=HA(adm_tok)); chk("segundo pago sin descuento", r.json().get("descuento_bono") == 0, r.text)

print(f"\nRESULTADO: {len(OK)} OK, {len(MAL)} FALLAS")
for m in MAL: print("  - " + m)
