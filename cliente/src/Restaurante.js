import { useState, useEffect } from "react";

function Restaurante({ API, usuario, onSalir }) {
  const [pedidos, setPedidos] = useState([]);
  const [domiciliarioInfo, setDomiciliarioInfo] = useState({});

  const cargarPedidos = () => {
    fetch(`${API}/pedidos/restaurante/${usuario.restaurante_id}`)
      .then((res) => res.json())
      .then((data) => {
        setPedidos(data.filter(p => p.estado !== "entregado"));
      });
  };

  const cargarDomiciliario = (domiciliarioId) => {
    if (!domiciliarioId || domiciliarioInfo[domiciliarioId]) return;
    fetch(`${API}/usuarios`)
      .then((res) => res.json())
      .then((data) => {
        const domi = data.find(u => u.id === domiciliarioId);
        if (domi) {
          setDomiciliarioInfo(prev => ({ ...prev, [domiciliarioId]: domi }));
        }
      });
  };

  useEffect(() => {
    cargarPedidos();
    const intervalo = setInterval(cargarPedidos, 8000);
    return () => clearInterval(intervalo);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    pedidos.forEach(p => {
      if (p.domiciliario_id) cargarDomiciliario(p.domiciliario_id);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pedidos]);

  const cambiarEstado = (id, estado) => {
    fetch(`${API}/pedidos/${id}/estado?estado=${estado}`, { method: "PUT" })
      .then(() => cargarPedidos());
  };

  const colorEstado = (estado) => {
    if (estado === "pendiente") return { background: "#FAEEDA", color: "#854F0B" };
    if (estado === "aceptado") return { background: "#E6F1FB", color: "#185FA5" };
    if (estado === "preparando") return { background: "#E6F1FB", color: "#185FA5" };
    if (estado === "listo") return { background: "#EAF3DE", color: "#3B6D11" };
    if (estado === "asignado") return { background: "#F1EFE8", color: "#5F5E5A" };
    if (estado === "en camino") return { background: "#E6F1FB", color: "#185FA5" };
    return {};
  };

  const labelEstado = (estado) => {
    if (estado === "pendiente") return "Nuevo pedido";
    if (estado === "aceptado") return "Aceptado";
    if (estado === "preparando") return "Preparando";
    if (estado === "listo") return "Listo";
    if (estado === "asignado") return "Domiciliario asignado";
    if (estado === "en camino") return "En camino";
    return estado;
  };

  return (
    <div style={{ fontFamily: "sans-serif", maxWidth: "500px", margin: "0 auto", padding: "16px" }}>

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "8px" }}>
        <span style={{ fontSize: "13px", color: "#888" }}>Hola, {usuario.nombre}</span>
        <span onClick={onSalir} style={{ fontSize: "12px", color: "#888", cursor: "pointer" }}>Salir</span>
      </div>

      <div style={{ background: "#185FA5", borderRadius: "16px", padding: "20px", marginBottom: "20px" }}>
        <p style={{ color: "rgba(255,255,255,0.8)", fontSize: "12px", margin: 0 }}>Panel de</p>
        <p style={{ color: "#fff", fontSize: "20px", fontWeight: 500, margin: "4px 0 0" }}>Mi Restaurante</p>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: "10px", marginBottom: "20px" }}>
        <div style={{ background: "#FAEEDA", borderRadius: "12px", padding: "12px", textAlign: "center" }}>
          <p style={{ fontSize: "11px", color: "#854F0B", margin: "0 0 4px" }}>Nuevos</p>
          <p style={{ fontSize: "22px", fontWeight: 500, color: "#854F0B", margin: 0 }}>{pedidos.filter(p => p.estado === "pendiente" || p.estado === "aceptado").length}</p>
        </div>
        <div style={{ background: "#E6F1FB", borderRadius: "12px", padding: "12px", textAlign: "center" }}>
          <p style={{ fontSize: "11px", color: "#185FA5", margin: "0 0 4px" }}>Preparando</p>
          <p style={{ fontSize: "22px", fontWeight: 500, color: "#185FA5", margin: 0 }}>{pedidos.filter(p => p.estado === "preparando").length}</p>
        </div>
        <div style={{ background: "#EAF3DE", borderRadius: "12px", padding: "12px", textAlign: "center" }}>
          <p style={{ fontSize: "11px", color: "#3B6D11", margin: "0 0 4px" }}>Listos</p>
          <p style={{ fontSize: "22px", fontWeight: 500, color: "#3B6D11", margin: 0 }}>{pedidos.filter(p => p.estado === "listo" || p.estado === "asignado").length}</p>
        </div>
      </div>

      <h3 style={{ margin: "0 0 12px" }}>Pedidos activos</h3>

      {pedidos.length === 0 && (
        <div style={{ textAlign: "center", padding: "40px", color: "#888" }}>
          <p style={{ fontSize: "32px" }}>😴</p>
          <p>No hay pedidos por ahora</p>
        </div>
      )}

      {pedidos.map((p) => (
        <div key={p.id} style={{ border: p.estado === "pendiente" ? "1.5px solid #D85A30" : "0.5px solid #ddd", borderRadius: "12px", padding: "14px", marginBottom: "12px" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "start", marginBottom: "10px" }}>
            <div>
              <p style={{ fontWeight: 500, margin: 0 }}>Pedido #{p.id}</p>
              <p style={{ fontSize: "12px", color: "#888", margin: "4px 0" }}>👤 {p.cliente_nombre}</p>
              <p style={{ fontSize: "12px", color: "#888", margin: "4px 0" }}>📍 {p.cliente_direccion}</p>
              <p style={{ fontSize: "13px", fontWeight: 500, color: "#D85A30", margin: "4px 0" }}>🍽️ {p.plato}</p>
              <p style={{ fontSize: "12px", color: "#888", margin: "4px 0" }}>💰 ${p.total.toLocaleString()} - {p.metodo_pago}</p>
              {p.domiciliario_id && domiciliarioInfo[p.domiciliario_id] && (
                <div style={{ background: "#EAF3DE", borderRadius: "8px", padding: "8px", marginTop: "8px" }}>
                  <p style={{ fontSize: "12px", color: "#3B6D11", fontWeight: 500, margin: 0 }}>🛵 Domiciliario: {domiciliarioInfo[p.domiciliario_id].nombre}</p>
                  <p style={{ fontSize: "12px", color: "#3B6D11", margin: "2px 0 0" }}>📞 {domiciliarioInfo[p.domiciliario_id].telefono}</p>
                </div>
              )}
            </div>
            <span style={{ ...colorEstado(p.estado), fontSize: "11px", padding: "4px 10px", borderRadius: "8px", fontWeight: 500 }}>{labelEstado(p.estado)}</span>
          </div>

          <div style={{ display: "flex", gap: "8px" }}>
            {p.estado === "pendiente" && (
              <button onClick={() => cambiarEstado(p.id, "aceptado")} style={{ background: "#185FA5", color: "#fff", border: "none", borderRadius: "8px", padding: "10px 16px", cursor: "pointer", fontSize: "13px", fontWeight: 500 }}>
                Aceptar pedido
              </button>
            )}
            {p.estado === "aceptado" && (
              <button onClick={() => cambiarEstado(p.id, "preparando")} style={{ background: "#D85A30", color: "#fff", border: "none", borderRadius: "8px", padding: "10px 16px", cursor: "pointer", fontSize: "13px", fontWeight: 500 }}>
                Empezar a preparar
              </button>
            )}
            {p.estado === "preparando" && (
              <button onClick={() => cambiarEstado(p.id, "listo")} style={{ background: "#3B6D11", color: "#fff", border: "none", borderRadius: "8px", padding: "10px 16px", cursor: "pointer", fontSize: "13px", fontWeight: 500 }}>
                Marcar como listo
              </button>
            )}
            {p.estado === "listo" && (
              <div style={{ background: "#EAF3DE", borderRadius: "8px", padding: "10px 16px" }}>
                <p style={{ fontSize: "13px", color: "#3B6D11", margin: 0 }}>Esperando domiciliario...</p>
              </div>
            )}
            {p.estado === "asignado" && (
              <div style={{ background: "#F1EFE8", borderRadius: "8px", padding: "10px 16px" }}>
                <p style={{ fontSize: "13px", color: "#5F5E5A", margin: 0 }}>Domiciliario viene en camino</p>
              </div>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

export default Restaurante;