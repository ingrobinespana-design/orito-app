"""Direcciones colombianas calculadas con la malla de calles (OpenStreetMap).

"Calle 9 # 43B-30" significa: sobre la Calle 9, en la cuadra de la Carrera 43B,
a unos 30 m de la esquina. Con la red de calles de la ciudad se calcula el cruce
exacto (en OSM dos calles que se cruzan comparten el mismo punto) y se avanza la
placa en metros hacia la siguiente carrera. Asi se ubica la direccion aunque el
proveedor de mapas no la tenga registrada.

Datos: data/calles_<ciudad>.json.gz (© colaboradores de OpenStreetMap, ODbL).
Todo en memoria del servidor; la app no carga nada de esto.
"""
import gzip
import json
import math
import os
import re
import unicodedata

_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data")
_CIUDADES = {"cali": "calles_cali.json.gz"}
_cache = {}

VIAS = {
    "calle": "calle", "cl": "calle", "cll": "calle", "cale": "calle", "clle": "calle",
    "carrera": "carrera", "cra": "carrera", "cr": "carrera", "kr": "carrera", "kra": "carrera",
    "carera": "carrera", "carr": "carrera", "crr": "carrera",
    "avenida": "avenida", "av": "avenida", "ave": "avenida", "avda": "avenida",
    "diagonal": "diagonal", "dg": "diagonal", "diag": "diagonal",
    "transversal": "transversal", "tv": "transversal", "tr": "transversal", "transv": "transversal",
}
# con que tipo de via se cruza cada una (la placa "# 43B" es una carrera si vas por una calle)
CRUCES = {
    "calle": ["carrera", "transversal", "avenida", "diagonal"],
    "diagonal": ["carrera", "transversal", "avenida"],
    "carrera": ["calle", "diagonal", "avenida", "transversal"],
    "transversal": ["calle", "diagonal", "avenida"],
    "avenida": ["calle", "carrera", "diagonal", "transversal", "avenida"],
}
NOMBRE_VIA = {"calle": "Calle", "carrera": "Carrera", "avenida": "Avenida",
              "diagonal": "Diagonal", "transversal": "Transversal"}


def _norm(t):
    t = "".join(c for c in unicodedata.normalize("NFD", t or "") if unicodedata.category(c) != "Mn").lower()
    t = re.sub(r"[^a-z0-9#\- ]", " ", t)
    return re.sub(r"\s+", " ", t).strip()


def _datos(ciudad):
    k = _norm(ciudad).replace("santiago de ", "")
    if k not in _CIUDADES:
        return None
    if k not in _cache:
        try:
            with gzip.open(os.path.join(_DIR, _CIUDADES[k]), "rt", encoding="utf-8") as f:
                _cache[k] = json.load(f)["calles"]
        except Exception:
            _cache[k] = None
    return _cache[k]


def tiene_malla(ciudad):
    return _datos(ciudad or "") is not None


# "calle 9 # 43b-30", "cl 5 66 10", "cra 39 #10-20", "calle 13 n 100-00",
# "avenida 6 norte # 25-50", "calle 5 con carrera 66", "carrera 80 con calle 5"
_NUM = r"\d{1,3}(?:\s?[a-h](?![a-z]))?(?:\s?bis)?(?:\s?[a-h](?![a-z]))?"
_CARD = r"norte|sur|oeste|este"
_RX_DIR = re.compile(
    r"^(?P<via>[a-z]+)\.?\s*(?P<n1>" + _NUM + r")(?:\s(?P<c1>" + _CARD + r"))?"
    + r"\s*(?:(?:#|nro|numero|num|no|n)(?![a-z]))?\s*"
    + r"(?:(?P<via2>[a-z]+)\.?\s*)?(?P<n2>" + _NUM + r")(?:\s(?P<c2>" + _CARD + r"))?"
    + r"(?:\s*-\s*|\s+)?(?P<placa>\d{1,3})?\s*$")
_RX_CON = re.compile(r"\s(con|y|x|&)\s")


def parsear(texto):
    """-> dict(via, n1, c1, via2, n2, c2, placa, es_cruce) o None si no es direccion."""
    t = _norm(texto)
    es_cruce = bool(_RX_CON.search(" " + t + " "))
    t = _RX_CON.sub(" ", " " + t + " ").strip()
    t = re.sub(r"\s*#\s*", " # ", t)
    m = _RX_DIR.match(t)
    if not m:
        return None
    via = VIAS.get(m.group("via"))
    if not via:
        return None
    via2 = VIAS.get(m.group("via2")) if m.group("via2") else None
    if m.group("via2") and not via2:
        return None
    lim = lambda s: re.sub(r"\s+", " ", (s or "").strip())
    return {"via": via, "n1": lim(m.group("n1")), "c1": m.group("c1") or "",
            "via2": via2, "n2": lim(m.group("n2")), "c2": m.group("c2") or "",
            "placa": int(m.group("placa")) if m.group("placa") else None, "es_cruce": es_cruce}


def _variantes(via, num, card):
    """'43b' -> ['carrera 43b', 'carrera 43 b']; con cardinal tambien sin el."""
    n = num.replace(" ", "")
    n2 = re.sub(r"^(\d+)([a-h])", r"\1 \2", n)
    n2 = re.sub(r"bis", " bis", n2).strip()
    base = [f"{via} {n}", f"{via} {n2}"]
    if card:
        return [f"{b} {card}" for b in base] + base
    return base


def _dist_m(a, b):
    la = math.radians((a[0] + b[0]) / 2)
    return math.hypot((a[0] - b[0]) * 111320, (a[1] - b[1]) * 111320 * math.cos(la))


def _puntos(calles, nombres):
    out = []
    for n in nombres:
        for pl in calles.get(n, []):
            out.extend((pl[i], pl[i + 1]) for i in range(0, len(pl), 2))
        if out:
            return n, out
    return None, []


def _cruce(calles, nombres_a, nombres_b, cerca=None, max_m=40.0):
    """Punto donde se cruzan A y B: nodo compartido o, si no, el punto de A mas cercano
    a B (hasta max_m). Con max_m grande sirve para diagonales/transversales, que se
    numeran por la carrera cercana aunque no la toquen."""
    na, pa = _puntos(calles, nombres_a)
    nb, pb = _puntos(calles, nombres_b)
    if not pa or not pb:
        return None
    sb = set(pb)
    comunes = [p for p in pa if p in sb]
    if not comunes:
        celdas = {}
        for p in pb:
            celdas.setdefault((round(p[0], 3), round(p[1], 3)), []).append(p)
        mejor, dmin = None, max_m
        r = max(1, int(max_m // 100) + 1)
        pasos = [i * 0.001 for i in range(-r, r + 1)]
        for p in pa:
            for dx in pasos:
                for dy in pasos:
                    for q in celdas.get((round(p[0] + dx, 3), round(p[1] + dy, 3)), []):
                        dd = _dist_m(p, q)
                        if dd < dmin:
                            # cruce real (<40 m): el medio; aproximado: sobre la via principal
                            mejor, dmin = (((p[0] + q[0]) / 2, (p[1] + q[1]) / 2) if dd < 40 else p), dd
        comunes = [mejor] if mejor else []
    if not comunes:
        return None
    if cerca and len(comunes) > 1:
        comunes.sort(key=lambda p: _dist_m(p, cerca))
    return comunes[0], na, nb, pa


def _siguiente(num):
    m = re.match(r"(\d+)", num.replace(" ", ""))
    return str(int(m.group(1)) + 1) if m else None


def ubicar(texto, ciudad, cerca=None):
    """-> {lat, lon, titulo, detalle, exacta} o None."""
    calles = _datos(ciudad or "")
    if not calles:
        return None
    d = parsear(texto)
    if not d:
        return None
    vias_b = [d["via2"]] if d["via2"] else CRUCES.get(d["via"], [])
    nombres_a = _variantes(d["via"], d["n1"], d["c1"])
    intentos = [(vb, m) for m in (40.0, 450.0) for vb in vias_b]
    for vb, max_m in intentos:
        nombres_b = _variantes(vb, d["n2"], d["c2"] or d["c1"])
        r = _cruce(calles, nombres_a, nombres_b, cerca, max_m)
        if not r:
            continue
        exacta = max_m <= 40.0
        (lat, lon), na, nb, pa = r
        placa = d["placa"]
        # avanza la placa (metros) por la via principal hacia la siguiente via del cruce
        if placa and placa > 0 and exacta:
            sig = _siguiente(d["n2"])
            r2 = _cruce(calles, nombres_a, _variantes(vb, sig, d["c2"] or d["c1"]), (lat, lon)) if sig else None
            if r2:
                (lat2, lon2) = r2[0]
                total = _dist_m((lat, lon), (lat2, lon2))
                if 20 < total < 400:
                    f = min(placa / total, 0.9)
                    lat, lon = lat + (lat2 - lat) * f, lon + (lon2 - lon) * f
        t1 = f"{NOMBRE_VIA[d['via']]} {d['n1'].upper()}{(' ' + d['c1'].capitalize()) if d['c1'] else ''}"
        t2 = d["n2"].upper() + ((" " + d["c2"].capitalize()) if d["c2"] else "")
        if d["es_cruce"] or not placa:
            titulo = f"{t1} con {NOMBRE_VIA[vb]} {t2}"
        else:
            titulo = f"{t1} # {t2}-{placa:02d}"
        return {"lat": round(lat, 6), "lon": round(lon, 6), "titulo": titulo,
                "detalle": f"{ciudad.strip().title()} · " + ("dirección exacta" if exacta else "ubicación aproximada, ajusta el pin"),
                "exacta": exacta}
    return None
