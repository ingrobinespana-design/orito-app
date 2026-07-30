"""Notificaciones push via Expo.

Usa urllib de la libreria estandar a proposito: no agrega dependencias nuevas al
deploy de Railway. Nada de lo que pasa aca puede tumbar una carrera — si Expo esta
caido o el celular perdio el token, se falla en silencio y la app sigue andando
(el conductor igual ve las carreras al refrescar cada 8 segundos).
"""
import json
import logging
import urllib.request
import urllib.error

log = logging.getLogger("push")

EXPO_URL = "https://exp.host/--/api/v2/push/send"
TIMEOUT = 10


def _es_token_valido(token):
    return bool(token) and token.startswith(("ExponentPushToken[", "ExpoPushToken["))


def enviar(mensajes):
    """Manda un lote a Expo. Devuelve los tokens que Expo reporta como muertos
    (celular desinstalado o token vencido) para poder limpiarlos de la base."""
    mensajes = [m for m in mensajes if _es_token_valido(m.get("to"))]
    if not mensajes:
        return []

    peticion = urllib.request.Request(
        EXPO_URL,
        data=json.dumps(mensajes).encode("utf-8"),
        headers={"Content-Type": "application/json", "Accept": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(peticion, timeout=TIMEOUT) as resp:
            respuesta = json.loads(resp.read().decode("utf-8"))
    except Exception as e:
        log.warning("No se pudo enviar la notificacion: %s", e)
        return []

    muertos = []
    datos = respuesta.get("data") or []
    for mensaje, resultado in zip(mensajes, datos):
        if not isinstance(resultado, dict) or resultado.get("status") != "error":
            continue
        detalles = resultado.get("details") or {}
        if detalles.get("error") == "DeviceNotRegistered":
            muertos.append(mensaje["to"])
        else:
            log.warning("Expo rechazo un mensaje: %s", resultado.get("message"))
    return muertos


def mensaje(token, titulo, cuerpo, datos=None, canal="carreras3"):
    return {
        "to": token,
        "title": titulo,
        "body": cuerpo,
        "sound": "default",
        # "high" es lo que hace que suene de una y no espere a que el celular
        # decida despertar; sin esto Android la puede demorar varios minutos
        "priority": "high",
        "channelId": canal,
        "data": datos or {},
    }
