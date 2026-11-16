package app.ledger.importer

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * What the app remembers: the server, who logs in, the session cookie and the
 * list of accounts. The password is kept encrypted with a key that never
 * leaves the phone's keystore.
 */
class Prefs(context: Context) {
    private val p = context.applicationContext.getSharedPreferences("ledger", Context.MODE_PRIVATE)

    var server: String
        get() = p.getString("server", "") ?: ""
        set(v) = p.edit().putString("server", v.trim().trimEnd('/')).apply()

    var username: String
        get() = p.getString("username", "") ?: ""
        set(v) = p.edit().putString("username", v.trim()).apply()

    var cookie: String
        get() = p.getString("cookie", "") ?: ""
        set(v) = p.edit().putString("cookie", v).apply()

    /** The accounts as Ledger last listed them (JSON array), for choosing one with no connection. */
    var accountsJson: String
        get() = p.getString("accounts", "[]") ?: "[]"
        set(v) = p.edit().putString("accounts", v).apply()

    var lastAccount: String
        get() = p.getString("last_account", "") ?: ""
        set(v) = p.edit().putString("last_account", v).apply()

    var autoSend: Boolean
        get() = p.getBoolean("auto_send", true)
        set(v) = p.edit().putBoolean("auto_send", v).apply()

    var lastUpdateCheck: Long
        get() = p.getLong("update_check", 0)
        set(v) = p.edit().putLong("update_check", v).apply()

    val configured: Boolean get() = server.isNotEmpty() && username.isNotEmpty() && p.contains("password")

    var password: String
        get() {
            val stored = p.getString("password", null) ?: return ""
            return try {
                val raw = Base64.decode(stored, Base64.NO_WRAP)
                val cipher = Cipher.getInstance("AES/GCM/NoPadding")
                cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, raw, 0, 12))
                String(cipher.doFinal(raw, 12, raw.size - 12), Charsets.UTF_8)
            } catch (e: Exception) {
                "" // the key is gone (the phone was restored): ask again
            }
        }
        set(v) {
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.ENCRYPT_MODE, key())
            val out = cipher.iv + cipher.doFinal(v.toByteArray(Charsets.UTF_8))
            p.edit().putString("password", Base64.encodeToString(out, Base64.NO_WRAP)).apply()
        }

    private fun key(): SecretKey {
        val ks = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (ks.getKey(KEY, null) as? SecretKey)?.let { return it }
        val gen = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
        gen.init(
            KeyGenParameterSpec.Builder(KEY, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .build(),
        )
        return gen.generateKey()
    }

    companion object {
        private const val KEY = "ledger-import-password"
    }
}
