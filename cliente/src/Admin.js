import { useState, useEffect, useRef } from "react";

function Admin({ API }) {
  const [pedidos, setPedidos] = useState([]);
  const [restaurantes, setRestaurantes] = useState([]);
  const [domiciliarios, setDomiciliarios] = useState([]);
  const [platos, setPlatos] = useState([]);
  const [usuarios, setUsuarios] = useState([]);
  const [vista, setVista] = useState("pedidos");
  const [restauranteSeleccionado, setRestauranteSeleccionado] = useState(null);
  const [nuevoRestaurante, setNuevoRestaurante] = useState({ nombre: "", categoria: "", calificacion: "", tiempo: "", domicilio: "" });
  const [nuevoPlato, setNuevoPlato] = useState({ nombre: "", descripcion: "", precio: "" });
  const [nuevoUsuario, setNuevoUsuario] = useState({ nombre: "", telefono: "", password: "", rol: "domiciliario", restaurante_id: "" });
  const [mensaje, setMensaje] = useState("");
  const [objetivoFoto, setObjetivoFoto] = useState(null); // { tipo: "restaurante" | "plato", id }
  const [subiendoFoto, setSubiendoFoto] = useState(false);
  const fileInputRef = useRef(null);

  const cargarPedidos = () => {
    fetch(`${API}/pedidos`)
      .then((res) => res.json())
      .then((data) => setPedidos(data));
  };

  const cargarRestaurantes = () => {
    fetch(`${API}/restaurantes`)
      .then((res) => res.json())
      .then((data) => setRestaurantes(data));
  };

  const cargarDomiciliarios = () => {
    fetch(`${API}/domiciliarios`)
      .then((res) => res.json())
      .then((data) => setDomiciliarios(data));
  };

  const cargarUsuarios = () => {
    fetch(`${API}/usuarios`)
      .then((res) => res.json())
      .then((data) => setUsuarios(data));
  };

  const cargarPlatos = (restauranteId) => {
    fetch(`${API}/restaurantes/${restauranteId}/platos`)
      .then((res) => res.json())
      .then((data) => setPlatos(data));
  };

  useEffect(() => {
    cargarPedidos();
    cargarRestaurantes();
    cargarDomiciliarios();
    cargarUsuarios();
    const intervalo = setInterval(cargarPedidos, 10000);
    return () => clearInterval(intervalo);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const cambiarEstado = (id, estado) => {
    fetch(`${API}/pedidos/${id}/estado?estado=${estado}`, { method: "PUT" })
      .then(() => cargarPedidos());
  };

  const asignarDomiciliario = (pedidoId, domiciliarioId) => {
    fetch(`${API}/pedidos/${pedidoId}/asignar?domiciliario_id=${domiciliarioId}`, { method: "PUT" })
      .then(() => cargarPedidos());
  };

  const agregarRestaurante = () => {
    if (!nuevoRestaurante.nombre || !nuevoRestaurante.categoria) {
      setMensaje("Por favor completa nombre y categoria");
      return;
    }
    fetch(`${API}/restaurantes?nombre=${encodeURIComponent(nuevoRestaurante.nombre)}&categoria=${encodeURIComponent(nuevoRestaurante.categoria)}&calificacion=${nuevoRestaurante.calificacion || 5.0}&tiempo=${encodeURIComponent(nuevoRestaurante.tiempo || "30-40 min")}&domicilio=${nuevoRestaurante.domicilio || 3000}`, { method: "POST" })
      .then((res) => res.json())
      .then(() => {
        setMensaje("Restaurante agregado exitosamente");
        setNuevoRestaurante({ nombre: "", categoria: "", calificacion: "", tiempo: "", domicilio: "" });
        cargarRestaurantes();
      });
  };

  const agregarPlato = () => {
    if (!nuevoPlato.nombre || !nuevoPlato.precio) {
      setMensaje("Por favor completa nombre y precio");
      return;
    }
    fetch(`${API}/platos?restaurante_id=${restauranteSeleccionado.id}&nombre=${encodeURIComponent(nuevoPlato.nombre)}&descripcion=${encodeURIComponent(nuevoPlato.descripcion || "")}&precio=${nuevoPlato.precio}`, { method: "POST" })
      .then((res) => res.json())
      .then(() => {
        setMensaje("Plato agregado exitosamente");
        setNuevoPlato({ nombre: "", descripcion: "", precio: "" });
        cargarPlatos(restauranteSeleccionado.id);
      });
  };

  const crearUsuario = () => {
    if (!nuevoUsuario.nombre || !nuevoUsuario.telefono || !nuevoUsuario.password) {
      setMensaje("Por favor completa todos los campos");
      return;
    }
    fetch(`${API}/registro?nombre=${encodeURIComponent(nuevoUsuario.nombre)}&telefono=${nuevoUsuario.telefono}&password=${nuevoUsuario.password}`, { method: "POST" })
      .then((res) => res.json())
      .then((data) => {
        if (data.detail) { setMensaje(data.detail); return; }
        const url = nuevoUsuario.rol === "restaurante"
          ? `${API}/usuarios/${nuevoUsuario.telefono}/rol?rol=${nuevoUsuario.rol}&restaurante_id=${nuevoUsuario.restaurante_id}`
          : `${API}/usuarios/${nuevoUsuario.telefono}/rol?rol=${nuevoUsuario.rol}`;
        fetch(url, { method: "PUT" })
          .then(() => {
            setMensaje(`Usuario ${nuevoUsuario.rol} creado exitosamente`);
            setNuevoUsuario({ nombre: "", telefono: "", password: "", rol: "domiciliario", restaurante_id: "" });
            cargarUsuarios();
            cargarDomiciliarios();
          });
      });
  };

  // --- NUEVO: manejo del boton Foto, sirve para restaurantes y para platos ---
  const abrirSelectorFoto = (tipo, id) => {
    setObjetivoFoto({ tipo, id });
    // pequeno delay para asegurar que el estado quede seteado antes del click
    setTimeout(() => {
      fileInputRef.current.click();
    }, 0);
  };

  const manejarArchivoSeleccionado = (e) => {
    const file = e.target.files[0];
    if (!file || !objetivoFoto) return;

    const formData = new FormData();
    formData.append("file", file);

    setSubiendoFoto(true);
    setMensaje("Subiendo foto...");

    const endpoint = objetivoFoto.tipo === "plato"
      ? `${API}/platos/imagen/${objetivoFoto.id}`
      : `${API}/restaurantes/imagen/${objetivoFoto.id}`;

    fetch(endpoint, {
      method: "POST",
      body: formData,
    })
      .then((res) => {
        if (!res.ok) throw new Error("Error al subir");
        return res.json();
      })
      .then(() => {
        setMensaje("Foto actualizada correctamente");
        if (objetivoFoto.tipo === "plato" && restauranteSeleccionado) {
          cargarPlatos(restauranteSeleccionado.id);
        } else {
          cargarRestaurantes();
        }
      })
      .catch(() => {
        setMensaje("Error al subir la foto. Intenta de nuevo.");
      })
      .finally(() => {
        setSubiendoFoto(false);
        setObjetivoFoto(null);
        e.target.value = "";
      });
  };

  const colorEstado = (estado) => {
    if (estado === "pendiente") return { background: "#FAEEDA", color: "#854F0B" };
    if (estado === "preparando") return { background: "#E6F1FB", color: "#185FA5" };
    if (estado === "listo") return { background: "#EAF3DE", color: "#3B6D11" };
    if (estado === "asignado") return { background: "#F1EFE8", color: "#5F5E5A" };
    if (estado === "en camino") return { background: "#E6F1FB", color: "#185FA5" };
    if (estado === "entregado") return { background: "#EAF3DE", color: "#3B6D11" };
    return {};
  };

  return (
    <div style={{ fontFamily: "sans-serif", maxWidth: "600px", margin: "0 auto", padding: "16px" }}>

      {/* input de archivo oculto, compartido para el boton Foto de cada restaurante */}
      <input
        type="file"
        accept="image/*"
        ref={fileInputRef}
        onChange={manejarArchivoSeleccionado}
        style={{ display: "none" }}
      />

      <div style={{ background: "#D85A30", borderRadius: "16px", padding: "20px", marginBottom: "20px" }}>
        <p style={{ color: "rgba(255,255,255,0.8)", fontSize: "12px", margin: 0 }}>Panel de control</p>
        <p style={{ color: "#fff", fontSize: "20px", fontWeight: 500, margin: "4px 0 0" }}>Domicilios Orito - Admin</p>
      </div>

      <div style={{ display: "flex", marginBottom: "20px", background: "#f5f5f5", borderRadius: "8px", padding: "4px", gap: "4px" }}>
        <button onClick={() => { setVista("pedidos"); setRestauranteSeleccionado(null); }} style={{ flex: 1, padding: "8px", border: "none", borderRadius: "6px", background: vista === "pedidos" ? "#fff" : "transparent", cursor: "pointer", fontWeight: vista === "pedidos" ? 500 : 400, fontSize: "12px" }}>Pedidos</button>
        <button onClick={() => { setVista("restaurantes"); setRestauranteSeleccionado(null); }} style={{ flex: 1, padding: "8px", border: "none", borderRadius: "6px", background: vista === "restaurantes" ? "#fff" : "transparent", cursor: "pointer", fontWeight: vista === "restaurantes" ? 500 : 400, fontSize: "12px" }}>Restaurantes</button>
        <button onClick={() => { setVista("usuarios"); setRestauranteSeleccionado(null); }} style={{ flex: 1, padding: "8px", border: "none", borderRadius: "6px", background: vista === "usuarios" ? "#fff" : "transparent", cursor: "pointer", fontWeight: vista === "usuarios" ? 500 : 400, fontSize: "12px" }}>Usuarios</button>
      </div>

      {vista === "pedidos" && (
        <>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: "12px", marginBottom: "20px" }}>
            <div style={{ background: "#FAEEDA", borderRadius: "12px", padding: "16px" }}>
              <p style={{ fontSize: "12px", color: "#854F0B", margin: "0 0 4px" }}>Pendientes</p>
              <p style={{ fontSize: "24px", fontWeight: 500, color: "#854F0B", margin: 0 }}>{pedidos.filter(p => p.estado === "pendiente").length}</p>
            </div>
            <div style={{ background: "#E6F1FB", borderRadius: "12px", padding: "16px" }}>
              <p style={{ fontSize: "12px", color: "#185FA5", margin: "0 0 4px" }}>En proceso</p>
              <p style={{ fontSize: "24px", fontWeight: 500, color: "#185FA5", margin: 0 }}>{pedidos.filter(p => ["preparando", "listo", "asignado", "en camino"].includes(p.estado)).length}</p>
            </div>
            <div style={{ background: "#EAF3DE", borderRadius: "12px", padding: "16px" }}>
              <p style={{ fontSize: "12px", color: "#3B6D11", margin: "0 0 4px" }}>Entregados</p>
              <p style={{ fontSize: "24px", fontWeight: 500, color: "#3B6D11", margin: 0 }}>{pedidos.filter(p => p.estado === "entregado").length}</p>
            </div>
            <div style={{ background: "#F1EFE8", borderRadius: "12px", padding: "16px" }}>
              <p style={{ fontSize: "12px", color: "#5F5E5A", margin: "0 0 4px" }}>Total</p>
              <p style={{ fontSize: "24px", fontWeight: 500, color: "#5F5E5A", margin: 0 }}>{pedidos.length}</p>
            </div>
          </div>

          {pedidos.length === 0 && <p style={{ color: "#888", textAlign: "center", padding: "20px" }}>No hay pedidos aun</p>}

          {pedidos.map((p) => (
            <div key={p.id} style={{ border: "0.5px solid #ddd", borderRadius: "12px", padding: "14px", marginBottom: "12px" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "start", marginBottom: "10px" }}>
                <div>
                  <p style={{ fontWeight: 500, margin: 0 }}>Pedido #{p.id} — {p.cliente_nombre}</p>
                  <p style={{ fontSize: "12px", color: "#888", margin: "4px 0" }}>📍 {p.cliente_direccion}</p>
                  <p style={{ fontSize: "12px", color: "#888", margin: "4px 0" }}>📞 {p.cliente_telefono}</p>
                  <p style={{ fontSize: "12px", color: "#888", margin: "4px 0" }}>🍽️ {p.plato}</p>
                  <p style={{ fontSize: "12px", color: "#888", margin: "4px 0" }}>💰 ${p.total.toLocaleString()} - {p.metodo_pago}</p>
                </div>
                <span style={{ ...colorEstado(p.estado), fontSize: "11px", padding: "4px 10px", borderRadius: "8px", fontWeight: 500 }}>{p.estado}</span>
              </div>

              {p.estado === "listo" && domiciliarios.length > 0 && (
                <div style={{ marginBottom: "10px" }}>
                  <p style={{ fontSize: "12px", fontWeight: 500, margin: "0 0 6px" }}>Asignar domiciliario:</p>
                  <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
                    {domiciliarios.map((d) => (
                      <button key={d.id} onClick={() => asignarDomiciliario(p.id, d.id)} style={{ background: "#185FA5", color: "#fff", border: "none", borderRadius: "8px", padding: "6px 12px", cursor: "pointer", fontSize: "12px" }}>
                        🛵 {d.nombre}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              <div style={{ display: "flex", gap: "8px" }}>
                {p.estado === "pendiente" && <button onClick={() => cambiarEstado(p.id, "preparando")} style={{ background: "#185FA5", color: "#fff", border: "none", borderRadius: "8px", padding: "8px 14px", cursor: "pointer", fontSize: "12px" }}>Confirmar</button>}
                {p.estado === "asignado" && <button onClick={() => cambiarEstado(p.id, "en camino")} style={{ background: "#D85A30", color: "#fff", border: "none", borderRadius: "8px", padding: "8px 14px", cursor: "pointer", fontSize: "12px" }}>En camino</button>}
                {p.estado === "en camino" && <button onClick={() => cambiarEstado(p.id, "entregado")} style={{ background: "#3B6D11", color: "#fff", border: "none", borderRadius: "8px", padding: "8px 14px", cursor: "pointer", fontSize: "12px" }}>Entregado</button>}
                {p.estado === "entregado" && <span style={{ fontSize: "12px", color: "#3B6D11" }}>Completado ✓</span>}
              </div>
            </div>
          ))}
        </>
      )}

      {vista === "restaurantes" && !restauranteSeleccionado && (
        <>
          <div style={{ border: "0.5px solid #ddd", borderRadius: "12px", padding: "16px", marginBottom: "20px" }}>
            <h3 style={{ margin: "0 0 16px" }}>Agregar restaurante</h3>
            <input placeholder="Nombre del restaurante" value={nuevoRestaurante.nombre} onChange={(e) => setNuevoRestaurante({ ...nuevoRestaurante, nombre: e.target.value })} style={{ width: "100%", padding: "10px", borderRadius: "8px", border: "0.5px solid #ddd", marginBottom: "10px", boxSizing: "border-box", fontSize: "13px" }} />
            <input placeholder="Categoria (Comidas, Pizzas, Pollos...)" value={nuevoRestaurante.categoria} onChange={(e) => setNuevoRestaurante({ ...nuevoRestaurante, categoria: e.target.value })} style={{ width: "100%", padding: "10px", borderRadius: "8px", border: "0.5px solid #ddd", marginBottom: "10px", boxSizing: "border-box", fontSize: "13px" }} />
            <input placeholder="Calificacion (ej: 4.8)" value={nuevoRestaurante.calificacion} onChange={(e) => setNuevoRestaurante({ ...nuevoRestaurante, calificacion: e.target.value })} style={{ width: "100%", padding: "10px", borderRadius: "8px", border: "0.5px solid #ddd", marginBottom: "10px", boxSizing: "border-box", fontSize: "13px" }} />
            <input placeholder="Tiempo de entrega (ej: 25-35 min)" value={nuevoRestaurante.tiempo} onChange={(e) => setNuevoRestaurante({ ...nuevoRestaurante, tiempo: e.target.value })} style={{ width: "100%", padding: "10px", borderRadius: "8px", border: "0.5px solid #ddd", marginBottom: "10px", boxSizing: "border-box", fontSize: "13px" }} />
            <input placeholder="Costo domicilio en pesos (ej: 3000)" value={nuevoRestaurante.domicilio} onChange={(e) => setNuevoRestaurante({ ...nuevoRestaurante, domicilio: e.target.value })} style={{ width: "100%", padding: "10px", borderRadius: "8px", border: "0.5px solid #ddd", marginBottom: "16px", boxSizing: "border-box", fontSize: "13px" }} />
            {mensaje && <p style={{ color: "#3B6D11", fontSize: "12px", margin: "0 0 12px" }}>{mensaje}</p>}
            <button onClick={agregarRestaurante} style={{ width: "100%", padding: "12px", background: "#D85A30", color: "#fff", border: "none", borderRadius: "8px", cursor: "pointer", fontWeight: 500 }}>Agregar restaurante</button>
          </div>

          <h3 style={{ margin: "0 0 12px" }}>Restaurantes activos ({restaurantes.length})</h3>
          {restaurantes.map((r) => (
            <div key={r.id} style={{ border: "0.5px solid #ddd", borderRadius: "12px", padding: "14px", marginBottom: "12px" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "10px" }}>
                <div style={{ display: "flex", alignItems: "center", gap: "10px", flex: 1, minWidth: 0 }}>
                  {r.imagen_url && (
                    <img src={r.imagen_url} alt={r.nombre} style={{ width: "44px", height: "44px", borderRadius: "8px", objectFit: "cover", flexShrink: 0 }} />
                  )}
                  <div style={{ minWidth: 0 }}>
                    <p style={{ fontWeight: 500, margin: 0 }}>{r.nombre}</p>
                    <p style={{ fontSize: "12px", color: "#888", margin: "4px 0" }}>{r.categoria}</p>
                    <p style={{ fontSize: "12px", color: "#888", margin: "4px 0" }}>⭐ {r.calificacion} | {r.tiempo} | ${r.domicilio.toLocaleString()}</p>
                  </div>
                </div>
                <div style={{ display: "flex", gap: "8px", flexShrink: 0 }}>
                  <button onClick={() => { setRestauranteSeleccionado(r); cargarPlatos(r.id); }} style={{ background: "#185FA5", color: "#fff", border: "none", borderRadius: "8px", padding: "8px 14px", cursor: "pointer", fontSize: "12px" }}>Ver menu</button>
                  <button
                    onClick={() => abrirSelectorFoto("restaurante", r.id)}
                    disabled={subiendoFoto && objetivoFoto && objetivoFoto.tipo === "restaurante" && objetivoFoto.id === r.id}
                    style={{ background: "#3B6D11", color: "#fff", border: "none", borderRadius: "8px", padding: "8px 14px", cursor: "pointer", fontSize: "12px" }}
                  >
                    {subiendoFoto && objetivoFoto && objetivoFoto.tipo === "restaurante" && objetivoFoto.id === r.id ? "Subiendo..." : "📷 Foto"}
                  </button>
                </div>
              </div>
            </div>
          ))}
        </>
      )}

      {vista === "restaurantes" && restauranteSeleccionado && (
        <>
          <div style={{ display: "flex", alignItems: "center", gap: "12px", marginBottom: "16px" }}>
            <button onClick={() => { setRestauranteSeleccionado(null); setMensaje(""); }} style={{ background: "none", border: "0.5px solid #ddd", borderRadius: "8px", padding: "8px 12px", cursor: "pointer", fontSize: "13px" }}>Volver</button>
            <h3 style={{ margin: 0 }}>{restauranteSeleccionado.nombre}</h3>
          </div>

          <div style={{ border: "0.5px solid #ddd", borderRadius: "12px", padding: "16px", marginBottom: "20px" }}>
            <h4 style={{ margin: "0 0 12px" }}>Agregar plato</h4>
            <input placeholder="Nombre del plato" value={nuevoPlato.nombre} onChange={(e) => setNuevoPlato({ ...nuevoPlato, nombre: e.target.value })} style={{ width: "100%", padding: "10px", borderRadius: "8px", border: "0.5px solid #ddd", marginBottom: "10px", boxSizing: "border-box", fontSize: "13px" }} />
            <input placeholder="Descripcion (opcional)" value={nuevoPlato.descripcion} onChange={(e) => setNuevoPlato({ ...nuevoPlato, descripcion: e.target.value })} style={{ width: "100%", padding: "10px", borderRadius: "8px", border: "0.5px solid #ddd", marginBottom: "10px", boxSizing: "border-box", fontSize: "13px" }} />
            <input placeholder="Precio en pesos (ej: 15000)" value={nuevoPlato.precio} onChange={(e) => setNuevoPlato({ ...nuevoPlato, precio: e.target.value })} style={{ width: "100%", padding: "10px", borderRadius: "8px", border: "0.5px solid #ddd", marginBottom: "16px", boxSizing: "border-box", fontSize: "13px" }} />
            {mensaje && <p style={{ color: "#3B6D11", fontSize: "12px", margin: "0 0 12px" }}>{mensaje}</p>}
            <button onClick={agregarPlato} style={{ width: "100%", padding: "12px", background: "#D85A30", color: "#fff", border: "none", borderRadius: "8px", cursor: "pointer", fontWeight: 500 }}>Agregar plato</button>
          </div>

          <h4 style={{ margin: "0 0 12px" }}>Menu actual ({platos.length} platos)</h4>
          {platos.length === 0 && <p style={{ color: "#888", textAlign: "center", padding: "20px" }}>No hay platos aun</p>}
          {platos.map((p) => (
            <div key={p.id} style={{ border: "0.5px solid #ddd", borderRadius: "12px", padding: "14px", marginBottom: "12px" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "10px" }}>
                <div style={{ display: "flex", alignItems: "center", gap: "10px", flex: 1, minWidth: 0 }}>
                  {p.imagen_url && (
                    <img src={p.imagen_url} alt={p.nombre} style={{ width: "44px", height: "44px", borderRadius: "8px", objectFit: "cover", flexShrink: 0 }} />
                  )}
                  <div style={{ minWidth: 0 }}>
                    <p style={{ fontWeight: 500, margin: 0 }}>{p.nombre}</p>
                    {p.descripcion && <p style={{ fontSize: "12px", color: "#888", margin: "4px 0" }}>{p.descripcion}</p>}
                    <p style={{ fontSize: "13px", color: "#D85A30", fontWeight: 500, margin: "4px 0" }}>${p.precio.toLocaleString()}</p>
                  </div>
                </div>
                <button
                  onClick={() => abrirSelectorFoto("plato", p.id)}
                  disabled={subiendoFoto && objetivoFoto && objetivoFoto.tipo === "plato" && objetivoFoto.id === p.id}
                  style={{ background: "#3B6D11", color: "#fff", border: "none", borderRadius: "8px", padding: "8px 12px", cursor: "pointer", fontSize: "12px", flexShrink: 0 }}
                >
                  {subiendoFoto && objetivoFoto && objetivoFoto.tipo === "plato" && objetivoFoto.id === p.id ? "..." : "📷 Foto"}
                </button>
              </div>
            </div>
          ))}
        </>
      )}

      {vista === "usuarios" && (
        <>
          <div style={{ border: "0.5px solid #ddd", borderRadius: "12px", padding: "16px", marginBottom: "20px" }}>
            <h3 style={{ margin: "0 0 16px" }}>Crear usuario</h3>
            <input placeholder="Nombre" value={nuevoUsuario.nombre} onChange={(e) => setNuevoUsuario({ ...nuevoUsuario, nombre: e.target.value })} style={{ width: "100%", padding: "10px", borderRadius: "8px", border: "0.5px solid #ddd", marginBottom: "10px", boxSizing: "border-box", fontSize: "13px" }} />
            <input placeholder="Telefono" value={nuevoUsuario.telefono} onChange={(e) => setNuevoUsuario({ ...nuevoUsuario, telefono: e.target.value })} style={{ width: "100%", padding: "10px", borderRadius: "8px", border: "0.5px solid #ddd", marginBottom: "10px", boxSizing: "border-box", fontSize: "13px" }} />
            <input placeholder="Contrasena" value={nuevoUsuario.password} onChange={(e) => setNuevoUsuario({ ...nuevoUsuario, password: e.target.value })} style={{ width: "100%", padding: "10px", borderRadius: "8px", border: "0.5px solid #ddd", marginBottom: "10px", boxSizing: "border-box", fontSize: "13px" }} />
            <select value={nuevoUsuario.rol} onChange={(e) => setNuevoUsuario({ ...nuevoUsuario, rol: e.target.value })} style={{ width: "100%", padding: "10px", borderRadius: "8px", border: "0.5px solid #ddd", marginBottom: "10px", boxSizing: "border-box", fontSize: "13px" }}>
              <option value="domiciliario">Domiciliario</option>
              <option value="restaurante">Restaurante</option>
              <option value="admin">Admin</option>
            </select>
            {nuevoUsuario.rol === "restaurante" && (
              <select value={nuevoUsuario.restaurante_id} onChange={(e) => setNuevoUsuario({ ...nuevoUsuario, restaurante_id: e.target.value })} style={{ width: "100%", padding: "10px", borderRadius: "8px", border: "0.5px solid #ddd", marginBottom: "10px", boxSizing: "border-box", fontSize: "13px" }}>
                <option value="">Selecciona el restaurante</option>
                {restaurantes.map((r) => (
                  <option key={r.id} value={r.id}>{r.nombre}</option>
                ))}
              </select>
            )}
            {mensaje && <p style={{ color: "#3B6D11", fontSize: "12px", margin: "0 0 12px" }}>{mensaje}</p>}
            <button onClick={crearUsuario} style={{ width: "100%", padding: "12px", background: "#D85A30", color: "#fff", border: "none", borderRadius: "8px", cursor: "pointer", fontWeight: 500 }}>Crear usuario</button>
          </div>

          <h3 style={{ margin: "0 0 12px" }}>Usuarios ({usuarios.length})</h3>
          {usuarios.map((u) => (
            <div key={u.id} style={{ border: "0.5px solid #ddd", borderRadius: "12px", padding: "14px", marginBottom: "10px" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <div>
                  <p style={{ fontWeight: 500, margin: 0 }}>{u.nombre}</p>
                  <p style={{ fontSize: "12px", color: "#888", margin: "4px 0" }}>📞 {u.telefono}</p>
                </div>
                <span style={{ background: u.rol === "admin" ? "#FAEEDA" : u.rol === "domiciliario" ? "#E6F1FB" : u.rol === "restaurante" ? "#EAF3DE" : "#f5f5f5", color: u.rol === "admin" ? "#854F0B" : u.rol === "domiciliario" ? "#185FA5" : u.rol === "restaurante" ? "#3B6D11" : "#888", fontSize: "11px", padding: "4px 10px", borderRadius: "8px", fontWeight: 500 }}>{u.rol}</span>
              </div>
            </div>
          ))}
        </>
      )}

    </div>
  );
}

export default Admin;
