import { useState, useEffect } from "react";

function Domiciliario({ API, usuario, onSalir }) {
  const [pedidos, setPedidos] = useState([]);
  const [restaurantes, setRestaurantes] = useState({});

  const cargarRestaurantes = () => {
    fetch(`${API}/restaurantes`)
      .then((res) => res.json())
      .then((data) => {
        const mapa = {};
        data.forEach(r => { mapa[r.id] = r; });
        setRestaurantes(mapa);
      });
  };

  const cargarPedidos = () => {
    fetch(`${API}/pedidos`)
      .then((res) => res.json())
      .then((data) => {
        setPedidos(data.filter(p =>
          p.domiciliario_id === usuario.id &&
          p.estado !== "entregado"
        ));
      });
  };

  useEffect(() => {
    cargarRestaurantes();
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
    if (estado === "asignado") return { background: "#FAEEDA", color: "#854F0B" };
    if (estado === "en camino") return { background: "#E6F1FB", color: "#185FA5" };
    return {};
  };

  return (
    <div style={{ fontFamily: "sans-serif", maxWidth: "400px", margin: "0 auto", padding: "16px" }}>

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "8px" }}>
        <span style={{ fontSize: "13px", color: "#888" }}>Hola, {usuario.nombre} 🛵</span>
        <span onClick={onSalir} style={{ fontSize: "12px", color: "#888", cursor: "pointer" }}>Salir</span>
      </div>

      <div style={{ background: "#D85A30", borderRadius: "16px", padding: "20px", marginBottom: "20px" }}>
        <p style={{ color: "rgba(255,255,255,0.8)", fontSize: "12px", margin: 0 }}>Panel de</p>
        <p style={{ color: "#fff", fontSize: "20px", fontWeight: 500, margin: "4px 0 0" }}>Mis Entregas 🛵</p>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: "10px", marginBottom: "20px" }}>
        <div style={{ background: "#FAEEDA", borderRadius: "12px", padding: "12px", textAlign: "center" }}>
          <p style={{ fontSize: "11px", color: "#854F0B", margin: "0 0 4px" }}>Por recoger</p>
          <p style={{ fontSize: "22px", fontWeight: 500, color: "#854F0B", margin: 0 }}>{pedidos.filter(p => p.estado === "asignado").length}</p>
        </div>
        <div style={{ background: "#E6F1FB", borderRadius: "12px", padding: "12px", textAlign: "center" }}>
          <p style={{ fontSize: "11px", color: "#185FA5", margin: "0 0 4px" }}>En camino</p>
          <p style={{ fontSize: "22px", fontWeight: 500, color: "#185FA5", margin: 0 }}>{pedidos.filter(p => p.estado === "en camino").length}</p>
        </div>
      </div>

      <h3 style={{ margin: "0 0 12px" }}>Mis pedidos asignados</h3>

      {pedidos.length === 0 && (
        <div style={{ textAlign: "center", padding: "40px", color: "#888" }}>
          <p style={{ fontSize: "32px" }}>😴</p>
          <p>No tienes pedidos asignados aun</p>
        </div>
      )}

      {pedidos.map((p) => (
        <div key={p.id} style={{ border: "0.5px solid #ddd", borderRadius: "12px", padding: "14px", marginBottom: "12px" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "start", marginBottom: "10px" }}>
            <p style={{ fontWeight: 500, margin: 0 }}>Pedido #{p.id}</p>
            <span style={{ ...colorEstado(p.estado), fontSize: "11px", padding: "4px 10px", borderRadius: "8px", fontWeight: 500 }}>{p.estado}</span>
          </div>

          {restaurantes[p.restaurante_id] && (
            <div style={{ background: "#FAECE7", borderRadius: "8px", padding: "10px", marginBottom: "10px" }}>
              <p style={{ fontSize: "12px", fontWeight: 500, color: "#D85A30", margin: "0 0 4px" }}>Recoger en:</p>
              <p style={{ fontSize: "13px", fontWeight: 500, margin: 0 }}>{restaurantes[p.restaurante_id].nombre}</p>
            </div>
          )}

          <div style={{ marginBottom: "10px" }}>
            <p style={{ fontSize: "12px", color: "#888", margin: "4px 0" }}>👤 {p.cliente_nombre}</p>
            <p style={{ fontSize: "12px", color: "#888", margin: "4px 0" }}>📍 Entregar en: {p.cliente_direccion}</p>
            <p style={{ fontSize: "12px", color: "#888", margin: "4px 0" }}>📞 {p.cliente_telefono}</p>
            <p style={{ fontSize: "13px", fontWeight: 500, color: "#D85A30", margin: "4px 0" }}>🍽️ {p.plato}</p>
            <p style={{ fontSize: "12px", color: "#888", margin: "4px 0" }}>💰 ${p.total.toLocaleString()} - {p.metodo_pago}</p>
          </div>

          <div style={{ display: "flex", gap: "8px" }}>
            {p.estado === "asignado" && (
              <button onClick={() => cambiarEstado(p.id, "en camino")} style={{ flex: 1, background: "#D85A30", color: "#fff", border: "none", borderRadius: "8px", padding: "10px 16px", cursor: "pointer", fontSize: "13px", fontWeight: 500 }}>
                Ya recogi — En camino
              </button>
            )}
            {p.estado === "en camino" && (
              <button onClick={() => cambiarEstado(p.id, "entregado")} style={{ flex: 1, background: "#3B6D11", color: "#fff", border: "none", borderRadius: "8px", padding: "10px 16px", cursor: "pointer", fontSize: "13px", fontWeight: 500 }}>
                Pedido entregado
              </button>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

export default Domiciliario;