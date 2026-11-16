package app.ledger.importer

import android.content.Context
import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.Worker
import androidx.work.WorkerParameters
import java.util.concurrent.TimeUnit

/** Sending what waits in the queue, by hand or by itself when the phone is connected. */
object Sender {
    private val lock = Any()

    /**
     * Sends every waiting receipt, oldest first. Returns how many were sent
     * and, if it stopped, why. A receipt the server refuses for good (too
     * large, not allowed) keeps its reason and the rest still go.
     */
    fun sendAll(context: Context): Pair<Int, String> = synchronized(lock) {
        val prefs = Prefs(context)
        if (!prefs.configured) return 0 to "Set up the server first"
        val queue = Queue(context)
        val client = LedgerClient(prefs)
        var sent = 0
        var problem = ""
        for (item in queue.pending()) {
            try {
                client.upload(item, queue.pdf(item.id))
                queue.markSent(item)
                sent++
            } catch (e: ServerException) {
                queue.write(item.copy(error = e.message ?: "refused"))
                problem = e.message ?: "refused"
                if (e.status == 401 || e.status == 403 || e.status >= 500) break // nothing will get through now
            } catch (e: Exception) {
                problem = "Can't reach the server (${e.message ?: e.javaClass.simpleName})"
                break
            }
        }
        sent to problem
    }

    /** Asks Android to send the queue as soon as there is a connection, and to look again every so often. */
    fun schedule(context: Context) {
        val wm = WorkManager.getInstance(context)
        if (!Prefs(context).autoSend) {
            wm.cancelUniqueWork(NOW)
            wm.cancelUniqueWork(REGULAR)
            return
        }
        val online = Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build()
        wm.enqueueUniqueWork(
            NOW, ExistingWorkPolicy.REPLACE,
            OneTimeWorkRequestBuilder<SendWorker>().setConstraints(online).setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 1, TimeUnit.MINUTES).build(),
        )
        wm.enqueueUniquePeriodicWork(
            REGULAR, ExistingPeriodicWorkPolicy.KEEP,
            PeriodicWorkRequestBuilder<SendWorker>(30, TimeUnit.MINUTES).setConstraints(online).build(),
        )
    }

    private const val NOW = "send-now"
    private const val REGULAR = "send-regularly"
}

class SendWorker(context: Context, params: WorkerParameters) : Worker(context, params) {
    override fun doWork(): Result {
        val queue = Queue(applicationContext)
        if (Prefs(applicationContext).autoSend && queue.pending().isNotEmpty()) {
            Sender.sendAll(applicationContext)
        }
        // Once a day, see whether there is a newer app.
        try {
            Updater.checkQuietly(applicationContext)
        } catch (e: Exception) {
            // next time
        }
        // The phone is on a network but the server wasn't reached (away from home): try again later.
        return if (Prefs(applicationContext).autoSend && queue.pending().isNotEmpty() && runAttemptCount < 8) Result.retry() else Result.success()
    }
}
