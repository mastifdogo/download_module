package app.ledger.importer

import android.os.Build
import android.util.Base64
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL

/** The server answered, but not with what was asked for. */
class ServerException(val status: Int, message: String) : IOException(message)

/** An account a receipt can be put under. */
data class Account(val code: String, val name: String, val type: String, val currency: String) {
    override fun toString() = "$code  $name"
}

/**
 * Talks to Ledger: logs in with the saved username and password (again
 * whenever the session has run out), lists the accounts, and uploads a
 * receipt to the Import module's inbox.
 */
class LedgerClient(private val prefs: Prefs) {

    private fun open(method: String, path: String, body: JSONObject?, withCookie: Boolean): HttpURLConnection {
        if (prefs.server.isEmpty()) throw IOException("Enter the server's address first")
        val c = URL(prefs.server + "/api/v1" + path).openConnection() as HttpURLConnection
        c.requestMethod = method
        c.connectTimeout = 10_000
        c.readTimeout = 60_000
        c.instanceFollowRedirects = false
        c.setRequestProperty("Accept", "application/json")
        if (withCookie && prefs.cookie.isNotEmpty()) c.setRequestProperty("Cookie", prefs.cookie)
        if (body != null) {
            val bytes = body.toString().toByteArray(Charsets.UTF_8)
            c.doOutput = true
            c.setRequestProperty("Content-Type", "application/json")
            c.setFixedLengthStreamingMode(bytes.size)
            c.outputStream.use { it.write(bytes) }
        }
        return c
    }

    private fun read(c: HttpURLConnection): String {
        val status = c.responseCode
        val text = (if (status < 400) c.inputStream else c.errorStream)?.bufferedReader(Charsets.UTF_8)?.use { it.readText() } ?: ""
        if (status in 200..299) return text
        val message = try {
            JSONObject(text).getJSONObject("error").getString("message")
        } catch (e: Exception) {
            "the server answered $status"
        }
        throw ServerException(status, message)
    }

    /** Logs in and keeps the session cookie. */
    fun login() {
        val c = open("POST", "/auth/login", JSONObject().put("username", prefs.username).put("password", prefs.password), false)
        try {
            read(c)
            val cookie = c.headerFields.entries
                .filter { it.key?.equals("Set-Cookie", ignoreCase = true) == true }
                .flatMap { it.value }
                .firstOrNull { it.startsWith("ledger_session=") }
                ?: throw IOException("the server did not start a session; is this address a Ledger server?")
            prefs.cookie = cookie.substringBefore(';')
        } finally {
            c.disconnect()
        }
    }

    /** One request, logging in first when there is no session or it has run out. */
    private fun call(method: String, path: String, body: JSONObject? = null): String {
        if (prefs.cookie.isEmpty()) login()
        var c = open(method, path, body, true)
        try {
            return read(c)
        } catch (e: ServerException) {
            if (e.status != 401) throw e
        } finally {
            c.disconnect()
        }
        login()
        c = open(method, path, body, true)
        try {
            return read(c)
        } finally {
            c.disconnect()
        }
    }

    /** Who is logged in, as a sentence for the settings screen. */
    fun whoAmI(): String {
        val me = JSONObject(call("GET", "/auth/me"))
        return "${me.getString("username")} (${me.getString("role")}) in ${me.getJSONObject("organization").getString("name")}"
    }

    /** The accounts a receipt can go under, saved for when there is no connection. */
    fun refreshAccounts(): List<Account> {
        val data = JSONObject(call("GET", "/accounts")).getJSONArray("data")
        val keep = JSONArray()
        for (i in 0 until data.length()) {
            val a = data.getJSONObject(i)
            if (!a.optBoolean("is_active", true) || a.optBoolean("hidden", false)) continue
            keep.put(JSONObject().put("code", a.getString("code")).put("name", a.getString("name")).put("type", a.getString("type")).put("currency", a.getString("currency")))
        }
        prefs.accountsJson = keep.toString()
        return accounts(prefs)
    }

    /** Sends one receipt to the Import module's inbox, in pieces the server accepts. */
    fun upload(item: QueueItem, pdf: File) {
        val base = "/m/${BuildConfig.MODULE_ID}/files"
        val started = JSONObject(
            call(
                "POST", base,
                JSONObject()
                    .put("name", item.name)
                    .put("size", pdf.length())
                    .put("content_type", "application/pdf")
                    .put("origin", "app")
                    .put("note", item.note)
                    .put("account_code", item.accountCode)
                    .put("device", "${Build.MANUFACTURER} ${Build.MODEL}".trim()),
            ),
        )
        val id = started.getLong("id")
        val chunkSize = started.getInt("chunk_size")
        pdf.inputStream().use { input ->
            val buf = ByteArray(chunkSize)
            var index = 0
            while (true) {
                var n = 0
                while (n < chunkSize) {
                    val r = input.read(buf, n, chunkSize - n)
                    if (r < 0) break
                    n += r
                }
                if (n == 0) break
                call("PUT", "$base/$id/chunks/$index", JSONObject().put("data", Base64.encodeToString(buf, 0, n, Base64.NO_WRAP)))
                index++
                if (n < chunkSize) break
            }
        }
        call("POST", "$base/$id/complete")
    }

    companion object {
        /** The saved accounts: expenses first (where receipts usually go), then the rest by code. */
        fun accounts(prefs: Prefs): List<Account> {
            val out = ArrayList<Account>()
            try {
                val arr = JSONArray(prefs.accountsJson)
                for (i in 0 until arr.length()) {
                    val a = arr.getJSONObject(i)
                    out.add(Account(a.getString("code"), a.getString("name"), a.getString("type"), a.getString("currency")))
                }
            } catch (e: Exception) {
                // nothing saved yet
            }
            return out.sortedWith(compareBy<Account> { if (it.type == "expense") 0 else 1 }.thenBy { it.code })
        }
    }
}
