// Modulo nativo propio. En APKs viejos no existe: devuelve null y la app sigue igual.
import { requireOptionalNativeModule } from "expo-modules-core";

export default requireOptionalNativeModule("TukanOverlay");
