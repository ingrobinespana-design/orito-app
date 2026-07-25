import { useState, useEffect, useRef, useMemo } from 'react';
import { NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { View, Text, TextInput, TouchableOpacity, StyleSheet, SafeAreaView, ScrollView, ActivityIndicator, Image, Alert, Platform, Modal, LayoutAnimation, UIManager, Linking, Animated, Vibration } from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import * as Notifications from 'expo-notifications';
import * as Device from 'expo-device';
import Constants from 'expo-constants';
import * as Location from 'expo-location';
import * as TaskManager from 'expo-task-manager';
import { WebView } from 'react-native-webview';
import * as Updates from 'expo-updates';
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context';

// Produccion por defecto. Para probar contra un servidor local se arranca con
// EXPO_PUBLIC_API_URL=http://localhost:8000 y asi nunca queda un localhost publicado.
const API = process.env.EXPO_PUBLIC_API_URL || "https://orito-app-production.up.railway.app";
const Stack = createNativeStackNavigator();

// Llave de sesion. En memoria (al cerrar la app se pide entrar de nuevo).
//  - llaveUsuario: identifica a CUALQUIER usuario; el servidor exige que solo
//    toques TUS cosas (tu carrera, tu perfil).
//  - llaveAdmin: solo la tiene el dueño; abre el panel de administracion.
let llaveUsuario = null;
let llaveAdmin = null;
const guardarLlave = (u) => {
  llaveUsuario = (u && u.token) || null;
  llaveAdmin = (u && u.rol === "admin" && u.token) || null;
};
const adminFetch = (url, opciones = {}) =>
  fetch(url, { ...opciones, headers: { ...(opciones.headers || {}), "X-Admin-Token": llaveAdmin || "" } });
// para acciones sobre lo propio: manda la identidad del usuario
const userFetch = (url, opciones = {}) =>
  fetch(url, { ...opciones, headers: { ...(opciones.headers || {}), "X-User-Token": llaveUsuario || "" } });

// ===== rastreo en SEGUNDO PLANO del conductor con carrera activa =====
// Un servicio de Android (notificacion fija "carrera en curso") sigue enviando
// la ubicacion aunque el conductor cierre Tukan, bloquee el telefono o navegue
// con Google Maps: el cliente lo ve venir en tiempo real pase lo que pase.
const TAREA_UBICACION = "tukan-ubicacion-carrera";
let conductorRastreado = null;   // id del conductor; lo fija ConductorScreen

try {
  TaskManager.defineTask(TAREA_UBICACION, ({ data, error }) => {
    if (error || !conductorRastreado) return;
    const locs = data && data.locations;
    if (!locs || !locs.length) return;
    const p = locs[locs.length - 1].coords;
    fetch(`${API}/conductores/${conductorRastreado}/ubicacion?lat=${p.latitude}&lon=${p.longitude}`,
      { method: "PUT" })
      .then((r) => r.json())
      .then((d) => {
        // la carrera termino (o el cliente cancelo) con la app en segundo plano:
        // el servicio se apaga solo para no gastar bateria
        if (d && d.carrera_activa === false) detenerRastreoFondo();
      })
      .catch(() => {});
  });
} catch (e) {}   // en web no existe TaskManager y no hace falta

async function iniciarRastreoFondo(conductorId) {
  try {
    conductorRastreado = conductorId;
    if (Platform.OS === "web") return false;
    const ya = await Location.hasStartedLocationUpdatesAsync(TAREA_UBICACION).catch(() => false);
    if (ya) return true;
    // el permiso "todo el tiempo" es lo ideal; si no lo dan, el servicio en
    // primer plano igual funciona en la mayoria de Androids modernos
    await Location.requestBackgroundPermissionsAsync().catch(() => {});
    await Location.startLocationUpdatesAsync(TAREA_UBICACION, {
      accuracy: Location.Accuracy.Balanced,
      timeInterval: 8000,          // cada ~8s
      distanceInterval: 20,        // o cada ~20m, lo que pase primero
      foregroundService: {
        notificationTitle: "Tukán — carrera en curso",
        notificationBody: "Compartiendo tu ubicacion para que el cliente te vea venir",
        notificationColor: "#187830",
      },
    });
    return true;
  } catch (e) { return false; }   // sin permiso: sigue el reporte con app abierta
}

async function detenerRastreoFondo() {
  try {
    const ya = await Location.hasStartedLocationUpdatesAsync(TAREA_UBICACION).catch(() => false);
    if (ya) await Location.stopLocationUpdatesAsync(TAREA_UBICACION);
  } catch (e) {}
}

// animaciones de layout suaves (aparecer/desaparecer solicitudes) en Android
if (Platform.OS === "android" && UIManager.setLayoutAnimationEnabledExperimental) {
  UIManager.setLayoutAnimationEnabledExperimental(true);
}
const animar = () => LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);

// construye el query string a mano con encodeURIComponent: el URLSearchParams de
// React Native a veces arma mal la URL y el fetch falla como si fuera "sin conexion"
function qs(obj) {
  // se filtran solo null/undefined; el string vacio SI se envia (p. ej. borrar un medio de pago)
  return Object.entries(obj)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");
}

// catalogo de vehiculos: "personas" = carreras normales; "carga" = trasteos y
// acarreos (mudanzas, mercancia). Todos se piden y negocian igual. Fuente unica
// para etiquetas e iconos en toda la app.
const VEHICULOS = {
  moto:         { label: "Moto",         icono: "🏍️", grupo: "personas" },
  carro:        { label: "Carro",        icono: "🚗", grupo: "personas" },
  motocarguero: { label: "Motocarguero", icono: "🛺", grupo: "carga" },
  camioneta:    { label: "Camioneta",    icono: "🛻", grupo: "carga" },
  camion:       { label: "Camion",       icono: "🚚", grupo: "carga" },
  furgon:       { label: "Furgon",       icono: "🚐", grupo: "carga" },
  planchon:     { label: "Planchon",     icono: "🚛", grupo: "carga" },
  grua:         { label: "Grua",         icono: "🏗️", grupo: "carga" },
};
const vehLabel = (t) => (VEHICULOS[t] ? VEHICULOS[t].label : (t || ""));
const vehIcono = (t) => (VEHICULOS[t] ? VEHICULOS[t].icono : "🚗");
const esCarga = (t) => VEHICULOS[t] && VEHICULOS[t].grupo === "carga";
// orden de aparicion: primero personas, luego carga
const ordenVehiculos = (tipos) =>
  Object.keys(VEHICULOS).filter((t) => tipos.includes(t));

// --- agendar recogida (solo trasteos). Todo con Date nativo, SIN modulos
//     nativos de calendario, para que viaje por OTA sin recompilar.
const DIAS_ABR = ["dom", "lun", "mar", "mie", "jue", "vie", "sab"];
function diasProximos() {
  const arr = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(); d.setDate(d.getDate() + i); d.setHours(0, 0, 0, 0);
    const lbl = i === 0 ? "Hoy" : i === 1 ? "Manana" : `${DIAS_ABR[d.getDay()]} ${d.getDate()}`;
    arr.push({ key: `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`, d, lbl });
  }
  return arr;
}
function horasDelDia() {
  const arr = [];
  for (let h = 6; h <= 20; h++) {
    for (const m of [0, 30]) {
      const ampm = h < 12 ? "am" : "pm";
      const h12 = h % 12 === 0 ? 12 : h % 12;
      arr.push({ h, m, lbl: `${h12}:${String(m).padStart(2, "0")} ${ampm}` });
    }
  }
  return arr;
}
// string ISO LOCAL (sin zona: hora de Colombia tal cual), para que el backend
// la guarde y la app la vuelva a leer igual
function isoLocal(d, h, m) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(h)}:${p(m)}:00`;
}
function fmtRecogida(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  const hoy = new Date(); hoy.setHours(0, 0, 0, 0);
  const dd = new Date(d); dd.setHours(0, 0, 0, 0);
  const difd = Math.round((dd - hoy) / 86400000);
  const dia = difd === 0 ? "hoy" : difd === 1 ? "manana" : `${DIAS_ABR[d.getDay()]} ${d.getDate()}`;
  const h = d.getHours(), m = d.getMinutes();
  const ampm = h < 12 ? "am" : "pm"; const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${dia} ${h12}:${String(m).padStart(2, "0")} ${ampm}`;
}

// abrir el marcador del telefono o WhatsApp con un numero colombiano
const soloDigitos = (n) => (n || "").replace(/\D/g, "");
function llamar(num) {
  const n = soloDigitos(num);
  if (n) Linking.openURL(`tel:${n}`).catch(() => {});
}
function whatsapp(num) {
  let n = soloDigitos(num);
  if (!n) return;
  if (n.length === 10) n = "57" + n;   // celular colombiano sin indicativo
  Linking.openURL(`https://wa.me/${n}`).catch(() => {});
}

/** Punto que "late" para dar sensacion de app viva/escuchando (el tic-tac). */
function PuntoVivo({ color, activo }) {
  const a = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (!activo) return;
    const loop = Animated.loop(Animated.sequence([
      Animated.timing(a, { toValue: 1, duration: 750, useNativeDriver: true }),
      Animated.timing(a, { toValue: 0, duration: 750, useNativeDriver: true }),
    ]));
    loop.start();
    return () => loop.stop();
  }, [activo]);
  const scale = a.interpolate({ inputRange: [0, 1], outputRange: [1, 1.9] });
  const opacity = a.interpolate({ inputRange: [0, 1], outputRange: [0.85, 0] });
  return (
    <View style={{ width: 16, height: 16, alignItems: "center", justifyContent: "center" }}>
      {activo && <Animated.View style={{ position: "absolute", width: 16, height: 16, borderRadius: 8, backgroundColor: color, transform: [{ scale }], opacity }} />}
      <View style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: color }} />
    </View>
  );
}

/** distancia en km en linea recta entre dos puntos {lat,lon} (Haversine) */
function kmEntre(a, b) {
  if (!a || !b || a.lat == null || b.lat == null) return null;
  const R = 6371, rad = (x) => (x * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat), dLon = rad(b.lon - a.lon);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(s), Math.sqrt(1 - s));
}

/** "hace 3 min" a partir de una fecha ISO */
function haceCuanto(fechaISO) {
  if (!fechaISO) return "";
  const min = Math.max(0, Math.floor((Date.now() - new Date(fechaISO).getTime()) / 60000));
  if (min < 1) return "ahora";
  if (min < 60) return `hace ${min} min`;
  const h = Math.floor(min / 60);
  return `hace ${h} h`;
}

/** fetch con reintentos: el servidor gratis de Railway se "duerme" y la primera
 *  peticion puede tardar en despertarlo. En vez de fallar de una, reintenta. */
async function fetchReintento(url, opciones = {}, intentos = 3) {
  let ultimoError;
  for (let i = 0; i < intentos; i++) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 20000);
      const r = await fetch(url, { ...opciones, signal: ctrl.signal });
      clearTimeout(timer);
      return r;
    } catch (e) {
      ultimoError = e;
      await new Promise((res) => setTimeout(res, 1500 * (i + 1)));  // espera y reintenta
    }
  }
  throw ultimoError;
}

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

/** Pide permiso, saca el token de Expo y lo guarda en el servidor. Devuelve un
 *  diagnostico {ok, motivo, token} para poder ver EN PANTALLA donde falla. */
async function registrarNotificaciones(usuarioId) {
  try {
    if (Platform.OS === "android") {
      // El canal define que suene fuerte y salte en pantalla.
      await Notifications.setNotificationChannelAsync("carreras2", {
        name: "Carreras",
        importance: Notifications.AndroidImportance.MAX,
        vibrationPattern: [0, 500, 220, 500],
        sound: "tono.wav",   // tono propio fuerte (bundleado en el APK 1.0.2)
        lockscreenVisibility: Notifications.AndroidNotificationVisibility.PUBLIC,
        bypassDnd: true,      // suena aunque este en "No molestar"
      });
    }
    if (!Device.isDevice) return { ok: false, motivo: "Debe ser un telefono real (no emulador)." };

    const permiso = await Notifications.getPermissionsAsync();
    let estado = permiso.status;
    if (estado !== "granted") {
      estado = (await Notifications.requestPermissionsAsync()).status;
    }
    if (estado !== "granted") return { ok: false, motivo: "No diste permiso de notificaciones." };

    const projectId =
      Constants?.expoConfig?.extra?.eas?.projectId ??
      Constants?.easConfig?.projectId;
    if (!projectId) return { ok: false, motivo: "Falta el projectId en la configuracion." };

    let token;
    try {
      const res = await Notifications.getExpoPushTokenAsync({ projectId });
      token = res.data;
    } catch (e) {
      return { ok: false, motivo: "Error obteniendo el token (FCM): " + (e.message || String(e)) };
    }
    if (!token) return { ok: false, motivo: "No se obtuvo token." };

    const r = await userFetch(`${API}/usuarios/${usuarioId}/push-token?token=${encodeURIComponent(token)}`, { method: "PUT" });
    if (!r.ok) return { ok: false, motivo: "El servidor rechazo el token (HTTP " + r.status + ").", token };
    return { ok: true, motivo: "Token guardado.", token };
  } catch (e) {
    return { ok: false, motivo: "Error: " + (e.message || String(e)) };
  }
}

function LoginScreen({ navigation }) {
  const [modo, setModo] = useState("login");
  // categoria: que va a hacer -> "cliente" | "carreras" (personas) | "acarreos" (carga)
  // comoMe: el vehiculo exacto (o "cliente"). Se elige en 2 pasos.
  const [form, setForm] = useState({ nombre: "", telefono: "", password: "", municipio: "Orito", categoria: "cliente", comoMe: "cliente", placa: "" });
  const [municipios, setMunicipios] = useState([]);
  const [cargandoMun, setCargandoMun] = useState(true);

  const cargarMunicipios = () => {
    setCargandoMun(true);
    fetchReintento(`${API}/municipios`).then(r => r.json())
      .then(d => { if (Array.isArray(d) && d.length) setMunicipios(d); })
      .catch(() => {})
      .finally(() => setCargandoMun(false));
  };
  useEffect(cargarMunicipios, []);

  // en Orito no hay mototaxi: la opcion de moto ni siquiera se muestra alla
  const vehiculosAqui = (municipios.find(m => m.nombre === form.municipio) || {}).vehiculos || ["carro"];
  const personasAqui = ordenVehiculos(vehiculosAqui).filter((v) => !esCarga(v));
  const cargaAqui = ordenVehiculos(vehiculosAqui).filter(esCarga);
  const [error, setError] = useState("");
  const [cargando, setCargando] = useState(false);

  // paso 1 del registro: elegir que va a hacer. Si en la categoria solo hay un
  // vehiculo posible (ej. Orito carreras = solo carro), se selecciona solo.
  const elegirCategoria = (cat) => {
    if (cat === "cliente") { setForm((f) => ({ ...f, categoria: "cliente", comoMe: "cliente" })); return; }
    const lista = cat === "carreras" ? personasAqui : cargaAqui;
    setForm((f) => ({ ...f, categoria: cat, comoMe: lista.length === 1 ? lista[0] : "" }));
  };

  const handleSubmit = () => {
    // si eligio ser conductor/acarreador, tiene que decir con que vehiculo
    if (modo === "registro" && form.categoria !== "cliente" && !form.comoMe) {
      setError(form.categoria === "carreras"
        ? "Elige si haras carreras en moto o carro"
        : "Elige el vehiculo de carga con el que trabajaras");
      return;
    }
    setCargando(true);
    setError("");
    const url = modo === "login"
      ? `${API}/login?telefono=${form.telefono}&password=${form.password}`
      : `${API}/registro?nombre=${form.nombre}&telefono=${form.telefono}&password=${form.password}`
        + `&municipio=${encodeURIComponent(form.municipio)}`
        + (form.comoMe === "cliente" || !form.comoMe ? "" :
           `&tipo_vehiculo=${form.comoMe}&placa=${encodeURIComponent(form.placa)}`);
    fetchReintento(url, { method: "POST" })
      .then((res) => res.json())
      .then((data) => {
        setCargando(false);
        if (data.detail) { setError(data.detail); return; }
        guardarLlave(data);   // habilita el panel si este usuario es el admin
        registrarNotificaciones(data.id);
        if (data.rol === "admin") navigation.replace("Admin", { usuario: data });
        else if (data.rol === "domiciliario") navigation.replace("Domiciliario", { usuario: data });
        else if (data.rol === "restaurante") navigation.replace("Restaurante", { usuario: data });
        else if (data.rol === "conductor") navigation.replace("Conductor", { usuario: data });
        else navigation.replace("ElegirServicio", { usuario: data });
      })
      .catch(() => { setCargando(false); setError("No hay conexion. Verifica tu internet e intenta de nuevo."); });
  };

  return (
    <SafeAreaView style={styles.container}>
      <ScrollView contentContainerStyle={styles.scroll}>
        <View style={[styles.header, { flexDirection: "row", alignItems: "center", gap: 14 }]}>
          <Image source={require("./assets/icon.png")} style={{ width: 54, height: 54, borderRadius: 14 }} />
          <View>
            <Text style={styles.headerSub}>Bienvenido a</Text>
            <Text style={styles.headerTitle}>Tukán</Text>
          </View>
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
              {cargandoMun ? (
                <View style={{ paddingVertical: 12 }}><ActivityIndicator color="#187830" /></View>
              ) : municipios.length === 0 ? (
                <TouchableOpacity style={[styles.opcion, { marginBottom: 12 }]} onPress={cargarMunicipios}>
                  <Text style={{ color: "#C0392B", fontSize: 13 }}>Sin conexion. Toca para reintentar</Text>
                </TouchableOpacity>
              ) : (
                <View style={{ flexDirection: "row", gap: 8, marginBottom: 12 }}>
                  {municipios.map(m => (
                    <TouchableOpacity
                      key={m.nombre}
                      style={[styles.opcion, form.municipio === m.nombre && styles.opcionActiva]}
                      onPress={() => {
                        // al cambiar de pueblo, si el vehiculo elegido no existe alla, se limpia
                        const permite = (m.vehiculos || []).includes(form.comoMe);
                        setForm({ ...form, municipio: m.nombre, comoMe: permite ? form.comoMe : (form.categoria === "cliente" ? "cliente" : "") });
                      }}
                    >
                      <Text style={[styles.opcionTexto, form.municipio === m.nombre && styles.opcionTextoActivo]}>{m.nombre}</Text>
                    </TouchableOpacity>
                  ))}
                </View>
              )}

              {/* PASO 1: que va a hacer */}
              <Text style={styles.etiqueta}>QUE VAS A HACER</Text>
              <View style={{ gap: 8, marginBottom: 12 }}>
                <TouchableOpacity
                  style={[styles.catBoton, form.categoria === "cliente" && styles.catBotonOn]}
                  onPress={() => elegirCategoria("cliente")}
                >
                  <Text style={styles.catEmoji}>🧍</Text>
                  <View style={{ flex: 1 }}>
                    <Text style={[styles.catTitulo, form.categoria === "cliente" && styles.catTituloOn]}>Soy cliente</Text>
                    <Text style={styles.catSub}>Quiero pedir carreras o acarreos</Text>
                  </View>
                </TouchableOpacity>
                {personasAqui.length > 0 && (
                  <TouchableOpacity
                    style={[styles.catBoton, form.categoria === "carreras" && styles.catBotonOn]}
                    onPress={() => elegirCategoria("carreras")}
                  >
                    <Text style={styles.catEmoji}>🚗</Text>
                    <View style={{ flex: 1 }}>
                      <Text style={[styles.catTitulo, form.categoria === "carreras" && styles.catTituloOn]}>Hago carreras</Text>
                      <Text style={styles.catSub}>Llevo personas en {personasAqui.map(vehLabel).join(" o ").toLowerCase()}</Text>
                    </View>
                  </TouchableOpacity>
                )}
                {cargaAqui.length > 0 && (
                  <TouchableOpacity
                    style={[styles.catBoton, form.categoria === "acarreos" && styles.catBotonOn]}
                    onPress={() => elegirCategoria("acarreos")}
                  >
                    <Text style={styles.catEmoji}>🚚</Text>
                    <View style={{ flex: 1 }}>
                      <Text style={[styles.catTitulo, form.categoria === "acarreos" && styles.catTituloOn]}>Hago acarreos</Text>
                      <Text style={styles.catSub}>Trasteos, mudanzas y carga</Text>
                    </View>
                  </TouchableOpacity>
                )}
              </View>

              {/* PASO 2: el vehiculo exacto de esa categoria */}
              {form.categoria === "carreras" && (
                <>
                  <Text style={styles.etiqueta}>TU VEHICULO</Text>
                  <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8, marginBottom: 12 }}>
                    {personasAqui.map((v) => (
                      <TouchableOpacity key={v}
                        style={[styles.chip, form.comoMe === v && styles.chipOn]}
                        onPress={() => setForm({ ...form, comoMe: v })}>
                        <Text style={[styles.chipTxt, form.comoMe === v && styles.chipTxtOn]}>{vehIcono(v)} {vehLabel(v)}</Text>
                      </TouchableOpacity>
                    ))}
                  </View>
                </>
              )}
              {form.categoria === "acarreos" && (
                <>
                  <Text style={styles.etiqueta}>TU VEHICULO DE CARGA</Text>
                  <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8, marginBottom: 12 }}>
                    {cargaAqui.map((v) => (
                      <TouchableOpacity key={v}
                        style={[styles.chip, form.comoMe === v && styles.chipOn]}
                        onPress={() => setForm({ ...form, comoMe: v })}>
                        <Text style={[styles.chipTxt, form.comoMe === v && styles.chipTxtOn]}>{vehIcono(v)} {vehLabel(v)}</Text>
                      </TouchableOpacity>
                    ))}
                  </View>
                </>
              )}
              {form.categoria !== "cliente" && form.comoMe ? (
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
              ) : null}
            </>
          )}
          <TextInput placeholder="Telefono" value={form.telefono} onChangeText={(t) => setForm({ ...form, telefono: t })} style={styles.input} keyboardType="phone-pad" />
          <TextInput placeholder="Contrasena" value={form.password} onChangeText={(t) => setForm({ ...form, password: t })} style={styles.input} secureTextEntry />
          {error ? <Text style={styles.error}>{error}</Text> : null}
          <TouchableOpacity style={styles.button} onPress={handleSubmit} disabled={cargando}>
            {cargando ? <ActivityIndicator color="#fff" /> : <Text style={styles.buttonText}>{modo === "login" ? "Ingresar" : "Crear cuenta"}</Text>}
          </TouchableOpacity>
          {modo === "registro" && (
            <Text style={{ fontSize: 11, color: "#888", textAlign: "center", marginTop: 10, lineHeight: 16 }}>
              Al crear tu cuenta aceptas los{" "}
              <Text style={{ color: "#187830", fontWeight: "600" }} onPress={() => Linking.openURL(`${API}/terminos`)}>Términos</Text>
              {" "}y la{" "}
              <Text style={{ color: "#187830", fontWeight: "600" }} onPress={() => Linking.openURL(`${API}/privacidad`)}>Política de Privacidad y Habeas Data</Text>.
            </Text>
          )}
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
              <Text style={{ fontSize: 15, fontWeight: "600", color: "#F06000", marginTop: 4 }}>${p.precio.toLocaleString()}</Text>
            </View>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
              <TouchableOpacity style={styles.btnCantidad} onPress={() => quitarDelCarrito(p)}>
                <Text style={{ fontSize: 18, color: "#333" }}>-</Text>
              </TouchableOpacity>
              <Text style={{ fontSize: 15, fontWeight: "600", minWidth: 20, textAlign: "center" }}>
                {carrito.find(c => c.id === p.id)?.cantidad || 0}
              </Text>
              <TouchableOpacity style={[styles.btnCantidad, { backgroundColor: "#F06000" }]} onPress={() => agregarAlCarrito(p)}>
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
            <Text style={{ fontSize: 15, fontWeight: "600", color: "#F06000" }}>${total.toLocaleString()}</Text>
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
              <TouchableOpacity key={m} style={{ flex: 1, padding: 10, borderRadius: 8, borderWidth: 1, borderColor: metodoPago === m ? "#F06000" : "#ddd", backgroundColor: metodoPago === m ? "#FDEEDC" : "#fff", alignItems: "center" }} onPress={() => setMetodoPago(m)}>
                <Text style={{ fontSize: 11, color: metodoPago === m ? "#F06000" : "#888", fontWeight: metodoPago === m ? "600" : "400" }}>
                  {m === "efectivo" ? "Efectivo" : m === "nequi" ? "Nequi" : "Bancolombia"}
                </Text>
              </TouchableOpacity>
            ))}
          </View>
          {metodoPago === "nequi" && (
            <View style={{ backgroundColor: "#FDEEDC", borderRadius: 8, padding: 10, marginTop: 10 }}>
              <Text style={{ fontSize: 12, fontWeight: "600", color: "#F06000" }}>Transfiere por Nequi</Text>
              <Text style={{ fontSize: 12, color: "#555", marginTop: 2 }}>Numero: 3156009728</Text>
            </View>
          )}
          {metodoPago === "bancolombia" && (
            <View style={{ backgroundColor: "#E7F3E9", borderRadius: 8, padding: 10, marginTop: 10 }}>
              <Text style={{ fontSize: 12, fontWeight: "600", color: "#187830" }}>Transfiere por Bancolombia</Text>
              <Text style={{ fontSize: 12, color: "#555", marginTop: 2 }}>Cuenta: 07985044028</Text>
            </View>
          )}
          {metodoPago === "efectivo" && (
            <View style={{ backgroundColor: "#EAF3DE", borderRadius: 8, padding: 10, marginTop: 10 }}>
              <Text style={{ fontSize: 12, fontWeight: "600", color: "#187830" }}>Pago en efectivo</Text>
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
              <Text style={{ color: "#F06000", fontWeight: "600", fontSize: 12 }}>{p.estado.toUpperCase()}</Text>
            </View>
            <Text style={{ fontSize: 13, color: "#888" }}>{p.plato}</Text>
            <Text style={{ fontSize: 14, fontWeight: "600", color: "#F06000", marginTop: 4 }}>${p.total.toLocaleString()}</Text>
            <View style={{ marginTop: 12 }}>
              {ordenEstados.map((estado, index) => {
                const indiceActual = ordenEstados.indexOf(p.estado);
                const completado = index <= indiceActual;
                const actual = index === indiceActual;
                return (
                  <View key={estado} style={{ flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 6 }}>
                    <View style={{ width: 24, height: 24, borderRadius: 12, backgroundColor: completado ? "#F06000" : "#f0f0f0", alignItems: "center", justifyContent: "center" }}>
                      <Text style={{ fontSize: 12 }}>{completado ? iconos[index] : "○"}</Text>
                    </View>
                    <Text style={{ fontSize: 12, color: completado ? "#333" : "#bbb", fontWeight: actual ? "600" : "400" }}>{labels[index]}</Text>
                    {actual && (
                      <View style={{ backgroundColor: "#FDEEDC", borderRadius: 4, paddingHorizontal: 6, paddingVertical: 2 }}>
                        <Text style={{ fontSize: 10, color: "#F06000", fontWeight: "600" }}>Ahora</Text>
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
        style={{ position: "absolute", bottom: 20, left: 16, right: 16, backgroundColor: "#F06000", borderRadius: 12, padding: 14, alignItems: "center" }}
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
    adminFetch(`${API}/usuarios`).then(r => r.json()).then(data => { if (Array.isArray(data)) setUsuarios(data); });
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
        adminFetch(url, { method: "PUT" }).then(() => {
          setMensaje("Usuario creado");
          setNuevoUsuario({ nombre: "", telefono: "", password: "", rol: "domiciliario", restaurante_id: "" });
          cargarUsuarios();
          cargarDomiciliarios();
        });
      });
  };

  const colorEstado = (estado) => {
    if (estado === "pendiente") return { bg: "#FAEEDA", text: "#854F0B" };
    if (estado === "preparando" || estado === "aceptado") return { bg: "#E7F3E9", text: "#187830" };
    if (estado === "listo") return { bg: "#EAF3DE", text: "#187830" };
    if (estado === "asignado" || estado === "en camino") return { bg: "#FDEEDC", text: "#F06000" };
    if (estado === "entregado") return { bg: "#EAF3DE", text: "#187830" };
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
            <View style={{ flex: 1, backgroundColor: "#E7F3E9", borderRadius: 12, padding: 12, alignItems: "center" }}>
              <Text style={{ fontSize: 11, color: "#187830" }}>En proceso</Text>
              <Text style={{ fontSize: 22, fontWeight: "bold", color: "#187830" }}>{pedidos.filter(p => ["aceptado", "preparando", "listo", "asignado", "en camino"].includes(p.estado)).length}</Text>
            </View>
            <View style={{ flex: 1, backgroundColor: "#EAF3DE", borderRadius: 12, padding: 12, alignItems: "center" }}>
              <Text style={{ fontSize: 11, color: "#187830" }}>Entregados</Text>
              <Text style={{ fontSize: 22, fontWeight: "bold", color: "#187830" }}>{pedidos.filter(p => p.estado === "entregado").length}</Text>
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
                        <TouchableOpacity key={d.id} style={{ backgroundColor: "#187830", borderRadius: 8, paddingHorizontal: 12, paddingVertical: 8 }}
                          onPress={() => { fetch(`${API}/pedidos/${p.id}/asignar?domiciliario_id=${d.id}`, { method: "PUT" }).then(() => cargarPedidos()); }}>
                          <Text style={{ color: "#fff", fontSize: 12, fontWeight: "600" }}>🛵 {d.nombre}</Text>
                        </TouchableOpacity>
                      ))}
                    </View>
                  </ScrollView>
                </View>
              )}
              {p.estado === "en camino" && (
                <TouchableOpacity style={[styles.button, { marginTop: 10, backgroundColor: "#187830" }]} onPress={() => cambiarEstado(p.id, "entregado")}>
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
                <TouchableOpacity style={[styles.button, { flex: 1, backgroundColor: "#187830" }]} onPress={() => { setRestauranteSeleccionado(r); cargarPlatos(r.id); }}>
                  <Text style={styles.buttonText}>Ver menu</Text>
                </TouchableOpacity>
                <TouchableOpacity style={[styles.button, { flex: 1, backgroundColor: "#187830" }]} onPress={() => subirFotoRestaurante(r.id)}>
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
            <Text style={{ color: "#F06000", fontWeight: "600" }}>← Volver</Text>
          </TouchableOpacity>
          <Text style={{ fontWeight: "600", fontSize: 16, marginBottom: 12 }}>{restauranteSeleccionado.nombre}</Text>
          <View style={[styles.card, { marginBottom: 16 }]}>
            <Text style={{ fontWeight: "600", fontSize: 14, marginBottom: 12 }}>Agregar plato</Text>
            <TextInput placeholder="Nombre del plato" value={nuevoPlato.nombre} onChangeText={(t) => setNuevoPlato({ ...nuevoPlato, nombre: t })} style={styles.input} />
            <TextInput placeholder="Descripcion (opcional)" value={nuevoPlato.descripcion} onChangeText={(t) => setNuevoPlato({ ...nuevoPlato, descripcion: t })} style={styles.input} />
            <TextInput placeholder="Precio (ej: 15000)" value={nuevoPlato.precio} onChangeText={(t) => setNuevoPlato({ ...nuevoPlato, precio: t })} style={styles.input} keyboardType="numeric" />
            {mensaje ? <Text style={{ color: "#187830", fontSize: 12, marginBottom: 8 }}>{mensaje}</Text> : null}
            <TouchableOpacity style={styles.button} onPress={agregarPlato}>
              <Text style={styles.buttonText}>Agregar plato</Text>
            </TouchableOpacity>
          </View>
          {subiendo && <ActivityIndicator color="#F06000" style={{ marginBottom: 12 }} />}
          <Text style={{ fontWeight: "600", fontSize: 14, marginBottom: 12 }}>Platos ({platos.length})</Text>
          {platos.map((p) => (
            <View key={p.id} style={[styles.card, { marginBottom: 10, flexDirection: "row", alignItems: "center", gap: 10 }]}>
              <TouchableOpacity onPress={() => subirFotoPlato(p.id)}>
                {p.imagen_url ? (
                  <Image source={{ uri: p.imagen_url }} style={{ width: 60, height: 60, borderRadius: 10 }} />
                ) : (
                  <View style={{ width: 60, height: 60, borderRadius: 10, backgroundColor: "#FDEEDC", alignItems: "center", justifyContent: "center" }}>
                    <Text style={{ fontSize: 10, color: "#F06000", textAlign: "center" }}>📷{"\n"}Subir</Text>
                  </View>
                )}
              </TouchableOpacity>
              <View style={{ flex: 1 }}>
                <Text style={{ fontWeight: "600" }}>{p.nombre}</Text>
                {p.descripcion ? <Text style={{ fontSize: 12, color: "#888" }}>{p.descripcion}</Text> : null}
                <Text style={{ fontSize: 13, color: "#F06000", fontWeight: "600" }}>${p.precio.toLocaleString()}</Text>
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
                <TouchableOpacity key={r} style={{ flex: 1, padding: 8, borderRadius: 8, borderWidth: 1, borderColor: nuevoUsuario.rol === r ? "#F06000" : "#ddd", backgroundColor: nuevoUsuario.rol === r ? "#FDEEDC" : "#fff", alignItems: "center" }} onPress={() => setNuevoUsuario({ ...nuevoUsuario, rol: r })}>
                  <Text style={{ fontSize: 10, color: nuevoUsuario.rol === r ? "#F06000" : "#888", fontWeight: nuevoUsuario.rol === r ? "600" : "400" }}>{r}</Text>
                </TouchableOpacity>
              ))}
            </View>
            {nuevoUsuario.rol === "restaurante" && restaurantes.map((r) => (
              <TouchableOpacity key={r.id} style={{ padding: 10, borderRadius: 8, borderWidth: 1, borderColor: nuevoUsuario.restaurante_id === String(r.id) ? "#F06000" : "#ddd", backgroundColor: nuevoUsuario.restaurante_id === String(r.id) ? "#FDEEDC" : "#fff", marginBottom: 8 }} onPress={() => setNuevoUsuario({ ...nuevoUsuario, restaurante_id: String(r.id) })}>
                <Text style={{ fontSize: 13, color: nuevoUsuario.restaurante_id === String(r.id) ? "#F06000" : "#333" }}>{r.nombre}</Text>
              </TouchableOpacity>
            ))}
            {mensaje ? <Text style={{ color: "#187830", fontSize: 12, marginBottom: 8 }}>{mensaje}</Text> : null}
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
              <View style={{ backgroundColor: u.rol === "admin" ? "#FAEEDA" : u.rol === "domiciliario" ? "#E7F3E9" : u.rol === "restaurante" ? "#EAF3DE" : "#F6F1E6", borderRadius: 6, paddingHorizontal: 8, paddingVertical: 4 }}>
                <Text style={{ fontSize: 11, color: u.rol === "admin" ? "#854F0B" : u.rol === "domiciliario" ? "#187830" : u.rol === "restaurante" ? "#187830" : "#888", fontWeight: "600" }}>{u.rol}</Text>
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
      <View style={[styles.header, { backgroundColor: "#F06000" }]}>
        <Text style={styles.headerSub}>Hola, {usuario.nombre} 🛵</Text>
        <Text style={styles.headerTitle}>Mis Entregas</Text>
      </View>
      <View style={{ flexDirection: "row", padding: 16, gap: 12 }}>
        <View style={{ flex: 1, backgroundColor: "#FAEEDA", borderRadius: 12, padding: 12, alignItems: "center" }}>
          <Text style={{ fontSize: 11, color: "#854F0B" }}>Por recoger</Text>
          <Text style={{ fontSize: 22, fontWeight: "bold", color: "#854F0B" }}>{pedidos.filter(p => p.estado === "asignado").length}</Text>
        </View>
        <View style={{ flex: 1, backgroundColor: "#E7F3E9", borderRadius: 12, padding: 12, alignItems: "center" }}>
          <Text style={{ fontSize: 11, color: "#187830" }}>En camino</Text>
          <Text style={{ fontSize: 22, fontWeight: "bold", color: "#187830" }}>{pedidos.filter(p => p.estado === "en camino").length}</Text>
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
              <View style={{ backgroundColor: p.estado === "asignado" ? "#FAEEDA" : "#E7F3E9", borderRadius: 6, paddingHorizontal: 8, paddingVertical: 3 }}>
                <Text style={{ fontSize: 11, color: p.estado === "asignado" ? "#854F0B" : "#187830", fontWeight: "600" }}>{p.estado}</Text>
              </View>
            </View>
            {restaurantes[p.restaurante_id] && (
              <View style={{ backgroundColor: "#FDEEDC", borderRadius: 8, padding: 10, marginBottom: 10 }}>
                <Text style={{ fontSize: 12, fontWeight: "600", color: "#F06000" }}>Recoger en:</Text>
                <Text style={{ fontSize: 14, fontWeight: "600", marginTop: 2 }}>{restaurantes[p.restaurante_id].nombre}</Text>
              </View>
            )}
            <Text style={{ fontSize: 13, color: "#888" }}>👤 {p.cliente_nombre}</Text>
            <Text style={{ fontSize: 13, color: "#888", marginTop: 2 }}>📍 {p.cliente_direccion}</Text>
            <Text style={{ fontSize: 13, color: "#888", marginTop: 2 }}>📞 {p.cliente_telefono}</Text>
            <Text style={{ fontSize: 13, fontWeight: "600", color: "#F06000", marginTop: 4 }}>🍽️ {p.plato}</Text>
            <Text style={{ fontSize: 13, color: "#888", marginTop: 2 }}>💰 ${p.total.toLocaleString()} - {p.metodo_pago}</Text>
            <View style={{ marginTop: 12 }}>
              {p.estado === "asignado" && (
                <TouchableOpacity style={[styles.button, { backgroundColor: "#F06000" }]} onPress={() => cambiarEstado(p.id, "en camino")}>
                  <Text style={styles.buttonText}>Ya recogi — En camino</Text>
                </TouchableOpacity>
              )}
              {p.estado === "en camino" && (
                <TouchableOpacity style={[styles.button, { backgroundColor: "#187830" }]} onPress={() => cambiarEstado(p.id, "entregado")}>
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
    if (estado === "aceptado") return { bg: "#E7F3E9", text: "#187830" };
    if (estado === "preparando") return { bg: "#E7F3E9", text: "#187830" };
    if (estado === "listo") return { bg: "#EAF3DE", text: "#187830" };
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
        <View style={{ flex: 1, backgroundColor: "#E7F3E9", borderRadius: 12, padding: 12, alignItems: "center" }}>
          <Text style={{ fontSize: 11, color: "#187830" }}>Preparando</Text>
          <Text style={{ fontSize: 22, fontWeight: "bold", color: "#187830" }}>{pedidos.filter(p => p.estado === "preparando").length}</Text>
        </View>
        <View style={{ flex: 1, backgroundColor: "#EAF3DE", borderRadius: 12, padding: 12, alignItems: "center" }}>
          <Text style={{ fontSize: 11, color: "#187830" }}>Listos</Text>
          <Text style={{ fontSize: 22, fontWeight: "bold", color: "#187830" }}>{pedidos.filter(p => p.estado === "listo").length}</Text>
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
          <View key={p.id} style={[styles.card, { marginBottom: 12, borderWidth: p.estado === "pendiente" ? 1.5 : 0.5, borderColor: p.estado === "pendiente" ? "#F06000" : "#eee" }]}>
            <View style={{ flexDirection: "row", justifyContent: "space-between", marginBottom: 8 }}>
              <Text style={{ fontWeight: "600" }}>Pedido #{p.id}</Text>
              <View style={{ backgroundColor: colorEstado(p.estado).bg, borderRadius: 6, paddingHorizontal: 8, paddingVertical: 3 }}>
                <Text style={{ fontSize: 11, color: colorEstado(p.estado).text, fontWeight: "600" }}>{p.estado}</Text>
              </View>
            </View>
            <Text style={{ fontSize: 13, color: "#888" }}>👤 {p.cliente_nombre}</Text>
            <Text style={{ fontSize: 13, color: "#888", marginTop: 2 }}>📍 {p.cliente_direccion}</Text>
            <Text style={{ fontSize: 14, fontWeight: "600", color: "#F06000", marginTop: 4 }}>🍽️ {p.plato}</Text>
            <Text style={{ fontSize: 13, color: "#888", marginTop: 2 }}>💰 ${p.total.toLocaleString()} - {p.metodo_pago}</Text>
            <View style={{ marginTop: 12 }}>
              {p.estado === "pendiente" && (
                <TouchableOpacity style={[styles.button, { backgroundColor: "#187830" }]} onPress={() => cambiarEstado(p.id, "aceptado")}>
                  <Text style={styles.buttonText}>Aceptar pedido</Text>
                </TouchableOpacity>
              )}
              {p.estado === "aceptado" && (
                <TouchableOpacity style={[styles.button, { backgroundColor: "#F06000" }]} onPress={() => cambiarEstado(p.id, "preparando")}>
                  <Text style={styles.buttonText}>Empezar a preparar</Text>
                </TouchableOpacity>
              )}
              {p.estado === "preparando" && (
                <TouchableOpacity style={[styles.button, { backgroundColor: "#187830" }]} onPress={() => cambiarEstado(p.id, "listo")}>
                  <Text style={styles.buttonText}>Marcar como listo</Text>
                </TouchableOpacity>
              )}
              {p.estado === "listo" && (
                <View style={{ backgroundColor: "#EAF3DE", borderRadius: 8, padding: 12 }}>
                  <Text style={{ color: "#187830", fontWeight: "600", textAlign: "center" }}>Esperando domiciliario...</Text>
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
  const insets = useSafeAreaInsets();
  return (
    <SafeAreaView style={styles.container}>
      <View style={[styles.header, { flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start" }]}>
        <View>
          <Text style={styles.headerSub}>Hola, {usuario.nombre}</Text>
          <Text style={styles.headerTitle}>Que necesitas hoy?</Text>
        </View>
        <TouchableOpacity onPress={() => navigation.navigate("Configuracion", { usuario })} style={{ padding: 4 }}>
          <Text style={{ fontSize: 24 }}>⚙️</Text>
        </TouchableOpacity>
      </View>
      <ScrollView contentContainerStyle={{ padding: 16 }}>
        <TouchableOpacity style={styles.servicioCard} onPress={() => navigation.navigate("Inicio", { usuario })}>
          <Text style={{ fontSize: 44 }}>🍽️</Text>
          <Text style={styles.servicioTitulo}>Pedir comida</Text>
          <Text style={styles.servicioSub}>Restaurantes de Orito a domicilio</Text>
        </TouchableOpacity>
        <TouchableOpacity style={[styles.servicioCard, { backgroundColor: "#E7F3E9" }]} onPress={() => navigation.navigate("PedirCarrera", { usuario })}>
          <Text style={{ fontSize: 44 }}>🚕</Text>
          <Text style={[styles.servicioTitulo, { color: "#187830" }]}>Pedir carrera</Text>
          <Text style={styles.servicioSub}>Un transportador te recoge</Text>
        </TouchableOpacity>
      </ScrollView>
      <TouchableOpacity style={{ padding: 16, paddingBottom: 16 + insets.bottom, alignItems: "center" }} onPress={() => navigation.replace("Login")}>
        <Text style={{ color: "#888", fontSize: 13 }}>Salir</Text>
      </TouchableOpacity>
    </SafeAreaView>
  );
}

/** Campo de origen/destino: se puede escribir libre (nomenclatura, negocio, lo que sea)
 *  y va sugiriendo lo que otros ya han usado EN ESE MUNICIPIO (no mezcla pueblos). */
function CampoLugar({ etiqueta, valor, onChange, placeholder, municipio, onSeleccionar }) {
  const [sugerencias, setSugerencias] = useState([]);
  const [mostrar, setMostrar] = useState(false);
  const filtroMun = municipio ? `&municipio=${encodeURIComponent(municipio)}` : "";

  const buscar = (texto) => {
    onChange(texto);
    if (texto.trim().length < 2) { setSugerencias([]); return; }
    fetch(`${API}/lugares?buscar=${encodeURIComponent(texto.trim())}${filtroMun}`)
      .then(r => r.json())
      .then(d => { if (Array.isArray(d)) setSugerencias(d); })
      .catch(() => setSugerencias([]));
  };

  const verTodos = () => {
    setMostrar(true);
    fetch(`${API}/lugares?buscar=${filtroMun}`).then(r => r.json())
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
              onPress={() => { onChange(l.nombre); onSeleccionar && onSeleccionar(l); setSugerencias([]); setMostrar(false); }}
            >
              <Text style={{ fontSize: 13, color: "#333" }}>
                {(l.lat ? "✅ " : (l.zona === "rural" ? "🌄 " : "📍 "))}{l.nombre}
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
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"/>
<style>
  html,body,#map{height:100%;margin:0;padding:0;background:#e8e8e8}
  .pin-emoji{font-size:40px;line-height:40px;text-align:center}
  #aviso{position:absolute;top:8px;left:8px;right:8px;z-index:1000;background:#fff3cd;color:#8A5A00;
    font-family:sans-serif;font-size:12px;padding:8px;border-radius:6px;display:none;text-align:center}
  #btnsat{position:absolute;bottom:14px;right:10px;z-index:1000;background:#fff;border:none;
    border-radius:10px;padding:9px 11px;font-size:20px;box-shadow:0 1px 5px rgba(0,0,0,.3)}
</style></head><body>
<div id="map"></div>
<div id="aviso">El mapa no cargo. Puedes cerrar y escribir la direccion.</div>
<button id="btnsat" onclick="alternarSatelite()">🛰️</button>
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
<script>
  if(!window.L){ document.getElementById('aviso').style.display='block'; }
  var map = L.map('map',{zoomControl:true}).setView([${lat}, ${lon}], 17);
  // OSM estandar de primero: es el que muestra nombres de calles Y negocios
  // (el mas parecido a Google Maps, gratis). Respaldo: Carto -> Esri.
  var proveedores = [
    {url:'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', opt:{maxZoom:19, subdomains:'abc'}},
    {url:'https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}.png', opt:{maxZoom:20, subdomains:'abcd'}},
    {url:'https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}', opt:{maxZoom:19}}
  ];
  var idx=0, capa=null, satelite=false, capaSat=null, capaEtiq=null;
  function ponerCapa(){
    if(capa){ map.removeLayer(capa); }
    var p = proveedores[idx];
    capa = L.tileLayer(p.url, p.opt);
    var err=0, ok=false;
    capa.on('load', function(){ ok=true; document.getElementById('aviso').style.display='none'; });
    capa.on('tileerror', function(){
      err++;
      if(err>4 && !ok){
        if(idx < proveedores.length-1){ idx++; ponerCapa(); }   // pasa al siguiente proveedor
        else { document.getElementById('aviso').style.display='block'; }
      }
    });
    capa.addTo(map);
  }
  ponerCapa();
  // boton de satelite como Google: en pueblo la gente encuentra su casa por el techo
  function alternarSatelite(){
    satelite = !satelite;
    document.getElementById('btnsat').textContent = satelite ? '🗺️' : '🛰️';
    if(satelite){
      if(capa) map.removeLayer(capa);
      capaSat = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {maxZoom:19}).addTo(map);
      capaEtiq = L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager_only_labels/{z}/{x}/{y}.png', {maxZoom:20, subdomains:'abcd'}).addTo(map);
    } else {
      if(capaSat) map.removeLayer(capaSat);
      if(capaEtiq) map.removeLayer(capaEtiq);
      ponerCapa();
    }
  }
  // pin de verdad: se queda donde lo pones (tocando el mapa) y se puede arrastrar
  var icono = L.divIcon({html:'📍', className:'pin-emoji', iconSize:[40,40], iconAnchor:[20,38]});
  var pin = L.marker([${lat}, ${lon}], {draggable:true, icon:icono, autoPan:true}).addTo(map);
  function enviar(){
    var p = pin.getLatLng();
    if(window.ReactNativeWebView) window.ReactNativeWebView.postMessage(JSON.stringify({lat:p.lat, lon:p.lng}));
  }
  pin.on('dragend', enviar);
  map.on('click', function(e){ pin.setLatLng(e.latlng); enviar(); });  // tocar = mover el pin ahi
  enviar();
  function irA(la, lo){ pin.setLatLng([la, lo]); map.setView([la, lo], 16); enviar(); }
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
            // baseUrl le da un origen https valido: sin esto Android usa "about:blank"
            // y varios servidores de mapas rechazan las peticiones de imagenes
            source={{ html: mapaHTML(inicial.lat, inicial.lon), baseUrl: "https://orito.app/" }}
            onMessage={(e) => { try { setCoords(JSON.parse(e.nativeEvent.data)); } catch (_) {} }}
            javaScriptEnabled
            domStorageEnabled
            mixedContentMode="always"
            setSupportMultipleWindows={false}
            androidLayerType="hardware"
            style={{ flex: 1 }}
          />
          <Text style={{ textAlign: "center", fontSize: 12, color: "#888", paddingVertical: 6 }}>
            Toca el mapa para poner el pin, o arrastralo al punto exacto
          </Text>
        </View>
        <View style={{ padding: 16, gap: 10 }}>
          <TouchableOpacity style={[styles.button, { backgroundColor: "#fff", borderWidth: 1, borderColor: "#ddd" }]} onPress={usarMiUbicacion} disabled={buscando}>
            {buscando ? <ActivityIndicator color="#187830" /> : <Text style={{ color: "#187830", fontWeight: "600" }}>📍 Usar mi ubicacion</Text>}
          </TouchableOpacity>
          <TouchableOpacity style={[styles.button, { backgroundColor: "#187830" }]} onPress={() => onConfirmar(coords)}>
            <Text style={styles.buttonText}>Confirmar este punto</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    </Modal>
  );
}

/** Mapa de seguimiento: el cliente ve al conductor 🚗 acercarse a su punto 📍.
 *  La camara SIGUE al carro de cerca (como Uber/inDrive): se ve avanzar por la
 *  calle en vez de mostrar toda la ruta alejada. El carrito se desliza suave
 *  entre cada posicion. Botones para "seguir" o "ver toda la ruta".
 *  El HTML no trae coordenadas quemadas: todo llega inyectado desde la app. */
function mapaSeguimientoHTML() {
  return `<!DOCTYPE html><html><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"/>
<style>
  html,body,#map{height:100%;margin:0;padding:0;background:#e8e8e8}
  .em{font-size:34px;line-height:34px;text-align:center}
  .em.carro{filter:drop-shadow(0 2px 3px rgba(0,0,0,.35))}
  #btns{position:absolute;top:10px;right:10px;z-index:1000;display:flex;flex-direction:column;gap:8px}
  #btns button{border:none;border-radius:22px;padding:9px 13px;font-size:13px;font-weight:700;
    box-shadow:0 2px 6px rgba(0,0,0,.25);background:#fff;color:#187830}
  #btns button.on{background:#187830;color:#fff}
</style>
</head><body><div id="map"></div>
<div id="btns">
  <button id="bSeguir" class="on" onclick="modoSeguir()">📍 Seguir</button>
  <button id="bRuta" onclick="modoRuta()">🗺️ Ruta</button>
</div>
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
<script>
  var map = L.map('map',{zoomControl:false}).setView([0.6668, -76.8719], 14);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{maxZoom:19,subdomains:'abc'}).addTo(map);
  var icoPin = L.divIcon({html:'📍', className:'em', iconSize:[34,34], iconAnchor:[17,32]});
  var icoCarro = L.divIcon({html:'🚗', className:'em carro', iconSize:[34,34], iconAnchor:[17,17]});
  var pin = null, carro = null, linea = null, rutaCapa = null, ultimaRuta = null;
  var dLat = null, dLon = null;   // punto de referencia (origen o destino), inyectado
  var seguir = true, primera = true, animId = null;
  var ZOOM = 16;                  // que tan cerca sigue al carro

  function botones(){
    document.getElementById('bSeguir').className = seguir ? 'on' : '';
    document.getElementById('bRuta').className = seguir ? '' : 'on';
  }
  function modoSeguir(){
    seguir = true; botones();
    if(carro){ map.setView(carro.getLatLng(), Math.max(map.getZoom(), ZOOM), {animate:true}); }
  }
  function modoRuta(){
    seguir = false; botones();
    if(rutaCapa){ map.fitBounds(rutaCapa.getBounds().pad(0.15)); }
    else if(carro && dLat != null){ map.fitBounds(L.latLngBounds([carro.getLatLng(), [dLat, dLon]]).pad(0.25)); }
  }
  // si el usuario arrastra el mapa a mano, dejamos de perseguir el carro para no
  // pelearle la camara; puede volver a "Seguir" con el boton
  map.on('dragstart', function(){ if(seguir){ seguir = false; botones(); } });

  function recta(la, lo){
    if(linea){ map.removeLayer(linea); linea = null; }
    if(dLat == null) return;
    linea = L.polyline([[la, lo], [dLat, dLon]], {color:'#187830', weight:3, dashArray:'6 8'}).addTo(map);
  }
  // ruta REAL por las calles (OSRM, gratis). Se recalcula cuando el conductor
  // avanza, asi la linea se va "consumiendo" en tiempo real como en Uber.
  function pedirRuta(la, lo){
    if(dLat == null) return;   // sin referencia no hay a donde trazar
    var url = 'https://router.project-osrm.org/route/v1/driving/' + lo + ',' + la + ';' + dLon + ',' + dLat + '?overview=full&geometries=geojson';
    fetch(url).then(function(r){ return r.json(); }).then(function(d){
      if(!d.routes || !d.routes[0]) throw 0;
      var r = d.routes[0];
      var pts = r.geometry.coordinates.map(function(c){ return [c[1], c[0]]; });
      if(rutaCapa){ map.removeLayer(rutaCapa); }
      if(linea){ map.removeLayer(linea); linea = null; }
      rutaCapa = L.polyline(pts, {color:'#187830', weight:5, opacity:0.85}).addTo(map);
      ultimaRuta = [la, lo];
      if(window.ReactNativeWebView){
        window.ReactNativeWebView.postMessage(JSON.stringify({km: r.distance/1000, min: Math.round(r.duration/60)}));
      }
      // OJO: ya NO se reencuadra a toda la ruta en cada refresco — eso es lo que
      // alejaba el mapa y hacia que el carro se viera quieto
    }).catch(function(){ recta(la, lo); });
  }
  // desliza el carrito de A a B en ~1.4s para que se vea moverse, no saltar
  function animarCarro(desde, hasta){
    if(animId) cancelAnimationFrame(animId);
    var t0 = performance.now(), dur = 1400;
    function paso(now){
      var t = Math.min(1, (now - t0) / dur);
      var la = desde[0] + (hasta[0]-desde[0])*t;
      var lo = desde[1] + (hasta[1]-desde[1])*t;
      carro.setLatLng([la, lo]);
      if(seguir){ map.panTo([la, lo], {animate:false}); }   // camara pegada al carro
      if(t < 1){ animId = requestAnimationFrame(paso); }
    }
    animId = requestAnimationFrame(paso);
  }
  function punto(la, lo){
    dLat = la; dLon = lo;
    if(!pin){ pin = L.marker([la, lo], {icon:icoPin}).addTo(map); }
    else { pin.setLatLng([la, lo]); }
    ultimaRuta = null;   // referencia nueva: la ruta se recalcula
    if(!carro){ map.setView([la, lo], ZOOM); }
    else { var c = carro.getLatLng(); pedirRuta(c.lat, c.lng); }
  }
  function conductor(la, lo){
    if(!carro){
      carro = L.marker([la, lo], {icon:icoCarro}).addTo(map);
      if(primera){ map.setView([la, lo], ZOOM); primera = false; }   // arranca CERCA del carro
    } else {
      var p = carro.getLatLng();
      animarCarro([p.lat, p.lng], [la, lo]);
    }
    // recalcular la ruta solo si se movio ~90m o es la primera vez (no saturar)
    var mover = !ultimaRuta || Math.sqrt(Math.pow(la-ultimaRuta[0],2) + Math.pow(lo-ultimaRuta[1],2)) > 0.0008;
    if(mover){ pedirRuta(la, lo); }
  }
</script></body></html>`;
}

function MapaSeguimiento({ punto, conductor, onInfo, lleno }) {
  const webRef = useRef(null);
  const [listo, setListo] = useState(false);
  // el HTML es FIJO (sin coordenadas) y se genera una sola vez por montaje: si
  // se regenerara en cada refresco, el WebView recargaria el mapa y se
  // "congelaria" perdiendo el 🚗. Las posiciones llegan siempre inyectadas —
  // antes, si la carrera se pedia sin pin, el HTML nacia null y el mapa no
  // aparecia NUNCA aunque el conductor ya estuviera reportando su ubicacion.
  const html = useMemo(() => mapaSeguimientoHTML(), []);
  // cada vez que llega posicion nueva (o el mapa termina de cargar), se inyecta
  useEffect(() => {
    if (!listo || !webRef.current) return;
    if (punto && punto.lat != null) {
      webRef.current.injectJavaScript(`punto(${punto.lat}, ${punto.lon}); true;`);
    }
  }, [listo, punto && punto.lat, punto && punto.lon]);
  useEffect(() => {
    if (!listo || !webRef.current) return;
    if (conductor && conductor.lat != null) {
      webRef.current.injectJavaScript(`conductor(${conductor.lat}, ${conductor.lon}); true;`);
    }
  }, [listo, conductor && conductor.lat, conductor && conductor.lon]);
  // chequeo VIVO en cada render: el mapa se muestra apenas exista alguna
  // coordenada, sin importar cuando llego
  const hayDatos = (punto && punto.lat != null) || (conductor && conductor.lat != null);
  if (!hayDatos) return null;
  return (
    // "lleno": ocupa todo el alto del contenedor (mapa fijo arriba, fuera de la
    // lista deslizable) para que el dedo pueda hacer zoom y arrastrar sin que el
    // scroll de la pantalla le robe el gesto. Si no, el recuadro chico de 240.
    <View style={lleno ? { flex: 1 } : { height: 240, borderRadius: 14, overflow: "hidden", marginBottom: 12 }}>
      <WebView
        ref={webRef}
        originWhitelist={["*"]}
        source={{ html, baseUrl: "https://orito.app/" }}
        onLoadEnd={() => setListo(true)}
        onMessage={(e) => { try { const d = JSON.parse(e.nativeEvent.data); if (d && d.km != null && onInfo) onInfo(d); } catch (_) {} }}
        javaScriptEnabled domStorageEnabled mixedContentMode="always"
        setSupportMultipleWindows={false} androidLayerType="hardware"
        nestedScrollEnabled
        style={{ flex: 1 }}
      />
    </View>
  );
}

/** abre Google Maps con navegacion por voz hacia un punto (gratis: usa la app
 *  de Maps que ya tiene el celular) */
function navegarGoogleMaps(lat, lon) {
  Linking.openURL(`google.navigation:q=${lat},${lon}`)
    .catch(() => Linking.openURL(`https://www.google.com/maps/dir/?api=1&destination=${lat},${lon}`).catch(() => {}));
}

function PedirCarreraScreen({ navigation, route }) {
  const { usuario } = route.params;
  const [carrera, setCarrera] = useState(null);
  const [form, setForm] = useState({ origen: "", origen_detalle: "", destino: "", destino_detalle: "", notas: "" });
  const [vehiculo, setVehiculo] = useState(null);   // sin defecto: el cliente elige
  const [muni, setMuni] = useState(null);           // municipio ACTIVO de esta carrera
  const [municipios, setMunicipios] = useState([]); // todos, para elegir manual
  const [eligiendoMuni, setEligiendoMuni] = useState(false);
  const [origenCoords, setOrigenCoords] = useState(null);
  const [destinoCoords, setDestinoCoords] = useState(null);
  const [estimado, setEstimado] = useState(null);   // {distancia_km, tarifa_sugerida}
  const [mapaAbierto, setMapaAbierto] = useState(null); // "origen" | "destino" | null
  const [oferta, setOferta] = useState("");          // lo que el cliente ofrece pagar
  const [contraofertas, setContraofertas] = useState([]);
  // cuenta regresiva de 6s por contraoferta nueva: cuando el cliente la vio por
  // primera vez. Mientras < 6s se resalta con la cuenta; luego sigue en la lista.
  const VENTANA_OF = 6000;
  const ofRecibidas = useRef({});
  const [ahoraOf, setAhoraOf] = useState(Date.now());
  const [rutaInfo, setRutaInfo] = useState(null);    // {km, min} reales por calle (OSRM)
  const [cargando, setCargando] = useState(false);
  // solicitudes activas del cliente y si esta mirando el formulario en vez del
  // seguimiento: un acarreo puede quedar horas esperando y no debe dejarlo preso
  const [activas, setActivas] = useState([]);
  const [verForm, setVerForm] = useState(false);
  // agendar recogida (solo trasteos): "lo antes posible" (default) o dia+hora
  const [programar, setProgramar] = useState(false);
  const [progDia, setProgDia] = useState(null);
  const [progHora, setProgHora] = useState(null);   // {h, m}

  const vehiculosAqui = (muni && muni.vehiculos) || [];
  // hora agendada final; solo aplica a carga y cuando el cliente eligio dia+hora
  const recogidaISO = (esCarga(vehiculo) && programar && progDia && progHora)
    ? isoLocal(progDia, progHora.h, progHora.m) : null;

  // fija el municipio activo y ajusta el vehiculo si el actual no aplica alli
  const aplicarMuni = (m) => {
    setMuni(m);
    const vs = m.vehiculos || [];
    setVehiculo((v) => (vs.includes(v) ? v : (vs.length === 1 ? vs[0] : null)));
  };

  useEffect(() => {
    fetchReintento(`${API}/municipios`).then(r => r.json())
      .then(d => { if (Array.isArray(d)) setMunicipios(d); }).catch(() => {});
  }, []);

  // el municipio sale de DONDE ESTAS: cuando marcas el origen (GPS o mapa),
  // el servidor dice en que pueblo caes. Si no logra ubicarte, se elige manual.
  useEffect(() => {
    if (!origenCoords) return;
    fetch(`${API}/ubicacion/municipio?lat=${origenCoords.lat}&lon=${origenCoords.lon}`)
      .then(r => r.json())
      .then(d => { if (d && !d.detail) aplicarMuni(d); })
      .catch(() => {});
  }, [origenCoords]);

  // cuando hay origen, destino y vehiculo, estima distancia y tarifa sugerida
  useEffect(() => {
    if (!muni || !muni.usa_gps || !origenCoords || !destinoCoords || !vehiculo) { setEstimado(null); return; }
    const p = qs({
      municipio: muni.nombre, vehiculo,
      origen_lat: origenCoords.lat, origen_lon: origenCoords.lon,
      destino_lat: destinoCoords.lat, destino_lon: destinoCoords.lon,
    });
    fetch(`${API}/tarifa?${p}`).then(r => r.json())
      .then(d => {
        if (d && !d.detail) {
          setEstimado(d);
          // precarga la oferta con la sugerencia para que el cliente arranque de ahi
          if (d.tarifa_sugerida && !oferta) setOferta(String(d.tarifa_sugerida));
        }
      }).catch(() => {});
  }, [origenCoords, destinoCoords, muni, vehiculo]);

  // el mapa de marcar abre DONDE ESTAS (GPS), como Uber; si no hay GPS, en el
  // centro del pueblo. Asi el pin queda cerca tuyo y las distancias son reales.
  const [gpsRapido, setGpsRapido] = useState(null);
  useEffect(() => {
    (async () => {
      try {
        const p = await Location.getForegroundPermissionsAsync();
        if (p.status !== "granted") return;
        const pos = await Location.getLastKnownPositionAsync();
        if (pos) setGpsRapido({ lat: pos.coords.latitude, lon: pos.coords.longitude });
      } catch (e) {}
    })();
  }, []);

  const centroMapa = (punto) => {
    if (punto === "origen" && origenCoords) return origenCoords;
    if (punto === "destino" && destinoCoords) return destinoCoords;
    if (gpsRapido) return gpsRapido;
    return muni && muni.centro_lat ? { lat: muni.centro_lat, lon: muni.centro_lon } : null;
  };

  // convierte el pin en un nombre real: sitio conocido cercano ("Gimnasio X")
  // o la nomenclatura ("Carrera 5 # 4-20"). Solo pisa la etiqueta generica.
  const esGenerico = (t) => !t.trim() || t.includes("Punto marcado") || t.includes("Mi ubicacion actual") || t.startsWith("📍") || t.startsWith("🏁");
  const nombrarPunto = (coords, cual) => {
    const p = qs({ lat: coords.lat, lon: coords.lon, municipio: muni ? muni.nombre : null });
    fetch(`${API}/ubicacion/direccion?${p}`).then(r => r.json()).then(d => {
      if (!d || !d.nombre) return;
      setForm(f => {
        const actual = cual === "origen" ? f.origen : f.destino;
        if (!esGenerico(actual)) return f;   // lo que escribio la persona manda
        return cual === "origen" ? { ...f, origen: `📍 ${d.nombre}` } : { ...f, destino: `🏁 ${d.nombre}` };
      });
    }).catch(() => {});
  };

  const confirmarPunto = (coords) => {
    // marcar en el mapa ya deja el punto listo; si no habia texto, se pone una
    // etiqueta para que el conductor tenga referencia y no quede vacio
    if (mapaAbierto === "origen") {
      setOrigenCoords(coords);
      if (!form.origen.trim()) setForm(f => ({ ...f, origen: "📍 Punto marcado en el mapa" }));
      nombrarPunto(coords, "origen");
      // aviso de cordura: marcaste un origen lejisimos de donde estas parado
      if (gpsRapido) {
        const lejos = kmEntre(coords, gpsRapido);
        if (lejos != null && lejos > 30) {
          avisar("Punto muy lejano", `Marcaste el origen a ~${Math.round(lejos)} km de donde estas. Si es un error, vuelve a abrir el mapa y usa "Usar mi ubicacion".`);
        }
      }
    } else if (mapaAbierto === "destino") {
      setDestinoCoords(coords);
      if (!form.destino.trim()) setForm(f => ({ ...f, destino: "🏁 Punto marcado en el mapa" }));
      nombrarPunto(coords, "destino");
    }
    setMapaAbierto(null);
  };

  // GPS de un toque: marca el origen con la ubicacion actual sin abrir el mapa
  const [buscandoGps, setBuscandoGps] = useState(false);
  const usarUbicacionActual = async () => {
    try {
      setBuscandoGps(true);
      const permiso = await Location.requestForegroundPermissionsAsync();
      if (permiso.status !== "granted") {
        avisar("Permiso de ubicacion", "Para usar tu ubicacion activa el permiso, o marca el punto en el mapa.");
        return;
      }
      const pos = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High });
      const coords = { lat: pos.coords.latitude, lon: pos.coords.longitude };
      setOrigenCoords(coords);
      if (!form.origen.trim()) setForm(f => ({ ...f, origen: "📍 Mi ubicacion actual" }));
      nombrarPunto(coords, "origen");
    } catch (e) {
      avisar("GPS", "No pudimos tomar tu ubicacion. Marca el punto en el mapa.");
    } finally { setBuscandoGps(false); }
  };

  const cargarActiva = () => {
    fetch(`${API}/carreras/cliente/${usuario.id}`)
      .then(r => r.json())
      .then(d => {
        if (!Array.isArray(d)) return;
        const act = d.filter(c => ["buscando", "aceptada", "en_camino"].includes(c.estado));
        setActivas(act);
        // se conserva la que se esta mirando; si ya termino, pasa a la siguiente
        setCarrera(prev => (prev && act.find(c => c.id === prev.id)) || act[0] || null);
      })
      .catch(() => {});
  };

  useEffect(() => {
    cargarActiva();
    // refresco en vivo cada 4s: el estado de la carrera (aceptada, en camino) se
    // actualiza casi al momento, ademas de la notificacion push
    const intervalo = setInterval(cargarActiva, 4000);
    const aviso = Notifications.addNotificationReceivedListener(cargarActiva);
    const toque = Notifications.addNotificationResponseReceivedListener(cargarActiva);
    return () => { clearInterval(intervalo); aviso.remove(); toque.remove(); };
  }, []);

  const pedir = () => {
    if (!muni) { avisar("Falta el municipio", "Marca donde estas o elige el municipio."); return; }
    // cada punto se cumple de UNA sola forma: texto/lista O pin en el mapa. No las dos.
    const origenListo = form.origen.trim() || origenCoords;
    const destinoListo = form.destino.trim() || destinoCoords;
    if (!origenListo) { avisar("Falta el origen", "Escribe donde estas, elige de la lista o marcalo en el mapa"); return; }
    if (!destinoListo) { avisar("Falta el destino", "Escribe para donde vas, elige de la lista o marcalo en el mapa"); return; }
    if (!vehiculo) { avisar("Falta el vehiculo", "Elige que necesitas: carrera o trasteo"); return; }
    // en trasteos, si eligio "programar" pero no completo dia y hora, se avisa
    if (esCarga(vehiculo) && programar && !recogidaISO) {
      avisar("Falta la hora", "Elige el dia y la hora de recogida, o toca 'Lo antes posible'."); return;
    }
    if (!oferta.trim()) { avisar("Falta tu oferta", "Escribe cuanto ofreces pagar"); return; }
    setCargando(true);
    const datos = {
      cliente_id: usuario.id,
      origen: form.origen.trim() || "Punto marcado en el mapa",
      destino: form.destino.trim() || "Punto marcado en el mapa",
      origen_detalle: form.origen_detalle.trim(), destino_detalle: form.destino_detalle.trim(),
      notas: form.notas.trim(), vehiculo_pedido: vehiculo, municipio: muni.nombre,
    };
    if (origenCoords) { datos.origen_lat = origenCoords.lat; datos.origen_lon = origenCoords.lon; }
    if (destinoCoords) { datos.destino_lat = destinoCoords.lat; datos.destino_lon = destinoCoords.lon; }
    const ofertaNum = parseInt((oferta || "").replace(/\D/g, ""), 10);
    if (ofertaNum) datos.tarifa_ofrecida = ofertaNum;
    if (recogidaISO) datos.recogida = recogidaISO;
    fetchReintento(`${API}/carreras?${qs(datos)}`, { method: "POST", headers: { "X-User-Token": llaveUsuario || "" } })
      .then(async (r) => {
        setCargando(false);
        const d = await r.json().catch(() => null);
        if (r.status === 401) {   // sesion vencida o app vieja: se manda a entrar de nuevo
          avisar("Vuelve a entrar", "Tu sesion se venció. Ingresa de nuevo con tu telefono y contraseña.");
          navigation.replace("Login"); return;
        }
        if (!r.ok) { avisar("No se pudo pedir", (d && d.detail) || `El servidor respondio ${r.status}`); return; }
        if (!d || !d.id) { avisar("Error", "Respuesta inesperada del servidor."); return; }
        setForm({ origen: "", origen_detalle: "", destino: "", destino_detalle: "", notas: "" });
        setOrigenCoords(null); setDestinoCoords(null); setEstimado(null); setOferta("");
        setProgramar(false); setProgDia(null); setProgHora(null);
        setCarrera(d); setVerForm(false);   // muestra el seguimiento de la recien pedida
      })
      .catch(() => { setCargando(false); avisar("Sin conexion", "No pudimos enviar tu carrera. Verifica tu internet e intenta de nuevo."); });
  };

  const cancelar = () => {
    confirmar("Cancelar carrera", "Seguro que quieres cancelar?",
      () => userFetch(`${API}/carreras/${carrera.id}/estado?estado=cancelada`, { method: "PUT" })
        .then(() => { setCarrera(null); setContraofertas([]); })
        .catch(() => avisar("Error", "No se pudo cancelar")),
      "Si, cancelar");
  };

  // mientras la carrera busca, se traen las contraofertas de los conductores
  useEffect(() => {
    if (!carrera || carrera.estado !== "buscando") { setContraofertas([]); return; }
    const traer = () => fetch(`${API}/carreras/${carrera.id}/ofertas`).then(r => r.json())
      .then(d => {
        if (!Array.isArray(d)) return;
        const t = Date.now();
        d.forEach(of => { if (!ofRecibidas.current[of.id]) ofRecibidas.current[of.id] = t; });
        setContraofertas(d);
      }).catch(() => {});
    traer();
    const t = setInterval(traer, 3000);   // 3s: para que la contraoferta llegue rapido
    return () => clearInterval(t);
  }, [carrera]);

  // reloj de la cuenta regresiva de las contraofertas (solo si hay alguna fresca)
  useEffect(() => {
    const hayFrescas = contraofertas.some(of => (Date.now() - (ofRecibidas.current[of.id] || 0)) < VENTANA_OF);
    if (!hayFrescas) return;
    const t = setInterval(() => setAhoraOf(Date.now()), 300);
    return () => clearInterval(t);
  }, [contraofertas, ahoraOf]);

  const aceptarContraoferta = (of) => {
    confirmar("Aceptar este precio", `${of.conductor_nombre} por $${of.monto.toLocaleString()}?`,
      () => userFetch(`${API}/carreras/${carrera.id}/aceptar-oferta?oferta_id=${of.id}`, { method: "PUT" })
        .then(r => r.json())
        .then(d => { if (d.detail) { avisar("No se pudo", d.detail); } else { setCarrera(d); setContraofertas([]); } })
        .catch(() => avisar("Error", "No hay conexion")),
      "Aceptar");
  };

  // --- ya tiene una solicitud en curso: se le hace seguimiento (salvo que haya
  //     tocado "pedir otro servicio" y este mirando el formulario)
  if (carrera && !verForm) {
    const buscando = carrera.estado === "buscando";
    const tituloEstado = {
      buscando: "Buscando transportador...",
      aceptada: "Tu conductor va en camino",
      en_camino: "En viaje a tu destino",
    }[carrera.estado] || "Tu carrera";
    // mientras viene a recogerte, el punto de referencia es tu ORIGEN;
    // ya con vos a bordo, el DESTINO
    const punto = carrera.estado === "aceptada"
      ? (carrera.origen_lat != null ? { lat: carrera.origen_lat, lon: carrera.origen_lon } : null)
      : (carrera.destino_lat != null ? { lat: carrera.destino_lat, lon: carrera.destino_lon } : null);
    const cond = carrera.conductor_lat != null ? { lat: carrera.conductor_lat, lon: carrera.conductor_lon } : null;
    const dist = punto && cond ? kmEntre(cond, punto) : null;
    const info = rutaInfo;   // km/min reales por calle si OSRM respondio
    // el mapa va FIJO arriba (fuera del scroll) para que se pueda hacer zoom y
    // arrastrar con el dedo — dentro de la lista, el scroll le robaba el gesto
    const hayMapa = !buscando && (punto || cond);
    return (
      <SafeAreaView style={styles.container}>
        <View style={[styles.header, { backgroundColor: "#187830" }]}>
          <Text style={styles.headerSub}>Carrera #{carrera.id}</Text>
          <Text style={styles.headerTitle}>{tituloEstado}</Text>
        </View>

        {hayMapa && (
          <View style={{ height: 300, backgroundColor: "#e8e8e8" }}>
            <MapaSeguimiento key={carrera.estado} punto={punto} conductor={cond} onInfo={setRutaInfo} lleno />
          </View>
        )}

        <ScrollView contentContainerStyle={{ padding: 16 }}>
          {/* si tiene varias solicitudes abiertas, puede saltar entre ellas */}
          {activas.length > 1 && (
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8, marginBottom: 12 }}>
              {activas.map((a) => (
                <TouchableOpacity key={a.id} onPress={() => { setCarrera(a); setRutaInfo(null); }}
                  style={[styles.chip, carrera.id === a.id && styles.chipOn]}>
                  <Text style={[styles.chipTxt, carrera.id === a.id && styles.chipTxtOn]}>
                    {vehIcono(a.vehiculo_pedido)} #{a.id}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>
          )}
          {!buscando && (
            <View style={styles.pasos}>
              {[["aceptada", "✓ Aceptada"], ["en_camino", "🚗 En camino"], ["finalizada", "🏁 Fin"]].map(([est, lbl], i) => {
                const orden = { aceptada: 0, en_camino: 1, finalizada: 2 };
                const activo = orden[carrera.estado] >= i;
                return (
                  <View key={est} style={[styles.paso, activo && styles.pasoActivo]}>
                    <Text style={{ fontSize: 12, fontWeight: "600", color: activo ? "#fff" : "#999" }}>{lbl}</Text>
                  </View>
                );
              })}
            </View>
          )}
          {hayMapa && (info || dist != null) && (
            <View style={{ backgroundColor: "#EAF6EC", borderRadius: 10, padding: 10, marginBottom: 12, alignItems: "center" }}>
              <Text style={{ fontSize: 15, fontWeight: "700", color: "#187830" }}>
                🚗 {carrera.estado === "aceptada" ? "Tu conductor esta a" : "Faltan"}{" "}
                {info
                  ? `${info.km < 1 ? `${Math.round(info.km * 1000)} m` : `${info.km.toFixed(1)} km`} · ~${Math.max(1, info.min)} min`
                  : `~${dist < 1 ? `${Math.round(dist * 1000)} m` : `${dist.toFixed(1)} km`}`}
              </Text>
              {carrera.conductor_ubic_fecha && (Date.now() - new Date(carrera.conductor_ubic_fecha).getTime()) > 90000 && (
                <Text style={{ fontSize: 11, color: "#8A5A00" }}>ubicacion de {haceCuanto(carrera.conductor_ubic_fecha)}</Text>
              )}
            </View>
          )}
          {buscando ? (
            <>
              <View style={[styles.card, { alignItems: "center", paddingVertical: 24 }]}>
                <ActivityIndicator size="large" color="#187830" />
                <Text style={{ color: "#888", marginTop: 12, textAlign: "center" }}>
                  {carrera.tarifa_ofrecida
                    ? `Ofreciste $${carrera.tarifa_ofrecida.toLocaleString()}. Esperando que un conductor acepte o te proponga otro precio.`
                    : "Avisamos a los transportadores disponibles."}
                  {"\n"}
                  {esCarga(carrera.vehiculo_pedido)
                    ? "Tu solicitud queda publicada hasta que alguien la tome. Te avisamos por notificacion."
                    : "No cierres la app."}
                </Text>
              </View>

              {/* la solicitud sigue viva; el cliente no queda preso en esta pantalla */}
              <TouchableOpacity
                style={[styles.button, { backgroundColor: "#fff", borderWidth: 1, borderColor: "#187830", marginBottom: 12 }]}
                onPress={() => setVerForm(true)}
              >
                <Text style={{ color: "#187830", fontWeight: "700" }}>＋ Pedir otro servicio</Text>
              </TouchableOpacity>

              {contraofertas.length > 0 && (
                <>
                  <Text style={styles.seccionTitulo}>Precios que te proponen</Text>
                  {contraofertas.map((of) => {
                    // fresca (< 6s): resaltada con cuenta regresiva; luego sigue
                    // en la lista, aceptable, sin la cuenta
                    const restante = VENTANA_OF - (ahoraOf - (ofRecibidas.current[of.id] || 0));
                    const fresca = restante > 0;
                    const seg = Math.max(1, Math.ceil(restante / 1000));
                    const pct = Math.max(0, Math.min(100, (restante / VENTANA_OF) * 100));
                    return (
                    <View key={of.id} style={fresca ? [styles.urgente, { padding: 14 }] : [styles.card, { marginBottom: 10 }]}>
                      {fresca && (
                        <>
                          <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
                            <Text style={{ fontSize: 12, letterSpacing: 1, color: "#B85C00", fontWeight: "800" }}>NUEVA OFERTA</Text>
                            <View style={styles.cuenta}><Text style={{ color: "#fff", fontWeight: "800", fontSize: 14 }}>{seg}</Text></View>
                          </View>
                          <View style={styles.barraFondo}><View style={[styles.barra, { width: `${pct}%` }]} /></View>
                        </>
                      )}
                      <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginTop: fresca ? 10 : 0 }}>
                        <View style={{ flex: 1 }}>
                          <Text style={{ fontWeight: "600", fontSize: 15 }}>{of.conductor_nombre}</Text>
                          <Text style={{ fontSize: 12, color: "#888", marginTop: 2 }}>
                            {vehIcono(of.conductor_tipo)} {of.conductor_placa || ""}
                          </Text>
                        </View>
                        <Text style={{ fontSize: 22, fontWeight: "bold", color: "#187830" }}>${of.monto.toLocaleString()}</Text>
                      </View>
                      <TouchableOpacity style={[styles.button, { backgroundColor: "#187830", marginTop: 10, padding: 11 }]} onPress={() => aceptarContraoferta(of)}>
                        <Text style={[styles.buttonText, { fontSize: 14 }]}>Aceptar a este precio</Text>
                      </TouchableOpacity>
                    </View>
                    );
                  })}
                </>
              )}
            </>
          ) : (
            <>
            <View style={[styles.card, { marginBottom: 12 }]}>
              <Text style={{ fontSize: 12, color: "#888" }}>Tu transportador</Text>
              <View style={{ flexDirection: "row", alignItems: "center", gap: 12, marginTop: 4 }}>
                {carrera.conductor_foto ? (
                  <Image source={{ uri: carrera.conductor_foto }} style={{ width: 56, height: 56, borderRadius: 28 }} />
                ) : (
                  <View style={{ width: 56, height: 56, borderRadius: 28, backgroundColor: "#EAF6EC", alignItems: "center", justifyContent: "center" }}>
                    <Text style={{ fontSize: 26 }}>👤</Text>
                  </View>
                )}
                <View style={{ flex: 1 }}>
                  <Text style={{ fontSize: 20, fontWeight: "bold", color: "#333" }}>{carrera.conductor_nombre}</Text>
                  {carrera.conductor_vehiculo ? <Text style={{ fontSize: 14, color: "#555", marginTop: 2 }}>🚕 {carrera.conductor_vehiculo}</Text> : null}
                </View>
              </View>
              {carrera.conductor_foto_vehiculo ? (
                <Image source={{ uri: carrera.conductor_foto_vehiculo }} style={{ width: "100%", height: 140, borderRadius: 10, marginTop: 10 }} />
              ) : null}
              {carrera.conductor_placa ? (
                <View style={styles.placaBadge}><Text style={styles.placaTexto}>{carrera.conductor_placa}</Text></View>
              ) : null}
              <View style={{ flexDirection: "row", gap: 10, marginTop: 12 }}>
                <TouchableOpacity style={[styles.button, { flex: 1, backgroundColor: "#187830" }]} onPress={() => llamar(carrera.conductor_telefono)}>
                  <Text style={[styles.buttonText, { fontSize: 15 }]}>📞 Llamar</Text>
                </TouchableOpacity>
                <TouchableOpacity style={[styles.button, { flex: 1, backgroundColor: "#25D366" }]} onPress={() => whatsapp(carrera.conductor_telefono)}>
                  <Text style={[styles.buttonText, { fontSize: 15 }]}>💬 WhatsApp</Text>
                </TouchableOpacity>
              </View>

              {carrera.conductor_pagos && (
                <View style={{ marginTop: 12, backgroundColor: "#EAF6EC", borderRadius: 10, padding: 12 }}>
                  <Text style={{ fontSize: 12, color: "#666", marginBottom: 6, fontWeight: "600" }}>COMO PAGARLE</Text>
                  {carrera.conductor_pagos.efectivo && <Text style={styles.pagoItem}>💵 Efectivo</Text>}
                  {carrera.conductor_pagos.nequi ? <Text style={styles.pagoItem}>📱 Nequi: {carrera.conductor_pagos.nequi}</Text> : null}
                  {carrera.conductor_pagos.daviplata ? <Text style={styles.pagoItem}>📱 Daviplata: {carrera.conductor_pagos.daviplata}</Text> : null}
                  {carrera.conductor_pagos.bancolombia ? <Text style={styles.pagoItem}>🏦 Bancolombia: {carrera.conductor_pagos.bancolombia}</Text> : null}
                  {carrera.conductor_pagos.breb ? <Text style={styles.pagoItem}>🔑 Bre-B: {carrera.conductor_pagos.breb}</Text> : null}
                </View>
              )}
            </View>
            </>
          )}

          <View style={styles.card}>
            {/* el cliente tambien ve el recorrido y, si va en camino, lo que falta */}
            <View style={{ marginBottom: 10, flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
              <Text style={{ fontSize: 14, fontWeight: "700", color: "#444" }}>
                {vehIcono(carrera.vehiculo_pedido)} {vehLabel(carrera.vehiculo_pedido)}
              </Text>
              {carrera.distancia_km != null && (
                <View style={{ backgroundColor: "#FFF3E6", borderRadius: 8, paddingVertical: 4, paddingHorizontal: 8 }}>
                  <Text style={{ fontSize: 13, color: "#B85C00", fontWeight: "700" }}>
                    🛣️ Recorrido ~{carrera.distancia_km < 1
                      ? `${Math.round(carrera.distancia_km * 1000)} m`
                      : `${carrera.distancia_km.toFixed(1)} km`}
                  </Text>
                </View>
              )}
              {carrera.recogida && (
                <View style={{ backgroundColor: "#FFF7E6", borderRadius: 8, paddingVertical: 4, paddingHorizontal: 8 }}>
                  <Text style={{ fontSize: 13, color: "#8A5A00", fontWeight: "700" }}>⏰ Recogida: {fmtRecogida(carrera.recogida)}</Text>
                </View>
              )}
            </View>
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

          {["buscando", "aceptada"].includes(carrera.estado) ? (
            <TouchableOpacity style={[styles.button, { backgroundColor: "#fff", borderWidth: 1, borderColor: "#ddd", marginTop: 16 }]} onPress={cancelar}>
              <Text style={{ color: "#C0392B", fontWeight: "600" }}>Cancelar carrera</Text>
            </TouchableOpacity>
          ) : (
            <Text style={{ textAlign: "center", color: "#888", fontSize: 13, marginTop: 16 }}>
              El viaje esta en curso y ya no se puede cancelar.{"\n"}Si hay un problema, llama al conductor.
            </Text>
          )}
        </ScrollView>
      </SafeAreaView>
    );
  }

  // --- formulario para pedir
  return (
    <SafeAreaView style={styles.container}>
      <View style={[styles.header, { backgroundColor: "#187830", flexDirection: "row", alignItems: "center", gap: 12 }]}>
        <TouchableOpacity onPress={() => navigation.goBack()}>
          <Text style={{ color: "#fff", fontSize: 20 }}>←</Text>
        </TouchableOpacity>
        <View>
          <Text style={styles.headerSub}>{muni ? `Transporte en ${muni.nombre}` : "Transporte"}</Text>
          <Text style={styles.headerTitle}>Pedir carrera</Text>
        </View>
      </View>
      <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 60 }} keyboardShouldPersistTaps="handled">
        {/* sus solicitudes siguen vivas mientras pide otra cosa */}
        {activas.length > 0 && (
          <TouchableOpacity
            style={{ backgroundColor: "#EAF6EC", borderWidth: 1, borderColor: "#187830", borderRadius: 10, padding: 12, marginBottom: 12, flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}
            onPress={() => setVerForm(false)}
          >
            <Text style={{ color: "#187830", fontWeight: "700", fontSize: 13, flex: 1 }}>
              🔔 Tienes {activas.length} solicitud{activas.length > 1 ? "es" : ""} en curso
            </Text>
            <Text style={{ color: "#187830", fontSize: 12 }}>ver ›</Text>
          </TouchableOpacity>
        )}
        {/* 1. UBICACION: primero, porque de aqui se detecta el pueblo */}
        <View style={styles.card}>
          <Text style={styles.etiqueta}>DONDE ESTAS</Text>
          <TouchableOpacity style={[styles.botonGps]} onPress={usarUbicacionActual} disabled={buscandoGps}>
            {buscandoGps
              ? <ActivityIndicator color="#fff" />
              : <Text style={{ color: "#fff", fontWeight: "700" }}>📍 Usar mi ubicacion actual</Text>}
          </TouchableOpacity>
          <TouchableOpacity style={[styles.botonMapa, origenCoords && styles.botonMapaOk]} onPress={() => setMapaAbierto("origen")}>
            <Text style={{ color: origenCoords ? "#187830" : "#187830", fontWeight: "600" }}>
              {origenCoords ? "✓ Ubicacion marcada — cambiar en el mapa" : "🗺️ O marcar en el mapa"}
            </Text>
          </TouchableOpacity>

          {/* municipio detectado o a elegir manual */}
          {muni ? (
            <TouchableOpacity style={styles.muniBanner} onPress={() => setEligiendoMuni(true)}>
              <Text style={{ fontSize: 13, color: "#187830", fontWeight: "600" }}>📌 Estas en {muni.nombre}</Text>
              <Text style={{ fontSize: 12, color: "#888" }}>cambiar</Text>
            </TouchableOpacity>
          ) : (
            <TouchableOpacity style={[styles.muniBanner, { backgroundColor: "#FFF4E0" }]} onPress={() => setEligiendoMuni(true)}>
              <Text style={{ fontSize: 13, color: "#8A5A00", fontWeight: "600" }}>¿En que municipio estas?</Text>
              <Text style={{ fontSize: 12, color: "#8A5A00" }}>elegir</Text>
            </TouchableOpacity>
          )}
          {eligiendoMuni && (
            <View style={{ flexDirection: "row", gap: 8, marginTop: 8, flexWrap: "wrap" }}>
              {municipios.map(m => (
                <TouchableOpacity key={m.nombre}
                  style={[styles.opcion, muni && muni.nombre === m.nombre && styles.opcionActiva]}
                  onPress={() => { aplicarMuni(m); setEligiendoMuni(false); }}>
                  <Text style={[styles.opcionTexto, muni && muni.nombre === m.nombre && styles.opcionTextoActivo]}>{m.nombre}</Text>
                </TouchableOpacity>
              ))}
            </View>
          )}

          <Text style={styles.ayuda}>Con el mapa o el GPS ya basta. Si prefieres, tambien puedes escribir o elegir de la lista:</Text>
          <CampoLugar
            etiqueta="EL SITIO (opcional si ya marcaste)"
            valor={form.origen}
            onChange={(t) => setForm({ ...form, origen: t })}
            placeholder="Ej: Parque Central o Carrera 5a # 4-20"
            municipio={muni ? muni.nombre : usuario.municipio}
            onSeleccionar={(l) => { if (l.lat != null) setOrigenCoords({ lat: l.lat, lon: l.lon }); }}
          />
          <TextInput
            value={form.origen_detalle}
            onChangeText={(t) => setForm({ ...form, origen_detalle: t })}
            placeholder="Detalle para encontrarte (opcional): porton azul, 2 pisos..."
            style={styles.input}
            multiline
          />
        </View>

        {/* 2. VEHICULO: personas (carrera) y carga (trasteo/acarreo), segun el pueblo */}
        {muni && vehiculosAqui.length > 0 && (
          <View style={styles.card}>
            {ordenVehiculos(vehiculosAqui).some((v) => !esCarga(v)) && (
              <>
                <Text style={styles.etiqueta}>QUE NECESITAS</Text>
                <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
                  {ordenVehiculos(vehiculosAqui).filter((v) => !esCarga(v)).map((v) => (
                    <TouchableOpacity
                      key={v}
                      style={[styles.chip, vehiculo === v && styles.chipOn]}
                      onPress={() => setVehiculo(v)}
                    >
                      <Text style={[styles.chipTxt, vehiculo === v && styles.chipTxtOn]}>{vehIcono(v)} {vehLabel(v)}</Text>
                    </TouchableOpacity>
                  ))}
                </View>
              </>
            )}
            {ordenVehiculos(vehiculosAqui).some(esCarga) && (
              <>
                <Text style={[styles.etiqueta, { marginTop: 14 }]}>🚚 TRASTEO O ACARREO</Text>
                <Text style={styles.ayuda}>Para mudanzas, mercancia o carga</Text>
                <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 6 }}>
                  {ordenVehiculos(vehiculosAqui).filter(esCarga).map((v) => (
                    <TouchableOpacity
                      key={v}
                      style={[styles.chip, vehiculo === v && styles.chipOn]}
                      onPress={() => setVehiculo(v)}
                    >
                      <Text style={[styles.chipTxt, vehiculo === v && styles.chipTxtOn]}>{vehIcono(v)} {vehLabel(v)}</Text>
                    </TouchableOpacity>
                  ))}
                </View>
              </>
            )}
          </View>
        )}

        {/* 2b. TRASTEO: descripcion de la carga + hora de recogida (solo carga) */}
        {muni && esCarga(vehiculo) && (
          <View style={styles.card}>
            <Text style={styles.etiqueta}>DESCRIPCION DE LA CARGA</Text>
            <TextInput
              value={form.notas}
              onChangeText={(t) => setForm({ ...form, notas: t })}
              placeholder="Ej: dos neveras, una lavadora y varias cajas"
              style={[styles.input, { minHeight: 60 }]}
              multiline
            />
            <Text style={[styles.ayuda, { marginTop: -2 }]}>Asi el transportador sabe que va a mover y con que ayuda</Text>

            <Text style={[styles.etiqueta, { marginTop: 8 }]}>PARA CUANDO</Text>
            <View style={{ flexDirection: "row", gap: 8 }}>
              <TouchableOpacity
                style={[styles.opcion, !programar && styles.opcionActiva]}
                onPress={() => setProgramar(false)}
              >
                <Text style={[styles.opcionTexto, !programar && styles.opcionTextoActivo]}>Lo antes posible</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.opcion, programar && styles.opcionActiva]}
                onPress={() => setProgramar(true)}
              >
                <Text style={[styles.opcionTexto, programar && styles.opcionTextoActivo]}>Programar</Text>
              </TouchableOpacity>
            </View>
            {programar && (
              <>
                <Text style={[styles.ayuda, { marginTop: 12 }]}>Dia</Text>
                <ScrollView horizontal showsHorizontalScrollIndicator={false}>
                  <View style={{ flexDirection: "row", gap: 8, paddingVertical: 4 }}>
                    {diasProximos().map((x) => {
                      const act = progDia && progDia.toDateString() === x.d.toDateString();
                      return (
                        <TouchableOpacity key={x.key} onPress={() => setProgDia(x.d)}
                          style={[styles.chip, act && styles.chipOn]}>
                          <Text style={[styles.chipTxt, act && styles.chipTxtOn]}>{x.lbl}</Text>
                        </TouchableOpacity>
                      );
                    })}
                  </View>
                </ScrollView>
                <Text style={[styles.ayuda, { marginTop: 8 }]}>Hora</Text>
                <ScrollView horizontal showsHorizontalScrollIndicator={false}>
                  <View style={{ flexDirection: "row", gap: 8, paddingVertical: 4 }}>
                    {horasDelDia().map((x) => {
                      const act = progHora && progHora.h === x.h && progHora.m === x.m;
                      return (
                        <TouchableOpacity key={x.lbl} onPress={() => setProgHora({ h: x.h, m: x.m })}
                          style={[styles.chip, act && styles.chipOn]}>
                          <Text style={[styles.chipTxt, act && styles.chipTxtOn]}>{x.lbl}</Text>
                        </TouchableOpacity>
                      );
                    })}
                  </View>
                </ScrollView>
                {recogidaISO ? (
                  <View style={{ marginTop: 12, backgroundColor: "#EAF6EC", borderRadius: 8, padding: 10 }}>
                    <Text style={{ color: "#187830", fontWeight: "700", fontSize: 14 }}>⏰ Recogida: {fmtRecogida(recogidaISO)}</Text>
                  </View>
                ) : (
                  <Text style={[styles.ayuda, { marginTop: 10 }]}>Elige el dia y la hora</Text>
                )}
              </>
            )}
          </View>
        )}

        {/* 3. DESTINO */}
        <View style={styles.card}>
          <Text style={styles.etiqueta}>PARA DONDE VAS</Text>
          <TouchableOpacity style={[styles.botonMapa, destinoCoords && styles.botonMapaOk]} onPress={() => setMapaAbierto("destino")}>
            <Text style={{ color: "#187830", fontWeight: "600" }}>
              {destinoCoords ? "✓ Destino marcado — cambiar en el mapa" : "🏁 Marcar a donde vas en el mapa"}
            </Text>
          </TouchableOpacity>
          <Text style={styles.ayuda}>O escribelo / elige de la lista:</Text>
          <CampoLugar
            etiqueta=""
            valor={form.destino}
            onChange={(t) => setForm({ ...form, destino: t })}
            placeholder="Ej: ESE Hospital Orito o Vereda Monserrate"
            municipio={muni ? muni.nombre : usuario.municipio}
            onSeleccionar={(l) => { if (l.lat != null) setDestinoCoords({ lat: l.lat, lon: l.lon }); }}
          />
          <TextInput
            value={form.destino_detalle}
            onChangeText={(t) => setForm({ ...form, destino_detalle: t })}
            placeholder="Detalle del destino (opcional)"
            style={styles.input}
            multiline
          />
          {/* en carga la descripcion va arriba; aqui solo para carreras de personas */}
          {!esCarga(vehiculo) && (
            <TextInput
              value={form.notas}
              onChangeText={(t) => setForm({ ...form, notas: t })}
              placeholder="Algo mas que deba saber? (opcional)"
              style={styles.input}
            />
          )}
        </View>

        {/* 4. OFERTA */}
        <View style={styles.card}>
          {muni && muni.usa_gps && estimado && estimado.distancia_km && (
            <View style={[styles.estimado, { marginBottom: 12 }]}>
              <Text style={{ fontSize: 13, color: "#555" }}>Distancia: {estimado.distancia_km} km</Text>
              {estimado.tarifa_sugerida ? (
                <Text style={{ fontSize: 13, color: "#888", marginTop: 2 }}>
                  La gente suele pagar ~${estimado.tarifa_sugerida.toLocaleString()}
                </Text>
              ) : null}
            </View>
          )}
          <Text style={styles.etiqueta}>CUANTO OFRECES PAGAR</Text>
          <View style={styles.ofertaFila}>
            <Text style={{ fontSize: 22, fontWeight: "bold", color: "#187830" }}>$</Text>
            <TextInput
              value={oferta}
              onChangeText={(t) => setOferta(t.replace(/\D/g, ""))}
              placeholder="0"
              keyboardType="number-pad"
              style={styles.ofertaInput}
            />
          </View>
          <Text style={styles.ayuda}>Un conductor puede aceptar tu precio o proponerte otro, y tu eliges</Text>
        </View>

        <TouchableOpacity style={[styles.button, { backgroundColor: "#F06000", marginTop: 16 }]} onPress={pedir} disabled={cargando}>
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
  // en Samsung y otros con botones de navegacion en pantalla, la barra del
  // sistema tapa las pestañas si no se respeta el area segura inferior
  const insets = useSafeAreaInsets();
  const [disponibles, setDisponibles] = useState([]);
  const [mias, setMias] = useState([]);
  const [disponible, setDisponible] = useState(usuario.disponible === "si");
  // el setInterval de cargar() captura el 'disponible' del primer render (stale
  // closure); este ref siempre tiene el valor actual para el ping
  const dispRef = useRef(usuario.disponible === "si");
  const [cuenta, setCuenta] = useState(null);
  const [stats, setStats] = useState(null);
  const [tab, setTab] = useState("solicitudes");
  const [miUbic, setMiUbic] = useState(null);   // ubicacion del conductor, para calcular distancia a cada carrera
  const [rutaCond, setRutaCond] = useState(null);   // {km, min} de su ruta por calles
  const [rutaPreview, setRutaPreview] = useState(null);   // {km,min} ruta a la recogida de la solicitud enfocada (antes de aceptar)
  const [permisoFondo, setPermisoFondo] = useState(true);   // "todo el tiempo": para transmitir con la app cerrada
  // cuenta regresiva de 6s por solicitud nueva: guardamos cuando la vimos por
  // primera vez. Mientras < 6s se muestra grande con contraoferta rapida; luego
  // baja al listado normal (sigue disponible). primeraCarga evita sonar al abrir.
  const VENTANA = 6000;
  const recibidas = useRef({});
  const idsVistos = useRef(null);
  const [ahora, setAhora] = useState(Date.now());

  useEffect(() => {
    if (Platform.OS === "web") return;
    Location.getBackgroundPermissionsAsync()
      .then((p) => setPermisoFondo(p.status === "granted"))
      .catch(() => {});
  }, []);

  const pedirPermisoFondo = async () => {
    try {
      const p = await Location.requestBackgroundPermissionsAsync();
      if (p.status === "granted") { setPermisoFondo(true); return; }
      // Android moderno manda a Ajustes: se le explica que debe elegir alli
      avisar("Un paso mas", 'En la pantalla que se abre, entra a "Permisos" > "Ubicacion" y elige "Permitir todo el tiempo".');
      Linking.openSettings().catch(() => {});
    } catch (e) {}
  };

  // ubicacion del conductor una vez, para mostrar "a X km" de cada solicitud
  useEffect(() => {
    (async () => {
      try {
        const permiso = await Location.getForegroundPermissionsAsync();
        if (permiso.status !== "granted") {
          const pedir = await Location.requestForegroundPermissionsAsync();
          if (pedir.status !== "granted") return;
        }
        const pos = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
        setMiUbic({ lat: pos.coords.latitude, lon: pos.coords.longitude });
      } catch (e) {}
    })();
  }, []);

  // suena un ping fuerte dentro de la app cuando llega una solicitud nueva
  // (ademas del push). Usa el mismo canal MAX, asi no depende de que el push
  // alcance a llegar mientras el conductor mira la pantalla.
  const pingSolicitud = () => {
    if (Platform.OS === "web") return;
    // vibracion fuerte: se siente aunque el telefono este en silencio (no
    // depende del permiso de notificaciones ni de modulos nativos extra)
    try { Vibration.vibrate([0, 500, 220, 500]); } catch (e) {}
    // ademas el tono de notificacion (si dio permiso y no esta en silencio)
    Notifications.scheduleNotificationAsync({
      content: { title: "🔔 Nueva solicitud de carrera", body: "Toca para verla y responder.", sound: "tono.wav" },
      trigger: Platform.OS === "android" ? { channelId: "carreras2", seconds: 1 } : null,
    }).catch(() => {});
  };

  const cargar = () => {
    // con conductor_id el servidor filtra por municipio y tipo de vehiculo
    fetch(`${API}/carreras/disponibles?conductor_id=${usuario.id}`).then(r => r.json())
      .then(d => {
        if (!Array.isArray(d)) return;
        const t = Date.now();
        const idsAhora = new Set(d.map(c => c.id));
        // primera vez que vemos cada solicitud -> arranca su ventana de 6s
        d.forEach(c => { if (!recibidas.current[c.id]) recibidas.current[c.id] = t; });
        // detectar nuevas (no en la carga anterior) para el ping; en la primera
        // carga solo memorizamos, no sonamos, para no pitar al abrir la app
        if (idsVistos.current === null) {
          idsVistos.current = idsAhora;
        } else {
          const hayNueva = d.some(c => !idsVistos.current.has(c.id));
          idsVistos.current = idsAhora;
          if (hayNueva && dispRef.current) pingSolicitud();
        }
        animar(); setDisponibles(d);
      }).catch(() => {});
    fetch(`${API}/carreras/conductor/${usuario.id}`).then(r => r.json())
      .then(d => { if (Array.isArray(d)) setMias(d.filter(c => ["aceptada", "en_camino"].includes(c.estado))); })
      .catch(() => {});
    fetch(`${API}/conductores/${usuario.id}/estado-cuenta`).then(r => r.json())
      .then(d => { if (d && !d.detail) setCuenta(d); }).catch(() => {});
    fetch(`${API}/conductores/${usuario.id}/estadisticas`).then(r => r.json())
      .then(d => { if (d && !d.detail) setStats(d); }).catch(() => {});
  };

  useEffect(() => {
    cargar();
    // refresco en vivo cada 3s (mas la notificacion push instantanea) para que
    // las carreras nuevas aparezcan casi al momento y las tomadas desaparezcan ya
    const intervalo = setInterval(cargar, 3000);
    const aviso = Notifications.addNotificationReceivedListener(cargar);
    const toque = Notifications.addNotificationResponseReceivedListener(cargar);
    return () => { clearInterval(intervalo); aviso.remove(); toque.remove(); };
  }, []);

  // reloj de la cuenta regresiva: solo tictaquea si hay alguna solicitud dentro
  // de su ventana de 6s, para no re-renderizar de gusto
  useEffect(() => {
    const hayFrescas = disponibles.some(c => (Date.now() - (recibidas.current[c.id] || 0)) < VENTANA);
    if (!hayFrescas) return;
    const t = setInterval(() => setAhora(Date.now()), 300);
    return () => clearInterval(t);
  }, [disponibles, ahora]);

  const cambiarDisponibilidad = () => {
    const nuevo = !disponible;
    setDisponible(nuevo);
    dispRef.current = nuevo;
    userFetch(`${API}/conductores/${usuario.id}?disponible=${nuevo ? "si" : "no"}`, { method: "PUT" }).catch(() => {});
  };

  // mientras tiene carrera activa: el servicio en SEGUNDO PLANO transmite la
  // ubicacion (aunque cierre la app o navegue con Google Maps) y ademas, con la
  // app abierta, un refresco cada 8s alimenta su propio mapa en pantalla
  const tieneCarreraActiva = mias.length > 0;
  useEffect(() => {
    if (!tieneCarreraActiva) { detenerRastreoFondo(); return; }
    iniciarRastreoFondo(usuario.id);
    let vivo = true;
    const reportar = async () => {
      try {
        const p = await Location.getForegroundPermissionsAsync();
        if (p.status !== "granted") return;
        const pos = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
        if (!vivo) return;
        setMiUbic({ lat: pos.coords.latitude, lon: pos.coords.longitude });   // alimenta su propio mapa
        fetch(`${API}/conductores/${usuario.id}/ubicacion?lat=${pos.coords.latitude}&lon=${pos.coords.longitude}`, { method: "PUT" }).catch(() => {});
      } catch (e) {}
    };
    reportar();
    const t = setInterval(reportar, 8000);
    return () => { vivo = false; clearInterval(t); };
  }, [tieneCarreraActiva]);

  const aceptar = (c) => {
    // se quita YA del listado (no espera al refresco) para que no la vuelva a
    // tocar y no haya duplicidad; si algo falla, cargar() restaura el estado real
    animar();
    setDisponibles((prev) => prev.filter((x) => x.id !== c.id));
    userFetch(`${API}/carreras/${c.id}/aceptar?conductor_id=${usuario.id}`, { method: "PUT" })
      .then(async (r) => {
        const d = await r.json();
        if (r.status === 409) { avisar("Servicio ya tomado", "Otro transportador lo tomo primero."); cargar(); return; }
        if (r.status === 402) { avisar("Suscripcion vencida", d.detail); cargar(); return; }
        if (d.detail) { avisar("No se pudo", d.detail); cargar(); return; }
        avisar("✅ Servicio asignado", "La carrera es tuya. Ve por el pasajero.");
        cargar();
      })
      .catch(() => { avisar("Error", "No hay conexion. Intenta de nuevo."); cargar(); });
  };

  // Alert.prompt solo existe en iPhone, asi que la ventana del cobro es propia
  const [cobrando, setCobrando] = useState(null);
  const [tarifa, setTarifa] = useState("");

  // llega pre-llenada con el precio ACORDADO: confirmar y listo. Solo se toca
  // si de verdad cambio (evita errores de dedo que dañan las estadisticas)
  const finalizar = (c) => { setTarifa(c.tarifa != null ? String(c.tarifa) : ""); setCobrando(c); };

  const confirmarCobro = () => {
    const t = parseInt((tarifa || "").replace(/\D/g, ""), 10);
    const id = cobrando.id;
    setCobrando(null);
    userFetch(`${API}/carreras/${id}/estado?estado=finalizada${t ? `&tarifa=${t}` : ""}`, { method: "PUT" })
      .then(cargar)
      .catch(() => avisar("Error", "No hay conexion. Intenta de nuevo."));
  };

  const cambiarEstado = (c, estado) => {
    userFetch(`${API}/carreras/${c.id}/estado?estado=${estado}`, { method: "PUT" }).then(cargar).catch(() => {});
  };

  // --- negociacion del lado del conductor
  const [contraofertando, setContraofertando] = useState(null);
  const [montoOferta, setMontoOferta] = useState("");

  // envia una contraoferta al servidor (usada por el teclado y por los botones
  // rapidos de un toque)
  const enviarOferta = (id, monto, silencioso) => {
    userFetch(`${API}/carreras/${id}/ofertas?conductor_id=${usuario.id}&monto=${monto}`, { method: "POST" })
      .then(async (r) => {
        const d = await r.json();
        if (r.status === 409) { avisar("Muy tarde", "Esa carrera ya no esta disponible."); cargar(); return; }
        if (r.status === 402) { avisar("Suscripcion vencida", d.detail); return; }
        if (d.detail) { avisar("No se pudo", d.detail); return; }
        if (!silencioso) avisar("Oferta enviada", "El cliente vera tu precio y decide.");
        cargar();
      })
      .catch(() => avisar("Error", "No hay conexion."));
  };

  const contraofertar = () => {
    const monto = parseInt((montoOferta || "").replace(/\D/g, ""), 10);
    if (!monto) { avisar("Falta el precio", "Escribe cuanto quieres cobrar"); return; }
    const id = contraofertando.id;
    setContraofertando(null); setMontoOferta("");
    enviarOferta(id, monto);
  };

  // contraoferta de UN toque: precios sugeridos por encima de lo que ofrece el
  // cliente, redondeados al mil
  const contraofertaRapida = (c, monto) => enviarOferta(c.id, monto, true);
  const sugerencias = (of) => (of ? [of + 1000, of + 2000, of + 3000] : []);

  // tarjeta GRANDE de solicitud recien llegada, con cuenta regresiva de 6s y
  // contraoferta de un toque. Al vencerse, el feed la muestra como tarjeta normal.
  const tarjetaUrgente = (c, restante) => {
    const seg = Math.max(1, Math.ceil(restante / 1000));
    const pct = Math.max(0, Math.min(100, (restante / VENTANA) * 100));
    const kmAlOrigen = miUbic && c.origen_lat != null ? kmEntre(miUbic, { lat: c.origen_lat, lon: c.origen_lon }) : null;
    const fmtKm = (k) => (k < 1 ? `${Math.round(k * 1000)} m` : `${k.toFixed(1)} km`);
    const of = c.tarifa_ofrecida;
    return (
      <View key={c.id} style={styles.urgente}>
        <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
          <Text style={{ fontSize: 12, letterSpacing: 1, color: "#B85C00", fontWeight: "800" }}>
            {esCarga(c.vehiculo_pedido) ? "🚚 NUEVO ACARREO" : "NUEVA SOLICITUD"}
          </Text>
          <View style={styles.cuenta}><Text style={{ color: "#fff", fontWeight: "800", fontSize: 14 }}>{seg}</Text></View>
        </View>
        <View style={styles.barraFondo}><View style={[styles.barra, { width: `${pct}%` }]} /></View>

        <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start", marginTop: 10 }}>
          <View style={{ flex: 1, minWidth: 0 }}>
            {kmAlOrigen != null && <Text style={{ fontSize: 12, color: "#187830", fontWeight: "700", marginBottom: 3 }}>📍 A ~{fmtKm(kmAlOrigen)} de ti</Text>}
            <Text style={{ fontSize: 14, color: "#333" }} numberOfLines={1}>🟢 {c.origen}</Text>
            <Text style={{ fontSize: 14, color: "#333", marginTop: 1 }} numberOfLines={1}>🔴 {c.destino}</Text>
          </View>
          {of ? <Text style={{ fontSize: 24, fontWeight: "800", color: "#187830", paddingLeft: 8 }}>${of.toLocaleString()}</Text> : null}
        </View>

        <TouchableOpacity style={[styles.button, { backgroundColor: "#187830", marginTop: 12, padding: 13 }]} onPress={() => aceptar(c)}>
          <Text style={styles.buttonText}>{of ? `Aceptar $${of.toLocaleString()}` : "Tomar"}</Text>
        </TouchableOpacity>

        {of ? (
          <>
            <Text style={[styles.ayuda, { marginTop: 8, marginBottom: 4 }]}>O contraoferta en un toque:</Text>
            <View style={{ flexDirection: "row", gap: 8 }}>
              {sugerencias(of).map((m) => (
                <TouchableOpacity key={m} style={styles.chipOferta} onPress={() => contraofertaRapida(c, m)}>
                  <Text style={styles.chipOfertaTxt}>${m.toLocaleString()}</Text>
                </TouchableOpacity>
              ))}
              <TouchableOpacity style={styles.chipOtro} onPress={() => { setMontoOferta(String(of)); setContraofertando(c); }}>
                <Text style={{ color: "#888", fontWeight: "700", fontSize: 14 }}>Otro</Text>
              </TouchableOpacity>
            </View>
          </>
        ) : (
          <TouchableOpacity style={[styles.button, { backgroundColor: "#fff", borderWidth: 1, borderColor: "#187830", marginTop: 8, padding: 11 }]} onPress={() => { setContraofertando(c); }}>
            <Text style={{ color: "#187830", fontWeight: "600" }}>Proponer precio</Text>
          </TouchableOpacity>
        )}
      </View>
    );
  };

  const tarjeta = (c, propia) => {
    // dos distancias para decidir ANTES de aceptar:
    //  1) del conductor al punto de recogida (con su GPS)
    //  2) el recorrido del viaje: recogida -> destino (del servidor, con factor
    //     de calle; si no viene, se estima en linea recta con las coordenadas)
    const kmAlOrigen = miUbic && c.origen_lat != null ? kmEntre(miUbic, { lat: c.origen_lat, lon: c.origen_lon }) : null;
    const kmViaje = c.distancia_km != null ? c.distancia_km
      : (c.origen_lat != null && c.destino_lat != null
          ? kmEntre({ lat: c.origen_lat, lon: c.origen_lon }, { lat: c.destino_lat, lon: c.destino_lon })
          : null);
    const fmtKm = (k) => (k < 1 ? `${Math.round(k * 1000)} m` : `${k.toFixed(1)} km`);
    return (
    <View key={c.id} style={styles.log}>
      {/* fila de encabezado tipo log: tiempo — precio */}
      <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
        <Text style={{ fontSize: 12, color: "#999" }}>
          {haceCuanto(c.fecha)}{c.zona === "rural" ? "  🌄 vereda" : ""}
        </Text>
        {!propia && c.tarifa_ofrecida ? (
          <Text style={{ fontSize: 20, fontWeight: "bold", color: "#187830" }}>${c.tarifa_ofrecida.toLocaleString()}</Text>
        ) : null}
      </View>

      {/* tipo de vehiculo pedido (util sobre todo en trasteos) */}
      <Text style={{ fontSize: 14, fontWeight: "700", color: "#444", marginTop: 6 }}>
        {vehIcono(c.vehiculo_pedido)} {vehLabel(c.vehiculo_pedido)}
        {esCarga(c.vehiculo_pedido) ? "  ·  trasteo" : ""}
      </Text>

      {/* hora agendada de recogida (solo trasteos que la programaron) */}
      {c.recogida && (
        <View style={{ backgroundColor: "#FFF7E6", borderRadius: 8, paddingVertical: 5, paddingHorizontal: 8, alignSelf: "flex-start", marginTop: 6 }}>
          <Text style={{ fontSize: 13, color: "#8A5A00", fontWeight: "700" }}>⏰ Recogida: {fmtRecogida(c.recogida)}</Text>
        </View>
      )}

      {/* ruta compacta origen -> destino */}
      <Text style={{ fontSize: 14, color: "#333", marginTop: 6 }} numberOfLines={1}>
        🟢 {c.origen}
      </Text>
      <Text style={{ fontSize: 14, color: "#333", marginTop: 2 }} numberOfLines={1}>
        🔴 {c.destino}
      </Text>

      {/* las dos distancias: antes de aceptar para decidir, y DESPUES tambien
          mientras hace el servicio (no desaparecen al tomar la carrera) */}
      {(kmAlOrigen != null || kmViaje != null) && (
        <View style={{ flexDirection: "row", gap: 8, marginTop: 8, flexWrap: "wrap" }}>
          {kmAlOrigen != null && (
            <View style={{ backgroundColor: "#EAF6EC", borderRadius: 8, paddingVertical: 4, paddingHorizontal: 8 }}>
              <Text style={{ fontSize: 12, color: "#187830", fontWeight: "600" }}>
                📍 {propia ? "Recogida a" : "A"} ~{fmtKm(kmAlOrigen)} de ti
              </Text>
            </View>
          )}
          {kmViaje != null && (
            <View style={{ backgroundColor: "#FFF3E6", borderRadius: 8, paddingVertical: 4, paddingHorizontal: 8 }}>
              <Text style={{ fontSize: 12, color: "#B85C00", fontWeight: "600" }}>🛣️ Viaje ~{fmtKm(kmViaje)}</Text>
            </View>
          )}
        </View>
      )}

      {(c.origen_detalle || c.notas) ? (
        <Text style={{ fontSize: 12, color: "#888", marginTop: 4 }} numberOfLines={2}>
          {c.origen_detalle || ""}{c.origen_detalle && c.notas ? " · " : ""}{c.notas || ""}
        </Text>
      ) : null}
      <Text style={{ fontSize: 12, color: "#999", marginTop: 4 }}>👤 {c.cliente_nombre} · 📞 {c.cliente_telefono}</Text>

      {propia && (
        <View style={{ flexDirection: "row", gap: 8, marginTop: 10 }}>
          <TouchableOpacity style={[styles.button, { flex: 1, backgroundColor: "#187830", padding: 10 }]} onPress={() => llamar(c.cliente_telefono)}>
            <Text style={[styles.buttonText, { fontSize: 14 }]}>📞 Llamar</Text>
          </TouchableOpacity>
          <TouchableOpacity style={[styles.button, { flex: 1, backgroundColor: "#25D366", padding: 10 }]} onPress={() => whatsapp(c.cliente_telefono)}>
            <Text style={[styles.buttonText, { fontSize: 14 }]}>💬 WhatsApp</Text>
          </TouchableOpacity>
        </View>
      )}

      {!propia && (
        c.tarifa_ofrecida ? (
          <View style={{ flexDirection: "row", gap: 8, marginTop: 10 }}>
            <TouchableOpacity style={[styles.button, { flex: 1, backgroundColor: "#187830", padding: 11 }]} onPress={() => aceptar(c)}>
              <Text style={[styles.buttonText, { fontSize: 14 }]}>Aceptar ${c.tarifa_ofrecida.toLocaleString()}</Text>
            </TouchableOpacity>
            <TouchableOpacity style={[styles.button, { flex: 1, backgroundColor: "#fff", borderWidth: 1, borderColor: "#187830", padding: 11 }]} onPress={() => { setMontoOferta(String(c.tarifa_ofrecida)); setContraofertando(c); }}>
              <Text style={{ color: "#187830", fontWeight: "600", fontSize: 14 }}>Proponer otro</Text>
            </TouchableOpacity>
          </View>
        ) : (
          <TouchableOpacity style={[styles.button, { backgroundColor: "#187830", marginTop: 10, padding: 11 }]} onPress={() => aceptar(c)}>
            <Text style={styles.buttonText}>Tomar</Text>
          </TouchableOpacity>
        )
      )}
      {propia && c.estado === "aceptada" && (
        <TouchableOpacity style={[styles.button, { backgroundColor: "#187830", marginTop: 10, padding: 11 }]} onPress={() => cambiarEstado(c, "en_camino")}>
          <Text style={styles.buttonText}>Ya lo recogi — En camino</Text>
        </TouchableOpacity>
      )}
      {propia && c.estado === "en_camino" && (
        <TouchableOpacity style={[styles.button, { backgroundColor: "#187830", marginTop: 10, padding: 11 }]} onPress={() => finalizar(c)}>
          <Text style={styles.buttonText}>Carrera terminada</Text>
        </TouchableOpacity>
      )}
    </View>
    );
  };

  return (
    <SafeAreaView style={styles.container}>
      <View style={[styles.header, { backgroundColor: "#187830", flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start" }]}>
        <View>
          <Text style={styles.headerSub}>Hola, {usuario.nombre} 🚕</Text>
          <Text style={styles.headerTitle}>Carreras</Text>
        </View>
        <TouchableOpacity onPress={() => navigation.navigate("Configuracion", { usuario })} style={{ padding: 4 }}>
          <Text style={{ fontSize: 24 }}>⚙️</Text>
        </TouchableOpacity>
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
        <Text style={{ fontWeight: "600", color: disponible ? "#187830" : "#C0392B" }}>
          {disponible ? "🟢 Estas conectado" : "🔴 Estas desconectado"}
        </Text>
        <Text style={{ fontSize: 12, color: "#888", marginTop: 2 }}>Toca para cambiar</Text>
      </TouchableOpacity>

      <ScrollView contentContainerStyle={{ padding: 16, paddingTop: 8 }}>
        {/* ===== PESTAÑA SOLICITUDES: feed en vivo ===== */}
        {tab === "solicitudes" && (
          <>
            {!permisoFondo && Platform.OS !== "web" && (
              <TouchableOpacity
                style={[styles.card, { backgroundColor: "#FFF6E5", borderWidth: 1, borderColor: "#F0C36D", marginBottom: 12 }]}
                onPress={pedirPermisoFondo}>
                <Text style={{ fontWeight: "700", color: "#8A5A00", fontSize: 14 }}>🛰️ Activa "Ubicacion todo el tiempo"</Text>
                <Text style={{ fontSize: 12, color: "#8A5A00", marginTop: 4 }}>
                  Para que el cliente te vea venir en el mapa aunque tengas Tukán cerrada o
                  estes navegando con Google Maps. Toca aqui y elige "Permitir todo el tiempo".
                </Text>
              </TouchableOpacity>
            )}
            {mias.length > 0 && (
              <>
                <Text style={styles.seccionTitulo}>Tu carrera en curso</Text>
                {(() => {
                  // el conductor tambien ve su ruta: al punto de recogida
                  // (aceptada) o al destino (en_camino), con su 🚗 moviendose
                  const c = mias[0];
                  const punto = c.estado === "aceptada"
                    ? (c.origen_lat != null ? { lat: c.origen_lat, lon: c.origen_lon } : null)
                    : (c.destino_lat != null ? { lat: c.destino_lat, lon: c.destino_lon } : null);
                  if (!punto && !miUbic) return null;
                  const dist = punto && miUbic ? kmEntre(miUbic, punto) : null;
                  const info = rutaCond;
                  return (
                    <>
                      <MapaSeguimiento key={"cond-" + c.estado} punto={punto} conductor={miUbic} onInfo={setRutaCond} />
                      <View style={{ flexDirection: "row", gap: 8, marginBottom: 10 }}>
                        {(info || dist != null) && (
                          <View style={{ flex: 1, backgroundColor: "#EAF6EC", borderRadius: 10, padding: 10, alignItems: "center", justifyContent: "center" }}>
                            <Text style={{ fontSize: 13, fontWeight: "700", color: "#187830" }}>
                              {c.estado === "aceptada" ? "📍 Recogida" : "🏁 Destino"}:{" "}
                              {info
                                ? `${info.km < 1 ? `${Math.round(info.km * 1000)} m` : `${info.km.toFixed(1)} km`} · ~${Math.max(1, info.min)} min`
                                : `~${dist < 1 ? `${Math.round(dist * 1000)} m` : `${dist.toFixed(1)} km`}`}
                            </Text>
                          </View>
                        )}
                        {punto && (
                          <TouchableOpacity style={[styles.button, { backgroundColor: "#1A73E8", paddingHorizontal: 14 }]} onPress={() => navegarGoogleMaps(punto.lat, punto.lon)}>
                            <Text style={[styles.buttonText, { fontSize: 13 }]}>🧭 Iniciar ruta</Text>
                          </TouchableOpacity>
                        )}
                      </View>
                    </>
                  );
                })()}
                {mias.map(c => tarjeta(c, true))}
                <View style={{ height: 8 }} />
              </>
            )}

            {/* MAPA SIEMPRE ABIERTO (sin carrera activa): muestra donde estas y,
                cuando hay solicitud, traza la ruta hasta la recogida para dar
                contexto y decidir/contraofertar rapido */}
            {mias.length === 0 && disponible && (() => {
              const foco = disponibles.find(c => c.origen_lat != null) || null;
              const punto = foco ? { lat: foco.origen_lat, lon: foco.origen_lon } : null;
              if (!miUbic) {
                return (
                  <View style={{ height: 88, borderRadius: 14, backgroundColor: "#EAF6EC", alignItems: "center", justifyContent: "center", marginBottom: 12 }}>
                    <ActivityIndicator color="#187830" />
                    <Text style={{ fontSize: 12, color: "#187830", marginTop: 6 }}>Activando tu ubicación en el mapa…</Text>
                  </View>
                );
              }
              const km = rutaPreview && (rutaPreview.km < 1 ? `${Math.round(rutaPreview.km * 1000)} m` : `${rutaPreview.km.toFixed(1)} km`);
              return (
                <>
                  <View style={{ height: 200, borderRadius: 14, overflow: "hidden", marginBottom: 8 }}>
                    <MapaSeguimiento key={"prev-" + (foco ? foco.id : "solo")} punto={punto} conductor={miUbic} onInfo={setRutaPreview} lleno />
                  </View>
                  <View style={{ backgroundColor: foco ? "#FFF3E6" : "#EAF6EC", borderRadius: 10, padding: 10, marginBottom: 12, flexDirection: "row", alignItems: "center", gap: 8 }}>
                    <Text style={{ fontSize: 16 }}>{foco ? "🚗" : "📍"}</Text>
                    <Text style={{ flex: 1, fontSize: 12.5, fontWeight: "600", color: foco ? "#B85C00" : "#187830" }}>
                      {foco
                        ? (rutaPreview ? `Recogida a ${km} · ~${Math.max(1, rutaPreview.min)} min de ti` : "Calculando la ruta hasta la recogida…")
                        : "Estás aquí. Cuando entre una solicitud verás la ruta hasta el pasajero."}
                    </Text>
                  </View>
                </>
              );
            })()}

            <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
              <Text style={styles.seccionTitulo}>Solicitudes en vivo</Text>
              {disponible && (
                <View style={{ flexDirection: "row", alignItems: "center", gap: 5 }}>
                  <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: "#2E7D32" }} />
                  <Text style={{ fontSize: 11, color: "#2E7D32", fontWeight: "600" }}>EN VIVO · {disponibles.length}</Text>
                </View>
              )}
            </View>
            {!disponible ? (
              <View style={{ alignItems: "center", padding: 24 }}>
                <Text style={{ fontSize: 34 }}>🔌</Text>
                <Text style={{ color: "#888", marginTop: 8, textAlign: "center" }}>Estas desconectado.{"\n"}Conectate arriba para recibir solicitudes.</Text>
              </View>
            ) : disponibles.length === 0 ? (
              <View style={{ alignItems: "center", padding: 30 }}>
                <Text style={{ fontSize: 40 }}>😴</Text>
                <Text style={{ color: "#888", marginTop: 8 }}>Esperando solicitudes...</Text>
              </View>
            ) : disponibles.map(c => {
              // recien llegada (< 6s): tarjeta grande con cuenta regresiva y
              // contraoferta rapida. Pasados los 6s baja al listado normal.
              const restante = VENTANA - (ahora - (recibidas.current[c.id] || 0));
              return restante > 0 ? tarjetaUrgente(c, restante) : tarjeta(c, false);
            })}
          </>
        )}

        {/* ===== PESTAÑA DESEMPEÑO: estadisticas ===== */}
        {tab === "desempeno" && stats && (
          <View style={styles.card}>
            <Text style={styles.seccionTitulo}>Tus números</Text>
            <View style={styles.statHoy}>
              <View>
                <Text style={{ fontSize: 12, color: "#666" }}>Hoy</Text>
                <Text style={{ fontSize: 28, fontWeight: "bold", color: "#187830" }}>${(stats.hoy.ganado || 0).toLocaleString()}</Text>
              </View>
              <View style={{ alignItems: "flex-end" }}>
                <Text style={{ fontSize: 12, color: "#666" }}>Carreras hoy</Text>
                <Text style={{ fontSize: 28, fontWeight: "bold", color: "#F06000" }}>{stats.hoy.carreras || 0}</Text>
              </View>
            </View>
            <View style={{ flexDirection: "row", flexWrap: "wrap", marginTop: 12 }}>
              {[["Semana", stats.semana], ["Mes", stats.mes], ["Año", stats.anio], ["Total", stats.total]].map(([lbl, d]) => (
                <View key={lbl} style={styles.statCelda}>
                  <Text style={{ fontSize: 11, color: "#888" }}>{lbl}</Text>
                  <Text style={{ fontSize: 15, fontWeight: "700", color: "#333" }}>${(d.ganado || 0).toLocaleString()}</Text>
                  <Text style={{ fontSize: 11, color: "#888" }}>{d.carreras || 0} {d.carreras === 1 ? "carrera" : "carreras"}</Text>
                </View>
              ))}
            </View>
          </View>
        )}

        {/* ===== PESTAÑA CARTERA: suscripcion ===== */}
        {tab === "cartera" && (
          <View style={styles.card}>
            <Text style={styles.seccionTitulo}>Tu suscripción</Text>
            {!cuenta ? <ActivityIndicator color="#187830" /> : !cuenta.cobro_activo ? (
              <>
                <Text style={{ fontSize: 16, color: "#187830", fontWeight: "700" }}>Gratis por ahora 🎉</Text>
                <Text style={{ fontSize: 13, color: "#666", marginTop: 6 }}>Trabajas sin costo durante el lanzamiento. Cuando empiece el cobro te avisamos aca.</Text>
              </>
            ) : (
              <>
                <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
                  <Text style={{ fontSize: 14, color: "#333" }}>Estado</Text>
                  <View style={[styles.estadoBadge, { backgroundColor: cuenta.al_dia ? "#E8F5E9" : "#FBECEC" }]}>
                    <Text style={{ fontSize: 12, fontWeight: "600", color: cuenta.al_dia ? "#187830" : "#C0392B" }}>{cuenta.al_dia ? "Al día" : "Vencida"}</Text>
                  </View>
                </View>
                {cuenta.al_dia && <Text style={{ fontSize: 13, color: "#666", marginTop: 10 }}>Te quedan {cuenta.dias_restantes} días</Text>}
                <Text style={{ fontSize: 13, color: "#666", marginTop: 8 }}>Valor: ${cuenta.valor_mensual.toLocaleString()} / mes</Text>
                {!cuenta.al_dia && cuenta.nequi_pagos ? (
                  <View style={{ backgroundColor: "#FFF4E0", borderRadius: 8, padding: 12, marginTop: 12 }}>
                    <Text style={{ fontSize: 13, color: "#8A5A00" }}>Renueva pagando a Nequi:</Text>
                    <Text style={{ fontSize: 18, fontWeight: "bold", color: "#8A5A00" }}>{cuenta.nequi_pagos}</Text>
                  </View>
                ) : null}
              </>
            )}
          </View>
        )}

      </ScrollView>

      {/* barra de ESTADO (el tic-tac): Conectado -> Buscando -> Viaje disponible */}
      {(() => {
        const enServicio = mias.length > 0;
        const hayDisp = disponibles.length > 0;
        let e;
        if (!disponible) e = { txt: "Desconectado", sub: "Conéctate arriba para recibir viajes", color: "#C0392B", pulse: false };
        else if (enServicio) e = { txt: "En servicio", sub: "Tienes una carrera en curso", color: "#187830", pulse: false };
        else if (hayDisp) e = { txt: "🚗 ¡Viaje disponible!", sub: `${disponibles.length} solicitud${disponibles.length > 1 ? "es" : ""} esperando`, color: "#F06000", pulse: true };
        else e = { txt: "Buscando viajes…", sub: "Estás conectado. Te avisamos apenas entre uno", color: "#187830", pulse: true };
        return (
          <View style={[styles.barraEstado, { borderTopColor: e.color }]}>
            <PuntoVivo color={e.color} activo={e.pulse} />
            <View style={{ flex: 1 }}>
              <Text style={{ fontSize: 13.5, fontWeight: "700", color: e.color }}>{e.txt}</Text>
              <Text style={{ fontSize: 11, color: "#888", marginTop: 1 }}>{e.sub}</Text>
            </View>
            {disponible && !enServicio && hayDisp && (
              <Text style={{ fontSize: 22, fontWeight: "800", color: e.color }}>{disponibles.length}</Text>
            )}
          </View>
        );
      })()}

      {/* barra de pestañas (con espacio para la barra del sistema en Samsung y similares) */}
      <View style={[styles.tabBar, { paddingBottom: Math.max(insets.bottom, 8) }]}>
        {[["solicitudes", "📋", "Solicitudes"], ["desempeno", "📊", "Desempeño"], ["cartera", "💳", "Cartera"], ["salir", "🚪", "Salir"]].map(([k, ic, lbl]) => (
          <TouchableOpacity key={k} style={styles.tabBarItem}
            onPress={() => k === "salir" ? (detenerRastreoFondo(), navigation.replace("Login")) : (animar(), setTab(k))}>
            <Text style={{ fontSize: 20, opacity: tab === k ? 1 : 0.5 }}>{ic}</Text>
            <Text style={{ fontSize: 11, marginTop: 2, color: tab === k ? "#187830" : "#999", fontWeight: tab === k ? "700" : "400" }}>{lbl}</Text>
          </TouchableOpacity>
        ))}
      </View>

      <Modal visible={!!cobrando} transparent animationType="fade" onRequestClose={() => setCobrando(null)}>
        <View style={styles.fondoModal}>
          <View style={styles.ventanaModal}>
            <Text style={{ fontSize: 17, fontWeight: "bold", color: "#333" }}>Carrera terminada</Text>
            <Text style={{ fontSize: 13, color: "#888", marginTop: 4, marginBottom: 14 }}>
              {cobrando && cobrando.tarifa != null
                ? `Precio acordado: $${cobrando.tarifa.toLocaleString()}. Confirma, o ajustalo solo si cambio.`
                : "Cuanto cobraste?"}
            </Text>
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
              <TouchableOpacity style={[styles.button, { flex: 1, backgroundColor: "#187830" }]} onPress={confirmarCobro}>
                <Text style={styles.buttonText}>Guardar</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      <Modal visible={!!contraofertando} transparent animationType="fade" onRequestClose={() => setContraofertando(null)}>
        <View style={styles.fondoModal}>
          <View style={styles.ventanaModal}>
            <Text style={{ fontSize: 17, fontWeight: "bold", color: "#333" }}>Proponer tu precio</Text>
            <Text style={{ fontSize: 13, color: "#888", marginTop: 4, marginBottom: 14 }}>
              {contraofertando && contraofertando.tarifa_ofrecida
                ? `El cliente ofrece $${contraofertando.tarifa_ofrecida.toLocaleString()}. Cuanto quieres cobrar?`
                : "Cuanto quieres cobrar?"}
            </Text>
            <View style={styles.ofertaFila}>
              <Text style={{ fontSize: 22, fontWeight: "bold", color: "#187830" }}>$</Text>
              <TextInput value={montoOferta} onChangeText={(t) => setMontoOferta(t.replace(/\D/g, ""))}
                placeholder="0" keyboardType="number-pad" style={styles.ofertaInput} autoFocus />
            </View>
            <View style={{ flexDirection: "row", gap: 10, marginTop: 14 }}>
              <TouchableOpacity style={[styles.button, { flex: 1, backgroundColor: "#fff", borderWidth: 1, borderColor: "#ddd" }]} onPress={() => setContraofertando(null)}>
                <Text style={{ color: "#888", fontWeight: "600" }}>Cancelar</Text>
              </TouchableOpacity>
              <TouchableOpacity style={[styles.button, { flex: 1, backgroundColor: "#187830" }]} onPress={contraofertar}>
                <Text style={styles.buttonText}>Enviar</Text>
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
  const [gStats, setGStats] = useState(null);
  const [pestana, setPestana] = useState("conductores");

  const cargar = () => {
    fetch(`${API}/conductores`).then(r => r.json()).then(d => { if (Array.isArray(d)) setConductores(d); }).catch(() => {});
    adminFetch(`${API}/carreras`).then(r => r.json()).then(d => { if (Array.isArray(d)) setCarreras(d); }).catch(() => {});
    adminFetch(`${API}/estadisticas`).then(r => r.json()).then(d => { if (d && !d.detail) setGStats(d); }).catch(() => {});
    adminFetch(`${API}/config`).then(r => r.json()).then(d => { if (d && !d.detail) setConfig(d); }).catch(() => {});
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
        alElegir: () => adminFetch(`${API}/conductores/${c.id}/suscripcion?meses=${m}`, { method: "PUT" }).then(cargar),
      })));
  };

  const quitarSuscripcion = (c) => {
    confirmar("Quitar suscripcion", `${c.nombre} dejara de recibir carreras.`,
      () => adminFetch(`${API}/conductores/${c.id}/suscripcion`, { method: "DELETE" }).then(cargar),
      "Si, quitar");
  };

  const cambiarCobro = () => {
    const nuevo = config.cobro_activo === "si" ? "no" : "si";
    confirmar(
      nuevo === "si" ? "Activar cobro" : "Desactivar cobro",
      nuevo === "si"
        ? "Desde ahora solo los conductores con suscripcion al dia podran tomar carreras."
        : "Todos los conductores podran trabajar gratis.",
      () => adminFetch(`${API}/config?clave=cobro_activo&valor=${nuevo}`, { method: "PUT" }).then(cargar));
  };

  const activos = conductores.filter(c => c.al_dia).length;
  const enCurso = carreras.filter(c => ["buscando", "aceptada", "en_camino"].includes(c.estado));
  const hoy = carreras.filter(c => (c.fecha || "").slice(0, 10) === new Date().toISOString().slice(0, 10));

  return (
    <SafeAreaView style={styles.container}>
      <View style={[styles.header, { backgroundColor: "#187830", flexDirection: "row", alignItems: "center", gap: 12 }]}>
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
        {["numeros", "conductores", "carreras", "cobro"].map(p => (
          <TouchableOpacity key={p} style={[styles.tab, pestana === p && styles.tabActive]} onPress={() => setPestana(p)}>
            <Text style={[styles.tabText, pestana === p && styles.tabTextActive]}>{p[0].toUpperCase() + p.slice(1)}</Text>
          </TouchableOpacity>
        ))}
      </View>

      <ScrollView contentContainerStyle={{ padding: 16, paddingTop: 4 }}>
        {pestana === "numeros" && gStats && (
          <>
            <View style={[styles.card, { marginBottom: 12 }]}>
              <Text style={styles.seccionTitulo}>📣 Difusión de la app</Text>
              <View style={{ flexDirection: "row", justifyContent: "space-around", alignItems: "center" }}>
                {[["Visitas", gStats.visitas_hoy, gStats.visitas_total], ["Descargas", gStats.descargas_hoy, gStats.descargas_total], ["Registros", null, (gStats.clientes || 0) + (gStats.conductores || 0)]].map(([lbl, hoyV, totV]) => (
                  <View key={lbl} style={{ alignItems: "center" }}>
                    <Text style={{ fontSize: 24, fontWeight: "bold", color: "#F06000" }}>{totV ?? 0}</Text>
                    <Text style={{ fontSize: 11, color: "#888" }}>{lbl}</Text>
                    {hoyV != null && <Text style={{ fontSize: 10, color: "#187830", fontWeight: "600" }}>+{hoyV} hoy</Text>}
                  </View>
                ))}
              </View>
              <Text style={[styles.ayuda, { textAlign: "center", marginTop: 8 }]}>Embudo: quien visita la página → descarga el APK → se registra</Text>
            </View>

            <View style={[styles.card, { marginBottom: 12 }]}>
              <Text style={styles.seccionTitulo}>Plata movida (carreras finalizadas)</Text>
              {[["Hoy", gStats.hoy], ["Esta semana", gStats.semana], ["Este mes", gStats.mes], ["Este año", gStats.anio], ["Total historico", gStats.total]].map(([lbl, d]) => (
                <View key={lbl} style={{ flexDirection: "row", justifyContent: "space-between", paddingVertical: 8, borderBottomWidth: 0.5, borderBottomColor: "#eee" }}>
                  <Text style={{ fontSize: 14, color: "#333" }}>{lbl}</Text>
                  <View style={{ alignItems: "flex-end" }}>
                    <Text style={{ fontSize: 15, fontWeight: "700", color: "#187830" }}>${(d.ganado || 0).toLocaleString()}</Text>
                    <Text style={{ fontSize: 11, color: "#888" }}>{d.carreras || 0} carreras</Text>
                  </View>
                </View>
              ))}
            </View>
            <View style={{ flexDirection: "row", flexWrap: "wrap" }}>
              {[["Clientes", gStats.clientes], ["Conductores", gStats.conductores], ["Al día", gStats.conductores_al_dia], ["En curso", gStats.en_curso], ["Canceladas", gStats.canceladas], ["Carreras totales", gStats.carreras_totales]].map(([lbl, v]) => (
                <View key={lbl} style={{ width: "33.3%", padding: 4 }}>
                  <View style={[styles.card, { alignItems: "center", padding: 12 }]}>
                    <Text style={{ fontSize: 22, fontWeight: "bold", color: "#F06000" }}>{v}</Text>
                    <Text style={{ fontSize: 10, color: "#888", textAlign: "center" }}>{lbl}</Text>
                  </View>
                </View>
              ))}
            </View>
          </>
        )}
        {pestana === "conductores" && conductores.map(c => (
          <View key={c.id} style={[styles.card, { marginBottom: 10 }]}>
            <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
              <View style={{ flex: 1 }}>
                <Text style={{ fontWeight: "600", fontSize: 15 }}>{c.nombre}</Text>
                <Text style={{ fontSize: 12, color: "#888", marginTop: 2 }}>📞 {c.telefono}</Text>
                {c.placa ? <Text style={{ fontSize: 12, color: "#888" }}>🚕 {c.vehiculo} - {c.placa}</Text> : null}
              </View>
              <View style={[styles.estadoBadge, { backgroundColor: c.al_dia ? "#E8F5E9" : "#FBECEC" }]}>
                <Text style={{ fontSize: 11, fontWeight: "600", color: c.al_dia ? "#187830" : "#C0392B" }}>
                  {c.al_dia ? (config.cobro_activo === "si" ? `${c.dias_restantes} dias` : "activo") : "vencido"}
                </Text>
              </View>
            </View>
            {c.fotos && (c.fotos.conductor || c.fotos.vehiculo || c.fotos.tarjeta) ? (
              <View style={{ flexDirection: "row", gap: 8, marginTop: 10 }}>
                {[["conductor", "👤"], ["vehiculo", "🚗"], ["tarjeta", "📄"]].map(([t, ic]) => (
                  <View key={t} style={{ flex: 1, alignItems: "center" }}>
                    {c.fotos[t]
                      ? <Image source={{ uri: c.fotos[t] }} style={{ width: "100%", height: 60, borderRadius: 8 }} />
                      : <View style={{ width: "100%", height: 60, borderRadius: 8, backgroundColor: "#f2f2f2", alignItems: "center", justifyContent: "center" }}><Text>{ic}</Text></View>}
                    <Text style={{ fontSize: 9, color: c.fotos[t] ? "#187830" : "#bbb", marginTop: 2 }}>{t === "tarjeta" ? "tarjeta" : t}</Text>
                  </View>
                ))}
              </View>
            ) : (
              <Text style={{ fontSize: 11, color: "#C0392B", marginTop: 8 }}>⚠️ Sin fotos de verificacion</Text>
            )}
            <View style={{ flexDirection: "row", gap: 8, marginTop: 12 }}>
              <TouchableOpacity style={[styles.button, { flex: 1, backgroundColor: "#187830", padding: 10 }]} onPress={() => registrarPago(c)}>
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
            {c.tarifa ? <Text style={{ fontSize: 12, color: "#187830", marginTop: 2 }}>${c.tarifa.toLocaleString()}</Text> : null}
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
              style={[styles.button, { backgroundColor: config.cobro_activo === "si" ? "#C0392B" : "#187830" }]}
              onPress={cambiarCobro}
            >
              <Text style={styles.buttonText}>{config.cobro_activo === "si" ? "Desactivar cobro" : "Activar cobro"}</Text>
            </TouchableOpacity>

            <Text style={[styles.etiqueta, { marginTop: 20 }]}>SUSCRIPCION MENSUAL — CARRO</Text>
            <TextInput
              defaultValue={config.valor_mensual_carro}
              placeholder="Ej: 59900"
              onEndEditing={(e) => {
                const v = e.nativeEvent.text.replace(/\D/g, "");
                if (v) adminFetch(`${API}/config?clave=valor_mensual_carro&valor=${v}`, { method: "PUT" }).then(cargar);
              }}
              keyboardType="number-pad"
              style={styles.input}
            />
            <Text style={styles.etiqueta}>SUSCRIPCION MENSUAL — MOTO</Text>
            <TextInput
              defaultValue={config.valor_mensual_moto}
              placeholder="Ej: 39900"
              onEndEditing={(e) => {
                const v = e.nativeEvent.text.replace(/\D/g, "");
                if (v) adminFetch(`${API}/config?clave=valor_mensual_moto&valor=${v}`, { method: "PUT" }).then(cargar);
              }}
              keyboardType="number-pad"
              style={styles.input}
            />
            <Text style={styles.etiqueta}>NEQUI PARA RECIBIR PAGOS</Text>
            <TextInput
              defaultValue={config.nequi_pagos}
              placeholder="Numero al que te transfieren"
              onEndEditing={(e) => adminFetch(`${API}/config?clave=nequi_pagos&valor=${encodeURIComponent(e.nativeEvent.text)}`, { method: "PUT" }).then(cargar)}
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

// todos los medios que puede aceptar un conductor; los que llevan cuenta piden el dato al marcar
const METODOS_PAGO = [
  { key: "efectivo", label: "Efectivo", icon: "💵", cuenta: false },
  { key: "nequi", label: "Nequi", icon: "📱", cuenta: true, ph: "Numero Nequi", soloNumeros: true },
  { key: "daviplata", label: "Daviplata", icon: "📱", cuenta: true, ph: "Numero Daviplata", soloNumeros: true },
  { key: "bancolombia", label: "Bancolombia", icon: "🏦", cuenta: true, ph: "Cuenta o llave" },
  { key: "breb", label: "Llave Bre-B", icon: "🔑", cuenta: true, ph: "Tu llave Bre-B" },
];

function ConfiguracionScreen({ navigation, route }) {
  const { usuario } = route.params;
  const esConductor = usuario.rol === "conductor";
  const [pagos, setPagos] = useState({ efectivo: true, nequi: "", daviplata: "", bancolombia: "", breb: "" });
  const [activos, setActivos] = useState({ efectivo: true });   // cuales estan marcados
  const [fotos, setFotos] = useState({ conductor: null, vehiculo: null, tarjeta: null });
  const [subiendoFoto, setSubiendoFoto] = useState(null);       // "conductor" | "vehiculo" | "tarjeta"
  const [notifOk, setNotifOk] = useState(null);
  const [cargando, setCargando] = useState(true);
  const [guardando, setGuardando] = useState(false);
  // zona de trabajo del conductor: puede mudarse o trabajar en el otro pueblo
  const [municipios, setMunicipios] = useState([]);
  const [miMuni, setMiMuni] = useState(usuario.municipio);
  const [cambiandoMuni, setCambiandoMuni] = useState(false);

  useEffect(() => {
    Notifications.getPermissionsAsync().then(p => setNotifOk(p.status === "granted")).catch(() => {});
    if (esConductor) {
      fetch(`${API}/municipios`).then(r => r.json())
        .then(d => { if (Array.isArray(d)) setMunicipios(d); }).catch(() => {});
    }
  }, []);

  const cambiarMunicipio = (nombre) => {
    if (nombre === miMuni) return;
    confirmar("Cambiar zona de trabajo", `Solo veras solicitudes de ${nombre}. Seguro?`, () => {
      setCambiandoMuni(true);
      userFetch(`${API}/conductores/${usuario.id}?municipio=${encodeURIComponent(nombre)}`, { method: "PUT" })
        .then(async (r) => {
          const d = await r.json();
          setCambiandoMuni(false);
          if (!r.ok || d.detail) { avisar("No se pudo", d.detail || "Intenta de nuevo."); return; }
          setMiMuni(d.municipio);
          usuario.municipio = d.municipio;   // para que la pantalla anterior quede al dia
          avisar("Listo", `Ahora recibes solicitudes de ${d.municipio}.`);
        })
        .catch(() => { setCambiandoMuni(false); avisar("Sin conexion", "Intenta de nuevo."); });
    }, "Si, cambiar");
  };

  const activarNotificaciones = async () => {
    const r = await registrarNotificaciones(usuario.id);
    const p = await Notifications.getPermissionsAsync();
    setNotifOk(p.status === "granted");
    if (r && r.ok) {
      avisar("✅ Notificaciones activas", "Recibiras las carreras aunque tengas la app cerrada.\n\nToken: " + (r.token ? r.token.slice(0, 30) + "…" : "sí"));
    } else {
      avisar("⚠️ No quedó activo", (r && r.motivo ? r.motivo : "Intenta de nuevo.") + "\n\nMuéstrale esta pantalla al soporte.");
    }
  };

  // dispara el tono AHORA para oir si suena (sin depender del servidor)
  const probarTono = async () => {
    try { Vibration.vibrate([0, 500, 220, 500]); } catch (e) {}
    try {
      await Notifications.scheduleNotificationAsync({
        content: { title: "🔔 Prueba de tono", body: "Así suena cuando entra una carrera.", sound: "tono.wav" },
        trigger: Platform.OS === "android" ? { channelId: "carreras2", seconds: 1 } : null,
      });
      avisar("Probando…", "En 1 segundo debe sonar el tono y vibrar. Si vibra pero no suena, revisa el volumen de notificaciones o la 'Pausa de actividad'.");
    } catch (e) {
      avisar("No se pudo probar", String(e.message || e));
    }
  };

  useEffect(() => {
    fetch(`${API}/usuarios/${usuario.id}/perfil`).then(r => r.json())
      .then(d => {
        if (d && d.pagos) {
          setPagos(d.pagos);
          setActivos({
            efectivo: d.pagos.efectivo, nequi: !!d.pagos.nequi, daviplata: !!d.pagos.daviplata,
            bancolombia: !!d.pagos.bancolombia, breb: !!d.pagos.breb,
          });
        }
        if (d && d.fotos) setFotos(d.fotos);
      })
      .catch(() => {})
      .finally(() => setCargando(false));
  }, []);

  const subirFoto = async (tipo) => {
    const permiso = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permiso.granted) { avisar("Permiso requerido", "Necesitamos acceso a tus fotos."); return; }
    const r = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images, allowsEditing: true,
      aspect: tipo === "conductor" ? [1, 1] : [4, 3], quality: 0.6,
    });
    if (r.canceled) return;
    setSubiendoFoto(tipo);
    const fd = new FormData();
    fd.append("file", { uri: r.assets[0].uri, type: "image/jpeg", name: `${tipo}.jpg` });
    userFetch(`${API}/usuarios/${usuario.id}/foto?tipo=${tipo}`, { method: "POST", body: fd, headers: { "Content-Type": "multipart/form-data" } })
      .then(res => res.json())
      .then(d => { setSubiendoFoto(null); if (d.url) setFotos(f => ({ ...f, [tipo]: d.url })); else avisar("Error", "No se pudo subir la foto."); })
      .catch(() => { setSubiendoFoto(null); avisar("Sin conexion", "Intenta de nuevo."); });
  };

  const guardar = () => {
    // si marco un medio con cuenta pero no puso el dato, se avisa
    for (const m of METODOS_PAGO) {
      if (m.cuenta && activos[m.key] && !(pagos[m.key] || "").trim()) {
        avisar("Falta un dato", `Marcaste ${m.label} pero no pusiste el numero/cuenta.`); return;
      }
    }
    setGuardando(true);
    const datos = { efectivo: activos.efectivo ? "si" : "no" };
    for (const m of METODOS_PAGO) {
      if (m.cuenta) datos[m.key] = activos[m.key] ? (pagos[m.key] || "") : "";  // desmarcar borra el dato
    }
    userFetch(`${API}/usuarios/${usuario.id}/pagos?${qs(datos)}`, { method: "PUT" })
      .then(r => r.json())
      .then(d => { setGuardando(false); if (d.ok) avisar("Guardado", "Tus medios de pago quedaron actualizados."); else avisar("Error", "No se pudo guardar."); })
      .catch(() => { setGuardando(false); avisar("Sin conexion", "Intenta de nuevo."); });
  };

  return (
    <SafeAreaView style={styles.container}>
      <View style={[styles.header, { backgroundColor: "#187830", flexDirection: "row", alignItems: "center", gap: 12 }]}>
        <TouchableOpacity onPress={() => navigation.goBack()}>
          <Text style={{ color: "#fff", fontSize: 20 }}>←</Text>
        </TouchableOpacity>
        <View>
          <Text style={styles.headerSub}>Mi cuenta</Text>
          <Text style={styles.headerTitle}>Configuracion</Text>
        </View>
      </View>
      <ScrollView contentContainerStyle={{ padding: 16 }}>
        <View style={[styles.card, { marginBottom: 14 }]}>
          <Text style={{ fontSize: 18, fontWeight: "bold", color: "#333" }}>{usuario.nombre}</Text>
          <Text style={{ fontSize: 13, color: "#888", marginTop: 4 }}>📞 {usuario.telefono}</Text>
          {usuario.municipio ? <Text style={{ fontSize: 13, color: "#888", marginTop: 2 }}>📍 {usuario.municipio}</Text> : null}
          {esConductor ? (
            <Text style={{ fontSize: 13, color: "#888", marginTop: 2 }}>
              {vehIcono(usuario.tipo_vehiculo)} {vehLabel(usuario.tipo_vehiculo)}{usuario.placa ? ` · ${usuario.placa}` : ""}
            </Text>
          ) : null}
          <Text style={{ fontSize: 11, color: "#bbb", marginTop: 6 }}>
            Version: {Updates.updateId ? `${Updates.updateId.slice(0, 8)} · ${Updates.createdAt ? new Date(Updates.createdAt).toLocaleString() : ""}` : "base (sin actualizaciones aun)"}
          </Text>
        </View>

        {/* notificaciones: recibir servicios aunque la app este cerrada */}
        <View style={[styles.card, { marginBottom: 14 }]}>
          <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
            <Text style={{ fontSize: 15, fontWeight: "600", color: "#333" }}>🔔 Notificaciones</Text>
            <View style={[styles.estadoBadge, { backgroundColor: notifOk ? "#E8F5E9" : "#FBECEC" }]}>
              <Text style={{ fontSize: 12, fontWeight: "600", color: notifOk ? "#187830" : "#C0392B" }}>{notifOk === null ? "..." : notifOk ? "Activas" : "Apagadas"}</Text>
            </View>
          </View>
          <Text style={{ fontSize: 13, color: "#666", marginTop: 6 }}>
            {esConductor
              ? "Recibe las carreras aunque tengas la app cerrada o en segundo plano."
              : "Te avisamos cuando un conductor acepte o te proponga precio, aunque cierres la app."}
          </Text>
          <View style={{ flexDirection: "row", gap: 8, marginTop: 10 }}>
            <TouchableOpacity style={[styles.button, { flex: 1, backgroundColor: "#187830", padding: 11 }]} onPress={activarNotificaciones}>
              <Text style={[styles.buttonText, { fontSize: 14 }]}>{notifOk ? "Re-registrar" : "Activar"}</Text>
            </TouchableOpacity>
            <TouchableOpacity style={[styles.button, { flex: 1, backgroundColor: "#F06000", padding: 11 }]} onPress={probarTono}>
              <Text style={[styles.buttonText, { fontSize: 14 }]}>🔊 Probar tono</Text>
            </TouchableOpacity>
          </View>
        </View>

        {esConductor && municipios.length > 0 && (
          <View style={[styles.card, { marginBottom: 14 }]}>
            <Text style={styles.seccionTitulo}>📍 Zona donde trabajas</Text>
            <Text style={styles.ayuda}>
              Solo recibes solicitudes de este municipio. Cambialo si te mudas o si hoy vas a trabajar en el otro.
            </Text>
            {cambiandoMuni ? (
              <ActivityIndicator color="#187830" style={{ marginTop: 8 }} />
            ) : (
              <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 6 }}>
                {municipios.map((m) => (
                  <TouchableOpacity key={m.nombre} onPress={() => cambiarMunicipio(m.nombre)}
                    style={[styles.chip, miMuni === m.nombre && styles.chipOn]}>
                    <Text style={[styles.chipTxt, miMuni === m.nombre && styles.chipTxtOn]}>{m.nombre}</Text>
                  </TouchableOpacity>
                ))}
              </View>
            )}
            <Text style={[styles.ayuda, { marginTop: 8, marginBottom: 0 }]}>
              Tu vehiculo: {vehIcono(usuario.tipo_vehiculo)} {vehLabel(usuario.tipo_vehiculo)}
            </Text>
          </View>
        )}

        {cargando ? <ActivityIndicator color="#187830" /> : esConductor ? (
          <>
          <View style={[styles.card, { marginBottom: 14 }]}>
            <Text style={styles.seccionTitulo}>Tus fotos</Text>
            <Text style={styles.ayuda}>Tu foto y la del vehiculo le dan confianza al cliente. La tarjeta de propiedad es para verificacion.</Text>
            <View style={{ flexDirection: "row", gap: 10, marginTop: 6 }}>
              {[["conductor", "Tu foto", 1], ["vehiculo", "Vehiculo", 1.3], ["tarjeta", "Tarjeta prop.", 1.3]].map(([tipo, lbl]) => (
                <TouchableOpacity key={tipo} style={{ flex: 1, alignItems: "center" }} onPress={() => subirFoto(tipo)} disabled={!!subiendoFoto}>
                  <View style={styles.fotoBox}>
                    {subiendoFoto === tipo ? <ActivityIndicator color="#187830" />
                      : fotos[tipo] ? <Image source={{ uri: fotos[tipo] }} style={{ width: "100%", height: "100%", borderRadius: 10 }} />
                      : <Text style={{ fontSize: 26 }}>{tipo === "conductor" ? "👤" : tipo === "vehiculo" ? "🚗" : "📄"}</Text>}
                  </View>
                  <Text style={{ fontSize: 11, color: "#666", marginTop: 4 }}>{lbl}</Text>
                  <Text style={{ fontSize: 10, color: "#187830" }}>{fotos[tipo] ? "cambiar" : "subir"}</Text>
                </TouchableOpacity>
              ))}
            </View>
          </View>
          <View style={styles.card}>
            <Text style={styles.seccionTitulo}>Medios de pago que aceptas</Text>
            <Text style={styles.ayuda}>Marca los que aceptas. El cliente vera solo esos para pagarte directo. La app no cobra ni maneja tu plata.</Text>

            {METODOS_PAGO.map(m => (
              <View key={m.key}>
                <TouchableOpacity style={styles.pagoFila} onPress={() => setActivos({ ...activos, [m.key]: !activos[m.key] })}>
                  <Text style={{ fontSize: 15, color: "#333" }}>{m.icon} {m.label}</Text>
                  <View style={[styles.switch, activos[m.key] && styles.switchOn]}>
                    <Text style={{ fontSize: 12, fontWeight: "600", color: activos[m.key] ? "#fff" : "#888" }}>{activos[m.key] ? "SI" : "NO"}</Text>
                  </View>
                </TouchableOpacity>
                {m.cuenta && activos[m.key] && (
                  <TextInput
                    value={pagos[m.key]}
                    onChangeText={t => setPagos({ ...pagos, [m.key]: m.soloNumeros ? t.replace(/\D/g, "") : t })}
                    placeholder={m.ph}
                    keyboardType={m.soloNumeros ? "phone-pad" : "default"}
                    style={[styles.input, { marginTop: 4 }]}
                  />
                )}
              </View>
            ))}

            <TouchableOpacity style={[styles.button, { backgroundColor: "#187830", marginTop: 12 }]} onPress={guardar} disabled={guardando}>
              {guardando ? <ActivityIndicator color="#fff" /> : <Text style={styles.buttonText}>Guardar medios de pago</Text>}
            </TouchableOpacity>
          </View>
          </>
        ) : (
          <View style={styles.card}>
            <Text style={styles.seccionTitulo}>Pagos</Text>
            <Text style={{ fontSize: 14, color: "#555", lineHeight: 20 }}>
              Le pagas directo al conductor. Cuando aceptes una carrera, veras que medios acepta
              (efectivo, Nequi, Bancolombia, Bre-B...) para que pagues como prefieras.
            </Text>
          </View>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

export default function App() {
  const [listo, setListo] = useState(false);

  // al abrir, busca la ultima version y la aplica ANTES de mostrar la app, para
  // que nadie quede atrasado con actualizaciones que no alcanzaron a bajar
  useEffect(() => {
    let vivo = true;
    (async () => {
      try {
        const u = await Promise.race([
          Updates.checkForUpdateAsync(),
          new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 4000)),
        ]);
        if (u && u.isAvailable) {
          await Updates.fetchUpdateAsync();
          await Updates.reloadAsync();   // reemplaza la app por la nueva version
          return;
        }
      } catch (e) { /* sin conexion o en desarrollo: se sigue con lo que hay */ }
      if (vivo) setListo(true);
    })();
    return () => { vivo = false; };
  }, []);

  if (!listo) {
    return (
      <View style={{ flex: 1, backgroundColor: "#F6F1E6", alignItems: "center", justifyContent: "center" }}>
        <Image source={require("./assets/icon.png")} style={{ width: 180, height: 180, borderRadius: 36 }} />
        <Text style={{ color: "#187830", fontSize: 32, fontWeight: "bold", marginTop: 16 }}>Tukán</Text>
        <Text style={{ color: "#888", marginTop: 4, fontSize: 13 }}>Domicilios y carreras amazónicas</Text>
        <ActivityIndicator color="#187830" style={{ marginTop: 20 }} />
        <Text style={{ color: "#aaa", marginTop: 10, fontSize: 12 }}>Buscando actualizaciones...</Text>
      </View>
    );
  }

  return (
    <SafeAreaProvider>
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
        <Stack.Screen name="Configuracion" component={ConfiguracionScreen} />
      </Stack.Navigator>
    </NavigationContainer>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#F6F1E6" },
  scroll: { padding: 16 },
  header: { backgroundColor: "#187830", padding: 20, paddingTop: 50 },
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
  button: { backgroundColor: "#F06000", borderRadius: 10, padding: 14, alignItems: "center", shadowColor: "#000", shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.15, shadowRadius: 4, elevation: 3 },
  buttonText: { color: "#fff", fontWeight: "bold", fontSize: 16 },
  searchInput: { backgroundColor: "rgba(255,255,255,0.2)", borderRadius: 10, padding: 10, fontSize: 13, marginTop: 12, color: "#fff" },
  // --- carreras
  servicioCard: { backgroundColor: "#FDEEDC", borderRadius: 16, padding: 24, alignItems: "center", marginBottom: 16 },
  servicioTitulo: { fontSize: 20, fontWeight: "bold", color: "#F06000", marginTop: 10 },
  servicioSub: { fontSize: 13, color: "#888", marginTop: 4, textAlign: "center" },
  etiqueta: { fontSize: 11, color: "#888", fontWeight: "600", letterSpacing: 0.5, marginBottom: 4 },
  ayuda: { fontSize: 11, color: "#888", marginTop: -6, marginBottom: 6 },
  sugerencias: { backgroundColor: "#fff", borderWidth: 0.5, borderColor: "#ddd", borderRadius: 8, marginTop: -8, marginBottom: 12, overflow: "hidden" },
  sugerenciaItem: { paddingVertical: 10, paddingHorizontal: 12, borderBottomWidth: 0.5, borderBottomColor: "#eee" },
  seccionTitulo: { fontSize: 15, fontWeight: "600", color: "#333", marginBottom: 10, marginTop: 6 },
  disponibleBar: { marginHorizontal: 16, marginTop: 16, borderRadius: 12, padding: 14, alignItems: "center" },
  barraEstado: { flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 10, paddingHorizontal: 18, backgroundColor: "#fff", borderTopWidth: 2 },
  placaBadge: { backgroundColor: "#333", borderRadius: 6, paddingHorizontal: 12, paddingVertical: 6, alignSelf: "flex-start", marginTop: 8 },
  placaTexto: { color: "#fff", fontWeight: "bold", fontSize: 16, letterSpacing: 2 },
  avisoRural: { backgroundColor: "#FFF4E0", borderRadius: 6, paddingHorizontal: 10, paddingVertical: 5, marginTop: 10, alignSelf: "flex-start" },
  avisoRuralTexto: { fontSize: 11, color: "#8A5A00", fontWeight: "600" },
  avisoVencido: { backgroundColor: "#FBECEC", marginHorizontal: 16, marginTop: 16, borderRadius: 12, padding: 14 },
  mini: { flex: 1, backgroundColor: "#fff", borderRadius: 12, padding: 12, alignItems: "center", elevation: 2 },
  miniNum: { fontSize: 22, fontWeight: "bold", color: "#187830" },
  miniTxt: { fontSize: 11, color: "#888", marginTop: 2 },
  estadoBadge: { borderRadius: 6, paddingHorizontal: 10, paddingVertical: 4 },
  statHoy: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", backgroundColor: "#EAF6EC", borderRadius: 12, padding: 14 },
  pagoFila: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingVertical: 12, borderBottomWidth: 0.5, borderBottomColor: "#eee", marginBottom: 8 },
  switch: { backgroundColor: "#eee", borderRadius: 12, paddingHorizontal: 12, paddingVertical: 5, minWidth: 44, alignItems: "center" },
  switchOn: { backgroundColor: "#187830" },
  pagoItem: { fontSize: 14, color: "#333", marginTop: 3 },
  pasos: { flexDirection: "row", gap: 6, marginBottom: 12 },
  paso: { flex: 1, backgroundColor: "#eee", borderRadius: 8, paddingVertical: 8, alignItems: "center" },
  pasoActivo: { backgroundColor: "#187830" },
  tabBar: { flexDirection: "row", borderTopWidth: 0.5, borderTopColor: "#ddd", backgroundColor: "#fff", paddingBottom: 6, paddingTop: 8 },
  tabBarItem: { flex: 1, alignItems: "center" },
  log: { backgroundColor: "#fff", borderRadius: 12, padding: 12, marginBottom: 8, borderLeftWidth: 3, borderLeftColor: "#187830", elevation: 1, shadowColor: "#000", shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.06, shadowRadius: 3 },
  urgente: { backgroundColor: "#fff", borderRadius: 16, padding: 15, marginBottom: 12, borderWidth: 2, borderColor: "#F06000", elevation: 3, shadowColor: "#F06000", shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.18, shadowRadius: 6 },
  cuenta: { width: 30, height: 30, borderRadius: 15, backgroundColor: "#F06000", alignItems: "center", justifyContent: "center" },
  barraFondo: { height: 5, backgroundColor: "#eee", borderRadius: 3, marginTop: 8, overflow: "hidden" },
  barra: { height: 5, backgroundColor: "#F06000", borderRadius: 3 },
  chipOferta: { flex: 1, borderWidth: 1.5, borderColor: "#F06000", borderRadius: 12, paddingVertical: 11, alignItems: "center" },
  chipOfertaTxt: { color: "#B85C00", fontWeight: "800", fontSize: 15 },
  chipOtro: { borderWidth: 1.5, borderColor: "#ccc", borderRadius: 12, paddingVertical: 11, paddingHorizontal: 14, alignItems: "center" },
  fotoBox: { width: "100%", aspectRatio: 1, borderRadius: 10, backgroundColor: "#F1F8F1", borderWidth: 1, borderColor: "#187830", borderStyle: "dashed", alignItems: "center", justifyContent: "center", overflow: "hidden" },
  statCelda: { width: "50%", paddingVertical: 8 },
  botonGps: { backgroundColor: "#187830", borderRadius: 8, padding: 13, alignItems: "center", marginBottom: 8 },
  muniBanner: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", backgroundColor: "#E7F3E9", borderRadius: 8, padding: 10, marginBottom: 12 },
  botonMapa: { borderWidth: 1, borderColor: "#187830", borderRadius: 8, padding: 12, alignItems: "center", marginBottom: 8, backgroundColor: "#F1F8F1" },
  botonMapaOk: { borderColor: "#187830", backgroundColor: "#EAF6EC" },
  estimado: { backgroundColor: "#F1F8F1", borderRadius: 10, padding: 14, marginTop: 6, alignItems: "center" },
  ofertaFila: { flexDirection: "row", alignItems: "center", borderWidth: 1, borderColor: "#187830", borderRadius: 10, paddingHorizontal: 12, backgroundColor: "#F1F8F1" },
  ofertaInput: { flex: 1, fontSize: 22, fontWeight: "bold", color: "#187830", padding: 12 },
  ofertaCliente: { backgroundColor: "#EAF6EC", borderRadius: 10, padding: 10, marginTop: 10, alignItems: "center" },
  opcion: { flex: 1, paddingVertical: 10, paddingHorizontal: 6, borderRadius: 8, borderWidth: 1, borderColor: "#ddd", alignItems: "center", backgroundColor: "#fff" },
  opcionActiva: { backgroundColor: "#E7F3E9", borderColor: "#187830" },
  opcionTexto: { fontSize: 13, color: "#888" },
  opcionTextoActivo: { color: "#187830", fontWeight: "600" },
  // chips de ancho automatico para el scroll horizontal de dia/hora
  chip: { paddingVertical: 8, paddingHorizontal: 14, borderRadius: 20, borderWidth: 1, borderColor: "#ddd", backgroundColor: "#fff" },
  chipOn: { backgroundColor: "#187830", borderColor: "#187830" },
  chipTxt: { fontSize: 13, color: "#555" },
  chipTxtOn: { color: "#fff", fontWeight: "700" },
  // tarjetas de categoria del registro (cliente / carreras / acarreos)
  catBoton: { flexDirection: "row", alignItems: "center", gap: 12, borderWidth: 1, borderColor: "#ddd", borderRadius: 12, padding: 12, backgroundColor: "#fff" },
  catBotonOn: { borderColor: "#187830", backgroundColor: "#EAF6EC", borderWidth: 2 },
  catEmoji: { fontSize: 26 },
  catTitulo: { fontSize: 15, fontWeight: "700", color: "#333" },
  catTituloOn: { color: "#187830" },
  catSub: { fontSize: 12, color: "#888", marginTop: 1 },
  fondoModal: { flex: 1, backgroundColor: "rgba(0,0,0,0.5)", justifyContent: "center", padding: 24 },
  ventanaModal: { backgroundColor: "#fff", borderRadius: 16, padding: 20 },
  restauranteCard: { backgroundColor: "#fff", borderRadius: 12, padding: 14, marginBottom: 12, flexDirection: "row", alignItems: "center", elevation: 2, shadowColor: "#000", shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.08, shadowRadius: 4 },
  restauranteNombre: { fontSize: 15, fontWeight: "600", color: "#333" },
  restauranteCategoria: { fontSize: 12, color: "#888", marginTop: 2 },
  restauranteInfo: { fontSize: 12, color: "#888" },
  calificacionBadge: { backgroundColor: "#EAF3DE", borderRadius: 8, padding: 6 },
  calificacionText: { fontSize: 12, color: "#187830", fontWeight: "500" },
  platoCard: { backgroundColor: "#fff", borderRadius: 12, padding: 14, marginBottom: 12, flexDirection: "row", alignItems: "center", elevation: 2, shadowColor: "#000", shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.08, shadowRadius: 4 },
  btnCantidad: { width: 28, height: 28, borderRadius: 14, borderWidth: 0.5, borderColor: "#ddd", alignItems: "center", justifyContent: "center" },
  botonCarrito: { position: "absolute", bottom: 20, left: 16, right: 16, backgroundColor: "#F06000", borderRadius: 12, padding: 16, alignItems: "center", elevation: 4 },
});