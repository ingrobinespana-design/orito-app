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
        <p style={{ color: "#fff", fontSize: "22px", fontWeight: 500, margin: "4px 0 0" }}>Orito App 🛵</p>
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
  const [formulario, setFormulario] = useState({ cliente_direccion: "", plato: "" });
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
    fetch(`${API}/pedidos?cliente_nombre=${usuario.nombre}&cliente_direccion=${formulario.cliente_direccion}&cliente_telefono=${usuario.telefono}&restaurante_id=${restauranteSeleccionado.id}&plato=${formulario.plato}&total=${restauranteSeleccionado.domicilio + 10000}`, { method: "POST" })
      .then((res) => res.json())
      .then(() => {
        setPedidoEnviado(true);
        setRestauranteSeleccionado(null);
        setFormulario({ cliente_direccion: "", plato: "" });
      })
      .catch(() => alert("Error al enviar pedido"));
  };

  if (!usuario) return <Login onLogin={setUsuario} />;
  if (usuario.rol === "domiciliario") return <Domiciliario API={API} usuario={usuario} onSalir={() => setUsuario(null)} />;
  if (verAdmin) return <Admin API={API} />;

  return (
    <div style={{ fontFamily: "sans-serif", maxWidth: "400px", margin: "0 auto", padding: "16px" }}>

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "8px" }}>
        <span style={{ fontSize: "13px", color: "#888" }}>Hola, {usuario.nombre} 👋</span>
        <div style={{ display: "flex", gap: "12px" }}>
          {usuario.rol === "admin" && <span onClick={() => setVerAdmin(true)} style={{ fontSize: "12px", color: "#D85A30", cursor: "pointer" }}>Admin</span>}
          <span onClick={() => setUsuario(null)} style={{ fontSize: "12px", color: "#888", cursor: "pointer" }}>Salir</span>
        </div>
      </div>

      <div style={{ background: "#D85A30", borderRadius: "16px", padding: "20px",