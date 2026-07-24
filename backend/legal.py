# -*- coding: utf-8 -*-
"""Paginas legales de Tukan servidas por el backend (URL publica, requisito de
Play Store y buena practica para facturar). BORRADOR SOLIDO adaptado a Colombia
(Ley 1581 de 2012, Habeas Data). El usuario deberia hacerlo revisar por un
abogado y confirmar los datos del 'Responsable' antes de considerarlo final."""

RESPONSABLE = "Darwin España"
MARCA = "Tukán"
CORREO = "ingrobinespana@gmail.com"
WHATSAPP = "+57 315 600 9728"
WHATSAPP_LINK = "https://wa.me/573156009728"
LUGAR = "Putumayo, Colombia"
ACTUALIZADO = "24 de julio de 2026"


def _pagina(titulo, cuerpo):
    return f"""<!DOCTYPE html>
<html lang="es"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{titulo} — {MARCA}</title>
<style>
  body{{margin:0;font-family:-apple-system,Roboto,'Segoe UI',sans-serif;background:#F6F1E6;color:#26332B;line-height:1.6}}
  .caja{{max-width:720px;margin:0 auto;padding:26px 20px 60px}}
  .top{{display:flex;align-items:center;gap:12px;margin-bottom:8px}}
  .top img{{width:46px;height:46px;border-radius:12px}}
  .top b{{font-size:22px;color:#187830}}
  h1{{font-size:26px;margin:14px 0 2px;color:#0E3D1E}}
  .fecha{{color:#7A8C80;font-size:13px;margin-bottom:22px}}
  h2{{font-size:18px;color:#187830;margin:26px 0 6px}}
  p,li{{font-size:15px}}
  a{{color:#187830}}
  .nav{{margin:6px 0 18px;font-size:14px}}
  .pie{{color:#7A8C80;font-size:12px;margin-top:34px;border-top:1px solid #DFD8C6;padding-top:16px}}
  .caja-info{{background:#EAF6EC;border-radius:12px;padding:14px 16px;margin:14px 0;font-size:14px}}
</style></head><body><div class="caja">
  <div class="top"><img src="/logo.png" alt="{MARCA}"><b>{MARCA}</b></div>
  <div class="nav"><a href="/terminos">Términos y condiciones</a> · <a href="/privacidad">Privacidad y Habeas Data</a> · <a href="/app">Descargar</a></div>
  {cuerpo}
  <div class="pie">{MARCA} · {LUGAR} · Responsable: {RESPONSABLE}<br>
  Contacto: <a href="mailto:{CORREO}">{CORREO}</a> · WhatsApp <a href="{WHATSAPP_LINK}">{WHATSAPP}</a></div>
</div></body></html>"""


def terminos_html():
    cuerpo = f"""
  <h1>Términos y Condiciones de Uso</h1>
  <div class="fecha">Última actualización: {ACTUALIZADO}</div>

  <p>Estos términos regulan el uso de la aplicación <b>{MARCA}</b> ("la App"), operada por
  {RESPONSABLE} ("nosotros"). Al registrarte y usar la App, aceptas estos términos. Si no estás
  de acuerdo, por favor no uses la App.</p>

  <h2>1. Qué es Tukán</h2>
  <p>{MARCA} es una plataforma tecnológica que <b>conecta</b> a personas que necesitan un servicio de
  transporte de pasajeros, domicilios o acarreos ("Clientes") con transportadores independientes
  ("Transportadores") en el Bajo Putumayo. {MARCA} <b>no presta directamente el servicio de transporte</b>,
  no es dueña de los vehículos ni emplea a los Transportadores: solo facilita el contacto entre las partes.</p>

  <h2>2. Los Transportadores son independientes</h2>
  <p>Cada Transportador es un trabajador independiente, responsable de contar con su licencia de conducción
  vigente, los documentos y seguros de su vehículo (SOAT, tecnomecánica cuando aplique) y de cumplir las
  normas de tránsito. {MARCA} solicita fotos de verificación (persona, vehículo y tarjeta de propiedad),
  pero no garantiza ni responde por el estado de los vehículos ni por la conducta de los Transportadores
  durante el servicio.</p>

  <h2>3. Precio del servicio</h2>
  <p>El precio de cada carrera o acarreo <b>se negocia y acuerda directamente entre el Cliente y el
  Transportador</b>. {MARCA} solo puede mostrar un valor sugerido como orientación; no fija ni cobra la
  tarifa del viaje.</p>

  <h2>4. Pagos</h2>
  <p>El pago del viaje se hace <b>directamente entre el Cliente y el Transportador</b> (efectivo, Nequi,
  Daviplata, transferencia u otro medio que acuerden). <b>{MARCA} no procesa, retiene ni intermedia el
  dinero del viaje.</b> La única relación de cobro de {MARCA} es la suscripción mensual que el Transportador
  paga para poder recibir solicitudes, la cual es opcional y puede iniciar de forma gratuita durante el
  periodo de lanzamiento.</p>

  <h2>5. Uso correcto</h2>
  <p>Te comprometes a dar información veraz, a no usar la App para actividades ilegales, fraudulentas o que
  pongan en riesgo a otras personas, y a tratar con respeto a las demás partes. Podemos suspender o cerrar
  cuentas que incumplan estas reglas.</p>

  <h2>6. Ubicación</h2>
  <p>Para funcionar, la App usa la ubicación del dispositivo (ver la <a href="/privacidad">Política de
  Privacidad</a>). El Transportador comparte su ubicación mientras tiene un servicio activo para que el
  Cliente pueda verlo llegar.</p>

  <h2>7. Limitación de responsabilidad</h2>
  <p>{MARCA} actúa únicamente como intermediario tecnológico. En la medida permitida por la ley, no somos
  responsables por daños, pérdidas, accidentes, retrasos, incumplimientos o desacuerdos que ocurran entre
  Clientes y Transportadores durante o con ocasión del servicio. Cualquier reclamo por el servicio de
  transporte debe resolverse entre las partes involucradas.</p>

  <h2>8. Disponibilidad</h2>
  <p>Procuramos que la App funcione de forma continua, pero puede haber interrupciones por mantenimiento,
  fallas técnicas o causas fuera de nuestro control. No garantizamos disponibilidad ininterrumpida.</p>

  <h2>9. Cambios</h2>
  <p>Podemos actualizar estos términos. Publicaremos la versión vigente en esta página con su fecha. El uso
  continuado de la App después de un cambio significa que lo aceptas.</p>

  <h2>10. Ley aplicable</h2>
  <p>Estos términos se rigen por las leyes de la República de Colombia. Cualquier controversia se tramitará
  ante los jueces competentes de {LUGAR}.</p>

  <div class="caja-info">¿Preguntas sobre estos términos? Escríbenos al correo
  <a href="mailto:{CORREO}">{CORREO}</a> o al WhatsApp <a href="{WHATSAPP_LINK}">{WHATSAPP}</a>.</div>
"""
    return _pagina("Términos y Condiciones", cuerpo)


def privacidad_html():
    cuerpo = f"""
  <h1>Política de Privacidad y Tratamiento de Datos</h1>
  <div class="fecha">Última actualización: {ACTUALIZADO} · Conforme a la Ley 1581 de 2012 (Habeas Data) de Colombia</div>

  <p>En {MARCA} respetamos tus datos personales. Esta política explica qué datos recogemos, para qué, y
  cuáles son tus derechos. El <b>Responsable del Tratamiento</b> es {RESPONSABLE}, con contacto en
  <a href="mailto:{CORREO}">{CORREO}</a> y WhatsApp <a href="{WHATSAPP_LINK}">{WHATSAPP}</a>, en {LUGAR}.</p>

  <h2>1. Qué datos recogemos</h2>
  <ul>
    <li><b>De registro:</b> tu nombre y número de teléfono. La contraseña se guarda <b>cifrada</b> (ni
      nosotros podemos verla).</li>
    <li><b>De ubicación:</b> la ubicación de tu dispositivo (GPS) para detectar tu municipio, marcar el
      punto de recogida y destino, calcular distancias y —en el caso del Transportador con un servicio
      activo— mostrar en vivo dónde va, incluso con la app en segundo plano.</li>
    <li><b>Del servicio:</b> el origen, destino, precio acordado e historial de tus carreras o acarreos.</li>
    <li><b>Del Transportador:</b> tipo y placa del vehículo, fotos de la persona, del vehículo y de la
      tarjeta de propiedad (esta última solo para verificación, no se muestra a los Clientes), y los medios
      de pago que declara aceptar.</li>
  </ul>

  <h2>2. Para qué los usamos</h2>
  <p>Únicamente para prestar el servicio: conectar Clientes con Transportadores, mostrar la ubicación en
  vivo, orientar el precio, enviar notificaciones de tus servicios, y llevar estadísticas de uso.
  <b>No vendemos tus datos.</b></p>

  <h2>3. Con quién se comparten</h2>
  <ul>
    <li><b>Entre las partes de un servicio:</b> cuando un Transportador acepta, el Cliente ve su nombre,
      foto, placa y teléfono para poder contactarlo, y viceversa. Esto es necesario para que el servicio
      funcione y para tu seguridad.</li>
    <li><b>Proveedores tecnológicos</b> que nos ayudan a operar: almacenamiento seguro de imágenes,
      alojamiento del servidor y envío de notificaciones. Solo acceden a lo necesario para su función.</li>
    <li><b>Autoridades</b>, cuando la ley lo exija.</li>
  </ul>

  <h2>4. Pagos</h2>
  <p>La App <b>no procesa el dinero de los viajes</b>. No pedimos ni almacenamos números de tarjetas ni
  claves bancarias. El pago es directo entre las partes.</p>

  <h2>5. Cómo protegemos tus datos</h2>
  <p>Usamos conexión cifrada (HTTPS), contraseñas cifradas, y acceso restringido: cada persona solo puede
  ver y modificar su propia información. El panel de administración está protegido con clave.</p>

  <h2>6. Tus derechos (Habeas Data)</h2>
  <p>Como titular de tus datos, tienes derecho a: <b>conocer, actualizar y rectificar</b> tus datos;
  solicitar prueba de la autorización; ser informado sobre su uso; presentar quejas ante la
  Superintendencia de Industria y Comercio; y <b>revocar la autorización o solicitar la supresión</b> de
  tus datos cuando no exista un deber legal de conservarlos.</p>
  <p>Para ejercer cualquiera de estos derechos, escríbenos a <a href="mailto:{CORREO}">{CORREO}</a> o al
  WhatsApp <a href="{WHATSAPP_LINK}">{WHATSAPP}</a>. Atenderemos tu solicitud en los plazos que fija la Ley
  1581 de 2012.</p>

  <h2>7. Autorización</h2>
  <p>Al registrarte y usar {MARCA}, <b>autorizas de manera libre, previa, expresa e informada</b> el
  tratamiento de tus datos personales para las finalidades descritas en esta política.</p>

  <h2>8. Conservación</h2>
  <p>Conservamos tus datos mientras tengas cuenta activa y por el tiempo necesario para cumplir obligaciones
  legales. Luego se eliminan o anonimizan.</p>

  <h2>9. Menores de edad</h2>
  <p>{MARCA} está dirigida a personas mayores de edad. No recogemos datos de menores de forma consciente.</p>

  <h2>10. Cambios</h2>
  <p>Podemos actualizar esta política; la versión vigente estará siempre en esta página con su fecha.</p>

  <div class="caja-info">Responsable del Tratamiento: <b>{RESPONSABLE}</b> · {LUGAR}<br>
  Ejerce tus derechos en <a href="mailto:{CORREO}">{CORREO}</a> o WhatsApp <a href="{WHATSAPP_LINK}">{WHATSAPP}</a>.</div>
"""
    return _pagina("Privacidad y Habeas Data", cuerpo)
