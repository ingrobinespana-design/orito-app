"""Distancia entre dos puntos y tarifa sugerida.

Todo se calcula aca adentro, sin llamar a ninguna API de mapas: la formula de
Haversine da la distancia exacta en linea recta entre dos coordenadas y no
cuesta un peso. La contra es que la calle no va en linea recta, asi que se
aplica un factor de correccion para acercarse al recorrido real.

La tarifa que sale es una SUGERENCIA. En transporte informal el precio se
acuerda entre las partes; la app propone y el conductor confirma al final lo
que de verdad cobro.
"""
import math

# Cuanto mas largo es el recorrido real que la linea recta. 1.3 es lo habitual
# en una malla urbana de calles y carreras: se anda en L, no en diagonal.
FACTOR_CALLE = 1.3

RADIO_TIERRA_KM = 6371.0


def distancia_km(lat1, lon1, lat2, lon2):
    """Kilometros en linea recta entre dos coordenadas (Haversine)."""
    if None in (lat1, lon1, lat2, lon2):
        return None
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = math.radians(lat2 - lat1)
    dl = math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return RADIO_TIERRA_KM * 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))


def distancia_por_calle(lat1, lon1, lat2, lon2):
    """La linea recta corregida para parecerse al recorrido real."""
    recta = distancia_km(lat1, lon1, lat2, lon2)
    return None if recta is None else round(recta * FACTOR_CALLE, 2)


def redondear_a_mil(valor):
    """En efectivo nadie cobra $7.340. Se redondea al mil de arriba."""
    return int(math.ceil(valor / 1000.0) * 1000)


def calcular_tarifa(km, base, valor_km, minima):
    """base + km recorridos, nunca por debajo de la minima, redondeado al mil."""
    if km is None or not valor_km:
        return None
    return max(redondear_a_mil((base or 0) + km * valor_km), minima or 0)
