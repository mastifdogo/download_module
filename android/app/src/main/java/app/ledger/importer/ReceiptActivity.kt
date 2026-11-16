package app.ledger.importer

import android.content.ActivityNotFoundException
import android.content.Intent
import android.os.Bundle
import android.speech.RecognizerIntent
import android.widget.ArrayAdapter
import android.widget.EditText
import android.widget.Spinner
import android.widget.TextView
import android.widget.Toast
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import com.google.android.material.button.MaterialButton
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/** After a scan: which account, a note (typed or spoken), and off it goes. */
class ReceiptActivity : AppCompatActivity() {
    private lateinit var note: EditText

    // The phone's own speech-to-text: what was said is added to the note.
    private val speech = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        val said = result.data?.getStringArrayListExtra(RecognizerIntent.EXTRA_RESULTS)?.firstOrNull()?.trim()
        if (result.resultCode == RESULT_OK && !said.isNullOrEmpty()) {
            val now = note.text.toString().trim()
            note.setText(if (now.isEmpty()) said else "$now $said")
            note.setSelection(note.text.length)
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_receipt)
        val prefs = Prefs(this)
        val scan = File(cacheDir, "scan.pdf")
        if (!scan.exists()) {
            finish()
            return
        }
        val pages = intent.getIntExtra(PAGES, 1)
        findViewById<TextView>(R.id.summary).text = "Scanned $pages page${if (pages == 1) "" else "s"} (${scan.length() / 1024} KB)"

        val none = Account("", "No account (decide in Ledger)", "", "")
        val accounts = listOf(none) + LedgerClient.accounts(prefs)
        val spinner = findViewById<Spinner>(R.id.account)
        spinner.adapter = ArrayAdapter(this, android.R.layout.simple_spinner_dropdown_item, accounts)
        spinner.setSelection(accounts.indexOfFirst { it.code == prefs.lastAccount }.coerceAtLeast(0))

        note = findViewById(R.id.note)
        val name = findViewById<EditText>(R.id.name)
        name.setText("Receipt ${SimpleDateFormat("yyyy-MM-dd HHmm", Locale.US).format(Date())}.pdf")

        findViewById<MaterialButton>(R.id.speak).setOnClickListener {
            val ask = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH)
                .putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
                .putExtra(RecognizerIntent.EXTRA_PROMPT, "Say the note")
            try {
                speech.launch(ask)
            } catch (e: ActivityNotFoundException) {
                Toast.makeText(this, "This phone has no speech-to-text installed; type the note instead.", Toast.LENGTH_LONG).show()
            }
        }

        findViewById<MaterialButton>(R.id.save).setOnClickListener {
            val account = spinner.selectedItem as Account
            var fileName = name.text.toString().trim().replace(Regex("[\\u0000-\\u001f/\\\\]"), "-")
            if (fileName.isEmpty()) fileName = "Receipt.pdf"
            if (!fileName.lowercase(Locale.US).endsWith(".pdf")) fileName += ".pdf"
            Queue(this).add(scan, fileName, account.code, if (account.code.isEmpty()) "" else account.name, note.text.toString().trim())
            scan.delete()
            prefs.lastAccount = account.code
            Sender.schedule(this)
            Toast.makeText(this, if (prefs.autoSend) "Saved. It is sent as soon as the server can be reached." else "Saved on this phone. Send it from the list.", Toast.LENGTH_LONG).show()
            finish()
        }
        findViewById<MaterialButton>(R.id.discard).setOnClickListener {
            scan.delete()
            finish()
        }
    }

    companion object {
        const val PAGES = "pages"
    }
}
