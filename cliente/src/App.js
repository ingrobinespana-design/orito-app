import { useState, useEffect } from "react";
import Admin from "./Admin";
import Domiciliario from "./Domiciliario";

const API = "https://orito-app-production.up.railway.app";

function Login({ onLogin }) {
  const [modo, setModo] = useState("login");
  const [form, setForm] = useState({ nombre: "", telefono: "", password: "" });
  const [error, setError] = useState("");

  const handleSubmit = () => {
    const url = modo === "login"
      ? `${API}/login?telefono=${form.telefono}&password=${form.password}`
      : `${API}/registro?nombre=${form.nombre}&telefono=${form.telefono}&password=${form.password}`;

    fetch(url, { method: "POST" })
      .then((res) => res.json())
      .then((data) => {
        if (data.detail) { setError(data.detail); return; }
        onLogin(data);
      })
      .catch(() => setError("Error de conexion"));
  };

  return (
    <div style={{ fontFamily: "sans-serif", maxWidth: "400px", margin: "0 auto", padding: "16px" }}>
      <div style={{ background: "#D85A30", borderRadius: "16px", padding: "20px", marginBottom: "20px" }}>
        <p style={{ color: "rgba(255,255,255,0.8)", fontSize: "12px", margin: 0 }}>Bienvenido a</p>
        <p style={{ color: "#fff", fontSize: "22px", fontWeight: 500, margin: "4px 0 0" }}>Orito App</p>
      </div>
      <div style={{ border: "0.5px solid #ddd", borderRadius: "12px", padding: "20px" }}>
        <div style={{ display: "flex", marginBottom: "20px", background: "#f5f5f5", borderRadius: "8px", padding: "4px" }}>
          <button onClick={() => setModo("login")} style={{ flex: 1, padding: "8px", border: "none", borderRadius: "6px", background: modo === "login" ? "#fff" : "transparent", cursor: "pointer", fontWeight: modo === "login" ? 500 : 400 }}>Ingresar</button>
          <button onClick={() => setModo("registro")} style={{ flex: 1, padding: "8px", border: "none", borderRadius: "6px", background: modo === "registro" ? "#fff" : "transparent", cursor: "pointer", fontWeight: modo === "registro" ? 500 : 400 }}>Registrarse</button>
        </div>
        {modo === "registro" && (
          <input placeholder="Tu nombre" value={form.nombre} onChange={(e) => setForm({ ...form, nombre: e.target.value })} style={{ width: "100%", padding: "10px", borderRadius: "8px", border: "0.5px solid #ddd", marginBottom: "10px", boxSizing: "border-box", fontSize: "13px" }} />
        )}
        <input placeholder="Telefono" value={form.telefono} onChange={(e) => setForm({ ...form, telefono: e.target.value })} style={{ width: "100%", padding: "10px", borderRadius: "8px", border: "0.5px solid #ddd", marginBottom: "10px", boxSizing: "border-box", fontSize: "13px" }} />
        <input placeholder="Contrasena" type="password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} style={{ width: "100%", padding: "10px", borderRadius: "8px", border: "0.5px solid #ddd", marginBottom: "16px", boxSizing: "border-box", fontSize: "13px" }} />
        {error && <p style={{ color: "red", fontSize: "12px", margin: "0 0 12px" }}>{error}</p>}
        <button onClick={handleSubmit} style={{ width: "100%", padding: "12px", background: "#D85A30", color: "#fff", border: "none", borderRadius: "8px", cursor: "pointer", fontWeight: 500, fontSize: "14px" }}>
          {modo === "login" ? "Ingresar" : "Crear cuenta"}
        </button>
      </div>
    </div>
  );
}

function App() {
  const [restaurantes, setRestaurantes] = useState([]);
  const [restauranteSeleccionado, setRestauranteSeleccionado] = useState(null);
  const [formulario, setFormulario] = useState({ cliente_direccion: "", plato: "", metodo_pago: "efectivo" });
  const [pedidoEnviado, setPedidoEnviado] = useState(false);
  const [usuario, setUsuario] = useState(null);
  const [verAdmin, setVerAdmin] = useState(false);

  useEffect(() => {
    if (usuario) {
      fetch(`${API}/restaurantes`)
        .then((res) => res.json())
        .then((data) => setRestaurantes(data));
    }
  }, [usuario]);

  const hacerPedido = () => {
    if (!formulario.cliente_direccion || !formulario.plato) {
      alert("Por favor completa todos los campos");
      return;
    }
    fetch(`${API}/pedidos?cliente_nombre=${usuario.nombre}&cliente_direccion=${formulario.cliente_direccion}&cliente_telefono=${usuario.telefono}&restaurante_id=${restauranteSeleccionado.id}&plato=${formulario.plato}&total=${restauranteSeleccionado.domicilio + 10000}&metodo_pago=${formulario.metodo_pago}`, { method: "POST" })
      .then((res) => res.json())
      .then(() => {
        setPedidoEnviado(true);
        setRestauranteSeleccionado(null);
        setFormulario({ cliente_direccion: "", plato: "", metodo_pago: "efectivo" });
      })
      .catch(() => alert("Error al enviar pedido"));
  };

  if (!usuario) return <Login onLogin={setUsuario} />;
  if (usuario.rol === "domiciliario") return <Domiciliario API={API} usuario={usuario} onSalir={() => setUsuario(null)} />;
  if (verAdmin) return <Admin API={API} />;

  return (
    <div style={{ fontFamily: "sans-serif", maxWidth: "400px", margin: "0 auto", padding: "16px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "8px" }}>
        <span style={{ fontSize: "13px", color: "#888" }}>Hola, {usuario.nombre}</span>
        <div style={{ display: "flex", gap: "12px" }}>
          {usuario.rol === "admin" && (
            <span onClick={() => setVerAdmin(true)} style={{ fontSize: "12px", color: "#D85A30", cursor: "pointer" }}>Admin</span>
          )}
          <span onClick={() => setUsuario(null)} style={{ fontSize: "12px", color: "#888", cursor: "pointer" }}>Salir</span>
        </div>
      </div>

      <div style={{ background: "#D85A30", borderRadius: "16px", padding: "20px", marginBottom: "20px" }}>
        <p style={{ color: "rgba(255,255,255,0.8)", fontSize: "12px", margin: 0 }}>Entregar en</p>
        <p style={{ color: "#fff", fontWeight: 500, margin: "4px 0 12px" }}>Orito, Putumayo</p>
        <p style={{ color: "#fff", fontSize: "20px", fontWeight: 500, margin: "0 0 12px" }}>Que quieres hoy?</p>
        <input placeholder="Buscar restaurante o plato..." style={{ width: "100%", padding: "8px 12px", borderRadius: "10px", border: "none", fontSize: "13px", boxSizing: "border-box" }} />
      </div>

      {pedidoEnviado && (
        <div style={{ background: "#EAF3DE", border: "0.5px solid #3B6D11", borderRadius: "12px", padding: "14px", marginBottom: "16px", textAlign: "center" }}>
          <p style={{ color: "#3B6D11", fontWeight: 500, margin: 0 }}>Pedido enviado exitosamente</p>
          <p style={{ color: "#639922", fontSize: "13px", margin: "4px 0 8px" }}>Tu domicilio esta en camino</p>
          <button onClick={() => setPedidoEnviado(false)} style={{ background: "#3B6D11", color: "#fff", border: "none", borderRadius: "8px", padding: "8px 16px", cursor: "pointer" }}>Hacer otro pedido</button>
        </div>
      )}

      {restauranteSeleccionado ? (
        <div style={{ border: "0.5px solid #ddd", borderRadius: "12px", padding: "16px" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "16px" }}>
            <h3 style={{ margin: 0 }}>{restauranteSeleccionado.nombre}</h3>
            <button onClick={() => setRestauranteSeleccionado(null)} style={{ background: "none", border: "none", fontSize: "18px", cursor: "pointer" }}>X</button>
          </div>
          <input placeholder="Tu direccion" value={formulario.cliente_direccion} onChange={(e) => setFormulario({ ...formulario, cliente_direccion: e.target.value })} style={{ width: "100%", padding: "10px", borderRadius: "8px", border: "0.5px solid #ddd", marginBottom: "10px", boxSizing: "border-box", fontSize: "13px" }} />
          <input placeholder="Que quieres pedir?" value={formulario.plato} onChange={(e) => setFormulario({ ...formulario, plato: e.target.value })} style={{ width: "100%", padding: "10px", borderRadius: "8px", border: "0.5px solid #ddd", marginBottom: "16px", boxSizing: "border-box", fontSize: "13px" }} />

          <p style={{ fontSize: "13px", fontWeight: 500, margin: "0 0 8px" }}>Metodo de pago:</p>
          <div style={{ display: "flex", gap: "8px", marginBottom: "16px" }}>
            {["efectivo", "nequi", "bancolombia"].map((m) => (
              <button key={m} onClick={() => setFormulario({ ...formulario, metodo_pago: m })} style={{ flex: 1, padding: "8px", border: `1px solid ${formulario.metodo_pago === m ? "#D85A30" : "#ddd"}`, borderRadius: "8px", background: formulario.metodo_pago === m ? "#FAECE7" : "#fff", color: formulario.metodo_pago === m ? "#D85A30" : "#888", cursor: "pointer", fontSize: "12px", fontWeight: formulario.metodo_pago === m ? 500 : 400 }}>
                {m === "efectivo" ? "Efectivo" : m === "nequi" ? "Nequi" : "Bancolombia"}
              </button>
            ))}
          </div>

          {formulario.metodo_pago === "nequi" && (
            <div style={{ background: "#FAECE7", borderRadius: "8px", padding: "12px", marginBottom: "16px" }}>
              <p style={{ fontSize: "13px", fontWeight: 500, color: "#D85A30", margin: "0 0 4px" }}>Transfiere por Nequi</p>
              <p style={{ fontSize: "13px", color: "#555", margin: 0 }}>Numero: <strong>3156009728</strong></p>
              <p style={{ fontSize: "12px", color: "#888", margin: "4px 0 0" }}>Envia el comprobante por WhatsApp al mismo numero</p>
            </div>
          )}

          {formulario.metodo_pago === "bancolombia" && (
            <div style={{ background: "#E6F1FB", borderRadius: "8px", padding: "12px", marginBottom: "16px" }}>
              <p style={{ fontSize: "13px", fontWeight: 500, color: "#185FA5", margin: "0 0 4px" }}>Transfiere por Bancolombia</p>
              <p style={{ fontSize: "13px", color: "#555", margin: "0 0 4px" }}>Numero de cuenta: <strong>07985044028</strong></p>
              <p style={{ fontSize: "12px", color: "#888", margin: 0 }}>Envia el comprobante por WhatsApp al 3156009728</p>
            </div>
          )}

          {formulario.metodo_pago === "efectivo" && (
            <div style={{ background: "#EAF3DE", borderRadius: "8px", padding: "12px", marginBottom: "16px" }}>
              <p style={{ fontSize: "13px", fontWeight: 500, color: "#3B6D11", margin: "0 0 4px" }}>Pago en efectivo</p>
              <p style={{ fontSize: "12px", color: "#888", margin: 0 }}>Ten el dinero listo cuando llegue el domiciliario</p>
            </div>
          )}

          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span style={{ fontSize: "13px", color: "#888" }}>Domicilio: ${restauranteSeleccionado.domicilio.toLocaleString()}</span>
            <button onClick={hacerPedido} style={{ background: "#D85A30", color: "#fff", border: "none", borderRadius: "8px", padding: "10px 20px", cursor: "pointer", fontWeight: 500 }}>Pedir ahora</button>
          </div>
        </div>
      ) : (
        <>
          <h3 style={{ margin: "0 0 12px" }}>Restaurantes</h3>
          {restaurantes.map((r) => (
            <div key={r.id} onClick={() => setRestauranteSeleccionado(r)} style={{ border: "0.5px solid #ddd", borderRadius: "12px", padding: "14px", marginBottom: "12px", cursor: "pointer" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "start" }}>
                <div>
                  <p style={{ fontWeight: 500, margin: 0 }}>{r.nombre}</p>
                  <p style={{ fontSize: "12px", color: "#888", margin: "4px 0" }}>{r.categoria}</p>
                </div>
                <span style={{ background: "#EAF3DE", color: "#3B6D11", fontSize: "12px", padding: "2px 8px", borderRadius: "8px" }}>estrella {r.calificacion}</span>
              </div>
              <div style={{ display: "flex", gap: "12px", marginTop: "8px" }}>
                <span style={{ fontSize: "12px", color: "#888" }}>{r.tiempo}</span>
                <span style={{ fontSize: "12px", color: "#888" }}>${r.domicilio.toLocaleString()}</span>
              </div>
            </div>
          ))}
        </>
      )}
    </div>
  );
}

export default App;