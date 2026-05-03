import { useState, useEffect } from "react";

function Admin({ API }) {
  const [pedidos, setPedidos] = useState([]);

  const cargarPedidos = () => {
    fetch(`${API}/pedidos`)
      .then((res) => res.json())
      .then((data) => setPedidos(data));
  };

 useEffect(() => {
    cargarPedidos();
    const intervalo = setInterval(cargarPedidos, 10000);
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
    if (estado === "entregado") return { background: "#EAF3DE", color: "#3B6D11" };
    return {};
  };

  return (
    <div style={{ fontFamily: "sans-serif", maxWidth: "600px", margin: "0 auto", padding: "16px" }}>
      <div style={{ background: "#D85A30", borderRadius: "16px", padding: "20px", marginBottom: "20px" }}>
        <p style={{ color: "rgba(255,255,255,0.8)", fontSize: "12px", margin: 0 }}>Panel de control</p>
        <p style={{ color: "#fff", fontSize: "20px", fontWeight: 500, margin: "4px 0 0" }}>Orito App - Admin</p>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: "12px", marginBottom: "20px" }}>
        <div style={{ background: "#FAEEDA", borderRadius: "12px", padding: "16px" }}>
          <p style={{ fontSize: "12px", color: "#854F0B", margin: "0 0 4px" }}>Pendientes</p>
          <p style={{ fontSize: "24px", fontWeight: 500, color: "#854F0B", margin: 0 }}>{pedidos.filter(p => p.estado === "pendiente").length}</p>
        </div>
        <div style={{ background: "#E6F1FB", borderRadius: "12px", padding: "16px" }}>
          <p style={{ fontSize: "12px", color: "#185FA5", margin: "0 0 4px" }}>En camino</p>
          <p style={{ fontSize: "24px", fontWeight: 500, color: "#185FA5", margin: 0 }}>{pedidos.filter(p => p.estado === "en camino").length}</p>
        </div>
        <div style={{ background: "#EAF3DE", borderRadius: "12px", padding: "16px" }}>
          <p style={{ fontSize: "12px", color: "#3B6D11", margin: "0 0 4px" }}>Entregados</p>
          <p style={{ fontSize: "24px", fontWeight: 500, color: "#3B6D11", margin: 0 }}>{pedidos.filter(p => p.estado === "entregado").length}</p>
        </div>
        <div style={{ background: "#F1EFE8", borderRadius: "12px", padding: "16px" }}>
          <p style={{ fontSize: "12px", color: "#5F5E5A", margin: "0 0 4px" }}>Total pedidos</p>
          <p style={{ fontSize: "24px", fontWeight: 500, color: "#5F5E5A", margin: 0 }}>{pedidos.length}</p>
        </div>
      </div>

      <h3 style={{ margin: "0 0 12px" }}>Pedidos</h3>

      {pedidos.length === 0 && (
        <p style={{ color: "#888", textAlign: "center", padding: "20px" }}>No hay pedidos aun</p>
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
              <button onClick={() => cambiarEstado(p.id, "en camino")} style={{ background: "#185FA5", color: "#fff", border: "none", borderRadius: "8px", padding: "8px 14px", cursor: "pointer", fontSize: "12px" }}>Enviar</button>
            )}
            {p.estado === "en camino" && (
              <button onClick={() => cambiarEstado(p.id, "entregado")} style={{ background: "#3B6D11", color: "#fff", border: "none", borderRadius: "8px", padding: "8px 14px", cursor: "pointer", fontSize: "12px" }}>Entregado</button>
            )}
            {p.estado === "entregado" && (
              <span style={{ fontSize: "12px", color: "#3B6D11" }}>Completado ✓</span>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

export default Admin;