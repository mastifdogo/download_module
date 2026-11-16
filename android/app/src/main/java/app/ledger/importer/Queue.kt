package app.ledger.importer

import android.content.Context
import org.json.JSONObject
import java.io.File
import java.util.UUID

/** One scanned receipt waiting on the phone, or already sent. */
data class QueueItem(
    val id: String,
    val name: String,
    val accountCode: String,
    val accountName: String,
    val note: String,
    val createdAt: Long,
    val sentAt: Long,
    val error: String,
) {
    val sent: Boolean get() = sentAt > 0
}

/**
 * Receipts kept on the phone: each is a PDF and a small file describing it,
 * in the app's own storage. A receipt stays here until the server has taken
 * it; sent ones are remembered for a week, without their PDF.
 */
class Queue(context: Context) {
    private val dir = File(context.applicationContext.filesDir, "queue").apply { mkdirs() }

    fun pdf(id: String) = File(dir, "$id.pdf")
    private fun meta(id: String) = File(dir, "$id.json")

    /** Takes a scanned PDF into the queue. */
    @Synchronized
    fun add(source: File, name: String, accountCode: String, accountName: String, note: String): QueueItem {
        val id = UUID.randomUUID().toString()
        source.copyTo(pdf(id), overwrite = true)
        val item = QueueItem(id, name, accountCode, accountName, note, System.currentTimeMillis(), 0, "")
        write(item)
        return item
    }

    @Synchronized
    fun write(item: QueueItem) {
        val o = JSONObject()
            .put("id", item.id).put("name", item.name).put("account_code", item.accountCode).put("account_name", item.accountName)
            .put("note", item.note).put("created_at", item.createdAt).put("sent_at", item.sentAt).put("error", item.error)
        val tmp = File(dir, "${item.id}.json.tmp")
        tmp.writeText(o.toString())
        tmp.renameTo(meta(item.id))
    }

    @Synchronized
    fun all(): List<QueueItem> {
        val weekAgo = System.currentTimeMillis() - 7L * 24 * 3600 * 1000
        val out = ArrayList<QueueItem>()
        for (f in dir.listFiles { f -> f.name.endsWith(".json") } ?: emptyArray()) {
            try {
                val o = JSONObject(f.readText())
                val item = QueueItem(
                    o.getString("id"), o.getString("name"), o.optString("account_code"), o.optString("account_name"),
                    o.optString("note"), o.getLong("created_at"), o.optLong("sent_at"), o.optString("error"),
                )
                if (item.sent && item.sentAt < weekAgo) remove(item.id) else out.add(item)
            } catch (e: Exception) {
                // a half-written file: leave it
            }
        }
        return out.sortedByDescending { it.createdAt }
    }

    fun pending(): List<QueueItem> = all().filter { !it.sent && pdf(it.id).exists() }.sortedBy { it.createdAt }

    @Synchronized
    fun markSent(item: QueueItem) {
        write(item.copy(sentAt = System.currentTimeMillis(), error = ""))
        pdf(item.id).delete()
    }

    @Synchronized
    fun remove(id: String) {
        pdf(id).delete()
        meta(id).delete()
    }
}
