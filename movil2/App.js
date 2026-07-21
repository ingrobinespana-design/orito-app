import { useState, useEffect, useRef } from 'react';
import { NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { View, Text, TextInput, TouchableOpacity, StyleSheet, SafeAreaView, ScrollView, ActivityIndicator, Image, Alert, Platform, Modal } from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import * as Notifications from 'expo-notifications';
import * as Device from 'expo-device';
import Constants from 'expo-constants';
import * as Location from 'expo-location';
import { WebView } from 'react-native-webview';

// Produccion por defecto. Para probar contra un servidor local se arranca con
// EXPO_PUBLIC_API_URL=http://localhost:8000 y asi nunca queda un localhost publicado.
const API = process.env.EXPO_PUBLIC_API_URL || "https://orito-app-production.up.railway.app";
const Stack = createNativeStackNavigator();

// Que la notificacion se vea y suene aunque la app este abierta
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

/** Confirmacion que funciona en celular Y en navegador.
 *  Alert.alert muestra los botones en el celular, pero en web los ignora
 *  (el dialogo aparece y no pasa nada al tocar), asi que ahi va window.confirm. */
function confirmar(titulo, mensaje, alAceptar, textoAceptar = "Confirmar") {
  if (Platform.OS === "web") {
    if (window.confirm(`${titulo}\n\n${mensaje}`)) alAceptar();
    return;
  }
  Alert.alert(titulo, mensaje, [
    { text: "Cancelar", style: "cancel" },
    { text: textoAceptar, onPress: alAceptar },
  ]);
}

/** Lo mismo pero eligiendo entre varias opciones. */
function elegir(titulo, mensaje, opciones) {
  if (Platform.OS === "web") {
    const lista = opciones.map((o, i) => `${i + 1}. ${o.texto}`).join("\n");
    const r = window.prompt(`${titulo}\n${mensaje}\n\n${lista}\n\nEscribe el numero:`);
    const i = parseInt(r, 10) - 1;
    if (opciones[i]) opciones[i].alElegir();
    return;
  }
  Alert.alert(titulo, mensaje, [
    { text: "Cancelar", style: "cancel" },
    ...opciones.map(o => ({ text: o.texto, onPress: o.alElegir })),
  ]);
}

/** Aviso simple. En web, Alert.alert sin botones si funciona, pero unificamos. */
function avisar(titulo, mensaje) {
  if (Platform.OS === "web") { window.alert(`${titulo}\n\n${mensaje}`); return; }
  Alert.alert(titulo, mensaje);
}

/** Pide permiso, saca el token de Expo y lo guarda en el servidor.
 *  Si algo falla no se avisa al usuario: la app funciona igual, solo que
 *  tocara mirar la pantalla en vez de esperar el sonido. */
async function registrarNotificaciones(usuarioId) {
  try {
    if (Platform.OS === "android") {
      // El canal define que suene fuerte y salte en pantalla. Sin esto Android
      // la trata como aviso silencioso y el conductor no se entera.
      await Notifications.setNotificationChannelAsync("carreras", {
        name: "Carreras",
        importance: Notifications.AndroidImportance.MAX,
        vibrationPattern: [0, 250, 250, 250],
        sound: "default",
        lockscreenVisibility: Notifications.AndroidNotificationVisibility.PUBLIC,
      });
    }
    if (!Device.isDevice) return;   // no funciona en emulador

    const permiso = await Notifications.getPermissionsAsync();
    let estado = permiso.status;
    if (estado !== "granted") {
      estado = (await Notifications.requestPermissionsAsync()).status;
    }
    if (estado !== "granted") return;

    const projectId =
      Constants?.expoConfig?.extra?.eas?.projectId ??
      Constants?.easConfig?.projectId;
    if (!projectId) return;

    const { data: token } = await Notifications.getExpoPushTokenAsync({ projectId });
    if (!token) return;

    await fetch(`${API}/usuarios/${usuarioId}/push-token?token=${encodeURIComponent(token)}`, { method: "PUT" });
  } catch (e) {
    console.log("No se pudieron activar las notificaciones:", e);
  }
}

function LoginScreen({ navigation }) {
  const [modo, setModo] = useState("login");
  const [form, setForm] = useState({ nombre: "", telefono: "", password: "", municipio: "Orito", comoMe: "cliente", placa: "" });
  const [municipios, setMunicipios] = useState([{ nombre: "Orito", vehiculos: ["carro"] }]);

  useEffect(() => {
    fetch(`${API}/municipios`).then(r => r.json())
      .then(d => { if (Array.isArray(d) && d.length) setMunicipios(d); }).catch(() => {});
  }, []);

  // en Orito no hay mototaxi: la opcion de moto ni siquiera se muestra alla
  const vehiculosAqui = (municipios.find(m => m.nombre === form.municipio) || {}).vehiculos || ["carro"];
  const [error, setError] = useState("");
  const [cargando, setCargando] = useState(false);

  const handleSubmit = () => {
    setCargando(true);
    setError("");
    const url = modo === "login"
      ? `${API}/login?telefono=${form.telefono}&password=${form.password}`
      : `${API}/registro?nombre=${form.nombre}&telefono=${form.telefono}&password=${form.password}`
        + `&municipio=${encodeURIComponent(form.municipio)}`
        + (form.comoMe === "cliente" ? "" :
           `&tipo_vehiculo=${form.comoMe}&placa=${encodeURIComponent(form.placa)}`);
    fetch(url, { method: "POST" })
      .then((res) => res.json())
      .then((data) => {
        setCargando(false);
        if (data.detail) { setError(data.detail); return; }
        registrarNotificaciones(data.id);
        if (data.rol === "admin") navigation.replace("Admin", { usuario: data });
        else if (data.rol === "domiciliario") navigation.replace("Domiciliario", { usuario: data });
        else if (data.rol === "restaurante") navigation.replace("Restaurante", { usuario: data });
        else if (data.rol === "conductor") navigation.replace("Conductor", { usuario: data });
        else navigation.replace("ElegirServicio", { usuario: data });
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
            <>
              <TextInput placeholder="Tu nombre" value={form.nombre} onChangeText={(t) => setForm({ ...form, nombre: t })} style={styles.input} />
              <Text style={styles.etiqueta}>TU MUNICIPIO</Text>
              <View style={{ flexDirection: "row", gap: 8, marginBottom: 12 }}>
                {municipios.map(m => (
                  <TouchableOpacity
                    key={m.nombre}
                    style={[styles.opcion, form.municipio === m.nombre && styles.opcionActiva]}
                    onPress={() => {
                      // si venia con moto elegida y en el nuevo pueblo no hay, se limpia
                      const permite = (m.vehiculos || []).includes(form.comoMe);
                      setForm({ ...form, municipio: m.nombre, comoMe: permite ? form.comoMe : "cliente" });
                    }}
                  >
                    <Text style={[styles.opcionTexto, form.municipio === m.nombre && styles.opcionTextoActivo]}>{m.nombre}</Text>
                  </TouchableOpacity>
                ))}
              </View>

              <Text style={styles.etiqueta}>COMO TE REGISTRAS</Text>
              <View style={{ flexDirection: "row", gap: 8, marginBottom: 12 }}>
                {[["cliente", "Cliente"], ["moto", "🏍️ Moto"], ["carro", "🚗 Carro"]]
                  .filter(([v]) => v === "cliente" || vehiculosAqui.includes(v))
                  .map(([v, txt]) => (
                  <TouchableOpacity
                    key={v}
                    style={[styles.opcion, form.comoMe === v && styles.opcionActiva]}
                    onPress={() => setForm({ ...form, comoMe: v })}
                  >
                    <Text style={[styles.opcionTexto, form.comoMe === v && styles.opcionTextoActivo]}>{txt}</Text>
                  </TouchableOpacity>
                ))}
              </View>
              {form.comoMe !== "cliente" && (
                <>
                  <TextInput
                    placeholder="Placa de tu vehiculo"
                    value={form.placa}
                    onChangeText={(t) => setForm({ ...form, placa: t.toUpperCase() })}
                    style={styles.input}
                    autoCapitalize="characters"
                  />
                  <Text style={styles.ayuda}>El cliente ve tu placa para reconocerte</Text>
                </>
              )}
            </>
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
        <TouchableOpacity
          style={{ backgroundColor: "rgba(255,255,255,0.15)", borderRadius: 10, padding: 12, marginTop: 14, flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}
          onPress={() => navigation.navigate("AdminCarreras")}
        >
          <Text style={{ color: "#fff", fontWeight: "600" }}>🚕  Carreras y cobros</Text>
          <Text style={{ color: "rgba(255,255,255,0.7)" }}>›</Text>
        </TouchableOpacity>
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

// ============================================================ CARRERAS
// Seccion de transporte. Comparte el login con domicilios, todo lo demas es aparte.

function ElegirServicioScreen({ navigation, route }) {
  const { usuario } = route.params;
  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.headerSub}>Hola, {usuario.nombre}</Text>
        <Text style={styles.headerTitle}>Que necesitas hoy?</Text>
      </View>
      <ScrollView contentContainerStyle={{ padding: 16 }}>
        <TouchableOpacity style={styles.servicioCard} onPress={() => navigation.navigate("Inicio", { usuario })}>
          <Text style={{ fontSize: 44 }}>🍽️</Text>
          <Text style={styles.servicioTitulo}>Pedir comida</Text>
          <Text style={styles.servicioSub}>Restaurantes de Orito a domicilio</Text>
        </TouchableOpacity>
        <TouchableOpacity style={[styles.servicioCard, { backgroundColor: "#E6F1FB" }]} onPress={() => navigation.navigate("PedirCarrera", { usuario })}>
          <Text style={{ fontSize: 44 }}>🚕</Text>
          <Text style={[styles.servicioTitulo, { color: "#185FA5" }]}>Pedir carrera</Text>
          <Text style={styles.servicioSub}>Un transportador te recoge</Text>
        </TouchableOpacity>
      </ScrollView>
      <TouchableOpacity style={{ padding: 16, alignItems: "center" }} onPress={() => navigation.replace("Login")}>
        <Text style={{ color: "#888", fontSize: 13 }}>Salir</Text>
      </TouchableOpacity>
    </SafeAreaView>
  );
}

/** Campo de origen/destino: se puede escribir libre (nomenclatura, negocio, lo que sea)
 *  y va sugiriendo lo que otros ya han usado. */
function CampoLugar({ etiqueta, valor, onChange, placeholder }) {
  const [sugerencias, setSugerencias] = useState([]);
  const [mostrar, setMostrar] = useState(false);

  const buscar = (texto) => {
    onChange(texto);
    if (texto.trim().length < 2) { setSugerencias([]); return; }
    fetch(`${API}/lugares?buscar=${encodeURIComponent(texto.trim())}`)
      .then(r => r.json())
      .then(d => { if (Array.isArray(d)) setSugerencias(d); })
      .catch(() => setSugerencias([]));
  };

  const verTodos = () => {
    setMostrar(true);
    fetch(`${API}/lugares`).then(r => r.json())
      .then(d => { if (Array.isArray(d)) setSugerencias(d); })
      .catch(() => {});
  };

  return (
    <View style={{ marginBottom: 4 }}>
      <Text style={styles.etiqueta}>{etiqueta}</Text>
      <TextInput
        value={valor}
        onChangeText={buscar}
        onFocus={verTodos}
        placeholder={placeholder}
        style={styles.input}
      />
      {mostrar && sugerencias.length > 0 && (
        <View style={styles.sugerencias}>
          {sugerencias.slice(0, 6).map((l) => (
            <TouchableOpacity
              key={l.id}
              style={styles.sugerenciaItem}
              onPress={() => { onChange(l.nombre); setSugerencias([]); setMostrar(false); }}
            >
              <Text style={{ fontSize: 13, color: "#333" }}>
                {l.zona === "rural" ? "🌄 " : "📍 "}{l.nombre}
              </Text>
            </TouchableOpacity>
          ))}
        </View>
      )}
    </View>
  );
}

/** Mapa con OpenStreetMap (gratis, sin clave de Google) dentro de un WebView.
 *  Patron tipo Uber: el pin queda fijo en el centro y el mapa se mueve debajo,
 *  asi ubicar es facil con el dedo. Devuelve {lat, lon} del centro. */
function mapaHTML(lat, lon) {
  return `<!DOCTYPE html><html><head>
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"/>
<style>
  html,body,#map{height:100%;margin:0;padding:0}
  #pin{position:absolute;top:50%;left:50%;transform:translate(-50%,-100%);z-index:1000;font-size:40px;pointer-events:none}
</style></head><body>
<div id="map"></div><div id="pin">📍</div>
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
<script>
  var map = L.map('map',{zoomControl:false}).setView([${lat}, ${lon}], 16);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{maxZoom:19}).addTo(map);
  function enviar(){
    var c = map.getCenter();
    if(window.ReactNativeWebView) window.ReactNativeWebView.postMessage(JSON.stringify({lat:c.lat, lon:c.lng}));
  }
  map.on('moveend', enviar); enviar();
  function irA(la, lo){ map.setView([la, lo], 16); }
</script></body></html>`;
}

function MapaSelector({ visible, titulo, centro, onConfirmar, onCerrar }) {
  const webRef = useRef(null);
  const inicial = centro && centro.lat ? centro : { lat: 0.5083, lon: -76.4972 };
  const [coords, setCoords] = useState(inicial);
  const [buscando, setBuscando] = useState(false);

  const usarMiUbicacion = async () => {
    try {
      setBuscando(true);
      const permiso = await Location.requestForegroundPermissionsAsync();
      if (permiso.status !== "granted") { setBuscando(false); avisar("Permiso", "Necesitamos tu ubicacion para el mapa"); return; }
      const pos = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High });
      const { latitude, longitude } = pos.coords;
      setCoords({ lat: latitude, lon: longitude });
      webRef.current && webRef.current.injectJavaScript(`irA(${latitude}, ${longitude}); true;`);
    } catch (e) {
      avisar("Error", "No se pudo obtener tu ubicacion. Movete en el mapa para marcar el punto.");
    } finally { setBuscando(false); }
  };

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onCerrar}>
      <SafeAreaView style={{ flex: 1, backgroundColor: "#fff" }}>
        <View style={{ padding: 14, flexDirection: "row", alignItems: "center", gap: 12, borderBottomWidth: 0.5, borderBottomColor: "#eee" }}>
          <TouchableOpacity onPress={onCerrar}><Text style={{ fontSize: 22 }}>←</Text></TouchableOpacity>
          <Text style={{ fontSize: 16, fontWeight: "600", color: "#333" }}>{titulo}</Text>
        </View>
        <View style={{ flex: 1 }}>
          <WebView
            ref={webRef}
            originWhitelist={["*"]}
            source={{ html: mapaHTML(inicial.lat, inicial.lon) }}
            onMessage={(e) => { try { setCoords(JSON.parse(e.nativeEvent.data)); } catch (_) {} }}
            style={{ flex: 1 }}
          />
          <Text style={{ textAlign: "center", fontSize: 12, color: "#888", paddingVertical: 6 }}>
            Mueve el mapa hasta que el pin quede en el punto exacto
          </Text>
        </View>
        <View style={{ padding: 16, gap: 10 }}>
          <TouchableOpacity style={[styles.button, { backgroundColor: "#fff", borderWidth: 1, borderColor: "#ddd" }]} onPress={usarMiUbicacion} disabled={buscando}>
            {buscando ? <ActivityIndicator color="#185FA5" /> : <Text style={{ color: "#185FA5", fontWeight: "600" }}>📍 Usar mi ubicacion</Text>}
          </TouchableOpacity>
          <TouchableOpacity style={[styles.button, { backgroundColor: "#185FA5" }]} onPress={() => onConfirmar(coords)}>
            <Text style={styles.buttonText}>Confirmar este punto</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    </Modal>
  );
}

function PedirCarreraScreen({ navigation, route }) {
  const { usuario } = route.params;
  const [carrera, setCarrera] = useState(null);
  const [form, setForm] = useState({ origen: "", origen_detalle: "", destino: "", destino_detalle: "", notas: "" });
  const [vehiculo, setVehiculo] = useState(null);   // sin defecto: el cliente elige
  const [vehiculosAqui, setVehiculosAqui] = useState(["carro"]);
  const [muni, setMuni] = useState(null);           // datos del municipio (gps, tarifas, centro)
  const [origenCoords, setOrigenCoords] = useState(null);
  const [destinoCoords, setDestinoCoords] = useState(null);
  const [estimado, setEstimado] = useState(null);   // {distancia_km, tarifa_sugerida}
  const [mapaAbierto, setMapaAbierto] = useState(null); // "origen" | "destino" | null
  const [cargando, setCargando] = useState(false);

  useEffect(() => {
    fetch(`${API}/municipios`).then(r => r.json()).then(d => {
      if (!Array.isArray(d)) return;
      const mio = d.find(m => m.nombre === (usuario.municipio || "Orito"));
      if (!mio) return;
      setMuni(mio);
      const vs = mio.vehiculos || ["carro"];
      setVehiculosAqui(vs);
      if (vs.length === 1) setVehiculo(vs[0]);   // si solo hay carro, no hay nada que elegir
    }).catch(() => {});
  }, []);

  // cuando hay origen y destino en el mapa, estima distancia y tarifa
  useEffect(() => {
    if (!muni || !muni.usa_gps || !origenCoords || !destinoCoords) { setEstimado(null); return; }
    const p = new URLSearchParams({
      municipio: muni.nombre,
      origen_lat: origenCoords.lat, origen_lon: origenCoords.lon,
      destino_lat: destinoCoords.lat, destino_lon: destinoCoords.lon,
    });
    fetch(`${API}/tarifa?${p.toString()}`).then(r => r.json())
      .then(d => { if (d && !d.detail) setEstimado(d); }).catch(() => {});
  }, [origenCoords, destinoCoords, muni]);

  const centroMapa = (punto) => {
    if (punto === "origen" && origenCoords) return origenCoords;
    if (punto === "destino" && destinoCoords) return destinoCoords;
    return muni && muni.centro_lat ? { lat: muni.centro_lat, lon: muni.centro_lon } : null;
  };

  const confirmarPunto = (coords) => {
    if (mapaAbierto === "origen") setOrigenCoords(coords);
    else if (mapaAbierto === "destino") setDestinoCoords(coords);
    setMapaAbierto(null);
  };

  const cargarActiva = () => {
    fetch(`${API}/carreras/cliente/${usuario.id}`)
      .then(r => r.json())
      .then(d => {
        if (!Array.isArray(d)) return;
        setCarrera(d.find(c => ["buscando", "aceptada", "en_camino"].includes(c.estado)) || null);
      })
      .catch(() => {});
  };

  useEffect(() => {
    cargarActiva();
    const intervalo = setInterval(cargarActiva, 6000);
    const aviso = Notifications.addNotificationReceivedListener(cargarActiva);
    const toque = Notifications.addNotificationResponseReceivedListener(cargarActiva);
    return () => { clearInterval(intervalo); aviso.remove(); toque.remove(); };
  }, []);

  const pedir = () => {
    if (!form.origen.trim()) { avisar("Falta el origen", "Dinos donde estas"); return; }
    if (!form.destino.trim()) { avisar("Falta el destino", "Dinos para donde vas"); return; }
    if (!form.origen_detalle.trim()) {
      avisar("Falta la referencia", "Escribe exactamente donde estas para que el conductor te encuentre. Ej: casa de dos pisos, porton azul, al frente de la cancha");
      return;
    }
    if (!vehiculo) { avisar("Falta el vehiculo", "Elige si quieres ir en moto o en carro"); return; }
    if (muni && muni.usa_gps && (!origenCoords || !destinoCoords)) {
      avisar("Falta ubicar en el mapa", "Marca en el mapa de donde a donde vas para calcular la tarifa"); return;
    }
    setCargando(true);
    const datos = {
      cliente_id: usuario.id, origen: form.origen.trim(), destino: form.destino.trim(),
      origen_detalle: form.origen_detalle.trim(), destino_detalle: form.destino_detalle.trim(),
      notas: form.notas.trim(), vehiculo_pedido: vehiculo,
    };
    if (origenCoords) { datos.origen_lat = origenCoords.lat; datos.origen_lon = origenCoords.lon; }
    if (destinoCoords) { datos.destino_lat = destinoCoords.lat; datos.destino_lon = destinoCoords.lon; }
    const p = new URLSearchParams(datos);
    fetch(`${API}/carreras?${p.toString()}`, { method: "POST" })
      .then(r => r.json())
      .then(d => {
        setCargando(false);
        if (d.detail) { avisar("No se pudo pedir", d.detail); return; }
        setForm({ origen: "", origen_detalle: "", destino: "", destino_detalle: "", notas: "" });
        setOrigenCoords(null); setDestinoCoords(null); setEstimado(null);
        setCarrera(d);
      })
      .catch(() => { setCargando(false); avisar("Error", "No hay conexion. Intenta de nuevo."); });
  };

  const cancelar = () => {
    confirmar("Cancelar carrera", "Seguro que quieres cancelar?",
      () => fetch(`${API}/carreras/${carrera.id}/estado?estado=cancelada`, { method: "PUT" })
        .then(() => setCarrera(null))
        .catch(() => avisar("Error", "No se pudo cancelar")),
      "Si, cancelar");
  };

  // --- ya tiene una carrera en curso: se le hace seguimiento
  if (carrera) {
    const buscando = carrera.estado === "buscando";
    return (
      <SafeAreaView style={styles.container}>
        <View style={[styles.header, { backgroundColor: "#185FA5" }]}>
          <Text style={styles.headerSub}>Carrera #{carrera.id}</Text>
          <Text style={styles.headerTitle}>{buscando ? "Buscando transportador..." : "Ya tienes conductor"}</Text>
        </View>
        <ScrollView contentContainerStyle={{ padding: 16 }}>
          {buscando ? (
            <View style={[styles.card, { alignItems: "center", paddingVertical: 30 }]}>
              <ActivityIndicator size="large" color="#185FA5" />
              <Text style={{ color: "#888", marginTop: 12, textAlign: "center" }}>
                Avisamos a los transportadores disponibles.{"\n"}No cierres la app.
              </Text>
            </View>
          ) : (
            <View style={[styles.card, { marginBottom: 12 }]}>
              <Text style={{ fontSize: 12, color: "#888" }}>Tu transportador</Text>
              <Text style={{ fontSize: 20, fontWeight: "bold", color: "#333", marginTop: 2 }}>{carrera.conductor_nombre}</Text>
              {carrera.conductor_vehiculo ? <Text style={{ fontSize: 14, color: "#555", marginTop: 4 }}>🚕 {carrera.conductor_vehiculo}</Text> : null}
              {carrera.conductor_placa ? (
                <View style={styles.placaBadge}><Text style={styles.placaTexto}>{carrera.conductor_placa}</Text></View>
              ) : null}
              <Text style={{ fontSize: 17, fontWeight: "600", color: "#185FA5", marginTop: 10 }}>📞 {carrera.conductor_telefono}</Text>
              <Text style={{ fontSize: 12, color: "#888", marginTop: 4 }}>Llamalo si necesitas explicarle mejor donde estas</Text>
            </View>
          )}

          <View style={styles.card}>
            <Text style={styles.etiqueta}>DESDE</Text>
            <Text style={{ fontSize: 15, fontWeight: "600", color: "#333" }}>{carrera.origen}</Text>
            {carrera.origen_detalle ? <Text style={{ fontSize: 13, color: "#888", marginTop: 2 }}>{carrera.origen_detalle}</Text> : null}
            <View style={{ height: 1, backgroundColor: "#eee", marginVertical: 12 }} />
            <Text style={styles.etiqueta}>HASTA</Text>
            <Text style={{ fontSize: 15, fontWeight: "600", color: "#333" }}>{carrera.destino}</Text>
            {carrera.destino_detalle ? <Text style={{ fontSize: 13, color: "#888", marginTop: 2 }}>{carrera.destino_detalle}</Text> : null}
            {carrera.zona === "rural" && (
              <View style={styles.avisoRural}><Text style={styles.avisoRuralTexto}>🌄 Carrera fuera del casco urbano</Text></View>
            )}
          </View>

          <TouchableOpacity style={[styles.button, { backgroundColor: "#fff", borderWidth: 1, borderColor: "#ddd", marginTop: 16 }]} onPress={cancelar}>
            <Text style={{ color: "#C0392B", fontWeight: "600" }}>Cancelar carrera</Text>
          </TouchableOpacity>
        </ScrollView>
      </SafeAreaView>
    );
  }

  // --- formulario para pedir
  return (
    <SafeAreaView style={styles.container}>
      <View style={[styles.header, { backgroundColor: "#185FA5", flexDirection: "row", alignItems: "center", gap: 12 }]}>
        <TouchableOpacity onPress={() => navigation.goBack()}>
          <Text style={{ color: "#fff", fontSize: 20 }}>←</Text>
        </TouchableOpacity>
        <View>
          <Text style={styles.headerSub}>Transporte en Orito</Text>
          <Text style={styles.headerTitle}>Pedir carrera</Text>
        </View>
      </View>
      <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 60 }} keyboardShouldPersistTaps="handled">
        <View style={styles.card}>
          <CampoLugar
            etiqueta="DONDE ESTAS"
            valor={form.origen}
            onChange={(t) => setForm({ ...form, origen: t })}
            placeholder="Ej: Parque Central o Carrera 5a # 4-20"
          />
          <TextInput
            value={form.origen_detalle}
            onChangeText={(t) => setForm({ ...form, origen_detalle: t })}
            placeholder="Exactamente donde: casa de dos pisos, porton azul..."
            style={styles.input}
            multiline
          />
          <Text style={styles.ayuda}>Entre mas claro, mas rapido te encuentra el conductor</Text>

          <View style={{ height: 1, backgroundColor: "#eee", marginVertical: 14 }} />

          <CampoLugar
            etiqueta="PARA DONDE VAS"
            valor={form.destino}
            onChange={(t) => setForm({ ...form, destino: t })}
            placeholder="Ej: ESE Hospital Orito o Vereda Monserrate"
          />
          <TextInput
            value={form.destino_detalle}
            onChangeText={(t) => setForm({ ...form, destino_detalle: t })}
            placeholder="Referencia del destino (opcional)"
            style={styles.input}
            multiline
          />

          <TextInput
            value={form.notas}
            onChangeText={(t) => setForm({ ...form, notas: t })}
            placeholder="Algo mas que deba saber? (opcional)"
            style={styles.input}
          />

          {vehiculosAqui.length > 1 && (
            <>
              <Text style={styles.etiqueta}>EN QUE QUIERES IR</Text>
              <View style={{ flexDirection: "row", gap: 8 }}>
                {[["moto", "🏍️ Moto"], ["carro", "🚗 Carro"]]
                  .filter(([v]) => vehiculosAqui.includes(v))
                  .map(([v, txt]) => (
                  <TouchableOpacity
                    key={v}
                    style={[styles.opcion, vehiculo === v && styles.opcionActiva]}
                    onPress={() => setVehiculo(v)}
                  >
                    <Text style={[styles.opcionTexto, vehiculo === v && styles.opcionTextoActivo]}>{txt}</Text>
                  </TouchableOpacity>
                ))}
              </View>
            </>
          )}

          {muni && muni.usa_gps && (
            <>
              <View style={{ height: 1, backgroundColor: "#eee", marginVertical: 14 }} />
              <Text style={styles.etiqueta}>UBICACION EN EL MAPA</Text>
              <TouchableOpacity style={[styles.botonMapa, origenCoords && styles.botonMapaOk]} onPress={() => setMapaAbierto("origen")}>
                <Text style={{ color: origenCoords ? "#2E7D32" : "#185FA5", fontWeight: "600" }}>
                  {origenCoords ? "✓ Origen marcado" : "📍 Marcar de donde sales"}
                </Text>
              </TouchableOpacity>
              <TouchableOpacity style={[styles.botonMapa, destinoCoords && styles.botonMapaOk]} onPress={() => setMapaAbierto("destino")}>
                <Text style={{ color: destinoCoords ? "#2E7D32" : "#185FA5", fontWeight: "600" }}>
                  {destinoCoords ? "✓ Destino marcado" : "🏁 Marcar a donde vas"}
                </Text>
              </TouchableOpacity>

              {estimado && estimado.distancia_km && (
                <View style={styles.estimado}>
                  <Text style={{ fontSize: 13, color: "#555" }}>Distancia: {estimado.distancia_km} km</Text>
                  {estimado.tarifa_sugerida ? (
                    <>
                      <Text style={{ fontSize: 22, fontWeight: "bold", color: "#185FA5", marginTop: 2 }}>
                        aprox ${estimado.tarifa_sugerida.toLocaleString()}
                      </Text>
                      <Text style={{ fontSize: 11, color: "#888" }}>Es una sugerencia, el precio lo acuerdas con el conductor</Text>
                    </>
                  ) : null}
                </View>
              )}
            </>
          )}
        </View>

        <TouchableOpacity style={[styles.button, { backgroundColor: "#185FA5", marginTop: 16 }]} onPress={pedir} disabled={cargando}>
          {cargando ? <ActivityIndicator color="#fff" /> : <Text style={styles.buttonText}>Pedir carrera</Text>}
        </TouchableOpacity>
      </ScrollView>

      <MapaSelector
        visible={!!mapaAbierto}
        titulo={mapaAbierto === "origen" ? "De donde sales" : "A donde vas"}
        centro={centroMapa(mapaAbierto)}
        onConfirmar={confirmarPunto}
        onCerrar={() => setMapaAbierto(null)}
      />
    </SafeAreaView>
  );
}

function ConductorScreen({ navigation, route }) {
  const { usuario } = route.params;
  const [disponibles, setDisponibles] = useState([]);
  const [mias, setMias] = useState([]);
  const [disponible, setDisponible] = useState(usuario.disponible === "si");
  const [cuenta, setCuenta] = useState(null);

  const cargar = () => {
    // con conductor_id el servidor filtra por municipio y tipo de vehiculo
    fetch(`${API}/carreras/disponibles?conductor_id=${usuario.id}`).then(r => r.json())
      .then(d => { if (Array.isArray(d)) setDisponibles(d); }).catch(() => {});
    fetch(`${API}/carreras/conductor/${usuario.id}`).then(r => r.json())
      .then(d => { if (Array.isArray(d)) setMias(d.filter(c => ["aceptada", "en_camino"].includes(c.estado))); })
      .catch(() => {});
    fetch(`${API}/conductores/${usuario.id}/estado-cuenta`).then(r => r.json())
      .then(d => { if (d && !d.detail) setCuenta(d); }).catch(() => {});
  };

  useEffect(() => {
    cargar();
    // el sondeo es el respaldo: si la notificacion no llega (sin señal, permiso
    // negado), igual aparece la carrera al refrescar
    const intervalo = setInterval(cargar, 8000);
    const aviso = Notifications.addNotificationReceivedListener(cargar);
    const toque = Notifications.addNotificationResponseReceivedListener(cargar);
    return () => { clearInterval(intervalo); aviso.remove(); toque.remove(); };
  }, []);

  const cambiarDisponibilidad = () => {
    const nuevo = !disponible;
    setDisponible(nuevo);
    fetch(`${API}/conductores/${usuario.id}?disponible=${nuevo ? "si" : "no"}`, { method: "PUT" }).catch(() => {});
  };

  const aceptar = (c) => {
    fetch(`${API}/carreras/${c.id}/aceptar?conductor_id=${usuario.id}`, { method: "PUT" })
      .then(async (r) => {
        const d = await r.json();
        if (r.status === 409) { avisar("Muy tarde", "Otro transportador ya tomo esa carrera."); cargar(); return; }
        if (r.status === 402) { avisar("Suscripcion vencida", d.detail); cargar(); return; }
        if (d.detail) { avisar("No se pudo", d.detail); return; }
        cargar();
      })
      .catch(() => avisar("Error", "No hay conexion. Intenta de nuevo."));
  };

  // Alert.prompt solo existe en iPhone, asi que la ventana del cobro es propia
  const [cobrando, setCobrando] = useState(null);
  const [tarifa, setTarifa] = useState("");

  const finalizar = (c) => { setTarifa(""); setCobrando(c); };

  const confirmarCobro = () => {
    const t = parseInt((tarifa || "").replace(/\D/g, ""), 10);
    const id = cobrando.id;
    setCobrando(null);
    fetch(`${API}/carreras/${id}/estado?estado=finalizada${t ? `&tarifa=${t}` : ""}`, { method: "PUT" })
      .then(cargar)
      .catch(() => avisar("Error", "No hay conexion. Intenta de nuevo."));
  };

  const cambiarEstado = (c, estado) => {
    fetch(`${API}/carreras/${c.id}/estado?estado=${estado}`, { method: "PUT" }).then(cargar).catch(() => {});
  };

  const tarjeta = (c, propia) => (
    <View key={c.id} style={[styles.card, { marginBottom: 12 }]}>
      <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
        <Text style={{ fontWeight: "600" }}>Carrera #{c.id}</Text>
        {c.zona === "rural" && (
          <View style={styles.avisoRural}><Text style={styles.avisoRuralTexto}>🌄 Fuera del pueblo</Text></View>
        )}
      </View>

      <Text style={styles.etiqueta}>RECOGER EN</Text>
      <Text style={{ fontSize: 15, fontWeight: "600", color: "#333" }}>{c.origen}</Text>
      {c.origen_detalle ? <Text style={{ fontSize: 13, color: "#555", marginTop: 2 }}>📍 {c.origen_detalle}</Text> : null}

      <View style={{ height: 1, backgroundColor: "#eee", marginVertical: 10 }} />

      <Text style={styles.etiqueta}>LLEVAR A</Text>
      <Text style={{ fontSize: 15, fontWeight: "600", color: "#333" }}>{c.destino}</Text>
      {c.destino_detalle ? <Text style={{ fontSize: 13, color: "#555", marginTop: 2 }}>📍 {c.destino_detalle}</Text> : null}

      {c.notas ? <Text style={{ fontSize: 13, color: "#888", marginTop: 10, fontStyle: "italic" }}>💬 {c.notas}</Text> : null}

      {c.distancia_km ? (
        <Text style={{ fontSize: 13, color: "#555", marginTop: 8 }}>
          📏 {c.distancia_km} km{c.tarifa_sugerida ? `  ·  sugerido $${c.tarifa_sugerida.toLocaleString()}` : ""}
        </Text>
      ) : null}

      <View style={{ height: 1, backgroundColor: "#eee", marginVertical: 10 }} />
      <Text style={{ fontSize: 13, color: "#888" }}>👤 {c.cliente_nombre}</Text>
      <Text style={{ fontSize: 15, fontWeight: "600", color: "#185FA5", marginTop: 2 }}>📞 {c.cliente_telefono}</Text>

      {!propia && (
        <TouchableOpacity style={[styles.button, { backgroundColor: "#2E7D32", marginTop: 12 }]} onPress={() => aceptar(c)}>
          <Text style={styles.buttonText}>Tomar esta carrera</Text>
        </TouchableOpacity>
      )}
      {propia && c.estado === "aceptada" && (
        <TouchableOpacity style={[styles.button, { backgroundColor: "#185FA5", marginTop: 12 }]} onPress={() => cambiarEstado(c, "en_camino")}>
          <Text style={styles.buttonText}>Ya lo recogi — En camino</Text>
        </TouchableOpacity>
      )}
      {propia && c.estado === "en_camino" && (
        <TouchableOpacity style={[styles.button, { backgroundColor: "#2E7D32", marginTop: 12 }]} onPress={() => finalizar(c)}>
          <Text style={styles.buttonText}>Carrera terminada</Text>
        </TouchableOpacity>
      )}
    </View>
  );

  return (
    <SafeAreaView style={styles.container}>
      <View style={[styles.header, { backgroundColor: "#185FA5" }]}>
        <Text style={styles.headerSub}>Hola, {usuario.nombre} 🚕</Text>
        <Text style={styles.headerTitle}>Carreras</Text>
      </View>

      {cuenta && cuenta.cobro_activo && !cuenta.al_dia && (
        <View style={styles.avisoVencido}>
          <Text style={{ fontWeight: "bold", color: "#8A1C1C" }}>Tu suscripcion esta vencida</Text>
          <Text style={{ fontSize: 13, color: "#8A1C1C", marginTop: 4 }}>
            No puedes tomar carreras. Renueva por ${cuenta.valor_mensual.toLocaleString()} al mes.
          </Text>
          {cuenta.nequi_pagos ? (
            <Text style={{ fontSize: 13, color: "#8A1C1C", marginTop: 4, fontWeight: "600" }}>Nequi: {cuenta.nequi_pagos}</Text>
          ) : null}
        </View>
      )}
      {cuenta && cuenta.cobro_activo && cuenta.al_dia && cuenta.dias_restantes <= 5 && (
        <View style={[styles.avisoVencido, { backgroundColor: "#FFF4E0" }]}>
          <Text style={{ fontSize: 13, color: "#8A5A00", fontWeight: "600" }}>
            Te quedan {cuenta.dias_restantes} dias de suscripcion
          </Text>
        </View>
      )}

      <TouchableOpacity style={[styles.disponibleBar, { backgroundColor: disponible ? "#E8F5E9" : "#FBECEC" }]} onPress={cambiarDisponibilidad}>
        <Text style={{ fontWeight: "600", color: disponible ? "#2E7D32" : "#C0392B" }}>
          {disponible ? "🟢 Estas conectado" : "🔴 Estas desconectado"}
        </Text>
        <Text style={{ fontSize: 12, color: "#888", marginTop: 2 }}>Toca para cambiar</Text>
      </TouchableOpacity>

      <ScrollView contentContainerStyle={{ padding: 16, paddingTop: 8 }}>
        {mias.length > 0 && (
          <>
            <Text style={styles.seccionTitulo}>Tu carrera en curso</Text>
            {mias.map(c => tarjeta(c, true))}
          </>
        )}

        <Text style={styles.seccionTitulo}>Carreras disponibles</Text>
        {disponibles.length === 0 && (
          <View style={{ alignItems: "center", padding: 30 }}>
            <Text style={{ fontSize: 40 }}>😴</Text>
            <Text style={{ color: "#888", marginTop: 8 }}>No hay carreras por ahora</Text>
          </View>
        )}
        {disponibles.map(c => tarjeta(c, false))}
      </ScrollView>

      <TouchableOpacity style={{ padding: 16, alignItems: "center" }} onPress={() => navigation.replace("Login")}>
        <Text style={{ color: "#888", fontSize: 13 }}>Salir</Text>
      </TouchableOpacity>

      <Modal visible={!!cobrando} transparent animationType="fade" onRequestClose={() => setCobrando(null)}>
        <View style={styles.fondoModal}>
          <View style={styles.ventanaModal}>
            <Text style={{ fontSize: 17, fontWeight: "bold", color: "#333" }}>Carrera terminada</Text>
            <Text style={{ fontSize: 13, color: "#888", marginTop: 4, marginBottom: 14 }}>Cuanto cobraste?</Text>
            <TextInput
              value={tarifa}
              onChangeText={setTarifa}
              placeholder="Ej: 8000"
              keyboardType="number-pad"
              style={styles.input}
              autoFocus
            />
            <View style={{ flexDirection: "row", gap: 10, marginTop: 6 }}>
              <TouchableOpacity style={[styles.button, { flex: 1, backgroundColor: "#fff", borderWidth: 1, borderColor: "#ddd" }]} onPress={() => setCobrando(null)}>
                <Text style={{ color: "#888", fontWeight: "600" }}>Cancelar</Text>
              </TouchableOpacity>
              <TouchableOpacity style={[styles.button, { flex: 1, backgroundColor: "#2E7D32" }]} onPress={confirmarCobro}>
                <Text style={styles.buttonText}>Guardar</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

function AdminCarrerasScreen({ navigation }) {
  const [conductores, setConductores] = useState([]);
  const [carreras, setCarreras] = useState([]);
  const [config, setConfig] = useState({});
  const [pestana, setPestana] = useState("conductores");

  const cargar = () => {
    fetch(`${API}/conductores`).then(r => r.json()).then(d => { if (Array.isArray(d)) setConductores(d); }).catch(() => {});
    fetch(`${API}/carreras`).then(r => r.json()).then(d => { if (Array.isArray(d)) setCarreras(d); }).catch(() => {});
    fetch(`${API}/config`).then(r => r.json()).then(d => { if (d && !d.detail) setConfig(d); }).catch(() => {});
  };

  useEffect(() => {
    cargar();
    const intervalo = setInterval(cargar, 10000);
    return () => clearInterval(intervalo);
  }, []);

  const registrarPago = (c) => {
    elegir(`Pago de ${c.nombre}`, "Cuantos meses le registro?",
      [1, 3, 6].map(m => ({
        texto: `${m} ${m === 1 ? "mes" : "meses"}`,
        alElegir: () => fetch(`${API}/conductores/${c.id}/suscripcion?meses=${m}`, { method: "PUT" }).then(cargar),
      })));
  };

  const quitarSuscripcion = (c) => {
    confirmar("Quitar suscripcion", `${c.nombre} dejara de recibir carreras.`,
      () => fetch(`${API}/conductores/${c.id}/suscripcion`, { method: "DELETE" }).then(cargar),
      "Si, quitar");
  };

  const cambiarCobro = () => {
    const nuevo = config.cobro_activo === "si" ? "no" : "si";
    confirmar(
      nuevo === "si" ? "Activar cobro" : "Desactivar cobro",
      nuevo === "si"
        ? "Desde ahora solo los conductores con suscripcion al dia podran tomar carreras."
        : "Todos los conductores podran trabajar gratis.",
      () => fetch(`${API}/config?clave=cobro_activo&valor=${nuevo}`, { method: "PUT" }).then(cargar));
  };

  const activos = conductores.filter(c => c.al_dia).length;
  const enCurso = carreras.filter(c => ["buscando", "aceptada", "en_camino"].includes(c.estado));
  const hoy = carreras.filter(c => (c.fecha || "").slice(0, 10) === new Date().toISOString().slice(0, 10));

  return (
    <SafeAreaView style={styles.container}>
      <View style={[styles.header, { backgroundColor: "#185FA5", flexDirection: "row", alignItems: "center", gap: 12 }]}>
        <TouchableOpacity onPress={() => navigation.goBack()}>
          <Text style={{ color: "#fff", fontSize: 20 }}>←</Text>
        </TouchableOpacity>
        <View>
          <Text style={styles.headerSub}>Administracion</Text>
          <Text style={styles.headerTitle}>Carreras</Text>
        </View>
      </View>

      <View style={{ flexDirection: "row", padding: 16, gap: 10 }}>
        <View style={styles.mini}><Text style={styles.miniNum}>{enCurso.length}</Text><Text style={styles.miniTxt}>En curso</Text></View>
        <View style={styles.mini}><Text style={styles.miniNum}>{hoy.length}</Text><Text style={styles.miniTxt}>Hoy</Text></View>
        <View style={styles.mini}><Text style={styles.miniNum}>{activos}</Text><Text style={styles.miniTxt}>Al dia</Text></View>
      </View>

      <View style={[styles.tabs, { marginHorizontal: 16 }]}>
        {["conductores", "carreras", "cobro"].map(p => (
          <TouchableOpacity key={p} style={[styles.tab, pestana === p && styles.tabActive]} onPress={() => setPestana(p)}>
            <Text style={[styles.tabText, pestana === p && styles.tabTextActive]}>{p[0].toUpperCase() + p.slice(1)}</Text>
          </TouchableOpacity>
        ))}
      </View>

      <ScrollView contentContainerStyle={{ padding: 16, paddingTop: 4 }}>
        {pestana === "conductores" && conductores.map(c => (
          <View key={c.id} style={[styles.card, { marginBottom: 10 }]}>
            <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
              <View style={{ flex: 1 }}>
                <Text style={{ fontWeight: "600", fontSize: 15 }}>{c.nombre}</Text>
                <Text style={{ fontSize: 12, color: "#888", marginTop: 2 }}>📞 {c.telefono}</Text>
                {c.placa ? <Text style={{ fontSize: 12, color: "#888" }}>🚕 {c.vehiculo} - {c.placa}</Text> : null}
              </View>
              <View style={[styles.estadoBadge, { backgroundColor: c.al_dia ? "#E8F5E9" : "#FBECEC" }]}>
                <Text style={{ fontSize: 11, fontWeight: "600", color: c.al_dia ? "#2E7D32" : "#C0392B" }}>
                  {c.al_dia ? (config.cobro_activo === "si" ? `${c.dias_restantes} dias` : "activo") : "vencido"}
                </Text>
              </View>
            </View>
            <View style={{ flexDirection: "row", gap: 8, marginTop: 12 }}>
              <TouchableOpacity style={[styles.button, { flex: 1, backgroundColor: "#2E7D32", padding: 10 }]} onPress={() => registrarPago(c)}>
                <Text style={[styles.buttonText, { fontSize: 13 }]}>Registrar pago</Text>
              </TouchableOpacity>
              <TouchableOpacity style={[styles.button, { flex: 1, backgroundColor: "#fff", borderWidth: 1, borderColor: "#ddd", padding: 10 }]} onPress={() => quitarSuscripcion(c)}>
                <Text style={{ color: "#C0392B", fontWeight: "600", fontSize: 13 }}>Quitar</Text>
              </TouchableOpacity>
            </View>
          </View>
        ))}
        {pestana === "conductores" && conductores.length === 0 && (
          <Text style={{ color: "#888", textAlign: "center", padding: 20 }}>
            No hay conductores. Cambia el rol de un usuario a "conductor" desde el panel de usuarios.
          </Text>
        )}

        {pestana === "carreras" && carreras.slice(0, 40).map(c => (
          <View key={c.id} style={[styles.card, { marginBottom: 10 }]}>
            <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
              <Text style={{ fontWeight: "600" }}>#{c.id} · {c.cliente_nombre}</Text>
              <Text style={{ fontSize: 11, color: "#888" }}>{c.estado}</Text>
            </View>
            <Text style={{ fontSize: 13, color: "#555", marginTop: 4 }}>{c.origen} → {c.destino}</Text>
            {c.conductor_nombre ? <Text style={{ fontSize: 12, color: "#888", marginTop: 2 }}>🚕 {c.conductor_nombre}</Text> : null}
            {c.tarifa ? <Text style={{ fontSize: 12, color: "#2E7D32", marginTop: 2 }}>${c.tarifa.toLocaleString()}</Text> : null}
          </View>
        ))}
        {pestana === "carreras" && carreras.length === 0 && (
          <Text style={{ color: "#888", textAlign: "center", padding: 20 }}>Todavia no hay carreras</Text>
        )}

        {pestana === "cobro" && (
          <View style={styles.card}>
            <Text style={{ fontWeight: "600", fontSize: 15, marginBottom: 4 }}>Cobro a conductores</Text>
            <Text style={{ fontSize: 12, color: "#888", marginBottom: 14 }}>
              {config.cobro_activo === "si"
                ? "Esta activo: solo los que tengan la suscripcion al dia reciben carreras."
                : "Esta apagado: todos trabajan gratis. Ideal mientras la app se llena de usuarios."}
            </Text>
            <TouchableOpacity
              style={[styles.button, { backgroundColor: config.cobro_activo === "si" ? "#C0392B" : "#2E7D32" }]}
              onPress={cambiarCobro}
            >
              <Text style={styles.buttonText}>{config.cobro_activo === "si" ? "Desactivar cobro" : "Activar cobro"}</Text>
            </TouchableOpacity>

            <Text style={[styles.etiqueta, { marginTop: 20 }]}>VALOR MENSUAL</Text>
            <TextInput
              defaultValue={config.valor_mensual}
              onEndEditing={(e) => {
                const v = e.nativeEvent.text.replace(/\D/g, "");
                if (v) fetch(`${API}/config?clave=valor_mensual&valor=${v}`, { method: "PUT" }).then(cargar);
              }}
              keyboardType="number-pad"
              style={styles.input}
            />
            <Text style={styles.etiqueta}>NEQUI PARA RECIBIR PAGOS</Text>
            <TextInput
              defaultValue={config.nequi_pagos}
              placeholder="Numero al que te transfieren"
              onEndEditing={(e) => fetch(`${API}/config?clave=nequi_pagos&valor=${encodeURIComponent(e.nativeEvent.text)}`, { method: "PUT" }).then(cargar)}
              keyboardType="phone-pad"
              style={styles.input}
            />
            <Text style={styles.ayuda}>Los conductores vencidos ven este numero para renovar</Text>
          </View>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

export default function App() {
  return (
    <NavigationContainer>
      <Stack.Navigator initialRouteName="Login" screenOptions={{ headerShown: false, animation: "slide_from_right" }}>
        <Stack.Screen name="Login" component={LoginScreen} />
        <Stack.Screen name="ElegirServicio" component={ElegirServicioScreen} />
        <Stack.Screen name="Inicio" component={InicioScreen} />
        <Stack.Screen name="Menu" component={MenuScreen} />
        <Stack.Screen name="Pedido" component={PedidoScreen} />
        <Stack.Screen name="MisPedidos" component={MisPedidosScreen} />
        <Stack.Screen name="Admin" component={AdminScreen} />
        <Stack.Screen name="Domiciliario" component={DomiciliarioScreen} />
        <Stack.Screen name="Restaurante" component={RestauranteScreen} />
        <Stack.Screen name="PedirCarrera" component={PedirCarreraScreen} />
        <Stack.Screen name="Conductor" component={ConductorScreen} />
        <Stack.Screen name="AdminCarreras" component={AdminCarrerasScreen} />
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
  // --- carreras
  servicioCard: { backgroundColor: "#FDEEDC", borderRadius: 16, padding: 24, alignItems: "center", marginBottom: 16 },
  servicioTitulo: { fontSize: 20, fontWeight: "bold", color: "#E8821C", marginTop: 10 },
  servicioSub: { fontSize: 13, color: "#888", marginTop: 4, textAlign: "center" },
  etiqueta: { fontSize: 11, color: "#888", fontWeight: "600", letterSpacing: 0.5, marginBottom: 4 },
  ayuda: { fontSize: 11, color: "#888", marginTop: -6, marginBottom: 6 },
  sugerencias: { backgroundColor: "#fff", borderWidth: 0.5, borderColor: "#ddd", borderRadius: 8, marginTop: -8, marginBottom: 12, overflow: "hidden" },
  sugerenciaItem: { paddingVertical: 10, paddingHorizontal: 12, borderBottomWidth: 0.5, borderBottomColor: "#eee" },
  seccionTitulo: { fontSize: 15, fontWeight: "600", color: "#333", marginBottom: 10, marginTop: 6 },
  disponibleBar: { marginHorizontal: 16, marginTop: 16, borderRadius: 12, padding: 14, alignItems: "center" },
  placaBadge: { backgroundColor: "#333", borderRadius: 6, paddingHorizontal: 12, paddingVertical: 6, alignSelf: "flex-start", marginTop: 8 },
  placaTexto: { color: "#fff", fontWeight: "bold", fontSize: 16, letterSpacing: 2 },
  avisoRural: { backgroundColor: "#FFF4E0", borderRadius: 6, paddingHorizontal: 10, paddingVertical: 5, marginTop: 10, alignSelf: "flex-start" },
  avisoRuralTexto: { fontSize: 11, color: "#8A5A00", fontWeight: "600" },
  avisoVencido: { backgroundColor: "#FBECEC", marginHorizontal: 16, marginTop: 16, borderRadius: 12, padding: 14 },
  mini: { flex: 1, backgroundColor: "#fff", borderRadius: 12, padding: 12, alignItems: "center", elevation: 2 },
  miniNum: { fontSize: 22, fontWeight: "bold", color: "#185FA5" },
  miniTxt: { fontSize: 11, color: "#888", marginTop: 2 },
  estadoBadge: { borderRadius: 6, paddingHorizontal: 10, paddingVertical: 4 },
  botonMapa: { borderWidth: 1, borderColor: "#185FA5", borderRadius: 8, padding: 12, alignItems: "center", marginBottom: 8, backgroundColor: "#F4F9FE" },
  botonMapaOk: { borderColor: "#2E7D32", backgroundColor: "#EAF6EC" },
  estimado: { backgroundColor: "#F4F9FE", borderRadius: 10, padding: 14, marginTop: 6, alignItems: "center" },
  opcion: { flex: 1, paddingVertical: 10, paddingHorizontal: 6, borderRadius: 8, borderWidth: 1, borderColor: "#ddd", alignItems: "center", backgroundColor: "#fff" },
  opcionActiva: { backgroundColor: "#E6F1FB", borderColor: "#185FA5" },
  opcionTexto: { fontSize: 13, color: "#888" },
  opcionTextoActivo: { color: "#185FA5", fontWeight: "600" },
  fondoModal: { flex: 1, backgroundColor: "rgba(0,0,0,0.5)", justifyContent: "center", padding: 24 },
  ventanaModal: { backgroundColor: "#fff", borderRadius: 16, padding: 20 },
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