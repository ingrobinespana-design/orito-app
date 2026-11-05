import { useState, useEffect, useRef, useMemo, forwardRef } from 'react';
import { NavigationContainer, createNavigationContainerRef } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { View, Text as RNText, TextInput as RNTextInput, TouchableOpacity, StyleSheet, SafeAreaView, ScrollView, ActivityIndicator, Image, Alert, Platform, Modal, LayoutAnimation, UIManager, Linking, Animated, Vibration, KeyboardAvoidingView, findNodeHandle, Share, Dimensions, AppState, NativeModules, Keyboard } from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import * as Notifications from 'expo-notifications';
import * as Device from 'expo-device';
import Constants from 'expo-constants';
import * as Location from 'expo-location';
import * as TaskManager from 'expo-task-manager';
import { WebView } from 'react-native-webview';
import * as Updates from 'expo-updates';
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context';
import AsyncStorage from '@react-native-async-storage/async-storage';
import TukanOverlay from './modules/tukan-overlay';

// Letra de toda la app: Inter (la de NEXA), metida en el APK por
// plugins/fuentes.js. En APKs viejos sin la letra, Android usa la normal.
const FUENTE = { fontFamily: "Inter" };
// en la vista web (solo pruebas) se carga Inter de Google Fonts
if (Platform.OS === "web" && typeof document !== "undefined" && !document.getElementById("fuente-inter")) {
  const l = document.createElement("link");
  l.id = "fuente-inter"; l.rel = "stylesheet";
  l.href = "https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap";
  document.head.appendChild(l);
}
const Text = forwardRef((props, ref) => <RNText ref={ref} {...props} style={[FUENTE, props.style]} />);
const COLOR_GUIA = "#7C8278";   // texto guia de los campos: legible tambien con el celular en modo oscuro
const TextInput = forwardRef((props, ref) => <RNTextInput ref={ref} placeholderTextColor={COLOR_GUIA} {...props} style={[FUENTE, props.style]} />);

// Produccion por defecto. Para probar contra un servidor local se arranca con
// EXPO_PUBLIC_API_URL=http://localhost:8000 y asi nunca queda un localhost publicado.
const API = process.env.EXPO_PUBLIC_API_URL || "https://orito-app-production.up.railway.app";
// Mapbox: tiles profesionales (estilo navegacion, como las apps grandes). El
// token publico (pk.) es seguro en la app; se puede restringir por dominio luego.
const MAPBOX_TOKEN = "pk.eyJ1IjoiZGFyd2luZSIsImEiOiJjbXNkenQ2Ym4wMDN3MnhxMGoxZGlyN3R2In0.WwBcBvXWmpy-I55Ceud-Lg";
const MAPBOX_TILES = `https://api.mapbox.com/styles/v1/mapbox/navigation-day-v1/tiles/512/{z}/{x}/{y}@2x?access_token=${MAPBOX_TOKEN}`;
const MAPBOX_STREETS = `https://api.mapbox.com/styles/v1/mapbox/streets-v12/tiles/512/{z}/{x}/{y}@2x?access_token=${MAPBOX_TOKEN}`;
const MAPBOX_SAT = `https://api.mapbox.com/styles/v1/mapbox/satellite-streets-v12/tiles/512/{z}/{x}/{y}@2x?access_token=${MAPBOX_TOKEN}`;
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
// SESION PERSISTENTE: el usuario queda adentro aunque cierre la app (como Uber).
// Se guarda el usuario completo (con token) en el telefono; al abrir se restaura.
const SESION_KEY = "tukan_sesion_v1";
const guardarSesion = async (u) => { try { await AsyncStorage.setItem(SESION_KEY, JSON.stringify(u)); } catch (_) {} };
const leerSesion = async () => { try { const s = await AsyncStorage.getItem(SESION_KEY); return s ? JSON.parse(s) : null; } catch (_) { return null; } };
const borrarSesion = async () => { try { await AsyncStorage.removeItem(SESION_KEY); } catch (_) {} llaveUsuario = null; llaveAdmin = null; };
// a qué pantalla va cada rol al entrar (login o restaurar sesión)
const pantallaDe = (rol) => rol === "admin" ? "Admin" : rol === "domiciliario" ? "Domiciliario"
  : rol === "restaurante" ? "Restaurante" : rol === "conductor" ? "Conductor" : "ElegirServicio";
const adminFetch = (url, opciones = {}) =>
  fetch(url, { ...opciones, headers: { ...(opciones.headers || {}), "X-Admin-Token": llaveAdmin || "" } });
// para acciones sobre lo propio: manda la identidad del usuario
const navRef = createNavigationContainerRef();
let avisoSesionDado = false;
const userFetch = (url, opciones = {}) =>
  fetch(url, { ...opciones, headers: { ...(opciones.headers || {}), "X-User-Token": llaveUsuario || "" } })
    .then((r) => {
      // sesion vencida (entro con la misma cuenta en otro celular, o soporte le cambio
      // la clave): se le explica y se le lleva a entrar de nuevo, en vez de "HTTP 401"
      if (r.status === 401 && llaveUsuario && !avisoSesionDado && navRef.isReady()) {
        avisoSesionDado = true;
        borrarSesion().catch(() => {}).finally(() => {
          avisar("Vuelve a iniciar sesión", "Tu sesión se cerró porque esta cuenta se abrió en otro celular (o se cambió la contraseña). Entra de nuevo con tu número y contraseña.");
          try { navRef.reset({ index: 0, routes: [{ name: "Login" }] }); } catch (e) {}
          setTimeout(() => { avisoSesionDado = false; }, 5000);
        });
      }
      return r;
    });

// ===== rastreo en SEGUNDO PLANO del conductor con carrera activa =====
// Un servicio de Android (notificacion fija "carrera en curso") sigue enviando
// la ubicacion aunque el conductor cierre Tukan, bloquee el telefono o navegue
// con Google Maps: el cliente lo ve venir en tiempo real pase lo que pase.
const TAREA_UBICACION = "tukan-ubicacion-carrera";
let conductorRastreado = null;   // id del conductor; lo fija ConductorScreen

let ultimoVivo = 0;
// ¿La pantalla de Tukan esta de verdad a la vista? Cuando Android reinicia la app
// en segundo plano (telefono bloqueado) no hay pantalla, pero AppState dice
// "active". Solo el componente App (que se monta con pantalla) lo pone en true.
let pantallaVisible = false;
const alFrente = () => pantallaVisible && AppState.currentState === "active";
let idsVistosFondo = null;   // carreras ya vistas por el servicio en segundo plano
let activasFondo = null;     // carreras en curso del conductor (para detectar cancelaciones)
let ultimoSonido = 0;        // anti-rebote: no sonar dos veces (fondo + pantalla)
// solicitud que se aviso a pantalla completa: al abrir la app se muestra de una
let solicitudDesdeFondo = null;

// evita sonar dos veces seguidas (cuando app abierta corren el ping y el fondo)
function puedeSonar() {
  if (Date.now() - ultimoSonido < 7000) return false;
  ultimoSonido = Date.now();
  return true;
}

// ===== AVISO A PANTALLA COMPLETA (tipo llamada) =====
// Con Notifee (APK con pantalla completa) el aviso salta encima de todo: telefono
// bloqueado, en segundo plano o en otra app, y abre Tukan. En APKs viejos sin esa
// pieza nativa no existe: se usa el aviso normal de siempre (no se rompe nada).
let notifee = null, NotifeeTipos = null;
try {
  if (Platform.OS === "android" && NativeModules.NotifeeApiModule) {
    const m = require("@notifee/react-native");
    notifee = m.default; NotifeeTipos = m;
  }
} catch (e) { notifee = null; }
let canalPantallaLista = false;
async function canalPantalla() {
  const { AndroidImportance, AndroidVisibility } = NotifeeTipos;
  if (!canalPantallaLista) {
    await notifee.createChannel({
      id: CANAL_PANTALLA, name: "Avisos a pantalla completa", importance: AndroidImportance.HIGH,
      sound: SONIDO_PANTALLA, vibration: true, vibrationPattern: [300, 500, 300, 500],
      bypassDnd: true, visibility: AndroidVisibility.PUBLIC,
    });
    canalPantallaLista = true;
  }
}
function notifPantallaCompleta(id, titulo, cuerpo) {
  const { AndroidImportance, AndroidVisibility, AndroidCategory } = NotifeeTipos;
  return {
    id, title: titulo, body: cuerpo,
    android: {
      channelId: CANAL_PANTALLA, category: AndroidCategory.CALL, importance: AndroidImportance.HIGH,
      visibility: AndroidVisibility.PUBLIC, sound: SONIDO_PANTALLA, lightUpScreen: true, autoCancel: true,
      fullScreenAction: { id: "default" }, pressAction: { id: "default" }, timeoutAfter: 90000,
    },
  };
}
async function avisoPantallaCompleta(id, titulo, cuerpo) {
  if (!notifee) return false;
  try {
    await canalPantalla();
    await notifee.displayNotification(notifPantallaCompleta(id, titulo, cuerpo));
    return true;
  } catch (e) { return false; }
}
function quitarAviso(id) {
  try { if (notifee) notifee.cancelNotification(id); } catch (e) {}
  try { if (TukanOverlay && TukanOverlay.quitarAvisos) TukanOverlay.quitarAvisos(); } catch (e) {}
}
// APK con receptor nativo de push (el aviso tipo llamada lo hace Android solo)
// Tono propio "Selva": solo si el APK lo trae (los APK viejos siguen con el tono anterior;
// el sonido de un canal de Android no se cambia, por eso los canales son nuevos)
const TONO_SELVA = (() => { try { return !!(TukanOverlay && TukanOverlay.tonoSelva && TukanOverlay.tonoSelva()); } catch (e) { return false; } })();
const CANAL_EXPO = TONO_SELVA ? "carreras4" : "carreras3";
const SONIDO_EXPO = TONO_SELVA ? "tono_selva.wav" : "tono.wav";
const CANAL_PANTALLA = TONO_SELVA ? "alerta_selva" : "alerta_total";
const SONIDO_PANTALLA = TONO_SELVA ? "tono_selva" : "tono";
const avisoNativo = () => { try { return !!(TukanOverlay && TukanOverlay.avisoNativo && TukanOverlay.avisoNativo()); } catch (e) { return false; } };

// ===== TUKAN AL FRENTE (encima de Waze, WhatsApp...) =====
// Con el permiso "Mostrar encima de otras apps", Android deja abrir Tukan desde
// segundo plano: la solicitud o la cancelacion aparecen encima de lo que este usando.
const puedeSobreponer = () => { try { return !!(TukanOverlay && TukanOverlay.puedeSobreponer()); } catch (e) { return false; } };
function traerTukanAlFrente() {
  try { if (TukanOverlay && TukanOverlay.puedeSobreponer()) TukanOverlay.traerAlFrente(); } catch (e) {}
}

/** Prueba: programa un aviso a pantalla completa en unos segundos para que el
 *  conductor bloquee el telefono y vea si le sale encima de todo. */
async function probarPantallaCompleta() {
  if (!notifee) {
    avisar("Falta actualizar la app", "Esta versión no trae los avisos a pantalla completa. Instala el APK nuevo desde el link de descarga.");
    return;
  }
  try {
    await canalPantalla();
    await notifee.createTriggerNotification(
      notifPantallaCompleta("prueba-pantalla", "🔔 Prueba de Tukán", "Si ves esto encima de todo, los avisos a pantalla completa funcionan ✅"),
      { type: NotifeeTipos.TriggerType.TIMESTAMP, timestamp: Date.now() + 10000 });
    avisar("Bloquea el teléfono ya 🔒", "En unos 10 segundos debe encenderse la pantalla con un aviso de prueba de Tukán.\n\nSi solo te llega una notificación normal, falta activar el permiso de pantalla completa (te mostramos cómo).");
  } catch (e) { avisar("No se pudo programar la prueba", String((e && e.message) || e)); }
}

// SUENA fuerte aunque la app este minimizada o cerrada, SIN depender del push:
// lo dispara el servicio en segundo plano al detectar una carrera nueva. Si la app
// no esta al frente, el aviso sale a pantalla completa (si el APK lo soporta).
async function sonarCarreraFondo(c) {
  if (!puedeSonar()) return;
  const carga = c && esCarga(c.vehiculo_pedido);
  const titulo = carga ? "🚚 Nuevo acarreo" : "🔔 Nueva solicitud de carrera";
  const cuerpo = c ? `${limpiaDir(c.origen)} → ${limpiaDir(c.destino)}${c.tarifa_ofrecida ? ` · ofrece $${c.tarifa_ofrecida.toLocaleString()}` : ""}` : "Toca para verla y responder.";
  if (c && !alFrente()) {
    solicitudDesdeFondo = c.id;
    traerTukanAlFrente();
    if (await avisoPantallaCompleta(`solicitud-${c.id}`, titulo, cuerpo)) return;
  }
  try { Vibration.vibrate([0, 500, 220, 500]); } catch (e) {}
  Notifications.scheduleNotificationAsync({
    content: { title: titulo, body: cuerpo, sound: SONIDO_EXPO },
    trigger: Platform.OS === "android" ? { channelId: CANAL_EXPO, seconds: 1 } : null,
  }).catch(() => {});
}

try {
  TaskManager.defineTask(TAREA_UBICACION, async ({ data, error }) => {
    if (error) return;
    // si Android reinicio Tukan en segundo plano (telefono bloqueado), la memoria
    // se borra: el conductor se recupera de lo guardado en el telefono
    if (!conductorRastreado) {
      try { const g = await AsyncStorage.getItem("tukan_rastreo_conductor"); if (g) conductorRastreado = Number(g); } catch (e) {}
      // respaldo: la sesion guardada (solo si es conductor)
      if (!conductorRastreado) {
        try { const ses = await leerSesion(); if (ses && ses.rol === "conductor" && ses.id) conductorRastreado = Number(ses.id); } catch (e) {}
      }
      diagFondo("rastreo_reinicio", { recuperado: conductorRastreado || null });
      if (!conductorRastreado) return;
    }
    // senal de vida (1 por minuto) para depurar si Android lo deja correr bloqueado
    if (Date.now() - ultimoVivo > 60000) { ultimoVivo = Date.now(); diagFondo("rastreo_vivo", { c: conductorRastreado }); }
    // 1) reporta la ubicacion (para el seguimiento del cliente si hay carrera activa)
    const locs = data && data.locations;
    if (locs && locs.length) {
      const p = locs[locs.length - 1].coords;
      fetch(`${API}/conductores/${conductorRastreado}/ubicacion?lat=${p.latitude}&lon=${p.longitude}`,
        { method: "PUT" }).catch(() => {});
    }
    // 2) revisa carreras nuevas y SUENA — aunque la app este minimizada o cerrada.
    // Solo suena por las que le corresponden AHORA (cercano, o ya paso la ventana
    // de prioridad): el backend marca 'alertar'. Asi respeta la prioridad por
    // cercania tambien con la app cerrada.
    fetch(`${API}/carreras/disponibles?conductor_id=${conductorRastreado}`)
      .then((r) => r.json())
      .then(async (d) => {
        if (!Array.isArray(d)) return;
        const alertables = d.filter((c) => c.alertar !== false);
        const ids = alertables.map((c) => c.id);
        // tras un reinicio de Android, lo ya visto se recupera del telefono (si no,
        // la solicitud que llego mientras tanto se tomaria como "vista" sin sonar)
        if (idsVistosFondo === null) {
          try { const g = await AsyncStorage.getItem("tukan_rastreo_vistos"); if (g) idsVistosFondo = JSON.parse(g); } catch (e) {}
        }
        AsyncStorage.setItem("tukan_rastreo_vistos", JSON.stringify(ids)).catch(() => {});
        if (idsVistosFondo === null) { idsVistosFondo = ids; return; }   // primera vez: solo memoriza
        const nueva = alertables.find((c) => idsVistosFondo.indexOf(c.id) === -1);
        idsVistosFondo = ids;
        if (nueva) { diagFondo("rastreo_nueva", { id: nueva.id, frente: alFrente() }); sonarCarreraFondo(nueva); }
      })
      .catch(() => {});
    // 3) si el pasajero le cancela una carrera en curso y la app no esta al frente,
    // aviso a pantalla completa con el motivo (al abrir, la app muestra la ventana)
    fetch(`${API}/carreras/conductor/${conductorRastreado}`)
      .then((r) => r.json())
      .then((d) => {
        if (!Array.isArray(d)) return;
        const activas = d.filter((c) => ["aceptada", "en_sitio", "en_camino"].includes(c.estado)).map((c) => c.id);
        if (activasFondo !== null && !alFrente()) {
          const c = d.find((x) => activasFondo.indexOf(x.id) !== -1 && x.estado === "cancelada" && x.cancelada_por !== "conductor");
          if (c) traerTukanAlFrente();
          if (c) avisoPantallaCompleta(`cancelada-${c.id}`, "❌ El pasajero canceló la carrera",
            `${limpiaDir(c.origen)} → ${limpiaDir(c.destino)}. Motivo: ${c.motivo_cancelacion || "sin motivo"}`);
        }
        activasFondo = activas;
      })
      .catch(() => {});
  });
} catch (e) {}   // en web no existe TaskManager y no hace falta

// ===== PUSH QUE SE CONVIERTE EN PANTALLA COMPLETA =====
// Con el telefono bloqueado Android pausa la app y no alcanza a revisar sola; el
// push del servidor si llega al instante. A los conductores con este APK el
// servidor les manda un push SOLO DE DATOS: esta tarea lo recibe (app bloqueada,
// en otra app o cerrada) y lo convierte en aviso tipo llamada + Tukan al frente.
const TAREA_PUSH = "tukan-push-fondo";
function datosDePush(data) {
  const intentar = (c) => {
    if (!c) return null;
    if (c.tipo) return c;
    for (const k of ["body", "dataString"]) {
      if (typeof c[k] === "string") { try { const b = JSON.parse(c[k]); if (b && b.tipo) return b; } catch (e) {} }
    }
    return null;
  };
  try {
    const n = data && data.notification;
    return intentar(data && data.data) || intentar(n && n.data)
      || intentar(n && n.request && n.request.content && n.request.content.data) || intentar(data);
  } catch (e) { return null; }
}
// reporte de depuracion al servidor: que recibio la app en segundo plano y en
// que paso quedo (se ve con GET /diag/eventos). No lleva datos personales.
function diagFondo(paso, extra) {
  try {
    fetch(`${API}/diag/evento`, { method: "POST", headers: { "Content-Type": "text/plain" },
      body: JSON.stringify({ paso, app: AppState.currentState, vis: pantallaVisible, notifee: !!notifee, sobre: puedeSobreponer(), ...(extra || {}) }).slice(0, 1900) }).catch(() => {});
  } catch (e) {}
}
async function manejarPushFondo(d) {
  if (!d || !d.tipo) { diagFondo("sin_tipo"); return; }
  if (d.tipo === "carrera_nueva") solicitudDesdeFondo = Number(d.carrera_id) || solicitudDesdeFondo;
  if (alFrente()) { diagFondo("app_activa", { tipo: d.tipo }); return; }   // con la app al frente la maneja la pantalla
  // APK con receptor nativo: el aviso tipo llamada ya lo mostro Android (no se duplica)
  if (avisoNativo()) { diagFondo("nativo", { tipo: d.tipo }); return; }
  const titulo = d.titulo || "Tukán", cuerpo = d.cuerpo || "";
  const id = d.tipo === "carrera_cancelada" ? `cancelada-${d.carrera_id}` : `solicitud-${d.carrera_id}`;
  traerTukanAlFrente();
  const ok = await avisoPantallaCompleta(id, titulo, cuerpo);
  diagFondo("aviso", { tipo: d.tipo, ok });
  if (!ok) {
    Notifications.scheduleNotificationAsync({
      content: { title: titulo, body: cuerpo, sound: SONIDO_EXPO },
      trigger: Platform.OS === "android" ? { channelId: CANAL_EXPO, seconds: 1 } : null,
    }).catch(() => {});
  }
}
let tareaPushLista = Promise.resolve(false);
try {
  if (Platform.OS === "android" && notifee) {
    TaskManager.defineTask(TAREA_PUSH, ({ data, error }) => {
      const d = error ? null : datosDePush(data);
      diagFondo("push_recibido", { tipo: d && d.tipo, frente: alFrente() });
      return error ? null : manejarPushFondo(d);
    });
    tareaPushLista = Notifications.registerTaskAsync(TAREA_PUSH).then(() => true).catch(() => false);
  }
} catch (e) {}

async function iniciarRastreoFondo(conductorId) {
  try {
    conductorRastreado = conductorId;
    AsyncStorage.setItem("tukan_rastreo_conductor", String(conductorId)).catch(() => {});
    AsyncStorage.removeItem("tukan_rastreo_vistos").catch(() => {});
    idsVistosFondo = null;   // arranca fresco: memoriza y luego suena solo con las NUEVAS
    if (Platform.OS === "web") return false;
    const ya = await Location.hasStartedLocationUpdatesAsync(TAREA_UBICACION).catch(() => false);
    if (ya) return true;
    // el permiso "todo el tiempo" es lo ideal; si no lo dan, el servicio en
    // primer plano igual funciona en la mayoria de Androids modernos
    // aviso destacado ANTES de pedir "todo el tiempo" (requisito de Google Play)
    const bg = await Location.getBackgroundPermissionsAsync().catch(() => null);
    if (!bg || bg.status !== "granted") {
      const acepta = await new Promise((res) => Alert.alert(
        "📍 Ubicación en segundo plano",
        "Tukán recoge tu ubicación mientras estás CONECTADO como conductor, incluso con la app cerrada o el teléfono bloqueado, para avisarte de solicitudes cercanas y para que el pasajero te vea llegar en vivo.\n\nVerás la notificación fija \"Tukán activo\" mientras esto ocurre. Al desconectarte, se detiene.\n\nEn la siguiente pantalla elige \"Permitir todo el tiempo\".",
        [{ text: "Ahora no", style: "cancel", onPress: () => res(false) }, { text: "Continuar", onPress: () => res(true) }],
        { cancelable: false }));
      if (acepta) await Location.requestBackgroundPermissionsAsync().catch(() => {});
    }
    await Location.startLocationUpdatesAsync(TAREA_UBICACION, {
      accuracy: Location.Accuracy.Balanced,
      timeInterval: 9000,          // cada ~9s revisa carreras y reporta ubicacion
      distanceInterval: 0,         // por tiempo, no por distancia (para oir aunque este quieto)
      foregroundService: {
        notificationTitle: "🚕 Tukán activo — buscando carreras",
        notificationBody: "Te avisamos con sonido cuando entre una solicitud, aunque tengas la app cerrada.",
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
  motocarguero: { label: "Motocarguero", icono: "🛵", grupo: "carga" },
  camion_pequeno: { label: "Camión pequeño (Piaggio)", icono: "🚙", grupo: "carga" },
  camioneta:    { label: "Camioneta",    icono: "🚙", grupo: "carga" },
  camion:       { label: "Camión",       icono: "🚚", grupo: "carga" },
  furgon:       { label: "Furgón",       icono: "🚐", grupo: "carga" },
  planchon:     { label: "Planchón",     icono: "🚛", grupo: "carga" },
  grua:         { label: "Grúa",         icono: "🏗️", grupo: "carga" },
};
const vehLabel = (t) => (VEHICULOS[t] ? VEHICULOS[t].label : (t || ""));
const vehIcono = (t) => (VEHICULOS[t] ? VEHICULOS[t].icono : "🚗");
// direccion "limpia" para mostrar: sin los pines/banderas que se guardan como
// prefijo (a veces repetidos) y con tilde en "Mi ubicación actual"
const limpiaDir = (t) => String(t || "")
  .replace(/^[\s\u{1F4CD}\u{1F3C1}\u{1F4CC}\u{1F7E2}\u{1F534}️]+/u, "")
  .replace("Mi ubicacion actual", "Mi ubicación actual").trim();
const esCarga = (t) => VEHICULOS[t] && VEHICULOS[t].grupo === "carga";
const estadoExpreso = (e) => ({ buscando: "buscando conductor", aceptado: "✅ asignado", en_camino: "🚗 en camino", finalizado: "finalizado", cancelado: "cancelado" }[e] || e);
// orden de aparicion: primero personas, luego carga
const ordenVehiculos = (tipos) =>
  Object.keys(VEHICULOS).filter((t) => tipos.includes(t));

// --- agendar recogida (solo trasteos). Todo con Date nativo, SIN modulos
//     nativos de calendario, para que viaje por OTA sin recompilar.
const DIAS_ABR = ["dom", "lun", "mar", "mie", "jue", "vie", "sab"];
function diasProximos() {
  const arr = [];
  for (let i = 0; i < 15; i++) {
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
// reloj COMPLETO: cualquier hora (0-23) y minutos cada 5. Para agendar a la hora
// exacta que sea, sin quedar limitado a un rango predeterminado.
function horasCompletas() {
  const arr = [];
  for (let h = 0; h < 24; h++) {
    const ampm = h < 12 ? "am" : "pm";
    const h12 = h % 12 === 0 ? 12 : h % 12;
    arr.push({ h, lbl: `${h12} ${ampm}` });
  }
  return arr;
}
function minutosLista() {
  const arr = [];
  for (let m = 0; m < 60; m += 5) arr.push({ m, lbl: `:${String(m).padStart(2, "0")}` });
  return arr;
}
const MESES_ES = ["Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio", "Julio", "Agosto", "Septiembre", "Octubre", "Noviembre", "Diciembre"];
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
// fecha completa y clara para el detalle: "Jueves 24 de agosto, 4:00 p.m."
const DIAS_LARGO = ["Domingo", "Lunes", "Martes", "Miércoles", "Jueves", "Viernes", "Sábado"];
function fmtFechaLarga(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  const h = d.getHours(), m = d.getMinutes();
  const ampm = h < 12 ? "a.m." : "p.m."; const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${DIAS_LARGO[d.getDay()]} ${d.getDate()} de ${MESES_ES[d.getMonth()].toLowerCase()}, ${h12}:${String(m).padStart(2, "0")} ${ampm}`;
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

/** Abre el WhatsApp de soporte con un mensaje pre-llenado que identifica al
 *  usuario (nombre, telefono, ciudad) para atenderlo rapido. */
function soporteWhatsApp(num, usuario) {
  let n = soloDigitos(num);
  if (!n) { avisar("Soporte no configurado", "Aún no hay número de soporte. Inténtalo más tarde."); return; }
  if (n.length === 10) n = "57" + n;
  const u = usuario || {};
  const txt = `Hola, soy ${u.nombre || ""} (${u.telefono || ""})${u.municipio ? " de " + u.municipio : ""}. Necesito ayuda con:`;
  Linking.openURL(`https://wa.me/${n}?text=${encodeURIComponent(txt)}`)
    .catch(() => Linking.openURL(`https://wa.me/${n}`).catch(() => {}));
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
      // Los canales de Android son INMUTABLES: si "carreras2" se creo alguna vez
      // sin el tono, ya no se le puede cambiar el sonido. Se borran los viejos y
      // se crea uno NUEVO ("carreras3") para forzar el tono propio en todos.
      try { await Notifications.deleteNotificationChannelAsync("carreras"); } catch (e) {}
      try { await Notifications.deleteNotificationChannelAsync("carreras2"); } catch (e) {}
      // El canal define que suene fuerte y salte en pantalla.
      // con el APK del tono Selva se crea "carreras4"; "carreras3" se deja para los
      // pushes que el servidor aun mande con el canal viejo
      await Notifications.setNotificationChannelAsync(CANAL_EXPO, {
        name: "Carreras",
        importance: Notifications.AndroidImportance.MAX,
        vibrationPattern: [0, 500, 220, 500],
        sound: SONIDO_EXPO,   // tono propio (Selva desde el APK nuevo)
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

    // FCM a veces responde SERVICE_NOT_AVAILABLE (red/Google Play temporal);
    // se reintenta unas veces con espera, que suele destrabarlo
    let token, ultimoError;
    for (let i = 0; i < 4; i++) {
      try {
        const res = await Notifications.getExpoPushTokenAsync({ projectId });
        token = res.data;
        break;
      } catch (e) {
        ultimoError = e;
        await new Promise((res) => setTimeout(res, 2500 * (i + 1)));
      }
    }
    if (!token) {
      const msg = (ultimoError && (ultimoError.message || String(ultimoError))) || "sin token";
      const pista = msg.includes("SERVICE_NOT_AVAILABLE")
        ? "\n\nEsto es temporal (red o Google Play). Revisa que tengas buen internet, y vuelve a tocar 'Re-registrar'. Si sigue, reinicia el teléfono."
        : "";
      return { ok: false, motivo: "Error obteniendo el token (FCM): " + msg + pista };
    }

    // "si" = este APK convierte el push en aviso a pantalla completa (el servidor
    // le manda push solo de datos); "no" = push normal
    const pantalla = (await tareaPushLista) ? "si" : "no";
    const r = await userFetch(`${API}/usuarios/${usuarioId}/push-token?token=${encodeURIComponent(token)}&pantalla_completa=${pantalla}&canal=${CANAL_EXPO}`, { method: "PUT" });
    if (!r.ok) return { ok: false, motivo: "El servidor rechazo el token (HTTP " + r.status + ").", token };
    return { ok: true, motivo: "Token guardado.", token };
  } catch (e) {
    return { ok: false, motivo: "Error: " + (e.message || String(e)) };
  }
}

// etiqueta encima de cada campo del registro
const estEtiqueta = { fontSize: 14, fontWeight: "800", color: "#2E2E2E", marginBottom: 6 };
// nombres bonitos (en la base algunos quedaron sin tilde)
const NOMBRES_CIUDAD = { "Puerto Asis": "Puerto Asís", "Villgarzon": "Villagarzón", "Villagarzon": "Villagarzón", "Popayan": "Popayán" };
const nombreCiudad = (n) => NOMBRES_CIUDAD[n] || n;
// orden de las zonas: el sur del pais, empezando por Putumayo (donde nacio Tukan)
const ORDEN_DEPTOS = ["Putumayo", "Nariño", "Cauca", "Valle del Cauca", "Caquetá", "Huila"];
const zonasOrdenadas = (munis) => {
  const g = {};
  (munis || []).forEach((m) => { const d = m.departamento || "Otros"; (g[d] = g[d] || []).push(m); });
  const pos = (d) => { const i = ORDEN_DEPTOS.indexOf(d); return i === -1 ? 99 : i; };
  return Object.entries(g)
    .sort((a, b) => pos(a[0]) - pos(b[0]) || a[0].localeCompare(b[0]))
    .map(([d, l]) => [d, l.slice().sort((x, y) => nombreCiudad(x.nombre).localeCompare(nombreCiudad(y.nombre)))]);
};

function LoginScreen({ navigation }) {
  const [modo, setModo] = useState("login");
  // categoria: que va a hacer -> "cliente" | "carreras" (personas) | "acarreos" (carga)
  // comoMe: el vehiculo exacto (o "cliente"). Se elige en 2 pasos.
  const [form, setForm] = useState({ nombre: "", telefono: "", password: "", municipio: "", categoria: "cliente", comoMe: "cliente", placa: "" });
  const [zonaAbierta, setZonaAbierta] = useState(false);
  // al escribir telefono/contraseña la pantalla baja para que el teclado no los tape
  const scrollLogin = useRef(null);
  const verCampos = () => setTimeout(() => { try { scrollLogin.current && scrollLogin.current.scrollToEnd({ animated: true }); } catch (e) {} }, 300);
  const [municipios, setMunicipios] = useState([]);
  const [cargandoMun, setCargandoMun] = useState(true);
  const [verPass, setVerPass] = useState(false);   // mostrar/ocultar la contraseña
  const [restaurando, setRestaurando] = useState(true);   // revisa si hay sesión guardada al abrir
  // SESION: si quedó una sesión guardada, entra directo (no pide login cada vez)
  useEffect(() => {
    (async () => {
      const s = await leerSesion();
      if (s && s.id && s.token) {
        guardarLlave(s);
        registrarNotificaciones(s.id);
        navigation.replace(pantallaDe(s.rol), { usuario: s });
      } else {
        setRestaurando(false);
      }
    })();
  }, []);

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
    if (modo === "registro" && !form.nombre.trim()) { setError("Escribe tu nombre"); return; }
    if (modo === "registro" && !form.municipio) { setError("Escoge tu zona (la ciudad donde usarás Tukán)"); return; }
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
        guardarSesion(data);  // queda la sesión guardada: no pide entrar cada vez
        registrarNotificaciones(data.id);
        // entro con un codigo de grupo de la comunidad (CALI20 / REDCALI)
        if (data.beneficio) avisar("¡Bienvenido a Tukán!", data.beneficio);
        if (data.rol === "admin") navigation.replace("Admin", { usuario: data });
        else if (data.rol === "domiciliario") navigation.replace("Domiciliario", { usuario: data });
        else if (data.rol === "restaurante") navigation.replace("Restaurante", { usuario: data });
        else if (data.rol === "conductor") navigation.replace("Conductor", { usuario: data });
        else navigation.replace("ElegirServicio", { usuario: data });
      })
      .catch(() => { setCargando(false); setError("No hay conexion. Verifica tu internet e intenta de nuevo."); });
  };

  // mientras revisa si hay sesión guardada, no muestra el formulario (evita el flash)
  if (restaurando) {
    return (
      <View style={{ flex: 1, backgroundColor: "#F6F1E6", alignItems: "center", justifyContent: "center" }}>
        <Image source={require("./assets/icon.png")} style={{ width: 92, height: 92, borderRadius: 22 }} />
        <ActivityIndicator color="#187830" style={{ marginTop: 18 }} />
      </View>
    );
  }

  return (
    <SafeAreaView style={styles.container}>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior="padding">
      <ScrollView ref={scrollLogin} contentContainerStyle={{ paddingBottom: 30 }} keyboardShouldPersistTaps="handled">
        {/* portada: logo y nombre centrados sobre el verde de la marca */}
        <View style={{ backgroundColor: "#187830", paddingTop: 60, paddingBottom: 70, alignItems: "center", borderBottomLeftRadius: 32, borderBottomRightRadius: 32 }}>
          <Image source={require("./assets/icon.png")} style={{ width: 84, height: 84, borderRadius: 24, borderWidth: 3, borderColor: "rgba(255,255,255,0.9)" }} />
          <Text style={{ color: "#fff", fontSize: 30, fontWeight: "800", marginTop: 12, letterSpacing: -0.5 }}>Tukán</Text>
          <Text style={{ color: "rgba(255,255,255,0.85)", fontSize: 14, marginTop: 2 }}>Carreras y acarreos en tu ciudad</Text>
        </View>
        <View style={[styles.card, { marginHorizontal: 16, marginTop: -44, padding: 20 }]}>
          <Text style={{ fontSize: 22, fontWeight: "800", color: "#1D1D1D", letterSpacing: -0.3 }}>{modo === "login" ? "Iniciar sesión" : "Crea tu cuenta"}</Text>
          <Text style={{ fontSize: 13.5, color: "#8A8A8A", marginTop: 3, marginBottom: 16 }}>{modo === "login" ? "Entra con tu número de celular." : "Es gratis y toma un minuto."}</Text>
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
              <Text style={estEtiqueta}>Tu nombre</Text>
              <TextInput placeholder="Escribe aquí tu nombre y apellido" value={form.nombre} onChangeText={(t) => setForm({ ...form, nombre: t })} style={styles.input} autoCapitalize="words" />

              {/* ZONA: lista desplegable por departamento */}
              <Text style={{ fontSize: 17, fontWeight: "800", color: "#187830", marginTop: 6, marginBottom: 2 }}>📍 Escoge tu zona</Text>
              <Text style={{ fontSize: 12.5, color: "#7A7A7A", marginBottom: 8 }}>La ciudad donde vas a usar Tukán.</Text>
              {cargandoMun ? (
                <View style={{ paddingVertical: 12 }}><ActivityIndicator color="#187830" /></View>
              ) : municipios.length === 0 ? (
                <TouchableOpacity style={[styles.opcion, { marginBottom: 12 }]} onPress={cargarMunicipios}>
                  <Text style={{ color: "#C0392B", fontSize: 13 }}>Sin conexion. Toca para reintentar</Text>
                </TouchableOpacity>
              ) : (
                <>
                  <TouchableOpacity activeOpacity={0.85} onPress={() => setZonaAbierta(true)}
                    style={{ flexDirection: "row", alignItems: "center", borderWidth: 1.5, borderColor: form.municipio ? "#187830" : "#D3D8CE", backgroundColor: form.municipio ? "#EAF6EC" : "#F1F4EE", borderRadius: 12, paddingVertical: 14, paddingHorizontal: 14, marginBottom: 14 }}>
                    <View style={{ flex: 1 }}>
                      {form.municipio ? (
                        <>
                          <Text style={{ fontSize: 16, fontWeight: "800", color: "#187830" }}>{nombreCiudad(form.municipio)}</Text>
                          <Text style={{ fontSize: 12.5, color: "#3F7A4D", marginTop: 1 }}>{(municipios.find(m => m.nombre === form.municipio) || {}).departamento || ""}</Text>
                        </>
                      ) : (
                        <Text style={{ fontSize: 15, color: COLOR_GUIA }}>Toca aquí para elegir tu ciudad</Text>
                      )}
                    </View>
                    <Text style={{ fontSize: 18, color: "#187830", fontWeight: "800" }}>▾</Text>
                  </TouchableOpacity>
                  <Modal visible={zonaAbierta} transparent animationType="slide" onRequestClose={() => setZonaAbierta(false)}>
                    <View style={{ flex: 1, backgroundColor: "rgba(0,0,0,0.45)", justifyContent: "flex-end" }}>
                      <View style={{ backgroundColor: "#fff", borderTopLeftRadius: 24, borderTopRightRadius: 24, maxHeight: "80%", paddingBottom: 18 }}>
                        <View style={{ alignItems: "center", paddingTop: 10 }}><View style={{ width: 44, height: 5, borderRadius: 3, backgroundColor: "#DADDD5" }} /></View>
                        <Text style={{ fontSize: 20, fontWeight: "800", color: "#1D1D1D", paddingHorizontal: 20, paddingTop: 12, paddingBottom: 6 }}>📍 Escoge tu zona</Text>
                        <ScrollView contentContainerStyle={{ paddingHorizontal: 20, paddingBottom: 10 }}>
                          {zonasOrdenadas(municipios).map(([depto, lista]) => (
                            <View key={depto} style={{ marginTop: 12 }}>
                              <Text style={{ fontSize: 12, color: "#8A8A8A", fontWeight: "800", letterSpacing: 1, textTransform: "uppercase", marginBottom: 4 }}>{depto}</Text>
                              {lista.map(m => {
                                const activa = form.municipio === m.nombre;
                                return (
                                  <TouchableOpacity key={m.nombre} activeOpacity={0.7}
                                    onPress={() => {
                                      // al cambiar de ciudad, si el vehiculo elegido no existe alla, se limpia
                                      const permite = (m.vehiculos || []).includes(form.comoMe);
                                      setForm({ ...form, municipio: m.nombre, comoMe: permite ? form.comoMe : (form.categoria === "cliente" ? "cliente" : "") });
                                      setZonaAbierta(false);
                                    }}
                                    style={{ flexDirection: "row", alignItems: "center", paddingVertical: 13, borderBottomWidth: 1, borderBottomColor: "#F0F1EE" }}>
                                    <Text style={{ flex: 1, fontSize: 16, color: activa ? "#187830" : "#1D1D1D", fontWeight: activa ? "800" : "500" }}>{nombreCiudad(m.nombre)}</Text>
                                    {activa ? <Text style={{ color: "#187830", fontSize: 16, fontWeight: "800" }}>✓</Text> : null}
                                  </TouchableOpacity>
                                );
                              })}
                            </View>
                          ))}
                        </ScrollView>
                        <TouchableOpacity onPress={() => setZonaAbierta(false)} style={{ marginHorizontal: 20, marginTop: 6, paddingVertical: 13, alignItems: "center", borderRadius: 12, backgroundColor: "#F1F2EF" }}>
                          <Text style={{ fontWeight: "700", color: "#555" }}>Cerrar</Text>
                        </TouchableOpacity>
                      </View>
                    </View>
                  </Modal>
                </>
              )}

              {/* PASO 1: que va a hacer */}
              <Text style={estEtiqueta}>¿Qué vas a hacer?</Text>
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
                  <Text style={estEtiqueta}>Placa de tu vehículo</Text>
                  <TextInput
                    placeholder="Escribe aquí la placa (ej: ABC123)"
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
          <Text style={estEtiqueta}>Tu número de celular</Text>
          <TextInput placeholder="Escribe aquí tu celular (ej: 3001234567)" value={form.telefono} onChangeText={(t) => setForm({ ...form, telefono: t })} style={styles.input} keyboardType="phone-pad" onFocus={verCampos} />
          <Text style={estEtiqueta}>{modo === "login" ? "Tu contraseña" : "Crea una contraseña"}</Text>
          <View style={{ justifyContent: "center" }}>
            <TextInput placeholder={modo === "login" ? "Escribe aquí tu contraseña" : "Mínimo 6 caracteres, que no olvides"} value={form.password} onChangeText={(t) => setForm({ ...form, password: t })} style={[styles.input, { paddingRight: 50 }]} secureTextEntry={!verPass} onFocus={verCampos} />
            <TouchableOpacity style={{ position: "absolute", right: 6, padding: 10, top: 2 }} onPress={() => setVerPass(v => !v)}>
              <Text style={{ fontSize: 18 }}>{verPass ? "🙈" : "👁️"}</Text>
            </TouchableOpacity>
          </View>
          {error ? <Text style={styles.error}>{error}</Text> : null}
          <TouchableOpacity style={styles.button} onPress={handleSubmit} disabled={cargando}>
            {cargando ? <ActivityIndicator color="#fff" /> : <Text style={styles.buttonText}>{modo === "login" ? "Ingresar" : "Crear cuenta"}</Text>}
          </TouchableOpacity>
          {modo === "login" && (
            // recuperacion manual por WhatsApp mientras el login por codigo (Fase 2) sigue apagado
            <TouchableOpacity style={{ marginTop: 14, alignItems: "center", padding: 6 }}
              onPress={() => Linking.openURL(`https://wa.me/573133714915?text=${encodeURIComponent(`Hola, olvidé mi contraseña de Tukán. Mi teléfono es ${form.telefono || ""}`)}`)}>
              <Text style={{ fontSize: 13, color: "#666" }}>¿Olvidaste tu contraseña?{" "}
                <Text style={{ color: "#187830", fontWeight: "700" }}>Escríbenos por WhatsApp</Text>
              </Text>
            </TouchableOpacity>
          )}
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
      </KeyboardAvoidingView>
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

      {/* Cerrar sesion de verdad: borra la sesion guardada y resetea a Login. Si
          solo hiciera replace("Login"), la restauracion de sesion rebota a Admin. */}
      <TouchableOpacity style={{ padding: 16, alignItems: "center" }} onPress={async () => { await borrarSesion(); navigation.reset({ index: 0, routes: [{ name: "Login" }] }); }}>
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

// ===== ACARREOS: catalogos y fotos =====
const TIPOS_CARGA = [["trasteo", "🏠 Trasteo / mudanza"], ["mercancia", "🏪 Mercancía de negocio"],
  ["materiales", "🧱 Materiales de construcción"], ["objeto", "📦 Objeto grande / electrodoméstico"], ["otro", "➕ Otro"]];
const TAMANOS_CARGA = [["pequena", "Pequeña", "cajas, un mueble"], ["mediana", "Mediana", "nevera, lavadora, varios muebles"],
  ["grande", "Grande", "trasteo de 1–2 cuartos"], ["muy_grande", "Muy grande", "casa completa o mucha mercancía"]];
const etiquetaDe = (lista, k) => (lista.find((x) => x[0] === k) || [])[1];
// ejemplos de cada tamaño SEGUN lo que se mueve (no es lo mismo un trasteo que materiales)
const EJEMPLOS_TAMANO = {
  trasteo: { pequena: "cajas y un mueble", mediana: "nevera, lavadora, varios muebles", grande: "trasteo de 1–2 cuartos", muy_grande: "casa o apartamento completo" },
  mercancia: { pequena: "unas cajas o paquetes", mediana: "varias cajas o un electrodoméstico", grande: "muchas cajas o estibas pequeñas", muy_grande: "surtido completo o carga de bodega" },
  materiales: { pequena: "hasta 5 bultos de cemento, tubos o varillas", mediana: "10 a 20 bultos, tejas o baldosa", grande: "1 a 2 metros de arena, ladrillo por cientos", muy_grande: "varios metros de material, ladrillo por miles" },
  objeto: { pequena: "televisor, silla o bicicleta", mediana: "nevera, lavadora o sofá", grande: "varios electrodomésticos o una cama doble", muy_grande: "maquinaria o algo muy pesado" },
  otro: { pequena: "cabe en un motocarguero", mediana: "cabe en una camioneta", grande: "necesita un camión pequeño", muy_grande: "necesita un camión grande" },
};
const ejemploTamano = (tipo, tam) => (EJEMPLOS_TAMANO[tipo] || EJEMPLOS_TAMANO.otro)[tam] || "";

/** Foto desde la camara (si el celular lo permite) o la galeria. Devuelve la uri o null.
 *  Si la camara no esta disponible en esta version de la app, cae a la galeria. */
async function tomarOElegirFoto() {
  const galeria = async () => {
    const p = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!p.granted) { avisar("Permiso requerido", "Necesitamos acceso a tus fotos."); return null; }
    const r = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ImagePicker.MediaTypeOptions.Images, quality: 0.5 });
    return r.canceled ? null : r.assets[0].uri;
  };
  const camara = async () => {
    try {
      const p = await ImagePicker.requestCameraPermissionsAsync();
      if (!p.granted) return galeria();
      const r = await ImagePicker.launchCameraAsync({ quality: 0.5 });
      return r.canceled ? null : r.assets[0].uri;
    } catch (e) { return galeria(); }
  };
  if (Platform.OS === "web") return galeria();
  return new Promise((res) => {
    Alert.alert("Agregar foto", "¿De dónde la tomas?", [
      { text: "📷 Cámara", onPress: () => camara().then(res).catch(() => res(null)) },
      { text: "🖼️ Galería", onPress: () => galeria().then(res).catch(() => res(null)) },
      { text: "Cancelar", style: "cancel", onPress: () => res(null) },
    ], { cancelable: true, onDismiss: () => res(null) });
  });
}

/** Detalles del acarreo para quien transporta (y para el recibo): tipo, tamaño,
 *  ayudantes, pisos, quien recibe y fotos (tocar para ampliar). */
// foto del pasajero (o su inicial si no ha subido foto)
function AvatarPasajero({ c, tam = 30 }) {
  const r = tam / 2;
  if (c && c.cliente_foto) {
    return <Image source={{ uri: c.cliente_foto }} style={{ width: tam, height: tam, borderRadius: r, backgroundColor: "#EEE" }} />;
  }
  return (
    <View style={{ width: tam, height: tam, borderRadius: r, backgroundColor: "#E7F3E9", alignItems: "center", justifyContent: "center" }}>
      <Text style={{ fontSize: tam * 0.45, fontWeight: "700", color: "#187830" }}>{((c && c.cliente_nombre) || "?").trim().charAt(0).toUpperCase()}</Text>
    </View>
  );
}

// estilos de la lista y el detalle de solicitudes (estilo limpio: fondo gris
// claro, tarjeta blanca sin borde, precio grande, un solo acento verde)
const sl = StyleSheet.create({
  card: { backgroundColor: "#fff", borderRadius: 20, paddingHorizontal: 16, paddingTop: 12, paddingBottom: 12, marginBottom: 10,
    shadowColor: "#0C2C1B", shadowOffset: { width: 0, height: 3 }, shadowOpacity: 0.06, shadowRadius: 10, elevation: 2 },
  cardNueva: { borderWidth: 2, borderColor: "#F06000" },
  filaChips: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  chip: { borderRadius: 999, paddingHorizontal: 10, paddingVertical: 3 },
  chipVerde: { backgroundColor: "#E3F4E6" },
  chipNaranja: { backgroundColor: "#FFEBDB" },
  chipTxt: { fontSize: 12.5, fontWeight: "700" },
  precio: { fontSize: 32, fontWeight: "800", color: "#111", letterSpacing: -0.5 },
  moneda: { fontSize: 18, fontWeight: "800", color: "#111" },
  vehBadge: { width: 42, height: 42, borderRadius: 21, backgroundColor: "#F2F4F1", alignItems: "center", justifyContent: "center" },
  filaRuta: { flexDirection: "row", alignItems: "flex-start", marginTop: 8 },
  puntoHueco: { width: 10, height: 10, borderRadius: 5, borderWidth: 2, borderColor: "#187830", marginTop: 6, marginRight: 12 },
  puntoLleno: { width: 10, height: 10, borderRadius: 5, backgroundColor: "#F06000", marginTop: 6, marginRight: 12 },
  dir: { flex: 1, fontSize: 15.5, color: "#1D1D1D", lineHeight: 21 },
  km: { fontSize: 15.5, fontWeight: "700", color: "#1D1D1D", marginLeft: 10 },
  pie: { flexDirection: "row", alignItems: "center", marginTop: 12, gap: 8 },
  pieNombre: { fontSize: 15, color: "#1D1D1D", maxWidth: 140 },
  pieEstrella: { fontSize: 14.5, color: "#1D1D1D", fontWeight: "600" },
  pieGris: { fontSize: 13.5, color: "#8A8A8A" },
  // detalle (hoja que sube desde abajo)
  fondo: { flex: 1, backgroundColor: "rgba(0,0,0,0.45)", justifyContent: "flex-end" },
  hoja: { backgroundColor: "#fff", borderTopLeftRadius: 26, borderTopRightRadius: 26, maxHeight: "94%", overflow: "hidden" },
  mapa: { height: 250, backgroundColor: "#EEF1EC" },
  mapaChip: { position: "absolute", left: 12, top: 12, backgroundColor: "#187830", borderRadius: 12, paddingHorizontal: 12, paddingVertical: 7 },
  titulo: { fontSize: 22, fontWeight: "800", color: "#111", letterSpacing: -0.3 },
  letra: { width: 22, height: 22, borderRadius: 11, alignItems: "center", justifyContent: "center", marginRight: 10, marginTop: 1 },
  letraTxt: { color: "#fff", fontSize: 12, fontWeight: "800" },
  btnAceptar: { backgroundColor: "#187830", borderRadius: 16, paddingVertical: 17, alignItems: "center" },
  btnAceptarTxt: { color: "#fff", fontSize: 18, fontWeight: "800" },
  btnGris: { backgroundColor: "#F1F2EF", borderRadius: 16, paddingVertical: 15, alignItems: "center" },
  btnGrisTxt: { color: "#1D1D1D", fontSize: 16, fontWeight: "600" },
  oferta: { backgroundColor: "#F1F2EF", borderRadius: 14, paddingVertical: 14, paddingHorizontal: 18, marginRight: 8, alignItems: "center", minWidth: 104 },
  ofertaTxt: { fontSize: 16, fontWeight: "700", color: "#1D1D1D" },
});

function DetalleAcarreo({ c, compacto }) {
  const [ampliada, setAmpliada] = useState(null);
  if (!esCarga(c.vehiculo_pedido)) return null;
  const sinEmoji = (t) => (t || "").replace(/^\S+\s/, "");          // "🏠 Trasteo" -> "Trasteo"
  const tam = TAMANOS_CARGA.find((x) => x[0] === c.tamano_carga);
  const piso = (n, asc) => n == null ? null
    : `${n <= 1 ? "Primer piso" : `Piso ${n}`}${n > 1 && asc === "si" ? " · con ascensor" : n > 1 && asc === "no" ? " · sin ascensor" : ""}`;
  const fotos = c.fotos_carga || [];
  const visor = (
    <Modal visible={!!ampliada} transparent animationType="fade" onRequestClose={() => setAmpliada(null)}>
      <TouchableOpacity activeOpacity={1} onPress={() => setAmpliada(null)} style={{ flex: 1, backgroundColor: "rgba(0,0,0,0.92)", justifyContent: "center", padding: 12 }}>
        {ampliada && <Image source={{ uri: ampliada }} style={{ width: "100%", height: "80%" }} resizeMode="contain" />}
        <Text style={{ color: "#fff", textAlign: "center", marginTop: 10 }}>Toca para cerrar</Text>
      </TouchableOpacity>
    </Modal>
  );

  // version compacta (avisos del conductor): pastillas en una o dos lineas
  if (compacto) {
    const pills = [
      c.tipo_carga && sinEmoji(etiquetaDe(TIPOS_CARGA, c.tipo_carga)),
      tam && tam[1],
      c.ayudantes > 0 && `${c.ayudantes} ayudante${c.ayudantes > 1 ? "s" : ""}`,
      (c.piso_origen > 1 || c.piso_destino > 1) && `Piso ${c.piso_origen || 1} → ${c.piso_destino || 1}`,
    ].filter(Boolean);
    if (!pills.length && !fotos.length) return null;
    return (
      <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 6, marginTop: 8 }}>
        {pills.map((t) => (
          <View key={t} style={{ backgroundColor: "#FFF1E3", borderRadius: 20, paddingVertical: 4, paddingHorizontal: 10 }}>
            <Text style={{ fontSize: 12, color: "#B85C00", fontWeight: "700" }}>{t}</Text>
          </View>
        ))}
        {fotos.map((u) => (
          <TouchableOpacity key={u} onPress={() => setAmpliada(u)}>
            <Image source={{ uri: u }} style={{ width: 34, height: 34, borderRadius: 8 }} />
          </TouchableOpacity>
        ))}
        {visor}
      </View>
    );
  }

  // ficha completa: icono en circulo + etiqueta + valor
  const filas = [
    c.tipo_carga && ["📦", "Qué se mueve", sinEmoji(etiquetaDe(TIPOS_CARGA, c.tipo_carga))],
    tam && ["📐", "Tamaño", `${tam[1]} · ${ejemploTamano(c.tipo_carga, tam[0])}`],
    c.ayudantes != null && ["🙋", "Ayuda para cargar", c.ayudantes > 0 ? `${c.ayudantes} ayudante${c.ayudantes > 1 ? "s" : ""}` : "No necesita"],
    c.piso_origen != null && ["📤", "Recoger en", piso(c.piso_origen, c.ascensor_origen)],
    c.piso_destino != null && ["📥", "Entregar en", piso(c.piso_destino, c.ascensor_destino)],
    c.recibe_nombre && ["👤", "Recibe", `${c.recibe_nombre}${c.recibe_telefono ? ` · ${c.recibe_telefono}` : ""}`],
  ].filter(Boolean);
  if (!filas.length && !fotos.length) return null;
  return (
    <View style={{ backgroundColor: "#fff", borderRadius: 14, borderWidth: 1, borderColor: "#EFE7DA", paddingHorizontal: 14, paddingVertical: 10, marginTop: 14 }}>
      <Text style={{ fontSize: 11, color: "#9A948A", fontWeight: "800", letterSpacing: 1, marginBottom: 2 }}>DETALLES DEL ACARREO</Text>
      {filas.map(([ic, k, v], i) => (
        <View key={k} style={{ flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 9, borderTopWidth: i ? 1 : 0, borderTopColor: "#F3EEE5" }}>
          <View style={{ width: 34, height: 34, borderRadius: 17, backgroundColor: "#FFF1E3", alignItems: "center", justifyContent: "center" }}>
            <Text style={{ fontSize: 16 }}>{ic}</Text>
          </View>
          <View style={{ flex: 1 }}>
            <Text style={{ fontSize: 11.5, color: "#9A948A" }}>{k}</Text>
            <Text style={{ fontSize: 15, color: "#1C2B22", fontWeight: "700", marginTop: 1 }}>{v}</Text>
          </View>
        </View>
      ))}
      {fotos.length > 0 && (
        <View style={{ borderTopWidth: filas.length ? 1 : 0, borderTopColor: "#F3EEE5", paddingTop: 10, marginTop: 2 }}>
          <Text style={{ fontSize: 11.5, color: "#9A948A", marginBottom: 8 }}>Fotos de la carga · toca para ampliar</Text>
          <View style={{ flexDirection: "row", gap: 8 }}>
            {fotos.map((u) => (
              <TouchableOpacity key={u} onPress={() => setAmpliada(u)}>
                <Image source={{ uri: u }} style={{ width: 84, height: 84, borderRadius: 12, borderWidth: 1, borderColor: "#EFE7DA" }} />
              </TouchableOpacity>
            ))}
          </View>
        </View>
      )}
      {visor}
    </View>
  );
}

/** Prueba de entrega del acarreo: quien recibio, cuando y la foto (si hay). */
function PruebaEntrega({ c }) {
  const [ver, setVer] = useState(false);
  if (!c || !c.entrega_recibio) return null;
  return (
    <View style={{ backgroundColor: "#EAF6EC", borderRadius: 10, padding: 10, marginTop: 8, flexDirection: "row", gap: 10, alignItems: "center" }}>
      {c.entrega_foto ? (
        <TouchableOpacity onPress={() => setVer(true)}>
          <Image source={{ uri: c.entrega_foto }} style={{ width: 56, height: 56, borderRadius: 8 }} />
        </TouchableOpacity>
      ) : <Text style={{ fontSize: 30 }}>📦</Text>}
      <View style={{ flex: 1 }}>
        <Text style={{ fontSize: 13.5, color: "#187830", fontWeight: "800" }}>✅ Entregado</Text>
        <Text style={{ fontSize: 12.5, color: "#555", marginTop: 2 }}>Recibió: {c.entrega_recibio}{c.entregada_en ? ` · ${haceCuanto(c.entregada_en)}` : ""}</Text>
        {c.entrega_foto ? <Text style={{ fontSize: 11.5, color: "#1A56B8", fontWeight: "700", marginTop: 2 }}>Toca la foto para verla</Text> : null}
      </View>
      <Modal visible={ver} transparent animationType="fade" onRequestClose={() => setVer(false)}>
        <TouchableOpacity activeOpacity={1} onPress={() => setVer(false)} style={{ flex: 1, backgroundColor: "rgba(0,0,0,0.9)", justifyContent: "center", padding: 12 }}>
          <Image source={{ uri: c.entrega_foto }} style={{ width: "100%", height: "80%" }} resizeMode="contain" />
          <Text style={{ color: "#fff", textAlign: "center", marginTop: 10 }}>Toca para cerrar</Text>
        </TouchableOpacity>
      </Modal>
    </View>
  );
}

/** Icono de servicio: el emoji a color dentro del marco de Tukan (aro verde por
 *  fuera, aro naranja por dentro, fondo crema). */
function IconoServicio({ emoji, size = 82 }) {
  const aro = Math.round(size * 0.075);
  return (
    <View style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: "#187830", alignItems: "center", justifyContent: "center", elevation: 4, shadowColor: "#0C2C1B", shadowOpacity: 0.2, shadowRadius: 6, shadowOffset: { width: 0, height: 3 } }}>
      <View style={{ width: size - aro * 2, height: size - aro * 2, borderRadius: size / 2, backgroundColor: "#F06000", alignItems: "center", justifyContent: "center" }}>
        <View style={{ width: size - aro * 3.6, height: size - aro * 3.6, borderRadius: size / 2, backgroundColor: "#FFF8EE", alignItems: "center", justifyContent: "center" }}>
          <Text style={{ fontSize: Math.round(size * 0.46) }}>{emoji}</Text>
        </View>
      </View>
    </View>
  );
}

const MOSTRAR_COMIDA = false;   // domicilios de comida: apagado hasta que el modulo este listo

function ElegirServicioScreen({ navigation, route }) {
  const { usuario } = route.params;
  const insets = useSafeAreaInsets();
  // promo de lanzamiento de su ciudad (si hay), para mostrarla en el inicio
  const [promo, setPromo] = useState(null);
  useEffect(() => {
    fetch(`${API}/municipios`).then(r => r.json()).then(d => {
      if (!Array.isArray(d)) return;
      const m = d.find(x => x.nombre === usuario.municipio) || null;
      if (m && m.promo && m.promo.activa) setPromo(m.promo);
    }).catch(() => {});
  }, []);
  const nombre = (usuario.nombre || "").trim().split(" ")[0];
  const ir = (modo) => navigation.navigate("PedirCarrera", { usuario, modo });
  const tiles = [
    ["🚕", "Carrera", "Moto o carro", "#E7F3E9", "#14672A", () => ir("carrera")],
    ["🚚", "Acarreo", "Trasteos y carga", "#FFF1E3", "#B54A00", () => ir("acarreo")],
    // COMIDA oculta: el modulo de domicilios (pensado para Putumayo) aun no esta listo.
    // Para volver a mostrarla, poner MOSTRAR_COMIDA = true.
    ...(MOSTRAR_COMIDA ? [["🍔", "Comida", "A domicilio", "#FFF6DA", "#8A5A00", () => navigation.navigate("Inicio", { usuario })]] : []),
  ];
  return (
    <SafeAreaView style={[styles.container, { backgroundColor: "#F4F5F1" }]}>
      <View style={{ backgroundColor: "#187830", paddingTop: insets.top + 18, paddingBottom: 20, paddingHorizontal: 18, borderBottomLeftRadius: 28, borderBottomRightRadius: 28 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
          <Image source={require("./assets/icon.png")} style={{ width: 42, height: 42, borderRadius: 13 }} />
          <View style={{ flex: 1 }}>
            <Text style={{ color: "rgba(255,255,255,0.85)", fontSize: 14 }}>Hola{nombre ? `, ${nombre}` : ""} 👋</Text>
            <Text style={{ color: "#fff", fontSize: 24, fontWeight: "800", letterSpacing: -0.4 }}>¿Qué necesitas hoy?</Text>
          </View>
        </View>
        {/* barra tipo buscador: el atajo principal es pedir carrera */}
        <TouchableOpacity activeOpacity={0.9} onPress={() => ir("carrera")}
          style={{ marginTop: 18, backgroundColor: "#fff", borderRadius: 18, paddingVertical: 17, paddingHorizontal: 18, flexDirection: "row", alignItems: "center", gap: 12,
            shadowColor: "#0C2C1B", shadowOffset: { width: 0, height: 6 }, shadowOpacity: 0.12, shadowRadius: 14, elevation: 5 }}>
          <View style={{ width: 12, height: 12, borderRadius: 6, backgroundColor: "#F06000" }} />
          <Text style={{ flex: 1, fontSize: 17, fontWeight: "700", color: "#1D1D1D" }}>¿A dónde vas?</Text>
          <View style={{ backgroundColor: "#F1F2EF", borderRadius: 999, paddingHorizontal: 12, paddingVertical: 6 }}>
            <Text style={{ fontSize: 13, fontWeight: "700", color: "#187830" }}>Ahora ›</Text>
          </View>
        </TouchableOpacity>

      </View>

      <ScrollView contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 24 }}>
        {promo ? (
          <TouchableOpacity activeOpacity={0.9} onPress={() => ir("carrera")}
            style={{ marginTop: 16, backgroundColor: "#F06000", borderRadius: 18, padding: 16, flexDirection: "row", alignItems: "center", gap: 12 }}>
            <Text style={{ fontSize: 30, fontWeight: "900", color: "#fff" }}>{promo.pct}%</Text>
            <View style={{ flex: 1 }}>
              <Text style={{ color: "#fff", fontWeight: "800", fontSize: 15 }}>Descuento en carreras</Text>
              <Text style={{ color: "rgba(255,255,255,0.9)", fontSize: 12.5, marginTop: 1 }}>{promo.texto || "Precio de lanzamiento por tiempo limitado"}</Text>
            </View>
            <Text style={{ color: "#fff", fontSize: 20 }}>›</Text>
          </TouchableOpacity>
        ) : null}

        <Text style={{ fontSize: 17, fontWeight: "800", color: "#1D1D1D", marginTop: 22, marginBottom: 12, letterSpacing: -0.2 }}>Servicios</Text>
        <View style={{ flexDirection: "row", gap: 10 }}>
          {tiles.map(([ic, tit, sub, fondo, color, fn]) => (
            <TouchableOpacity key={tit} activeOpacity={0.85} onPress={fn}
              style={{ flex: 1, backgroundColor: "#fff", borderRadius: 18, paddingVertical: 16, paddingHorizontal: 10, alignItems: "center",
                borderWidth: 1, borderColor: "#E1E5DD",   // en pantallas de gama baja la sombra no se ve: el borde marca la tarjeta
                shadowColor: "#0C2C1B", shadowOffset: { width: 0, height: 3 }, shadowOpacity: 0.08, shadowRadius: 10, elevation: 3 }}>
              <View style={{ width: 58, height: 58, borderRadius: 18, backgroundColor: fondo, alignItems: "center", justifyContent: "center" }}>
                <Text style={{ fontSize: 30 }}>{ic}</Text>
              </View>
              <Text style={{ fontSize: 15, fontWeight: "800", color, marginTop: 10 }}>{tit}</Text>
              <Text style={{ fontSize: 11.5, color: "#8A8A8A", marginTop: 2, textAlign: "center" }}>{sub}</Text>
            </TouchableOpacity>
          ))}
        </View>

        {/* por que Tukan: corto, da confianza */}
        <View style={{ backgroundColor: "#fff", borderRadius: 18, padding: 16, marginTop: 16, gap: 12 }}>
          {[["💵", "Tú pones el precio", "Ves una tarifa sugerida y ofreces lo que quieres pagar."],
            ["🛡️", "Conductores verificados", "Ves foto, placa y calificación antes de subirte."],
            ["📍", "Viaje en vivo", "Comparte tu recorrido con tu familia."]].map(([ic, t, d]) => (
            <View key={t} style={{ flexDirection: "row", gap: 12, alignItems: "center" }}>
              <View style={{ width: 38, height: 38, borderRadius: 12, backgroundColor: "#F1F2EF", alignItems: "center", justifyContent: "center" }}>
                <Text style={{ fontSize: 18 }}>{ic}</Text>
              </View>
              <View style={{ flex: 1 }}>
                <Text style={{ fontSize: 14.5, fontWeight: "700", color: "#1D1D1D" }}>{t}</Text>
                <Text style={{ fontSize: 12.5, color: "#7A7A7A", marginTop: 1 }}>{d}</Text>
              </View>
            </View>
          ))}
        </View>
      </ScrollView>
      <TouchableOpacity style={{ padding: 14, paddingBottom: 14 + insets.bottom, alignItems: "center" }} onPress={() => navigation.replace("Login")}>
        <Text style={{ color: "#999", fontSize: 13 }}>Salir</Text>
      </TouchableOpacity>
    </SafeAreaView>
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
    {url:'${MAPBOX_STREETS}', opt:{maxZoom:20, tileSize:512, zoomOffset:-1}},
    {url:'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', opt:{maxZoom:19, subdomains:'abc'}},
    {url:'https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}.png', opt:{maxZoom:20, subdomains:'abcd'}}
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
      capaSat = L.tileLayer('${MAPBOX_SAT}', {maxZoom:20, tileSize:512, zoomOffset:-1}).addTo(map);
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

function MapaSelector({ visible, titulo, centro, municipio, onConfirmar, onCerrar }) {
  const webRef = useRef(null);
  const inicial = centro && centro.lat ? centro : { lat: 0.5083, lon: -76.4972 };
  const [coords, setCoords] = useState(inicial);
  const [buscando, setBuscando] = useState(false);
  const [busqueda, setBusqueda] = useState("");
  const [buscandoLugar, setBuscandoLugar] = useState(false);
  const [encontrado, setEncontrado] = useState(null);   // nombre del sitio hallado, para confirmar "es aqui"
  const [sugerencias, setSugerencias] = useState([]);    // autocompletar Mapbox (tipo Uber)
  const [sinRes, setSinRes] = useState(false);           // busco pero no encontro en la zona
  const [cargandoSug, setCargandoSug] = useState(false);
  // cada vez que se abre, la busqueda se sesga hacia donde abre el mapa (la ciudad
  // del usuario), no hacia el primer centro que tuvo (podia quedar en Orito)
  const insets = useSafeAreaInsets();
  // cada vez que se abre: el mapa arranca limpio (sin el texto del punto anterior)
  useEffect(() => {
    if (!visible) return;
    setCoords(inicial);
    setBusqueda(""); setSugerencias([]); setSinRes(false); setEncontrado(null);
  }, [visible, titulo]);
  const saltarAuto = useRef(false);                     // al elegir una sugerencia no se vuelve a buscar

  // AUTOCOMPLETAR (tipo Uber): mientras escribes, el backend sugiere direcciones con
  // Mapbox (mucho mejor que Nominatim para nomenclatura de ciudades). Se sesga hacia
  // donde miras el mapa. Si no hay red, queda vacio y el usuario usa "Buscar"
  // (Nominatim) o marca en el mapa — nunca se queda sin poder ubicar.
  useEffect(() => {
    const t = busqueda.trim();
    if (saltarAuto.current) { saltarAuto.current = false; return; }
    if (t.length < 3) { setSugerencias([]); setSinRes(false); setCargandoSug(false); return; }
    setCargandoSug(true);
    const timer = setTimeout(() => {
      const cerca = coords && coords.lat != null ? `&cerca_lat=${coords.lat}&cerca_lon=${coords.lon}` : "";
      const muni = municipio ? `&municipio=${encodeURIComponent(municipio)}` : "";
      fetch(`${API}/ubicacion/autocompletar?texto=${encodeURIComponent(t)}${cerca}${muni}`)
        .then(r => r.json())
        .then(d => { if (Array.isArray(d)) { setSugerencias(d); setSinRes(d.length === 0); } })
        .catch(() => {})
        .finally(() => setCargandoSug(false));
    }, 350);   // espera a que deje de escribir, para no llamar en cada tecla
    return () => clearTimeout(timer);
  }, [busqueda]);

  const elegirSugerencia = (s) => {
    setCoords({ lat: s.lat, lon: s.lon });
    saltarAuto.current = true;   // poner el texto elegido NO debe abrir otra vez la lista
    setBusqueda(s.titulo || s.nombre.split(",")[0].trim());
    setSugerencias([]);
    setSinRes(false);
    Keyboard.dismiss();
    setEncontrado(s.titulo ? [s.titulo, (s.detalle || "").split(",")[0]].filter(Boolean).join(", ") : s.nombre.split(",").slice(0, 3).join(",").trim());
    webRef.current && webRef.current.injectJavaScript(`irA(${s.lat}, ${s.lon}); true;`);
  };

  // buscador: escribe un sitio, se geocodifica y el pin salta ahi en el mapa.
  // No graba nada; solo mueve el pin para que confirmes/ajustes a mano.
  const buscarLugar = () => {
    const t = busqueda.trim();
    if (!t) return;
    setBuscandoLugar(true);
    setEncontrado(null);
    // se sesga hacia donde esta mirando el mapa (coords) para que 'Calle 49' caiga
    // en la ciudad correcta: busca AMPLIO en toda Colombia, no solo en el municipio
    const cerca = coords && coords.lat != null ? `&cerca_lat=${coords.lat}&cerca_lon=${coords.lon}` : "";
    fetch(`${API}/ubicacion/buscar?texto=${encodeURIComponent(t)}&municipio=${encodeURIComponent(municipio || "Orito")}${cerca}`)
      .then(r => r.json())
      .then(d => {
        if (d && d.lat != null) {
          setCoords({ lat: d.lat, lon: d.lon });
          // el nombre de Nominatim viene largo ("Calle 5, Barrio, Cali, Valle..."):
          // dejamos las primeras 3 partes, que es lo que ubica al usuario
          const corto = (d.nombre || "").split(",").slice(0, 3).join(",").trim();
          setEncontrado(corto || t);
          webRef.current && webRef.current.injectJavaScript(`irA(${d.lat}, ${d.lon}); true;`);
        } else {
          setEncontrado(null);
          avisar("No lo ubicamos", "No encontramos ese sitio. Intenta con el nombre completo (ej. 'Calle 49 #10, Cali') o marca el punto a mano en el mapa.");
        }
      })
      .catch(() => {})
      .finally(() => setBuscandoLugar(false));
  };

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
        <View style={{ paddingHorizontal: 14, paddingTop: 10, paddingBottom: 8 }}>
          <View style={{ flexDirection: "row", alignItems: "center", height: 50, backgroundColor: "#F4F5F1", borderRadius: 14, borderWidth: 1, borderColor: "#E2E5DE", overflow: "hidden" }}>
            <View style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: "#187830", marginLeft: 14 }} />
            <TextInput
              value={busqueda}
              onChangeText={setBusqueda}
              placeholder="Sitio o dirección"
              placeholderTextColor="#9A9A9A"
              numberOfLines={1}
              multiline={false}
              style={{ flex: 1, height: 50, paddingHorizontal: 10, paddingVertical: 0, fontSize: 15, color: "#1D1D1D" }}
              onSubmitEditing={buscarLugar}
              returnKeyType="search"
              autoCorrect={false}
            />
            {cargandoSug ? <ActivityIndicator size="small" color="#187830" style={{ marginRight: 10 }} /> : null}
            {busqueda && !cargandoSug ? (
              <TouchableOpacity onPress={() => { setBusqueda(""); setSugerencias([]); setSinRes(false); setEncontrado(null); }} style={{ paddingHorizontal: 10, height: 50, justifyContent: "center" }}>
                <Text style={{ fontSize: 15, color: "#9A9A9A", fontWeight: "700" }}>✕</Text>
              </TouchableOpacity>
            ) : null}
            <TouchableOpacity onPress={buscarLugar} disabled={buscandoLugar} activeOpacity={0.85}
              style={{ backgroundColor: "#187830", height: 50, paddingHorizontal: 16, justifyContent: "center" }}>
              {buscandoLugar ? <ActivityIndicator color="#fff" size="small" /> : <Text style={{ color: "#fff", fontWeight: "800", fontSize: 14 }}>Buscar</Text>}
            </TouchableOpacity>
          </View>
          {encontrado ? (
            <View style={{ marginTop: 8, backgroundColor: "#EAF6EC", borderRadius: 12, paddingVertical: 9, paddingHorizontal: 12 }}>
              <Text style={{ fontSize: 13, color: "#187830", fontWeight: "700" }} numberOfLines={1}>{encontrado}</Text>
              <Text style={{ fontSize: 12, color: "#3F7A4D", marginTop: 1 }}>¿Es aquí? Ajusta el pin si hace falta y confirma abajo.</Text>
            </View>
          ) : null}
        </View>
        <View style={{ flex: 1 }}>
          <WebView
            ref={webRef}
            originWhitelist={["*"]}
            // baseUrl le da un origen https valido: sin esto Android usa "about:blank"
            // y varios servidores de mapas rechazan las peticiones de imagenes
            source={{ html: mapaHTML(inicial.lat, inicial.lon), baseUrl: "https://orito.app/" }}
            onMessage={(e) => { try { setCoords(JSON.parse(e.nativeEvent.data)); setEncontrado(null); setSugerencias([]); setSinRes(false); } catch (_) {} }}
            javaScriptEnabled
            domStorageEnabled
            mixedContentMode="always"
            setSupportMultipleWindows={false}
            androidLayerType="hardware"
            style={{ flex: 1 }}
          />
          {/* la lista flota SOBRE el mapa (no lo empuja hacia abajo) */}
          {sugerencias.length > 0 ? (
            <View style={{ position: "absolute", top: 0, left: 14, right: 14, backgroundColor: "#fff", borderRadius: 14, overflow: "hidden", elevation: 8, shadowColor: "#000", shadowOpacity: 0.15, shadowRadius: 12, shadowOffset: { width: 0, height: 4 } }}>
              <ScrollView keyboardShouldPersistTaps="handled" style={{ maxHeight: 330 }}>
                {sugerencias.map((s, i) => {
                  const tit = s.titulo || s.nombre.split(",")[0];
                  const det = s.titulo ? (s.detalle || "") : s.nombre.split(",").slice(1).join(",").trim();
                  return (
                    <TouchableOpacity key={i} onPress={() => elegirSugerencia(s)} activeOpacity={0.7}
                      style={{ paddingVertical: 11, paddingHorizontal: 14, borderBottomWidth: i < sugerencias.length - 1 ? 1 : 0, borderBottomColor: "#F0F1EE", flexDirection: "row", gap: 12, alignItems: "center" }}>
                      <View style={{ width: 32, height: 32, borderRadius: 16, backgroundColor: "#EEF1EC", alignItems: "center", justifyContent: "center" }}>
                        <View style={{ width: 9, height: 9, borderRadius: 5, backgroundColor: "#187830" }} />
                      </View>
                      <View style={{ flex: 1 }}>
                        <Text style={{ fontSize: 14.5, fontWeight: "700", color: "#1D1D1D" }} numberOfLines={1}>{tit}</Text>
                        {det ? <Text style={{ fontSize: 12.5, color: "#8A8A8A", marginTop: 1 }} numberOfLines={1}>{det}</Text> : null}
                      </View>
                    </TouchableOpacity>
                  );
                })}
              </ScrollView>
            </View>
          ) : null}
          {sinRes && sugerencias.length === 0 && !cargandoSug ? (
            <View style={{ position: "absolute", top: 0, left: 14, right: 14, backgroundColor: "#FFF4E0", borderRadius: 12, padding: 12, elevation: 6 }}>
              <Text style={{ fontSize: 13, color: "#8A5A00", fontWeight: "600" }}>
                No encontramos "{busqueda.trim()}" por aquí. Prueba con el nombre de un sitio cercano o una calle, o toca el mapa para marcar el punto.
              </Text>
            </View>
          ) : null}
          {/* "mi ubicacion" flota sobre el mapa (abajo a la izquierda), como en Uber */}
          {sugerencias.length === 0 ? (
            <TouchableOpacity onPress={usarMiUbicacion} disabled={buscando} activeOpacity={0.85}
              style={{ position: "absolute", left: 14, bottom: 14, flexDirection: "row", alignItems: "center", gap: 8, backgroundColor: "#fff", borderRadius: 22, paddingVertical: 10, paddingHorizontal: 14, elevation: 6, shadowColor: "#000", shadowOpacity: 0.18, shadowRadius: 8, shadowOffset: { width: 0, height: 3 } }}>
              {buscando ? <ActivityIndicator size="small" color="#187830" /> : (
                <View style={{ width: 16, height: 16, borderRadius: 8, borderWidth: 2, borderColor: "#187830", alignItems: "center", justifyContent: "center" }}>
                  <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: "#187830" }} />
                </View>
              )}
              <Text style={{ color: "#187830", fontWeight: "800", fontSize: 13.5 }}>Mi ubicación</Text>
            </TouchableOpacity>
          ) : null}
        </View>
        <View style={{ paddingHorizontal: 16, paddingTop: 10, paddingBottom: Math.max(insets.bottom, 10) + 8, backgroundColor: "#fff" }}>
          <Text style={{ textAlign: "center", fontSize: 12, color: "#8A8A8A", marginBottom: 8 }}>
            Toca el mapa o arrastra el pin al punto exacto
          </Text>
          <TouchableOpacity style={[styles.button, { backgroundColor: "#187830", shadowColor: "#187830" }]} onPress={() => onConfirmar(coords)}>
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
<link href="https://api.mapbox.com/mapbox-gl-js/v3.9.0/mapbox-gl.css" rel="stylesheet">
<style>
  html,body,#map{height:100%;margin:0;padding:0;background:#e8e8e8}
  .veh{width:40px;height:40px;will-change:transform;filter:drop-shadow(0 2px 4px rgba(0,0,0,.4))}
  .em{font-size:30px;line-height:30px;text-align:center}
  #btns{position:absolute;top:10px;right:10px;z-index:3;display:flex;flex-direction:column;gap:8px}
  #btns button{border:none;border-radius:22px;padding:9px 13px;font-size:13px;font-weight:700;
    box-shadow:0 2px 6px rgba(0,0,0,.25);background:#fff;color:#187830}
  #btns button.on{background:#187830;color:#fff}
  #leyenda{position:absolute;left:8px;bottom:24px;z-index:3;background:rgba(255,255,255,.92);
    border-radius:10px;padding:5px 9px;font-size:12px;font-weight:600;color:#333;
    box-shadow:0 1px 4px rgba(0,0,0,.2);line-height:1.15}
</style>
</head><body><div id="map"></div>
<div id="btns">
  <button id="bSeguir" class="on" onclick="modoSeguir()">📍 Seguir</button>
  <button id="bRuta" onclick="modoRuta()">🗺️ Ruta</button>
</div>
<div id="leyenda">🚗 Tú · 📍 Recogida · 🏁 Destino</div>
<script src="https://api.mapbox.com/mapbox-gl-js/v3.9.0/mapbox-gl.js"></script>
<script>
  // ===== COMPATIBILIDAD: celulares sin WebGL2 (gama baja / Android viejo) =====
  // Mapbox GL v3 necesita WebGL2; sin eso el mapa queda EN BLANCO. Se detecta y se usa
  // Leaflet con el MISMO mapa de Mapbox (raster) imitando las funciones de GL que usa
  // este mapa, asi el resto del codigo (carro, ruta, botones) no cambia.
  function tieneWebGL2(){ try{ var c=document.createElement('canvas'); return !!(c.getContext('webgl2')); }catch(e){ return false; } }
  function toLL(p){ return Array.isArray(p)?[p[1],p[0]]:[p.lat,p.lng]; }
  function shimLeaflet(){
    function Bounds(a,b){ this.s=Infinity;this.w=Infinity;this.n=-Infinity;this.e=-Infinity; if(a)this.extend(a); if(b)this.extend(b); }
    Bounds.prototype.extend=function(p){ var ll=toLL(p); this.s=Math.min(this.s,ll[0]);this.n=Math.max(this.n,ll[0]);this.w=Math.min(this.w,ll[1]);this.e=Math.max(this.e,ll[1]); return this; };
    function estilo(paint){ var d=paint['line-dasharray']; return {color:paint['line-color']||'#187830',weight:paint['line-width']||5,opacity:paint['line-opacity']==null?0.9:paint['line-opacity'],dashArray:(d&&d[1]>0)?'2,9':null,lineCap:'round',lineJoin:'round'}; }
    function GMap(o){
      var self=this; this.L=L.map(o.container,{zoomControl:false,attributionControl:false}).setView(toLL(o.center),o.zoom||14);
      L.tileLayer('${MAPBOX_STREETS}',{tileSize:512,zoomOffset:-1,maxZoom:20}).addTo(this.L);
      this.capas={}; this.paints={};
    }
    GMap.prototype.on=function(ev,fn){ if(ev==='load'){ setTimeout(fn,0); } else if(ev==='dragstart'){ this.L.on('dragstart',fn); } };
    GMap.prototype.addSource=function(id){ this.capas[id]=L.geoJSON(null).addTo(this.L); };
    GMap.prototype.addLayer=function(l){ this.paints[l.id]=Object.assign({},l.paint||{}); this.capas[l.id].setStyle(estilo(this.paints[l.id])); };
    GMap.prototype.getSource=function(id){ var self=this,c=this.capas[id]; if(!c) return null; return {setData:function(g){ c.clearLayers(); c.addData(g); c.setStyle(estilo(self.paints[id]||{})); }}; };
    GMap.prototype.setPaintProperty=function(id,k,v){ this.paints[id]=this.paints[id]||{}; this.paints[id][k]=v; if(this.capas[id]) this.capas[id].setStyle(estilo(this.paints[id])); };
    GMap.prototype.easeTo=function(o){ this.L.setView(toLL(o.center),o.zoom||this.L.getZoom(),{animate:true}); };
    GMap.prototype.fitBounds=function(b,o){ var p=(o&&o.padding)||40; this.L.fitBounds([[b.s,b.w],[b.n,b.e]],{padding:[p,p]}); };
    GMap.prototype.setCenter=function(c){ this.L.panTo(toLL(c),{animate:false}); };
    GMap.prototype.getZoom=function(){ return this.L.getZoom(); };
    GMap.prototype.resize=function(){ this.L.invalidateSize(); };
    GMap.prototype.remove=function(){ this.L.remove(); };
    function Marker(o){ this.el=o.element; this.anchor=o.anchor||'center'; this.m=null; this.ll=[0,0]; }
    Marker.prototype.setLngLat=function(p){ this.ll=toLL(p); if(this.m) this.m.setLatLng(this.ll); return this; };
    Marker.prototype.addTo=function(map){ var w=40,h=40; var ic=L.divIcon({html:this.el,className:'',iconSize:[w,h],iconAnchor:this.anchor==='bottom'?[w/2,h]:[w/2,h/2]}); this.m=L.marker(this.ll,{icon:ic,interactive:false}).addTo(map.L); return this; };
    Marker.prototype.getLngLat=function(){ return {lng:this.ll[1],lat:this.ll[0]}; };
    Marker.prototype.setRotation=function(d){ this.el.style.transform='rotate('+d+'deg)'; return this; };
    Marker.prototype.getElement=function(){ return this.el; };
    return {Map:GMap,Marker:Marker,LngLatBounds:Bounds,accessToken:''};
  }
  var map=null, modoMapa='gl', esperaGL=null;
  function crearMapa(){
    map=new mapboxgl.Map({container:'map',style:'mapbox://styles/mapbox/streets-v12',
      center:[-76.8719,0.6668],zoom:14,attributionControl:false,
      dragRotate:true,touchZoomRotate:true,touchPitch:false,pitchWithRotate:false});
    map.on('load', alCargar);
    // si el usuario arrastra (pan) a mano, dejamos de perseguir el carro
    map.on('dragstart', function(){ if(seguir){ seguir=false; botones(); } });
  }
  function pasarALeaflet(){
    if(modoMapa==='leaflet') return; modoMapa='leaflet';
    if(esperaGL) clearTimeout(esperaGL);
    try{ if(map) map.remove(); }catch(e){}
    document.getElementById('map').innerHTML='';
    var css=document.createElement('link'); css.rel='stylesheet'; css.href='https://unpkg.com/leaflet@1.9.4/dist/leaflet.css'; document.head.appendChild(css);
    var js=document.createElement('script'); js.src='https://unpkg.com/leaflet@1.9.4/dist/leaflet.js';
    js.onload=function(){ window.mapboxgl=shimLeaflet(); carro=null; pin=null; mDest=null; crearMapa(); };
    document.head.appendChild(js);
  }
  var SVG={
    carro:'<svg viewBox="0 0 44 44" width="40" height="40" style="display:block"><defs><linearGradient id="cB" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#2FA84F"/><stop offset="0.55" stop-color="#1E8A3E"/><stop offset="1" stop-color="#115526"/></linearGradient><linearGradient id="cG" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#eafff0"/><stop offset="1" stop-color="#bfe6cf"/></linearGradient></defs><rect x="13" y="5" width="18" height="33" rx="8" fill="url(#cB)" stroke="#0e4a22" stroke-width="0.9"/><rect x="15" y="7" width="4.5" height="29" rx="2.2" fill="#ffffff" opacity="0.16"/><rect x="16" y="5.6" width="4" height="2" rx="1" fill="#fff6d8"/><rect x="24" y="5.6" width="4" height="2" rx="1" fill="#fff6d8"/><path d="M15 12 Q22 9 29 12 L27.5 17 Q22 15 16.5 17 Z" fill="url(#cG)"/><rect x="16" y="18" width="12" height="9" rx="2.5" fill="#0f5e2a"/><rect x="17" y="19" width="10" height="2.6" rx="1.3" fill="#ffffff" opacity="0.12"/><path d="M16.5 30 Q22 32 27.5 30 L26 27 Q22 28.5 18 27 Z" fill="url(#cG)"/><rect x="10.3" y="15" width="3.1" height="2.6" rx="1.3" fill="#F06000"/><rect x="30.6" y="15" width="3.1" height="2.6" rx="1.3" fill="#F06000"/></svg>',
    moto:'<svg viewBox="0 0 44 44" width="38" height="38" style="display:block"><defs><linearGradient id="mB" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#FF9A4D"/><stop offset="0.55" stop-color="#F06000"/><stop offset="1" stop-color="#B84800"/></linearGradient></defs><rect x="20" y="6" width="4" height="8" rx="2" fill="#1a1a1a"/><rect x="20" y="30" width="4" height="8" rx="2" fill="#1a1a1a"/><rect x="13" y="12" width="18" height="2.8" rx="1.4" fill="#444"/><path d="M18 14 Q22 12 26 14 L25 30 Q22 31.5 19 30 Z" fill="url(#mB)" stroke="#9c3d00" stroke-width="0.8"/><rect x="19" y="20" width="6" height="8" rx="3" fill="#135E29"/><rect x="20" y="15" width="4" height="3" rx="1.5" fill="#fff6d8"/><rect x="19.4" y="15" width="1.8" height="12" rx="0.9" fill="#ffffff" opacity="0.14"/></svg>',
    camion:'<svg viewBox="0 0 44 44" width="40" height="40" style="display:block"><defs><linearGradient id="tCab" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#FFF4E0"/><stop offset="1" stop-color="#E8D9B8"/></linearGradient><linearGradient id="tCar" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#2FA84F"/><stop offset="1" stop-color="#145E29"/></linearGradient></defs><rect x="11" y="16" width="22" height="22" rx="3" fill="url(#tCar)" stroke="#0e4a22" stroke-width="0.9"/><rect x="13.5" y="18.8" width="17" height="16.5" rx="2" fill="#176e34"/><rect x="11" y="16" width="22" height="2.6" rx="1.3" fill="#F06000"/><rect x="12" y="5" width="20" height="12" rx="3" fill="url(#tCab)" stroke="#c9b98f" stroke-width="0.9"/><rect x="14.5" y="7" width="15" height="5" rx="1.6" fill="#bfe6cf"/></svg>'
  };
  var svgActual=SVG.carro;
  var recLat=null,recLon=null,destLat=null,destLon=null,dLat=null,dLon=null,metaRuta=null;
  var carro=null,pin=null,mDest=null,rutaPts=null,carIdx=0,ultimaRuta=null;
  var seguir=true,primera=true,animId=null,navegacion=false,ZOOM=16;
  var ready=false,cola=[];
  function enListo(fn){ if(ready){ try{fn();}catch(e){} } else cola.push(fn); }
  function line(coords){ return {type:'Feature',geometry:{type:'LineString',coordinates:coords||[]}}; }
  function rutaURL(lo1,la1,lo2,la2){ return 'https://api.mapbox.com/directions/v5/mapbox/driving/'+lo1+','+la1+';'+lo2+','+la2+'?geometries=geojson&overview=full&access_token=${MAPBOX_TOKEN}'; }
  function rumbo(a,b){ var la1=a[1]*Math.PI/180,la2=b[1]*Math.PI/180,dlo=(b[0]-a[0])*Math.PI/180; var y=Math.sin(dlo)*Math.cos(la2); var x=Math.cos(la1)*Math.sin(la2)-Math.sin(la1)*Math.cos(la2)*Math.cos(dlo); return (Math.atan2(y,x)*180/Math.PI+360)%360; }
  function emoji(ch){ var d=document.createElement('div'); d.className='em'; d.textContent=ch; return d; }

  function alCargar(){
    if(esperaGL) clearTimeout(esperaGL);
    map.addSource('ctx',{type:'geojson',data:line([])});
    map.addLayer({id:'ctx',type:'line',source:'ctx',layout:{'line-cap':'round','line-join':'round'},paint:{'line-color':'#C0392B','line-width':4,'line-opacity':0.5,'line-dasharray':[1,3]}});
    map.addSource('ruta',{type:'geojson',data:line([])});
    map.addLayer({id:'ruta',type:'line',source:'ruta',layout:{'line-cap':'round','line-join':'round'},paint:{'line-color':'#187830','line-width':6,'line-opacity':0.9}});
    ready=true; map.resize(); var q=cola; cola=[]; q.forEach(function(f){ try{f();}catch(e){} });
    // al pasar a Leaflet se repinta lo ultimo conocido (recogida, destino, conductor)
    if(modoMapa==='leaflet'){ var u=ultimos; if(u.rec) _recogida(u.rec[0],u.rec[1]); if(u.dest) _destino(u.dest[0],u.dest[1]); if(u.cond) _conductor(u.cond[0],u.cond[1]); }
  }
  var ultimos={};
  window.addEventListener('resize', function(){ try{ map.resize(); }catch(e){} });
  // arranque: GL si el celular puede; si no (o si GL no carga en 8 s), Leaflet
  if(typeof mapboxgl==='undefined' || !tieneWebGL2()){ pasarALeaflet(); }
  else {
    try{ mapboxgl.accessToken='${MAPBOX_TOKEN}'; crearMapa(); esperaGL=setTimeout(function(){ if(!ready) pasarALeaflet(); },8000); }
    catch(e){ pasarALeaflet(); }
  }

  function botones(){ document.getElementById('bSeguir').className=seguir?'on':''; document.getElementById('bRuta').className=seguir?'':'on'; }
  function modoSeguir(){ seguir=true; botones(); if(carro){ map.easeTo({center:carro.getLngLat(),zoom:Math.max(map.getZoom(),ZOOM),duration:400}); } }
  function modoRuta(){ seguir=false; botones(); var pts=[]; if(carro){ var c=carro.getLngLat(); pts.push([c.lng,c.lat]); } if(recLat!=null)pts.push([recLon,recLat]); if(destLat!=null)pts.push([destLon,destLat]); if(pts.length>=2){ var b=new mapboxgl.LngLatBounds(pts[0],pts[0]); pts.forEach(function(p){b.extend(p);}); map.fitBounds(b,{padding:60,duration:500}); } else if(pts.length===1){ map.easeTo({center:pts[0],zoom:Math.max(map.getZoom(),14)}); } }

  function setVehiculo(t){ t=(t||'').toLowerCase(); svgActual=t==='moto'?SVG.moto:t==='carro'?SVG.carro:SVG.camion; if(carro){ carro.getElement().innerHTML=svgActual; } }
  function setNavegacion(v){ navegacion=!!v; if(navegacion&&carro){ seguir=true; botones(); map.easeTo({center:carro.getLngLat(),zoom:17,duration:500}); } }

  function aplicarMeta(){ if(metaRuta==='destino'&&destLat!=null){ dLat=destLat; dLon=destLon; } else if(recLat!=null){ dLat=recLat; dLon=recLon; } else if(destLat!=null){ dLat=destLat; dLon=destLon; } else { dLat=null; dLon=null; } }

  function pedirRuta(la,lo){
    if(dLat==null) return;
    fetch(rutaURL(lo,la,dLon,dLat)).then(function(r){return r.json();}).then(function(d){
      if(!d.routes||!d.routes[0]) throw 0;
      var r=d.routes[0]; var pts=r.geometry.coordinates;
      map.getSource('ruta').setData(line(pts));
      rutaPts=pts; carIdx=carro?nearestIdx(carro.getLngLat().lng,carro.getLngLat().lat):0;
      ultimaRuta=[la,lo];
      if(window.ReactNativeWebView){ window.ReactNativeWebView.postMessage(JSON.stringify({km:r.distance/1000,min:Math.round(r.duration/60)})); }
    }).catch(function(){ if(map.getSource('ruta')) map.getSource('ruta').setData(line(dLat!=null?[[lo,la],[dLon,dLat]]:[])); });
  }
  function dibujarContexto(){
    if(recLat==null||destLat==null||!map.getSource('ctx')) return;
    map.setPaintProperty('ctx','line-color','#C0392B'); map.setPaintProperty('ctx','line-width',4); map.setPaintProperty('ctx','line-opacity',0.5); map.setPaintProperty('ctx','line-dasharray',[1,3]);
    fetch(rutaURL(recLon,recLat,destLon,destLat)).then(function(r){return r.json();}).then(function(d){
      if(!d.routes||!d.routes[0]) throw 0;
      map.getSource('ctx').setData(line(d.routes[0].geometry.coordinates));
    }).catch(function(){ if(map.getSource('ctx')) map.getSource('ctx').setData(line([[recLon,recLat],[destLon,destLat]])); });
  }
  function previa(){
    if(recLat==null||destLat==null||!map.getSource('ctx')) return;
    map.setPaintProperty('ctx','line-color','#F06000'); map.setPaintProperty('ctx','line-width',6); map.setPaintProperty('ctx','line-opacity',0.95); map.setPaintProperty('ctx','line-dasharray',[1,0]);
    var b=new mapboxgl.LngLatBounds([recLon,recLat],[recLon,recLat]); b.extend([destLon,destLat]); map.fitBounds(b,{padding:60,duration:400});
    fetch(rutaURL(recLon,recLat,destLon,destLat)).then(function(r){return r.json();}).then(function(d){
      if(!d.routes||!d.routes[0]) throw 0;
      var r=d.routes[0]; var pts=r.geometry.coordinates;
      var bb=new mapboxgl.LngLatBounds(pts[0],pts[0]); pts.forEach(function(p){bb.extend(p);}); map.fitBounds(bb,{padding:55,duration:400});
      var total=pts.length,t0=performance.now(),DUR=900;
      (function dibuja(now){ var prog=Math.min(1,(now-t0)/DUR); var n=Math.max(2,Math.floor(prog*total)); map.getSource('ctx').setData(line(pts.slice(0,n))); if(prog<1) requestAnimationFrame(dibuja); else map.getSource('ctx').setData(line(pts)); })(performance.now());
      if(window.ReactNativeWebView){ window.ReactNativeWebView.postMessage(JSON.stringify({km:r.distance/1000,min:Math.round(r.duration/60)})); }
    }).catch(function(){ if(map.getSource('ctx')) map.getSource('ctx').setData(line([[recLon,recLat],[destLon,destLat]])); });
  }

  function nearestIdx(lng,lat){ if(!rutaPts) return 0; var best=0,bd=Infinity; for(var i=0;i<rutaPts.length;i++){ var dx=rutaPts[i][0]-lng,dy=rutaPts[i][1]-lat,d=dx*dx+dy*dy; if(d<bd){bd=d;best=i;} } return best; }
  function moverEnRuta(la,lo){
    var c=carro.getLngLat(); var a=[c.lng,c.lat];
    if(!rutaPts||rutaPts.length<2){ animarSecuencia([a,[lo,la]]); return; }
    var idx=nearestIdx(lo,la); var seq=[a]; if(idx>=carIdx){ for(var i=carIdx+1;i<=idx;i++) seq.push(rutaPts[i]); } seq.push([lo,la]); carIdx=idx; animarSecuencia(seq);
  }
  function animarSecuencia(seq){
    if(animId) cancelAnimationFrame(animId);
    var pts=[seq[0]]; for(var k=1;k<seq.length;k++){ var p=seq[k],q=pts[pts.length-1]; if(p[0]!==q[0]||p[1]!==q[1]) pts.push(p); }
    if(pts.length<2){ if(carro) carro.setLngLat(pts[0]); return; }
    var i=0,t0=performance.now(),segDur=1300/(pts.length-1);
    function paso(now){ var t=Math.min(1,(now-t0)/segDur); var a=pts[i],b=pts[i+1];
      carro.setLngLat([a[0]+(b[0]-a[0])*t,a[1]+(b[1]-a[1])*t]); carro.setRotation(rumbo(a,b));
      if(seguir){ map.setCenter(carro.getLngLat()); }
      if(t>=1){ i++; if(i<pts.length-1){ t0=now; animId=requestAnimationFrame(paso); } } else { animId=requestAnimationFrame(paso); }
    }
    animId=requestAnimationFrame(paso);
  }

  function _recogida(la,lo){ recLat=la; recLon=lo; if(!pin){ pin=new mapboxgl.Marker({element:emoji('📍'),anchor:'bottom'}).setLngLat([lo,la]).addTo(map); } else pin.setLngLat([lo,la]); aplicarMeta(); ultimaRuta=null; dibujarContexto(); if(!carro){ map.easeTo({center:[lo,la],zoom:ZOOM}); } else if(metaRuta!=='destino'){ var c=carro.getLngLat(); pedirRuta(c.lat,c.lng); } }
  function _destino(la,lo){ destLat=la; destLon=lo; if(!mDest){ mDest=new mapboxgl.Marker({element:emoji('🏁'),anchor:'bottom'}).setLngLat([lo,la]).addTo(map); } else mDest.setLngLat([lo,la]); aplicarMeta(); dibujarContexto(); if(!carro&&!pin){ map.easeTo({center:[lo,la],zoom:ZOOM}); } else if(metaRuta==='destino'&&carro){ ultimaRuta=null; var c=carro.getLngLat(); pedirRuta(c.lat,c.lng); } }
  function _conductor(la,lo){
    if(!carro){ var el=document.createElement('div'); el.className='veh'; el.innerHTML=svgActual; carro=new mapboxgl.Marker({element:el,rotationAlignment:'map'}).setLngLat([lo,la]).addTo(map); carIdx=0;
      if(primera){ if(navegacion){ seguir=true; botones(); map.easeTo({center:[lo,la],zoom:17}); } else if(dLat!=null){ seguir=false; botones(); var b=new mapboxgl.LngLatBounds([lo,la],[lo,la]); b.extend([dLon,dLat]); map.fitBounds(b,{padding:60,duration:400}); } else { map.easeTo({center:[lo,la],zoom:ZOOM}); } primera=false; }
    } else { moverEnRuta(la,lo); }
    var mover=!ultimaRuta||Math.sqrt(Math.pow(la-ultimaRuta[0],2)+Math.pow(lo-ultimaRuta[1],2))>0.0008; if(mover) pedirRuta(la,lo);
  }
  function _rutaA(cual){ metaRuta=cual; aplicarMeta(); ultimaRuta=null; if(carro&&dLat!=null){ var c=carro.getLngLat(); pedirRuta(c.lat,c.lng); } }
  function recogida(la,lo){ ultimos.rec=[la,lo]; enListo(function(){_recogida(la,lo);}); }
  function punto(la,lo){ recogida(la,lo); }
  function destino(la,lo){ ultimos.dest=[la,lo]; enListo(function(){_destino(la,lo);}); }
  function conductor(la,lo){ ultimos.cond=[la,lo]; enListo(function(){_conductor(la,lo);}); }
  function rutaA(cual){ enListo(function(){_rutaA(cual);}); }
</script></body></html>`;
}

function MapaSeguimiento({ punto, recogida, destino, conductor, rutaA, onInfo, lleno, preview, vehiculo, navegacion }) {
  const webRef = useRef(null);
  const [listo, setListo] = useState(false);
  // el HTML es FIJO (sin coordenadas) y se genera una sola vez por montaje: si
  // se regenerara en cada refresco, el WebView recargaria el mapa y se
  // "congelaria" perdiendo el 🚗. Las posiciones llegan siempre inyectadas —
  // antes, si la carrera se pedia sin pin, el HTML nacia null y el mapa no
  // aparecia NUNCA aunque el conductor ya estuviera reportando su ubicacion.
  const html = useMemo(() => mapaSeguimientoHTML(), []);
  // "punto" queda como alias de recogida para no romper llamados viejos
  const rec = recogida || punto || null;
  // cada vez que llega posicion nueva (o el mapa termina de cargar), se inyecta
  useEffect(() => {
    if (!listo || !webRef.current) return;
    if (rec && rec.lat != null) {
      webRef.current.injectJavaScript(`recogida(${rec.lat}, ${rec.lon}); true;`);
    }
  }, [listo, rec && rec.lat, rec && rec.lon]);
  useEffect(() => {
    if (!listo || !webRef.current) return;
    if (destino && destino.lat != null) {
      webRef.current.injectJavaScript(`destino(${destino.lat}, ${destino.lon}); true;`);
    }
  }, [listo, destino && destino.lat, destino && destino.lon]);
  useEffect(() => {
    if (!listo || !webRef.current) return;
    if (conductor && conductor.lat != null) {
      webRef.current.injectJavaScript(`conductor(${conductor.lat}, ${conductor.lon}); true;`);
    }
  }, [listo, conductor && conductor.lat, conductor && conductor.lon]);
  useEffect(() => {
    if (!listo || !webRef.current || !rutaA) return;
    webRef.current.injectJavaScript(`rutaA(${JSON.stringify(rutaA)}); true;`);
  }, [listo, rutaA]);
  // tipo de vehiculo -> elige el icono (moto / carro / acarreo) en el mapa
  useEffect(() => {
    if (!listo || !webRef.current || !vehiculo) return;
    webRef.current.injectJavaScript(`setVehiculo(${JSON.stringify(vehiculo)}); true;`);
  }, [listo, vehiculo]);
  // modo navegación (conductor): cámara pegada al vehículo, como Google Maps
  useEffect(() => {
    if (!listo || !webRef.current) return;
    webRef.current.injectJavaScript(`setNavegacion(${navegacion ? "true" : "false"}); true;`);
  }, [listo, navegacion]);
  // VISTA PREVIA: con recogida + destino (y sin conductor), traza el recorrido y
  // encuadra los dos puntos. Se re-dispara si cambia cualquiera de los extremos.
  useEffect(() => {
    if (!preview || !listo || !webRef.current) return;
    if (rec && rec.lat != null && destino && destino.lat != null) {
      webRef.current.injectJavaScript(`previa(); true;`);
    }
  }, [preview, listo, rec && rec.lat, rec && rec.lon, destino && destino.lat, destino && destino.lon]);
  // chequeo VIVO en cada render: el mapa se muestra apenas exista alguna
  // coordenada, sin importar cuando llego
  const hayDatos = (rec && rec.lat != null) || (destino && destino.lat != null) || (conductor && conductor.lat != null);
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

/** abre Google Maps con navegacion hacia un punto (gratis: usa la app de Maps del
 *  celular). Se usa la URL universal de direcciones como principal porque es la
 *  mas confiable para que Maps TRACE la ruta; si no, el esquema de navegacion. */
function navegarGoogleMaps(lat, lon) {
  const dir = `https://www.google.com/maps/dir/?api=1&destination=${lat},${lon}&travelmode=driving`;
  Linking.openURL(dir)
    .catch(() => Linking.openURL(`google.navigation:q=${lat},${lon}`)
      .catch(() => Linking.openURL(`geo:${lat},${lon}?q=${lat},${lon}`).catch(() => {})));
}

// respaldo cuando el destino no tiene coordenadas: navega por el nombre escrito
function navegarGoogleMapsTexto(texto) {
  const q = encodeURIComponent((texto || "").trim());
  if (!q) return;
  Linking.openURL(`google.navigation:q=${q}`)
    .catch(() => Linking.openURL(`https://www.google.com/maps/dir/?api=1&destination=${q}`).catch(() => {}));
}

// Calendario tipo hoja inferior: mes navegable (hasta donde quieras hacia adelante)
// + hora + minutos. Todo en JS (sale por OTA, sin modulo nativo ni reinstalar).
// onConfirmar(dia, h, m) -> dia es la fecha a medianoche; el padre arma el ISO.
function CalendarioModal({ visible, inicial, onConfirmar, onCerrar }) {
  const hoy = new Date(); hoy.setHours(0, 0, 0, 0);
  const [mes, setMes] = useState(new Date(hoy.getFullYear(), hoy.getMonth(), 1));
  const [sel, setSel] = useState(null);
  const [hSel, setHSel] = useState(null);
  const [mSel, setMSel] = useState(null);
  useEffect(() => {
    if (visible) {
      const d = inicial && inicial.d ? inicial.d : null;
      setMes(new Date((d || hoy).getFullYear(), (d || hoy).getMonth(), 1));
      setSel(d);
      setHSel(inicial && inicial.h != null ? inicial.h : null);
      setMSel(inicial && inicial.m != null ? inicial.m : null);
    }
  }, [visible]);
  const y = mes.getFullYear(), m = mes.getMonth();
  const offset = new Date(y, m, 1).getDay();   // domingo primero (0=dom)
  const diasMes = new Date(y, m + 1, 0).getDate();
  const celdas = [];
  for (let i = 0; i < offset; i++) celdas.push(0);
  for (let d = 1; d <= diasMes; d++) celdas.push(d);
  while (celdas.length % 7 !== 0) celdas.push(0);
  const puedeAtras = (y > hoy.getFullYear()) || (y === hoy.getFullYear() && m > hoy.getMonth());
  const esPasado = (d) => new Date(y, m, d) < hoy;
  const esHoy = (d) => new Date(y, m, d).getTime() === hoy.getTime();
  const selEs = (d) => sel && sel.getFullYear() === y && sel.getMonth() === m && sel.getDate() === d;
  const listo = sel && hSel != null && mSel != null;
  const DIAS_COR = ["Dom", "Lun", "Mar", "Mié", "Jue", "Vie", "Sáb"];
  const MES_COR = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];
  const cabAnio = sel ? sel.getFullYear() : mes.getFullYear();
  const cabFecha = sel ? `${DIAS_COR[sel.getDay()]}, ${sel.getDate()} de ${MES_COR[sel.getMonth()]}` : "Elige el día";
  return (
    <Modal visible={visible} animationType="fade" transparent onRequestClose={onCerrar}>
      <View style={{ flex: 1, backgroundColor: "rgba(0,0,0,0.45)", justifyContent: "center", padding: 22 }}>
        <View style={{ backgroundColor: "#fff", borderRadius: 20, overflow: "hidden", maxHeight: "92%" }}>
          {/* cabecera con la fecha seleccionada (estilo Material) */}
          <View style={{ backgroundColor: "#187830", paddingHorizontal: 22, paddingTop: 18, paddingBottom: 16 }}>
            <Text style={{ color: "rgba(255,255,255,0.8)", fontSize: 15, fontWeight: "700" }}>{cabAnio}</Text>
            <Text style={{ color: "#fff", fontSize: 30, fontWeight: "800", marginTop: 2 }}>{cabFecha}</Text>
            {listo && <Text style={{ color: "rgba(255,255,255,0.92)", fontSize: 15, fontWeight: "700", marginTop: 4 }}>⏰ {(hSel % 12 === 0 ? 12 : hSel % 12)}:{String(mSel).padStart(2, "0")} {hSel < 12 ? "a.m." : "p.m."}</Text>}
          </View>

          <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ padding: 16, paddingBottom: 8 }}>
            {/* navegacion de mes */}
            <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
              <TouchableOpacity onPress={() => puedeAtras && setMes(new Date(y, m - 1, 1))} disabled={!puedeAtras} style={{ padding: 8, width: 44, alignItems: "center" }}>
                <Text style={{ fontSize: 26, color: puedeAtras ? "#187830" : "#ddd" }}>‹</Text>
              </TouchableOpacity>
              <Text style={{ fontSize: 16, fontWeight: "800", color: "#222" }}>{MESES_ES[m]} de {y}</Text>
              <TouchableOpacity onPress={() => setMes(new Date(y, m + 1, 1))} style={{ padding: 8, width: 44, alignItems: "center" }}>
                <Text style={{ fontSize: 26, color: "#187830" }}>›</Text>
              </TouchableOpacity>
            </View>
            <View style={{ flexDirection: "row" }}>
              {["D", "L", "M", "M", "J", "V", "S"].map((x, i) => (
                <Text key={i} style={{ flex: 1, textAlign: "center", fontSize: 12, color: "#bbb", fontWeight: "700", paddingVertical: 4 }}>{x}</Text>
              ))}
            </View>
            <View style={{ flexDirection: "row", flexWrap: "wrap" }}>
              {celdas.map((d, i) => (
                <View key={i} style={{ width: "14.28%", aspectRatio: 1, padding: 2, alignItems: "center", justifyContent: "center" }}>
                  {d ? (
                    <TouchableOpacity disabled={esPasado(d)} onPress={() => setSel(new Date(y, m, d))} activeOpacity={0.7}
                      style={{ width: 40, height: 40, borderRadius: 20, alignItems: "center", justifyContent: "center",
                        backgroundColor: selEs(d) ? "#187830" : "transparent",
                        borderWidth: !selEs(d) && esHoy(d) ? 1.5 : 0, borderColor: "#187830" }}>
                      <Text style={{ fontSize: 15, fontWeight: selEs(d) ? "800" : "500", color: esPasado(d) ? "#d0d0d0" : selEs(d) ? "#fff" : esHoy(d) ? "#187830" : "#333" }}>{d}</Text>
                    </TouchableOpacity>
                  ) : null}
                </View>
              ))}
            </View>

            <View style={{ height: 1, backgroundColor: "#eee", marginVertical: 12 }} />
            <Text style={{ fontSize: 12, color: "#999", fontWeight: "800", letterSpacing: 0.5 }}>HORA</Text>
            <ScrollView horizontal showsHorizontalScrollIndicator={false}>
              <View style={{ flexDirection: "row", gap: 8, paddingVertical: 6 }}>
                {horasCompletas().map(x => (
                  <TouchableOpacity key={x.h} onPress={() => setHSel(x.h)} style={[styles.chip, hSel === x.h && styles.chipOn]}>
                    <Text style={[styles.chipTxt, hSel === x.h && styles.chipTxtOn]}>{x.lbl}</Text>
                  </TouchableOpacity>
                ))}
              </View>
            </ScrollView>
            <Text style={{ fontSize: 12, color: "#999", fontWeight: "800", letterSpacing: 0.5, marginTop: 4 }}>MINUTOS</Text>
            <ScrollView horizontal showsHorizontalScrollIndicator={false}>
              <View style={{ flexDirection: "row", gap: 8, paddingVertical: 6 }}>
                {minutosLista().map(x => (
                  <TouchableOpacity key={x.m} onPress={() => setMSel(x.m)} style={[styles.chip, mSel === x.m && styles.chipOn]}>
                    <Text style={[styles.chipTxt, mSel === x.m && styles.chipTxtOn]}>{x.lbl}</Text>
                  </TouchableOpacity>
                ))}
              </View>
            </ScrollView>
          </ScrollView>

          {/* acciones */}
          <View style={{ flexDirection: "row", justifyContent: "flex-end", alignItems: "center", gap: 6, paddingHorizontal: 14, paddingVertical: 12, borderTopWidth: 1, borderTopColor: "#f0f0f0" }}>
            <TouchableOpacity onPress={onCerrar} style={{ paddingVertical: 10, paddingHorizontal: 18 }}>
              <Text style={{ color: "#888", fontWeight: "800", fontSize: 15 }}>CANCELAR</Text>
            </TouchableOpacity>
            <TouchableOpacity disabled={!listo} onPress={() => onConfirmar(sel, hSel, mSel)} style={{ paddingVertical: 10, paddingHorizontal: 18 }}>
              <Text style={{ color: listo ? "#187830" : "#c5c5c5", fontWeight: "800", fontSize: 15 }}>CONFIRMAR</Text>
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </Modal>
  );
}

// Recibo detallado de una carrera/acarreo (cliente o conductor), con opcion de
// compartir por WhatsApp/el medio que elija. Se abre al tocar una del historial.
function ReciboModal({ visible, c, esConductor, onCerrar }) {
  if (!c) return null;
  const fin = c.estado === "finalizada";
  const precio = c.tarifa || c.tarifa_ofrecida;
  const contra = esConductor ? c.cliente_nombre : c.conductor_nombre;
  const estrellas = esConductor ? c.estrellas_conductor : c.estrellas_cliente;
  const veh = c.vehiculo_pedido;
  const compartir = async () => {
    try {
      const L = [
        "🧾 RECIBO · Tukán",
        c.fecha ? `🗓️ ${fmtFechaLarga(c.fecha)}` : null,
        fin ? "✅ Finalizada" : "❌ Cancelada",
        "",
        `🟢 ${c.origen || "—"}`,
        `🔴 ${c.destino || "—"}`,
        c.distancia_km ? `📏 ~${c.distancia_km} km` : null,
        veh ? `${vehIcono(veh)} ${vehLabel(veh)}${c.conductor_placa ? " · " + c.conductor_placa : ""}` : null,
        contra ? `${esConductor ? "👤 Cliente" : "🚕 Conductor"}: ${contra}` : null,
        estrellas ? `⭐ ${Number(estrellas).toFixed(0)}` : null,
        precio ? `💵 TOTAL: $${precio.toLocaleString()}` : null,
        "",
        "Gracias por viajar con Tukán 🚕",
      ].filter(x => x !== null);
      await Share.share({ message: L.join("\n") });
    } catch (_) {}
  };
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onCerrar}>
      <View style={{ flex: 1, backgroundColor: "rgba(0,0,0,0.45)", justifyContent: "flex-end" }}>
        <View style={{ backgroundColor: "#fff", borderTopLeftRadius: 22, borderTopRightRadius: 22, padding: 20, paddingBottom: 26 }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
            <Image source={require("./assets/icon.png")} style={{ width: 40, height: 40, borderRadius: 11 }} />
            <View style={{ flex: 1 }}>
              <Text style={{ fontSize: 11, color: "#9A948A", fontWeight: "800", letterSpacing: 1 }}>RECIBO · TUKÁN</Text>
              <Text style={{ fontSize: 15.5, fontWeight: "800", color: "#1C2B22" }}>{c.fecha ? fmtFechaLarga(c.fecha) : ""}</Text>
            </View>
            <View style={{ backgroundColor: fin ? "#EAF6EC" : "#FDECEA", borderRadius: 8, paddingHorizontal: 10, paddingVertical: 4 }}>
              <Text style={{ fontSize: 11, color: fin ? "#187830" : "#C0392B", fontWeight: "800" }}>{fin ? "Finalizada" : "Cancelada"}</Text>
            </View>
          </View>

          <View style={{ height: 1, backgroundColor: "#eee", marginVertical: 14 }} />

          <View style={{ flexDirection: "row" }}>
            <View style={{ width: 16, alignItems: "center", paddingVertical: 4 }}>
              <View style={{ width: 11, height: 11, borderRadius: 6, backgroundColor: "#187830" }} />
              <View style={{ width: 2, flex: 1, backgroundColor: "#DADDD5", marginVertical: 3 }} />
              <View style={{ width: 11, height: 11, borderRadius: 3, backgroundColor: "#F06000" }} />
            </View>
            <View style={{ flex: 1, marginLeft: 10 }}>
              <Text style={{ fontSize: 10.5, color: "#9A948A", fontWeight: "800" }}>RECOGIDA</Text>
              <Text style={{ fontSize: 14.5, color: "#1C2B22", marginBottom: 10 }} numberOfLines={2}>{c.origen || "—"}</Text>
              <Text style={{ fontSize: 10.5, color: "#9A948A", fontWeight: "800" }}>DESTINO</Text>
              <Text style={{ fontSize: 14.5, color: "#1C2B22" }} numberOfLines={2}>{c.destino || "—"}</Text>
            </View>
          </View>
          <DetalleAcarreo c={c} />
          <PruebaEntrega c={c} />

          <View style={{ flexDirection: "row", flexWrap: "wrap", marginTop: 16 }}>
            {[
              ["Distancia", c.distancia_km ? `~${c.distancia_km} km` : "—"],
              ["Vehículo", veh ? `${vehIcono(veh)} ${vehLabel(veh)}` : "—"],
              [esConductor ? "Cliente" : "Conductor", contra || "—"],
              ["Placa", c.conductor_placa || "—"],
            ].map(([k, v]) => (
              <View key={k} style={{ width: "50%", marginBottom: 12 }}>
                <Text style={{ fontSize: 10.5, color: "#9A948A", fontWeight: "800" }}>{k.toUpperCase()}</Text>
                <Text style={{ fontSize: 14.5, color: "#1C2B22", fontWeight: "600", marginTop: 1 }} numberOfLines={1}>{v}</Text>
              </View>
            ))}
          </View>

          <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", backgroundColor: "#EAF6EC", borderRadius: 12, padding: 14, marginTop: 2 }}>
            <View>
              <Text style={{ fontSize: 11, color: "#7A927F", fontWeight: "800" }}>TOTAL</Text>
              {estrellas ? <Text style={{ fontSize: 12, color: "#5a7a60", marginTop: 2 }}>⭐ {Number(estrellas).toFixed(0)} de calificación</Text> : null}
            </View>
            <Text style={{ fontSize: 26, fontWeight: "900", color: "#187830" }}>{precio ? `$${precio.toLocaleString()}` : "—"}</Text>
          </View>

          <View style={{ flexDirection: "row", gap: 10, marginTop: 16 }}>
            <TouchableOpacity style={[styles.button, { flex: 1, backgroundColor: "#fff", borderWidth: 1, borderColor: "#ddd" }]} onPress={onCerrar}>
              <Text style={{ color: "#888", fontWeight: "700" }}>Cerrar</Text>
            </TouchableOpacity>
            <TouchableOpacity style={[styles.button, { flex: 1.3, backgroundColor: "#187830" }]} onPress={compartir}>
              <Text style={styles.buttonText}>📤 Compartir recibo</Text>
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </Modal>
  );
}

// una carrera del historial (pasada). Sirve para el conductor y para el cliente:
// segun quien mira, muestra a la contraparte y la calificacion que recibio.
// Se toca para abrir el RECIBO detallado.
function TarjetaHistorial({ c, esConductor }) {
  const [ver, setVer] = useState(false);
  const fin = c.estado === "finalizada";
  const badge = fin ? { t: "Finalizada", col: "#187830", bg: "#EAF6EC" } : { t: "Cancelada", col: "#C0392B", bg: "#FDECEA" };
  const precio = c.tarifa || c.tarifa_ofrecida;
  const contra = esConductor ? c.cliente_nombre : c.conductor_nombre;
  const estrellas = esConductor ? c.estrellas_conductor : c.estrellas_cliente;   // la que recibio quien mira
  return (
    <>
    <TouchableOpacity activeOpacity={0.7} onPress={() => setVer(true)} style={{ backgroundColor: "#fff", borderRadius: 12, padding: 13, marginBottom: 8 }}>
      <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
        <Text style={{ fontSize: 12, color: "#999" }}>{haceCuanto(c.fecha)}{esCarga(c.vehiculo_pedido) ? "  ·  🚚 acarreo" : ""}</Text>
        <View style={{ backgroundColor: badge.bg, borderRadius: 6, paddingHorizontal: 8, paddingVertical: 2 }}>
          <Text style={{ fontSize: 11, color: badge.col, fontWeight: "700" }}>{badge.t}</Text>
        </View>
      </View>
      <Text numberOfLines={1} style={{ fontSize: 13.5, color: "#333", marginTop: 5 }}>🟢 {limpiaDir(c.origen)}</Text>
      <Text numberOfLines={1} style={{ fontSize: 13.5, color: "#333", marginTop: 1 }}>🔴 {limpiaDir(c.destino)}</Text>
      <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginTop: 6 }}>
        <Text style={{ fontSize: 12.5, color: "#666" }} numberOfLines={1}>
          {contra ? `${esConductor ? "👤" : "🚕"} ${contra}` : "—"}{estrellas ? `  ·  ⭐ ${Number(estrellas).toFixed(0)}` : ""}
        </Text>
        {precio ? <Text style={{ fontSize: 16, fontWeight: "800", color: fin ? "#187830" : "#999" }}>${precio.toLocaleString()}</Text> : null}
      </View>
      {!fin && c.motivo_cancelacion ? (
        <Text style={{ fontSize: 12, color: "#C0392B", marginTop: 5 }} numberOfLines={2}>
          Motivo{c.cancelada_por ? ` (${c.cancelada_por})` : ""}: {c.motivo_cancelacion}
        </Text>
      ) : null}
      <Text style={{ fontSize: 11, color: "#1A56B8", fontWeight: "700", marginTop: 7 }}>📄 Ver recibo ›</Text>
    </TouchableOpacity>
    <ReciboModal visible={ver} c={c} esConductor={esConductor} onCerrar={() => setVer(false)} />
    </>
  );
}

/** ADMIN · comportamiento de un conductor para tomar accion: promedio, reparto
 *  de estrellas, cancelaciones y comentarios de los pasajeros. */
function ReputacionAdminModal({ conductorId, onCerrar }) {
  const [rep, setRep] = useState(null);
  useEffect(() => {
    fetch(`${API}/conductores/${conductorId}/reputacion`).then(r => r.json())
      .then(d => { if (d && d.conductor_id) setRep(d); }).catch(() => {});
  }, [conductorId]);
  const alerta = rep && ((rep.calificacion != null && rep.calificacion < 3.5) || rep.canceladas_por_conductor >= 3);
  return (
    <Modal visible transparent animationType="slide" onRequestClose={onCerrar}>
      <View style={{ flex: 1, backgroundColor: "rgba(0,0,0,0.45)", justifyContent: "flex-end" }}>
        <View style={{ backgroundColor: "#fff", borderTopLeftRadius: 22, borderTopRightRadius: 22, padding: 20, paddingBottom: 28, maxHeight: "85%" }}>
          {!rep ? <ActivityIndicator color="#187830" /> : (
            <ScrollView>
              <Text style={{ fontSize: 19, fontWeight: "900", color: "#1C2B22" }}>{rep.nombre}</Text>
              <Text style={{ fontSize: 14, color: "#555", marginTop: 4 }}>
                ⭐ {rep.calificacion != null ? Number(rep.calificacion).toFixed(2) : "—"} · {rep.total_calificaciones} calificaciones · {rep.finalizadas} finalizadas
              </Text>
              {alerta && (
                <View style={{ backgroundColor: "#FDECEA", borderRadius: 10, padding: 10, marginTop: 10 }}>
                  <Text style={{ color: "#C0392B", fontWeight: "800", fontSize: 13 }}>⚠️ Revisar: calificación baja o muchas cancelaciones</Text>
                </View>
              )}
              <View style={{ flexDirection: "row", gap: 8, marginTop: 12 }}>
                <View style={{ flex: 1, backgroundColor: "#FFF4E0", borderRadius: 10, padding: 10 }}>
                  <Text style={{ fontSize: 11, color: "#8A5A00" }}>Canceló él</Text>
                  <Text style={{ fontSize: 22, fontWeight: "900", color: "#8A5A00" }}>{rep.canceladas_por_conductor}</Text>
                </View>
                <View style={{ flex: 1, backgroundColor: "#F3F0E8", borderRadius: 10, padding: 10 }}>
                  <Text style={{ fontSize: 11, color: "#666" }}>Le cancelaron</Text>
                  <Text style={{ fontSize: 22, fontWeight: "900", color: "#666" }}>{rep.canceladas_por_cliente}</Text>
                </View>
              </View>
              <Text style={[styles.etiqueta, { marginTop: 14 }]}>ESTRELLAS</Text>
              {[5, 4, 3, 2, 1].map(n => (
                <Text key={n} style={{ fontSize: 13, color: "#555" }}>{"⭐".repeat(n)}  {rep.distribucion[n] || 0}</Text>
              ))}
              <Text style={[styles.etiqueta, { marginTop: 14 }]}>COMENTARIOS</Text>
              {rep.comentarios.length === 0 ? <Text style={{ color: "#999", fontSize: 13 }}>Sin comentarios.</Text>
                : rep.comentarios.map((cm, i) => (
                  <View key={i} style={{ borderTopWidth: i ? 1 : 0, borderTopColor: "#eee", paddingVertical: 8 }}>
                    <Text style={{ fontSize: 12, color: "#B8860B", fontWeight: "700" }}>{"⭐".repeat(cm.estrellas)} · {haceCuanto(cm.fecha)}</Text>
                    <Text style={{ fontSize: 13.5, color: "#333", marginTop: 2 }}>{cm.comentario}</Text>
                  </View>
                ))}
            </ScrollView>
          )}
          <TouchableOpacity style={{ padding: 12, marginTop: 6 }} onPress={onCerrar}>
            <Text style={{ textAlign: "center", color: "#888", fontWeight: "600" }}>Cerrar</Text>
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
}

/** Historial del conductor con filtros: periodo, estado, tipo y busqueda por
 *  lugar o cliente. Arriba, el resumen de lo que quedo filtrado. */
function HistorialFiltrado({ historial }) {
  const [periodo, setPeriodo] = useState("todo");
  const [estado, setEstado] = useState("todas");
  const [tipo, setTipo] = useState("todos");
  const [q, setQ] = useState("");
  const desde = (() => {
    const d = new Date(); d.setHours(0, 0, 0, 0);
    if (periodo === "hoy") return d;
    if (periodo === "semana") { const x = new Date(d); x.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return x; }
    if (periodo === "mes") return new Date(d.getFullYear(), d.getMonth(), 1);
    return null;
  })();
  const texto = q.trim().toLowerCase();
  const lista = historial.filter(c => {
    if (desde && (!c.fecha || new Date(c.fecha) < desde)) return false;
    if (estado !== "todas" && c.estado !== estado) return false;
    if (tipo === "carreras" && esCarga(c.vehiculo_pedido)) return false;
    if (tipo === "acarreos" && !esCarga(c.vehiculo_pedido)) return false;
    if (texto && ![c.origen, c.destino, c.cliente_nombre].some(v => (v || "").toLowerCase().includes(texto))) return false;
    return true;
  });
  const fin = lista.filter(c => c.estado === "finalizada");
  const ganado = fin.reduce((s, c) => s + (c.tarifa || c.tarifa_ofrecida || 0), 0);
  const Chips = ({ val, set, opts }) => (
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6, marginBottom: 8 }}>
      {opts.map(([k, t]) => (
        <TouchableOpacity key={k} onPress={() => set(k)}
          style={{ paddingVertical: 6, paddingHorizontal: 11, borderRadius: 16, backgroundColor: val === k ? "#187830" : "#fff", borderWidth: 1, borderColor: val === k ? "#187830" : "#ddd" }}>
          <Text style={{ fontSize: 12.5, fontWeight: "700", color: val === k ? "#fff" : "#555" }}>{t}</Text>
        </TouchableOpacity>
      ))}
    </View>
  );
  return (
    <>
      <Chips val={periodo} set={setPeriodo} opts={[["hoy", "Hoy"], ["semana", "Semana"], ["mes", "Mes"], ["todo", "Todo"]]} />
      <Chips val={estado} set={setEstado} opts={[["todas", "Todas"], ["finalizada", "Finalizadas"], ["cancelada", "Canceladas"]]} />
      <Chips val={tipo} set={setTipo} opts={[["todos", "Todo tipo"], ["carreras", "🚗 Carreras"], ["acarreos", "🚚 Acarreos"]]} />
      <TextInput value={q} onChangeText={setQ} placeholder="🔎 Buscar por lugar o cliente" style={[styles.input, { marginBottom: 10 }]} />
      <View style={{ flexDirection: "row", justifyContent: "space-between", backgroundColor: "#EAF6EC", borderRadius: 10, padding: 10, marginBottom: 10 }}>
        <Text style={{ fontSize: 13, color: "#187830", fontWeight: "700" }}>{lista.length} carreras · {fin.length} finalizadas</Text>
        <Text style={{ fontSize: 13, color: "#187830", fontWeight: "800" }}>${ganado.toLocaleString()}</Text>
      </View>
      {lista.length === 0 ? (
        <Text style={{ color: "#888", textAlign: "center", padding: 20 }}>No hay carreras con esos filtros.</Text>
      ) : lista.map(c => <TarjetaHistorial key={c.id} c={c} esConductor={true} />)}
    </>
  );
}

// ventana de calificacion mutua (1 a 5 estrellas) al terminar la carrera
function ModalEstrellas({ visible, titulo, subtitulo, onEnviar, onCerrar }) {
  const [sel, setSel] = useState(0);
  const [comentario, setComentario] = useState("");
  useEffect(() => { if (visible) { setSel(0); setComentario(""); } }, [visible]);
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onCerrar}>
      <KeyboardAvoidingView style={styles.fondoModal} behavior={Platform.OS === "ios" ? "padding" : "height"}>
        <View style={styles.ventanaModal}>
          <Text style={{ fontSize: 18, fontWeight: "800", color: "#111", textAlign: "center" }}>{titulo}</Text>
          {subtitulo ? <Text style={{ fontSize: 14, color: "#666", textAlign: "center", marginTop: 4 }}>{subtitulo}</Text> : null}
          <View style={{ flexDirection: "row", justifyContent: "center", marginTop: 18, marginBottom: 14 }}>
            {[1, 2, 3, 4, 5].map(n => (
              <TouchableOpacity key={n} onPress={() => setSel(n)} style={{ paddingHorizontal: 5 }}>
                <Text style={{ fontSize: 42, opacity: n <= sel ? 1 : 0.22 }}>⭐</Text>
              </TouchableOpacity>
            ))}
          </View>
          <TextInput value={comentario} onChangeText={setComentario}
            placeholder="Comentario (opcional): ¿cómo estuvo?" style={[styles.input, { minHeight: 46 }]} multiline />
          <TouchableOpacity style={[styles.button, { backgroundColor: sel ? "#187830" : "#bbb", padding: 12 }]} disabled={!sel} onPress={() => onEnviar(sel, comentario.trim())}>
            <Text style={styles.buttonText}>Enviar calificación</Text>
          </TouchableOpacity>
          <TouchableOpacity style={{ padding: 10, marginTop: 2 }} onPress={onCerrar}>
            <Text style={{ textAlign: "center", color: "#888" }}>Ahora no</Text>
          </TouchableOpacity>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

// muestra el promedio de estrellas de un usuario (ej. "⭐ 4.8")
function Estrellas({ valor, size = 13, color = "#B8860B" }) {
  if (valor == null) return null;
  return <Text style={{ fontSize: size, color, fontWeight: "700" }}>⭐ {Number(valor).toFixed(1)}</Text>;
}

// CLIENTE · viajes a OTRA ciudad (expresos por cupos). Se muestra dentro de Pedir
// carrera cuando el cliente toca "A otra ciudad". Publica un viaje (destino, cupos,
// $/cupo, punto de recogida, opcional agendado) y ve las contraofertas para elegir.
function ExpresoCliente({ usuario, municipios, muniActual, gpsRapido }) {
  const [destino, setDestino] = useState("");
  const [pin, setPin] = useState(null);
  const [origenTxt, setOrigenTxt] = useState("");
  const [destinoDet, setDestinoDet] = useState("");
  const [cupos, setCupos] = useState("1");
  const [precio, setPrecio] = useState("");
  const [notas, setNotas] = useState("");
  const [programar, setProgramar] = useState(false);
  const [dia, setDia] = useState(null);
  const [hSel, setHSel] = useState(null);   // hora (0-23) elegida
  const [mSel, setMSel] = useState(null);   // minutos elegidos
  const [calAbierto, setCalAbierto] = useState(false); // calendario para programar
  const [reprogE, setReprogE] = useState(null); // expreso que se esta reprogramando
  const [mapaOpen, setMapaOpen] = useState(false);
  const [pinDest, setPinDest] = useState(null);       // destino EXACTO en el mapa (puerta a puerta)
  const [mapaDestOpen, setMapaDestOpen] = useState(false);
  const [mios, setMios] = useState([]);
  const [ofertas, setOfertas] = useState({});
  const [cargando, setCargando] = useState(false);

  const miMuni = usuario.municipio || (muniActual && muniActual.nombre) || "Orito";
  const otras = (municipios || []).filter(m => m.nombre !== miMuni && m.activo !== "no");
  // si el destino coincide con una ciudad conocida, el mapa del destino abre en su
  // centro; si es texto libre, usa el buscador del mapa para ubicarlo
  const destMuni = (municipios || []).find(m => m.nombre === destino);
  const destCentro = destMuni && destMuni.centro_lat != null ? { lat: destMuni.centro_lat, lon: destMuni.centro_lon } : null;

  const cargarMios = () => {
    fetch(`${API}/expresos/cliente/${usuario.id}`).then(r => r.json())
      .then(d => { if (Array.isArray(d)) setMios(d); }).catch(() => {});
  };
  useEffect(() => { cargarMios(); const t = setInterval(cargarMios, 5000); return () => clearInterval(t); }, []);

  useEffect(() => {
    mios.filter(e => e.estado === "buscando").forEach(e => {
      fetch(`${API}/expresos/${e.id}/ofertas`).then(r => r.json())
        .then(d => { if (Array.isArray(d)) setOfertas(o => ({ ...o, [e.id]: d })); }).catch(() => {});
    });
  }, [mios]);

  const publicar = () => {
    const c = parseInt(cupos, 10) || 0;
    const p = parseInt((precio || "").replace(/\D/g, ""), 10) || 0;
    if (!destino.trim()) return avisar("Falta", "Escribe a dónde vas.");
    if (!pin) return avisar("Falta", "Marca el punto de recogida en el mapa.");
    if (c <= 0) return avisar("Falta", "¿Cuántos cupos?");
    if (p <= 0) return avisar("Falta", "¿Cuánto pagas por cupo?");
    if (programar && (!dia || hSel == null || mSel == null)) return avisar("Falta la fecha", "Elige el día, la hora y los minutos de salida, o cambia a 'Lo antes posible'.");
    const salidaISO = (programar && dia && hSel != null && mSel != null) ? isoLocal(dia, hSel, mSel) : null;
    setCargando(true);
    const params = qs({
      cliente_id: usuario.id, destino_municipio: destino, origen: origenTxt || "Punto marcado",
      cupos: c, precio_por_cupo: p, origen_lat: pin.lat, origen_lon: pin.lon,
      destino_detalle: destinoDet, notas, ...(salidaISO ? { salida: salidaISO } : {}),
      ...(pinDest ? { destino_lat: pinDest.lat, destino_lon: pinDest.lon } : {}),
    });
    userFetch(`${API}/expresos?${params}`, { method: "POST" }).then(async r => {
      const d = await r.json().catch(() => null);
      if (!r.ok) { avisar("No se pudo", (d && d.detail) || `Error ${r.status}`); return; }
      setDestino(""); setPin(null); setPinDest(null); setOrigenTxt(""); setDestinoDet(""); setCupos("1"); setPrecio(""); setNotas(""); setProgramar(false); setDia(null); setHSel(null); setMSel(null);
      avisar("✅ Viaje publicado", "Los conductores de tu ciudad lo verán. Te avisamos cuando alguien lo tome o te proponga precio.");
      cargarMios();
    }).catch(() => avisar("Error", "No hay conexión.")).finally(() => setCargando(false));
  };

  const aceptarOferta = (e, of) => {
    confirmar("Aceptar este precio", `${of.conductor_nombre} por $${of.monto.toLocaleString()}/cupo (total $${(of.monto * e.cupos).toLocaleString()})?`,
      () => userFetch(`${API}/expresos/${e.id}/aceptar-oferta?oferta_id=${of.id}`, { method: "PUT" }).then(async r => {
        const d = await r.json().catch(() => null);
        if (!r.ok) { avisar("No se pudo", (d && d.detail) || `Error ${r.status}`); return; }
        cargarMios();
      }).catch(() => avisar("Error", "No hay conexión.")), "Aceptar");
  };

  const cancelar = (e) => {
    confirmar("Cancelar viaje", "¿Seguro que quieres cancelar este viaje?",
      () => userFetch(`${API}/expresos/${e.id}/estado?estado=cancelado`, { method: "PUT" }).then(cargarMios).catch(() => {}), "Sí");
  };
  // marcar que el viaje YA se hizo (p. ej. se coordinó por fuera): queda finalizado
  const ejecutado = (e) => {
    confirmar("Marcar como ejecutado", "¿Este viaje ya se realizó? Se marcará como finalizado y saldrá de los activos.",
      () => userFetch(`${API}/expresos/${e.id}/estado?estado=finalizado`, { method: "PUT" }).then(cargarMios).catch(() => {}), "Sí, ya se hizo");
  };
  // reprogramar: abre el calendario; al confirmar, pone la nueva fecha y lo reactiva
  const reprogramar = (e) => setReprogE(e);
  const confirmarReprog = (d, h, mm) => {
    const nueva = isoLocal(d, h, mm);
    userFetch(`${API}/expresos/${reprogE.id}/reprogramar?salida=${encodeURIComponent(nueva)}`, { method: "PUT" })
      .then(async r => {
        if (r.ok) { avisar("📅 Reprogramado", "Tu viaje quedó con la nueva fecha y volvió a estar disponible."); cargarMios(); }
        else { const dd = await r.json().catch(() => null); avisar("No se pudo", (dd && dd.detail) || "Intenta de nuevo."); }
      }).catch(() => avisar("Error", "No hay conexión."));
    setReprogE(null);
  };

  const totalCalc = (parseInt(cupos, 10) || 0) * (parseInt((precio || "0").replace(/\D/g, ""), 10) || 0);

  return (
    <>
      <View style={styles.card}>
        <Text style={styles.etiqueta}>🚌 VIAJE A OTRA CIUDAD (EXPRESO)</Text>
        <Text style={styles.ayuda}>Sales de {miMuni}. Di a dónde vas, dónde te recogen, cupos y cuánto pagas por cupo; un conductor lo toma o te propone precio.</Text>
        <Text style={[styles.etiqueta, { marginTop: 10 }]}>¿A DÓNDE VAS? (cualquier ciudad o lugar)</Text>
        <TextInput value={destino} onChangeText={setDestino} placeholder="Ej: Mocoa, Pitalito, Cali, La Hormiga, Neiva..." style={styles.input} />
        {otras.length > 0 && (
          <>
            <Text style={{ fontSize: 11, color: "#999", marginBottom: 5 }}>O toca una ciudad frecuente:</Text>
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
              {otras.map(m => (
                <TouchableOpacity key={m.nombre} style={[styles.chip, destino === m.nombre && styles.chipOn]} onPress={() => setDestino(m.nombre)}>
                  <Text style={[styles.chipTxt, destino === m.nombre && styles.chipTxtOn]}>{m.nombre}</Text>
                </TouchableOpacity>
              ))}
            </View>
          </>
        )}
        <TextInput value={destinoDet} onChangeText={setDestinoDet} placeholder="¿Dónde exactamente te dejan? (dirección/referencia)" style={[styles.input, { marginTop: 10 }]} />
        <TouchableOpacity style={[styles.botonMapa, { marginTop: 4 }, pinDest && styles.botonMapaOk]} onPress={() => setMapaDestOpen(true)}>
          <Text style={{ color: "#187830", fontWeight: "700" }}>{pinDest ? "✓ Destino marcado — cambiar" : "🗺️ Marcar el destino EXACTO en el mapa (puerta a puerta)"}</Text>
        </TouchableOpacity>
        <Text style={styles.ayuda}>Puerta a puerta: usa el buscador del mapa para ubicar la dirección en {destino || "la otra ciudad"} y marca el punto.</Text>
      </View>

      <View style={styles.card}>
        <Text style={styles.etiqueta}>📍 ¿DÓNDE TE RECOGEN? (en {miMuni})</Text>
        <TouchableOpacity style={[styles.botonMapa, pin && styles.botonMapaOk]} onPress={() => setMapaOpen(true)}>
          <Text style={{ color: "#187830", fontWeight: "700" }}>{pin ? "✓ Punto de recogida marcado — cambiar" : "🗺️ Marcar el punto de recogida en el mapa"}</Text>
        </TouchableOpacity>
        {pin ? (
          <Text style={{ fontSize: 12, color: "#187830", fontWeight: "600", marginTop: 2, marginBottom: 4 }}>✓ Punto marcado en el mapa</Text>
        ) : (
          <Text style={styles.ayuda}>Toca para abrir el mapa y marcar dónde te recogen.</Text>
        )}
        <TextInput value={origenTxt} onChangeText={setOrigenTxt} placeholder="Referencia (opcional): terminal, barrio, casa..." style={styles.input} />
      </View>

      <View style={styles.card}>
        <View style={{ flexDirection: "row", gap: 10 }}>
          <View style={{ flex: 1 }}>
            <Text style={styles.etiqueta}>CUPOS</Text>
            <TextInput value={cupos} onChangeText={t => setCupos(t.replace(/\D/g, ""))} keyboardType="number-pad" placeholder="1" style={[styles.input, { marginBottom: 0 }]} />
          </View>
          <View style={{ flex: 1.6 }}>
            <Text style={styles.etiqueta}>PAGAS POR CUPO $</Text>
            <TextInput value={precio} onChangeText={t => setPrecio(t.replace(/\D/g, ""))} keyboardType="number-pad" placeholder="0" style={[styles.input, { marginBottom: 0 }]} />
          </View>
        </View>
        {totalCalc > 0 ? (
          <Text style={{ fontSize: 13.5, color: "#187830", fontWeight: "700", marginTop: 8 }}>Total: ${totalCalc.toLocaleString()} ({cupos} cupo{cupos === "1" ? "" : "s"})</Text>
        ) : null}
      </View>

      <View style={styles.card}>
        <Text style={styles.etiqueta}>¿PARA CUÁNDO?</Text>
        <View style={{ flexDirection: "row", gap: 8 }}>
          <TouchableOpacity style={[styles.opcion, !programar && styles.opcionActiva]} onPress={() => setProgramar(false)}>
            <Text style={[styles.opcionTexto, !programar && styles.opcionTextoActivo]}>Lo antes posible</Text>
          </TouchableOpacity>
          <TouchableOpacity style={[styles.opcion, programar && styles.opcionActiva]} onPress={() => setProgramar(true)}>
            <Text style={[styles.opcionTexto, programar && styles.opcionTextoActivo]}>Programar</Text>
          </TouchableOpacity>
        </View>
        {programar && (
          <>
            <TouchableOpacity
              onPress={() => setCalAbierto(true)}
              style={{ marginTop: 12, borderWidth: 1.5, borderColor: (dia && hSel != null && mSel != null) ? "#187830" : "#F06000", borderRadius: 12, paddingVertical: 14, paddingHorizontal: 16, backgroundColor: (dia && hSel != null && mSel != null) ? "#EAF6EC" : "#FFF6EF", flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
              <Text style={{ color: (dia && hSel != null && mSel != null) ? "#187830" : "#B44700", fontWeight: "800", fontSize: 15 }}>
                {(dia && hSel != null && mSel != null) ? `📅 ${fmtRecogida(isoLocal(dia, hSel, mSel))}` : "📅 Elegir día y hora"}
              </Text>
              <Text style={{ color: (dia && hSel != null && mSel != null) ? "#187830" : "#B44700", fontWeight: "800", fontSize: 15 }}>
                {(dia && hSel != null && mSel != null) ? "Cambiar ›" : "Abrir ›"}
              </Text>
            </TouchableOpacity>
            <Text style={[styles.ayuda, { marginTop: 8 }]}>Abre el calendario y elige el día (puedes ir meses adelante) y la hora exacta de salida.</Text>
            <CalendarioModal
              visible={calAbierto}
              inicial={dia && hSel != null && mSel != null ? { d: dia, h: hSel, m: mSel } : null}
              onConfirmar={(d, h, mm) => { setDia(d); setHSel(h); setMSel(mm); setCalAbierto(false); }}
              onCerrar={() => setCalAbierto(false)}
            />
          </>
        )}
        <TextInput value={notas} onChangeText={setNotas} placeholder="Algo más (equipaje, # de contacto...)" style={[styles.input, { marginTop: 10 }]} />
      </View>

      <TouchableOpacity style={[styles.button, { backgroundColor: "#F06000", marginTop: 4 }]} onPress={publicar} disabled={cargando}>
        {cargando ? <ActivityIndicator color="#fff" /> : <Text style={styles.buttonText}>Publicar viaje</Text>}
      </TouchableOpacity>

      {mios.length > 0 && (
        <View style={{ marginTop: 18 }}>
          <Text style={styles.seccionTitulo}>Tus viajes a otra ciudad</Text>
          {mios.map(e => {
            const ofs = ofertas[e.id] || [];
            return (
              <View key={e.id} style={[styles.card, { marginBottom: 10 }]}>
                <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
                  <Text style={{ fontWeight: "700", fontSize: 15 }}>{e.origen_municipio} → {e.destino_municipio}</Text>
                  <Text style={{ fontSize: 11, color: "#888" }}>{estadoExpreso(e.estado)}</Text>
                </View>
                <Text style={{ fontSize: 12.5, color: "#555", marginTop: 2 }}>{e.cupos} cupo(s) · ${e.precio_por_cupo.toLocaleString()}/cupo</Text>
                <Text style={{ fontSize: 12.5, fontWeight: "700", marginTop: 2, color: e.salida ? "#B85C00" : "#187830" }}>
                  {e.salida ? `🗓️ Sale: ${fmtRecogida(e.salida)}` : "🟢 Lo antes posible"}
                </Text>
                <Text style={{ fontSize: 12.5, color: "#333", marginTop: 2 }}>🟢 Recoge: {e.origen}{e.destino_detalle ? `   ·   🏁 Deja: ${e.destino_detalle}` : ""}</Text>
                {(e.estado === "aceptado" || e.estado === "en_camino") && (
                  <View style={{ backgroundColor: e.estado === "en_camino" ? "#E7F0FF" : "#EAF6EC", borderRadius: 8, padding: 8, marginTop: 6 }}>
                    {e.estado === "en_camino" && <Text style={{ fontSize: 12.5, color: "#1A73E8", fontWeight: "800", marginBottom: 2 }}>🚗 En camino a {e.destino_municipio}</Text>}
                    <Text style={{ fontSize: 12.5, color: "#187830", fontWeight: "700" }}>✅ {e.conductor_nombre} · ${(e.tarifa_cupo || 0).toLocaleString()}/cupo</Text>
                    {e.conductor_telefono ? <Text style={{ fontSize: 12, color: "#187830", marginTop: 2 }}>📞 {e.conductor_telefono}{e.conductor_placa ? ` · ${e.conductor_placa}` : ""}</Text> : null}
                  </View>
                )}
                {/* tracking en vivo: el carro moviendose, una vez inició el recorrido */}
                {e.estado === "en_camino" && e.conductor_lat != null && (
                  <>
                    <View style={{ height: 220, borderRadius: 12, overflow: "hidden", marginTop: 8 }}>
                      <MapaSeguimiento key={"exp-" + e.id}
                        conductor={{ lat: e.conductor_lat, lon: e.conductor_lon }}
                        recogida={e.origen_lat != null ? { lat: e.origen_lat, lon: e.origen_lon } : null}
                        destino={e.destino_lat != null ? { lat: e.destino_lat, lon: e.destino_lon } : null}
                        rutaA="destino" lleno />
                    </View>
                    {e.conductor_ubic_fecha && (Date.now() - new Date(e.conductor_ubic_fecha).getTime()) > 90000 && (
                      <Text style={{ fontSize: 11, color: "#8A5A00", marginTop: 4 }}>Última ubicación {haceCuanto(e.conductor_ubic_fecha)}</Text>
                    )}
                  </>
                )}
                {e.estado === "buscando" && ofs.length > 0 && (
                  <View style={{ marginTop: 8 }}>
                    <Text style={{ fontSize: 12, color: "#666", fontWeight: "700", marginBottom: 4 }}>Precios que te proponen:</Text>
                    {ofs.map(of => (
                      <View key={of.id} style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingVertical: 5 }}>
                        <Text style={{ fontSize: 13, color: "#333" }}>{of.conductor_nombre} · ${of.monto.toLocaleString()}/cupo</Text>
                        <TouchableOpacity style={[styles.button, { backgroundColor: "#187830", paddingVertical: 6, paddingHorizontal: 12 }]} onPress={() => aceptarOferta(e, of)}>
                          <Text style={[styles.buttonText, { fontSize: 12 }]}>Aceptar</Text>
                        </TouchableOpacity>
                      </View>
                    ))}
                  </View>
                )}
                {e.estado === "buscando" && (() => {
                  const vencido = e.salida && new Date(e.salida).getTime() < Date.now();
                  return (
                    <View style={{ marginTop: 10 }}>
                      {vencido && (
                        <Text style={{ fontSize: 12, color: "#B85C00", fontWeight: "800", marginBottom: 6 }}>
                          ⏰ Se pasó la fecha de este viaje. ¿Qué hacemos?
                        </Text>
                      )}
                      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
                        <TouchableOpacity style={[styles.button, { backgroundColor: "#187830", paddingVertical: 9, paddingHorizontal: 14 }]} onPress={() => reprogramar(e)}>
                          <Text style={[styles.buttonText, { fontSize: 13 }]}>📅 Reprogramar</Text>
                        </TouchableOpacity>
                        <TouchableOpacity style={[styles.button, { backgroundColor: "#1C2B22", paddingVertical: 9, paddingHorizontal: 14 }]} onPress={() => ejecutado(e)}>
                          <Text style={[styles.buttonText, { fontSize: 13 }]}>✅ Ejecutado</Text>
                        </TouchableOpacity>
                        <TouchableOpacity style={[styles.button, { backgroundColor: "#fff", borderWidth: 1, borderColor: "#E6BDBD", paddingVertical: 9, paddingHorizontal: 14 }]} onPress={() => cancelar(e)}>
                          <Text style={{ color: "#C0392B", fontWeight: "700", fontSize: 13 }}>✕ Cancelar</Text>
                        </TouchableOpacity>
                      </View>
                    </View>
                  );
                })()}
              </View>
            );
          })}
        </View>
      )}

      {/* calendario para REPROGRAMAR un viaje (reutiliza el mismo componente) */}
      <CalendarioModal
        visible={!!reprogE}
        onConfirmar={confirmarReprog}
        onCerrar={() => setReprogE(null)} />

      <MapaSelector visible={mapaOpen} titulo="Marca dónde te recogen"
        centro={pin || gpsRapido || (muniActual && muniActual.centro_lat ? { lat: muniActual.centro_lat, lon: muniActual.centro_lon } : null)}
        municipio={miMuni}
        onConfirmar={(c) => { setPin({ lat: c.lat, lon: c.lon }); setMapaOpen(false); }}
        onCerrar={() => setMapaOpen(false)} />

      <MapaSelector visible={mapaDestOpen} titulo={`Marca el destino${destino ? ` en ${destino}` : ""}`}
        centro={pinDest || destCentro || pin || gpsRapido || (muniActual && muniActual.centro_lat ? { lat: muniActual.centro_lat, lon: muniActual.centro_lon } : null)}
        municipio={destino || "Colombia"}
        onConfirmar={(c) => { setPinDest({ lat: c.lat, lon: c.lon }); setMapaDestOpen(false); }}
        onCerrar={() => setMapaDestOpen(false)} />
    </>
  );
}

function PedirCarreraScreen({ navigation, route }) {
  const { usuario } = route.params;
  const insets = useSafeAreaInsets();   // para que los modales no queden bajo la barra de estado
  const [carrera, setCarrera] = useState(null);
  const [form, setForm] = useState({ origen: "", origen_detalle: "", destino: "", destino_detalle: "", notas: "" });
  const [vehiculo, setVehiculo] = useState(null);   // sin defecto: el cliente elige
  // desde el inicio el cliente entra por "Pedir carrera" o por "Acarreo" (separados).
  // Sin modo (versiones viejas / otros accesos) se muestran ambos como antes.
  const modoServicio = (route.params && route.params.modo) || null;
  const delModo = (vs) => modoServicio === "acarreo" ? vs.filter(esCarga) : modoServicio === "carrera" ? vs.filter((v) => !esCarga(v)) : vs;
  // detalles del acarreo
  const [tipoCarga, setTipoCarga] = useState(null);
  const [tamanoCarga, setTamanoCarga] = useState(null);
  const [fotosCarga, setFotosCarga] = useState([]);       // URLs ya subidas
  const [subiendoCarga, setSubiendoCarga] = useState(false);
  const [ayudantes, setAyudantes] = useState(0);
  const [pisoO, setPisoO] = useState("");
  const [pisoD, setPisoD] = useState("");
  const [ascO, setAscO] = useState(null);
  const [ascD, setAscD] = useState(null);
  const [recibeNombre, setRecibeNombre] = useState("");
  const [recibeTel, setRecibeTel] = useState("");
  const agregarFotoCarga = async () => {
    if (fotosCarga.length >= 3) { avisar("Máximo 3 fotos", "Con 3 fotos el transportador ya ve bien la carga."); return; }
    const uri = await tomarOElegirFoto();
    if (!uri) return;
    setSubiendoCarga(true);
    const fd = new FormData();
    fd.append("file", { uri, type: "image/jpeg", name: "carga.jpg" });
    userFetch(`${API}/cargas/foto`, { method: "POST", body: fd })
      .then((r) => r.json())
      .then((d) => { setSubiendoCarga(false); if (d && d.url) setFotosCarga((f) => [...f, d.url]); else avisar("Error", (d && d.detail) || "No se pudo subir la foto."); })
      .catch(() => { setSubiendoCarga(false); avisar("Sin conexión", "No se pudo subir la foto. Intenta de nuevo."); });
  };
  const limpiarAcarreo = () => {
    setTipoCarga(null); setTamanoCarga(null); setFotosCarga([]); setAyudantes(0);
    setPisoO(""); setPisoD(""); setAscO(null); setAscD(null); setRecibeNombre(""); setRecibeTel("");
  };
  const [muni, setMuni] = useState(null);           // municipio ACTIVO de esta carrera
  const [municipios, setMunicipios] = useState([]); // todos, para elegir manual
  const [eligiendoMuni, setEligiendoMuni] = useState(false);
  const [origenCoords, setOrigenCoords] = useState(null);
  const [destinoCoords, setDestinoCoords] = useState(null);
  const [estimado, setEstimado] = useState(null);   // {distancia_km, tarifa_sugerida}
  const [mapaAbierto, setMapaAbierto] = useState(null); // "origen" | "destino" | null
  const [oferta, setOferta] = useState("");          // lo que el cliente ofrece pagar
  const [modo, setModo] = useState("local");         // "local" (en la ciudad) | "expreso" (otra ciudad)
  const scrollForm = useRef(null);                   // para subir el campo de oferta sobre el teclado
  // sube CUALQUIER campo por encima del teclado al enfocarlo (no solo la oferta):
  // usa el metodo nativo del ScrollView, que mide el input y lo deja visible.
  // Asi los campos del acarreo (descripcion, detalle) ya no quedan tapados.
  const subirCampo = (ref) => {
    setTimeout(() => {
      const sr = scrollForm.current && scrollForm.current.getScrollResponder && scrollForm.current.getScrollResponder();
      const nodo = ref && ref.current && findNodeHandle(ref.current);
      if (sr && nodo && sr.scrollResponderScrollNativeHandleToKeyboard) {
        sr.scrollResponderScrollNativeHandleToKeyboard(nodo, 120, true);
      }
    }, 80);
  };
  const refCarga = useRef(null);
  const refDestDet = useRef(null);
  const refNotas = useRef(null);
  const [rutaPrevia, setRutaPrevia] = useState(null);   // {km,min} del recorrido en la vista previa
  // SEGURIDAD: comparte el viaje (conductor, placa, ruta + link de mapa) con un
  // familiar por WhatsApp/el medio que elija. Da tranquilidad, como Uber/DiDi.
  const compartirViaje = async () => {
    try {
      const c = carrera || {};
      // limpia emojis/pines al inicio del texto ("📍 Escuela" -> "Escuela")
      const limpio = (s) => (s || "").replace(/^[^A-Za-z0-9ÁÉÍÓÚÑáéíóúñ]+/, "").trim();
      // Al final va un link a la pagina publica /viaje. WhatsApp muestra el LOGO
      // de Tukan en la vista previa (og:image) y al abrirlo hay mapa + datos del
      // conductor, como Uber. Si hay token, el link es EN VIVO (el vehiculo se
      // mueve y cambia el estado); si no, cae al modo estatico (compat).
      let url;
      if (c.id && c.token_viaje) {
        url = `${API}/viaje?${qs({ c: c.id, t: c.token_viaje })}`;
      } else {
        const p = qs({
          con: c.conductor_nombre,
          pla: c.conductor_placa,
          tel: c.conductor_telefono,
          veh: c.conductor_vehiculo,
          o: c.origen ? limpio(c.origen) : undefined,
          d: c.destino ? limpio(c.destino) : undefined,
          dlat: c.destino_lat, dlon: c.destino_lon,
          olat: c.origen_lat, olon: c.origen_lon,
        });
        url = `${API}/viaje?${p}`;
      }
      const lineas = [
        "🚕 *TUKÁN* · Voy en un viaje",
        c.conductor_nombre ? `👤 Conductor: ${c.conductor_nombre}` : null,
        c.conductor_placa ? `🚗 Placa: ${c.conductor_placa}${c.conductor_vehiculo ? " · " + c.conductor_vehiculo : ""}` : null,
        c.conductor_telefono ? `📞 Tel: ${c.conductor_telefono}` : null,
        c.origen ? `🟢 Desde: ${limpio(c.origen)}` : null,
        c.destino ? `🔴 Hacia: ${limpio(c.destino)}` : null,
        "🛡️ Te comparto mi viaje por seguridad. Míralo en vivo aquí:",
        url,
      ].filter(Boolean);
      await Share.share({ message: lineas.join("\n") });
    } catch (_) {}
  };
  // LUGARES GUARDADOS (Casa/Trabajo/favoritos) + destinos recientes, para pedir rapido
  const [guardados, setGuardados] = useState([]);
  const [recientes, setRecientes] = useState([]);
  const cargarGuardados = () => {
    fetch(`${API}/usuarios/${usuario.id}/lugares`).then(r => r.json())
      .then(d => { if (Array.isArray(d)) setGuardados(d); }).catch(() => {});
  };
  useEffect(() => {
    cargarGuardados();
    fetch(`${API}/carreras/cliente/${usuario.id}`).then(r => r.json()).then(d => {
      if (!Array.isArray(d)) return;
      const vistos = new Set(); const out = [];
      for (const c of d) {
        if (c.destino_lat == null || c.destino_lon == null) continue;
        const k = `${Math.round(c.destino_lat * 1000)},${Math.round(c.destino_lon * 1000)}`;
        if (vistos.has(k)) continue; vistos.add(k);
        out.push({ direccion: (c.destino || "").replace(/^🏁 /, ""), lat: c.destino_lat, lon: c.destino_lon });
        if (out.length >= 3) break;
      }
      setRecientes(out);
    }).catch(() => {});
  }, []);
  const usarComoDestino = (l) => {
    if (l.lat == null) return;
    setDestinoCoords({ lat: l.lat, lon: l.lon });
    setForm(f => ({ ...f, destino: l.direccion || l.etiqueta || "Destino guardado" }));
  };
  const guardarDestino = (etiqueta) => {
    if (!destinoCoords) { avisar("Marca el destino", "Primero marca a dónde vas para poder guardarlo."); return; }
    const dir = (form.destino || "").replace(/^🏁 /, "").trim() || etiqueta;
    userFetch(`${API}/usuarios/${usuario.id}/lugares?${qs({ etiqueta, direccion: dir, lat: destinoCoords.lat, lon: destinoCoords.lon })}`, { method: "POST" })
      .then(r => r.json()).then(() => { cargarGuardados(); avisar("Guardado ⭐", `Destino guardado como ${etiqueta}.`); }).catch(() => {});
  };
  const iconoLugar = (et) => { const e = (et || "").toLowerCase(); return e === "casa" ? "🏠" : e === "trabajo" ? "💼" : "⭐"; };
  // REFERIDOS (invita y gana): tu codigo + a cuantos has invitado
  const [verReferidos, setVerReferidos] = useState(false);
  const [referidos, setReferidos] = useState(null);
  const abrirReferidos = () => {
    setVerReferidos(true);
    fetch(`${API}/usuarios/${usuario.id}/referidos`).then(r => r.json())
      .then(d => { if (d && d.codigo) setReferidos(d); }).catch(() => {});
  };
  const compartirCodigo = async () => {
    if (!referidos) return;
    try {
      await Share.share({ message:
        `🚕 ¡Únete a Tukán! Carreras y acarreos, tú pones el precio.\n` +
        `Regístrate con mi código: ${referidos.codigo}\n` +
        `Descárgala aquí 👉 https://orito-app-production.up.railway.app/app` });
    } catch (_) {}
  };
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
  const [porCalificar, setPorCalificar] = useState(null);   // carrera terminada, pendiente de calificar al conductor
  const [verHistorial, setVerHistorial] = useState(false);  // modal con el historial del cliente
  const [historialCli, setHistorialCli] = useState([]);
  const [verMenu, setVerMenu] = useState(false);            // menu tipo perfil (como Yango)
  const [soporteWa, setSoporteWa] = useState("3133714915"); // whatsapp de soporte (configurable en backend)
  useEffect(() => {
    fetch(`${API}/soporte/contacto`).then(r => r.json()).then(d => { if (d && d.whatsapp) setSoporteWa(d.whatsapp); }).catch(() => {});
  }, []);

  const abrirHistorial = () => {
    setVerHistorial(true);
    fetch(`${API}/carreras/cliente/${usuario.id}`).then(r => r.json())
      .then(d => { if (Array.isArray(d)) setHistorialCli(d.filter(c => ["finalizada", "cancelada"].includes(c.estado))); })
      .catch(() => {});
  };
  // agendar recogida (solo trasteos): "lo antes posible" (default) o dia+hora
  const [programar, setProgramar] = useState(false);
  const [progDia, setProgDia] = useState(null);
  const [progHora, setProgHora] = useState(null);   // {h, m}
  const [calAbierto, setCalAbierto] = useState(false); // calendario para agendar acarreo

  const vehiculosAqui = delModo((muni && muni.vehiculos) || []);
  // hora agendada final; solo aplica a carga y cuando el cliente eligio dia+hora
  const recogidaISO = (esCarga(vehiculo) && programar && progDia && progHora)
    ? isoLocal(progDia, progHora.h, progHora.m) : null;

  // fija el municipio activo y ajusta el vehiculo si el actual no aplica alli
  const aplicarMuni = (m) => {
    setMuni(m);
    const vs = delModo(m.vehiculos || []);
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
      municipio: muni.nombre, vehiculo, usuario_id: usuario.id,
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
      // un punto NUEVO en el mapa manda: se resetea el texto (y nombrarPunto lo
      // rellena con el nombre real), para que mapa y texto queden coherentes
      setForm(f => ({ ...f, origen: "📍 Punto marcado en el mapa" }));
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
      // igual que el origen: el punto nuevo manda, texto y mapa coherentes
      setForm(f => ({ ...f, destino: "🏁 Punto marcado en el mapa" }));
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
        const act = d.filter(c => ["buscando", "aceptada", "en_sitio", "en_camino"].includes(c.estado));
        setActivas(act);
        // se conserva la que se esta mirando; si ya termino, pasa a la siguiente
        setCarrera(prev => {
          // si la que miraba acaba de finalizar y no la ha calificado, se le pide
          if (prev && !act.find(c => c.id === prev.id)) {
            const fin = d.find(c => c.id === prev.id);
            if (fin && fin.estado === "finalizada" && !fin.estrellas_conductor) setPorCalificar(fin);
          }
          return (prev && act.find(c => c.id === prev.id)) || act[0] || null;
        });
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

  const pedir = async () => {
    if (!muni) { avisar("Falta el municipio", "Marca donde estas o elige el municipio."); return; }
    // origen y destino SIEMPRE por GPS o pin en el mapa: nunca quedan sin ubicar
    if (!origenCoords) {
      avisar("Falta el origen", "Toca '📍 Usar mi ubicación actual' o marca en el mapa dónde estás.");
      return;
    }
    if (!destinoCoords) {
      avisar("Falta el destino", "Toca '🏁 Marcar a dónde vas en el mapa' para fijar el destino.");
      return;
    }
    if (!vehiculo) { avisar("Falta el vehiculo", "Elige el vehículo que necesitas"); return; }
    // en trasteos, si eligio "programar" pero no completo dia y hora, se avisa
    if (esCarga(vehiculo) && programar && !recogidaISO) {
      avisar("Falta la hora", "Elige el dia y la hora de recogida, o toca 'Lo antes posible'."); return;
    }
    if (esCarga(vehiculo) && !tipoCarga) { avisar("¿Qué vas a mover?", "Elige el tipo de acarreo: trasteo, mercancía, materiales…"); return; }
    if (esCarga(vehiculo) && !tamanoCarga) { avisar("¿Qué tan grande es?", "Elige el tamaño de la carga para que te coticen bien."); return; }
    if (subiendoCarga) { avisar("Un momento", "Se está subiendo una foto, espera a que termine."); return; }
    if (!oferta.trim()) { avisar("Falta tu oferta", "Escribe cuanto ofreces pagar"); return; }
    setCargando(true);
    const datos = {
      cliente_id: usuario.id,
      origen: form.origen.trim() || "Punto marcado en el mapa",
      destino: form.destino.trim() || "Punto marcado en el mapa",
      origen_detalle: form.origen_detalle.trim(), destino_detalle: form.destino_detalle.trim(),
      notas: form.notas.trim(), vehiculo_pedido: vehiculo, municipio: muni.nombre,
    };
    datos.origen_lat = origenCoords.lat; datos.origen_lon = origenCoords.lon;
    datos.destino_lat = destinoCoords.lat; datos.destino_lon = destinoCoords.lon;
    const ofertaNum = parseInt((oferta || "").replace(/\D/g, ""), 10);
    if (ofertaNum) datos.tarifa_ofrecida = ofertaNum;
    if (recogidaISO) datos.recogida = recogidaISO;
    if (esCarga(vehiculo)) {
      Object.assign(datos, { tipo_carga: tipoCarga, tamano_carga: tamanoCarga, ayudantes });
      if (fotosCarga.length) datos.fotos_carga = fotosCarga.join(",");
      if (pisoO.trim()) datos.piso_origen = parseInt(pisoO, 10) || 0;
      if (pisoD.trim()) datos.piso_destino = parseInt(pisoD, 10) || 0;
      if (ascO) datos.ascensor_origen = ascO;
      if (ascD) datos.ascensor_destino = ascD;
      if (recibeNombre.trim()) datos.recibe_nombre = recibeNombre.trim();
      if (recibeTel.trim()) datos.recibe_telefono = recibeTel.trim();
    }
    fetchReintento(`${API}/carreras?${qs(datos)}`, { method: "POST", headers: { "X-User-Token": llaveUsuario || "" } })
      .then(async (r) => {
        setCargando(false);
        const d = await r.json().catch(() => null);
        if (r.status === 401) {   // sesion vencida o app vieja: se manda a entrar de nuevo
          avisar("Vuelve a entrar", "Tu sesion se venció. Ingresa de nuevo con tu telefono y contraseña.");
          navigation.replace("Login"); return;
        }
        if (!r.ok) {
          const msg = (d && d.detail) || `El servidor respondio ${r.status}`;
          // si ya tiene una en curso, en vez de dejarlo sin salida se le lleva a
          // esa carrera (donde puede verla o cancelarla y volver a pedir)
          if (r.status === 400 && /ya tienes/i.test(msg)) {
            avisar("Ya tienes una en curso", msg + "\n\nTe llevamos a ella para que la veas o la canceles.");
            setVerForm(false);
            cargarActiva();
            return;
          }
          avisar("No se pudo pedir", msg);
          return;
        }
        if (!d || !d.id) { avisar("Error", "Respuesta inesperada del servidor."); return; }
        setForm({ origen: "", origen_detalle: "", destino: "", destino_detalle: "", notas: "" });
        setOrigenCoords(null); setDestinoCoords(null); setEstimado(null); setOferta("");
        setProgramar(false); setProgDia(null); setProgHora(null); limpiarAcarreo();
        setCarrera(d); setVerForm(false);   // muestra el seguimiento de la recien pedida
      })
      .catch(() => { setCargando(false); avisar("Sin conexion", "No pudimos enviar tu carrera. Verifica tu internet e intenta de nuevo."); });
  };

  // CANCELACION: buscando = libre; aceptada = solo 1,5 min (el servidor manda
  // cuanto queda). Pasado ese tiempo ya no se cancela desde la app: se habla con
  // el conductor o con soporte (puede aplicar penalidad).
  const MOTIVOS_CANCELAR = ["El conductor tarda mucho", "Me equivoqué de dirección", "Encontré otro transporte",
    "Ya no lo necesito", "El precio no me sirve", "Otro"];
  const [verCancelar, setVerCancelar] = useState(false);
  const [motivoSel, setMotivoSel] = useState(null);
  const [motivoTxt, setMotivoTxt] = useState("");
  const recibidoCancel = useRef({ seg: null, t: 0 });
  const [, setTicCancel] = useState(0);
  useEffect(() => {
    recibidoCancel.current = { seg: carrera ? carrera.segundos_para_cancelar : null, t: Date.now() };
  }, [carrera && carrera.id, carrera && carrera.estado, carrera && carrera.segundos_para_cancelar]);
  const corriendoCancel = !!(carrera && ["aceptada", "en_sitio"].includes(carrera.estado) && carrera.segundos_para_cancelar > 0);
  useEffect(() => {
    if (!corriendoCancel) return;
    const i = setInterval(() => setTicCancel(x => x + 1), 1000);
    return () => clearInterval(i);
  }, [corriendoCancel]);
  const restanteCancel = recibidoCancel.current.seg == null ? null
    : Math.max(0, recibidoCancel.current.seg - Math.floor((Date.now() - recibidoCancel.current.t) / 1000));

  // reputacion del conductor asignado (promedio + comentarios de otros pasajeros)
  const [rep, setRep] = useState(null);
  const [verRep, setVerRep] = useState(false);
  useEffect(() => {
    setRep(null);
    if (!carrera || !carrera.conductor_id) return;
    fetch(`${API}/conductores/${carrera.conductor_id}/reputacion`).then(r => r.json())
      .then(d => { if (d && d.conductor_id) setRep(d); }).catch(() => {});
  }, [carrera && carrera.conductor_id]);

  const cancelar = () => { setMotivoSel(null); setMotivoTxt(""); setVerCancelar(true); };
  const confirmarCancelacion = () => {
    const motivo = motivoSel === "Otro" || !motivoSel ? motivoTxt.trim() : (motivoTxt.trim() ? `${motivoSel} — ${motivoTxt.trim()}` : motivoSel);
    if (!motivo) { avisar("Cuéntanos por qué", "Elige un motivo o escríbelo para poder cancelar."); return; }
    userFetch(`${API}/carreras/${carrera.id}/estado?${qs({ estado: "cancelada", motivo })}`, { method: "PUT" })
      .then(r => r.json().then(d => ({ ok: r.ok, d })))
      .then(({ ok, d }) => {
        setVerCancelar(false);
        if (ok) { setCarrera(null); setContraofertas([]); return; }
        // el servidor manda la ultima palabra (por si el reloj del celular va distinto)
        if (String(d && d.detail || "").startsWith("FUERA_DE_TIEMPO")) {
          recibidoCancel.current = { seg: 0, t: Date.now() }; setTicCancel(x => x + 1);
          avisar("Ya no se puede cancelar", "Pasó el tiempo para cancelar (1,5 min). Comunícate con el conductor o con soporte. Puede aplicar una penalidad.");
        } else avisar("Error", (d && d.detail) || "No se pudo cancelar");
      })
      .catch(() => avisar("Sin conexión", "No se pudo cancelar. Revisa tu internet."));
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

  const modalCalif = (
    <ModalEstrellas
      visible={!!porCalificar}
      titulo="Califica a tu conductor"
      subtitulo={porCalificar ? `¿Cómo estuvo el viaje con ${porCalificar.conductor_nombre || "tu conductor"}?` : ""}
      onEnviar={(estrellas, comentario) => {
        const id = porCalificar && porCalificar.id;
        setPorCalificar(null);
        if (id) userFetch(`${API}/carreras/${id}/calificar?estrellas=${estrellas}${comentario ? `&comentario=${encodeURIComponent(comentario)}` : ""}`, { method: "PUT" }).catch(() => {});
      }}
      onCerrar={() => setPorCalificar(null)}
    />
  );

  // --- ya tiene una solicitud en curso: se le hace seguimiento (salvo que haya
  //     tocado "pedir otro servicio" y este mirando el formulario)
  if (carrera && !verForm) {
    const buscando = carrera.estado === "buscando";
    const tituloEstado = {
      buscando: "Buscando conductor…",
      aceptada: "Tu conductor va en camino",
      en_sitio: "Tu conductor ya llegó",
      en_camino: "En viaje a tu destino",
    }[carrera.estado] || "Tu carrera";
    const yendoARecoger = carrera.estado === "aceptada" || carrera.estado === "en_sitio";
    // mientras viene a recogerte, el punto de referencia es tu ORIGEN;
    // ya con vos a bordo, el DESTINO
    const punto = yendoARecoger
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
        {modalCalif}
        <View style={[styles.header, { backgroundColor: "#187830" }]}>
          <Text style={styles.headerSub}>Carrera #{carrera.id}</Text>
          <Text style={styles.headerTitle}>{tituloEstado}</Text>
        </View>

        {hayMapa && (
          <View style={{ height: 300, backgroundColor: "#e8e8e8" }}>
            <MapaSeguimiento key={carrera.estado}
              conductor={cond}
              vehiculo={carrera.vehiculo_pedido}
              recogida={carrera.origen_lat != null ? { lat: carrera.origen_lat, lon: carrera.origen_lon } : null}
              destino={carrera.destino_lat != null ? { lat: carrera.destino_lat, lon: carrera.destino_lon } : null}
              rutaA={yendoARecoger ? "recogida" : "destino"}
              onInfo={setRutaInfo} lleno />
          </View>
        )}

        <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: insets.bottom + 40 }}>
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
          {!buscando && (() => {
            // barra de progreso limpia: 4 tramos + el nombre del paso actual
            const orden = { aceptada: 0, en_sitio: 1, en_camino: 2, finalizada: 3 };
            const actual = orden[carrera.estado] != null ? orden[carrera.estado] : 0;
            const nombres = ["Aceptada", "Llegó", "En viaje", "Fin"];
            return (
              <View style={{ marginBottom: 12 }}>
                <View style={{ flexDirection: "row", gap: 6 }}>
                  {nombres.map((n, i) => (
                    <View key={n} style={{ flex: 1, height: 5, borderRadius: 3, backgroundColor: i <= actual ? "#187830" : "#DADDD5" }} />
                  ))}
                </View>
                <View style={{ flexDirection: "row", marginTop: 6 }}>
                  {nombres.map((n, i) => (
                    <Text key={n} style={{ flex: 1, fontSize: 11.5, textAlign: "center", fontWeight: i === actual ? "800" : "500", color: i <= actual ? "#187830" : "#9A9A9A" }}>{n}</Text>
                  ))}
                </View>
              </View>
            );
          })()}
          {carrera.estado === "en_sitio" ? (
            <View style={{ backgroundColor: "#E7F0FF", borderRadius: 10, padding: 12, marginBottom: 12, alignItems: "center" }}>
              <Text style={{ fontSize: 15, fontWeight: "800", color: "#1A73E8" }}>📍 Tu conductor ya está en el punto</Text>
              <Text style={{ fontSize: 12, color: "#555", marginTop: 2 }}>Sal a encontrarlo para iniciar el viaje.</Text>
            </View>
          ) : hayMapa && (info || dist != null) && (
            <View style={{ backgroundColor: "#EAF6EC", borderRadius: 10, padding: 10, marginBottom: 12, alignItems: "center" }}>
              <Text style={{ fontSize: 15, fontWeight: "700", color: "#187830" }}>
                🚗 {carrera.estado === "aceptada" ? "Tu conductor está a" : "Faltan"}{" "}
                {info
                  ? `${info.km < 1 ? `${Math.round(info.km * 1000)} m` : `${info.km.toFixed(1)} km`} · ~${Math.max(1, info.min)} min`
                  : `~${dist < 1 ? `${Math.round(dist * 1000)} m` : `${dist.toFixed(1)} km`}`}
              </Text>
              {carrera.conductor_ubic_fecha && (Date.now() - new Date(carrera.conductor_ubic_fecha).getTime()) > 90000 && (
                <Text style={{ fontSize: 11, color: "#8A5A00" }}>ubicación de {haceCuanto(carrera.conductor_ubic_fecha)}</Text>
              )}
            </View>
          )}
          {/* RESUMEN DEL VIAJE: recorrido y tarifa, lo importante para el trato
              (y para decidir cuando llegan contraofertas) */}
          {(() => {
            const kmViaje = carrera.distancia_km != null ? carrera.distancia_km
              : (carrera.origen_lat != null && carrera.destino_lat != null
                  ? kmEntre({ lat: carrera.origen_lat, lon: carrera.origen_lon }, { lat: carrera.destino_lat, lon: carrera.destino_lon })
                  : null);
            const tarifa = carrera.tarifa || carrera.tarifa_ofrecida || carrera.tarifa_sugerida;
            const fmtKm = (k) => (k < 1 ? `${Math.round(k * 1000)} m` : `${k.toFixed(1)} km`);
            return (
              <View style={[styles.card, { marginBottom: 12, padding: 16 }]}>
                <View style={sl.filaRuta}>
                  <View style={[sl.puntoHueco, { marginTop: 5 }]} />
                  <View style={{ flex: 1 }}>
                    <Text style={sl.dir} numberOfLines={2}>{limpiaDir(carrera.origen)}</Text>
                    {carrera.origen_detalle ? <Text style={{ fontSize: 12.5, color: "#8A8A8A" }}>{carrera.origen_detalle}</Text> : null}
                  </View>
                </View>
                <View style={[sl.filaRuta, { marginTop: 10 }]}>
                  <View style={[sl.puntoLleno, { marginTop: 5 }]} />
                  <View style={{ flex: 1 }}>
                    <Text style={sl.dir} numberOfLines={2}>{limpiaDir(carrera.destino)}</Text>
                    {carrera.destino_detalle ? <Text style={{ fontSize: 12.5, color: "#8A8A8A" }}>{carrera.destino_detalle}</Text> : null}
                  </View>
                </View>
                <View style={{ flexDirection: "row", marginTop: 14, paddingTop: 12, borderTopWidth: 1, borderTopColor: "#EEEFEA" }}>
                  <View style={{ flex: 1 }}>
                    <Text style={{ fontSize: 11.5, color: "#8A8A8A", fontWeight: "700" }}>{vehLabel(carrera.vehiculo_pedido).toUpperCase()}</Text>
                    <Text style={{ fontSize: 17, fontWeight: "800", color: "#1D1D1D", marginTop: 2 }}>{kmViaje != null ? `~${fmtKm(kmViaje)}` : "—"}</Text>
                  </View>
                  {tarifa ? (
                    <View style={{ alignItems: "flex-end" }}>
                      <Text style={{ fontSize: 11.5, color: "#8A8A8A", fontWeight: "700" }}>{buscando ? "TU OFERTA" : "PRECIO"}</Text>
                      <Text style={{ fontSize: 22, fontWeight: "800", color: "#187830" }}>${tarifa.toLocaleString()}</Text>
                    </View>
                  ) : null}
                </View>
                {buscando && carrera.tarifa_sugerida && carrera.tarifa_ofrecida && carrera.tarifa_ofrecida < carrera.tarifa_sugerida ? (
                  <Text style={{ fontSize: 12.5, color: "#C0392B", fontWeight: "600", marginTop: 8 }}>
                    Ofreciste menos del sugerido (${carrera.tarifa_sugerida.toLocaleString()}). Puede que tarden más en aceptarla.
                  </Text>
                ) : null}
              </View>
            );
          })()}
          {buscando ? (
            <>
              {contraofertas.length > 0 && (
                <>
                  <Text style={[styles.seccionTitulo, { marginTop: 0 }]}>
                    {contraofertas.length === 1 ? "1 conductor te propone" : `${contraofertas.length} conductores te proponen`}
                  </Text>
                  {contraofertas.map((of) => {
                    // fresca (< 6s): resaltada con su barra de tiempo; luego sigue en la lista
                    const restante = VENTANA_OF - (ahoraOf - (ofRecibidas.current[of.id] || 0));
                    const fresca = restante > 0;
                    const pct = Math.max(0, Math.min(100, (restante / VENTANA_OF) * 100));
                    const nom = (of.conductor_nombre || "Conductor").trim();
                    return (
                    <View key={of.id} style={[styles.card, { marginBottom: 10, padding: 14 }, fresca && { borderWidth: 2, borderColor: "#F06000" }]}>
                      {fresca && <View style={[styles.barraFondo, { marginTop: 0, marginBottom: 10 }]}><View style={[styles.barra, { width: `${pct}%` }]} /></View>}
                      <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
                        {of.conductor_foto ? (
                          <Image source={{ uri: of.conductor_foto }} style={{ width: 52, height: 52, borderRadius: 26, backgroundColor: "#EEE" }} />
                        ) : (
                          <View style={{ width: 52, height: 52, borderRadius: 26, backgroundColor: "#E7F3E9", alignItems: "center", justifyContent: "center" }}>
                            <Text style={{ fontSize: 22, fontWeight: "700", color: "#187830" }}>{nom.charAt(0).toUpperCase()}</Text>
                          </View>
                        )}
                        <View style={{ flex: 1 }}>
                          <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
                            <Text style={{ fontWeight: "800", fontSize: 16, color: "#1D1D1D" }} numberOfLines={1}>{nom.split(" ")[0]}</Text>
                            {of.conductor_fundador === "si" ? <InsigniaFundador /> : null}
                          </View>
                          <Text style={{ fontSize: 13, color: "#555", marginTop: 1 }}>★ {of.conductor_calificacion ? Number(of.conductor_calificacion).toFixed(1) : "Nuevo"}</Text>
                          <Text style={{ fontSize: 12.5, color: "#8A8A8A", marginTop: 1 }} numberOfLines={1}>
                            {[of.conductor_vehiculo || vehLabel(of.conductor_tipo), of.conductor_veh_color, of.conductor_placa].filter(Boolean).join(" · ")}
                          </Text>
                        </View>
                        <Text style={{ fontSize: 24, fontWeight: "800", color: "#1D1D1D" }}>${of.monto.toLocaleString()}</Text>
                      </View>
                      <TouchableOpacity activeOpacity={0.9} style={{ backgroundColor: "#187830", borderRadius: 14, paddingVertical: 13, alignItems: "center", marginTop: 12 }} onPress={() => aceptarContraoferta(of)}>
                        <Text style={{ color: "#fff", fontWeight: "800", fontSize: 15.5 }}>Aceptar por ${of.monto.toLocaleString()}</Text>
                      </TouchableOpacity>
                    </View>
                    );
                  })}
                </>
              )}
              <View style={[styles.card, { alignItems: "center", paddingVertical: 22, marginBottom: 12 }]}>
                <ActivityIndicator size="large" color="#187830" />
                <Text style={{ fontSize: 16.5, fontWeight: "800", color: "#1D1D1D", marginTop: 12, textAlign: "center" }}>Buscando conductores cerca de ti</Text>
                <Text style={{ color: "#7A7A7A", marginTop: 6, textAlign: "center", fontSize: 13.5, lineHeight: 19 }}>
                  {carrera.tarifa_ofrecida
                    ? "Un conductor puede aceptar tu precio o proponerte otro. Las ofertas te aparecen en esta pantalla."
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
                  <View style={{ flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                    <Text style={{ fontSize: 20, fontWeight: "bold", color: "#333" }}>{carrera.conductor_nombre}</Text>
                    <Estrellas valor={carrera.conductor_calificacion} size={14} />
                  </View>
                  {carrera.conductor_fundador === "si" ? <View style={{ marginTop: 4 }}><InsigniaFundador grande /></View> : null}
                  {rep && (
                    <TouchableOpacity onPress={() => setVerRep(true)} style={{ marginTop: 3 }}>
                      <Text style={{ fontSize: 12.5, color: "#1A56B8", fontWeight: "700" }}>
                        {rep.total_calificaciones > 0 ? `${rep.total_calificaciones} calificaciones · ${rep.finalizadas} viajes · ver comentarios ›` : "Conductor nuevo · aún sin calificaciones"}
                      </Text>
                    </TouchableOpacity>
                  )}
                  {(carrera.conductor_vehiculo || carrera.conductor_tipo_vehiculo) ? (
                    <Text style={{ fontSize: 14, color: "#555", marginTop: 2 }}>
                      {/* lidera la MARCA/linea del carro; si el conductor no la puso,
                          cae al tipo (Carro/Moto). El icono ya dice el tipo. */}
                      {vehIcono(carrera.conductor_tipo_vehiculo)} {carrera.conductor_vehiculo || vehLabel(carrera.conductor_tipo_vehiculo)}{carrera.conductor_veh_color ? ` · ${carrera.conductor_veh_color}` : ""}
                    </Text>
                  ) : null}
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
              {/* SEGURIDAD: compartir el viaje con un familiar + SOS */}
              <View style={{ flexDirection: "row", gap: 10, marginTop: 10 }}>
                <TouchableOpacity style={{ flex: 1, backgroundColor: "#EAF1FB", borderRadius: 14, paddingVertical: 13, alignItems: "center" }} onPress={compartirViaje}>
                  <Text style={{ color: "#1A56B8", fontWeight: "800", fontSize: 14 }}>📤 Compartir viaje</Text>
                </TouchableOpacity>
                <TouchableOpacity style={{ flex: 1, backgroundColor: "#FDECEA", borderRadius: 14, paddingVertical: 13, alignItems: "center", borderWidth: 1.5, borderColor: "#F3B4AC" }}
                  onPress={() => confirmar("Emergencias", "¿Llamar al 123 (Policía / emergencias)?", () => llamar("123"), "Llamar 123")}>
                  <Text style={{ color: "#C0392B", fontWeight: "800", fontSize: 14 }}>🆘 SOS 123</Text>
                </TouchableOpacity>
              </View>

              {carrera.conductor_pagos && (
                <View style={{ marginTop: 12, backgroundColor: "#EAF6EC", borderRadius: 10, padding: 12 }}>
                  <Text style={{ fontSize: 12, color: "#666", marginBottom: 6, fontWeight: "600" }}>CÓMO PAGARLE</Text>
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

          {/* extras del viaje (solo si hay algo que el resumen de arriba no muestra) */}
          {(carrera.recogida || carrera.zona === "rural" || esCarga(carrera.vehiculo_pedido) || carrera.entrega_foto || carrera.entregada_en) ? (
          <View style={styles.card}>
            {carrera.recogida && (
              <View style={{ backgroundColor: "#FFF7E6", borderRadius: 10, paddingVertical: 8, paddingHorizontal: 10, alignSelf: "flex-start" }}>
                <Text style={{ fontSize: 13.5, color: "#8A5A00", fontWeight: "700" }}>Recogida programada: {fmtRecogida(carrera.recogida)}</Text>
              </View>
            )}
            {carrera.zona === "rural" && (
              <View style={styles.avisoRural}><Text style={styles.avisoRuralTexto}>🌄 Carrera fuera del casco urbano</Text></View>
            )}
            <DetalleAcarreo c={carrera} />
            <PruebaEntrega c={carrera} />
          </View>
          ) : null}

          {carrera.estado === "buscando" || (carrera.estado === "aceptada" && (restanteCancel == null || restanteCancel > 0)) ? (
            <>
              <TouchableOpacity style={[styles.button, { backgroundColor: "#fff", borderWidth: 1, borderColor: "#ddd", marginTop: 16 }]} onPress={cancelar}>
                <Text style={{ color: "#C0392B", fontWeight: "600" }}>
                  Cancelar carrera{restanteCancel != null && carrera.estado !== "buscando" ? ` · ${Math.floor(restanteCancel / 60)}:${String(restanteCancel % 60).padStart(2, "0")}` : ""}
                </Text>
              </TouchableOpacity>
              {restanteCancel != null && carrera.estado !== "buscando" && (
                <Text style={{ textAlign: "center", color: "#999", fontSize: 12, marginTop: 6 }}>
                  Tienes 1,5 min para cancelar sin problema. Después ya no se puede desde la app.
                </Text>
              )}
            </>
          ) : ["aceptada", "en_sitio"].includes(carrera.estado) ? (
            // se le paso el tiempo: ya no cancela desde la app; habla con el conductor o soporte
            <View style={{ backgroundColor: "#FFF4E0", borderRadius: 12, padding: 14, marginTop: 16 }}>
              <Text style={{ fontSize: 14, fontWeight: "800", color: "#8A5A00" }}>{carrera.estado === "en_sitio" ? "📍 Tu conductor ya llegó: ya no se puede cancelar" : "⏱️ Ya pasó el tiempo para cancelar"}</Text>
              <Text style={{ fontSize: 12.5, color: "#8A5A00", marginTop: 4, lineHeight: 18 }}>
                {carrera.estado === "en_sitio" ? "Te está esperando en el punto de recogida." : "El conductor ya va en camino."} Si de verdad no puedes tomar el viaje, avísale o escríbele a soporte. Puede aplicar una penalidad por cancelar tarde.
              </Text>
              <View style={{ flexDirection: "row", gap: 8, marginTop: 10 }}>
                <TouchableOpacity style={[styles.button, { flex: 1, backgroundColor: "#25D366", padding: 10 }]} onPress={() => whatsapp(carrera.conductor_telefono)}>
                  <Text style={[styles.buttonText, { fontSize: 13 }]}>💬 Conductor</Text>
                </TouchableOpacity>
                <TouchableOpacity style={[styles.button, { flex: 1, backgroundColor: "#187830", padding: 10 }]} onPress={() => soporteWhatsApp("3133714915", usuario)}>
                  <Text style={[styles.buttonText, { fontSize: 13 }]}>🛟 Soporte</Text>
                </TouchableOpacity>
              </View>
            </View>
          ) : (
            <Text style={{ textAlign: "center", color: "#888", fontSize: 13, marginTop: 16 }}>
              El viaje esta en curso y ya no se puede cancelar.{"\n"}Si hay un problema, llama al conductor.
            </Text>
          )}

          {/* motivo de la cancelacion: rapido (chips) + abierto (texto) */}
          <Modal visible={verCancelar} transparent animationType="slide" onRequestClose={() => setVerCancelar(false)}>
            <View style={{ flex: 1, backgroundColor: "rgba(0,0,0,0.45)", justifyContent: "flex-end" }}>
              <View style={{ backgroundColor: "#fff", borderTopLeftRadius: 22, borderTopRightRadius: 22, padding: 20, paddingBottom: 28 }}>
                <Text style={{ fontSize: 19, fontWeight: "900", color: "#1C2B22" }}>¿Por qué cancelas?</Text>
                <Text style={{ fontSize: 12.5, color: "#888", marginTop: 3 }}>Nos ayuda a mejorar el servicio.</Text>
                <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 14 }}>
                  {MOTIVOS_CANCELAR.map(m => (
                    <TouchableOpacity key={m} onPress={() => setMotivoSel(m)}
                      style={{ paddingVertical: 8, paddingHorizontal: 12, borderRadius: 18, borderWidth: 1.5,
                        borderColor: motivoSel === m ? "#C0392B" : "#ddd", backgroundColor: motivoSel === m ? "#FDECEA" : "#fff" }}>
                      <Text style={{ fontSize: 13, color: motivoSel === m ? "#C0392B" : "#555", fontWeight: "600" }}>{m}</Text>
                    </TouchableOpacity>
                  ))}
                </View>
                <TextInput value={motivoTxt} onChangeText={setMotivoTxt} maxLength={300} multiline
                  placeholder={motivoSel === "Otro" ? "Cuéntanos qué pasó" : "Algo más que quieras contarnos (opcional)"}
                  style={[styles.input, { marginTop: 12, minHeight: 60, textAlignVertical: "top" }]} />
                <TouchableOpacity style={[styles.button, { backgroundColor: "#C0392B", marginTop: 4 }]} onPress={confirmarCancelacion}>
                  <Text style={styles.buttonText}>Cancelar carrera</Text>
                </TouchableOpacity>
                <TouchableOpacity style={{ padding: 12 }} onPress={() => setVerCancelar(false)}>
                  <Text style={{ textAlign: "center", color: "#888", fontWeight: "600" }}>Volver</Text>
                </TouchableOpacity>
              </View>
            </View>
          </Modal>

          {/* REPUTACION del conductor: promedio + comentarios de otros pasajeros */}
          <Modal visible={verRep} transparent animationType="slide" onRequestClose={() => setVerRep(false)}>
            <View style={{ flex: 1, backgroundColor: "rgba(0,0,0,0.45)", justifyContent: "flex-end" }}>
              <View style={{ backgroundColor: "#fff", borderTopLeftRadius: 22, borderTopRightRadius: 22, padding: 20, paddingBottom: 28, maxHeight: "80%" }}>
                <Text style={{ fontSize: 19, fontWeight: "900", color: "#1C2B22" }}>{rep ? rep.nombre : "Conductor"}</Text>
                {rep ? (
                  <>
                    <Text style={{ fontSize: 13, color: "#666", marginTop: 4 }}>
                      ⭐ {rep.calificacion != null ? Number(rep.calificacion).toFixed(1) : "—"} · {rep.total_calificaciones} calificaciones · {rep.finalizadas} viajes
                    </Text>
                    <ScrollView style={{ marginTop: 12 }}>
                      {rep.comentarios.length === 0 ? (
                        <Text style={{ color: "#999", fontSize: 13 }}>Aún no tiene comentarios.</Text>
                      ) : rep.comentarios.map((cm, i) => (
                        <View key={i} style={{ borderTopWidth: i ? 1 : 0, borderTopColor: "#eee", paddingVertical: 10 }}>
                          <Text style={{ fontSize: 13, color: "#B8860B", fontWeight: "700" }}>{"⭐".repeat(cm.estrellas)}</Text>
                          <Text style={{ fontSize: 14, color: "#333", marginTop: 2 }}>{cm.comentario}</Text>
                        </View>
                      ))}
                    </ScrollView>
                  </>
                ) : <ActivityIndicator color="#187830" style={{ marginTop: 16 }} />}
                <TouchableOpacity style={{ padding: 12, marginTop: 6 }} onPress={() => setVerRep(false)}>
                  <Text style={{ textAlign: "center", color: "#888", fontWeight: "600" }}>Cerrar</Text>
                </TouchableOpacity>
              </View>
            </View>
          </Modal>
        </ScrollView>
      </SafeAreaView>
    );
  }

  // --- formulario para pedir
  return (
    <SafeAreaView style={styles.container}>
      {modalCalif}
      <View style={{ backgroundColor: "#187830", paddingTop: insets.top + 10, paddingBottom: 16, paddingHorizontal: 14, flexDirection: "row", alignItems: "center", gap: 11,
        shadowColor: "#0C2C1B", shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.18, shadowRadius: 10, elevation: 5 }}>
        <TouchableOpacity onPress={() => navigation.goBack()} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
          style={{ width: 38, height: 38, borderRadius: 19, backgroundColor: "rgba(255,255,255,0.15)", alignItems: "center", justifyContent: "center" }}>
          <Text style={{ color: "#fff", fontSize: 24, marginTop: -3 }}>‹</Text>
        </TouchableOpacity>
        <Image source={require("./assets/icon.png")} style={{ width: 40, height: 40, borderRadius: 12 }} />
        <View style={{ flex: 1 }}>
          <Text style={{ color: "rgba(255,255,255,0.8)", fontSize: 12, fontWeight: "600" }}>{muni ? `Transporte en ${muni.nombre}` : "Movilidad y acarreos"}</Text>
          <Text style={{ color: "#fff", fontSize: 22, fontWeight: "800", letterSpacing: -0.3, marginTop: 1 }}>{modoServicio === "acarreo" ? "Pedir acarreo" : "Pedir carrera"}</Text>
        </View>
        <TouchableOpacity onPress={() => setVerMenu(true)}
          style={{ width: 40, height: 40, borderRadius: 20, backgroundColor: "rgba(255,255,255,0.15)", alignItems: "center", justifyContent: "center" }}>
          <Text style={{ color: "#fff", fontSize: 21 }}>☰</Text>
        </TouchableOpacity>
      </View>

      {/* menu tipo perfil (referencia Yango): historial, soporte, configuracion */}
      <Modal visible={verMenu} animationType="slide" onRequestClose={() => setVerMenu(false)}>
        <SafeAreaView style={{ flex: 1, backgroundColor: "#fff" }}>
          <View style={{ paddingTop: insets.top + 10, paddingBottom: 6, paddingHorizontal: 14 }}>
            <TouchableOpacity onPress={() => setVerMenu(false)} style={{ padding: 4, alignSelf: "flex-start" }}><Text style={{ fontSize: 26 }}>←</Text></TouchableOpacity>
          </View>
          <View style={{ alignItems: "center", marginTop: 4 }}>
            <View style={{ width: 96, height: 96, borderRadius: 48, backgroundColor: "#E7F3E9", alignItems: "center", justifyContent: "center" }}>
              <Text style={{ fontSize: 44 }}>👤</Text>
            </View>
            <Text style={{ fontSize: 22, fontWeight: "800", marginTop: 10, color: "#222" }}>{usuario.nombre || "Tú"}</Text>
            <Text style={{ fontSize: 14, color: "#888", marginTop: 2 }}>{usuario.telefono}</Text>
          </View>
          <View style={{ flexDirection: "row", flexWrap: "wrap", justifyContent: "space-around", marginTop: 26, paddingHorizontal: 10 }}>
            {[["🕘", "Historial", () => { setVerMenu(false); setTimeout(abrirHistorial, 260); }],
              ["🎁", "Invita", () => { setVerMenu(false); setTimeout(abrirReferidos, 260); }],
              ["💬", "Soporte", () => { setVerMenu(false); soporteWhatsApp(soporteWa, usuario); }],
              ["⚙️", "Ajustes", () => { setVerMenu(false); navigation.navigate("Configuracion", { usuario }); }]].map(([ic, lbl, fn]) => (
              <TouchableOpacity key={lbl} style={{ alignItems: "center", width: 80 }} onPress={fn}>
                <View style={{ width: 60, height: 60, borderRadius: 30, backgroundColor: "#F1F1F1", alignItems: "center", justifyContent: "center" }}>
                  <Text style={{ fontSize: 26 }}>{ic}</Text>
                </View>
                <Text style={{ fontSize: 12, color: "#333", marginTop: 7, textAlign: "center", fontWeight: "600" }}>{lbl}</Text>
              </TouchableOpacity>
            ))}
          </View>
        </SafeAreaView>
      </Modal>

      {/* INVITA Y GANA: código de referido + compartir + cuántos has invitado */}
      <Modal visible={verReferidos} transparent animationType="slide" onRequestClose={() => setVerReferidos(false)}>
        <View style={{ flex: 1, backgroundColor: "rgba(0,0,0,0.45)", justifyContent: "flex-end" }}>
          <View style={{ backgroundColor: "#fff", borderTopLeftRadius: 22, borderTopRightRadius: 22, padding: 22, paddingBottom: 28 }}>
            <Text style={{ fontSize: 22, fontWeight: "900", color: "#1C2B22" }}>🎁 Invita y gana</Text>
            <Text style={{ fontSize: 14, color: "#777", marginTop: 4 }}>Comparte tu código. Cuando <Text style={{ fontWeight: "800", color: "#F06000" }}>10 invitados pidan carrera</Text>, ¡la tuya va gratis! 🎉</Text>
            <View style={{ backgroundColor: "#EAF6EC", borderRadius: 14, padding: 18, marginTop: 16, alignItems: "center" }}>
              <Text style={{ fontSize: 11, color: "#7A927F", fontWeight: "800", letterSpacing: 1 }}>TU CÓDIGO</Text>
              <Text style={{ fontSize: 30, fontWeight: "900", color: "#187830", letterSpacing: 2, marginTop: 4 }}>{referidos ? referidos.codigo : "…"}</Text>
            </View>
            {/* progreso al premio: invitados que YA pidieron al menos una carrera */}
            {(() => {
              const meta = (referidos && referidos.meta) || 10;
              const hechos = (referidos && referidos.con_carrera) || 0;
              const listo = !!(referidos && referidos.premio_listo);
              const pct = Math.min(100, Math.round((hechos / meta) * 100));
              return (
                <View style={{ marginTop: 18 }}>
                  <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "flex-end", marginBottom: 6 }}>
                    <Text style={{ fontSize: 13, color: "#555", fontWeight: "600" }}>Ya pidieron carrera</Text>
                    <Text style={{ fontSize: 18, fontWeight: "900", color: "#F06000" }}>{hechos}<Text style={{ fontSize: 13, color: "#999" }}> / {meta}</Text></Text>
                  </View>
                  <View style={{ height: 10, borderRadius: 6, backgroundColor: "#EDEDED", overflow: "hidden" }}>
                    <View style={{ width: `${pct}%`, height: 10, backgroundColor: listo ? "#2E9E49" : "#F06000" }} />
                  </View>
                  <Text style={{ fontSize: 12.5, color: listo ? "#2E9E49" : "#999", marginTop: 8, fontWeight: listo ? "800" : "500", textAlign: "center" }}>
                    {listo ? "🎉 ¡Lo lograste! Tu próxima carrera va gratis." : `Te faltan ${Math.max(0, meta - hechos)} para tu carrera gratis`}
                  </Text>
                  <Text style={{ fontSize: 11.5, color: "#aaa", marginTop: 4, textAlign: "center" }}>{referidos ? referidos.total : 0} invitados en total</Text>
                </View>
              );
            })()}
            <TouchableOpacity style={[styles.button, { backgroundColor: "#25D366", marginTop: 18 }]} onPress={compartirCodigo}>
              <Text style={styles.buttonText}>📤 Compartir mi código</Text>
            </TouchableOpacity>
            <TouchableOpacity style={{ padding: 12, marginTop: 2 }} onPress={() => setVerReferidos(false)}>
              <Text style={{ textAlign: "center", color: "#888", fontWeight: "600" }}>Cerrar</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      <Modal visible={verHistorial} animationType="slide" onRequestClose={() => setVerHistorial(false)}>
        <SafeAreaView style={{ flex: 1, backgroundColor: "#F4F5F1" }}>
          <View style={{ paddingTop: insets.top + 12, paddingBottom: 14, paddingHorizontal: 14, flexDirection: "row", alignItems: "center", gap: 12, backgroundColor: "#187830" }}>
            <TouchableOpacity onPress={() => setVerHistorial(false)} style={{ padding: 4 }}><Text style={{ fontSize: 24, color: "#fff" }}>←</Text></TouchableOpacity>
            <Text style={{ fontSize: 17, fontWeight: "700", color: "#fff" }}>Tus carreras</Text>
          </View>
          <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: insets.bottom + 40 }}>
            {historialCli.length === 0 ? (
              <Text style={{ color: "#888", textAlign: "center", padding: 30 }}>Aún no tienes carreras terminadas.{"\n"}Aquí quedará tu historial.</Text>
            ) : historialCli.map(c => <TarjetaHistorial key={c.id} c={c} esConductor={false} />)}
          </ScrollView>
        </SafeAreaView>
      </Modal>

      <KeyboardAvoidingView style={{ flex: 1 }} behavior="padding">
      <ScrollView ref={scrollForm} contentContainerStyle={{ padding: 16, paddingBottom: 160 }} keyboardShouldPersistTaps="handled">
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
        {/* switch: pedir EN la ciudad, o un viaje a OTRA ciudad (expreso por cupos) */}
        <View style={{ flexDirection: "row", backgroundColor: "#E9EBE5", borderRadius: 14, padding: 5, marginBottom: 16 }}>
          {[["local", "🚕 En la ciudad"], ["expreso", "🚌 A otra ciudad"]].map(([mm, lbl]) => {
            const on = modo === mm;
            return (
              <TouchableOpacity key={mm} activeOpacity={0.85}
                style={{ flex: 1, paddingVertical: 11, borderRadius: 11, alignItems: "center", backgroundColor: on ? "#fff" : "transparent",
                  shadowColor: "#0C2C1B", shadowOpacity: on ? 0.12 : 0, shadowRadius: 8, shadowOffset: { width: 0, height: 3 }, elevation: on ? 2 : 0 }}
                onPress={() => setModo(mm)}>
                <Text style={{ fontSize: 13.5, fontWeight: on ? "800" : "600", color: on ? "#187830" : "#9A938A" }}>{lbl}</Text>
              </TouchableOpacity>
            );
          })}
        </View>

        {modo === "expreso" ? (
          <ExpresoCliente usuario={usuario} municipios={municipios} muniActual={muni} gpsRapido={gpsRapido} />
        ) : (<>
        {/* ===== TU VIAJE: recogida + destino en una sola tarjeta con riel ===== */}
        <View style={styles.card}>
          <Text style={styles.etiqueta}>TU VIAJE</Text>

          {/* accesos rápidos: Casa/Trabajo/favoritos + destinos recientes (pedir en 2 toques).
              Los RECIENTES se filtran a los de la ciudad actual (≤40 km): así en Orito no
              aparecen destinos de Cali de pruebas pasadas. */}
          {(() => {
            const ref = origenCoords
              || (muni && muni.centro_lat != null ? { lat: muni.centro_lat, lon: muni.centro_lon } : null)
              || gpsRapido || null;
            const recs = ref ? recientes.filter(l => { const d = kmEntre(ref, l); return d != null && d <= 40; }) : [];
            if (guardados.length === 0 && recs.length === 0) return null;
            return (
              <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: 12 }} keyboardShouldPersistTaps="handled">
                <View style={{ flexDirection: "row", gap: 8 }}>
                  {guardados.map(l => (
                    <TouchableOpacity key={"g" + l.id} onPress={() => usarComoDestino(l)}
                      style={{ flexDirection: "row", alignItems: "center", gap: 6, backgroundColor: "#EAF6EC", borderRadius: 20, paddingVertical: 9, paddingHorizontal: 14 }}>
                      <Text style={{ fontSize: 15 }}>{iconoLugar(l.etiqueta)}</Text>
                      <Text style={{ color: "#187830", fontWeight: "700", fontSize: 13 }}>{l.etiqueta}</Text>
                    </TouchableOpacity>
                  ))}
                  {recs.map((l, i) => (
                    <TouchableOpacity key={"r" + i} onPress={() => usarComoDestino(l)}
                      style={{ flexDirection: "row", alignItems: "center", gap: 6, backgroundColor: "#F7F8F5", borderWidth: 1, borderColor: "#E6E8E2", borderRadius: 20, paddingVertical: 9, paddingHorizontal: 14 }}>
                      <Text style={{ fontSize: 14 }}>🕘</Text>
                      <Text numberOfLines={1} style={{ color: "#555", fontWeight: "600", fontSize: 13, maxWidth: 150 }}>{l.direccion || "Reciente"}</Text>
                    </TouchableOpacity>
                  ))}
                </View>
              </ScrollView>
            );
          })()}

          {/* riel de puntos (recogida 🟢 -> destino 🟥). Cada fila abre el mapa. */}
          <View style={{ flexDirection: "row", backgroundColor: "#F7F8F5", borderRadius: 14, borderWidth: 1, borderColor: "#E9EBE5", paddingLeft: 14, paddingRight: 12 }}>
            <View style={{ width: 16, alignItems: "center", paddingVertical: 20 }}>
              <View style={{ width: 13, height: 13, borderRadius: 7, backgroundColor: "#187830", borderWidth: 3, borderColor: "#C7E6CF" }} />
              <View style={{ width: 2, flex: 1, backgroundColor: "#DADDD5", marginVertical: 4 }} />
              <View style={{ width: 13, height: 13, borderRadius: 3, backgroundColor: "#F06000", borderWidth: 3, borderColor: "#FAD6B8" }} />
            </View>
            <View style={{ flex: 1, marginLeft: 10 }}>
              <TouchableOpacity onPress={() => setMapaAbierto("origen")} activeOpacity={0.6} style={{ paddingVertical: 15, borderBottomWidth: 1, borderBottomColor: "#E9EBE5" }}>
                <Text style={{ fontSize: 10.5, color: "#9A948A", fontWeight: "800", letterSpacing: 0.8 }}>RECOGIDA</Text>
                <Text numberOfLines={1} style={{ fontSize: 15.5, fontWeight: "700", marginTop: 2, color: origenCoords ? "#1C2B22" : "#B9B3A6" }}>
                  {origenCoords ? (limpiaDir(form.origen) || "Punto marcado en el mapa") : "Marca dónde estás"}
                </Text>
              </TouchableOpacity>
              <TouchableOpacity onPress={() => setMapaAbierto("destino")} activeOpacity={0.6} style={{ paddingVertical: 15 }}>
                <Text style={{ fontSize: 10.5, color: "#9A948A", fontWeight: "800", letterSpacing: 0.8 }}>DESTINO</Text>
                <Text numberOfLines={1} style={{ fontSize: 15.5, fontWeight: "700", marginTop: 2, color: destinoCoords ? "#1C2B22" : "#B9B3A6" }}>
                  {destinoCoords ? (limpiaDir(form.destino) || "Punto marcado en el mapa") : "¿A dónde vas?"}
                </Text>
              </TouchableOpacity>
            </View>
          </View>

          {/* guardar el destino actual como Casa / Trabajo (para la próxima) */}
          {destinoCoords && (
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8, marginTop: 10 }}>
              <Text style={{ fontSize: 12, color: "#999", fontWeight: "600" }}>Guardar destino:</Text>
              <TouchableOpacity onPress={() => guardarDestino("Casa")} style={{ backgroundColor: "#F1F8F1", borderRadius: 16, paddingVertical: 6, paddingHorizontal: 12 }}>
                <Text style={{ color: "#187830", fontWeight: "700", fontSize: 12 }}>🏠 Casa</Text>
              </TouchableOpacity>
              <TouchableOpacity onPress={() => guardarDestino("Trabajo")} style={{ backgroundColor: "#F1F8F1", borderRadius: 16, paddingVertical: 6, paddingHorizontal: 12 }}>
                <Text style={{ color: "#187830", fontWeight: "700", fontSize: 12 }}>💼 Trabajo</Text>
              </TouchableOpacity>
            </View>
          )}

          {/* acciones rápidas de recogida: GPS o mapa */}
          <View style={{ flexDirection: "row", gap: 8, marginTop: 12 }}>
            <TouchableOpacity onPress={usarUbicacionActual} disabled={buscandoGps} activeOpacity={0.85}
              style={{ flex: 1.25, backgroundColor: "#187830", borderRadius: 12, paddingVertical: 13, alignItems: "center", justifyContent: "center",
                shadowColor: "#187830", shadowOffset: { width: 0, height: 5 }, shadowOpacity: 0.22, shadowRadius: 9, elevation: 3 }}>
              {buscandoGps ? <ActivityIndicator color="#fff" /> : <Text style={{ color: "#fff", fontWeight: "800", fontSize: 13.5 }}>📍 Mi ubicación</Text>}
            </TouchableOpacity>
            <TouchableOpacity onPress={() => setMapaAbierto("origen")} activeOpacity={0.85}
              style={{ flex: 1, backgroundColor: "#F1F8F1", borderWidth: 1.5, borderColor: "#BFE0C8", borderRadius: 12, paddingVertical: 13, alignItems: "center", justifyContent: "center" }}>
              <Text style={{ color: "#187830", fontWeight: "700", fontSize: 13.5 }}>🗺️ En el mapa</Text>
            </TouchableOpacity>
          </View>

          {/* municipio detectado o a elegir manual */}
          {muni ? (
            <TouchableOpacity style={[styles.muniBanner, { marginTop: 12, marginBottom: 0 }]} onPress={() => setEligiendoMuni(true)}>
              <Text style={{ fontSize: 13, color: "#187830", fontWeight: "700" }}>📌 Estás en {muni.nombre}</Text>
              <Text style={{ fontSize: 12, color: "#888" }}>cambiar ›</Text>
            </TouchableOpacity>
          ) : (
            <TouchableOpacity style={[styles.muniBanner, { backgroundColor: "#FFF4E0", marginTop: 12, marginBottom: 0 }]} onPress={() => setEligiendoMuni(true)}>
              <Text style={{ fontSize: 13, color: "#8A5A00", fontWeight: "700" }}>¿En qué municipio estás?</Text>
              <Text style={{ fontSize: 12, color: "#8A5A00" }}>elegir ›</Text>
            </TouchableOpacity>
          )}
          {eligiendoMuni && (
            <View style={{ marginTop: 10 }}>
              {Object.entries(
                municipios.reduce((acc, m) => {
                  const d = m.departamento || "Otros";
                  (acc[d] = acc[d] || []).push(m);
                  return acc;
                }, {})
              )
                .sort((a, b) => a[0].localeCompare(b[0]))
                .map(([depto, lista]) => (
                  <View key={depto} style={{ marginBottom: 10 }}>
                    <Text style={{ fontSize: 10.5, color: "#9a9a9a", fontWeight: "800", letterSpacing: 0.5, marginBottom: 5, textTransform: "uppercase" }}>{depto}</Text>
                    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
                      {lista
                        .slice()
                        .sort((a, b) => a.nombre.localeCompare(b.nombre))
                        .map(m => {
                          const activa = muni && muni.nombre === m.nombre;
                          return (
                            <TouchableOpacity key={m.nombre}
                              style={[styles.chip, activa && styles.chipOn]}
                              onPress={() => { aplicarMuni(m); setEligiendoMuni(false); }}>
                              <Text style={[styles.chipTxt, activa && styles.chipTxtOn]}>{m.nombre}</Text>
                            </TouchableOpacity>
                          );
                        })}
                    </View>
                  </View>
                ))}
            </View>
          )}

          {/* UNA sola nota opcional para el conductor. (En acarreos la nota es la
              "Descripcion de la carga", que va en su propia tarjeta mas abajo, por
              eso aqui solo aparece cuando NO es carga.) */}
          {!esCarga(vehiculo) && (
            <TextInput
              ref={refNotas}
              onFocus={() => subirCampo(refNotas)}
              value={form.notas}
              onChangeText={(t) => setForm({ ...form, notas: t })}
              placeholder="Indicaciones para el conductor (opcional)"
              style={[styles.input, { marginTop: 12, marginBottom: 0 }]}
              multiline
            />
          )}
        </View>

        {/* ===== VISTA PREVIA DEL RECORRIDO: aparece al tener recogida + destino ===== */}
        {origenCoords && destinoCoords && (
          <View style={styles.card}>
            <Text style={styles.etiqueta}>RECORRIDO</Text>
            <View style={{ height: 340, borderRadius: 14, overflow: "hidden", marginBottom: 12 }}>
              <MapaSeguimiento recogida={origenCoords} destino={destinoCoords} preview lleno onInfo={setRutaPrevia} />
            </View>
            <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", backgroundColor: "#FFF6EF", borderRadius: 12, padding: 12 }}>
              <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
                <Text style={{ fontSize: 22 }}>🛣️</Text>
                <View>
                  <Text style={{ fontSize: 10.5, color: "#B08A5A", fontWeight: "800", letterSpacing: 0.5 }}>DISTANCIA DEL VIAJE</Text>
                  <Text style={{ fontSize: 17, fontWeight: "800", color: "#B85C00", marginTop: 1 }}>
                    {rutaPrevia ? `~${rutaPrevia.km.toFixed(1)} km` : (estimado && estimado.distancia_km ? `~${estimado.distancia_km} km` : "Calculando…")}
                  </Text>
                </View>
              </View>
              {rutaPrevia && rutaPrevia.min ? (
                <View style={{ alignItems: "flex-end" }}>
                  <Text style={{ fontSize: 10.5, color: "#B08A5A", fontWeight: "800", letterSpacing: 0.5 }}>APROX.</Text>
                  <Text style={{ fontSize: 15, fontWeight: "800", color: "#B85C00", marginTop: 1 }}>~{rutaPrevia.min} min</Text>
                </View>
              ) : null}
            </View>
          </View>
        )}

        {/* 2. VEHICULO: personas (carrera) y carga (trasteo/acarreo), segun el pueblo */}
        {muni && vehiculosAqui.length > 0 && (
          <View style={styles.card}>
            {ordenVehiculos(vehiculosAqui).some((v) => !esCarga(v)) && (
              <>
                <Text style={styles.etiqueta}>¿EN QUÉ TE VAS?</Text>
                <View style={{ flexDirection: "row", gap: 10 }}>
                  {ordenVehiculos(vehiculosAqui).filter((v) => !esCarga(v)).map((v) => {
                    const on = vehiculo === v;
                    const capacidad = v === "moto" ? "1 pasajero" : v === "carro" ? "Hasta 4 pasajeros" : "";
                    return (
                      <TouchableOpacity key={v} activeOpacity={0.85} onPress={() => setVehiculo(v)}
                        style={{ flex: 1, borderRadius: 16, paddingVertical: 14, paddingHorizontal: 12, borderWidth: 2,
                          borderColor: on ? "#187830" : "#ECECE6", backgroundColor: on ? "#EEF7F0" : "#fff" }}>
                        <Text style={{ fontSize: 30 }}>{vehIcono(v)}</Text>
                        <Text style={{ fontSize: 16, fontWeight: "800", color: on ? "#14672A" : "#1D1D1D", marginTop: 6 }}>{vehLabel(v)}</Text>
                        {capacidad ? <Text style={{ fontSize: 12, color: "#8A8A8A", marginTop: 1 }}>{capacidad}</Text> : null}
                        {on ? <View style={{ position: "absolute", top: 10, right: 10, width: 20, height: 20, borderRadius: 10, backgroundColor: "#187830", alignItems: "center", justifyContent: "center" }}><Text style={{ color: "#fff", fontSize: 12, fontWeight: "900" }}>✓</Text></View> : null}
                      </TouchableOpacity>
                    );
                  })}
                </View>
              </>
            )}
            {ordenVehiculos(vehiculosAqui).some(esCarga) && (
              <>
                <Text style={[styles.etiqueta, { marginTop: modoServicio === "acarreo" ? 0 : 14 }]}>{modoServicio === "acarreo" ? "🚚 ¿QUÉ VEHÍCULO NECESITAS?" : "🚚 TRASTEO O ACARREO"}</Text>
                <Text style={styles.ayuda}>{modoServicio === "acarreo" ? "Elige según el tamaño de lo que vas a mover" : "Para mudanzas, mercancia o carga"}</Text>
                <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 6 }}>
                  {ordenVehiculos(vehiculosAqui).filter(esCarga).map((v) => (
                    <TouchableOpacity
                      key={v}
                      style={[styles.chip, vehiculo === v && styles.chipOn]}
                      onPress={() => setVehiculo(v)}
                    >
                      <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}><Text style={styles.chipTxt}>{vehIcono(v)}</Text><Text style={[styles.chipTxt, vehiculo === v && styles.chipTxtOn]}>{vehLabel(v)}</Text></View>
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
            <Text style={styles.etiqueta}>¿QUÉ VAS A MOVER?</Text>
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8, marginBottom: 12 }}>
              {TIPOS_CARGA.map(([k, t]) => (
                <TouchableOpacity key={k} style={[styles.chip, tipoCarga === k && styles.chipOn]} onPress={() => setTipoCarga(k)}>
                  <Text style={[styles.chipTxt, tipoCarga === k && styles.chipTxtOn]}>{t}</Text>
                </TouchableOpacity>
              ))}
            </View>

            <Text style={styles.etiqueta}>¿QUÉ TAN GRANDE ES?</Text>
            <View style={{ gap: 6, marginBottom: 12 }}>
              {TAMANOS_CARGA.map(([k, t]) => (
                <TouchableOpacity key={k} onPress={() => setTamanoCarga(k)}
                  style={{ flexDirection: "row", alignItems: "center", gap: 10, padding: 10, borderRadius: 10, borderWidth: 1.5,
                    borderColor: tamanoCarga === k ? "#187830" : "#E5E0D5", backgroundColor: tamanoCarga === k ? "#EAF6EC" : "#fff" }}>
                  <Text style={{ fontSize: 14, fontWeight: "800", color: tamanoCarga === k ? "#187830" : "#333", width: 86 }}>{t}</Text>
                  <Text style={{ fontSize: 12.5, color: "#777", flex: 1 }}>{ejemploTamano(tipoCarga, k)}</Text>
                </TouchableOpacity>
              ))}
            </View>

            <Text style={styles.etiqueta}>DESCRIPCION DE LA CARGA</Text>
            <TextInput
              ref={refCarga}
              onFocus={() => subirCampo(refCarga)}
              value={form.notas}
              onChangeText={(t) => setForm({ ...form, notas: t })}
              placeholder="Ej: dos neveras, una lavadora y varias cajas"
              style={[styles.input, { minHeight: 60 }]}
              multiline
            />
            <Text style={[styles.ayuda, { marginTop: -2 }]}>Asi el transportador sabe que va a mover y con que ayuda</Text>

            <Text style={[styles.etiqueta, { marginTop: 8 }]}>FOTOS DE LA CARGA (OPCIONAL, MÁX 3)</Text>
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
              {fotosCarga.map((u) => (
                <View key={u}>
                  <Image source={{ uri: u }} style={{ width: 70, height: 70, borderRadius: 10 }} />
                  <TouchableOpacity onPress={() => setFotosCarga((f) => f.filter((x) => x !== u))}
                    style={{ position: "absolute", top: -6, right: -6, backgroundColor: "#C0392B", borderRadius: 11, width: 22, height: 22, alignItems: "center", justifyContent: "center" }}>
                    <Text style={{ color: "#fff", fontWeight: "900", fontSize: 12 }}>✕</Text>
                  </TouchableOpacity>
                </View>
              ))}
              {fotosCarga.length < 3 && (
                <TouchableOpacity onPress={agregarFotoCarga} disabled={subiendoCarga}
                  style={{ width: 70, height: 70, borderRadius: 10, borderWidth: 1.5, borderStyle: "dashed", borderColor: "#B85C00", alignItems: "center", justifyContent: "center", backgroundColor: "#FFF7EC" }}>
                  {subiendoCarga ? <ActivityIndicator color="#B85C00" /> : <Text style={{ fontSize: 24 }}>📷</Text>}
                </TouchableOpacity>
              )}
            </View>
            <Text style={[styles.ayuda, { marginTop: 10 }]}>Con fotos te cotizan más rápido y más justo</Text>

            <Text style={[styles.etiqueta, { marginTop: 8 }]}>¿NECESITAS AYUDA PARA CARGAR?</Text>
            <View style={{ flexDirection: "row", gap: 8, marginBottom: 12 }}>
              {[[0, "No"], [1, "1 ayudante"], [2, "2 ayudantes"]].map(([n, t]) => (
                <TouchableOpacity key={n} style={[styles.opcion, ayudantes === n && styles.opcionActiva]} onPress={() => setAyudantes(n)}>
                  <Text style={[styles.opcionTexto, ayudantes === n && styles.opcionTextoActivo]}>{t}</Text>
                </TouchableOpacity>
              ))}
            </View>

            <Text style={styles.etiqueta}>PISOS (SI ES APARTAMENTO O LOCAL EN ALTURA)</Text>
            {[["Recoger en piso", pisoO, setPisoO, ascO, setAscO], ["Entregar en piso", pisoD, setPisoD, ascD, setAscD]].map(([lbl, val, setVal, asc, setAsc]) => (
              <View key={lbl} style={{ marginBottom: 10 }}>
                <Text style={{ fontSize: 13, color: "#555", marginBottom: 6 }}>{lbl}</Text>
                <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                  <TextInput value={val} onChangeText={(t) => setVal(t.replace(/\D/g, "").slice(0, 2))} keyboardType="number-pad" placeholder="1"
                    style={[styles.input, { width: 58, marginBottom: 0, textAlign: "center" }]} />
                  {[["si", "Con ascensor"], ["no", "Sin ascensor"]].map(([k, t]) => (
                    <TouchableOpacity key={k} onPress={() => setAsc(asc === k ? null : k)}
                      style={{ flex: 1, paddingVertical: 11, borderRadius: 10, borderWidth: 1.5, alignItems: "center", borderColor: asc === k ? "#187830" : "#E5E0D5", backgroundColor: asc === k ? "#EAF6EC" : "#fff" }}>
                      <Text style={{ fontSize: 12.5, color: asc === k ? "#187830" : "#666", fontWeight: "700" }}>{t}</Text>
                    </TouchableOpacity>
                  ))}
                </View>
              </View>
            ))}

            <Text style={[styles.etiqueta, { marginTop: 6 }]}>¿QUIÉN RECIBE EN EL DESTINO? (OPCIONAL)</Text>
            <TextInput value={recibeNombre} onChangeText={setRecibeNombre} placeholder="Nombre de quien recibe" style={styles.input} maxLength={80} />
            <TextInput value={recibeTel} onChangeText={setRecibeTel} placeholder="Teléfono de quien recibe" keyboardType="phone-pad" style={styles.input} maxLength={15} />
            <Text style={[styles.ayuda, { marginTop: -2 }]}>Útil si envías mercancía a un cliente o a una obra</Text>

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
                <TouchableOpacity
                  onPress={() => setCalAbierto(true)}
                  style={{ marginTop: 12, borderWidth: 1.5, borderColor: recogidaISO ? "#187830" : "#F06000", borderRadius: 12, paddingVertical: 14, paddingHorizontal: 16, backgroundColor: recogidaISO ? "#EAF6EC" : "#FFF6EF", flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
                  <Text style={{ color: recogidaISO ? "#187830" : "#B44700", fontWeight: "800", fontSize: 15 }}>
                    {recogidaISO ? `📅 ${fmtRecogida(recogidaISO)}` : "📅 Elegir día y hora"}
                  </Text>
                  <Text style={{ color: recogidaISO ? "#187830" : "#B44700", fontWeight: "800", fontSize: 15 }}>
                    {recogidaISO ? "Cambiar ›" : "Abrir ›"}
                  </Text>
                </TouchableOpacity>
                <Text style={[styles.ayuda, { marginTop: 8 }]}>Abre el calendario y elige el día (puedes ir meses adelante) y la hora exacta de recogida.</Text>
                <CalendarioModal
                  visible={calAbierto}
                  inicial={progDia && progHora ? { d: progDia, h: progHora.h, m: progHora.m } : null}
                  onConfirmar={(d, h, mm) => { setProgDia(d); setProgHora({ h, m: mm }); setCalAbierto(false); }}
                  onCerrar={() => setCalAbierto(false)}
                />
              </>
            )}
          </View>
        )}

        {/* 4. OFERTA */}
        <View style={styles.card}>
          {/* tarifa sugerida = mínimo recomendado (distancia x $/km de la ciudad).
              Se muestra SIEMPRE que la ciudad tenga tarifa; el cliente arranca de
              ahi. El conductor puede aceptarla o contraofertar. */}
          {muni && muni.usa_gps && estimado && estimado.tarifa_sugerida ? (
            (estimado.promo && estimado.promo.aplica) ? (
              // PROMO de lanzamiento (solo carreras): precio normal tachado + el de promo
              <View style={{ backgroundColor: "#FFF1E8", borderRadius: 12, padding: 12, marginBottom: 12, borderWidth: 1, borderColor: "#F0A878" }}>
                <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 6, marginBottom: 2 }}>
                  <View style={{ backgroundColor: "#E8470A", borderRadius: 6, paddingHorizontal: 7, paddingVertical: 2 }}>
                    <Text style={{ color: "#fff", fontSize: 12, fontWeight: "800" }}>🔥 {estimado.promo.pct}% OFF</Text>
                  </View>
                  {estimado.promo.texto ? <Text style={{ fontSize: 12, color: "#B8430A", fontWeight: "700" }}>{estimado.promo.texto}</Text> : null}
                </View>
                <View style={{ flexDirection: "row", alignItems: "flex-end", gap: 10, marginTop: 2 }}>
                  <Text style={{ fontSize: 26, fontWeight: "800", color: "#E8470A" }}>${estimado.tarifa_sugerida.toLocaleString()}</Text>
                  {estimado.tarifa_normal ? (
                    <Text style={{ fontSize: 16, color: "#999", textDecorationLine: "line-through", marginBottom: 3 }}>${estimado.tarifa_normal.toLocaleString()}</Text>
                  ) : null}
                </View>
                <Text style={{ fontSize: 12, color: "#9a5a3a", marginTop: 2 }}>
                  Precio de lanzamiento para ~{estimado.distancia_km} km. ¡Aprovecha!
                </Text>
                {String(estimado.tarifa_sugerida) !== oferta && (
                  <TouchableOpacity onPress={() => setOferta(String(estimado.tarifa_sugerida))} style={{ marginTop: 8, backgroundColor: "#E8470A", borderRadius: 8, paddingVertical: 8, alignItems: "center" }}>
                    <Text style={{ color: "#fff", fontWeight: "700", fontSize: 13 }}>Usar ${estimado.tarifa_sugerida.toLocaleString()}</Text>
                  </TouchableOpacity>
                )}
              </View>
            ) : (
              <View style={{ backgroundColor: "#EAF6EC", borderRadius: 12, padding: 12, marginBottom: 12 }}>
                <Text style={{ fontSize: 12.5, color: "#187830", fontWeight: "700", letterSpacing: 0.3 }}>💵 TARIFA SUGERIDA (mínimo)</Text>
                <Text style={{ fontSize: 26, fontWeight: "800", color: "#187830", marginTop: 2 }}>${estimado.tarifa_sugerida.toLocaleString()}</Text>
                <Text style={{ fontSize: 12, color: "#5a7a60", marginTop: 2 }}>
                  Para ~{estimado.distancia_km} km. Es lo mínimo recomendado; puedes ofrecer más para que te tomen más rápido.
                </Text>
                {String(estimado.tarifa_sugerida) !== oferta && (
                  <TouchableOpacity onPress={() => setOferta(String(estimado.tarifa_sugerida))} style={{ marginTop: 8, backgroundColor: "#187830", borderRadius: 8, paddingVertical: 8, alignItems: "center" }}>
                    <Text style={{ color: "#fff", fontWeight: "700", fontSize: 13 }}>Usar ${estimado.tarifa_sugerida.toLocaleString()}</Text>
                  </TouchableOpacity>
                )}
              </View>
            )
          ) : (muni && muni.usa_gps && estimado && estimado.distancia_km ? (
            <View style={[styles.estimado, { marginBottom: 12 }]}>
              <Text style={{ fontSize: 13, color: "#555" }}>Distancia: ~{estimado.distancia_km} km</Text>
              <Text style={{ fontSize: 12.5, color: "#888", marginTop: 2 }}>Aún no hay tarifa para esta ciudad. Ofrece lo que consideres justo.</Text>
            </View>
          ) : null)}
          <Text style={styles.etiqueta}>¿CUÁNTO OFRECES PAGAR?</Text>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
            <TouchableOpacity onPress={() => setOferta(String(Math.max(0, (parseInt(oferta || "0", 10) || 0) - 500)))}
              style={{ width: 48, height: 48, borderRadius: 24, backgroundColor: "#F1F2EF", alignItems: "center", justifyContent: "center" }}>
              <Text style={{ fontSize: 26, fontWeight: "700", color: "#1D1D1D", marginTop: -2 }}>−</Text>
            </TouchableOpacity>
            <View style={{ flex: 1, flexDirection: "row", alignItems: "center", justifyContent: "center", backgroundColor: "#F7F8F5", borderRadius: 16, paddingHorizontal: 10 }}>
              <Text style={{ fontSize: 26, fontWeight: "800", color: "#1D1D1D" }}>$</Text>
              <TextInput
                value={oferta ? Number(oferta).toLocaleString("es-CO") : ""}
                onChangeText={(t) => setOferta(t.replace(/\D/g, ""))}
                placeholder="0"
                placeholderTextColor="#B9B9B2"
                keyboardType="number-pad"
                style={{ fontSize: 32, fontWeight: "800", color: "#1D1D1D", paddingVertical: 10, paddingHorizontal: 6, minWidth: 90, textAlign: "center" }}
                onFocus={() => setTimeout(() => scrollForm.current && scrollForm.current.scrollToEnd({ animated: true }), 250)}
              />
            </View>
            <TouchableOpacity onPress={() => setOferta(String((parseInt(oferta || "0", 10) || 0) + 500))}
              style={{ width: 48, height: 48, borderRadius: 24, backgroundColor: "#187830", alignItems: "center", justifyContent: "center" }}>
              <Text style={{ fontSize: 26, fontWeight: "700", color: "#fff", marginTop: -2 }}>+</Text>
            </TouchableOpacity>
          </View>
          {estimado && estimado.tarifa_sugerida && oferta && Number(oferta) < estimado.tarifa_sugerida ? (
            <Text style={{ fontSize: 12.5, color: "#C0392B", fontWeight: "600", marginTop: 6 }}>
              ⚠️ Estás ofreciendo menos del sugerido (${estimado.tarifa_sugerida.toLocaleString()}). Puede que ningún conductor la tome o te propongan más.
            </Text>
          ) : (
            <Text style={[styles.ayuda, { marginTop: 10, marginBottom: 0, textAlign: "center" }]}>Un conductor puede aceptar tu precio o proponerte otro, y tú eliges</Text>
          )}
        </View>

        </>)}
      </ScrollView>
      {modo !== "expreso" && (
        <View style={{ backgroundColor: "#fff", paddingHorizontal: 16, paddingTop: 12, paddingBottom: 12 + insets.bottom, borderTopLeftRadius: 22, borderTopRightRadius: 22,
          shadowColor: "#0C2C1B", shadowOffset: { width: 0, height: -4 }, shadowOpacity: 0.08, shadowRadius: 12, elevation: 12 }}>
          <TouchableOpacity activeOpacity={0.9} onPress={pedir} disabled={cargando}
            style={{ backgroundColor: "#F06000", borderRadius: 16, paddingVertical: 16, paddingHorizontal: 18, flexDirection: "row", alignItems: "center", justifyContent: "center" }}>
            {cargando ? <ActivityIndicator color="#fff" /> : (
              <>
                <Text style={{ color: "#fff", fontSize: 17, fontWeight: "800", flex: 1, textAlign: oferta ? "left" : "center" }}>
                  {(esCarga(vehiculo) || modoServicio === "acarreo") ? "Pedir acarreo" : "Pedir carrera"}
                </Text>
                {oferta ? <Text style={{ color: "#fff", fontSize: 17, fontWeight: "800" }}>${Number(oferta).toLocaleString("es-CO")}</Text> : null}
              </>
            )}
          </TouchableOpacity>
        </View>
      )}
      </KeyboardAvoidingView>

      <MapaSelector
        visible={!!mapaAbierto}
        titulo={mapaAbierto === "origen" ? "De donde sales" : "A donde vas"}
        centro={centroMapa(mapaAbierto)}
        municipio={muni ? muni.nombre : usuario.municipio}
        onConfirmar={confirmarPunto}
        onCerrar={() => setMapaAbierto(null)}
      />
    </SafeAreaView>
  );
}

/** Insignia dorada de los conductores fundadores (los primeros de la Red). */
function InsigniaFundador({ grande }) {
  return (
    <View style={{ flexDirection: "row", alignItems: "center", alignSelf: "flex-start", gap: 4, backgroundColor: "#FFF4D6", borderWidth: 1, borderColor: "#F5B301", borderRadius: 999, paddingVertical: grande ? 4 : 2, paddingHorizontal: grande ? 10 : 7 }}>
      <Text style={{ fontSize: grande ? 13 : 11 }}>🏅</Text>
      <Text style={{ fontSize: grande ? 12.5 : 11, fontWeight: "800", color: "#8A5A00" }}>{grande ? "Conductor Fundador" : "Fundador"}</Text>
    </View>
  );
}

function ConductorScreen({ navigation, route }) {
  const { usuario } = route.params;
  // en Samsung y otros con botones de navegacion en pantalla, la barra del
  // sistema tapa las pestañas si no se respeta el area segura inferior
  const insets = useSafeAreaInsets();
  const [disponibles, setDisponibles] = useState([]);
  const [mias, setMias] = useState([]);
  const [esFundador, setEsFundador] = useState(usuario.fundador === "si");
  useEffect(() => {
    fetch(`${API}/usuarios/${usuario.id}/perfil`).then(r => r.json())
      .then(p => { if (p && p.fundador) setEsFundador(p.fundador === "si"); }).catch(() => {});
  }, []);
  const [avisoCancelada, setAvisoCancelada] = useState(null); // carrera que el pasajero cancelo
  const [sobreOk, setSobreOk] = useState(puedeSobreponer());  // "Mostrar encima de otras apps"
  useEffect(() => {
    const sub = AppState.addEventListener("change", (st) => { if (st === "active") setSobreOk(puedeSobreponer()); });
    return () => sub.remove();
  }, []);
  const avisoCanceladaRef = useRef(null);
  // cancelaciones que el conductor ya confirmo ("Entendido"); se guardan en el
  // celular para no repetir el aviso al reabrir la app
  const cancelVistas = useRef(null);
  const CLAVE_CANCEL_VISTAS = `tukan_cancel_vistas_${usuario.id}`;
  useEffect(() => {
    AsyncStorage.getItem(CLAVE_CANCEL_VISTAS)
      .then(v => { cancelVistas.current = new Set(v ? JSON.parse(v) : []); })
      .catch(() => { cancelVistas.current = new Set(); });
  }, []);
  const cerrarAvisoCancelada = () => {
    const c = avisoCanceladaRef.current;
    if (c && cancelVistas.current) {
      cancelVistas.current.add(c.id);
      AsyncStorage.setItem(CLAVE_CANCEL_VISTAS, JSON.stringify([...cancelVistas.current].slice(-100))).catch(() => {});
    }
    if (c) quitarAviso(`cancelada-${c.id}`);
    avisoCanceladaRef.current = null;
    setAvisoCancelada(null);
  };
  const [historial, setHistorial] = useState([]);   // carreras pasadas (finalizadas/canceladas)
  const [disponible, setDisponible] = useState(usuario.disponible === "si");
  // el setInterval de cargar() captura el 'disponible' del primer render (stale
  // closure); este ref siempre tiene el valor actual para el ping
  const dispRef = useRef(usuario.disponible === "si");
  // igual que dispRef pero para "ya tengo una carrera en curso": el setInterval de
  // cargar() usa un closure viejo, este ref siempre tiene el valor actual. Sirve
  // para NO saltar el popup ni el tono de una solicitud que no podria aceptar.
  const tieneActivaRef = useRef(false);
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
  const VENTANA = 10000;
  const recibidas = useRef({});
  const idsVistos = useRef(null);
  // ids por las que YA sonamos/saltamos, para no repetir. Una carrera lejana no
  // esta aca hasta que le toca (cercania o vencida la ventana): ahi si suena.
  const idsAlertados = useRef(null);
  // recuadro tipo Uber cuando entra una solicitud: salta, vibra y cuenta 10s
  const [entrante, setEntrante] = useState(null);
  const barraEntrante = useRef(new Animated.Value(1)).current;   // ancho de la barra (10s)
  const escalaEntrante = useRef(new Animated.Value(0.85)).current; // animacion de entrada
  const [ahora, setAhora] = useState(Date.now());
  // tarifas por ciudad: para sugerir un precio que suma recogida + viaje.
  // En Pasto/Cali/Florencia el $/km es distinto, asi el conductor ve cuanto
  // cobrar sin perder la contraoferta (es solo una sugerencia).
  const [munis, setMunis] = useState([]);

  useEffect(() => {
    // se refresca cada 5 min: trae el recargo de hora pico / madrugada vigente
    const cargar = () => fetch(`${API}/municipios`)
      .then((r) => r.json())
      .then((d) => Array.isArray(d) && setMunis(d))
      .catch(() => {});
    cargar();
    const iv = setInterval(cargar, 5 * 60 * 1000);
    return () => clearInterval(iv);
  }, []);

  // precio sugerido para el conductor = base + (km a la recogida + km del viaje) x $/km
  // de la ciudad, redondeado al mil y nunca por debajo de la minima. Si la ciudad
  // no tiene $/km configurado, devuelve null (precio libre, sin sugerencia).
  const sugeridoConductor = (c, kmAlOrigen, kmViaje) => {
    // acarreos: sin sugerido, se negocia (peso, ayuda, pisos). Solo oferta+contra.
    if (esCarga(c.vehiculo_pedido)) return null;
    const m = munis.find((x) => x.nombre === c.municipio);
    if (!m) return null;
    // tarifa propia del vehiculo (ej. moto mas barata) o, si no tiene, la de la ciudad
    const tv = m.tarifas_vehiculo && m.tarifas_vehiculo[c.vehiculo_pedido];
    const t = tv ? { tarifa_base: tv.base, valor_km: tv.valor_km, tarifa_minima: tv.minima } : m;
    if (!t.valor_km) return null;
    const km = (kmAlOrigen || 0) + (kmViaje || 0);
    if (!km) return null;
    // hora pico / madrugada (lo decide el servidor): mas $/km y mas minima
    const rec = m.recargo || { km: 0, minima: 0 };
    const bruto = (t.tarifa_base || 0) + km * (t.valor_km + (rec.km || 0));
    return Math.max(Math.ceil(bruto / 1000) * 1000, (t.tarifa_minima || 0) + (rec.minima || 0));
  };

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
  const pingSolicitud = (c) => {
    if (Platform.OS === "web") return;
    // app NO al frente (bloqueado, otra app): aviso a pantalla completa, no el normal
    if (c && AppState.currentState !== "active") { sonarCarreraFondo(c); return; }
    if (!puedeSonar()) return;   // anti-rebote compartido con el servicio de fondo
    // vibracion fuerte: se siente aunque el telefono este en silencio (no
    // depende del permiso de notificaciones ni de modulos nativos extra)
    try { Vibration.vibrate([0, 500, 220, 500]); } catch (e) {}
    // ademas el tono de notificacion (si dio permiso y no esta en silencio)
    Notifications.scheduleNotificationAsync({
      content: { title: "🔔 Nueva solicitud de carrera", body: "Toca para verla y responder.", sound: SONIDO_EXPO },
      trigger: Platform.OS === "android" ? { channelId: CANAL_EXPO, seconds: 1 } : null,
    }).catch(() => {});
  };

  // recuadro tipo Uber: aparece de golpe, vibra y corre una barra de 10 segundos
  const mostrarEntrante = (c) => {
    setEntrante(c);
    try { Vibration.vibrate([0, 400, 180, 400, 180, 400]); } catch (e) {}
    escalaEntrante.setValue(0.85);
    Animated.spring(escalaEntrante, { toValue: 1, friction: 6, tension: 90, useNativeDriver: true }).start();
    barraEntrante.setValue(1);
    Animated.timing(barraEntrante, { toValue: 0, duration: VENTANA, useNativeDriver: false })
      .start(({ finished }) => { if (finished) setEntrante(null); });
  };
  const cerrarEntrante = () => { barraEntrante.stopAnimation(); setEntrante(null); };

  const cargar = () => {
    // con conductor_id el servidor filtra por municipio y tipo de vehiculo
    fetch(`${API}/carreras/disponibles?conductor_id=${usuario.id}`).then(r => r.json())
      .then(d => {
        if (!Array.isArray(d)) return;
        const t = Date.now();
        const idsAhora = new Set(d.map(c => c.id));
        // primera vez que vemos cada solicitud -> arranca su ventana de 6s
        d.forEach(c => { if (!recibidas.current[c.id]) recibidas.current[c.id] = t; });
        idsVistos.current = idsAhora;
        // solo suena/salta por las que le TOCAN ahora: el backend marca 'alertar'
        // (cercano al cliente, o ya vencida la ventana de prioridad). Si va en una
        // carrera no lo interrumpimos. Primera carga: solo memoriza, no pita.
        const puedeTomar = dispRef.current && !tieneActivaRef.current;
        const kmDe = (c) => (c.km_a_recogida != null ? c.km_a_recogida : 9e9);
        const alertablesAhora = d.filter(c => c.alertar !== false).map(c => c.id);
        if (idsAlertados.current === null) {
          idsAlertados.current = new Set(alertablesAhora);
        } else {
          const porAlertar = puedeTomar
            ? d.filter(c => c.alertar !== false && !idsAlertados.current.has(c.id))
            : [];
          if (porAlertar.length) {
            // muestra primero la MAS cercana al cliente
            porAlertar.sort((a, b) => kmDe(a) - kmDe(b));
            pingSolicitud(porAlertar[0]);
            mostrarEntrante(porAlertar[0]);
          }
          idsAlertados.current = new Set(alertablesAhora);
        }
        animar(); setDisponibles(d);
        // abrio Tukan desde el aviso a pantalla completa: se le muestra esa solicitud de una
        if (solicitudDesdeFondo && AppState.currentState === "active") {
          const c = d.find((x) => x.id === solicitudDesdeFondo);
          solicitudDesdeFondo = null;
          if (c && !tieneActivaRef.current) { mostrarEntrante(c); quitarAviso(`solicitud-${c.id}`); }
        }
      }).catch(() => {});
    fetch(`${API}/carreras/conductor/${usuario.id}`).then(r => r.json())
      .then(d => {
        if (!Array.isArray(d)) return;
        const activas = d.filter(c => ["aceptada", "en_sitio", "en_camino"].includes(c.estado));
        // el pasajero (o el admin) le cancelo una carrera que ya era suya y el
        // conductor aun no lo ha confirmado: aviso encima de todo con el motivo.
        // No depende de que la app haya estado abierta: sirve al volver del segundo
        // plano o al abrirla tocando la notificacion. Se marca vista con "Entendido".
        if (cancelVistas.current) {
          const hace = (f) => f ? Date.now() - new Date(f).getTime() : Infinity;
          const pendiente = d
            .filter(c => c.estado === "cancelada" && c.cancelada_por && c.cancelada_por !== "conductor"
              && c.aceptada_en && hace(c.cancelada_en) < 2 * 3600 * 1000 && !cancelVistas.current.has(c.id))
            .sort((a, b) => hace(a.cancelada_en) - hace(b.cancelada_en))[0];
          if (pendiente && (!avisoCanceladaRef.current || avisoCanceladaRef.current.id !== pendiente.id)) {
            avisoCanceladaRef.current = pendiente;
            setAvisoCancelada(pendiente);
            if (AppState.currentState === "active") quitarAviso(`cancelada-${pendiente.id}`);
            else {
              traerTukanAlFrente();
              avisoPantallaCompleta(`cancelada-${pendiente.id}`, "❌ El pasajero canceló la carrera",
                `${pendiente.origen} → ${pendiente.destino}. Motivo: ${pendiente.motivo_cancelacion || "sin motivo"}`);
            }
            try { Vibration.vibrate([0, 600, 200, 600]); } catch (e) {}
          }
        }
        setMias(activas);
        tieneActivaRef.current = activas.length > 0;
        setHistorial(d.filter(c => ["finalizada", "cancelada"].includes(c.estado)));
      })
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
    // al volver del segundo plano refresca YA (ej. para mostrar una cancelacion)
    const alFrente = AppState.addEventListener("change", (s) => { if (s === "active") cargar(); });
    return () => { clearInterval(intervalo); aviso.remove(); toque.remove(); alFrente.remove(); };
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

  // El servicio en SEGUNDO PLANO corre cuando el conductor esta DISPONIBLE o tiene
  // una carrera activa: mantiene viva la app (notificacion fija) para SONAR cuando
  // entre una carrera aunque este minimizada/cerrada, y transmite la ubicacion en
  // carrera. Con la app abierta y carrera activa, ademas alimenta su mapa cada 8s.
  // expresos (viajes a otra ciudad) que salen de la ciudad del conductor. Se
  // declaran ANTES de tieneExpresoEnCamino (abajo) para no caer en TDZ.
  const [expresosDisp, setExpresosDisp] = useState([]);
  const [misExpresos, setMisExpresos] = useState([]);
  const [ofExpreso, setOfExpreso] = useState(null);   // expreso al que le va a contraofertar
  const [montoExp, setMontoExp] = useState("");
  const [verExp, setVerExp] = useState(null);   // expreso cuyo detalle+mapa esta viendo antes de decidir

  const tieneCarreraActiva = mias.length > 0;
  // un expreso EN CAMINO tambien exige reportar GPS: el cliente ve el carro moverse
  const tieneExpresoEnCamino = misExpresos.some(e => e.estado === "en_camino");
  const debeRastrear = tieneCarreraActiva || tieneExpresoEnCamino;
  const debeCorrerFondo = disponible || debeRastrear;
  useEffect(() => {
    if (!debeCorrerFondo) { detenerRastreoFondo(); return; }
    iniciarRastreoFondo(usuario.id);
  }, [debeCorrerFondo]);

  useEffect(() => {
    // corre con carrera activa (el cliente te ve venir) Y TAMBIEN cuando estas solo
    // DISPONIBLE esperando: con la pantalla encendida tu carrito debe moverse en el
    // mapa mientras manejas (antes solo se tomaba el GPS una vez y se veia quieto).
    if (!debeRastrear && !disponible) return;
    let vivo = true;
    let sub = null;
    (async () => {
      try {
        const p = await Location.getForegroundPermissionsAsync();
        if (p.status !== "granted") return;
        // rastreo CONTINUO (no getCurrentPosition, que a veces da posicion en cache
        // y el carro se ve quieto): reporta al moverse ~12m o cada 4s
        sub = await Location.watchPositionAsync(
          { accuracy: Location.Accuracy.High, timeInterval: 4000, distanceInterval: 12 },
          (pos) => {
            if (!vivo) return;
            setMiUbic({ lat: pos.coords.latitude, lon: pos.coords.longitude });
            fetch(`${API}/conductores/${usuario.id}/ubicacion?lat=${pos.coords.latitude}&lon=${pos.coords.longitude}`, { method: "PUT" }).catch(() => {});
          }
        );
      } catch (e) {}
    })();
    return () => { vivo = false; if (sub) { try { sub.remove(); } catch (e) {} } };
  }, [debeRastrear, disponible]);

  const aceptar = (c) => {
    // se quita YA del listado (no espera al refresco) para que no la vuelva a
    // tocar y no haya duplicidad; si algo falla, cargar() restaura el estado real
    animar();
    setDisponibles((prev) => prev.filter((x) => x.id !== c.id));
    userFetch(`${API}/carreras/${c.id}/aceptar?conductor_id=${usuario.id}`, { method: "PUT" })
      .then(async (r) => {
        const d = await r.json();
        if (r.status === 409) { avisar("No se pudo", d.detail || "Otro transportador lo tomo primero."); cargar(); return; }
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
  const [calificarCliente, setCalificarCliente] = useState(null);   // carrera recien terminada, para calificar al cliente

  // llega pre-llenada con el precio ACORDADO: confirmar y listo. Solo se toca
  // si de verdad cambio (evita errores de dedo que dañan las estadisticas)
  // ACARREO: antes de cobrar se deja la prueba de entrega (quien recibio + foto)
  const [entregando, setEntregando] = useState(null);
  const [recibio, setRecibio] = useState("");
  const [fotoEntrega, setFotoEntrega] = useState(null);   // uri local
  const [enviandoEntrega, setEnviandoEntrega] = useState(false);
  const irACobrar = (c) => { setTarifa(c.tarifa != null ? String(c.tarifa) : ""); setCobrando(c); };
  const finalizar = (c) => {
    if (esCarga(c.vehiculo_pedido) && !c.entrega_recibio) {
      setRecibio(c.recibe_nombre || ""); setFotoEntrega(null); setEntregando(c); return;
    }
    irACobrar(c);
  };
  const confirmarEntrega = () => {
    const c = entregando;
    if (!recibio.trim()) { avisar("Falta el nombre", "Escribe quién recibió la carga."); return; }
    setEnviandoEntrega(true);
    const fd = new FormData();
    fd.append("origen", "app");   // asi el formulario nunca va vacio
    if (fotoEntrega) fd.append("file", { uri: fotoEntrega, type: "image/jpeg", name: "entrega.jpg" });
    userFetch(`${API}/carreras/${c.id}/entrega?${qs({ recibio: recibio.trim() })}`, { method: "POST", body: fd })
      .then((r) => r.json().then((d) => ({ ok: r.ok, d })))
      .then(({ ok, d }) => {
        setEnviandoEntrega(false);
        if (!ok) { avisar("No se pudo registrar", (d && d.detail) || "Intenta de nuevo."); return; }
        setEntregando(null);
        irACobrar({ ...c, entrega_recibio: d.entrega_recibio, entrega_foto: d.entrega_foto });
      })
      .catch(() => { setEnviandoEntrega(false); avisar("Sin conexión", "No se pudo registrar la entrega. Intenta de nuevo."); });
  };

  const confirmarCobro = () => {
    const t = parseInt((tarifa || "").replace(/\D/g, ""), 10);
    const car = cobrando;
    setCobrando(null);
    userFetch(`${API}/carreras/${car.id}/estado?estado=finalizada${t ? `&tarifa=${t}` : ""}`, { method: "PUT" })
      .then(() => { setCalificarCliente(car); cargar(); })
      .catch(() => avisar("Error", "No hay conexion. Intenta de nuevo."));
  };

  const cambiarEstado = (c, estado) => {
    userFetch(`${API}/carreras/${c.id}/estado?estado=${estado}`, { method: "PUT" }).then(cargar).catch(() => {});
  };
  // "ya lo recogí, iniciar viaje": pasa a en_camino y ABRE la navegacion al destino
  const iniciarViajeLocal = (c) => {
    cambiarEstado(c, "en_camino");
    if (c.destino_lat != null) navegarGoogleMaps(c.destino_lat, c.destino_lon);
    else if (c.destino) navegarGoogleMapsTexto(c.destino);
  };

  // --- negociacion del lado del conductor
  const [contraofertando, setContraofertando] = useState(null);
  const [montoOferta, setMontoOferta] = useState("");
  // solicitud abierta en detalle (tipo inDrive: lista -> toque -> mapa + todo)
  const [detalle, setDetalle] = useState(null);
  const [rutaDet, setRutaDet] = useState(null);   // {km,min} hasta la recogida

  const cargarExpresos = () => {
    fetch(`${API}/expresos/disponibles?conductor_id=${usuario.id}`).then(r => r.json())
      .then(d => { if (Array.isArray(d)) setExpresosDisp(d); }).catch(() => {});
    fetch(`${API}/expresos/conductor/${usuario.id}`).then(r => r.json())
      .then(d => { if (Array.isArray(d)) setMisExpresos(d); }).catch(() => {});
  };
  useEffect(() => { cargarExpresos(); const t = setInterval(cargarExpresos, 6000); return () => clearInterval(t); }, []);

  const aceptarExpreso = (e) => {
    confirmar("Tomar este viaje", `${e.origen_municipio} → ${e.destino_municipio} · ${e.cupos} cupo(s) a $${e.precio_por_cupo.toLocaleString()}/cupo (total $${(e.precio_por_cupo * e.cupos).toLocaleString()}). ¿Lo tomas a ese precio?`,
      () => userFetch(`${API}/expresos/${e.id}/aceptar?conductor_id=${usuario.id}`, { method: "PUT" }).then(async r => {
        const d = await r.json().catch(() => null);
        if (!r.ok) { avisar("No se pudo", (d && d.detail) || `Error ${r.status}`); cargarExpresos(); return; }
        avisar("✅ Viaje tomado", "Ya es tuyo. Contacta al cliente para coordinar la salida.");
        cargarExpresos();
      }).catch(() => avisar("Error", "No hay conexión.")), "Sí, tomar");
  };

  const enviarOfExpreso = () => {
    const m = parseInt((montoExp || "").replace(/\D/g, ""), 10) || 0;
    const e = ofExpreso;
    if (m <= 0 || !e) return;
    setOfExpreso(null); setMontoExp("");
    userFetch(`${API}/expresos/${e.id}/ofertas?conductor_id=${usuario.id}&monto=${m}`, { method: "POST" }).then(async r => {
      const d = await r.json().catch(() => null);
      if (!r.ok) { avisar("No se pudo", (d && d.detail) || `Error ${r.status}`); cargarExpresos(); return; }
      avisar("Oferta enviada", "El cliente verá tu precio por cupo y decide.");
      cargarExpresos();
    }).catch(() => avisar("Error", "No hay conexión."));
  };

  // abre Google Maps hacia el destino del expreso: por coordenadas si las hay
  // (puerta a puerta), o por texto (nombre del sitio + ciudad) si no
  const irAlDestinoExpreso = (e) => {
    if (e.destino_lat != null) navegarGoogleMaps(e.destino_lat, e.destino_lon);
    else navegarGoogleMapsTexto([e.destino_detalle, e.destino_municipio].filter(Boolean).join(", "));
  };
  // arranca el recorrido (recogí) y de una abre la navegacion al destino
  const iniciarRecorridoExpreso = (e) => {
    userFetch(`${API}/expresos/${e.id}/estado?estado=en_camino`, { method: "PUT" })
      .then(() => { cargarExpresos(); irAlDestinoExpreso(e); })
      .catch(() => avisar("Error", "No hay conexión."));
  };

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
            <Text style={{ fontSize: 14, color: "#333" }} numberOfLines={1}>🟢 {limpiaDir(c.origen)}</Text>
            <Text style={{ fontSize: 14, color: "#333", marginTop: 1 }} numberOfLines={1}>🔴 {limpiaDir(c.destino)}</Text>
          </View>
          {of ? <Text style={{ fontSize: 24, fontWeight: "800", color: "#187830", paddingLeft: 8 }}>${of.toLocaleString()}</Text> : null}
        </View>
        <DetalleAcarreo c={c} compacto />

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

  // ---- LISTA de solicitudes estilo inDrive: precio grande, origen/destino con
  // puntos y distancias a la derecha, pasajero con estrellas. Al tocar abre el
  // detalle con mapa (abrirDetalle). Solo para solicitudes que NO son propias.
  const fmtKmL = (k) => (k == null ? null : k < 1 ? `${Math.round(k * 1000)} m` : `${k.toFixed(1)} km`);
  const kmsDe = (c) => {
    const kmAlOrigen = miUbic && c.origen_lat != null ? kmEntre(miUbic, { lat: c.origen_lat, lon: c.origen_lon }) : (c.km_a_recogida != null ? c.km_a_recogida : null);
    const kmViaje = c.distancia_km != null ? c.distancia_km
      : (c.origen_lat != null && c.destino_lat != null
          ? kmEntre({ lat: c.origen_lat, lon: c.origen_lon }, { lat: c.destino_lat, lon: c.destino_lon }) : null);
    return { kmAlOrigen, kmViaje };
  };
  const abrirDetalle = (c) => { setRutaDet(null); setDetalle(c); };
  const tarjetaLista = (c, restante) => {
    const nueva = restante > 0;
    const { kmAlOrigen, kmViaje } = kmsDe(c);
    const of = c.tarifa_ofrecida;
    const carga = esCarga(c.vehiculo_pedido);
    return (
      <TouchableOpacity key={c.id} activeOpacity={0.85} onPress={() => abrirDetalle(c)}
        style={[sl.card, nueva && sl.cardNueva]}>
        <View style={sl.filaChips}>
          <View style={[sl.chip, carga ? sl.chipNaranja : sl.chipVerde]}>
            <Text style={[sl.chipTxt, { color: carga ? "#B54A00" : "#14672A" }]}>{carga ? "Acarreo" : vehLabel(c.vehiculo_pedido)}</Text>
          </View>
          {nueva && <View style={[sl.chip, { backgroundColor: "#F06000" }]}><Text style={[sl.chipTxt, { color: "#fff" }]}>Nueva</Text></View>}
          {!nueva && kmAlOrigen != null && kmAlOrigen <= 1.5 && !c.mi_oferta && (
            <View style={[sl.chip, sl.chipNaranja]}><Text style={[sl.chipTxt, { color: "#B54A00" }]}>Muy cerca</Text></View>
          )}
          {c.mi_oferta ? <View style={[sl.chip, { backgroundColor: "#E6EEFB" }]}><Text style={[sl.chipTxt, { color: "#1A56B8" }]}>Ofertaste ${c.mi_oferta.toLocaleString()}</Text></View> : null}
          {c.recogida ? <View style={[sl.chip, { backgroundColor: "#FFF4DD" }]}><Text style={[sl.chipTxt, { color: "#8A5A00" }]}>Programada</Text></View> : null}
        </View>

        <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginTop: 6 }}>
          <Text style={sl.precio}>
            <Text style={sl.moneda}>$ </Text>{of ? of.toLocaleString() : "A convenir"}
          </Text>
          <View style={sl.vehBadge}><Text style={{ fontSize: 22 }}>{vehIcono(c.vehiculo_pedido)}</Text></View>
        </View>

        <View style={sl.filaRuta}>
          <View style={sl.puntoHueco} />
          <Text style={sl.dir} numberOfLines={2}>{limpiaDir(c.origen)}</Text>
          {kmAlOrigen != null && <Text style={sl.km}>{fmtKmL(kmAlOrigen)}</Text>}
        </View>
        <View style={sl.filaRuta}>
          <View style={sl.puntoLleno} />
          <Text style={sl.dir} numberOfLines={2}>{limpiaDir(c.destino)}</Text>
          {kmViaje != null && <Text style={sl.km}>{fmtKmL(kmViaje)}</Text>}
        </View>

        <View style={sl.pie}>
          <AvatarPasajero c={c} tam={30} />
          <Text style={sl.pieNombre} numberOfLines={1}>{(c.cliente_nombre || "Pasajero").split(" ")[0]}</Text>
          <Text style={sl.pieEstrella}>★ {c.cliente_calificacion ? Number(c.cliente_calificacion).toFixed(1) : "Nuevo"}</Text>
          <View style={{ flex: 1 }} />
          <Text style={sl.pieGris}>{haceCuanto(c.fecha)}</Text>
        </View>
      </TouchableOpacity>
    );
  };

  const tarjeta = (c, propia, sinAccionEstado) => {
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
    // sugerencia = recogida + viaje x $/km de la ciudad (solo antes de tomarla)
    const sug = !propia ? sugeridoConductor(c, kmAlOrigen, kmViaje) : null;
    // para la carrera propia YENDO a recoger, mostramos la MISMA distancia real
    // por calles que el banner de arriba (rutaCond), no la linea recta: asi no
    // salen dos numeros distintos ("9.4 km" arriba y "5.4 km" abajo) para la
    // misma recogida. Si la ruta aun no se calcula, cae a la linea recta.
    const yendoARecoger = c.estado === "aceptada" || c.estado === "en_sitio";
    const kmRecogida = (propia && yendoARecoger && rutaCond && rutaCond.km != null) ? rutaCond.km : kmAlOrigen;
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
        🟢 {limpiaDir(c.origen)}
      </Text>
      <Text style={{ fontSize: 14, color: "#333", marginTop: 2 }} numberOfLines={1}>
        🔴 {limpiaDir(c.destino)}
      </Text>
      <DetalleAcarreo c={c} />

      {/* las dos distancias: antes de aceptar para decidir, y DESPUES tambien
          mientras hace el servicio (no desaparecen al tomar la carrera) */}
      {(kmAlOrigen != null || kmViaje != null) && (
        <View style={{ flexDirection: "row", gap: 8, marginTop: 8, flexWrap: "wrap" }}>
          {kmRecogida != null && (
            // ≤1.5 km de una solicitud disponible: eres el prioritario, se resalta
            !propia && kmRecogida <= 1.5 ? (
              <View style={{ backgroundColor: "#FFE9D6", borderRadius: 8, paddingVertical: 4, paddingHorizontal: 8, borderWidth: 1, borderColor: "#F06000" }}>
                <Text style={{ fontSize: 12, color: "#C24E00", fontWeight: "800" }}>
                  🔥 Muy cerca · a ~{fmtKm(kmRecogida)} de ti
                </Text>
              </View>
            ) : (
              <View style={{ backgroundColor: "#EAF6EC", borderRadius: 8, paddingVertical: 4, paddingHorizontal: 8 }}>
                <Text style={{ fontSize: 12, color: "#187830", fontWeight: "600" }}>
                  📍 {propia ? "Recogida a" : "A"} ~{fmtKm(kmRecogida)} de ti
                </Text>
              </View>
            )
          )}
          {kmViaje != null && (
            <View style={{ backgroundColor: "#FFF3E6", borderRadius: 8, paddingVertical: 4, paddingHorizontal: 8 }}>
              <Text style={{ fontSize: 12, color: "#B85C00", fontWeight: "600" }}>🛣️ Viaje ~{fmtKm(kmViaje)}</Text>
            </View>
          )}
        </View>
      )}

      {/* precio sugerido: recogida + viaje segun la tarifa de la ciudad. Es una
          guia; el conductor puede aceptar la oferta del cliente o proponer otro */}
      {sug != null && (
        <View style={{ backgroundColor: "#EAF1FB", borderRadius: 8, paddingVertical: 6, paddingHorizontal: 9, marginTop: 8, alignSelf: "flex-start" }}>
          <Text style={{ fontSize: 12.5, color: "#1A56B8", fontWeight: "700" }}>💡 Sugerido (recogida + viaje): ${sug.toLocaleString()}</Text>
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
        tieneCarreraActiva ? (
          // ya tiene una carrera en curso: la puede VER (para agarrarla apenas
          // termine), pero no aceptarla ahora. La solicitud sigue viva hasta que
          // alguien la tome; no desaparece.
          <View style={{ backgroundColor: "#FFF4E0", borderRadius: 8, padding: 10, marginTop: 10, alignItems: "center" }}>
            <Text style={{ fontSize: 12.5, color: "#8A5A00", fontWeight: "700", textAlign: "center" }}>🚫 Termina tu carrera actual para aceptar esta</Text>
            <Text style={{ fontSize: 11.5, color: "#8A5A00", marginTop: 2, textAlign: "center" }}>Sigue disponible: si nadie la toma, la puedes agarrar apenas termines.</Text>
          </View>
        ) : c.mi_oferta ? (
          // ya contraoferto: no debe aceptar el precio original por accidente y
          // pisar su propia oferta. Se muestra su oferta pendiente y, si de verdad
          // quiere el original, tiene que confirmarlo (cancela su oferta).
          <View style={{ marginTop: 10 }}>
            <View style={{ backgroundColor: "#EAF1FB", borderRadius: 8, padding: 10 }}>
              <Text style={{ fontSize: 13, color: "#1A56B8", fontWeight: "700" }}>🕒 Ya ofertaste ${c.mi_oferta.toLocaleString()}</Text>
              <Text style={{ fontSize: 11.5, color: "#5a7a9a", marginTop: 2 }}>Esperando que el cliente acepte tu precio o responda.</Text>
            </View>
            <View style={{ flexDirection: "row", gap: 8, marginTop: 8 }}>
              <TouchableOpacity style={[styles.button, { flex: 1, backgroundColor: "#fff", borderWidth: 1, borderColor: "#187830", padding: 10 }]} onPress={() => { setMontoOferta(String(c.mi_oferta)); setContraofertando(c); }}>
                <Text style={{ color: "#187830", fontWeight: "600", fontSize: 13 }}>Cambiar mi oferta</Text>
              </TouchableOpacity>
              {c.tarifa_ofrecida ? (
                <TouchableOpacity style={[styles.button, { flex: 1, backgroundColor: "#fff", borderWidth: 1, borderColor: "#ddd", padding: 10 }]}
                  onPress={() => confirmar("Aceptar el precio original", `Vas a tomar la carrera a $${c.tarifa_ofrecida.toLocaleString()} (el precio del cliente). Esto CANCELA tu oferta de $${c.mi_oferta.toLocaleString()}. ¿Seguro?`, () => aceptar(c), "Sí, aceptar")}>
                  <Text style={{ color: "#888", fontWeight: "600", fontSize: 12.5, textAlign: "center" }}>Aceptar ${c.tarifa_ofrecida.toLocaleString()} original</Text>
                </TouchableOpacity>
              ) : null}
            </View>
          </View>
        ) : c.tarifa_ofrecida ? (
          <View style={{ flexDirection: "row", gap: 8, marginTop: 10 }}>
            <TouchableOpacity style={[styles.button, { flex: 1, backgroundColor: "#187830", padding: 11 }]} onPress={() => aceptar(c)}>
              <Text style={[styles.buttonText, { fontSize: 14 }]}>Aceptar ${c.tarifa_ofrecida.toLocaleString()}</Text>
            </TouchableOpacity>
            <TouchableOpacity style={[styles.button, { flex: 1, backgroundColor: "#fff", borderWidth: 1, borderColor: "#187830", padding: 11 }]} onPress={() => { setMontoOferta(String(sug || c.tarifa_ofrecida)); setContraofertando(c); }}>
              <Text style={{ color: "#187830", fontWeight: "600", fontSize: 14 }}>Proponer otro</Text>
            </TouchableOpacity>
          </View>
        ) : (
          <TouchableOpacity style={[styles.button, { backgroundColor: "#187830", marginTop: 10, padding: 11 }]} onPress={() => aceptar(c)}>
            <Text style={styles.buttonText}>Tomar</Text>
          </TouchableOpacity>
        )
      )}
      {propia && !sinAccionEstado && c.estado === "aceptada" && (
        <TouchableOpacity style={[styles.button, { backgroundColor: "#1A73E8", marginTop: 10, padding: 11 }]} onPress={() => cambiarEstado(c, "en_sitio")}>
          <Text style={styles.buttonText}>📍 Ya estoy en el punto</Text>
        </TouchableOpacity>
      )}
      {propia && !sinAccionEstado && c.estado === "en_sitio" && (
        <TouchableOpacity style={[styles.button, { backgroundColor: "#187830", marginTop: 10, padding: 11 }]} onPress={() => iniciarViajeLocal(c)}>
          <Text style={styles.buttonText}>🚗 Ya lo recogí — Iniciar viaje</Text>
        </TouchableOpacity>
      )}
      {propia && !sinAccionEstado && c.estado === "en_camino" && (
        <TouchableOpacity style={[styles.button, { backgroundColor: "#C0392B", marginTop: 10, padding: 11 }]} onPress={() => finalizar(c)}>
          <Text style={styles.buttonText}>🏁 Finalizar carrera</Text>
        </TouchableOpacity>
      )}
    </View>
    );
  };

  // sugerido para el modal de contraoferta (misma cuenta: recogida + viaje)
  const sugContra = (() => {
    const c = contraofertando;
    if (!c) return null;
    const kmO = miUbic && c.origen_lat != null ? kmEntre(miUbic, { lat: c.origen_lat, lon: c.origen_lon }) : null;
    const kmV = c.distancia_km != null ? c.distancia_km
      : (c.origen_lat != null && c.destino_lat != null
          ? kmEntre({ lat: c.origen_lat, lon: c.origen_lon }, { lat: c.destino_lat, lon: c.destino_lon }) : null);
    return sugeridoConductor(c, kmO, kmV);
  })();

  // Capa 1: las solicitudes se muestran ORDENADAS por cercania del conductor al
  // punto de recogida (la mas cerca arriba). Usa el GPS vivo del conductor; si no
  // lo tiene a mano, la distancia que calculo el backend. Sin datos, al final.
  const kmACliente = (c) => {
    if (miUbic && c.origen_lat != null) return kmEntre(miUbic, { lat: c.origen_lat, lon: c.origen_lon });
    if (c.km_a_recogida != null) return c.km_a_recogida;
    return 9e9;
  };
  const disponiblesOrden = [...disponibles].sort((a, b) => kmACliente(a) - kmACliente(b));

  return (
    <SafeAreaView style={styles.container}>
      {/* ACARREO: prueba de entrega antes de cobrar */}
      <Modal visible={!!entregando} transparent animationType="slide" onRequestClose={() => setEntregando(null)}>
        <View style={{ flex: 1, backgroundColor: "rgba(0,0,0,0.5)", justifyContent: "flex-end" }}>
          <View style={{ backgroundColor: "#fff", borderTopLeftRadius: 22, borderTopRightRadius: 22, padding: 20, paddingBottom: 28 }}>
            <Text style={{ fontSize: 19, fontWeight: "900", color: "#1C2B22" }}>📦 Confirmar entrega</Text>
            <Text style={{ fontSize: 12.5, color: "#888", marginTop: 3 }}>El cliente recibe el aviso con quién recibió y la foto.</Text>
            <Text style={[styles.etiqueta, { marginTop: 14 }]}>¿QUIÉN RECIBIÓ?</Text>
            <TextInput value={recibio} onChangeText={setRecibio} placeholder="Nombre de quien recibió" style={styles.input} maxLength={80} />
            <Text style={styles.etiqueta}>FOTO DE LA ENTREGA</Text>
            {fotoEntrega ? (
              <View style={{ flexDirection: "row", alignItems: "center", gap: 12, marginBottom: 12 }}>
                <Image source={{ uri: fotoEntrega }} style={{ width: 80, height: 80, borderRadius: 10 }} />
                <TouchableOpacity onPress={async () => { const u = await tomarOElegirFoto(); if (u) setFotoEntrega(u); }}>
                  <Text style={{ color: "#1A56B8", fontWeight: "700" }}>Cambiar foto</Text>
                </TouchableOpacity>
              </View>
            ) : (
              <TouchableOpacity onPress={async () => { const u = await tomarOElegirFoto(); if (u) setFotoEntrega(u); }}
                style={{ borderWidth: 1.5, borderStyle: "dashed", borderColor: "#B85C00", borderRadius: 12, padding: 16, alignItems: "center", backgroundColor: "#FFF7EC", marginBottom: 12 }}>
                <Text style={{ fontSize: 26 }}>📷</Text>
                <Text style={{ color: "#B85C00", fontWeight: "800", marginTop: 4 }}>Tomar foto de la carga entregada</Text>
                <Text style={{ color: "#999", fontSize: 11.5, marginTop: 2 }}>Recomendado: te protege a ti y al cliente</Text>
              </TouchableOpacity>
            )}
            <TouchableOpacity style={[styles.button, { backgroundColor: "#187830" }]} onPress={confirmarEntrega} disabled={enviandoEntrega}>
              {enviandoEntrega ? <ActivityIndicator color="#fff" /> : <Text style={styles.buttonText}>{fotoEntrega ? "Confirmar entrega" : "Confirmar sin foto"}</Text>}
            </TouchableOpacity>
            <TouchableOpacity style={{ padding: 12 }} onPress={() => setEntregando(null)}>
              <Text style={{ textAlign: "center", color: "#888", fontWeight: "600" }}>Volver</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      {/* EL PASAJERO CANCELO: aviso encima de todo con el motivo */}
      <Modal visible={!!avisoCancelada} transparent animationType="fade" onRequestClose={cerrarAvisoCancelada}>
        <View style={{ flex: 1, backgroundColor: "rgba(0,0,0,0.6)", justifyContent: "center", padding: 22 }}>
          <View style={{ backgroundColor: "#fff", borderRadius: 22, padding: 22, borderTopWidth: 6, borderTopColor: "#C0392B" }}>
            <Text style={{ fontSize: 40, textAlign: "center" }}>❌</Text>
            <Text style={{ fontSize: 21, fontWeight: "900", color: "#C0392B", textAlign: "center", marginTop: 4 }}>
              {avisoCancelada && avisoCancelada.cancelada_por === "admin" ? "La carrera fue cancelada" : "El pasajero canceló la carrera"}
            </Text>
            {avisoCancelada && (
              <>
                <Text style={{ fontSize: 13.5, color: "#666", textAlign: "center", marginTop: 6 }} numberOfLines={2}>
                  {avisoCancelada.cliente_nombre ? `${avisoCancelada.cliente_nombre} · ` : ""}{avisoCancelada.origen} → {avisoCancelada.destino}
                </Text>
                <View style={{ backgroundColor: "#FDECEA", borderRadius: 12, padding: 14, marginTop: 14 }}>
                  <Text style={{ fontSize: 11.5, color: "#C0392B", fontWeight: "800", letterSpacing: 0.5 }}>MOTIVO</Text>
                  <Text style={{ fontSize: 16, color: "#333", fontWeight: "600", marginTop: 4 }}>
                    {avisoCancelada.motivo_cancelacion || "El pasajero no indicó un motivo"}
                  </Text>
                </View>
                <Text style={{ fontSize: 12.5, color: "#888", textAlign: "center", marginTop: 12 }}>
                  Quedas libre otra vez para recibir solicitudes.
                </Text>
              </>
            )}
            <TouchableOpacity style={[styles.button, { backgroundColor: "#187830", marginTop: 14 }]} onPress={cerrarAvisoCancelada}>
              <Text style={styles.buttonText}>Entendido</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
      <View style={[styles.header, { backgroundColor: "#187830", flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start" }, mias.length > 0 && { paddingTop: 44, paddingBottom: 9 }]}>
        <View>
          <Text style={styles.headerSub}>Hola, {usuario.nombre} 🚕</Text>
          <Text style={[styles.headerTitle, mias.length > 0 && { fontSize: 19, marginTop: 1 }]}>Carreras</Text>
          {esFundador && mias.length === 0 ? <View style={{ marginTop: 6 }}><InsigniaFundador grande /></View> : null}
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

      <ScrollView contentContainerStyle={{ padding: 16, paddingTop: 12 }}>
        {/* ===== PESTAÑA SOLICITUDES: feed en vivo ===== */}
        {tab === "solicitudes" && (
          <>
            {TukanOverlay && !sobreOk && (
              <TouchableOpacity
                style={{ backgroundColor: "#EAF1FB", borderWidth: 1, borderColor: "#A9C4EA", borderRadius: 10, paddingVertical: 7, paddingHorizontal: 11, marginBottom: 8, flexDirection: "row", alignItems: "center", gap: 8 }}
                onPress={() => { try { TukanOverlay.pedirPermiso(); } catch (e) {} }}>
                <Text style={{ fontSize: 15 }}>🪟</Text>
                <Text style={{ flex: 1, fontSize: 11.5, color: "#1A56B8", fontWeight: "600" }}>
                  Activa "Mostrar encima de otras apps" para que las solicitudes te salten aunque estés en otra app · <Text style={{ textDecorationLine: "underline" }}>tocar</Text>
                </Text>
              </TouchableOpacity>
            )}
            {!permisoFondo && Platform.OS !== "web" && (
              <TouchableOpacity
                style={{ backgroundColor: "#FFF6E5", borderWidth: 1, borderColor: "#F0C36D", borderRadius: 10, paddingVertical: 7, paddingHorizontal: 11, marginBottom: 8, flexDirection: "row", alignItems: "center", gap: 8 }}
                onPress={pedirPermisoFondo}>
                <Text style={{ fontSize: 15 }}>🛰️</Text>
                <Text style={{ flex: 1, fontSize: 11.5, color: "#8A5A00", fontWeight: "600" }}>
                  Activa "Ubicación todo el tiempo" para que te vean venir · <Text style={{ textDecorationLine: "underline" }}>tocar</Text>
                </Text>
              </TouchableOpacity>
            )}
            {mias.length > 0 && (
              <>
                <Text style={[styles.seccionTitulo, { marginTop: 0, marginBottom: 8, fontSize: 15 }]}>Tu carrera en curso</Text>
                {(() => {
                  // el conductor tambien ve su ruta: al punto de recogida
                  // (aceptada) o al destino (en_camino), con su 🚗 moviendose
                  const c = mias[0];
                  const yendoARecoger = c.estado === "aceptada" || c.estado === "en_sitio";
                  const punto = yendoARecoger
                    ? (c.origen_lat != null ? { lat: c.origen_lat, lon: c.origen_lon } : null)
                    : (c.destino_lat != null ? { lat: c.destino_lat, lon: c.destino_lon } : null);
                  const destinoPunto = c.destino_lat != null ? { lat: c.destino_lat, lon: c.destino_lon } : null;
                  // a donde navega el boton: yendo a recoger (aceptada) -> a la
                  // recogida; ya en el punto o en viaje -> al DESTINO (si vas a la
                  // recogida estando encima, Maps no traza nada y "rebota")
                  const navTarget = c.estado === "aceptada" ? punto : destinoPunto;
                  if (!punto && !miUbic) return null;
                  const dist = punto && miUbic ? kmEntre(miUbic, punto) : null;
                  const info = rutaCond;
                  // carrera aceptada/en curso = modo navegacion: el mapa es grande
                  // pero deja aire ABAJO para el panel de control (ir, ya lo recogi,
                  // finalizar) sin tener que bajar a buscarlo. Nunca por debajo de 300.
                  const altoMapa = Math.max(300, Dimensions.get("window").height - 430);
                  return (
                    <>
                      {c.estado === "en_sitio" && (
                        <View style={{ backgroundColor: "#E7F0FF", borderRadius: 10, padding: 10, marginBottom: 8 }}>
                          <Text style={{ fontSize: 13, fontWeight: "700", color: "#1A73E8" }}>📍 Estás en el punto de recogida</Text>
                          <Text style={{ fontSize: 12, color: "#555", marginTop: 2 }}>Ya le avisamos al cliente. Cuando suba, toca "Ya lo recogí".</Text>
                        </View>
                      )}
                      <View style={{ height: altoMapa, borderRadius: 14, overflow: "hidden", marginBottom: 10 }}>
                        <MapaSeguimiento key={"cond-" + c.estado}
                          conductor={miUbic}
                          vehiculo={c.vehiculo_pedido}
                          navegacion
                          recogida={c.origen_lat != null ? { lat: c.origen_lat, lon: c.origen_lon } : null}
                          destino={c.destino_lat != null ? { lat: c.destino_lat, lon: c.destino_lon } : null}
                          rutaA={yendoARecoger ? "recogida" : "destino"}
                          onInfo={setRutaCond} lleno />
                      </View>
                      <View style={{ flexDirection: "row", gap: 8, marginBottom: 8 }}>
                        {(info || dist != null) && (
                          <View style={{ flex: 1, backgroundColor: "#EAF6EC", borderRadius: 10, padding: 10, alignItems: "center", justifyContent: "center" }}>
                            <Text style={{ fontSize: 13, fontWeight: "700", color: "#187830" }}>
                              {yendoARecoger ? "📍 Recogida" : "🏁 Destino"}:{" "}
                              {info
                                ? `${info.km < 1 ? `${Math.round(info.km * 1000)} m` : `${info.km.toFixed(1)} km`} · ~${Math.max(1, info.min)} min`
                                : `~${dist < 1 ? `${Math.round(dist * 1000)} m` : `${dist.toFixed(1)} km`}`}
                            </Text>
                          </View>
                        )}
                        {navTarget ? (
                          <TouchableOpacity style={[styles.button, { backgroundColor: "#1A73E8", paddingHorizontal: 14 }]} onPress={() => navegarGoogleMaps(navTarget.lat, navTarget.lon)}>
                            <Text style={[styles.buttonText, { fontSize: 13 }]}>🧭 {c.estado === "aceptada" ? "Iniciar ruta" : "Ir al destino"}</Text>
                          </TouchableOpacity>
                        ) : (c.destino) ? (
                          <TouchableOpacity style={[styles.button, { backgroundColor: "#1A73E8", paddingHorizontal: 14 }]} onPress={() => navegarGoogleMapsTexto(c.destino)}>
                            <Text style={[styles.buttonText, { fontSize: 13 }]}>🧭 Navegar</Text>
                          </TouchableOpacity>
                        ) : null}
                      </View>
                      {/* Acción principal del estado, PEGADA al mapa: el conductor la ve
                          sin tener que bajar a buscarla. El detalle (cliente, llamar,
                          WhatsApp) queda en la tarjeta de abajo. */}
                      {c.estado === "aceptada" && (
                        <TouchableOpacity style={[styles.button, { backgroundColor: "#1A73E8", padding: 13, marginBottom: 10 }]} onPress={() => cambiarEstado(c, "en_sitio")}>
                          <Text style={styles.buttonText}>📍 Ya estoy en el punto de recogida</Text>
                        </TouchableOpacity>
                      )}
                      {c.estado === "en_sitio" && (
                        <TouchableOpacity style={[styles.button, { backgroundColor: "#187830", padding: 13, marginBottom: 10 }]} onPress={() => iniciarViajeLocal(c)}>
                          <Text style={styles.buttonText}>🚗 Ya lo recogí — Iniciar viaje</Text>
                        </TouchableOpacity>
                      )}
                      {c.estado === "en_camino" && (
                        <TouchableOpacity style={[styles.button, { backgroundColor: "#C0392B", padding: 13, marginBottom: 10 }]} onPress={() => finalizar(c)}>
                          <Text style={styles.buttonText}>🏁 Finalizar carrera</Text>
                        </TouchableOpacity>
                      )}
                      {c.estado === "en_camino" && !punto && (
                        <View style={{ backgroundColor: "#FFF3E6", borderRadius: 10, padding: 10, marginBottom: 10 }}>
                          <Text style={{ fontSize: 13, fontWeight: "700", color: "#B85C00" }}>🏁 Destino: {limpiaDir(c.destino)}</Text>
                          <Text style={{ fontSize: 11, color: "#8A5A00", marginTop: 2 }}>Este destino se pidió sin ubicación en el mapa. Usa 🧭 Navegar para ir por el nombre.</Text>
                        </View>
                      )}
                    </>
                  );
                })()}
                {mias.map(c => tarjeta(c, true, true))}
                <View style={{ height: 8 }} />
              </>
            )}

            {/* MAPA SIEMPRE ABIERTO (sin carrera activa): muestra donde estas y,
                cuando hay solicitud, traza la ruta hasta la recogida para dar
                contexto y decidir/contraofertar rapido */}
            {mias.length === 0 && disponible && disponibles.length === 0 && (() => {
              const foco = disponiblesOrden.find(c => c.origen_lat != null) || null;
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
                  {/* esperando sin solicitudes = el mapa manda (ocupa casi toda la
                      pantalla); cuando entra una solicitud se achica para dejar ver
                      la tarjeta. Nunca baja de 360. */}
                  <View style={{ height: disponibles.length > 0 ? 300 : Math.max(360, Dimensions.get("window").height - 330), borderRadius: 14, overflow: "hidden", marginBottom: 8 }}>
                    <MapaSeguimiento key={"prev-" + (foco ? foco.id : "solo")}
                      conductor={miUbic}
                      vehiculo={usuario.tipo_vehiculo}
                      navegacion
                      recogida={punto}
                      destino={foco && foco.destino_lat != null ? { lat: foco.destino_lat, lon: foco.destino_lon } : null}
                      rutaA="recogida"
                      onInfo={setRutaPreview} lleno />
                  </View>
                  {/* solo cuando hay una solicitud a la vista: la distancia hasta la
                      recogida. Esperando (sin foco) no se muestra nada (el banner de
                      abajo ya dice "Buscando viajes"). */}
                  {foco && (
                    <View style={{ backgroundColor: "#FFF3E6", borderRadius: 10, padding: 10, marginBottom: 12, flexDirection: "row", alignItems: "center", gap: 8 }}>
                      <Text style={{ fontSize: 16 }}>🚗</Text>
                      <Text style={{ flex: 1, fontSize: 12.5, fontWeight: "600", color: "#B85C00" }}>
                        {rutaPreview ? `Recogida a ${km} · ~${Math.max(1, rutaPreview.min)} min de ti` : "Calculando la ruta hasta la recogida…"}
                      </Text>
                    </View>
                  )}
                </>
              );
            })()}

            {/* Feed de solicitudes: SOLO cuando NO estas en servicio. En servicio
                mandan el mapa + la tarjeta del viaje; el banner inferior "En
                servicio" es el unico indicador (no se repite el mismo mensaje ni
                se le roba espacio al mapa). */}
            {/* Desconectado: un recordatorio (el mapa no se muestra si no estas
                disponible). */}
            {mias.length === 0 && !disponible && (
              <View style={{ alignItems: "center", padding: 24 }}>
                <Text style={{ fontSize: 34 }}>🔌</Text>
                <Text style={{ color: "#888", marginTop: 8, textAlign: "center" }}>Estás desconectado.{"\n"}Conéctate abajo para recibir solicitudes.</Text>
              </View>
            )}
            {/* Solicitudes: SOLO cuando hay alguna (encabezado + tarjetas). Conectado
                SIN solicitudes = el mapa grande + el banner "Buscando viajes" de abajo
                es el unico indicador (no se repite el mensaje ni se deja el hueco). */}
            {mias.length === 0 && disponibles.length > 0 && (
              <>
                <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
                  <Text style={styles.seccionTitulo}>Solicitudes en vivo</Text>
                  <View style={{ flexDirection: "row", alignItems: "center", gap: 5 }}>
                    <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: "#2E7D32" }} />
                    <Text style={{ fontSize: 11, color: "#2E7D32", fontWeight: "600" }}>EN VIVO · {disponibles.length}</Text>
                  </View>
                </View>
                {disponiblesOrden.map(c => {
                  // recien llegada (< 6s): tarjeta grande con cuenta regresiva y
                  // contraoferta rapida. Pasados los 6s baja al listado normal.
                  const restante = VENTANA - (ahora - (recibidas.current[c.id] || 0));
                  return tarjetaLista(c, restante);
                })}
              </>
            )}
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
        {/* ===== HISTORIAL del conductor (dentro de Desempeño) ===== */}
        {tab === "desempeno" && (
          <>
            <Text style={styles.seccionTitulo}>📜 Historial de carreras</Text>
            {historial.length === 0 ? (
              <Text style={{ color: "#888", textAlign: "center", padding: 20 }}>Aún no tienes carreras terminadas. Aquí quedará tu historial.</Text>
            ) : <HistorialFiltrado historial={historial} />}
          </>
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

        {tab === "otraciudad" && (
          <>
            <View style={{ backgroundColor: "#EAF1FB", borderRadius: 10, padding: 12, marginBottom: 12 }}>
              <Text style={{ fontWeight: "800", color: "#1A56B8", fontSize: 14 }}>🚌 Viajes a otra ciudad (expresos)</Text>
              <Text style={{ fontSize: 12, color: "#3a5a8a", marginTop: 2 }}>Viajes que salen de {usuario.municipio}. Tómalos al precio del cliente o propón tu precio por cupo.</Text>
            </View>

            {misExpresos.length > 0 && (
              <>
                <Text style={styles.seccionTitulo}>Tus viajes tomados</Text>
                {misExpresos.map(e => (
                  <View key={e.id} style={[styles.card, { marginBottom: 10, borderLeftWidth: 3, borderLeftColor: "#187830" }]}>
                    <Text style={{ fontWeight: "700", fontSize: 15 }}>{e.origen_municipio} → {e.destino_municipio}</Text>
                    <Text style={{ fontSize: 12.5, color: "#555", marginTop: 2 }}>{e.cupos} cupo(s) · ${(e.tarifa_cupo || e.precio_por_cupo).toLocaleString()}/cupo · total ${((e.tarifa_cupo || e.precio_por_cupo) * e.cupos).toLocaleString()}</Text>
                    <View style={{ backgroundColor: e.salida ? "#FFF3E6" : "#EAF6EC", borderRadius: 8, paddingVertical: 6, paddingHorizontal: 9, alignSelf: "flex-start", marginTop: 4 }}>
                      <Text style={{ fontSize: 13, fontWeight: "700", color: e.salida ? "#B85C00" : "#187830" }}>{e.salida ? `🗓️ Sale: ${fmtRecogida(e.salida)}` : "🟢 Lo antes posible"}</Text>
                    </View>
                    <Text style={{ fontSize: 13, color: "#333", marginTop: 6 }}>🟢 Recoge: {e.origen}</Text>
                    {e.destino_detalle ? <Text style={{ fontSize: 13, color: "#333" }}>🏁 Deja: {e.destino_detalle}</Text> : null}
                    <Text style={{ fontSize: 12, color: "#999", marginTop: 4 }}>👤 {e.cliente_nombre} · 📞 {e.cliente_telefono}</Text>
                    {e.estado === "en_camino" && (
                      <View style={{ backgroundColor: "#E7F0FF", borderRadius: 8, padding: 8, marginTop: 6 }}>
                        <Text style={{ fontSize: 12.5, color: "#1A73E8", fontWeight: "700" }}>🚗 En recorrido hacia {e.destino_municipio}</Text>
                      </View>
                    )}
                    {/* navegacion segun la fase: si aun no recoge -> a la recogida;
                        si ya va en recorrido -> al destino (por coords o por texto) */}
                    {e.estado === "aceptado" && e.origen_lat != null && (
                      <TouchableOpacity style={[styles.button, { backgroundColor: "#1A73E8", padding: 10, marginTop: 8 }]} onPress={() => navegarGoogleMaps(e.origen_lat, e.origen_lon)}>
                        <Text style={[styles.buttonText, { fontSize: 13 }]}>🧭 Ir a recoger</Text>
                      </TouchableOpacity>
                    )}
                    {e.estado === "en_camino" && (
                      <TouchableOpacity style={[styles.button, { backgroundColor: "#1A73E8", padding: 10, marginTop: 8 }]} onPress={() => irAlDestinoExpreso(e)}>
                        <Text style={[styles.buttonText, { fontSize: 13 }]}>🧭 Ir al destino</Text>
                      </TouchableOpacity>
                    )}
                    <View style={{ flexDirection: "row", gap: 8, marginTop: 8 }}>
                      <TouchableOpacity style={[styles.button, { flex: 1, backgroundColor: "#187830", padding: 10 }]} onPress={() => llamar(e.cliente_telefono)}>
                        <Text style={[styles.buttonText, { fontSize: 13 }]}>📞 Llamar</Text>
                      </TouchableOpacity>
                      <TouchableOpacity style={[styles.button, { flex: 1, backgroundColor: "#25D366", padding: 10 }]} onPress={() => whatsapp(e.cliente_telefono)}>
                        <Text style={[styles.buttonText, { fontSize: 13 }]}>💬 WhatsApp</Text>
                      </TouchableOpacity>
                    </View>
                    {/* la SECUENCIA arranca al recoger: aceptado -> (recogí) en_camino -> finalizado */}
                    {e.estado === "aceptado" ? (
                      <TouchableOpacity style={[styles.button, { backgroundColor: "#187830", marginTop: 8, padding: 11 }]}
                        onPress={() => confirmar("Iniciar recorrido", `¿Ya recogiste al pasajero y arrancas hacia ${e.destino_municipio}? Se abrirá la navegación.`, () => iniciarRecorridoExpreso(e), "Sí, arrancar")}>
                        <Text style={styles.buttonText}>🚗 Ya recogí — Iniciar recorrido</Text>
                      </TouchableOpacity>
                    ) : (
                      <TouchableOpacity style={[styles.button, { backgroundColor: "#C0392B", marginTop: 8, padding: 11 }]}
                        onPress={() => confirmar("Finalizar viaje", `¿Ya llegaste a ${e.destino_municipio}?`, () => userFetch(`${API}/expresos/${e.id}/estado?estado=finalizado`, { method: "PUT" }).then(cargarExpresos).catch(() => {}), "Sí, finalizar")}>
                        <Text style={styles.buttonText}>🏁 Finalizar viaje</Text>
                      </TouchableOpacity>
                    )}
                  </View>
                ))}
              </>
            )}

            <Text style={styles.seccionTitulo}>Disponibles</Text>
            {expresosDisp.length === 0 ? (
              <View style={{ alignItems: "center", padding: 24 }}>
                <Text style={{ fontSize: 34 }}>🚌</Text>
                <Text style={{ color: "#888", marginTop: 8, textAlign: "center" }}>No hay viajes a otra ciudad ahora.{"\n"}Cuando alguien publique uno desde {usuario.municipio}, aparece aquí.</Text>
              </View>
            ) : expresosDisp.map(e => (
              <View key={e.id} style={[styles.card, { marginBottom: 10 }]}>
                <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
                  <Text style={{ fontWeight: "700", fontSize: 15 }}>{e.origen_municipio} → {e.destino_municipio}</Text>
                  <Text style={{ fontSize: 18, fontWeight: "bold", color: "#187830" }}>${e.precio_por_cupo.toLocaleString()}</Text>
                </View>
                <Text style={{ fontSize: 12.5, color: "#555", marginTop: 2 }}>{e.cupos} cupo(s) · total ${(e.precio_por_cupo * e.cupos).toLocaleString()}</Text>
                <View style={{ backgroundColor: e.salida ? "#FFF3E6" : "#EAF6EC", borderRadius: 8, paddingVertical: 6, paddingHorizontal: 9, alignSelf: "flex-start", marginTop: 4 }}>
                  <Text style={{ fontSize: 13, fontWeight: "700", color: e.salida ? "#B85C00" : "#187830" }}>{e.salida ? `🗓️ Sale: ${fmtRecogida(e.salida)}` : "🟢 Lo antes posible"}</Text>
                </View>
                <Text style={{ fontSize: 13, color: "#333", marginTop: 6 }}>🟢 Recoge: {e.origen}</Text>
                {e.destino_detalle ? <Text style={{ fontSize: 13, color: "#333" }}>🏁 Deja: {e.destino_detalle}</Text> : null}
                {e.notas ? <Text style={{ fontSize: 12, color: "#888", marginTop: 2 }}>📝 {e.notas}</Text> : null}
                <Text style={{ fontSize: 12, color: "#999", marginTop: 4 }}>👤 {e.cliente_nombre}</Text>
                <TouchableOpacity onPress={() => setVerExp(e)} style={{ marginTop: 8, backgroundColor: "#EAF1FB", borderRadius: 8, paddingVertical: 10, alignItems: "center" }}>
                  <Text style={{ color: "#1A56B8", fontWeight: "700", fontSize: 13 }}>🔍 Ver detalles y mapa</Text>
                </TouchableOpacity>
                {e.mi_oferta ? (
                  <View style={{ marginTop: 10 }}>
                    <View style={{ backgroundColor: "#EAF1FB", borderRadius: 8, padding: 10 }}>
                      <Text style={{ fontSize: 13, color: "#1A56B8", fontWeight: "700" }}>🕒 Ya ofertaste ${e.mi_oferta.toLocaleString()}/cupo</Text>
                      <Text style={{ fontSize: 11.5, color: "#5a7a9a", marginTop: 2 }}>Esperando que el cliente responda.</Text>
                    </View>
                    <TouchableOpacity style={[styles.button, { backgroundColor: "#fff", borderWidth: 1, borderColor: "#187830", padding: 10, marginTop: 8 }]} onPress={() => { setMontoExp(String(e.mi_oferta)); setOfExpreso(e); }}>
                      <Text style={{ color: "#187830", fontWeight: "600", fontSize: 13 }}>Cambiar mi oferta</Text>
                    </TouchableOpacity>
                  </View>
                ) : (
                  <View style={{ flexDirection: "row", gap: 8, marginTop: 10 }}>
                    <TouchableOpacity style={[styles.button, { flex: 1, backgroundColor: "#187830", padding: 11 }]} onPress={() => aceptarExpreso(e)}>
                      <Text style={[styles.buttonText, { fontSize: 13 }]}>Tomar ${e.precio_por_cupo.toLocaleString()}/cupo</Text>
                    </TouchableOpacity>
                    <TouchableOpacity style={[styles.button, { flex: 1, backgroundColor: "#fff", borderWidth: 1, borderColor: "#187830", padding: 11 }]} onPress={() => { setMontoExp(String(e.precio_por_cupo)); setOfExpreso(e); }}>
                      <Text style={{ color: "#187830", fontWeight: "600", fontSize: 13 }}>Proponer otro</Text>
                    </TouchableOpacity>
                  </View>
                )}
              </View>
            ))}
          </>
        )}

      </ScrollView>

      {/* barra de ESTADO (el tic-tac): Conectado -> Buscando -> Viaje disponible.
          En carrera en curso NO se muestra: el detalle ya está en la tarjeta de
          arriba y ese espacio se lo damos al mapa de navegación. */}
      {mias.length === 0 && (() => {
        const enServicio = false;
        const hayDisp = disponibles.length > 0;
        let e;
        if (!disponible) e = { txt: "Desconectado", sub: "Toca aquí para conectarte y recibir viajes", color: "#C0392B", pulse: false };
        else if (hayDisp) e = { txt: "🚗 ¡Viaje disponible!", sub: `${disponibles.length} solicitud${disponibles.length > 1 ? "es" : ""} esperando`, color: "#F06000", pulse: true };
        else e = { txt: "Buscando viajes…", sub: "Estás conectado. Te avisamos apenas entre uno", color: "#187830", pulse: true };
        return (
          <TouchableOpacity activeOpacity={enServicio ? 1 : 0.7} onPress={enServicio ? undefined : cambiarDisponibilidad}
            style={[styles.barraEstado, { borderTopColor: e.color }]}>
            <PuntoVivo color={e.color} activo={e.pulse} />
            <View style={{ flex: 1 }}>
              <Text style={{ fontSize: 13.5, fontWeight: "700", color: e.color }}>{e.txt}</Text>
              <Text style={{ fontSize: 11, color: "#888", marginTop: 1 }}>{e.sub}</Text>
            </View>
            {disponible && !enServicio && hayDisp ? (
              <Text style={{ fontSize: 22, fontWeight: "800", color: e.color }}>{disponibles.length}</Text>
            ) : !enServicio ? (
              <View style={{ backgroundColor: disponible ? "#FDECEA" : "#E8F5E9", borderRadius: 16, paddingVertical: 6, paddingHorizontal: 12 }}>
                <Text style={{ fontSize: 12, fontWeight: "800", color: disponible ? "#C0392B" : "#187830" }}>{disponible ? "Desconectar" : "Conectar"}</Text>
              </View>
            ) : null}
          </TouchableOpacity>
        );
      })()}

      {/* barra de pestañas (con espacio para la barra del sistema en Samsung y similares) */}
      <View style={[styles.tabBar, { paddingBottom: Math.max(insets.bottom, 8) }]}>
        {[["solicitudes", "📋", "Solicitudes"], ["otraciudad", "🚌", "Otra ciudad"], ["desempeno", "📊", "Desempeño"], ["cartera", "💳", "Cartera"], ["salir", "🚪", "Salir"]].map(([k, ic, lbl]) => (
          <TouchableOpacity key={k} style={styles.tabBarItem}
            onPress={() => k === "salir" ? (detenerRastreoFondo(), navigation.replace("Login")) : (animar(), setTab(k))}>
            <Text style={{ fontSize: 20, opacity: tab === k ? 1 : 0.5 }}>{ic}</Text>
            <Text style={{ fontSize: 10, marginTop: 2, color: tab === k ? "#187830" : "#999", fontWeight: tab === k ? "700" : "400" }} numberOfLines={1}>{lbl}</Text>
          </TouchableOpacity>
        ))}
      </View>

      <Modal visible={!!cobrando} transparent animationType="fade" onRequestClose={() => setCobrando(null)}>
        <KeyboardAvoidingView style={styles.fondoModal} behavior={Platform.OS === "ios" ? "padding" : "height"}>
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
        </KeyboardAvoidingView>
      </Modal>

      <ModalEstrellas
        visible={!!calificarCliente}
        titulo="Califica al cliente"
        subtitulo={calificarCliente ? `¿Cómo fue el servicio con ${calificarCliente.cliente_nombre || "el cliente"}?` : ""}
        onEnviar={(estrellas, comentario) => {
          const id = calificarCliente && calificarCliente.id;
          setCalificarCliente(null);
          if (id) userFetch(`${API}/carreras/${id}/calificar?estrellas=${estrellas}${comentario ? `&comentario=${encodeURIComponent(comentario)}` : ""}`, { method: "PUT" }).catch(() => {});
        }}
        onCerrar={() => setCalificarCliente(null)}
      />

      {/* DETALLE de una solicitud (tipo inDrive): mapa con A/B, precio grande,
          pasajero con foto, aceptar y ofertas de un toque */}
      {(() => {
        const c = detalle && disponibles.find(x => x.id === detalle.id);
        if (!c) return null;
        const { kmAlOrigen, kmViaje } = kmsDe(c);
        const of = c.tarifa_ofrecida;
        const sug = sugeridoConductor(c, kmAlOrigen, kmViaje);
        const ofertas = [];
        if (sug && of && sug > of) ofertas.push(sug);
        for (const m of sugerencias(of)) if (!ofertas.includes(m)) ofertas.push(m);
        const cerrar = () => setDetalle(null);
        const hayMapa = c.origen_lat != null || !!miUbic;
        return (
          <Modal visible transparent animationType="slide" onRequestClose={cerrar}>
            <View style={sl.fondo}>
              <TouchableOpacity style={{ flex: 1 }} activeOpacity={1} onPress={cerrar} />
              <View style={sl.hoja}>
                {hayMapa ? (
                  <View style={sl.mapa}>
                    <MapaSeguimiento key={"det-" + c.id}
                      conductor={miUbic}
                      vehiculo={usuario.tipo_vehiculo}
                      recogida={c.origen_lat != null ? { lat: c.origen_lat, lon: c.origen_lon } : null}
                      destino={c.destino_lat != null ? { lat: c.destino_lat, lon: c.destino_lon } : null}
                      rutaA="recogida"
                      onInfo={setRutaDet} lleno />
                    {(rutaDet || kmAlOrigen != null) && (
                      <View style={sl.mapaChip} pointerEvents="none">
                        <Text style={{ color: "#fff", fontWeight: "800", fontSize: 13.5 }}>
                          {rutaDet ? `${Math.max(1, rutaDet.min)} min · ${fmtKmL(rutaDet.km)}` : `~${fmtKmL(kmAlOrigen)}`} a la recogida
                        </Text>
                      </View>
                    )}
                  </View>
                ) : null}
                <ScrollView contentContainerStyle={{ padding: 18, paddingBottom: 26 }}>
                  <Text style={sl.titulo}>{esCarga(c.vehiculo_pedido) ? "Solicitud de acarreo" : "Solicitud de viaje"}</Text>

                  <View style={{ flexDirection: "row", marginTop: 14 }}>
                    <View style={{ alignItems: "center", width: 74, marginRight: 12 }}>
                      <AvatarPasajero c={c} tam={60} />
                      <Text style={{ fontSize: 13, fontWeight: "700", color: "#1D1D1D", marginTop: 5 }} numberOfLines={1}>{(c.cliente_nombre || "Pasajero").split(" ")[0]}</Text>
                      <Text style={{ fontSize: 12.5, color: "#555" }}>★ {c.cliente_calificacion ? Number(c.cliente_calificacion).toFixed(1) : "Nuevo"}</Text>
                      <Text style={{ fontSize: 11.5, color: "#999" }}>{haceCuanto(c.fecha)}</Text>
                    </View>
                    <View style={{ flex: 1 }}>
                      <Text style={{ fontSize: 13.5, color: "#777" }}>
                        {vehLabel(c.vehiculo_pedido)}{kmViaje != null ? ` · viaje ${fmtKmL(kmViaje)}` : ""}
                      </Text>
                      <Text style={[sl.precio, { fontSize: 34 }]}><Text style={sl.moneda}>$ </Text>{of ? of.toLocaleString() : "A convenir"}</Text>
                      <View style={[sl.filaRuta, { marginTop: 10 }]}>
                        <View style={[sl.letra, { backgroundColor: "#187830" }]}><Text style={sl.letraTxt}>A</Text></View>
                        <View style={{ flex: 1 }}>
                          <Text style={sl.dir}>{limpiaDir(c.origen)}</Text>
                          {c.origen_detalle ? <Text style={{ fontSize: 13, color: "#777", marginTop: 1 }}>{c.origen_detalle}</Text> : null}
                        </View>
                      </View>
                      <View style={[sl.filaRuta, { marginTop: 10 }]}>
                        <View style={[sl.letra, { backgroundColor: "#F06000" }]}><Text style={sl.letraTxt}>B</Text></View>
                        <View style={{ flex: 1 }}>
                          <Text style={sl.dir}>{limpiaDir(c.destino)}</Text>
                          {c.destino_detalle ? <Text style={{ fontSize: 13, color: "#777", marginTop: 1 }}>{c.destino_detalle}</Text> : null}
                        </View>
                      </View>
                    </View>
                  </View>

                  {c.recogida ? (
                    <View style={{ backgroundColor: "#FFF4DD", borderRadius: 12, padding: 10, marginTop: 12 }}>
                      <Text style={{ fontSize: 13.5, color: "#8A5A00", fontWeight: "700" }}>Recogida programada: {fmtRecogida(c.recogida)}</Text>
                    </View>
                  ) : null}
                  {c.notas ? (
                    <View style={{ backgroundColor: "#F6F7F4", borderRadius: 12, padding: 10, marginTop: 12 }}>
                      <Text style={{ fontSize: 13.5, color: "#444" }}>{c.notas}</Text>
                    </View>
                  ) : null}
                  <DetalleAcarreo c={c} />
                  {sug != null && (
                    <Text style={{ fontSize: 13, color: "#777", marginTop: 12 }}>Precio sugerido por distancia: <Text style={{ fontWeight: "800", color: "#1D1D1D" }}>${sug.toLocaleString()}</Text></Text>
                  )}

                  <View style={{ marginTop: 16 }}>
                    {tieneCarreraActiva ? (
                      <View style={{ backgroundColor: "#FFF4E0", borderRadius: 12, padding: 12 }}>
                        <Text style={{ fontSize: 13.5, color: "#8A5A00", fontWeight: "700", textAlign: "center" }}>Termina tu carrera actual para aceptar esta</Text>
                      </View>
                    ) : c.mi_oferta ? (
                      <>
                        <View style={{ backgroundColor: "#E6EEFB", borderRadius: 12, padding: 12, marginBottom: 10 }}>
                          <Text style={{ fontSize: 14, color: "#1A56B8", fontWeight: "700" }}>Ya ofertaste ${c.mi_oferta.toLocaleString()}</Text>
                          <Text style={{ fontSize: 12.5, color: "#5a7a9a", marginTop: 2 }}>Esperando que el pasajero acepte tu precio.</Text>
                        </View>
                        <TouchableOpacity style={sl.btnGris} onPress={() => { cerrar(); setMontoOferta(String(c.mi_oferta)); setContraofertando(c); }}>
                          <Text style={sl.btnGrisTxt}>Cambiar mi oferta</Text>
                        </TouchableOpacity>
                      </>
                    ) : (
                      <>
                        <TouchableOpacity style={sl.btnAceptar} onPress={() => { cerrar(); aceptar(c); }}>
                          <Text style={sl.btnAceptarTxt}>{of ? `Aceptar por $${of.toLocaleString()}` : "Tomar solicitud"}</Text>
                        </TouchableOpacity>
                        {of ? (
                          <>
                            <Text style={{ textAlign: "center", color: "#777", fontSize: 14.5, marginTop: 14, marginBottom: 8 }}>Ofrece tu tarifa</Text>
                            <ScrollView horizontal showsHorizontalScrollIndicator={false}>
                              {ofertas.map(m => (
                                <TouchableOpacity key={m} style={sl.oferta} onPress={() => { cerrar(); enviarOferta(c.id, m); }}>
                                  <Text style={sl.ofertaTxt}>${m.toLocaleString()}</Text>
                                </TouchableOpacity>
                              ))}
                              <TouchableOpacity style={sl.oferta} onPress={() => { cerrar(); setMontoOferta(String(sug || of || "")); setContraofertando(c); }}>
                                <Text style={sl.ofertaTxt}>Otro valor</Text>
                              </TouchableOpacity>
                            </ScrollView>
                          </>
                        ) : (
                          <TouchableOpacity style={[sl.btnGris, { marginTop: 10 }]} onPress={() => { cerrar(); setMontoOferta(String(sug || "")); setContraofertando(c); }}>
                            <Text style={sl.btnGrisTxt}>Proponer precio</Text>
                          </TouchableOpacity>
                        )}
                      </>
                    )}
                    <TouchableOpacity style={[sl.btnGris, { marginTop: 12 }]} onPress={cerrar}>
                      <Text style={sl.btnGrisTxt}>Cerrar</Text>
                    </TouchableOpacity>
                  </View>
                </ScrollView>
              </View>
            </View>
          </Modal>
        );
      })()}

      {/* RECUADRO tipo Uber: salta cuando entra una solicitud, con barra de 10s */}
      <Modal visible={!!entrante} transparent animationType="fade" onRequestClose={cerrarEntrante}>
        <View style={styles.entranteFondo}>
          <Animated.View style={[styles.entranteCard, { transform: [{ scale: escalaEntrante }] }]}>
            <View style={styles.entranteBarraBg}>
              <Animated.View style={[styles.entranteBarra, { width: barraEntrante.interpolate({ inputRange: [0, 1], outputRange: ["0%", "100%"] }) }]} />
            </View>
            {entrante && (() => {
              const c = entrante;
              const kmAlOrigen = miUbic && c.origen_lat != null ? kmEntre(miUbic, { lat: c.origen_lat, lon: c.origen_lon }) : null;
              const kmViaje = c.distancia_km != null ? c.distancia_km
                : (c.origen_lat != null && c.destino_lat != null
                    ? kmEntre({ lat: c.origen_lat, lon: c.origen_lon }, { lat: c.destino_lat, lon: c.destino_lon }) : null);
              const fmt = (k) => (k < 1 ? `${Math.round(k * 1000)} m` : `${k.toFixed(1)} km`);
              const sug = sugeridoConductor(c, kmAlOrigen, kmViaje);
              return (
                <View style={{ padding: 18 }}>
                  <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
                    <Text style={{ fontSize: 13, fontWeight: "800", letterSpacing: 1, color: "#F06000" }}>🔔 NUEVA SOLICITUD</Text>
                    {c.tarifa_ofrecida ? <Text style={{ fontSize: 24, fontWeight: "bold", color: "#187830" }}>${c.tarifa_ofrecida.toLocaleString()}</Text> : null}
                  </View>
                  <Text style={{ fontSize: 15, fontWeight: "700", color: "#444", marginTop: 8 }}>
                    {vehIcono(c.vehiculo_pedido)} {vehLabel(c.vehiculo_pedido)}{esCarga(c.vehiculo_pedido) ? " · trasteo" : ""}{c.zona === "rural" ? " · 🌄 vereda" : ""}
                  </Text>
                  <Text style={{ fontSize: 15, color: "#333", marginTop: 8 }} numberOfLines={1}>🟢 {limpiaDir(c.origen)}</Text>
                  <Text style={{ fontSize: 15, color: "#333", marginTop: 2 }} numberOfLines={1}>🏁 {limpiaDir(c.destino)}</Text>
                  <DetalleAcarreo c={c} compacto />
                  <View style={{ flexDirection: "row", gap: 8, marginTop: 10, flexWrap: "wrap" }}>
                    {kmAlOrigen != null && (
                      <View style={{ backgroundColor: "#EAF6EC", borderRadius: 8, paddingVertical: 4, paddingHorizontal: 9 }}>
                        <Text style={{ fontSize: 12.5, color: "#187830", fontWeight: "700" }}>📍 Recogida a ~{fmt(kmAlOrigen)}</Text>
                      </View>
                    )}
                    {kmViaje != null && (
                      <View style={{ backgroundColor: "#FFF3E6", borderRadius: 8, paddingVertical: 4, paddingHorizontal: 9 }}>
                        <Text style={{ fontSize: 12.5, color: "#B85C00", fontWeight: "700" }}>🛣️ Viaje ~{fmt(kmViaje)}</Text>
                      </View>
                    )}
                  </View>
                  {sug != null && (
                    <View style={{ backgroundColor: "#EAF1FB", borderRadius: 8, paddingVertical: 6, paddingHorizontal: 9, marginTop: 9, alignSelf: "flex-start" }}>
                      <Text style={{ fontSize: 12.5, color: "#1A56B8", fontWeight: "700" }}>💡 Sugerido (recogida + viaje): ${sug.toLocaleString()}</Text>
                    </View>
                  )}
                  <Text style={{ fontSize: 12.5, color: "#999", marginTop: 8 }}>👤 {c.cliente_nombre}</Text>
                  <View style={{ flexDirection: "row", gap: 10, marginTop: 14 }}>
                    <TouchableOpacity style={[styles.button, { flex: 1.3, backgroundColor: "#187830", padding: 13 }]} onPress={() => { cerrarEntrante(); aceptar(c); }}>
                      <Text style={styles.buttonText}>Aceptar{c.tarifa_ofrecida ? ` $${c.tarifa_ofrecida.toLocaleString()}` : ""}</Text>
                    </TouchableOpacity>
                    <TouchableOpacity style={[styles.button, { flex: 1, backgroundColor: "#fff", borderWidth: 1, borderColor: "#187830", padding: 13 }]} onPress={() => { cerrarEntrante(); setMontoOferta(String(sug || c.tarifa_ofrecida || "")); setContraofertando(c); }}>
                      <Text style={{ color: "#187830", fontWeight: "700" }}>Contraofertar</Text>
                    </TouchableOpacity>
                  </View>
                  <TouchableOpacity style={{ padding: 10, marginTop: 4 }} onPress={cerrarEntrante}>
                    <Text style={{ textAlign: "center", color: "#999", fontSize: 13 }}>Descartar</Text>
                  </TouchableOpacity>
                </View>
              );
            })()}
          </Animated.View>
        </View>
      </Modal>

      <Modal visible={!!contraofertando} transparent animationType="fade" onRequestClose={() => setContraofertando(null)}>
        <KeyboardAvoidingView style={styles.fondoModal} behavior={Platform.OS === "ios" ? "padding" : "height"}>
          <View style={styles.ventanaModal}>
            <Text style={{ fontSize: 17, fontWeight: "bold", color: "#333" }}>Proponer tu precio</Text>
            <Text style={{ fontSize: 13, color: "#888", marginTop: 4, marginBottom: contraofertando && sugContra != null ? 8 : 14 }}>
              {contraofertando && contraofertando.tarifa_ofrecida
                ? `El cliente ofrece $${contraofertando.tarifa_ofrecida.toLocaleString()}. Cuanto quieres cobrar?`
                : "Cuanto quieres cobrar?"}
            </Text>
            {contraofertando && sugContra != null && (
              <TouchableOpacity onPress={() => setMontoOferta(String(sugContra))} style={{ backgroundColor: "#EAF1FB", borderRadius: 8, paddingVertical: 7, paddingHorizontal: 10, marginBottom: 14, alignSelf: "flex-start" }}>
                <Text style={{ fontSize: 12.5, color: "#1A56B8", fontWeight: "700" }}>💡 Sugerido (recogida + viaje): ${sugContra.toLocaleString()} · tocar para usar</Text>
              </TouchableOpacity>
            )}
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
        </KeyboardAvoidingView>
      </Modal>

      {/* contraoferta de un EXPRESO (precio por cupo) */}
      <Modal visible={!!ofExpreso} transparent animationType="fade" onRequestClose={() => setOfExpreso(null)}>
        <KeyboardAvoidingView style={styles.fondoModal} behavior={Platform.OS === "ios" ? "padding" : "height"}>
          <View style={styles.ventanaModal}>
            <Text style={{ fontSize: 17, fontWeight: "bold", color: "#333" }}>Tu precio por cupo</Text>
            <Text style={{ fontSize: 13, color: "#888", marginTop: 4, marginBottom: 14 }}>
              {ofExpreso ? `${ofExpreso.origen_municipio} → ${ofExpreso.destino_municipio} · ${ofExpreso.cupos} cupo(s). El cliente ofrece $${ofExpreso.precio_por_cupo.toLocaleString()}/cupo.` : ""}
            </Text>
            <View style={styles.ofertaFila}>
              <Text style={{ fontSize: 22, fontWeight: "bold", color: "#187830" }}>$</Text>
              <TextInput value={montoExp} onChangeText={(t) => setMontoExp(t.replace(/\D/g, ""))}
                placeholder="0" keyboardType="number-pad" style={styles.ofertaInput} autoFocus />
              <Text style={{ fontSize: 14, color: "#888" }}>/cupo</Text>
            </View>
            {ofExpreso && parseInt(montoExp || "0", 10) > 0 ? (
              <Text style={{ fontSize: 12.5, color: "#187830", fontWeight: "700", marginTop: 6 }}>Total: ${(parseInt(montoExp, 10) * ofExpreso.cupos).toLocaleString()}</Text>
            ) : null}
            <View style={{ flexDirection: "row", gap: 10, marginTop: 14 }}>
              <TouchableOpacity style={[styles.button, { flex: 1, backgroundColor: "#fff", borderWidth: 1, borderColor: "#ddd" }]} onPress={() => setOfExpreso(null)}>
                <Text style={{ color: "#888", fontWeight: "600" }}>Cancelar</Text>
              </TouchableOpacity>
              <TouchableOpacity style={[styles.button, { flex: 1, backgroundColor: "#187830" }]} onPress={enviarOfExpreso}>
                <Text style={styles.buttonText}>Enviar</Text>
              </TouchableOpacity>
            </View>
          </View>
        </KeyboardAvoidingView>
      </Modal>

      {/* DETALLE del expreso: mapa de dónde a dónde + fecha clara, ANTES de decidir */}
      <Modal visible={!!verExp} transparent animationType="slide" onRequestClose={() => setVerExp(null)}>
        <View style={{ flex: 1, backgroundColor: "#F3F4F6" }}>
          <View style={{ backgroundColor: "#187830", paddingTop: insets.top + 10, paddingBottom: 12, paddingHorizontal: 16, flexDirection: "row", alignItems: "center" }}>
            <TouchableOpacity onPress={() => setVerExp(null)} style={{ paddingRight: 12, paddingVertical: 2 }}>
              <Text style={{ color: "#fff", fontSize: 26, fontWeight: "700" }}>‹</Text>
            </TouchableOpacity>
            <Text style={{ color: "#fff", fontSize: 18, fontWeight: "800" }}>Detalle del viaje</Text>
          </View>
          {verExp && (() => {
            const oLat = verExp.origen_lat, oLon = verExp.origen_lon;
            const dLat = verExp.destino_lat, dLon = verExp.destino_lon;
            const hayMapa = oLat != null || dLat != null;
            const total = verExp.precio_por_cupo * verExp.cupos;
            return (
              <ScrollView contentContainerStyle={{ padding: 14, paddingBottom: 24 }}>
                <View style={[styles.card, { marginBottom: 12 }]}>
                  <Text style={{ fontSize: 20, fontWeight: "800", color: "#111" }}>{verExp.origen_municipio} → {verExp.destino_municipio}</Text>
                  <View style={{ backgroundColor: verExp.salida ? "#FFF3E6" : "#EAF6EC", borderRadius: 10, padding: 12, marginTop: 10 }}>
                    <Text style={{ fontSize: 11.5, color: verExp.salida ? "#B85C00" : "#187830", fontWeight: "800", letterSpacing: 0.5 }}>{verExp.salida ? "🗓️ SALIDA PROGRAMADA" : "🟢 CUÁNDO"}</Text>
                    <Text style={{ fontSize: 16, fontWeight: "800", color: verExp.salida ? "#B85C00" : "#187830", marginTop: 3 }}>
                      {verExp.salida ? fmtFechaLarga(verExp.salida) : "Lo antes posible"}
                    </Text>
                  </View>
                </View>

                <View style={[styles.card, { marginBottom: 12 }]}>
                  <Text style={{ fontSize: 13, fontWeight: "800", color: "#666", marginBottom: 8 }}>📍 DE DÓNDE A DÓNDE</Text>
                  {hayMapa ? (
                    <MapaSeguimiento
                      recogida={oLat != null ? { lat: oLat, lon: oLon } : null}
                      destino={dLat != null ? { lat: dLat, lon: dLon } : null}
                    />
                  ) : (
                    <View style={{ backgroundColor: "#FFF7E6", borderRadius: 10, padding: 12, marginBottom: 4 }}>
                      <Text style={{ fontSize: 13, color: "#9A6B00" }}>El cliente no marcó puntos exactos en el mapa. Guíate por las direcciones escritas abajo.</Text>
                    </View>
                  )}
                  <Text style={{ fontSize: 14, color: "#333", marginTop: 6 }}>🟢 <Text style={{ fontWeight: "700" }}>Recoge:</Text> {verExp.origen}</Text>
                  <Text style={{ fontSize: 14, color: "#333", marginTop: 4 }}>🏁 <Text style={{ fontWeight: "700" }}>Deja:</Text> {verExp.destino_detalle || verExp.destino_municipio}</Text>
                  <View style={{ flexDirection: "row", gap: 8, marginTop: 12 }}>
                    {oLat != null && (
                      <TouchableOpacity style={{ flex: 1, backgroundColor: "#EAF1FB", borderRadius: 8, paddingVertical: 10, alignItems: "center" }} onPress={() => navegarGoogleMaps(oLat, oLon)}>
                        <Text style={{ color: "#1A56B8", fontWeight: "700", fontSize: 12.5 }}>🧭 Ver recogida en Maps</Text>
                      </TouchableOpacity>
                    )}
                    {dLat != null && (
                      <TouchableOpacity style={{ flex: 1, backgroundColor: "#EAF1FB", borderRadius: 8, paddingVertical: 10, alignItems: "center" }} onPress={() => navegarGoogleMaps(dLat, dLon)}>
                        <Text style={{ color: "#1A56B8", fontWeight: "700", fontSize: 12.5 }}>🧭 Ver destino en Maps</Text>
                      </TouchableOpacity>
                    )}
                  </View>
                </View>

                <View style={[styles.card, { marginBottom: 12 }]}>
                  <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
                    <Text style={{ fontSize: 14, color: "#555" }}>Precio del cliente</Text>
                    <Text style={{ fontSize: 20, fontWeight: "800", color: "#187830" }}>${verExp.precio_por_cupo.toLocaleString()}<Text style={{ fontSize: 13, color: "#888" }}>/cupo</Text></Text>
                  </View>
                  <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginTop: 6 }}>
                    <Text style={{ fontSize: 14, color: "#555" }}>{verExp.cupos} cupo(s) · total</Text>
                    <Text style={{ fontSize: 16, fontWeight: "700", color: "#333" }}>${total.toLocaleString()}</Text>
                  </View>
                  {verExp.notas ? <Text style={{ fontSize: 13, color: "#666", marginTop: 8 }}>📝 {verExp.notas}</Text> : null}
                  <Text style={{ fontSize: 13, color: "#999", marginTop: 8 }}>👤 {verExp.cliente_nombre}</Text>
                </View>

                {verExp.mi_oferta ? (
                  <View style={{ backgroundColor: "#EAF1FB", borderRadius: 10, padding: 12 }}>
                    <Text style={{ fontSize: 14, color: "#1A56B8", fontWeight: "700" }}>🕒 Ya ofertaste ${verExp.mi_oferta.toLocaleString()}/cupo</Text>
                    <TouchableOpacity style={[styles.button, { backgroundColor: "#fff", borderWidth: 1, borderColor: "#187830", padding: 11, marginTop: 10 }]} onPress={() => { const e = verExp; setVerExp(null); setMontoExp(String(e.mi_oferta)); setOfExpreso(e); }}>
                      <Text style={{ color: "#187830", fontWeight: "700" }}>Cambiar mi oferta</Text>
                    </TouchableOpacity>
                  </View>
                ) : (
                  <View style={{ flexDirection: "row", gap: 10 }}>
                    <TouchableOpacity style={[styles.button, { flex: 1, backgroundColor: "#187830", padding: 13 }]} onPress={() => { const e = verExp; setVerExp(null); aceptarExpreso(e); }}>
                      <Text style={styles.buttonText}>Tomar ${verExp.precio_por_cupo.toLocaleString()}/cupo</Text>
                    </TouchableOpacity>
                    <TouchableOpacity style={[styles.button, { flex: 1, backgroundColor: "#fff", borderWidth: 1, borderColor: "#187830", padding: 13 }]} onPress={() => { const e = verExp; setVerExp(null); setMontoExp(String(e.precio_por_cupo)); setOfExpreso(e); }}>
                      <Text style={{ color: "#187830", fontWeight: "700" }}>Proponer otro</Text>
                    </TouchableOpacity>
                  </View>
                )}
              </ScrollView>
            );
          })()}
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
  const [telLiberar, setTelLiberar] = useState("");   // desbloquear a un usuario atascado
  const [municipios, setMunicipios] = useState([]);
  const [demanda, setDemanda] = useState({ ciudades: [], departamentos: [] });
  const [nuevaCiudad, setNuevaCiudad] = useState({ nombre: "", lat: null, lon: null, vehiculos: ["carro"], departamento: "Putumayo" });
  const [marcandoCentro, setMarcandoCentro] = useState(false);
  const [buscaUsuario, setBuscaUsuario] = useState("");
  const [usuariosHallados, setUsuariosHallados] = useState(null);
  const [clientes, setClientes] = useState([]);   // lista de usuarios (rol cliente) para la pestaña Usuarios
  const [filtroCli, setFiltroCli] = useState("");  // filtro rapido de la lista de usuarios (nombre/telefono)
  const [editCiudad, setEditCiudad] = useState(null);   // nombre de la ciudad cuyas tarifas se editan
  const [tarBase, setTarBase] = useState("");
  const [tarKm, setTarKm] = useState("");
  const [tarMin, setTarMin] = useState("");
  const [editDepto, setEditDepto] = useState("Putumayo");
  const [editVeh, setEditVeh] = useState([]);          // vehiculos habilitados de la ciudad que se edita
  const [reCentrar, setReCentrar] = useState(null);   // ciudad a la que se le corrige el centro en el mapa

  const cargar = () => {
    fetch(`${API}/conductores`).then(r => r.json()).then(d => { if (Array.isArray(d)) setConductores(d); }).catch(() => {});
    adminFetch(`${API}/carreras`).then(r => r.json()).then(d => { if (Array.isArray(d)) setCarreras(d); }).catch(() => {});
    adminFetch(`${API}/estadisticas`).then(r => r.json()).then(d => { if (d && !d.detail) setGStats(d); }).catch(() => {});
    adminFetch(`${API}/config`).then(r => r.json()).then(d => { if (d && !d.detail) setConfig(d); }).catch(() => {});
    fetch(`${API}/municipios?todos=1`).then(r => r.json()).then(d => { if (Array.isArray(d)) setMunicipios(d); }).catch(() => {});
    adminFetch(`${API}/admin/demanda`).then(r => r.json()).then(d => { if (d && d.ciudades) setDemanda(d); }).catch(() => {});
    adminFetch(`${API}/admin/usuarios?rol=cliente`).then(r => r.json()).then(d => { if (Array.isArray(d)) setClientes(d); }).catch(() => {});
  };

  const TODOS_VEHICULOS = ["carro", "moto", "motocarguero", "camion_pequeno", "camioneta", "camion", "furgon", "planchon", "grua"];
  const DEPARTAMENTOS = ["Putumayo", "Cauca", "Nariño", "Caquetá", "Valle del Cauca", "Huila"];
  const demandaDe = (nombre) => (demanda.ciudades || []).find(c => c.nombre === nombre) || {};

  const buscarUsuarios = () => {
    setUsuariosHallados(null);
    adminFetch(`${API}/admin/usuarios?buscar=${encodeURIComponent(buscaUsuario.trim())}`)
      .then(r => r.json())
      .then(d => setUsuariosHallados(Array.isArray(d) ? d : []))
      .catch(() => setUsuariosHallados([]));
  };

  // soporte "olvide mi contraseña": clave temporal de 6 numeros + enviarla por WhatsApp
  const nuevaClaveUsuario = (u) => {
    confirmar("Nueva contraseña", `Se le pondrá a ${u.nombre} una contraseña temporal de 6 números, se reactiva la cuenta y se le quita el bloqueo por intentos. Su contraseña anterior deja de servir.`, () => {
      adminFetch(`${API}/admin/usuarios/${u.id}/clave`, { method: "POST" })
        .then(async r => {
          const d = await r.json().catch(() => null);
          if (!r.ok) { avisar("No se pudo", (d && d.detail) || `Error ${r.status}`); return; }
          buscarUsuarios(); cargar();
          const tel = String(d.telefono || "").replace(/\D/g, "").slice(-10);
          const msg = `Hola ${String(d.nombre || "").split(" ")[0]} 👋 Soy de soporte Tukán. Tu contraseña temporal es: ${d.clave_temporal}\nEntra con tu número ${tel} y esa clave. Luego cámbiala en Configuración → Cambiar contraseña.`;
          elegir("Contraseña temporal", `${d.nombre}\nTeléfono: ${tel}\nClave: ${d.clave_temporal}`, [
            { texto: "Enviar por WhatsApp", alElegir: () => Linking.openURL(`https://wa.me/57${tel}?text=${encodeURIComponent(msg)}`).catch(() => {}) },
            { texto: "Listo", alElegir: () => {} },
          ]);
        })
        .catch(() => avisar("Error", "No hay conexión."));
    }, "Generar clave");
  };

  // de raiz: borra sus datos y LIBERA el numero para que se registre otra vez
  const eliminarDeRaiz = (u) => {
    confirmar("Eliminar de raíz", `Se borran los datos de ${u.nombre} y su número ${u.telefono} queda LIBRE para registrarse de nuevo. Sus carreras pasadas quedan anónimas para las estadísticas. No se puede deshacer.`, () => {
      adminFetch(`${API}/admin/usuarios/${u.id}/raiz`, { method: "DELETE" })
        .then(async r => {
          const d = await r.json().catch(() => null);
          if (!r.ok) { avisar("No se pudo", (d && d.detail) || `Error ${r.status}`); return; }
          buscarUsuarios(); cargar();
          avisar("Eliminado de raíz", `${d.nombre} se eliminó. El número ${d.telefono_liberado} ya puede registrarse de nuevo.`);
        })
        .catch(() => avisar("Error", "No hay conexión."));
    }, "Sí, eliminar de raíz");
  };

  const eliminarUsuario = (u) => {
    const tieneHist = ((u.carreras_cliente || 0) + (u.carreras_conductor || 0)) > 0;
    if (tieneHist) {
      elegir("Eliminar usuario", `${u.nombre} tiene historial de carreras. ¿Qué quieres hacer?\n\n• Bloquear: no puede entrar; lo puedes reactivar después.\n• De raíz: se borran sus datos y su número queda libre para registrarse otra vez.`, [
        { texto: "Bloquear", alElegir: () => bloquearUsuario(u) },
        { texto: "Eliminar de raíz", alElegir: () => eliminarDeRaiz(u) },
      ]);
      return;
    }
    bloquearUsuario(u);
  };

  const bloquearUsuario = (u) => {
    const tieneHist = ((u.carreras_cliente || 0) + (u.carreras_conductor || 0)) > 0;
    const msg = tieneHist
      ? `${u.nombre} tiene historial de carreras. Se BLOQUEARÁ (no podrá entrar ni trabajar), pero se conserva su historial para las estadísticas. Podrás reactivarlo después.`
      : `${u.nombre} no tiene carreras. Se ELIMINARÁ por completo de la base.`;
    confirmar("Eliminar usuario", msg, () => {
      adminFetch(`${API}/admin/usuarios/${u.id}`, { method: "DELETE" })
        .then(async r => {
          const d = await r.json().catch(() => null);
          if (!r.ok) { avisar("No se pudo", (d && d.detail) || `Error ${r.status}`); return; }
          buscarUsuarios(); cargar();
          avisar(d.modo === "eliminado" ? "Usuario eliminado" : "Usuario bloqueado",
            d.modo === "eliminado" ? `${d.nombre} se borró por completo.` : `${d.nombre}: cuenta bloqueada. Ya no puede entrar. Puedes reactivarlo desde la búsqueda.`);
        })
        .catch(() => avisar("Error", "No hay conexión."));
    }, "Sí, eliminar");
  };

  const cambiarFundador = (u) => {
    const nuevo = u.fundador === "si" ? "no" : "si";
    confirmar(nuevo === "si" ? "Marcar como fundador" : "Quitar fundador",
      nuevo === "si" ? `${u.nombre} tendrá la insignia 🏅 Conductor Fundador en su app y los pasajeros la verán.` : `${u.nombre} dejará de mostrar la insignia de fundador.`,
      () => adminFetch(`${API}/admin/usuarios/${u.id}/fundador?valor=${nuevo}`, { method: "PUT" })
        .then(async r => {
          const d = await r.json().catch(() => null);
          if (!r.ok) { avisar("No se pudo", (d && d.detail) || `Error ${r.status}`); return; }
          buscarUsuarios(); cargar();
          avisar("Listo", nuevo === "si" ? `${u.nombre} ya es 🏅 Conductor Fundador.` : `${u.nombre} ya no es fundador.`);
        })
        .catch(() => avisar("Error", "No hay conexión.")),
      nuevo === "si" ? "Sí, marcar" : "Quitar");
  };

  const reactivarUsuario = (u) => {
    adminFetch(`${API}/admin/usuarios/${u.id}/reactivar`, { method: "POST" })
      .then(async r => {
        if (!r.ok) { avisar("No se pudo", `Error ${r.status}`); return; }
        buscarUsuarios(); cargar();
        avisar("Reactivado", `${u.nombre} ya puede entrar de nuevo.`);
      })
      .catch(() => avisar("Error", "No hay conexión."));
  };

  // manda un tono de prueba DIRECTO al conductor (salta todos los filtros): si su
  // telefono suena, la entrega del push funciona y el problema son los filtros
  const probarTonoConductor = (u) => {
    adminFetch(`${API}/diag-push?telefono=${encodeURIComponent(u.telefono)}`)
      .then(async r => {
        const d = await r.json().catch(() => null);
        if (!r.ok) { avisar("No se pudo", (d && d.detail) || `Error ${r.status}`); return; }
        const e = d.estado || {};
        if (!d.enviado) {
          avisar("Sin registro de tono", `${e.nombre || u.nombre}: ${d.motivo || "no tiene token"}. Que abra la app y toque '⚙️ → 🔔 → Re-registrar'.`);
          return;
        }
        avisar("Tono enviado ✅", `A ${e.nombre || u.nombre}. Su teléfono debe sonar en unos segundos.\n\nDisponible: ${e.disponible} · Token: ${e.tiene_token ? "sí" : "no"}${d.token_muerto ? "\n\n⚠️ El token está MUERTO: que reinstale el APK y re-registre." : ""}`);
      })
      .catch(() => avisar("Error", "No hay conexión."));
  };

  const crearCiudad = () => {
    const nom = nuevaCiudad.nombre.trim();
    if (nom.length < 3) { avisar("Falta el nombre", "Escribe el nombre de la ciudad."); return; }
    if (nuevaCiudad.lat == null) { avisar("Falta el centro", "Marca el centro de la ciudad en el mapa."); return; }
    if (!nuevaCiudad.vehiculos.length) { avisar("Faltan vehículos", "Elige al menos un tipo de vehículo."); return; }
    const p = qs({ nombre: nom, centro_lat: nuevaCiudad.lat, centro_lon: nuevaCiudad.lon, vehiculos: nuevaCiudad.vehiculos.join(","), departamento: nuevaCiudad.departamento || "Putumayo", usa_gps: "si" });
    adminFetch(`${API}/municipios?${p}`, { method: "POST" })
      .then(async r => {
        const d = await r.json().catch(() => null);
        if (!r.ok) { avisar("No se pudo", (d && d.detail) || `Error ${r.status}`); return; }
        setNuevaCiudad({ nombre: "", lat: null, lon: null, vehiculos: ["carro"], departamento: nuevaCiudad.departamento || "Putumayo" });
        cargar();
        avisar("Ciudad creada", `${nom} ya está activa. Los conductores de ahí ya pueden trabajar.`);
      })
      .catch(() => avisar("Error", "No hay conexión."));
  };

  const toggleCiudad = (m) => {
    const nuevo = m.activo === "no" ? "si" : "no";
    adminFetch(`${API}/municipios/${encodeURIComponent(m.nombre)}?activo=${nuevo}`, { method: "PUT" }).then(cargar).catch(() => {});
  };

  const guardarCentro = (nombre, c) => {
    adminFetch(`${API}/municipios/${encodeURIComponent(nombre)}?centro_lat=${c.lat}&centro_lon=${c.lon}`, { method: "PUT" })
      .then(() => { setReCentrar(null); cargar(); avisar("Centro corregido", `El centro de ${nombre} quedó bien ubicado.`); })
      .catch(() => avisar("Error", "No hay conexión."));
  };

  const abrirTarifas = (m) => {
    setEditCiudad(m.nombre);
    setTarBase(m.tarifa_base ? String(m.tarifa_base) : "");
    setTarKm(m.valor_km ? String(m.valor_km) : "");
    setTarMin(m.tarifa_minima ? String(m.tarifa_minima) : "");
    setEditDepto(m.departamento || "Putumayo");
    setEditVeh(m.vehiculos || []);
  };

  const guardarTarifas = (m) => {
    if (editVeh.length === 0) { avisar("Falta", "Marca al menos un servicio (vehículo) para la ciudad."); return; }
    const b = parseInt((tarBase || "").replace(/\D/g, ""), 10) || 0;
    const k = parseInt((tarKm || "").replace(/\D/g, ""), 10) || 0;
    const mn = parseInt((tarMin || "").replace(/\D/g, ""), 10) || 0;
    // con tarifas se activa el GPS para poder sugerir precio por km
    const p = `tarifa_base=${b}&valor_km=${k}&tarifa_minima=${mn}&departamento=${encodeURIComponent(editDepto || "Putumayo")}&vehiculos=${encodeURIComponent(editVeh.join(","))}${(b || k || mn) ? "&usa_gps=si" : ""}`;
    adminFetch(`${API}/municipios/${encodeURIComponent(m.nombre)}?${p}`, { method: "PUT" })
      .then(async r => {
        if (!r.ok) { const d = await r.json().catch(() => null); avisar("No se pudo", (d && d.detail) || `Error ${r.status}`); return; }
        setEditCiudad(null); cargar();
        avisar("Ciudad guardada", `${m.nombre}: ${editVeh.length} servicio(s) · base $${b.toLocaleString()} + $${k.toLocaleString()}/km.`);
      })
      .catch(() => avisar("Error", "No hay conexión."));
  };

  useEffect(() => {
    cargar();
    const intervalo = setInterval(cargar, 10000);
    return () => clearInterval(intervalo);
  }, []);

  const liberarUsuario = (telArg) => {
    const base = typeof telArg === "string" ? telArg : telLiberar;
    const tel = (base || "").replace(/\D/g, "");
    if (!tel) { avisar("Falta el teléfono", "Escribe el número del usuario a liberar."); return; }
    adminFetch(`${API}/soporte/liberar?telefono=${tel}`)
      .then(async r => {
        const d = await r.json().catch(() => null);
        if (!r.ok) { avisar("No se pudo", (d && d.detail) || `Error ${r.status}`); return; }
        setTelLiberar(""); cargar();
        if (usuariosHallados) buscarUsuarios();   // refresca la búsqueda si estaba abierta
        const n = (d.canceladas || []).length;
        avisar("Usuario liberado", `${d.usuario}: se cancelaron ${n} carrera(s) atascada(s)${n ? ` [#${d.canceladas.join(", #")}]` : ""}. Ya puede pedir de nuevo.`);
      })
      .catch(() => avisar("Error", "No hay conexión."));
  };

  const [repAdmin, setRepAdmin] = useState(null);   // id del conductor cuya reputacion se mira
  // tarjeta de un usuario, con sus acciones. Se usa en la busqueda (pestaña
  // Carreras) y en la lista de la pestaña Usuarios.
  const tarjetaUsuario = (u) => (
    <View key={u.id} style={{ backgroundColor: "#fff", borderRadius: 8, padding: 10, marginTop: 8, borderWidth: u.activo === "no" ? 1 : 0, borderColor: "#C0392B" }}>
      <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
        <Text style={{ fontWeight: "700", fontSize: 14 }}>
          {u.nombre || "(sin nombre)"}{u.fundador === "si" ? "  🏅" : ""}{u.activo === "no" ? <Text style={{ color: "#C0392B", fontWeight: "800" }}>  · BLOQUEADO</Text> : null}
        </Text>
        <Text style={{ fontSize: 11, color: "#854F0B", fontWeight: "700" }}>{u.rol}</Text>
      </View>
      <Text style={{ fontSize: 12, color: "#555", marginTop: 2 }}>📞 {u.telefono} · 📍 {u.municipio || "—"}{u.calificacion != null ? ` · ⭐ ${Number(u.calificacion).toFixed(1)}` : ""}</Text>
      <Text style={{ fontSize: 12, color: "#187830", marginTop: 2 }}>
        🚗 {u.carreras_cliente} pedidas · 🚕 {u.carreras_conductor} manejadas{u.activas ? ` · 🟠 ${u.activas} en curso` : ""}
      </Text>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 14, marginTop: 8 }}>
        {u.rol === "conductor" && (
          <TouchableOpacity onPress={() => probarTonoConductor(u)}>
            <Text style={{ color: "#F06000", fontWeight: "700", fontSize: 12 }}>🔔 Probar tono</Text>
          </TouchableOpacity>
        )}
        {u.rol === "conductor" && (
          <TouchableOpacity onPress={() => cambiarFundador(u)}>
            <Text style={{ color: "#8A5A00", fontWeight: "700", fontSize: 12 }}>{u.fundador === "si" ? "🏅 Quitar fundador" : "🏅 Marcar fundador"}</Text>
          </TouchableOpacity>
        )}
        {u.rol === "conductor" && (
          <TouchableOpacity onPress={() => setRepAdmin(u.id)}>
            <Text style={{ color: "#1A56B8", fontWeight: "700", fontSize: 12 }}>⭐ Reputación</Text>
          </TouchableOpacity>
        )}
        {repAdmin === u.id && <ReputacionAdminModal conductorId={u.id} onCerrar={() => setRepAdmin(null)} />}
        {u.activas > 0 && (
          <TouchableOpacity onPress={() => liberarUsuario(u.telefono)}>
            <Text style={{ color: "#B85C00", fontWeight: "700", fontSize: 12 }}>🔓 Liberar carreras</Text>
          </TouchableOpacity>
        )}
        {u.rol !== "admin" && !String(u.telefono || "").startsWith("ELIMINADO-") && (
          <TouchableOpacity onPress={() => nuevaClaveUsuario(u)}>
            <Text style={{ color: "#1A56B8", fontWeight: "700", fontSize: 12 }}>🔑 Nueva contraseña</Text>
          </TouchableOpacity>
        )}
        {u.activo === "no" && u.rol !== "admin" && !String(u.telefono || "").startsWith("ELIMINADO-") && (
          <TouchableOpacity onPress={() => eliminarDeRaiz(u)}>
            <Text style={{ color: "#C0392B", fontWeight: "700", fontSize: 12 }}>💥 Eliminar de raíz</Text>
          </TouchableOpacity>
        )}
        {u.activo === "no" ? (
          <TouchableOpacity onPress={() => reactivarUsuario(u)}>
            <Text style={{ color: "#187830", fontWeight: "700", fontSize: 12 }}>♻️ Reactivar</Text>
          </TouchableOpacity>
        ) : u.rol !== "admin" ? (
          <TouchableOpacity onPress={() => eliminarUsuario(u)}>
            <Text style={{ color: "#C0392B", fontWeight: "700", fontSize: 12 }}>🗑️ Eliminar</Text>
          </TouchableOpacity>
        ) : null}
      </View>
    </View>
  );

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

  const verificarConductor = (c) => {
    const nuevo = c.verificado === "si" ? "no" : "si";
    confirmar(
      nuevo === "si" ? "Habilitar conductor" : "Quitar habilitación",
      nuevo === "si"
        ? `¿Revisaste los documentos de ${c.nombre} y están correctos?`
        : `${c.nombre} quedará "en revisión" de nuevo.`,
      () => adminFetch(`${API}/conductores/${c.id}/verificar?valor=${nuevo}`, { method: "PUT" }).then(cargar),
      nuevo === "si" ? "Sí, habilitar" : "Sí, quitar");
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
  const enCurso = carreras.filter(c => ["buscando", "aceptada", "en_sitio", "en_camino"].includes(c.estado));
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
        {/* Cerrar sesion: borra la sesion guardada y vuelve a Login (si no, al
            reabrir la app la restauracion te devuelve a Admin). */}
        <TouchableOpacity
          onPress={() => confirmar("Cerrar sesión", "¿Seguro que quieres salir de tu cuenta de administrador?", async () => { await borrarSesion(); navigation.reset({ index: 0, routes: [{ name: "Login" }] }); }, "Cerrar sesión")}
          style={{ marginLeft: "auto", backgroundColor: "rgba(255,255,255,0.18)", borderRadius: 16, paddingVertical: 7, paddingHorizontal: 13 }}>
          <Text style={{ color: "#fff", fontWeight: "700", fontSize: 13 }}>🚪 Salir</Text>
        </TouchableOpacity>
      </View>

      <View style={{ flexDirection: "row", padding: 16, gap: 10 }}>
        <View style={styles.mini}><Text style={styles.miniNum}>{enCurso.length}</Text><Text style={styles.miniTxt}>En curso</Text></View>
        <View style={styles.mini}><Text style={styles.miniNum}>{hoy.length}</Text><Text style={styles.miniTxt}>Hoy</Text></View>
        <View style={styles.mini}><Text style={styles.miniNum}>{activos}</Text><Text style={styles.miniTxt}>Al dia</Text></View>
      </View>

      {/* pestañas: fila que envuelve a 2 renglones (ya son 6, no caben en una).
          Se evita el ScrollView horizontal porque en columna flex se colapsaba. */}
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6, marginHorizontal: 16, marginBottom: 16, backgroundColor: "#F6F1E6", borderRadius: 8, padding: 5 }}>
        {[["numeros", "Números"], ["conductores", "Conductores"], ["usuarios", "Usuarios"], ["carreras", "Carreras"], ["ciudades", "Ciudades"], ["cobro", "Cobro"]].map(([p, lbl]) => (
          <TouchableOpacity key={p} style={[{ paddingVertical: 8, paddingHorizontal: 14, borderRadius: 6 }, pestana === p && styles.tabActive]} onPress={() => setPestana(p)}>
            <Text style={[styles.tabText, pestana === p && styles.tabTextActive]}>{lbl}</Text>
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
              {gStats.comunidad && (
                <Text style={{ textAlign: "center", marginTop: 8, fontSize: 12.5, color: "#1A56B8", fontWeight: "700" }}>
                  👥 Llegaron por los grupos: {Object.entries(gStats.comunidad).map(([k, v]) => `${k} ${v}`).join("  ·  ")}
                </Text>
              )}
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

            {/* --- de donde son: registro por DEPARTAMENTO y CIUDAD --- */}
            {(demanda.departamentos || []).length > 0 && (
              <View style={[styles.card, { marginTop: 4 }]}>
                <Text style={styles.seccionTitulo}>📍 De dónde son (clientes y conductores)</Text>
                <Text style={[styles.ayuda, { marginTop: -2, marginBottom: 10 }]}>
                  Registros por departamento y ciudad. Sirve para ver dónde está creciendo la app y dónde faltan conductores.
                </Text>
                {[...(demanda.departamentos || [])]
                  .sort((a, b) => (b.clientes + b.conductores) - (a.clientes + a.conductores))
                  .map((dep) => {
                    const suyas = (demanda.ciudades || [])
                      .filter((c) => (c.departamento || "Putumayo") === dep.departamento)
                      .sort((a, b) => (b.clientes + b.conductores) - (a.clientes + a.conductores));
                    return (
                      <View key={dep.departamento} style={{ marginBottom: 12 }}>
                        <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", backgroundColor: "#EAF6EC", borderRadius: 8, paddingVertical: 7, paddingHorizontal: 10 }}>
                          <Text style={{ fontWeight: "800", color: "#187830", fontSize: 14 }}>{dep.departamento}</Text>
                          <Text style={{ fontSize: 12.5, color: "#187830", fontWeight: "700" }}>👤 {dep.clientes} · 🚕 {dep.conductores}</Text>
                        </View>
                        {suyas.map((c) => (
                          <View key={c.nombre} style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingVertical: 6, paddingHorizontal: 6, borderBottomWidth: 0.5, borderBottomColor: "#f2f2f2" }}>
                            <Text style={{ fontSize: 13, color: c.activo === "no" ? "#aaa" : "#333" }}>
                              {c.nombre}{c.activo === "no" ? "  · apagada" : ""}
                            </Text>
                            <Text style={{ fontSize: 12.5, color: "#555" }}>
                              👤 {c.clientes} · 🚕 {c.conductores}{c.conductores_disponibles ? `  (${c.conductores_disponibles} en línea)` : ""}
                            </Text>
                          </View>
                        ))}
                      </View>
                    );
                  })}
              </View>
            )}
          </>
        )}
        {pestana === "conductores" && conductores.map(c => (
          <View key={c.id} style={[styles.card, { marginBottom: 10 }]}>
            <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
              <View style={{ flex: 1 }}>
                <Text style={{ fontWeight: "600", fontSize: 15 }}>{c.nombre}</Text>
                <Text style={{ fontSize: 12, color: "#888", marginTop: 2 }}>📞 {c.telefono}</Text>
                {c.municipio ? <Text style={{ fontSize: 12, color: "#187830", fontWeight: "600" }}>📍 {c.municipio}{c.tipo_vehiculo ? `  ·  ${vehIcono(c.tipo_vehiculo)} ${vehLabel(c.tipo_vehiculo)}` : ""}</Text> : null}
                {c.placa ? <Text style={{ fontSize: 12, color: "#888" }}>🚕 {c.vehiculo} - {c.placa}</Text> : null}
              </View>
              <View style={{ alignItems: "flex-end", gap: 4 }}>
                <View style={[styles.estadoBadge, { backgroundColor: c.al_dia ? "#E8F5E9" : "#FBECEC" }]}>
                  <Text style={{ fontSize: 11, fontWeight: "600", color: c.al_dia ? "#187830" : "#C0392B" }}>
                    {c.al_dia ? (config.cobro_activo === "si" ? `${c.dias_restantes} dias` : "activo") : "vencido"}
                  </Text>
                </View>
                <View style={[styles.estadoBadge, { backgroundColor: c.verificado === "si" ? "#E8F5E9" : "#FFF3E0" }]}>
                  <Text style={{ fontSize: 11, fontWeight: "700", color: c.verificado === "si" ? "#187830" : "#B85C00" }}>
                    {c.verificado === "si" ? "✅ verificado" : "⏳ revisar"}
                  </Text>
                </View>
              </View>
            </View>
            {(c.veh_color || c.veh_modelo) ? (
              <Text style={{ fontSize: 12, color: "#888", marginTop: 2 }}>🎨 {[c.veh_color, c.veh_modelo].filter(Boolean).join(" · ")}</Text>
            ) : null}
            {c.fotos && Object.values(c.fotos).some(Boolean) ? (
              <>
              <Text style={{ fontSize: 10, color: "#999", marginTop: 10 }}>Toca un documento para verlo grande</Text>
              <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6, marginTop: 4 }}>
                {[["conductor", "foto"], ["vehiculo", "vehículo"], ["cedula", "cédula"], ["licencia", "licencia"], ["tarjeta", "tarjeta"], ["soat", "SOAT"]].map(([t, lbl]) => (
                  <TouchableOpacity key={t} style={{ width: "31.5%", alignItems: "center" }} disabled={!c.fotos[t]} onPress={() => c.fotos[t] && Linking.openURL(c.fotos[t])}>
                    {c.fotos[t]
                      ? <Image source={{ uri: c.fotos[t] }} style={{ width: "100%", height: 56, borderRadius: 8 }} />
                      : <View style={{ width: "100%", height: 56, borderRadius: 8, backgroundColor: "#f2f2f2", alignItems: "center", justifyContent: "center" }}><Text style={{ color: "#ccc", fontSize: 18 }}>—</Text></View>}
                    <Text style={{ fontSize: 9, color: c.fotos[t] ? "#187830" : "#bbb", marginTop: 2 }}>{lbl}</Text>
                  </TouchableOpacity>
                ))}
              </View>
              </>
            ) : (
              <Text style={{ fontSize: 11, color: "#C0392B", marginTop: 8 }}>⚠️ Sin documentos subidos</Text>
            )}
            <TouchableOpacity style={[styles.button, { backgroundColor: c.verificado === "si" ? "#fff" : "#1A56B8", borderWidth: c.verificado === "si" ? 1 : 0, borderColor: "#ddd", padding: 10, marginTop: 10 }]} onPress={() => verificarConductor(c)}>
              <Text style={{ color: c.verificado === "si" ? "#C0392B" : "#fff", fontWeight: "700", fontSize: 13 }}>{c.verificado === "si" ? "Quitar habilitación" : "✅ Habilitar (verificar)"}</Text>
            </TouchableOpacity>
            <View style={{ flexDirection: "row", gap: 8, marginTop: 8 }}>
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

        {pestana === "usuarios" && (() => {
          const q = filtroCli.trim().toLowerCase();
          const lista = q
            ? clientes.filter(u => (u.nombre || "").toLowerCase().includes(q) || (u.telefono || "").includes(q.replace(/\D/g, "")))
            : clientes;
          return (
            <>
              <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                <Text style={styles.seccionTitulo}>👥 Usuarios ({clientes.length})</Text>
                <TouchableOpacity onPress={cargar}><Text style={{ color: "#187830", fontWeight: "700", fontSize: 12 }}>↻ Actualizar</Text></TouchableOpacity>
              </View>
              <Text style={[styles.ayuda, { marginTop: -4, marginBottom: 8 }]}>Clientes registrados (los más recientes primero). Toca para liberar, bloquear o eliminar.</Text>
              <TextInput value={filtroCli} onChangeText={setFiltroCli}
                placeholder="🔎 Filtrar por nombre o teléfono" style={styles.input} />
              {lista.length === 0 ? (
                <Text style={{ color: "#888", textAlign: "center", padding: 20 }}>
                  {clientes.length === 0 ? "Aún no hay usuarios registrados." : "Ningún usuario coincide con el filtro."}
                </Text>
              ) : lista.map((u) => tarjetaUsuario(u))}
            </>
          );
        })()}

        {pestana === "carreras" && (
          <View style={[styles.card, { marginBottom: 12, backgroundColor: "#FFF6E5", borderWidth: 1, borderColor: "#F0C36D" }]}>
            <Text style={{ fontWeight: "800", color: "#8A5A00", fontSize: 14 }}>🔓 Liberar usuario atascado</Text>
            <Text style={{ fontSize: 12, color: "#8A5A00", marginTop: 2 }}>
              Si un usuario no puede pedir porque "ya tiene una carrera en curso", escribe su teléfono y cancela sus carreras atascadas.
            </Text>
            <View style={{ flexDirection: "row", gap: 8, marginTop: 10 }}>
              <TextInput
                value={telLiberar}
                onChangeText={setTelLiberar}
                placeholder="Teléfono del usuario"
                keyboardType="phone-pad"
                style={[styles.input, { flex: 1, marginBottom: 0 }]}
              />
              <TouchableOpacity style={[styles.button, { backgroundColor: "#C0392B", paddingHorizontal: 16, justifyContent: "center" }]} onPress={() => liberarUsuario()}>
                <Text style={[styles.buttonText, { fontSize: 14 }]}>Liberar</Text>
              </TouchableOpacity>
            </View>
          </View>
        )}

        {pestana === "carreras" && (
          <View style={[styles.card, { marginBottom: 12, backgroundColor: "#EDF3FF", borderWidth: 1, borderColor: "#B8CDF0" }]}>
            <Text style={{ fontWeight: "800", color: "#1A4C9B", fontSize: 14 }}>🔎 Buscar usuario</Text>
            <Text style={{ fontSize: 12, color: "#1A4C9B", marginTop: 2 }}>
              Por teléfono o nombre — para identificarlo y ver su actividad (soporte).
            </Text>
            <View style={{ flexDirection: "row", gap: 8, marginTop: 10 }}>
              <TextInput
                value={buscaUsuario}
                onChangeText={setBuscaUsuario}
                placeholder="Teléfono o nombre"
                style={[styles.input, { flex: 1, marginBottom: 0 }]}
                onSubmitEditing={buscarUsuarios}
                returnKeyType="search"
              />
              <TouchableOpacity style={[styles.button, { backgroundColor: "#1A73E8", paddingHorizontal: 16, justifyContent: "center" }]} onPress={buscarUsuarios}>
                <Text style={[styles.buttonText, { fontSize: 14 }]}>Buscar</Text>
              </TouchableOpacity>
            </View>
            {usuariosHallados != null && (usuariosHallados.length === 0 ? (
              <Text style={{ fontSize: 12, color: "#888", marginTop: 10 }}>No se encontró ningún usuario.</Text>
            ) : usuariosHallados.map((u) => tarjetaUsuario(u)))}
          </View>
        )}

        {pestana === "carreras" && carreras.slice(0, 40).map(c => (
          <View key={c.id} style={[styles.card, { marginBottom: 10 }]}>
            <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
              <Text style={{ fontWeight: "600" }}>#{c.id} · {c.cliente_nombre}</Text>
              <Text style={{ fontSize: 11, color: "#888" }}>{({ en_sitio: "en el punto", en_camino: "en viaje" }[c.estado]) || c.estado}</Text>
            </View>
            <Text style={{ fontSize: 13, color: "#555", marginTop: 4 }}>{limpiaDir(c.origen)} → {limpiaDir(c.destino)}</Text>
            {c.conductor_nombre ? <Text style={{ fontSize: 12, color: "#888", marginTop: 2 }}>🚕 {c.conductor_nombre}</Text> : null}
            {c.tarifa ? <Text style={{ fontSize: 12, color: "#187830", marginTop: 2 }}>${c.tarifa.toLocaleString()}</Text> : null}
          </View>
        ))}
        {pestana === "carreras" && carreras.length === 0 && (
          <Text style={{ color: "#888", textAlign: "center", padding: 20 }}>Todavia no hay carreras</Text>
        )}

        {pestana === "ciudades" && (
          <>
            {/* --- formulario: abrir ciudad nueva --- */}
            <View style={[styles.card, { marginBottom: 14, borderWidth: 1, borderColor: "#187830" }]}>
              <Text style={{ fontWeight: "800", color: "#187830", fontSize: 15 }}>➕ Abrir ciudad nueva</Text>
              <Text style={{ fontSize: 12, color: "#888", marginTop: 2, marginBottom: 10 }}>
                Con esto la app detecta la ciudad por GPS y los conductores de ahí ya pueden trabajar. Sin actualizar la app.
              </Text>
              <TextInput
                value={nuevaCiudad.nombre}
                onChangeText={(t) => setNuevaCiudad({ ...nuevaCiudad, nombre: t })}
                placeholder="Nombre de la ciudad (ej. Mocoa, Pasto, Florencia)"
                style={styles.input}
              />
              <Text style={{ fontSize: 12, color: "#666", fontWeight: "600", marginBottom: 4 }}>Departamento:</Text>
              <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8, marginBottom: 10 }}>
                {DEPARTAMENTOS.map((dep) => (
                  <TouchableOpacity key={dep}
                    style={[styles.chip, nuevaCiudad.departamento === dep && styles.chipOn]}
                    onPress={() => setNuevaCiudad({ ...nuevaCiudad, departamento: dep })}>
                    <Text style={[styles.chipTxt, nuevaCiudad.departamento === dep && styles.chipTxtOn]}>{dep}</Text>
                  </TouchableOpacity>
                ))}
              </View>
              <TouchableOpacity
                style={[styles.botonMapa, nuevaCiudad.lat != null && styles.botonMapaOk]}
                onPress={() => setMarcandoCentro(true)}>
                <Text style={{ color: "#187830", fontWeight: "600" }}>
                  {nuevaCiudad.lat != null ? "✓ Centro marcado — cambiar en el mapa" : "🗺️ Marcar el centro de la ciudad"}
                </Text>
              </TouchableOpacity>
              <Text style={{ fontSize: 12, color: "#666", fontWeight: "600", marginTop: 10, marginBottom: 4 }}>Vehículos permitidos:</Text>
              <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
                {TODOS_VEHICULOS.map((v) => {
                  const on = nuevaCiudad.vehiculos.includes(v);
                  return (
                    <TouchableOpacity key={v}
                      style={[styles.chip, on && styles.chipOn]}
                      onPress={() => setNuevaCiudad({
                        ...nuevaCiudad,
                        vehiculos: on ? nuevaCiudad.vehiculos.filter(x => x !== v) : [...nuevaCiudad.vehiculos, v],
                      })}>
                      <Text style={[styles.chipTxt, on && styles.chipTxtOn]}>{vehIcono(v)} {vehLabel(v)}</Text>
                    </TouchableOpacity>
                  );
                })}
              </View>
              <TouchableOpacity style={[styles.button, { backgroundColor: "#187830", marginTop: 14 }]} onPress={crearCiudad}>
                <Text style={styles.buttonText}>Crear ciudad</Text>
              </TouchableOpacity>
            </View>

            {/* --- demanda por departamento --- */}
            {(demanda.departamentos || []).length > 0 && (
              <>
                <Text style={styles.seccionTitulo}>Demanda por departamento</Text>
                {demanda.departamentos.map((d) => (
                  <View key={d.departamento} style={[styles.card, { marginBottom: 8, backgroundColor: "#EAF6EC" }]}>
                    <Text style={{ fontWeight: "800", color: "#187830", fontSize: 15 }}>📍 {d.departamento}</Text>
                    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 12, marginTop: 6 }}>
                      <Text style={{ fontSize: 12, color: "#333" }}>🏙️ {d.ciudades} ciudad(es)</Text>
                      <Text style={{ fontSize: 12, color: "#333" }}>🚗 {d.carreras_total} carreras</Text>
                      <Text style={{ fontSize: 12, color: "#333" }}>📅 {d.carreras_hoy} hoy</Text>
                      <Text style={{ fontSize: 12, color: "#333" }}>👤 {d.clientes} clientes</Text>
                      <Text style={{ fontSize: 12, color: "#333" }}>🚕 {d.conductores} conductores</Text>
                    </View>
                  </View>
                ))}
              </>
            )}

            {/* --- lista de ciudades (agrupadas por departamento) --- */}
            <Text style={styles.seccionTitulo}>Ciudades ({municipios.length})</Text>
            {[...municipios].sort((a, b) => (a.departamento || "").localeCompare(b.departamento || "") || a.nombre.localeCompare(b.nombre)).map((m) => (
              <View key={m.nombre} style={[styles.card, { marginBottom: 8, opacity: m.activo === "no" ? 0.55 : 1 }]}>
                <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
                  <View style={{ flex: 1 }}>
                    <Text style={{ fontWeight: "700", fontSize: 15 }}>{m.nombre} <Text style={{ fontSize: 11, color: "#999", fontWeight: "400" }}>· {m.departamento}</Text></Text>
                    <Text style={{ fontSize: 12, color: "#888", marginTop: 2 }}>
                      {(m.vehiculos || []).map(vehIcono).join(" ")}{m.usa_gps ? "  · 🛰️ GPS" : ""}
                    </Text>
                    {(() => { const dm = demandaDe(m.nombre); return (
                      <Text style={{ fontSize: 12, color: "#187830", marginTop: 2 }}>
                        🚗 {dm.carreras_total || 0} carreras ({dm.carreras_hoy || 0} hoy) · 👤 {dm.clientes || 0} · 🚕 {dm.conductores || 0} ({dm.conductores_disponibles || 0} en línea)
                      </Text>
                    ); })()}
                    <Text style={{ fontSize: 12, color: "#B85C00", marginTop: 2 }}>
                      {(m.tarifa_base || m.valor_km)
                        ? `💵 base $${(m.tarifa_base || 0).toLocaleString()} + $${(m.valor_km || 0).toLocaleString()}/km`
                        : "💬 precio libre (sin tarifa sugerida)"}
                    </Text>
                  </View>
                  <TouchableOpacity
                    style={[styles.chip, m.activo !== "no" && styles.chipOn]}
                    onPress={() => toggleCiudad(m)}>
                    <Text style={[styles.chipTxt, m.activo !== "no" && styles.chipTxtOn]}>
                      {m.activo === "no" ? "Apagada" : "Activa"}
                    </Text>
                  </TouchableOpacity>
                </View>

                {editCiudad === m.nombre ? (
                  <View style={{ marginTop: 10, borderTopWidth: 0.5, borderTopColor: "#eee", paddingTop: 10 }}>
                    <Text style={{ fontSize: 12, color: "#666", fontWeight: "600", marginBottom: 4 }}>Departamento:</Text>
                    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8, marginBottom: 10 }}>
                      {DEPARTAMENTOS.map((dep) => (
                        <TouchableOpacity key={dep}
                          style={[styles.chip, editDepto === dep && styles.chipOn]}
                          onPress={() => setEditDepto(dep)}>
                          <Text style={[styles.chipTxt, editDepto === dep && styles.chipTxtOn]}>{dep}</Text>
                        </TouchableOpacity>
                      ))}
                    </View>
                    <Text style={{ fontSize: 12, color: "#666", fontWeight: "600", marginBottom: 4 }}>Servicios que ofrece esta ciudad:</Text>
                    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8, marginBottom: 12 }}>
                      {TODOS_VEHICULOS.map((v) => {
                        const on = editVeh.includes(v);
                        return (
                          <TouchableOpacity key={v}
                            style={[styles.chip, on && styles.chipOn]}
                            onPress={() => setEditVeh(on ? editVeh.filter(x => x !== v) : [...editVeh, v])}>
                            <Text style={[styles.chipTxt, on && styles.chipTxtOn]}>{vehIcono(v)} {vehLabel(v)}</Text>
                          </TouchableOpacity>
                        );
                      })}
                    </View>
                    <Text style={{ fontSize: 12, color: "#666", marginBottom: 6 }}>
                      Tarifa SUGERIDA (solo orienta al cliente; el precio se sigue negociando). Deja todo en 0 para precio libre.
                    </Text>
                    <View style={{ flexDirection: "row", gap: 8 }}>
                      <View style={{ flex: 1 }}>
                        <Text style={styles.etiqueta}>BASE $</Text>
                        <TextInput value={tarBase} onChangeText={setTarBase} keyboardType="number-pad" placeholder="0" style={[styles.input, { marginBottom: 0 }]} />
                      </View>
                      <View style={{ flex: 1 }}>
                        <Text style={styles.etiqueta}>POR KM $</Text>
                        <TextInput value={tarKm} onChangeText={setTarKm} keyboardType="number-pad" placeholder="0" style={[styles.input, { marginBottom: 0 }]} />
                      </View>
                      <View style={{ flex: 1 }}>
                        <Text style={styles.etiqueta}>MÍNIMA $</Text>
                        <TextInput value={tarMin} onChangeText={setTarMin} keyboardType="number-pad" placeholder="0" style={[styles.input, { marginBottom: 0 }]} />
                      </View>
                    </View>
                    <TouchableOpacity
                      style={[styles.botonMapa, { marginTop: 12 }, m.centro_lat != null && styles.botonMapaOk]}
                      onPress={() => setReCentrar(m.nombre)}>
                      <Text style={{ color: "#187830", fontWeight: "600" }}>
                        {m.centro_lat != null ? "🗺️ Corregir el centro en el mapa" : "🗺️ Marcar el centro en el mapa"}
                      </Text>
                    </TouchableOpacity>
                    <Text style={{ fontSize: 11, color: "#8A5A00", marginBottom: 4 }}>
                      El centro es donde la app detecta la ciudad por GPS. Si quedó mal, corrígelo aquí.
                    </Text>
                    <View style={{ flexDirection: "row", gap: 8, marginTop: 6 }}>
                      <TouchableOpacity style={[styles.button, { flex: 1, backgroundColor: "#fff", borderWidth: 1, borderColor: "#ddd", padding: 10 }]} onPress={() => setEditCiudad(null)}>
                        <Text style={{ color: "#888", fontWeight: "600" }}>Cancelar</Text>
                      </TouchableOpacity>
                      <TouchableOpacity style={[styles.button, { flex: 1, backgroundColor: "#187830", padding: 10 }]} onPress={() => guardarTarifas(m)}>
                        <Text style={[styles.buttonText, { fontSize: 14 }]}>Guardar</Text>
                      </TouchableOpacity>
                    </View>
                  </View>
                ) : (
                  <TouchableOpacity style={{ marginTop: 8, alignSelf: "flex-start" }} onPress={() => abrirTarifas(m)}>
                    <Text style={{ color: "#1A73E8", fontWeight: "600", fontSize: 13 }}>✏️ Editar (servicios, departamento y tarifas)</Text>
                  </TouchableOpacity>
                )}
              </View>
            ))}

            <MapaSelector
              visible={marcandoCentro}
              titulo="Marca el centro de la ciudad"
              centro={nuevaCiudad.lat != null ? { lat: nuevaCiudad.lat, lon: nuevaCiudad.lon } : null}
              municipio={nuevaCiudad.nombre || "Colombia"}
              onConfirmar={(c) => { setNuevaCiudad((n) => ({ ...n, lat: c.lat, lon: c.lon })); setMarcandoCentro(false); }}
              onCerrar={() => setMarcandoCentro(false)}
            />
            <MapaSelector
              visible={!!reCentrar}
              titulo={`Centro de ${reCentrar || ""}`}
              centro={null}
              municipio={reCentrar || "Colombia"}
              onConfirmar={(c) => guardarCentro(reCentrar, c)}
              onCerrar={() => setReCentrar(null)}
            />
          </>
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

            <Text style={[styles.etiqueta, { marginTop: 16 }]}>💬 WHATSAPP DE SOPORTE</Text>
            <TextInput
              defaultValue={config.whatsapp_soporte}
              placeholder="Numero de WhatsApp Business para soporte"
              onEndEditing={(e) => adminFetch(`${API}/config?clave=whatsapp_soporte&valor=${encodeURIComponent(e.nativeEvent.text)}`, { method: "PUT" }).then(cargar)}
              keyboardType="phone-pad"
              style={styles.input}
            />
            <Text style={styles.ayuda}>Aquí llegan los mensajes de "Escribir al soporte" de la app</Text>
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

/** Cambiar contraseña (por ejemplo la temporal que dio soporte). */
function CambiarClave({ usuario }) {
  const [abierto, setAbierto] = useState(false);
  const [actual, setActual] = useState("");
  const [nueva, setNueva] = useState("");
  const [enviando, setEnviando] = useState(false);
  const [ver, setVer] = useState(false);   // mostrar/ocultar lo que se escribe
  const guardar = () => {
    if (nueva.trim().length < 6) { avisar("Muy corta", "La nueva contraseña debe tener al menos 6 caracteres."); return; }
    setEnviando(true);
    userFetch(`${API}/usuarios/${usuario.id}/clave?actual=${encodeURIComponent(actual)}&nueva=${encodeURIComponent(nueva.trim())}`, { method: "PUT" })
      .then(async r => {
        const d = await r.json().catch(() => null);
        if (!r.ok) { avisar("No se pudo", (d && d.detail) || "Intenta de nuevo."); return; }
        setAbierto(false); setActual(""); setNueva("");
        avisar("Listo", "Tu contraseña quedó cambiada.");
      })
      .catch(() => avisar("Error", "No hay conexión."))
      .finally(() => setEnviando(false));
  };
  if (!abierto) {
    return (
      <TouchableOpacity onPress={() => setAbierto(true)}
        style={{ marginTop: 14, alignSelf: "flex-start", backgroundColor: "#EEF3FB", borderRadius: 10, paddingVertical: 9, paddingHorizontal: 16 }}>
        <Text style={{ color: "#1A56B8", fontWeight: "700", fontSize: 13 }}>🔑 Cambiar contraseña</Text>
      </TouchableOpacity>
    );
  }
  return (
    <View style={{ marginTop: 14, backgroundColor: "#F4F5F1", borderRadius: 12, padding: 12 }}>
      <Text style={{ fontSize: 13, fontWeight: "700", color: "#3A3A3A", marginBottom: 6 }}>Contraseña actual</Text>
      <View style={{ justifyContent: "center" }}>
        <TextInput value={actual} onChangeText={setActual} secureTextEntry={!ver} placeholder="La que usas hoy (o la temporal)" style={[styles.input, { marginBottom: 10, backgroundColor: "#fff", paddingRight: 50 }]} />
        <TouchableOpacity style={{ position: "absolute", right: 6, padding: 10, top: 2 }} onPress={() => setVer(v => !v)}>
          <Text style={{ fontSize: 18 }}>{ver ? "🙈" : "👁️"}</Text>
        </TouchableOpacity>
      </View>
      <Text style={{ fontSize: 13, fontWeight: "700", color: "#3A3A3A", marginBottom: 6 }}>Nueva contraseña</Text>
      <View style={{ justifyContent: "center" }}>
        <TextInput value={nueva} onChangeText={setNueva} secureTextEntry={!ver} placeholder="Mínimo 6 caracteres" style={[styles.input, { marginBottom: 10, backgroundColor: "#fff", paddingRight: 50 }]} />
        <TouchableOpacity style={{ position: "absolute", right: 6, padding: 10, top: 2 }} onPress={() => setVer(v => !v)}>
          <Text style={{ fontSize: 18 }}>{ver ? "🙈" : "👁️"}</Text>
        </TouchableOpacity>
      </View>
      <View style={{ flexDirection: "row", gap: 10 }}>
        <TouchableOpacity onPress={guardar} disabled={enviando} style={{ flex: 1, backgroundColor: "#187830", borderRadius: 10, paddingVertical: 11, alignItems: "center" }}>
          {enviando ? <ActivityIndicator color="#fff" /> : <Text style={{ color: "#fff", fontWeight: "800" }}>Guardar</Text>}
        </TouchableOpacity>
        <TouchableOpacity onPress={() => { setAbierto(false); setActual(""); setNueva(""); }} style={{ paddingVertical: 11, paddingHorizontal: 14 }}>
          <Text style={{ color: "#8A8A8A", fontWeight: "700" }}>Cancelar</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

function ConfiguracionScreen({ navigation, route }) {
  const { usuario } = route.params;
  const esConductor = usuario.rol === "conductor";
  // permiso "Mostrar encima de otras apps": se re-lee al volver de los ajustes
  const [sobreOk, setSobreOk] = useState(puedeSobreponer());
  useEffect(() => {
    const sub = AppState.addEventListener("change", (st) => { if (st === "active") setSobreOk(puedeSobreponer()); });
    return () => sub.remove();
  }, []);
  const [pagos, setPagos] = useState({ efectivo: true, nequi: "", daviplata: "", bancolombia: "", breb: "" });
  const [activos, setActivos] = useState({ efectivo: true });   // cuales estan marcados
  const [fotos, setFotos] = useState({ conductor: null, vehiculo: null, tarjeta: null, licencia: null, cedula: null, soat: null });
  const [subiendoFoto, setSubiendoFoto] = useState(null);       // tipo que se esta subiendo
  const [perfil, setPerfil] = useState(null);                   // verificado, suscripcion, calificacion...
  const [vehForm, setVehForm] = useState({ placa: "", vehiculo: "", veh_color: "", veh_modelo: "" });
  const [guardandoVeh, setGuardandoVeh] = useState(false);
  const [notifOk, setNotifOk] = useState(null);
  const [cargando, setCargando] = useState(true);
  const [guardando, setGuardando] = useState(false);
  const [soporteWa, setSoporteWa] = useState("3133714915");
  // zona de trabajo del conductor: puede mudarse o trabajar en el otro pueblo
  const [municipios, setMunicipios] = useState([]);
  const [miMuni, setMiMuni] = useState(usuario.municipio);
  const [cambiandoMuni, setCambiandoMuni] = useState(false);

  useEffect(() => {
    Notifications.getPermissionsAsync().then(p => setNotifOk(p.status === "granted")).catch(() => {});
    fetch(`${API}/soporte/contacto`).then(r => r.json()).then(d => { if (d && d.whatsapp) setSoporteWa(d.whatsapp); }).catch(() => {});
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
        content: { title: "🔔 Prueba de tono", body: "Así suena cuando entra una carrera.", sound: SONIDO_EXPO },
        trigger: Platform.OS === "android" ? { channelId: CANAL_EXPO, seconds: 1 } : null,
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
        if (d && d.fotos) setFotos(f => ({ ...f, ...d.fotos }));
        if (d && !d.detail) {
          setPerfil(d);
          setVehForm({
            placa: d.placa || "", vehiculo: d.vehiculo || "",
            veh_color: d.veh_color || "", veh_modelo: d.veh_modelo || "",
          });
        }
      })
      .catch(() => {})
      .finally(() => setCargando(false));
  }, []);

  const guardarVehiculo = () => {
    setGuardandoVeh(true);
    userFetch(`${API}/usuarios/${usuario.id}/vehiculo?${qs(vehForm)}`, { method: "PUT" })
      .then(r => r.json())
      .then(d => {
        setGuardandoVeh(false);
        if (!d.ok) { avisar("Error", "No se pudo guardar."); return; }
        usuario.placa = d.placa; usuario.vehiculo = d.vehiculo;   // refresca la pantalla previa
        setPerfil(p => ({ ...(p || {}), ...d }));
        avisar("Guardado", "Datos del vehículo actualizados. Quedan en revisión para habilitarte.");
      })
      .catch(() => { setGuardandoVeh(false); avisar("Sin conexión", "Intenta de nuevo."); });
  };

  const subirFoto = async (tipo) => {
    const permiso = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permiso.granted) { avisar("Permiso requerido", "Necesitamos acceso a tus fotos."); return; }
    const r = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images, allowsEditing: true,
      aspect: (tipo === "conductor" || tipo === "perfil") ? [1, 1] : [4, 3], quality: 0.6,
    });
    if (r.canceled) return;
    setSubiendoFoto(tipo);
    const fd = new FormData();
    fd.append("file", { uri: r.assets[0].uri, type: "image/jpeg", name: `${tipo}.jpg` });
    // OJO: NO fijar "Content-Type" a mano. En React Native (New Architecture) eso
    // omite el boundary del multipart y la subida falla como "sin conexion". Al no
    // ponerlo, fetch arma solo "multipart/form-data; boundary=...". userFetch agrega
    // el X-User-Token.
    userFetch(`${API}/usuarios/${usuario.id}/foto?tipo=${tipo}`, { method: "POST", body: fd })
      .then(res => res.json())
      .then(d => { setSubiendoFoto(null); if (d.url) { setFotos(f => ({ ...f, [tipo]: d.url })); if (tipo === "perfil") { usuario.foto_perfil = d.url; guardarSesion(usuario); } } else avisar("Error", "No se pudo subir la foto."); })
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
      <KeyboardAvoidingView style={{ flex: 1 }} behavior="padding">
      <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 60 }} keyboardShouldPersistTaps="handled">
        <View style={[styles.card, { marginBottom: 14 }]}>
          {!esConductor && (
            <TouchableOpacity onPress={() => subirFoto("perfil")} style={{ flexDirection: "row", alignItems: "center", gap: 12, marginBottom: 12 }}>
              {(fotos.perfil || usuario.foto_perfil) ? (
                <Image source={{ uri: fotos.perfil || usuario.foto_perfil }} style={{ width: 64, height: 64, borderRadius: 32, backgroundColor: "#EEE" }} />
              ) : (
                <View style={{ width: 64, height: 64, borderRadius: 32, backgroundColor: "#E7F3E9", alignItems: "center", justifyContent: "center" }}>
                  <Text style={{ fontSize: 26, fontWeight: "700", color: "#187830" }}>{(usuario.nombre || "?").trim().charAt(0).toUpperCase()}</Text>
                </View>
              )}
              <View style={{ flex: 1 }}>
                <Text style={{ fontSize: 14, fontWeight: "700", color: "#187830" }}>
                  {subiendoFoto === "perfil" ? "Subiendo foto…" : (fotos.perfil || usuario.foto_perfil) ? "Cambiar mi foto" : "Agregar mi foto"}
                </Text>
                <Text style={{ fontSize: 12, color: "#888", marginTop: 2 }}>El conductor la ve al recibir tu solicitud. Da más confianza y te aceptan más rápido.</Text>
              </View>
            </TouchableOpacity>
          )}
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
          {usuario.rol === "conductor" && Platform.OS === "android" && (
            <View style={{ marginTop: 14, backgroundColor: "#EAF1FB", borderRadius: 12, padding: 12 }}>
              <Text style={{ fontSize: 13.5, fontWeight: "800", color: "#1A56B8" }}>🔔 Avisos a pantalla completa</Text>
              <Text style={{ fontSize: 12, color: "#4A6A8A", marginTop: 3 }}>
                Las solicitudes y cancelaciones te saltan encima de todo, aunque el teléfono esté bloqueado o estés en otra app.
              </Text>
              <View style={{ flexDirection: "row", gap: 8, marginTop: 10 }}>
                <TouchableOpacity onPress={probarPantallaCompleta} style={{ flex: 1, backgroundColor: "#1A56B8", borderRadius: 10, paddingVertical: 10, alignItems: "center" }}>
                  <Text style={{ color: "#fff", fontWeight: "800", fontSize: 13 }}>Probar ahora</Text>
                </TouchableOpacity>
                <TouchableOpacity onPress={() => Linking.openSettings().catch(() => {})} style={{ flex: 1, backgroundColor: "#fff", borderRadius: 10, paddingVertical: 10, alignItems: "center", borderWidth: 1, borderColor: "#1A56B8" }}>
                  <Text style={{ color: "#1A56B8", fontWeight: "800", fontSize: 13 }}>Abrir permisos</Text>
                </TouchableOpacity>
              </View>
              {TukanOverlay ? (
                <View style={{ marginTop: 12, borderTopWidth: 1, borderTopColor: "#D5E2F2", paddingTop: 10 }}>
                  <Text style={{ fontSize: 13, fontWeight: "800", color: "#1A56B8" }}>
                    🪟 Mostrar encima de otras apps: {sobreOk ? "✅ activo" : "❌ desactivado"}
                  </Text>
                  <Text style={{ fontSize: 12, color: "#4A6A8A", marginTop: 3 }}>
                    Así, si estás en Waze o WhatsApp, Tukán salta al frente con la solicitud o la cancelación.
                  </Text>
                  {!sobreOk && (
                    <TouchableOpacity onPress={() => { try { TukanOverlay.pedirPermiso(); } catch (e) {} }} style={{ marginTop: 8, backgroundColor: "#1A56B8", borderRadius: 10, paddingVertical: 10, alignItems: "center" }}>
                      <Text style={{ color: "#fff", fontWeight: "800", fontSize: 13 }}>Activar (busca Tukán y enciéndelo)</Text>
                    </TouchableOpacity>
                  )}
                </View>
              ) : null}
              <Text style={{ fontSize: 11, color: "#6A7F95", marginTop: 8 }}>
                Si solo te llega una notificación normal: en "Abrir permisos" → Notificaciones, activa "Pantalla completa" / "Pantalla de bloqueo". En Huawei también "Mostrar encima de otras apps" y quita la optimización de batería.
              </Text>
            </View>
          )}
          <CambiarClave usuario={usuario} />
          <TouchableOpacity onPress={() => confirmar("Cerrar sesión", "¿Seguro que quieres salir de tu cuenta?", async () => { await borrarSesion(); navigation.reset({ index: 0, routes: [{ name: "Login" }] }); }, "Cerrar sesión")}
            style={{ marginTop: 14, alignSelf: "flex-start", backgroundColor: "#FDECEA", borderRadius: 10, paddingVertical: 9, paddingHorizontal: 16 }}>
            <Text style={{ color: "#C0392B", fontWeight: "700", fontSize: 13 }}>🚪 Cerrar sesión</Text>
          </TouchableOpacity>
          {/* Habeas Data: eliminar cuenta y datos personales (doble confirmacion) */}
          <TouchableOpacity
            onPress={() => confirmar("Eliminar mi cuenta",
              "Borra tu cuenta y tus datos personales (nombre, teléfono, fotos, vehículo, lugares guardados). No se puede deshacer.",
              () => confirmar("¿Seguro, seguro?", "Perderás el acceso. Si tienes historial de viajes, se conserva de forma anónima para estadísticas.",
                () => userFetch(`${API}/usuarios/${usuario.id}`, { method: "DELETE" }).then(async r => {
                  if (r.ok) { await borrarSesion(); navigation.reset({ index: 0, routes: [{ name: "Login" }] }); }
                  else { const d = await r.json().catch(() => null); avisar("No se pudo", (d && d.detail) || "Intenta de nuevo."); }
                }).catch(() => avisar("Error", "No hay conexión.")),
                "Sí, eliminar definitivamente"),
              "Continuar")}
            style={{ marginTop: 10, alignSelf: "flex-start", paddingVertical: 6, paddingHorizontal: 4 }}>
            <Text style={{ color: "#B42318", fontWeight: "600", fontSize: 12, textDecorationLine: "underline" }}>Eliminar mi cuenta y mis datos</Text>
          </TouchableOpacity>
        </View>

        {/* HABILITACIÓN del conductor: verificación de documentos + suscripción */}
        {esConductor && (
          <View style={[styles.card, { marginBottom: 14 }]}>
            <Text style={styles.seccionTitulo}>🛡️ Habilitación</Text>
            <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginTop: 4 }}>
              <Text style={{ fontSize: 14, color: "#333" }}>Verificación de documentos</Text>
              <View style={[styles.estadoBadge, { backgroundColor: perfil && perfil.verificado === "si" ? "#E8F5E9" : "#FFF3E0" }]}>
                <Text style={{ fontSize: 12, fontWeight: "700", color: perfil && perfil.verificado === "si" ? "#187830" : "#B85C00" }}>
                  {perfil && perfil.verificado === "si" ? "✅ Verificado" : "⏳ En revisión"}
                </Text>
              </View>
            </View>
            {perfil && perfil.verificado !== "si" && (
              <Text style={[styles.ayuda, { marginTop: 6 }]}>Sube tus documentos abajo. Nuestro equipo los revisa y te habilita.</Text>
            )}
            <View style={{ height: 1, backgroundColor: "#eee", marginVertical: 10 }} />
            <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
              <Text style={{ fontSize: 14, color: "#333" }}>Suscripción</Text>
              <View style={[styles.estadoBadge, { backgroundColor: perfil && perfil.al_dia ? "#E8F5E9" : "#FBECEC" }]}>
                <Text style={{ fontSize: 12, fontWeight: "700", color: perfil && perfil.al_dia ? "#187830" : "#C0392B" }}>
                  {perfil ? (perfil.al_dia ? (perfil.dias_restantes != null ? `Al día · ${perfil.dias_restantes} días` : "Al día") : "Vencida") : "…"}
                </Text>
              </View>
            </View>
            {perfil && perfil.calificacion != null && (
              <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginTop: 10 }}>
                <Text style={{ fontSize: 14, color: "#333" }}>Calificación</Text>
                <Estrellas valor={perfil.calificacion} size={15} />
              </View>
            )}
          </View>
        )}

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

        {esConductor && (
          <View style={[styles.card, { marginBottom: 14 }]}>
            <Text style={styles.seccionTitulo}>💬 Soporte y ayuda</Text>
            <Text style={styles.ayuda}>¿Un problema, una duda o algo que reportar? Escríbenos por WhatsApp.</Text>
            <TouchableOpacity style={[styles.button, { backgroundColor: "#25D366", marginTop: 10 }]} onPress={() => soporteWhatsApp(soporteWa, usuario)}>
              <Text style={styles.buttonText}>💬 Escribir al soporte</Text>
            </TouchableOpacity>
          </View>
        )}

        {esConductor && municipios.length > 0 && (
          <View style={[styles.card, { marginBottom: 14 }]}>
            <Text style={styles.seccionTitulo}>📍 Zona donde trabajas</Text>
            <Text style={styles.ayuda}>
              Solo recibes solicitudes de este municipio. Cambialo si te mudas o si hoy vas a trabajar en el otro.
            </Text>
            {cambiandoMuni ? (
              <ActivityIndicator color="#187830" style={{ marginTop: 8 }} />
            ) : (
              <View style={{ marginTop: 8 }}>
                {Object.entries(
                  municipios.reduce((acc, m) => {
                    const d = m.departamento || "Otros";
                    (acc[d] = acc[d] || []).push(m);
                    return acc;
                  }, {})
                )
                  .sort((a, b) => a[0].localeCompare(b[0]))
                  .map(([depto, lista]) => (
                    <View key={depto} style={{ marginBottom: 10 }}>
                      <Text style={{ fontSize: 10.5, color: "#9a9a9a", fontWeight: "800", letterSpacing: 0.5, marginBottom: 5, textTransform: "uppercase" }}>{depto}</Text>
                      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
                        {lista
                          .slice()
                          .sort((a, b) => a.nombre.localeCompare(b.nombre))
                          .map((m) => (
                            <TouchableOpacity key={m.nombre} onPress={() => cambiarMunicipio(m.nombre)}
                              style={[styles.chip, miMuni === m.nombre && styles.chipOn]}>
                              <Text style={[styles.chipTxt, miMuni === m.nombre && styles.chipTxtOn]}>{m.nombre}</Text>
                            </TouchableOpacity>
                          ))}
                      </View>
                    </View>
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
          {/* DATOS DEL VEHÍCULO (el cliente los ve para identificarte) */}
          <View style={[styles.card, { marginBottom: 14 }]}>
            <Text style={styles.seccionTitulo}>🚗 Datos del vehículo</Text>
            <Text style={styles.ayuda}>El cliente los ve para identificarte cuando llegas. Si los cambias, tu cuenta vuelve a revisión.</Text>
            <Text style={{ fontSize: 12.5, color: "#888", marginTop: 6 }}>Tipo: {vehIcono(usuario.tipo_vehiculo)} {vehLabel(usuario.tipo_vehiculo)}</Text>
            <TextInput value={vehForm.placa} onChangeText={t => setVehForm({ ...vehForm, placa: t.toUpperCase() })} placeholder="Placa (ej. ABC123)" autoCapitalize="characters" style={[styles.input, { marginTop: 8 }]} />
            <TextInput value={vehForm.vehiculo} onChangeText={t => setVehForm({ ...vehForm, vehiculo: t })} placeholder="Marca y línea (ej. Chevrolet Spark)" style={[styles.input, { marginTop: 8 }]} />
            <View style={{ flexDirection: "row", gap: 8 }}>
              <TextInput value={vehForm.veh_color} onChangeText={t => setVehForm({ ...vehForm, veh_color: t })} placeholder="Color" style={[styles.input, { flex: 1, marginTop: 8 }]} />
              <TextInput value={vehForm.veh_modelo} onChangeText={t => setVehForm({ ...vehForm, veh_modelo: t })} placeholder="Modelo / año" style={[styles.input, { flex: 1, marginTop: 8 }]} />
            </View>
            <TouchableOpacity style={[styles.button, { backgroundColor: "#187830", marginTop: 12 }]} onPress={guardarVehiculo} disabled={guardandoVeh}>
              {guardandoVeh ? <ActivityIndicator color="#fff" /> : <Text style={styles.buttonText}>Guardar datos del vehículo</Text>}
            </TouchableOpacity>
          </View>

          {/* DOCUMENTOS Y FOTOS: fotos públicas + documentos de verificación */}
          <View style={[styles.card, { marginBottom: 14 }]}>
            <Text style={styles.seccionTitulo}>📎 Documentos y fotos</Text>
            <Text style={styles.ayuda}>Tu foto y la del vehículo las ve el cliente. Los documentos (cédula, licencia, tarjeta, SOAT) son solo para verificación del equipo; el cliente NO los ve.</Text>
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 8 }}>
              {[["conductor", "Tu foto", "👤"], ["vehiculo", "Vehículo", "🚗"], ["cedula", "Cédula", "🪪"], ["licencia", "Licencia", "🚦"], ["tarjeta", "Tarjeta prop.", "📄"], ["soat", "SOAT", "🛡️"]].map(([tipo, lbl, ic]) => (
                <TouchableOpacity key={tipo} style={{ width: "31.5%", alignItems: "center" }} onPress={() => subirFoto(tipo)} disabled={!!subiendoFoto}>
                  <View style={{ width: "100%", height: 76, borderRadius: 10, backgroundColor: "#F2F4F3", borderWidth: fotos[tipo] ? 0 : 1, borderColor: "#e2e2e2", alignItems: "center", justifyContent: "center", overflow: "hidden" }}>
                    {subiendoFoto === tipo ? <ActivityIndicator color="#187830" />
                      : fotos[tipo] ? <Image source={{ uri: fotos[tipo] }} style={{ width: "100%", height: "100%" }} />
                      : <Text style={{ fontSize: 24 }}>{ic}</Text>}
                  </View>
                  <Text style={{ fontSize: 11, color: "#666", marginTop: 4 }}>{lbl}</Text>
                  <Text style={{ fontSize: 10, color: "#187830", fontWeight: "600" }}>{fotos[tipo] ? "✓ cambiar" : "subir"}</Text>
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
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

export default function App() {
  const [listo, setListo] = useState(false);
  // marca que hay pantalla de verdad (ver alFrente)
  useEffect(() => {
    pantallaVisible = AppState.currentState === "active";
    const sub = AppState.addEventListener("change", (st) => { pantallaVisible = st === "active"; });
    return () => { sub.remove(); pantallaVisible = false; };
  }, []);

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
        <Text style={{ color: "#888", marginTop: 4, fontSize: 13 }}>Movilidad y acarreos</Text>
        <ActivityIndicator color="#187830" style={{ marginTop: 20 }} />
        <Text style={{ color: "#aaa", marginTop: 10, fontSize: 12 }}>Buscando actualizaciones...</Text>
      </View>
    );
  }

  return (
    <SafeAreaProvider>
    <NavigationContainer ref={navRef}>
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
  container: { flex: 1, backgroundColor: "#F4F5F1" },
  scroll: { padding: 16 },
  header: { backgroundColor: "#187830", padding: 20, paddingTop: 50 },
  headerSub: { color: "rgba(255,255,255,0.8)", fontSize: 12 },
  headerTitle: { color: "#fff", fontSize: 24, fontWeight: "bold", marginTop: 4 },
  card: { backgroundColor: "#fff", borderRadius: 18, padding: 18, shadowColor: "#0C2C1B", shadowOffset: { width: 0, height: 6 }, shadowOpacity: 0.07, shadowRadius: 16, elevation: 3 },
  tabs: { flexDirection: "row", backgroundColor: "#F1F2EF", borderRadius: 12, padding: 4, marginBottom: 18 },
  tab: { flex: 1, padding: 9, borderRadius: 9, alignItems: "center" },
  tabActive: { backgroundColor: "#fff" },
  tabText: { color: "#888", fontSize: 14 },
  tabTextActive: { color: "#333", fontWeight: "500" },
  input: { borderWidth: 1.5, borderColor: "#D3D8CE", borderRadius: 12, paddingVertical: 13, paddingHorizontal: 14, marginBottom: 12, fontSize: 15, backgroundColor: "#F1F4EE", color: "#1D1D1D" },
  error: { color: "red", fontSize: 12, marginBottom: 12 },
  button: { backgroundColor: "#F06000", borderRadius: 14, padding: 15, alignItems: "center", justifyContent: "center", shadowColor: "#F06000", shadowOffset: { width: 0, height: 6 }, shadowOpacity: 0.26, shadowRadius: 12, elevation: 4 },
  buttonText: { color: "#fff", fontWeight: "800", fontSize: 16, letterSpacing: 0.2 },
  searchInput: { backgroundColor: "rgba(255,255,255,0.2)", borderRadius: 10, padding: 10, fontSize: 13, marginTop: 12, color: "#fff" },
  // --- carreras
  servicioCard: { backgroundColor: "#FDEEDC", borderRadius: 16, padding: 24, alignItems: "center", marginBottom: 16 },
  servicioTitulo: { fontSize: 20, fontWeight: "bold", color: "#F06000", marginTop: 10 },
  servicioSub: { fontSize: 13, color: "#888", marginTop: 4, textAlign: "center" },
  etiqueta: { fontSize: 11.5, color: "#9A9488", fontWeight: "800", letterSpacing: 1, marginBottom: 8, textTransform: "uppercase" },
  ayuda: { fontSize: 11, color: "#888", marginTop: -6, marginBottom: 6 },
  sugerencias: { backgroundColor: "#fff", borderWidth: 0.5, borderColor: "#ddd", borderRadius: 8, marginTop: -8, marginBottom: 12, overflow: "hidden" },
  sugerenciaItem: { paddingVertical: 10, paddingHorizontal: 12, borderBottomWidth: 0.5, borderBottomColor: "#eee" },
  seccionTitulo: { fontSize: 17, fontWeight: "800", color: "#1C2B22", marginBottom: 12, marginTop: 6, letterSpacing: -0.3 },
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
  botonGps: { backgroundColor: "#187830", borderRadius: 14, padding: 15, alignItems: "center", marginBottom: 8, shadowColor: "#187830", shadowOffset: { width: 0, height: 5 }, shadowOpacity: 0.22, shadowRadius: 10, elevation: 3 },
  muniBanner: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", backgroundColor: "#E7F3E9", borderRadius: 8, padding: 10, marginBottom: 12 },
  botonMapa: { borderWidth: 1.5, borderColor: "#BFE0C8", borderRadius: 14, padding: 14, alignItems: "center", marginBottom: 8, backgroundColor: "#F1F8F1" },
  botonMapaOk: { borderColor: "#187830", backgroundColor: "#EAF6EC" },
  estimado: { backgroundColor: "#F1F8F1", borderRadius: 10, padding: 14, marginTop: 6, alignItems: "center" },
  ofertaFila: { flexDirection: "row", alignItems: "center", borderWidth: 1, borderColor: "#187830", borderRadius: 10, paddingHorizontal: 12, backgroundColor: "#F1F8F1" },
  ofertaInput: { flex: 1, fontSize: 22, fontWeight: "bold", color: "#187830", padding: 12 },
  ofertaCliente: { backgroundColor: "#EAF6EC", borderRadius: 10, padding: 10, marginTop: 10, alignItems: "center" },
  opcion: { flex: 1, paddingVertical: 12, paddingHorizontal: 6, borderRadius: 12, borderWidth: 1, borderColor: "#E6E8E2", alignItems: "center", backgroundColor: "#F7F8F5" },
  opcionActiva: { backgroundColor: "#E7F3E9", borderColor: "#187830" },
  opcionTexto: { fontSize: 13, color: "#888" },
  opcionTextoActivo: { color: "#187830", fontWeight: "600" },
  // chips de ancho automatico para el scroll horizontal de dia/hora
  chip: { paddingVertical: 9, paddingHorizontal: 15, borderRadius: 22, borderWidth: 1, borderColor: "#E6E8E2", backgroundColor: "#F7F8F5" },
  chipOn: { backgroundColor: "#187830", borderColor: "#187830" },
  chipTxt: { fontSize: 13, color: "#555" },
  chipTxtOn: { color: "#fff", fontWeight: "700" },
  // tarjetas de categoria del registro (cliente / carreras / acarreos)
  catBoton: { flexDirection: "row", alignItems: "center", gap: 12, borderWidth: 1, borderColor: "#E6E8E2", borderRadius: 14, padding: 14, backgroundColor: "#fff" },
  catBotonOn: { borderColor: "#187830", backgroundColor: "#EAF6EC", borderWidth: 2 },
  catEmoji: { fontSize: 26 },
  catTitulo: { fontSize: 15, fontWeight: "700", color: "#333" },
  catTituloOn: { color: "#187830" },
  catSub: { fontSize: 12, color: "#888", marginTop: 1 },
  fondoModal: { flex: 1, backgroundColor: "rgba(0,0,0,0.5)", justifyContent: "center", padding: 24 },
  ventanaModal: { backgroundColor: "#fff", borderRadius: 16, padding: 20 },
  entranteFondo: { flex: 1, backgroundColor: "rgba(0,0,0,0.55)", justifyContent: "center", padding: 20 },
  entranteCard: { backgroundColor: "#fff", borderRadius: 20, overflow: "hidden", borderWidth: 2, borderColor: "#187830",
    shadowColor: "#000", shadowOpacity: 0.3, shadowRadius: 20, shadowOffset: { width: 0, height: 8 }, elevation: 12 },
  entranteBarraBg: { height: 6, backgroundColor: "#E7EFE8", width: "100%" },
  entranteBarra: { height: 6, backgroundColor: "#F06000" },
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