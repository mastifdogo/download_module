package app.ledger.importer

import android.os.Bundle
import android.view.View
import android.widget.EditText
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import com.google.android.material.button.MaterialButton
import com.google.android.material.materialswitch.MaterialSwitch
import kotlin.concurrent.thread

/** Where the server is and who logs in; sending by itself; the app's version and updates. */
class SettingsActivity : AppCompatActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_settings)
        val prefs = Prefs(this)
        val server = findViewById<EditText>(R.id.server)
        val username = findViewById<EditText>(R.id.username)
        val password = findViewById<EditText>(R.id.password)
        val result = findViewById<TextView>(R.id.result)
        val save = findViewById<MaterialButton>(R.id.save)
        server.setText(prefs.server)
        username.setText(prefs.username)
        if (prefs.configured) password.hint = "(saved; type to replace)"

        save.setOnClickListener {
            var address = server.text.toString().trim().trimEnd('/')
            if (address.isNotEmpty() && !address.startsWith("http://") && !address.startsWith("https://")) address = "http://$address"
            if (address.isEmpty() || username.text.isBlank() || (password.text.isEmpty() && !prefs.configured)) {
                result.text = "Enter the server's address, your username and your password."
                return@setOnClickListener
            }
            prefs.server = address
            prefs.username = username.text.toString()
            if (password.text.isNotEmpty()) prefs.password = password.text.toString()
            prefs.cookie = ""
            server.setText(address)
            save.isEnabled = false
            result.text = "Connecting…"
            thread {
                val text = try {
                    val client = LedgerClient(prefs)
                    client.login()
                    val who = client.whoAmI()
                    val n = client.refreshAccounts().size
                    "Connected as $who. $n accounts to choose from."
                } catch (e: ServerException) {
                    "The server said: ${e.message}"
                } catch (e: Exception) {
                    "Can't reach $address (${e.message ?: e.javaClass.simpleName}). Check the address, and that this phone is on the same network or VPN as the server."
                }
                runOnUiThread {
                    save.isEnabled = true
                    result.text = text
                }
            }
        }

        val auto = findViewById<MaterialSwitch>(R.id.auto)
        auto.isChecked = prefs.autoSend
        auto.setOnCheckedChangeListener { _, on ->
            prefs.autoSend = on
            Sender.schedule(this)
        }

        val version = findViewById<TextView>(R.id.version)
        version.text = "Ledger Import ${BuildConfig.VERSION_NAME}. It updates itself from the Import module's releases."
        val check = findViewById<MaterialButton>(R.id.check)
        check.setOnClickListener {
            check.isEnabled = false
            version.text = "Looking for an update…"
            thread {
                val text = try {
                    val release = Updater.latest()
                    when {
                        release == null -> "Ledger Import ${BuildConfig.VERSION_NAME}. No release with the app was found."
                        !Updater.isNewer(release.version) -> "Ledger Import ${BuildConfig.VERSION_NAME} is the newest."
                        else -> {
                            Updater.install(applicationContext, release)
                            "Installing version ${release.version}… Android may ask you to confirm."
                        }
                    }
                } catch (e: Exception) {
                    "Couldn't check: ${e.message ?: e.javaClass.simpleName}"
                }
                runOnUiThread {
                    check.isEnabled = true
                    check.visibility = View.VISIBLE
                    version.text = text
                }
            }
        }
    }
}
