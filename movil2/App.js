import { useState, useEffect } from 'react';
import { NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { View, Text, TextInput, TouchableOpacity, StyleSheet, SafeAreaView, ScrollView, ActivityIndicator, Image, Alert } from 'react-native';
import * as ImagePicker from 'expo-image-picker';

const API = "https://orito-app-production.up.railway.app";
const Stack = createNativeStackNavigator();

function LoginScreen({ navigation }) {
  const [modo, setModo] = useState("login");
  const [form, setForm] = useState({ nombre: "", telefono: "", password: "" });
  const [error, setError] = useState("");
  const [cargando, setCargando] = useState(false);

  const handleSubmit = () => {
    setCargando(true);
    setError("");
    const url = modo === "login"
      ? `${API}/login?telefono=${form.telefono}&password=${form.password}`
      : `${API}/registro?nombre=${form.nombre}&telefono=${form.telefono}&password=${form.password}`;
    fetch(url, { method: "POST" })
      .then((res) => res.json())
      .then((data) => {
        setCargando(false);
        if (data.detail) { setError(data.detail); return; }
        if (data.rol === "admin") navigation.replace("Admin", { usuario: data });
        else if (data.rol === "domiciliario") navigation.replace("Domiciliario", { usuario: data });
        else if (data.rol === "restaurante") navigation.replace("Restaurante", { usuario: data });
        else navigation.replace("Inicio", { usuario: data });
      })
      .catch(() => { setCargando(false); setError("Error de conexion"); });
  };

  return (
    <SafeAreaView style={styles.container}>
      <ScrollView contentContainerStyle={styles.scroll}>
        <View style={styles.header}>
          <Text style={styles.headerSub}>Bienvenido a</Text>
          <Text style={styles.headerTitle}>Domicilios Orito</Text>
        </View>
        <View style={styles.card}>
          <View style={styles.tabs}>
            <TouchableOpacity style={[styles.tab, modo === "login" && styles.tabActive]} onPress={() => setModo("login")}>
              <Text style={[styles.tabText, modo === "login" && styles.tabTextActive]}>Ingresar</Text>
            </TouchableOpacity>
            <TouchableOpacity style={[styles.tab, modo === "registro" && styles.tabActive]} onPress={() => setModo("registro")}>
              <Text style={[styles.tabText, modo === "registro" && styles.tabTextActive]}>Registrarse</Text>
            </TouchableOpacity>
          </View>
          {modo === "registro" && (
            <TextInput placeholder="Tu nombre" value={form.nombre} onChangeText={(t) => setForm({ ...form, nombre: t })} style={styles.input} />
          )}
          <TextInput placeholder="Telefono" value={form.telefono} onChangeText={(t) => setForm({ ...form, telefono: t })} style={styles.input} keyboardType="phone-pad" />
          <TextInput placeholder="Contrasena" value={form.password} onChangeText={(t) => setForm({ ...form, password: t })} style={styles.input} secureTextEntry />
          {error ? <Text style={styles.error}>{error}</Text> : null}
          <TouchableOpacity style={styles.button} onPress={handleSubmit} disabled={cargando}>
            {cargando ? <ActivityIndicator color="#fff" /> : <Text style={styles.buttonText}>{modo === "login" ? "Ingresar" : "Crear cuenta"}</Text>}
          </TouchableOpacity>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

function InicioScreen({ navigation, route }) {
  const { usuario } = route.params;
  const [restaurantes, setRestaurantes] = useState([]);
  const [busqueda, setBusqueda] = useState("");

  useEffect(() => {
    fetch(`${API}/restaurantes`)
      .then((res) => res.json())
      .then((data) => { if (Array.isArray(data)) setRestaurantes(data); });
  }, []);

  const restaurantesFiltrados = restaurantes.filter(r =>
    r.nombre.toLowerCase().includes(busqueda.toLowerCase()) ||
    r.categoria.toLowerCase().includes(busqueda.toLowerCase())
  );

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.headerSub}>Hola, {usuario.nombre}</Text>
        <Text style={styles.headerTitle}>Que quieres hoy?</Text>
        <TextInput placeholder="Buscar restaurante o categoria..." value={busqueda} onChangeText={setBusqueda} style={styles.searchInput} />
      </View>
      <ScrollView contentContainerStyle={{ padding: 16 }}>
        <Text style={{ fontSize: 16, fontWeight: "600", color: "#333", marginBottom: 12 }}>
          {busqueda ? `Resultados para "${busqueda}"` : "Restaurantes"}
        </Text>
        {restaurantesFiltrados.length === 0 && (
          <Text style={{ color: "#888", textAlign: "center", padding: 20 }}>No se encontraron restaurantes</Text>
        )}
        {restaurantesFiltrados.map((r) => (
          <TouchableOpacity key={r.id} style={styles.restauranteCard} onPress={() => navigation.navigate("Menu", { restaurante: r, usuario })}>
            {r.imagen_url ? (
              <Image source={{ uri: r.imagen_url }} style={{ width: 60, height: 60, borderRadius: 10, marginRight: 12 }} />
            ) : (
              <View style={{ width: 60, height: 60, borderRadius: 10, backgroundColor: "#FDEEDC", alignItems: "center", justifyContent: "center", marginRight: 12 }}>
                <Text style={{ fontSize: 24 }}>🍽️</Text>
              </View>
            )}
            <View style={{ flex: 1 }}>
              <Text style={styles.restauranteNombre}>{r.nombre}</Text>
              <Text style={styles.restauranteCategoria}>{r.categoria}</Text>
              <View style={{ flexDirection: "row", gap: 12, marginTop: 6 }}>
                <Text style={styles.restauranteInfo}>🕐 {r.tiempo}</Text>
                <Text style={styles.restauranteInfo}>🛵 ${r.domicilio.toLocaleString()}</Text>
              </View>
            </View>
            <View style={styles.calificacionBadge}>
              <Text style={styles.calificacionText}>⭐ {r.calificacion}</Text>
            </View>
          </TouchableOpacity>
        ))}
      </ScrollView>
      <TouchableOpacity style={{ position: "absolute", top: 50, right: 16 }} onPress={() => navigation.replace("Login")}>
        <Text style={{ color: "rgba(255,255,255,0.8)", fontSize: 12 }}>Salir</Text>
      </TouchableOpacity>
    </SafeAreaView>
  );
}

function MenuScreen({ navigation, route }) {
  const { restaurante, usuario } = route.params;
  const [platos, setPlatos] = useState([]);
  const [carrito, setCarrito] = useState([]);

  useEffect(() => {
    fetch(`${API}/restaurantes/${restaurante.id}/platos`)
      .then((res) => res.json())
      .then((data) => { if (Array.isArray(data)) setPlatos(data); });
  }, []);

  const agregarAlCarrito = (plato) => {
    const existe = carrito.find(c => c.id === plato.id);
    if (existe) {
      setCarrito(carrito.map(c => c.id === plato.id ? { ...c, cantidad: c.cantidad + 1 } : c));
    } else {
      setCarrito([...carrito, { ...plato, cantidad: 1 }]);
    }
  };

  const quitarDelCarrito = (plato) => {
    const existe = carrito.find(c => c.id === plato.id);
    if (existe && existe.cantidad > 1) {
      setCarrito(carrito.map(c => c.id === plato.id ? { ...c, cantidad: c.cantidad - 1 } : c));
    } else {
      setCarrito(carrito.filter(c => c.id !== plato.id));
    }
  };

  const totalCarrito = () => carrito.reduce((acc, c) => acc + c.precio * c.cantidad, 0);

  return (
    <SafeAreaView style={styles.container}>
      <View style={[styles.header, { flexDirection: "row", alignItems: "center", gap: 12 }]}>
        <TouchableOpacity onPress={() => navigation.goBack()}>
          <Text style={{ color: "#fff", fontSize: 20 }}>←</Text>
        </TouchableOpacity>
        <View>
          <Text style={styles.headerSub}>{restaurante.categoria}</Text>
          <Text style={styles.headerTitle}>{restaurante.nombre}</Text>
        </View>
      </View>
      <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 100 }}>
        {platos.length === 0 && (
          <Text style={{ color: "#888", textAlign: "center", padding: 20 }}>Este restaurante no tiene platos aun</Text>
        )}
        {platos.map((p) => (
          <View key={p.id} style={styles.platoCard}>
            {p.imagen_url ? (
              <Image source={{ uri: p.imagen_url }} style={{ width: 70, height: 70, borderRadius: 10, marginRight: 12 }} />
            ) : (
              <View style={{ width: 70, height: 70, borderRadius: 10, backgroundColor: "#FDEEDC", alignItems: "center", justifyContent: "center", marginRight: 12 }}>
                <Text style={{ fontSize: 28 }}>🍽️</Text>
              </View>
            )}
            <View style={{ flex: 1 }}>
              <Text style={{ fontSize: 15, fontWeight: "600", color: "#333" }}>{p.nombre}</Text>
              {p.descripcion ? <Text style={{ fontSize: 12, color: "#888", marginTop: 2 }}>{p.descripcion}</Text> : null}
              <Text style={{ fontSize: 15, fontWeight: "600", color: "#E8821C", marginTop: 4 }}>${p.precio.toLocaleString()}</Text>
            </View>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
              <TouchableOpacity style={styles.btnCantidad} onPress={() => quitarDelCarrito(p)}>
                <Text style={{ fontSize: 18, color: "#333" }}>-</Text>
              </TouchableOpacity>
              <Text style={{ fontSize: 15, fontWeight: "600", minWidth: 20, textAlign: "center" }}>
                {carrito.find(c => c.id === p.id)?.cantidad || 0}
              </Text>
              <TouchableOpacity style={[styles.btnCantidad, { backgroundColor: "#E8821C" }]} onPress={() => agregarAlCarrito(p)}>
                <Text style={{ fontSize: 18, color: "#fff" }}>+</Text>
              </TouchableOpacity>
            </View>
          </View>
        ))}
      </ScrollView>
      {carrito.length > 0 && (
        <TouchableOpacity style={styles.botonCarrito} onPress={() => navigation.navigate("Pedido", { carrito, restaurante, usuario })}>
          <Text style={{ color: "#fff", fontWeight: "bold", fontSize: 15 }}>Ver pedido — ${totalCarrito().toLocaleString()}</Text>
        </TouchableOpacity>
      )}
    </SafeAreaView>
  );
}

function PedidoScreen({ navigation, route }) {
  const { carrito, restaurante, usuario } = route.params;
  const [direccion, setDireccion] = useState("");
  const [metodoPago, setMetodoPago] = useState("efectivo");
  const [cargando, setCargando] = useState(false);

  const totalCarrito = () => carrito.reduce((acc, c) => acc + c.precio * c.cantidad, 0);
  const total = totalCarrito() + restaurante.domicilio;

  const hacerPedido = () => {
    if (!direccion) { Alert.alert("Error", "Por favor ingresa tu direccion"); return; }
    setCargando(true);
    const platosTexto = carrito.map(c => `${c.cantidad}x ${c.nombre}`).join(", ");
    fetch(`${API}/pedidos?cliente_nombre=${usuario.nombre}&cliente_direccion=${direccion}&cliente_telefono=${usuario.telefono}&restaurante_id=${restaurante.id}&plato=${encodeURIComponent(platosTexto)}&total=${total}&metodo_pago=${metodoPago}`, { method: "POST" })
      .then((res) => res.json())
      .then(() => { setCargando(false); navigation.replace("MisPedidos", { usuario }); })
      .catch(() => { setCargando(false); Alert.alert("Error", "Error al enviar pedido"); });
  };

  return (
    <SafeAreaView style={styles.container}>
      <View style={[styles.header, { flexDirection: "row", alignItems: "center", gap: 12 }]}>
        <TouchableOpacity onPress={() => navigation.goBack()}>
          <Text style={{ color: "#fff", fontSize: 20 }}>←</Text>
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Tu pedido</Text>
      </View>
      <ScrollView contentContainerStyle={{ padding: 16 }}>
        <View style={styles.card}>
          <Text style={{ fontWeight: "600", fontSize: 15, marginBottom: 12 }}>Resumen</Text>
          {carrito.map((c) => (
            <View key={c.id} style={{ flexDirection: "row", justifyContent: "space-between", marginBottom: 8 }}>
              <Text style={{ fontSize: 13, color: "#333" }}>{c.cantidad}x {c.nombre}</Text>
              <Text style={{ fontSize: 13, fontWeight: "500" }}>${(c.precio * c.cantidad).toLocaleString()}</Text>
            </View>
          ))}
          <View style={{ flexDirection: "row", justifyContent: "space-between", paddingTop: 8, borderTopWidth: 0.5, borderColor: "#eee", marginTop: 4 }}>
            <Text style={{ fontSize: 13, color: "#888" }}>Domicilio</Text>
            <Text style={{ fontSize: 13 }}>${restaurante.domicilio.toLocaleString()}</Text>
          </View>
          <View style={{ flexDirection: "row", justifyContent: "space-between", marginTop: 8 }}>
            <Text style={{ fontSize: 15, fontWeight: "600" }}>Total</Text>
            <Text style={{ fontSize: 15, fontWeight: "600", color: "#E8821C" }}>${total.toLocaleString()}</Text>
          </View>
        </View>
        <View style={[styles.card, { marginTop: 12 }]}>
          <Text style={{ fontWeight: "600", fontSize: 15, marginBottom: 12 }}>Direccion de entrega</Text>
          <TextInput placeholder="Tu direccion completa" value={direccion} onChangeText={setDireccion} style={styles.input} />
        </View>
        <View style={[styles.card, { marginTop: 12 }]}>
          <Text style={{ fontWeight: "600", fontSize: 15, marginBottom: 12 }}>Metodo de pago</Text>
          <View style={{ flexDirection: "row", gap: 8 }}>
            {["efectivo", "nequi", "bancolombia"].map((m) => (
              <TouchableOpacity key={m} style={{ flex: 1, padding: 10, borderRadius: 8, borderWidth: 1, borderColor: metodoPago === m ? "#E8821C" : "#ddd", backgroundColor: metodoPago === m ? "#FDEEDC" : "#fff", alignItems: "center" }} onPress={() => setMetodoPago(m)}>
                <Text style={{ fontSize: 11, color: metodoPago === m ? "#E8821C" : "#888", fontWeight: metodoPago === m ? "600" : "400" }}>
                  {m === "efectivo" ? "Efectivo" : m === "nequi" ? "Nequi" : "Bancolombia"}
                </Text>
              </TouchableOpacity>
            ))}
          </View>
          {metodoPago === "nequi" && (
            <View style={{ backgroundColor: "#FDEEDC", borderRadius: 8, padding: 10, marginTop: 10 }}>
              <Text style={{ fontSize: 12, fontWeight: "600", color: "#E8821C" }}>Transfiere por Nequi</Text>
              <Text style={{ fontSize: 12, color: "#555", marginTop: 2 }}>Numero: 3156009728</Text>
            </View>
          )}
          {metodoPago === "bancolombia" && (
            <View style={{ backgroundColor: "#E6F1FB", borderRadius: 8, padding: 10, marginTop: 10 }}>
              <Text style={{ fontSize: 12, fontWeight: "600", color: "#185FA5" }}>Transfiere por Bancolombia</Text>
              <Text style={{ fontSize: 12, color: "#555", marginTop: 2 }}>Cuenta: 07985044028</Text>
            </View>
          )}
          {metodoPago === "efectivo" && (
            <View style={{ backgroundColor: "#EAF3DE", borderRadius: 8, padding: 10, marginTop: 10 }}>
              <Text style={{ fontSize: 12, fontWeight: "600", color: "#2E7D32" }}>Pago en efectivo</Text>
              <Text style={{ fontSize: 11, color: "#888", marginTop: 2 }}>Ten el dinero listo cuando llegue el domiciliario</Text>
            </View>
          )}
        </View>
        <TouchableOpacity style={[styles.button, { marginTop: 20 }]} onPress={hacerPedido} disabled={cargando}>
          {cargando ? <ActivityIndicator color="#fff" /> : <Text style={styles.buttonText}>Confirmar pedido — ${total.toLocaleString()}</Text>}
        </TouchableOpacity>
      </ScrollView>
    </SafeAreaView>
  );
}

function MisPedidosScreen({ navigation, route }) {
  const { usuario } = route.params;
  const [pedidos, setPedidos] = useState([]);

  const cargarPedidos = () => {
    fetch(`${API}/pedidos`)
      .then((res) => res.json())
      .then((data) => { if (Array.isArray(data)) setPedidos(data.filter(p => p.cliente_telefono === usuario.telefono)); });
  };

  useEffect(() => {
    cargarPedidos();
    const intervalo = setInterval(cargarPedidos, 8000);
    return () => clearInterval(intervalo);
  }, []);

  const ordenEstados = ["pendiente", "aceptado", "preparando", "listo", "asignado", "en camino", "entregado"];
  const iconos = ["📋", "✅", "👨‍🍳", "📦", "🛵", "🚀", "🎉"];
  const labels = ["Recibido", "Aceptado", "Preparando", "Listo", "Asignado", "En camino", "Entregado"];

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.headerSub}>Hola, {usuario.nombre}</Text>
        <Text style={styles.headerTitle}>Mis pedidos</Text>
      </View>
      <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 100 }}>
        {pedidos.length === 0 && (
          <View style={{ alignItems: "center", padding: 40 }}>
            <Text style={{ fontSize: 40 }}>📋</Text>
            <Text style={{ color: "#888", marginTop: 8 }}>No tienes pedidos aun</Text>
          </View>
        )}
        {pedidos.map((p) => (
          <View key={p.id} style={[styles.card, { marginBottom: 12 }]}>
            <View style={{ flexDirection: "row", justifyContent: "space-between", marginBottom: 8 }}>
              <Text style={{ fontWeight: "600" }}>Pedido #{p.id}</Text>
              <Text style={{ color: "#E8821C", fontWeight: "600", fontSize: 12 }}>{p.estado.toUpperCase()}</Text>
            </View>
            <Text style={{ fontSize: 13, color: "#888" }}>{p.plato}</Text>
            <Text style={{ fontSize: 14, fontWeight: "600", color: "#E8821C", marginTop: 4 }}>${p.total.toLocaleString()}</Text>
            <View style={{ marginTop: 12 }}>
              {ordenEstados.map((estado, index) => {
                const indiceActual = ordenEstados.indexOf(p.estado);
                const completado = index <= indiceActual;
                const actual = index === indiceActual;
                return (
                  <View key={estado} style={{ flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 6 }}>
                    <View style={{ width: 24, height: 24, borderRadius: 12, backgroundColor: completado ? "#E8821C" : "#f0f0f0", alignItems: "center", justifyContent: "center" }}>
                      <Text style={{ fontSize: 12 }}>{completado ? iconos[index] : "○"}</Text>
                    </View>
                    <Text style={{ fontSize: 12, color: completado ? "#333" : "#bbb", fontWeight: actual ? "600" : "400" }}>{labels[index]}</Text>
                    {actual && (
                      <View style={{ backgroundColor: "#FDEEDC", borderRadius: 4, paddingHorizontal: 6, paddingVertical: 2 }}>
                        <Text style={{ fontSize: 10, color: "#E8821C", fontWeight: "600" }}>Ahora</Text>
                      </View>
                    )}
                  </View>
                );
              })}
            </View>
          </View>
        ))}
      </ScrollView>
      <TouchableOpacity
        style={{ position: "absolute", bottom: 20, left: 16, right: 16, backgroundColor: "#E8821C", borderRadius: 12, padding: 14, alignItems: "center" }}
        onPress={() => navigation.replace("Inicio", { usuario })}
      >
        <Text style={{ color: "#fff", fontWeight: "bold", fontSize: 15 }}>Hacer otro pedido</Text>
      </TouchableOpacity>
    </SafeAreaView>
  );
}

function AdminScreen({ navigation, route }) {
  const { usuario } = route.params;
  const [pedidos, setPedidos] = useState([]);
  const [restaurantes, setRestaurantes] = useState([]);
  const [domiciliarios, setDomiciliarios] = useState([]);
  const [usuarios, setUsuarios] = useState([]);
  const [platos, setPlatos] = useState([]);
  const [vista, setVista] = useState("pedidos");
  const [restauranteSeleccionado, setRestauranteSeleccionado] = useState(null);
  const [nuevoPlato, setNuevoPlato] = useState({ nombre: "", descripcion: "", precio: "" });
  const [nuevoUsuario, setNuevoUsuario] = useState({ nombre: "", telefono: "", password: "", rol: "domiciliario", restaurante_id: "" });
  const [mensaje, setMensaje] = useState("");
  const [subiendo, setSubiendo] = useState(false);

  const cargarPedidos = () => {
    fetch(`${API}/pedidos`).then(r => r.json()).then(data => { if (Array.isArray(data)) setPedidos(data); });
  };

  const cargarRestaurantes = () => {
    fetch(`${API}/restaurantes`).then(r => r.json()).then(data => { if (Array.isArray(data)) setRestaurantes(data); });
  };

  const cargarDomiciliarios = () => {
    fetch(`${API}/domiciliarios`).then(r => r.json()).then(data => { if (Array.isArray(data)) setDomiciliarios(data); });
  };

  const cargarUsuarios = () => {
    fetch(`${API}/usuarios`).then(r => r.json()).then(data => { if (Array.isArray(data)) setUsuarios(data); });
  };

  const cargarPlatos = (restauranteId) => {
    fetch(`${API}/restaurantes/${restauranteId}/platos`).then(r => r.json()).then(data => { if (Array.isArray(data)) setPlatos(data); });
  };

  useEffect(() => {
    cargarPedidos();
    cargarRestaurantes();
    cargarDomiciliarios();
    cargarUsuarios();
    const intervalo = setInterval(cargarPedidos, 10000);
    return () => clearInterval(intervalo);
  }, []);

  const cambiarEstado = (id, estado) => {
    fetch(`${API}/pedidos/${id}/estado?estado=${estado}`, { method: "PUT" }).then(() => cargarPedidos());
  };

  const eliminarRestaurante = (restaurante) => {
    Alert.alert(
      "Eliminar restaurante",
      `Seguro que quieres eliminar "${restaurante.nombre}"? Se borraran tambien todos sus platos.`,
      [
        { text: "Cancelar", style: "cancel" },
        {
          text: "Eliminar",
          style: "destructive",
          onPress: () => {
            fetch(`${API}/restaurantes/${restaurante.id}`, { method: "DELETE" })
              .then(r => r.json())
              .then(() => cargarRestaurantes())
              .catch(() => Alert.alert("Error", "No se pudo eliminar el restaurante"));
          },
        },
      ]
    );
  };

  const agregarPlato = () => {
    if (!nuevoPlato.nombre || !nuevoPlato.precio) { setMensaje("Completa nombre y precio"); return; }
    fetch(`${API}/platos?restaurante_id=${restauranteSeleccionado.id}&nombre=${encodeURIComponent(nuevoPlato.nombre)}&descripcion=${encodeURIComponent(nuevoPlato.descripcion || "")}&precio=${nuevoPlato.precio}`, { method: "POST" })
      .then(r => r.json())
      .then(() => {
        setMensaje("Plato agregado");
        setNuevoPlato({ nombre: "", descripcion: "", precio: "" });
        cargarPlatos(restauranteSeleccionado.id);
      });
  };

  const subirFotoPlato = async (platoId) => {
    const permiso = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permiso.granted) { Alert.alert("Permiso requerido", "Necesitamos acceso a tu galeria"); return; }
    const resultado = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      allowsEditing: true,
      aspect: [1, 1],
      quality: 0.8,
    });
    if (!resultado.canceled) {
      setSubiendo(true);
      const formData = new FormData();
      formData.append("file", { uri: resultado.assets[0].uri, type: "image/jpeg", name: `plato_${platoId}.jpg` });
      fetch(`${API}/platos/imagen/${platoId}`, { method: "POST", body: formData, headers: { "Content-Type": "multipart/form-data" } })
        .then(r => r.json())
        .then(() => { setSubiendo(false); setMensaje("Foto subida"); cargarPlatos(restauranteSeleccionado.id); })
        .catch(() => { setSubiendo(false); Alert.alert("Error", "No se pudo subir la foto"); });
    }
  };

  const subirFotoRestaurante = async (restauranteId) => {
    const permiso = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permiso.granted) { Alert.alert("Permiso requerido", "Necesitamos acceso a tu galeria"); return; }
    const resultado = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      allowsEditing: true,
      aspect: [4, 3],
      quality: 0.8,
    });
    if (!resultado.canceled) {
      setSubiendo(true);
      const formData = new FormData();
      formData.append("file", { uri: resultado.assets[0].uri, type: "image/jpeg", name: `restaurante_${restauranteId}.jpg` });
      fetch(`${API}/restaurantes/imagen/${restauranteId}`, { method: "POST", body: formData, headers: { "Content-Type": "multipart/form-data" } })
        .then(r => r.json())
        .then(() => { setSubiendo(false); setMensaje("Foto subida"); cargarRestaurantes(); })
        .catch(() => { setSubiendo(false); Alert.alert("Error", "No se pudo subir la foto"); });
    }
  };

  const crearUsuario = () => {
    if (!nuevoUsuario.nombre || !nuevoUsuario.telefono || !nuevoUsuario.password) { setMensaje("Completa todos los campos"); return; }
    fetch(`${API}/registro?nombre=${encodeURIComponent(nuevoUsuario.nombre)}&telefono=${nuevoUsuario.telefono}&password=${nuevoUsuario.password}`, { method: "POST" })
      .then(r => r.json())
      .then((data) => {
        if (data.detail) { setMensaje(data.detail); return; }
        const url = nuevoUsuario.rol === "restaurante"
          ? `${API}/usuarios/${nuevoUsuario.telefono}/rol?rol=${nuevoUsuario.rol}&restaurante_id=${nuevoUsuario.restaurante_id}`
          : `${API}/usuarios/${nuevoUsuario.telefono}/rol?rol=${nuevoUsuario.rol}`;
        fetch(url, { method: "PUT" }).then(() => {
          setMensaje("Usuario creado");
          setNuevoUsuario({ nombre: "", telefono: "", password: "", rol: "domiciliario", restaurante_id: "" });
          cargarUsuarios();
          cargarDomiciliarios();
        });
      });
  };

  const colorEstado = (estado) => {
    if (estado === "pendiente") return { bg: "#FAEEDA", text: "#854F0B" };
    if (estado === "preparando" || estado === "aceptado") return { bg: "#E6F1FB", text: "#185FA5" };
    if (estado === "listo") return { bg: "#EAF3DE", text: "#2E7D32" };
    if (estado === "asignado" || estado === "en camino") return { bg: "#FDEEDC", text: "#E8821C" };
    if (estado === "entregado") return { bg: "#EAF3DE", text: "#2E7D32" };
    return { bg: "#F6F1E6", text: "#888" };
  };

  return (
    <SafeAreaView style={styles.container}>
      <View style={[styles.header, { backgroundColor: "#1E3B22" }]}>
        <Text style={styles.headerSub}>Panel de</Text>
        <Text style={styles.headerTitle}>Administracion</Text>
      </View>

      <View style={{ flexDirection: "row", backgroundColor: "#F6F1E6", margin: 16, borderRadius: 10, padding: 4 }}>
        {["pedidos", "restaurantes", "usuarios"].map((v) => (
          <TouchableOpacity key={v} style={{ flex: 1, padding: 8, borderRadius: 8, backgroundColor: vista === v ? "#fff" : "transparent", alignItems: "center" }} onPress={() => { setVista(v); setRestauranteSeleccionado(null); }}>
            <Text style={{ fontSize: 11, fontWeight: vista === v ? "600" : "400", color: vista === v ? "#333" : "#888" }}>
              {v === "pedidos" ? "Pedidos" : v === "restaurantes" ? "Restaurantes" : "Usuarios"}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      {vista === "pedidos" && (
        <ScrollView contentContainerStyle={{ padding: 16, paddingTop: 0 }}>
          <View style={{ flexDirection: "row", gap: 10, marginBottom: 16 }}>
            <View style={{ flex: 1, backgroundColor: "#FAEEDA", borderRadius: 12, padding: 12, alignItems: "center" }}>
              <Text style={{ fontSize: 11, color: "#854F0B" }}>Pendientes</Text>
              <Text style={{ fontSize: 22, fontWeight: "bold", color: "#854F0B" }}>{pedidos.filter(p => p.estado === "pendiente").length}</Text>
            </View>
            <View style={{ flex: 1, backgroundColor: "#E6F1FB", borderRadius: 12, padding: 12, alignItems: "center" }}>
              <Text style={{ fontSize: 11, color: "#185FA5" }}>En proceso</Text>
              <Text style={{ fontSize: 22, fontWeight: "bold", color: "#185FA5" }}>{pedidos.filter(p => ["aceptado", "preparando", "listo", "asignado", "en camino"].includes(p.estado)).length}</Text>
            </View>
            <View style={{ flex: 1, backgroundColor: "#EAF3DE", borderRadius: 12, padding: 12, alignItems: "center" }}>
              <Text style={{ fontSize: 11, color: "#2E7D32" }}>Entregados</Text>
              <Text style={{ fontSize: 22, fontWeight: "bold", color: "#2E7D32" }}>{pedidos.filter(p => p.estado === "entregado").length}</Text>
            </View>
          </View>
          {pedidos.map((p) => (
            <View key={p.id} style={[styles.card, { marginBottom: 12 }]}>
              <View style={{ flexDirection: "row", justifyContent: "space-between", marginBottom: 8 }}>
                <Text style={{ fontWeight: "600" }}>#{p.id} — {p.cliente_nombre}</Text>
                <View style={{ backgroundColor: colorEstado(p.estado).bg, borderRadius: 6, paddingHorizontal: 8, paddingVertical: 3 }}>
                  <Text style={{ fontSize: 11, color: colorEstado(p.estado).text, fontWeight: "600" }}>{p.estado}</Text>
                </View>
              </View>
              <Text style={{ fontSize: 12, color: "#888" }}>📍 {p.cliente_direccion}</Text>
              <Text style={{ fontSize: 12, color: "#888", marginTop: 2 }}>🍽️ {p.plato}</Text>
              <Text style={{ fontSize: 12, color: "#888", marginTop: 2 }}>💰 ${p.total.toLocaleString()} - {p.metodo_pago}</Text>
              {p.estado === "listo" && domiciliarios.length > 0 && (
                <View style={{ marginTop: 10 }}>
                  <Text style={{ fontSize: 12, fontWeight: "600", marginBottom: 6 }}>Asignar domiciliario:</Text>
                  <ScrollView horizontal showsHorizontalScrollIndicator={false}>
                    <View style={{ flexDirection: "row", gap: 8 }}>
                      {domiciliarios.map((d) => (
                        <TouchableOpacity key={d.id} style={{ backgroundColor: "#185FA5", borderRadius: 8, paddingHorizontal: 12, paddingVertical: 8 }}
                          onPress={() => { fetch(`${API}/pedidos/${p.id}/asignar?domiciliario_id=${d.id}`, { method: "PUT" }).then(() => cargarPedidos()); }}>
                          <Text style={{ color: "#fff", fontSize: 12, fontWeight: "600" }}>🛵 {d.nombre}</Text>
                        </TouchableOpacity>
                      ))}
                    </View>
                  </ScrollView>
                </View>
              )}
              {p.estado === "en camino" && (
                <TouchableOpacity style={[styles.button, { marginTop: 10, backgroundColor: "#2E7D32" }]} onPress={() => cambiarEstado(p.id, "entregado")}>
                  <Text style={styles.buttonText}>Entregado</Text>
                </TouchableOpacity>
              )}
            </View>
          ))}
        </ScrollView>
      )}

      {vista === "restaurantes" && !restauranteSeleccionado && (
        <ScrollView contentContainerStyle={{ padding: 16, paddingTop: 0 }}>
          {restaurantes.map((r) => (
            <View key={r.id} style={[styles.card, { marginBottom: 12 }]}>
              <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
                {r.imagen_url ? (
                  <Image source={{ uri: r.imagen_url }} style={{ width: 60, height: 60, borderRadius: 10 }} />
                ) : (
                  <View style={{ width: 60, height: 60, borderRadius: 10, backgroundColor: "#FDEEDC", alignItems: "center", justifyContent: "center" }}>
                    <Text style={{ fontSize: 24 }}>🍽️</Text>
                  </View>
                )}
                <View style={{ flex: 1 }}>
                  <Text style={{ fontWeight: "600", fontSize: 14 }}>{r.nombre}</Text>
                  <Text style={{ fontSize: 12, color: "#888" }}>{r.categoria}</Text>
                </View>
              </View>
              <View style={{ flexDirection: "row", gap: 8, marginTop: 10 }}>
                <TouchableOpacity style={[styles.button, { flex: 1, backgroundColor: "#185FA5" }]} onPress={() => { setRestauranteSeleccionado(r); cargarPlatos(r.id); }}>
                  <Text style={styles.buttonText}>Ver menu</Text>
                </TouchableOpacity>
                <TouchableOpacity style={[styles.button, { flex: 1, backgroundColor: "#2E7D32" }]} onPress={() => subirFotoRestaurante(r.id)}>
                  <Text style={styles.buttonText}>📷 Foto</Text>
                </TouchableOpacity>
                <TouchableOpacity style={[styles.button, { flex: 1, backgroundColor: "#C62828" }]} onPress={() => eliminarRestaurante(r)}>
                  <Text style={styles.buttonText}>🗑️ Eliminar</Text>
                </TouchableOpacity>
              </View>
            </View>
          ))}
        </ScrollView>
      )}

      {vista === "restaurantes" && restauranteSeleccionado && (
        <ScrollView contentContainerStyle={{ padding: 16, paddingTop: 0 }}>
          <TouchableOpacity style={{ marginBottom: 12 }} onPress={() => { setRestauranteSeleccionado(null); setMensaje(""); }}>
            <Text style={{ color: "#E8821C", fontWeight: "600" }}>← Volver</Text>
          </TouchableOpacity>
          <Text style={{ fontWeight: "600", fontSize: 16, marginBottom: 12 }}>{restauranteSeleccionado.nombre}</Text>
          <View style={[styles.card, { marginBottom: 16 }]}>
            <Text style={{ fontWeight: "600", fontSize: 14, marginBottom: 12 }}>Agregar plato</Text>
            <TextInput placeholder="Nombre del plato" value={nuevoPlato.nombre} onChangeText={(t) => setNuevoPlato({ ...nuevoPlato, nombre: t })} style={styles.input} />
            <TextInput placeholder="Descripcion (opcional)" value={nuevoPlato.descripcion} onChangeText={(t) => setNuevoPlato({ ...nuevoPlato, descripcion: t })} style={styles.input} />
            <TextInput placeholder="Precio (ej: 15000)" value={nuevoPlato.precio} onChangeText={(t) => setNuevoPlato({ ...nuevoPlato, precio: t })} style={styles.input} keyboardType="numeric" />
            {mensaje ? <Text style={{ color: "#2E7D32", fontSize: 12, marginBottom: 8 }}>{mensaje}</Text> : null}
            <TouchableOpacity style={styles.button} onPress={agregarPlato}>
              <Text style={styles.buttonText}>Agregar plato</Text>
            </TouchableOpacity>
          </View>
          {subiendo && <ActivityIndicator color="#E8821C" style={{ marginBottom: 12 }} />}
          <Text style={{ fontWeight: "600", fontSize: 14, marginBottom: 12 }}>Platos ({platos.length})</Text>
          {platos.map((p) => (
            <View key={p.id} style={[styles.card, { marginBottom: 10, flexDirection: "row", alignItems: "center", gap: 10 }]}>
              <TouchableOpacity onPress={() => subirFotoPlato(p.id)}>
                {p.imagen_url ? (
                  <Image source={{ uri: p.imagen_url }} style={{ width: 60, height: 60, borderRadius: 10 }} />
                ) : (
                  <View style={{ width: 60, height: 60, borderRadius: 10, backgroundColor: "#FDEEDC", alignItems: "center", justifyContent: "center" }}>
                    <Text style={{ fontSize: 10, color: "#E8821C", textAlign: "center" }}>📷{"\n"}Subir</Text>
                  </View>
                )}
              </TouchableOpacity>
              <View style={{ flex: 1 }}>
                <Text style={{ fontWeight: "600" }}>{p.nombre}</Text>
                {p.descripcion ? <Text style={{ fontSize: 12, color: "#888" }}>{p.descripcion}</Text> : null}
                <Text style={{ fontSize: 13, color: "#E8821C", fontWeight: "600" }}>${p.precio.toLocaleString()}</Text>
              </View>
            </View>
          ))}
        </ScrollView>
      )}

      {vista === "usuarios" && (
        <ScrollView contentContainerStyle={{ padding: 16, paddingTop: 0 }}>
          <View style={[styles.card, { marginBottom: 16 }]}>
            <Text style={{ fontWeight: "600", fontSize: 15, marginBottom: 12 }}>Crear usuario</Text>
            <TextInput placeholder="Nombre" value={nuevoUsuario.nombre} onChangeText={(t) => setNuevoUsuario({ ...nuevoUsuario, nombre: t })} style={styles.input} />
            <TextInput placeholder="Telefono" value={nuevoUsuario.telefono} onChangeText={(t) => setNuevoUsuario({ ...nuevoUsuario, telefono: t })} style={styles.input} keyboardType="phone-pad" />
            <TextInput placeholder="Contrasena" value={nuevoUsuario.password} onChangeText={(t) => setNuevoUsuario({ ...nuevoUsuario, password: t })} style={styles.input} />
            <View style={{ flexDirection: "row", gap: 8, marginBottom: 12 }}>
              {["domiciliario", "restaurante", "admin"].map((r) => (
                <TouchableOpacity key={r} style={{ flex: 1, padding: 8, borderRadius: 8, borderWidth: 1, borderColor: nuevoUsuario.rol === r ? "#E8821C" : "#ddd", backgroundColor: nuevoUsuario.rol === r ? "#FDEEDC" : "#fff", alignItems: "center" }} onPress={() => setNuevoUsuario({ ...nuevoUsuario, rol: r })}>
                  <Text style={{ fontSize: 10, color: nuevoUsuario.rol === r ? "#E8821C" : "#888", fontWeight: nuevoUsuario.rol === r ? "600" : "400" }}>{r}</Text>
                </TouchableOpacity>
              ))}
            </View>
            {nuevoUsuario.rol === "restaurante" && restaurantes.map((r) => (
              <TouchableOpacity key={r.id} style={{ padding: 10, borderRadius: 8, borderWidth: 1, borderColor: nuevoUsuario.restaurante_id === String(r.id) ? "#E8821C" : "#ddd", backgroundColor: nuevoUsuario.restaurante_id === String(r.id) ? "#FDEEDC" : "#fff", marginBottom: 8 }} onPress={() => setNuevoUsuario({ ...nuevoUsuario, restaurante_id: String(r.id) })}>
                <Text style={{ fontSize: 13, color: nuevoUsuario.restaurante_id === String(r.id) ? "#E8821C" : "#333" }}>{r.nombre}</Text>
              </TouchableOpacity>
            ))}
            {mensaje ? <Text style={{ color: "#2E7D32", fontSize: 12, marginBottom: 8 }}>{mensaje}</Text> : null}
            <TouchableOpacity style={styles.button} onPress={crearUsuario}>
              <Text style={styles.buttonText}>Crear usuario</Text>
            </TouchableOpacity>
          </View>
          {usuarios.map((u) => (
            <View key={u.id} style={[styles.card, { marginBottom: 10, flexDirection: "row", justifyContent: "space-between", alignItems: "center" }]}>
              <View>
                <Text style={{ fontWeight: "600" }}>{u.nombre}</Text>
                <Text style={{ fontSize: 12, color: "#888", marginTop: 2 }}>📞 {u.telefono}</Text>
              </View>
              <View style={{ backgroundColor: u.rol === "admin" ? "#FAEEDA" : u.rol === "domiciliario" ? "#E6F1FB" : u.rol === "restaurante" ? "#EAF3DE" : "#F6F1E6", borderRadius: 6, paddingHorizontal: 8, paddingVertical: 4 }}>
                <Text style={{ fontSize: 11, color: u.rol === "admin" ? "#854F0B" : u.rol === "domiciliario" ? "#185FA5" : u.rol === "restaurante" ? "#2E7D32" : "#888", fontWeight: "600" }}>{u.rol}</Text>
              </View>
            </View>
          ))}
        </ScrollView>
      )}

      <TouchableOpacity style={{ padding: 16, alignItems: "center" }} onPress={() => navigation.replace("Login")}>
        <Text style={{ color: "#888", fontSize: 13 }}>Salir</Text>
      </TouchableOpacity>
    </SafeAreaView>
  );
}

function DomiciliarioScreen({ navigation, route }) {
  const { usuario } = route.params;
  const [pedidos, setPedidos] = useState([]);
  const [restaurantes, setRestaurantes] = useState({});

  const cargarRestaurantes = () => {
    fetch(`${API}/restaurantes`).then(r => r.json()).then((data) => {
      if (Array.isArray(data)) {
        const mapa = {};
        data.forEach(r => { mapa[r.id] = r; });
        setRestaurantes(mapa);
      }
    });
  };

  const cargarPedidos = () => {
    fetch(`${API}/pedidos`).then(r => r.json()).then((data) => {
      if (Array.isArray(data)) setPedidos(data.filter(p => p.domiciliario_id === usuario.id && p.estado !== "entregado"));
    });
  };

  useEffect(() => {
    cargarRestaurantes();
    cargarPedidos();
    const intervalo = setInterval(cargarPedidos, 8000);
    return () => clearInterval(intervalo);
  }, []);

  const cambiarEstado = (id, estado) => {
    fetch(`${API}/pedidos/${id}/estado?estado=${estado}`, { method: "PUT" }).then(() => cargarPedidos());
  };

  return (
    <SafeAreaView style={styles.container}>
      <View style={[styles.header, { backgroundColor: "#E8821C" }]}>
        <Text style={styles.headerSub}>Hola, {usuario.nombre} 🛵</Text>
        <Text style={styles.headerTitle}>Mis Entregas</Text>
      </View>
      <View style={{ flexDirection: "row", padding: 16, gap: 12 }}>
        <View style={{ flex: 1, backgroundColor: "#FAEEDA", borderRadius: 12, padding: 12, alignItems: "center" }}>
          <Text style={{ fontSize: 11, color: "#854F0B" }}>Por recoger</Text>
          <Text style={{ fontSize: 22, fontWeight: "bold", color: "#854F0B" }}>{pedidos.filter(p => p.estado === "asignado").length}</Text>
        </View>
        <View style={{ flex: 1, backgroundColor: "#E6F1FB", borderRadius: 12, padding: 12, alignItems: "center" }}>
          <Text style={{ fontSize: 11, color: "#185FA5" }}>En camino</Text>
          <Text style={{ fontSize: 22, fontWeight: "bold", color: "#185FA5" }}>{pedidos.filter(p => p.estado === "en camino").length}</Text>
        </View>
      </View>
      <ScrollView contentContainerStyle={{ padding: 16, paddingTop: 0 }}>
        {pedidos.length === 0 && (
          <View style={{ alignItems: "center", padding: 40 }}>
            <Text style={{ fontSize: 40 }}>😴</Text>
            <Text style={{ color: "#888", marginTop: 8 }}>No tienes pedidos asignados</Text>
          </View>
        )}
        {pedidos.map((p) => (
          <View key={p.id} style={[styles.card, { marginBottom: 12 }]}>
            <View style={{ flexDirection: "row", justifyContent: "space-between", marginBottom: 8 }}>
              <Text style={{ fontWeight: "600" }}>Pedido #{p.id}</Text>
              <View style={{ backgroundColor: p.estado === "asignado" ? "#FAEEDA" : "#E6F1FB", borderRadius: 6, paddingHorizontal: 8, paddingVertical: 3 }}>
                <Text style={{ fontSize: 11, color: p.estado === "asignado" ? "#854F0B" : "#185FA5", fontWeight: "600" }}>{p.estado}</Text>
              </View>
            </View>
            {restaurantes[p.restaurante_id] && (
              <View style={{ backgroundColor: "#FDEEDC", borderRadius: 8, padding: 10, marginBottom: 10 }}>
                <Text style={{ fontSize: 12, fontWeight: "600", color: "#E8821C" }}>Recoger en:</Text>
                <Text style={{ fontSize: 14, fontWeight: "600", marginTop: 2 }}>{restaurantes[p.restaurante_id].nombre}</Text>
              </View>
            )}
            <Text style={{ fontSize: 13, color: "#888" }}>👤 {p.cliente_nombre}</Text>
            <Text style={{ fontSize: 13, color: "#888", marginTop: 2 }}>📍 {p.cliente_direccion}</Text>
            <Text style={{ fontSize: 13, color: "#888", marginTop: 2 }}>📞 {p.cliente_telefono}</Text>
            <Text style={{ fontSize: 13, fontWeight: "600", color: "#E8821C", marginTop: 4 }}>🍽️ {p.plato}</Text>
            <Text style={{ fontSize: 13, color: "#888", marginTop: 2 }}>💰 ${p.total.toLocaleString()} - {p.metodo_pago}</Text>
            <View style={{ marginTop: 12 }}>
              {p.estado === "asignado" && (
                <TouchableOpacity style={[styles.button, { backgroundColor: "#E8821C" }]} onPress={() => cambiarEstado(p.id, "en camino")}>
                  <Text style={styles.buttonText}>Ya recogi — En camino</Text>
                </TouchableOpacity>
              )}
              {p.estado === "en camino" && (
                <TouchableOpacity style={[styles.button, { backgroundColor: "#2E7D32" }]} onPress={() => cambiarEstado(p.id, "entregado")}>
                  <Text style={styles.buttonText}>Pedido entregado</Text>
                </TouchableOpacity>
              )}
            </View>
          </View>
        ))}
      </ScrollView>
      <TouchableOpacity style={{ padding: 16, alignItems: "center" }} onPress={() => navigation.replace("Login")}>
        <Text style={{ color: "#888", fontSize: 13 }}>Salir</Text>
      </TouchableOpacity>
    </SafeAreaView>
  );
}

function RestauranteScreen({ navigation, route }) {
  const { usuario } = route.params;
  const [pedidos, setPedidos] = useState([]);

  const cargarPedidos = () => {
    fetch(`${API}/pedidos/restaurante/${usuario.restaurante_id}`)
      .then(r => r.json())
      .then((data) => { if (Array.isArray(data)) setPedidos(data.filter(p => p.estado !== "entregado")); });
  };

  useEffect(() => {
    cargarPedidos();
    const intervalo = setInterval(cargarPedidos, 8000);
    return () => clearInterval(intervalo);
  }, []);

  const cambiarEstado = (id, estado) => {
    fetch(`${API}/pedidos/${id}/estado?estado=${estado}`, { method: "PUT" }).then(() => cargarPedidos());
  };

  const colorEstado = (estado) => {
    if (estado === "pendiente") return { bg: "#FAEEDA", text: "#854F0B" };
    if (estado === "aceptado") return { bg: "#E6F1FB", text: "#185FA5" };
    if (estado === "preparando") return { bg: "#E6F1FB", text: "#185FA5" };
    if (estado === "listo") return { bg: "#EAF3DE", text: "#2E7D32" };
    if (estado === "asignado") return { bg: "#F1EFE8", text: "#5F5E5A" };
    return { bg: "#F6F1E6", text: "#888" };
  };

  return (
    <SafeAreaView style={styles.container}>
      <View style={[styles.header, { backgroundColor: "#1B5E20" }]}>
        <Text style={styles.headerSub}>Hola, {usuario.nombre}</Text>
        <Text style={styles.headerTitle}>Mi Restaurante</Text>
      </View>
      <View style={{ flexDirection: "row", padding: 16, gap: 10 }}>
        <View style={{ flex: 1, backgroundColor: "#FAEEDA", borderRadius: 12, padding: 12, alignItems: "center" }}>
          <Text style={{ fontSize: 11, color: "#854F0B" }}>Nuevos</Text>
          <Text style={{ fontSize: 22, fontWeight: "bold", color: "#854F0B" }}>{pedidos.filter(p => p.estado === "pendiente").length}</Text>
        </View>
        <View style={{ flex: 1, backgroundColor: "#E6F1FB", borderRadius: 12, padding: 12, alignItems: "center" }}>
          <Text style={{ fontSize: 11, color: "#185FA5" }}>Preparando</Text>
          <Text style={{ fontSize: 22, fontWeight: "bold", color: "#185FA5" }}>{pedidos.filter(p => p.estado === "preparando").length}</Text>
        </View>
        <View style={{ flex: 1, backgroundColor: "#EAF3DE", borderRadius: 12, padding: 12, alignItems: "center" }}>
          <Text style={{ fontSize: 11, color: "#2E7D32" }}>Listos</Text>
          <Text style={{ fontSize: 22, fontWeight: "bold", color: "#2E7D32" }}>{pedidos.filter(p => p.estado === "listo").length}</Text>
        </View>
      </View>
      <ScrollView contentContainerStyle={{ padding: 16, paddingTop: 0 }}>
        {pedidos.length === 0 && (
          <View style={{ alignItems: "center", padding: 40 }}>
            <Text style={{ fontSize: 40 }}>😴</Text>
            <Text style={{ color: "#888", marginTop: 8 }}>No hay pedidos por ahora</Text>
          </View>
        )}
        {pedidos.map((p) => (
          <View key={p.id} style={[styles.card, { marginBottom: 12, borderWidth: p.estado === "pendiente" ? 1.5 : 0.5, borderColor: p.estado === "pendiente" ? "#E8821C" : "#eee" }]}>
            <View style={{ flexDirection: "row", justifyContent: "space-between", marginBottom: 8 }}>
              <Text style={{ fontWeight: "600" }}>Pedido #{p.id}</Text>
              <View style={{ backgroundColor: colorEstado(p.estado).bg, borderRadius: 6, paddingHorizontal: 8, paddingVertical: 3 }}>
                <Text style={{ fontSize: 11, color: colorEstado(p.estado).text, fontWeight: "600" }}>{p.estado}</Text>
              </View>
            </View>
            <Text style={{ fontSize: 13, color: "#888" }}>👤 {p.cliente_nombre}</Text>
            <Text style={{ fontSize: 13, color: "#888", marginTop: 2 }}>📍 {p.cliente_direccion}</Text>
            <Text style={{ fontSize: 14, fontWeight: "600", color: "#E8821C", marginTop: 4 }}>🍽️ {p.plato}</Text>
            <Text style={{ fontSize: 13, color: "#888", marginTop: 2 }}>💰 ${p.total.toLocaleString()} - {p.metodo_pago}</Text>
            <View style={{ marginTop: 12 }}>
              {p.estado === "pendiente" && (
                <TouchableOpacity style={[styles.button, { backgroundColor: "#185FA5" }]} onPress={() => cambiarEstado(p.id, "aceptado")}>
                  <Text style={styles.buttonText}>Aceptar pedido</Text>
                </TouchableOpacity>
              )}
              {p.estado === "aceptado" && (
                <TouchableOpacity style={[styles.button, { backgroundColor: "#E8821C" }]} onPress={() => cambiarEstado(p.id, "preparando")}>
                  <Text style={styles.buttonText}>Empezar a preparar</Text>
                </TouchableOpacity>
              )}
              {p.estado === "preparando" && (
                <TouchableOpacity style={[styles.button, { backgroundColor: "#2E7D32" }]} onPress={() => cambiarEstado(p.id, "listo")}>
                  <Text style={styles.buttonText}>Marcar como listo</Text>
                </TouchableOpacity>
              )}
              {p.estado === "listo" && (
                <View style={{ backgroundColor: "#EAF3DE", borderRadius: 8, padding: 12 }}>
                  <Text style={{ color: "#2E7D32", fontWeight: "600", textAlign: "center" }}>Esperando domiciliario...</Text>
                </View>
              )}
              {p.estado === "asignado" && (
                <View style={{ backgroundColor: "#F1EFE8", borderRadius: 8, padding: 12 }}>
                  <Text style={{ color: "#5F5E5A", fontWeight: "600", textAlign: "center" }}>Domiciliario viene en camino</Text>
                </View>
              )}
            </View>
          </View>
        ))}
      </ScrollView>
      <TouchableOpacity style={{ padding: 16, alignItems: "center" }} onPress={() => navigation.replace("Login")}>
        <Text style={{ color: "#888", fontSize: 13 }}>Salir</Text>
      </TouchableOpacity>
    </SafeAreaView>
  );
}

export default function App() {
  return (
    <NavigationContainer>
      <Stack.Navigator initialRouteName="Login" screenOptions={{ headerShown: false, animation: "slide_from_right" }}>
        <Stack.Screen name="Login" component={LoginScreen} />
        <Stack.Screen name="Inicio" component={InicioScreen} />
        <Stack.Screen name="Menu" component={MenuScreen} />
        <Stack.Screen name="Pedido" component={PedidoScreen} />
        <Stack.Screen name="MisPedidos" component={MisPedidosScreen} />
        <Stack.Screen name="Admin" component={AdminScreen} />
        <Stack.Screen name="Domiciliario" component={DomiciliarioScreen} />
        <Stack.Screen name="Restaurante" component={RestauranteScreen} />
      </Stack.Navigator>
    </NavigationContainer>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#F6F1E6" },
  scroll: { padding: 16 },
  header: { backgroundColor: "#2E7D32", padding: 20, paddingTop: 50 },
  headerSub: { color: "rgba(255,255,255,0.8)", fontSize: 12 },
  headerTitle: { color: "#fff", fontSize: 24, fontWeight: "bold", marginTop: 4 },
  card: { backgroundColor: "#fff", borderRadius: 16, padding: 16, shadowColor: "#000", shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.1, shadowRadius: 8, elevation: 4 },
  tabs: { flexDirection: "row", backgroundColor: "#F6F1E6", borderRadius: 8, padding: 4, marginBottom: 20 },
  tab: { flex: 1, padding: 8, borderRadius: 6, alignItems: "center" },
  tabActive: { backgroundColor: "#fff" },
  tabText: { color: "#888", fontSize: 14 },
  tabTextActive: { color: "#333", fontWeight: "500" },
  input: { borderWidth: 0.5, borderColor: "#ddd", borderRadius: 8, padding: 12, marginBottom: 12, fontSize: 14, backgroundColor: "#fff" },
  error: { color: "red", fontSize: 12, marginBottom: 12 },
  button: { backgroundColor: "#E8821C", borderRadius: 8, padding: 14, alignItems: "center" },
  buttonText: { color: "#fff", fontWeight: "bold", fontSize: 16 },
  searchInput: { backgroundColor: "rgba(255,255,255,0.2)", borderRadius: 10, padding: 10, fontSize: 13, marginTop: 12, color: "#fff" },
  restauranteCard: { backgroundColor: "#fff", borderRadius: 12, padding: 14, marginBottom: 12, flexDirection: "row", alignItems: "center", elevation: 2, shadowColor: "#000", shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.08, shadowRadius: 4 },
  restauranteNombre: { fontSize: 15, fontWeight: "600", color: "#333" },
  restauranteCategoria: { fontSize: 12, color: "#888", marginTop: 2 },
  restauranteInfo: { fontSize: 12, color: "#888" },
  calificacionBadge: { backgroundColor: "#EAF3DE", borderRadius: 8, padding: 6 },
  calificacionText: { fontSize: 12, color: "#2E7D32", fontWeight: "500" },
  platoCard: { backgroundColor: "#fff", borderRadius: 12, padding: 14, marginBottom: 12, flexDirection: "row", alignItems: "center", elevation: 2, shadowColor: "#000", shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.08, shadowRadius: 4 },
  btnCantidad: { width: 28, height: 28, borderRadius: 14, borderWidth: 0.5, borderColor: "#ddd", alignItems: "center", justifyContent: "center" },
  botonCarrito: { position: "absolute", bottom: 20, left: 16, right: 16, backgroundColor: "#E8821C", borderRadius: 12, padding: 16, alignItems: "center", elevation: 4 },
});