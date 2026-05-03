import { useState, useEffect } from "react";

function App() {
  const [restaurantes, setRestaurantes] = useState([]);

  useEffect(() => {
    fetch("http://127.0.0.1:8000/restaurantes")
      .then((res) => res.json())
      .then((data) => setRestaurantes(data));
  }, []);

  return (
    <div style={{ fontFamily: "sans-serif", maxWidth: "400px", margin: "0 auto", padding: "16px" }}>
      
      <div style={{ background: "#D85A30", borderRadius: "16px", padding: "20px", marginBottom: "20px" }}>
        <p style={{ color: "rgba(255,255,255,0.8)", fontSize: "12px", margin: 0 }}>Entregar en</p>
        <p style={{ color: "#fff", fontWeight: 500, margin: "4px 0 12px" }}>Orito, Putumayo</p>
        <p style={{ color: "#fff", fontSize: "20px", fontWeight: 500, margin: "0 0 12px" }}>Que quieres hoy?</p>
        <input
          placeholder="Buscar restaurante o plato..."
          style={{ width: "100%", padding: "8px 12px", borderRadius: "10px", border: "none", fontSize: "13px", boxSizing: "border-box" }}
        />
      </div>

      <h3 style={{ margin: "0 0 12px" }}>Restaurantes</h3>

      {restaurantes.map((r) => (
        <div key={r.id} style={{ border: "0.5px solid #ddd", borderRadius: "12px", padding: "14px", marginBottom: "12px" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "start" }}>
            <div>
              <p style={{ fontWeight: 500, margin: 0 }}>{r.nombre}</p>
              <p style={{ fontSize: "12px", color: "#888", margin: "4px 0" }}>{r.categoria}</p>
            </div>
            <span style={{ background: "#EAF3DE", color: "#3B6D11", fontSize: "12px", padding: "2px 8px", borderRadius: "8px" }}>
              {r.calificacion}
            </span>
          </div>
          <div style={{ display: "flex", gap: "12px", marginTop: "8px" }}>
            <span style={{ fontSize: "12px", color: "#888" }}>{r.tiempo}</span>
            <span style={{ fontSize: "12px", color: "#888" }}>$ {r.domicilio.toLocaleString()}</span>
          </div>
        </div>
      ))}

    </div>
  );
}

export default App;