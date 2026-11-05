package expo.modules.tukanoverlay

import android.app.ActivityManager
import android.app.KeyguardManager
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.media.AudioAttributes
import android.net.Uri
import android.os.Build
import android.provider.Settings
import com.google.firebase.messaging.RemoteMessage
import expo.modules.notifications.service.ExpoFirebaseMessagingService
import org.json.JSONObject

// Recibe los push ANTES que el JavaScript. Android congela el JS de una app en
// segundo plano o con el telefono bloqueado, y el aviso "de datos" (solicitud
// nueva / cancelacion) solo se procesaba al volver a abrir Tukan. Aqui, en codigo
// nativo, se muestra de una el aviso tipo llamada (pantalla completa) y, con el
// permiso "Mostrar encima de otras apps", se trae Tukan al frente. Despues se le
// pasa el mensaje a Expo igual que siempre (nada de lo de antes se pierde).
class TukanMessagingService : ExpoFirebaseMessagingService() {

  override fun onMessageReceived(remoteMessage: RemoteMessage) {
    try {
      manejar(remoteMessage)
    } catch (e: Throwable) {
      diag(this, "nativo_error", e.toString())
    }
    super.onMessageReceived(remoteMessage)
  }

  private fun manejar(m: RemoteMessage) {
    diag(this, "nativo_recibido", "notif=" + (m.notification != null) + " keys=" + m.data.keys.joinToString(","))
    if (m.notification != null) return               // el push normal lo maneja Expo
    val raw = m.data["body"] ?: m.data["dataString"] ?: return
    val j = try { JSONObject(raw) } catch (e: Throwable) { return }
    val tipo = j.optString("tipo")
    if (tipo != "carrera_nueva" && tipo != "carrera_cancelada") return
    if (!j.has("titulo")) return                      // solo el push "de datos" del conductor
    if (appAlFrente(this)) { diag(this, "nativo_app_al_frente", tipo); return }   // con Tukan abierto y desbloqueado, lo maneja la pantalla
    val titulo = j.optString("titulo", "Tukán")
    val cuerpo = j.optString("cuerpo", "")
    val carreraId = j.optInt("carrera_id", 0)
    mostrarLlamada(this, tipo, carreraId, titulo, cuerpo)
    val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    val fsi = if (Build.VERSION.SDK_INT >= 34) nm.canUseFullScreenIntent().toString() else "n/a"
    val sobre = Build.VERSION.SDK_INT < Build.VERSION_CODES.M || Settings.canDrawOverlays(this)
    diag(this, "nativo_mostrado", "tipo=$tipo id=$carreraId fullscreen=$fsi sobre=$sobre sdk=${Build.VERSION.SDK_INT}")
    if (sobre) {
      abrirTukan(this, tipo, carreraId)
    }
  }

  companion object {
    // reporte de depuracion al servidor (sin datos personales)
    fun diag(ctx: Context, paso: String, detalle: String) {
      Thread {
        try {
          val c = java.net.URL("https://orito-app-production.up.railway.app/diag/evento").openConnection() as java.net.HttpURLConnection
          c.requestMethod = "POST"; c.doOutput = true; c.connectTimeout = 8000; c.readTimeout = 8000
          c.setRequestProperty("Content-Type", "text/plain")
          val cuerpo = JSONObject().put("paso", paso).put("detalle", detalle).toString()
          c.outputStream.use { it.write(cuerpo.toByteArray()) }
          c.responseCode; c.disconnect()
        } catch (e: Throwable) {}
      }.start()
    }

    const val CANAL = "tukan_llamada_selva"   // canal nuevo: el sonido de un canal no se puede cambiar
    const val TAG = "tukan_llamada"

    fun appAlFrente(ctx: Context): Boolean {
      val info = ActivityManager.RunningAppProcessInfo()
      ActivityManager.getMyMemoryState(info)
      val km = ctx.getSystemService(Context.KEYGUARD_SERVICE) as KeyguardManager
      return info.importance == ActivityManager.RunningAppProcessInfo.IMPORTANCE_FOREGROUND && !km.isKeyguardLocked
    }

    private fun intentApp(ctx: Context, tipo: String, carreraId: Int): Intent? {
      val i = ctx.packageManager.getLaunchIntentForPackage(ctx.packageName) ?: return null
      i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_REORDER_TO_FRONT or Intent.FLAG_ACTIVITY_SINGLE_TOP)
      i.putExtra("tukan_tipo", tipo)
      i.putExtra("tukan_carrera", carreraId)
      return i
    }

    fun abrirTukan(ctx: Context, tipo: String, carreraId: Int) {
      try {
        val i = intentApp(ctx, tipo, carreraId) ?: return
        ctx.startActivity(i)
      } catch (e: Throwable) {}
    }

    fun mostrarLlamada(ctx: Context, tipo: String, carreraId: Int, titulo: String, cuerpo: String) {
      val nm = ctx.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
      val sonido = Uri.parse("android.resource://" + ctx.packageName + "/raw/tono_selva")
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        try { nm.deleteNotificationChannel("tukan_llamada") } catch (e: Throwable) {}   // el del tono viejo
      }
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && nm.getNotificationChannel(CANAL) == null) {
        val canal = NotificationChannel(CANAL, "Solicitudes tipo llamada", NotificationManager.IMPORTANCE_HIGH)
        canal.description = "Solicitudes y cancelaciones que saltan encima de todo"
        canal.enableVibration(true)
        canal.vibrationPattern = longArrayOf(0, 500, 300, 500, 300, 500)
        canal.lockscreenVisibility = Notification.VISIBILITY_PUBLIC
        canal.setBypassDnd(true)
        canal.setSound(sonido, AudioAttributes.Builder()
          .setUsage(AudioAttributes.USAGE_NOTIFICATION_RINGTONE)
          .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION).build())
        nm.createNotificationChannel(canal)
      }
      val abrir = intentApp(ctx, tipo, carreraId) ?: return
      val flags = PendingIntent.FLAG_UPDATE_CURRENT or (if (Build.VERSION.SDK_INT >= 23) PendingIntent.FLAG_IMMUTABLE else 0)
      val pi = PendingIntent.getActivity(ctx, carreraId, abrir, flags)
      val icono = ctx.resources.getIdentifier("notification_icon", "drawable", ctx.packageName)
        .takeIf { it != 0 } ?: ctx.applicationInfo.icon
      val b = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) Notification.Builder(ctx, CANAL) else Notification.Builder(ctx)
      b.setSmallIcon(icono)
        .setContentTitle(titulo)
        .setContentText(cuerpo)
        .setStyle(Notification.BigTextStyle().bigText(cuerpo))
        .setCategory(Notification.CATEGORY_CALL)
        .setVisibility(Notification.VISIBILITY_PUBLIC)
        .setAutoCancel(true)
        .setContentIntent(pi)
        .setFullScreenIntent(pi, true)
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) b.setTimeoutAfter(90000)
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
        @Suppress("DEPRECATION")
        b.setPriority(Notification.PRIORITY_MAX).setSound(sonido).setVibrate(longArrayOf(0, 500, 300, 500))
      }
      nm.notify(TAG, carreraId, b.build())
    }

    fun quitarTodas(ctx: Context) {
      try {
        val nm = ctx.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (Build.VERSION.SDK_INT >= 23) {
          for (n in nm.activeNotifications) if (n.tag == TAG) nm.cancel(TAG, n.id)
        }
      } catch (e: Throwable) {}
    }
  }
}
