import { useState, useEffect } from "react";
import Admin from "./Admin";

function App() {
  const [restaurantes, setRestaurantes] = useState([]);
  const [restauranteSeleccionado, setRestauranteSeleccionado] = useState(null);
  const [formulario, setFormulario] = useState({ cliente_nombre: "", cliente_direccion: "", cliente_telefono: "", plato: "" });
  const [pedidoEnviado, setPedidoEnviado] = useState(false);
  const [verAdmin, setVerAdmin] = useState(false);

  useEffect(() => {
    fetch("http://127.0.0.1:8000/restaurantes")
      .then((res) => res.json())
      .then((data) => setRestaurantes(data));
  }, []);

  const hacerPedido = () => {
    if (!formulario.cliente_nombre || !formulario.cliente_direccion || !formulario.plato) {
      alert("Por favor completa todos los campos");
      return;
    }
    fetch(`http://127.0.0.1:8000/pedidos?cliente_nombre=${formulario.cliente_nombre}&cliente_direccion=${formulario.cliente_direccion}&cliente_telefono=${formulario.cliente_telefono}&restaurante_id=${restauranteSeleccionado.id}&plato=${formulario.plato}&total=${restauranteSeleccionado.domicilio + 10000}`, { method: "POST" })
      .then((res) => res.json())
      .then(() => {
        setPedidoEnviado(true);
        setRestauranteSeleccionado(null);
        setFormulario({ cliente_nombre: "", cliente_direccion: "", cliente_telefono: "", plato: "" });
      })
      .catch(() => alert("Error al enviar pedido"));
  };

  if (verAdmin) return <Admin />;

  return (
    <div style={{ fontFamily: "sans-serif", maxWidth: "400px", margin: "0 auto", padding: "16px" }}>

      <div style={{ textAlign: "right", marginBottom: "8px" }}>
        <span onClick={() => setVerAdmin(true)} style={{ fontSize: "12px", color: "#888", cursor: "pointer" }}>Panel admin</span>
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
            <button onClick={() => setRestauranteSeleccionado(null)} style={{ background: "none", border: "none", fontSize: "18px", cursor: "pointer" }}>✕</button>
          </div>
          <input placeholder="Tu nombre" value={formulario.cliente_nombre} onChange={(e) => setFormulario({ ...formulario, cliente_nombre: e.target.value })} style={{ width: "100%", padding: "10px", borderRadius: "8px", border: "0.5px solid #ddd", marginBottom: "10px", boxSizing: "border-box", fontSize: "13px" }} />
          <input placeholder="Tu direccion" value={formulario.cliente_direccion} onChange={(e) => setFormulario({ ...formulario, cliente_direccion: e.target.value })} style={{ width: "100%", padding: "10px", borderRadius: "8px", border: "0.5px solid #ddd", marginBottom: "10px", boxSizing: "border-box", fontSize: "13px" }} />
          <input placeholder="Tu telefono" value={formulario.cliente_telefono} onChange={(e) => setFormulario({ ...formulario, cliente_telefono: e.target.value })} style={{ width: "100%", padding: "10px", borderRadius: "8px", border: "0.5px solid #ddd", marginBottom: "10px", boxSizing: "border-box", fontSize: "13px" }} />
          <input placeholder="Que quieres pedir?" value={formulario.plato} onChange={(e) => setFormulario({ ...formulario, plato: e.target.value })} style={{ width: "100%", padding: "10px", borderRadius: "8px", border: "0.5px solid #ddd", marginBottom: "16px", boxSizing: "border-box", fontSize: "13px" }} />
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
                <span style={{ background: "#EAF3DE", color: "#3B6D11", fontSize: "12px", padding: "2px 8px", borderRadius: "8px" }}>⭐ {r.calificacion}</span>
              </div>
              <div style={{ display: "flex", gap: "12px", marginTop: "8px" }}>
                <span style={{ fontSize: "12px", color: "#888" }}>🕐 {r.tiempo}</span>
                <span style={{ fontSize: "12px", color: "#888" }}>🛵 ${r.domicilio.toLocaleString()}</span>
              </div>
            </div>
          ))}
        </>
      )}

    </div>
  );
}

export default App;