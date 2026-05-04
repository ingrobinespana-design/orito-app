import { useState, useEffect } from "react";

function Domiciliario({ API, usuario, onSalir }) {
  const [pedidos, setPedidos] = useState([]);

  const cargarPedidos = () => {
    fetch(`${API}/pedidos`)
      .then((res) => res.json())
      .then((data) => setPedidos(data.filter(p => p.estado === "pendiente" || p.estado === "en camino")));
  };

  useEffect(() => {
    cargarPedidos();
    const intervalo = setInterval(cargarPedidos, 8000);
    return () => clearInterval(intervalo);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const cambiarEstado = (id, estado) => {
    fetch(`${API}/pedidos/${id}/estado?estado=${estado}`, { method: "PUT" })
      .then(() => cargarPedidos());
  };

  const colorEstado = (estado) => {
    if (estado === "pendiente") return { background: "#FAEEDA", color: "#854F0B" };
    if (estado === "en camino") return { background: "#E6F1FB", color: "#185FA5" };
    return {};
  };

  return (
    <div style={{ fontFamily: "sans-serif", maxWidth: "400px", margin: "0 auto", padding: "16px" }}>

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "8px" }}>
        <span style={{ fontSize: "13px", color: "#888" }}>Hola, {usuario.nombre} 🛵</span>
        <span onClick={onSalir} style={{ fontSize: "12px", color: "#888", cursor: "pointer" }}>Salir</span>
      </div>

      <div style={{ background: "#185FA5", borderRadius: "16px", padding: "20px", marginBottom: "20px" }}>
        <p style={{ color: "rgba(255,255,255,0.8)", fontSize: "12px", margin: 0 }}>Panel de</p>
        <p style={{ color: "#fff", fontSize: "20px", fontWeight: 500, margin: "4px 0 0" }}>Domiciliario 🛵</p>
      </div>

      <h3 style={{ margin: "0 0 12px" }}>Pedidos activos</h3>

      {pedidos.length === 0 && (
        <div style={{ textAlign: "center", padding: "40px", color: "#888" }}>
          <p style={{ fontSize: "32px" }}>😴</p>
          <p>No hay pedidos por ahora</p>
        </div>
      )}

      {pedidos.map((p) => (
        <div key={p.id} style={{ border: "0.5px solid #ddd", borderRadius: "12px", padding: "14px", marginBottom: "12px" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "start", marginBottom: "10px" }}>
            <div>
              <p style={{ fontWeight: 500, margin: 0 }}>{p.cliente_nombre}</p>
              <p style={{ fontSize: "12px", color: "#888", margin: "4px 0" }}>📍 {p.cliente_direccion}</p>
              <p style={{ fontSize: "12px", color: "#888", margin: "4px 0" }}>📞 {p.cliente_telefono}</p>
              <p style={{ fontSize: "12px", color: "#888", margin: "4px 0" }}>🍽️ {p.plato}</p>
              <p style={{ fontSize: "12px", color: "#888", margin: "4px 0" }}>💰 ${p.total.toLocaleString()}</p>
            </div>
            <span style={{ ...colorEstado(p.estado), fontSize: "11px", padding: "4px 10px", borderRadius: "8px", fontWeight: 500 }}>{p.estado}</span>
          </div>
          <div style={{ display: "flex", gap: "8px" }}>
            {p.estado === "pendiente" && (
              <button onClick={() => cambiarEstado(p.id, "en camino")} style={{ background: "#185FA5", color: "#fff", border: "none", borderRadius: "8px", padding: "10px 16px", cursor: "pointer", fontSize: "13px", fontWeight: 500 }}>
                Aceptar pedido
              </button>
            )}
            {p.estado === "en camino" && (
              <button onClick={() => cambiarEstado(p.id, "entregado")} style={{ background: "#3B6D11", color: "#fff", border: "none", borderRadius: "8px", padding: "10px 16px", cursor: "pointer", fontSize: "13px", fontWeight: 500 }}>
                Marcar entregado
              </button>
            )}
          </div>
        </div>
      ))}

    </div>
  );
}

export default Domiciliario;