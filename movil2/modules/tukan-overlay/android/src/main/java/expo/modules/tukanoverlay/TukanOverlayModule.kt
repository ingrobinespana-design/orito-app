package expo.modules.tukanoverlay

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.Settings
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

// Trae Tukan al frente (encima de la app que el conductor este usando: Waze,
// WhatsApp...) cuando llega una solicitud o una cancelacion. Android solo deja
// abrir una app desde segundo plano si tiene el permiso "Mostrar encima de otras
// apps" (SYSTEM_ALERT_WINDOW); por eso tambien se puede consultar y pedir.
class TukanOverlayModule : Module() {
  private val context: Context
    get() = appContext.reactContext ?: throw Exceptions.ReactContextLost()

  override fun definition() = ModuleDefinition {
    Name("TukanOverlay")

    Function("puedeSobreponer") {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) Settings.canDrawOverlays(context) else true
    }

    Function("pedirPermiso") {
      val intent = Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION, Uri.parse("package:" + context.packageName))
      intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      context.startActivity(intent)
      true
    }

    // true = este APK trae el receptor nativo de push (TukanMessagingService)
    Function("avisoNativo") { true }

    // este APK trae el tono "Selva" (raw/tono_selva) y sus canales nuevos
    Function("tonoSelva") { true }

    // quita los avisos tipo llamada nativos (al abrir la solicitud en la app)
    Function("quitarAvisos") {
      TukanMessagingService.quitarTodas(context)
      true
    }

    Function("traerAlFrente") {
      val intent = context.packageManager.getLaunchIntentForPackage(context.packageName)
      if (intent == null) {
        false
      } else {
        intent.addFlags(
          Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_REORDER_TO_FRONT or Intent.FLAG_ACTIVITY_SINGLE_TOP
        )
        context.startActivity(intent)
        true
      }
    }
  }
}
