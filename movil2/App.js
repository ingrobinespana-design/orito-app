import { useState, useEffect } from 'react';
import { NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { View, Text, TextInput, TouchableOpacity, StyleSheet, SafeAreaView, ScrollView, ActivityIndicator } from 'react-native';

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
      .then((data) => setRestaurantes(data));
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
        <TextInput
          placeholder="Buscar restaurante o categoria..."
          value={busqueda}
          onChangeText={setBusqueda}
          style={styles.searchInput}
          placeholderTextColor="#rgba(255,255,255,0.7)"
        />
      </View>
      <ScrollView contentContainerStyle={{ padding: 16 }}>
        <Text style={{ fontSize: 16, fontWeight: "600", color: "#333", marginBottom: 12 }}>
          {busqueda ? `Resultados para "${busqueda}"` : "Restaurantes"}
        </Text>
        {restaurantesFiltrados.length === 0 && (
          <Text style={{ color: "#888", textAlign: "center", padding: 20 }}>No se encontraron restaurantes</Text>
        )}
        {restaurantesFiltrados.map((r) => (
          <TouchableOpacity
            key={r.id}
            style={styles.restauranteCard}
            onPress={() => navigation.navigate("Menu", { restaurante: r, usuario })}
          >
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
      <TouchableOpacity
        style={{ position: "absolute", top: 50, right: 16 }}
        onPress={() => navigation.replace("Login")}
      >
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
      .then((data) => setPlatos(data));
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
            <View style={{ flex: 1 }}>
              <Text style={{ fontSize: 15, fontWeight: "600", color: "#333" }}>{p.nombre}</Text>
              {p.descripcion ? <Text style={{ fontSize: 12, color: "#888", marginTop: 2 }}>{p.descripcion}</Text> : null}
              <Text style={{ fontSize: 15, fontWeight: "600", color: "#D85A30", marginTop: 4 }}>${p.precio.toLocaleString()}</Text>
            </View>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
              <TouchableOpacity style={styles.btnCantidad} onPress={() => quitarDelCarrito(p)}>
                <Text style={{ fontSize: 18, color: "#333" }}>-</Text>
              </TouchableOpacity>
              <Text style={{ fontSize: 15, fontWeight: "600", minWidth: 20, textAlign: "center" }}>
                {carrito.find(c => c.id === p.id)?.cantidad || 0}
              </Text>
              <TouchableOpacity style={[styles.btnCantidad, { backgroundColor: "#D85A30" }]} onPress={() => agregarAlCarrito(p)}>
                <Text style={{ fontSize: 18, color: "#fff" }}>+</Text>
              </TouchableOpacity>
            </View>
          </View>
        ))}
      </ScrollView>

      {carrito.length > 0 && (
        <TouchableOpacity
          style={styles.botonCarrito}
          onPress={() => navigation.navigate("Pedido", { carrito, restaurante, usuario })}
        >
          <Text style={{ color: "#fff", fontWeight: "bold", fontSize: 15 }}>
            Ver pedido — ${totalCarrito().toLocaleString()}
          </Text>
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
    if (!direccion) { alert("Por favor ingresa tu direccion"); return; }
    setCargando(true);
    const platosTexto = carrito.map(c => `${c.cantidad}x ${c.nombre}`).join(", ");
    fetch(`${API}/pedidos?cliente_nombre=${usuario.nombre}&cliente_direccion=${direccion}&cliente_telefono=${usuario.telefono}&restaurante_id=${restaurante.id}&plato=${encodeURIComponent(platosTexto)}&total=${total}&metodo_pago=${metodoPago}`, { method: "POST" })
      .then((res) => res.json())
      .then(() => {
        setCargando(false);
        navigation.replace("MisPedidos", { usuario });
      })
      .catch(() => { setCargando(false); alert("Error al enviar pedido"); });
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
            <Text style={{ fontSize: 15, fontWeight: "600", color: "#D85A30" }}>${total.toLocaleString()}</Text>
          </View>
        </View>

        <View style={[styles.card, { marginTop: 12 }]}>
          <Text style={{ fontWeight: "600", fontSize: 15, marginBottom: 12 }}>Direccion de entrega</Text>
          <TextInput
            placeholder="Tu direccion completa"
            value={direccion}
            onChangeText={setDireccion}
            style={styles.input}
          />
        </View>

        <View style={[styles.card, { marginTop: 12 }]}>
          <Text style={{ fontWeight: "600", fontSize: 15, marginBottom: 12 }}>Metodo de pago</Text>
          <View style={{ flexDirection: "row", gap: 8 }}>
            {["efectivo", "nequi", "bancolombia"].map((m) => (
              <TouchableOpacity
                key={m}
                style={{ flex: 1, padding: 10, borderRadius: 8, borderWidth: 1, borderColor: metodoPago === m ? "#D85A30" : "#ddd", backgroundColor: metodoPago === m ? "#FAECE7" : "#fff", alignItems: "center" }}
                onPress={() => setMetodoPago(m)}
              >
                <Text style={{ fontSize: 11, color: metodoPago === m ? "#D85A30" : "#888", fontWeight: metodoPago === m ? "600" : "400" }}>
                  {m === "efectivo" ? "Efectivo" : m === "nequi" ? "Nequi" : "Bancolombia"}
                </Text>
              </TouchableOpacity>
            ))}
          </View>

          {metodoPago === "nequi" && (
            <View style={{ backgroundColor: "#FAECE7", borderRadius: 8, padding: 10, marginTop: 10 }}>
              <Text style={{ fontSize: 12, fontWeight: "600", color: "#D85A30" }}>Transfiere por Nequi</Text>
              <Text style={{ fontSize: 12, color: "#555", marginTop: 2 }}>Numero: 3156009728</Text>
              <Text style={{ fontSize: 11, color: "#888", marginTop: 2 }}>Envia comprobante por WhatsApp</Text>
            </View>
          )}

          {metodoPago === "bancolombia" && (
            <View style={{ backgroundColor: "#E6F1FB", borderRadius: 8, padding: 10, marginTop: 10 }}>
              <Text style={{ fontSize: 12, fontWeight: "600", color: "#185FA5" }}>Transfiere por Bancolombia</Text>
              <Text style={{ fontSize: 12, color: "#555", marginTop: 2 }}>Cuenta: 07985044028</Text>
              <Text style={{ fontSize: 11, color: "#888", marginTop: 2 }}>Envia comprobante al 3156009728</Text>
            </View>
          )}

          {metodoPago === "efectivo" && (
            <View style={{ backgroundColor: "#EAF3DE", borderRadius: 8, padding: 10, marginTop: 10 }}>
              <Text style={{ fontSize: 12, fontWeight: "600", color: "#3B6D11" }}>Pago en efectivo</Text>
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
      .then((data) => setPedidos(data.filter(p => p.cliente_telefono === usuario.telefono)));
  };

  useEffect(() => {
    cargarPedidos();
    const intervalo = setInterval(cargarPedidos, 8000);
    return () => clearInterval(intervalo);
  }, []);

  const ordenEstados = ["pendiente", "aceptado", "preparando", "listo", "asignado", "en camino", "entregado"];

  const colorEstado = (estado) => {
    if (estado === "pendiente") return "#854F0B";
    if (estado === "aceptado" || estado === "preparando") return "#185FA5";
    if (estado === "listo" || estado === "entregado") return "#3B6D11";
    if (estado === "asignado" || estado === "en camino") return "#D85A30";
    return "#888";
  };

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.headerSub}>Hola, {usuario.nombre}</Text>
        <Text style={styles.headerTitle}>Mis pedidos</Text>
      </View>
      <ScrollView contentContainerStyle={{ padding: 16 }}>
        {pedidos.length === 0 && (
          <View style={{ alignItems: "center", padding: 40 }}>
            <Text style={{ fontSize: 40 }}>📋</Text>
            <Text style={{ color: "#888", marginTop: 8 }}>No tienes pedidos aun</Text>
          </View>
        )}
        {pedidos.map((p) => (
          <View key={p.id} style={styles.card}>
            <View style={{ flexDirection: "row", justifyContent: "space-between", marginBottom: 8 }}>
              <Text style={{ fontWeight: "600" }}>Pedido #{p.id}</Text>
              <Text style={{ color: colorEstado(p.estado), fontWeight: "600", fontSize: 12 }}>{p.estado.toUpperCase()}</Text>
            </View>
            <Text style={{ fontSize: 13, color: "#888" }}>{p.plato}</Text>
            <Text style={{ fontSize: 14, fontWeight: "600", color: "#D85A30", marginTop: 4 }}>${p.total.toLocaleString()}</Text>
            <View style={{ marginTop: 12 }}>
              {ordenEstados.map((estado, index) => {
                const indiceActual = ordenEstados.indexOf(p.estado);
                const completado = index <= indiceActual;
                const actual = index === indiceActual;
                const iconos = ["📋", "✅", "👨‍🍳", "📦", "🛵", "🚀", "🎉"];
                const labels = ["Recibido", "Aceptado", "Preparando", "Listo", "Asignado", "En camino", "Entregado"];
                return (
                  <View key={estado} style={{ flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 6 }}>
                    <View style={{ width: 24, height: 24, borderRadius: 12, backgroundColor: completado ? "#D85A30" : "#f0f0f0", alignItems: "center", justifyContent: "center" }}>
                      <Text style={{ fontSize: 12 }}>{completado ? iconos[index] : "○"}</Text>
                    </View>
                    <Text style={{ fontSize: 12, color: completado ? "#333" : "#bbb", fontWeight: actual ? "600" : "400" }}>{labels[index]}</Text>
                    {actual && <View style={{ backgroundColor: "#FAECE7", borderRadius: 4, paddingHorizontal: 6, paddingVertical: 2 }}>
                      <Text style={{ fontSize: 10, color: "#D85A30", fontWeight: "600" }}>Ahora</Text>
                    </View>}
                  </View>
                );
              })}
            </View>
          </View>
        ))}
      </ScrollView>
      <TouchableOpacity
        style={{ position: "absolute", bottom: 20, left: 16, right: 16, backgroundColor: "#D85A30", borderRadius: 12, padding: 14, alignItems: "center" }}
        onPress={() => navigation.replace("Inicio", { usuario })}
      >
        <Text style={{ color: "#fff", fontWeight: "bold", fontSize: 15 }}>Hacer otro pedido</Text>
      </TouchableOpacity>
    </SafeAreaView>
  );
}

function AdminScreen({ navigation, route }) {
  const { usuario } = route.params;
  return (
    <SafeAreaView style={styles.container}>
      <ScrollView contentContainerStyle={styles.scroll}>
        <View style={[styles.header, { backgroundColor: "#854F0B" }]}>
          <Text style={styles.headerSub}>Panel de</Text>
          <Text style={styles.headerTitle}>Administracion</Text>
        </View>
        <View style={styles.card}>
          <Text style={{ fontSize: 16, color: "#333", textAlign: "center", padding: 20 }}>Hola admin {usuario.nombre}</Text>
          <TouchableOpacity style={[styles.button, { backgroundColor: "#888" }]} onPress={() => navigation.replace("Login")}>
            <Text style={styles.buttonText}>Salir</Text>
          </TouchableOpacity>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

function DomiciliarioScreen({ navigation, route }) {
  const { usuario } = route.params;
  return (
    <SafeAreaView style={styles.container}>
      <ScrollView contentContainerStyle={styles.scroll}>
        <View style={[styles.header, { backgroundColor: "#185FA5" }]}>
          <Text style={styles.headerSub}>Panel de</Text>
          <Text style={styles.headerTitle}>Domiciliario</Text>
        </View>
        <View style={styles.card}>
          <Text style={{ fontSize: 16, color: "#333", textAlign: "center", padding: 20 }}>Hola {usuario.nombre}</Text>
          <TouchableOpacity style={[styles.button, { backgroundColor: "#888" }]} onPress={() => navigation.replace("Login")}>
            <Text style={styles.buttonText}>Salir</Text>
          </TouchableOpacity>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

function RestauranteScreen({ navigation, route }) {
  const { usuario } = route.params;
  return (
    <SafeAreaView style={styles.container}>
      <ScrollView contentContainerStyle={styles.scroll}>
        <View style={[styles.header, { backgroundColor: "#3B6D11" }]}>
          <Text style={styles.headerSub}>Panel de</Text>
          <Text style={styles.headerTitle}>Mi Restaurante</Text>
        </View>
        <View style={styles.card}>
          <Text style={{ fontSize: 16, color: "#333", textAlign: "center", padding: 20 }}>Hola {usuario.nombre}</Text>
          <TouchableOpacity style={[styles.button, { backgroundColor: "#888" }]} onPress={() => navigation.replace("Login")}>
            <Text style={styles.buttonText}>Salir</Text>
          </TouchableOpacity>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

export default function App() {
  return (
    <NavigationContainer>
      <Stack.Navigator initialRouteName="Login" screenOptions={{ headerShown: false }}>
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
  container: { flex: 1, backgroundColor: "#f5f5f5" },
  scroll: { padding: 16 },
  header: { backgroundColor: "#D85A30", padding: 20, paddingTop: 50 },
  headerSub: { color: "rgba(255,255,255,0.8)", fontSize: 12 },
  headerTitle: { color: "#fff", fontSize: 24, fontWeight: "bold", marginTop: 4 },
  card: { backgroundColor: "#fff", borderRadius: 16, padding: 16, shadowColor: "#000", shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.1, shadowRadius: 8, elevation: 4 },
  tabs: { flexDirection: "row", backgroundColor: "#f5f5f5", borderRadius: 8, padding: 4, marginBottom: 20 },
  tab: { flex: 1, padding: 8, borderRadius: 6, alignItems: "center" },
  tabActive: { backgroundColor: "#fff" },
  tabText: { color: "#888", fontSize: 14 },
  tabTextActive: { color: "#333", fontWeight: "500" },
  input: { borderWidth: 0.5, borderColor: "#ddd", borderRadius: 8, padding: 12, marginBottom: 12, fontSize: 14, backgroundColor: "#fff" },
  error: { color: "red", fontSize: 12, marginBottom: 12 },
  button: { backgroundColor: "#D85A30", borderRadius: 8, padding: 14, alignItems: "center" },
  buttonText: { color: "#fff", fontWeight: "bold", fontSize: 16 },
  searchInput: { backgroundColor: "rgba(255,255,255,0.2)", borderRadius: 10, padding: 10, fontSize: 13, marginTop: 12, color: "#fff" },
  restauranteCard: { backgroundColor: "#fff", borderRadius: 12, padding: 14, marginBottom: 12, flexDirection: "row", alignItems: "center", elevation: 2, shadowColor: "#000", shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.08, shadowRadius: 4 },
  restauranteNombre: { fontSize: 15, fontWeight: "600", color: "#333" },
  restauranteCategoria: { fontSize: 12, color: "#888", marginTop: 2 },
  restauranteInfo: { fontSize: 12, color: "#888" },
  calificacionBadge: { backgroundColor: "#EAF3DE", borderRadius: 8, padding: 6 },
  calificacionText: { fontSize: 12, color: "#3B6D11", fontWeight: "500" },
  platoCard: { backgroundColor: "#fff", borderRadius: 12, padding: 14, marginBottom: 12, flexDirection: "row", alignItems: "center", elevation: 2, shadowColor: "#000", shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.08, shadowRadius: 4 },
  btnCantidad: { width: 28, height: 28, borderRadius: 14, borderWidth: 0.5, borderColor: "#ddd", alignItems: "center", justifyContent: "center" },
  botonCarrito: { position: "absolute", bottom: 20, left: 16, right: 16, backgroundColor: "#D85A30", borderRadius: 12, padding: 16, alignItems: "center", elevation: 4 },
});