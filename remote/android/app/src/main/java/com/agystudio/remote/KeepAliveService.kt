package com.agystudio.remote

import android.app.Notification
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat

class KeepAliveService : Service() {
    companion object {
        const val NOTIF_ID = 10401
        const val ACTION_START = "com.agystudio.remote.KEEPALIVE_START"
        const val ACTION_STOP = "com.agystudio.remote.KEEPALIVE_STOP"
        const val EXTRA_STATUS = "status_text"

        @Volatile
        var isRunning: Boolean = false
            private set

        @Volatile
        var lastStatusText: String = "等待桌面端审批与任务完成提醒"
            private set

        @Volatile
        var onStoppedListener: (() -> Unit)? = null

        fun start(context: Context, statusText: String = lastStatusText): Boolean {
            val cleanStatus = statusText.trim().ifEmpty { lastStatusText }
            lastStatusText = cleanStatus
            val intent = Intent(context, KeepAliveService::class.java).apply {
                action = ACTION_START
                putExtra(EXTRA_STATUS, cleanStatus)
            }
            return try {
                ContextCompat.startForegroundService(context, intent)
                true
            } catch (_: Exception) {
                isRunning = false
                ServerPrefs.setKeepAliveEnabled(context, false)
                false
            }
        }

        fun updateStatus(context: Context, statusText: String) {
            val cleanStatus = statusText.trim().ifEmpty { return }
            lastStatusText = cleanStatus
            if (!isRunning) return
            try {
                val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as? NotificationManager ?: return
                NotificationHelper.ensureChannels(context)
                nm.notify(NOTIF_ID, buildNotification(context, cleanStatus))
            } catch (_: Exception) {
            }
        }

        fun stop(context: Context) {
            isRunning = false
            try {
                context.stopService(Intent(context, KeepAliveService::class.java))
            } catch (_: Exception) {
            }
        }

        private fun buildNotification(context: Context, statusText: String): Notification {
            val openIntent = Intent(context, MainActivity::class.java).apply {
                flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
            }
            val openPi = PendingIntent.getActivity(
                context,
                NOTIF_ID,
                openIntent,
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
            )

            val stopIntent = Intent(context, KeepAliveService::class.java).apply {
                action = ACTION_STOP
            }
            val stopPi = PendingIntent.getService(
                context,
                NOTIF_ID + 1,
                stopIntent,
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
            )

            val safeBody = statusText.trim().ifEmpty { "等待桌面端审批与任务完成提醒" }
            return NotificationCompat.Builder(context, NotificationHelper.CHANNEL_KEEPALIVE)
                .setSmallIcon(R.mipmap.ic_launcher)
                .setContentTitle("AGY Remote 后台监听中")
                .setContentText(safeBody)
                .setOngoing(true)
                .setOnlyAlertOnce(true)
                .setSilent(true)
                .setCategory(NotificationCompat.CATEGORY_SERVICE)
                .setPriority(NotificationCompat.PRIORITY_LOW)
                .setContentIntent(openPi)
                .addAction(0, "停止监听", stopPi)
                .build()
        }
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            ServerPrefs.setKeepAliveEnabled(this, false)
            isRunning = false
            onStoppedListener?.invoke()
            runCatching { stopForeground(STOP_FOREGROUND_REMOVE) }
            stopSelf()
            return START_NOT_STICKY
        }

        NotificationHelper.ensureChannels(this)
        val statusText = intent?.getStringExtra(EXTRA_STATUS).orEmpty().ifBlank { lastStatusText }
        lastStatusText = statusText
        val notif = buildNotification(this, statusText)
        return try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                startForeground(NOTIF_ID, notif, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
            } else {
                startForeground(NOTIF_ID, notif)
            }
            isRunning = true
            START_NOT_STICKY
        } catch (_: Exception) {
            isRunning = false
            ServerPrefs.setKeepAliveEnabled(this, false)
            stopSelf()
            START_NOT_STICKY
        }
    }

    override fun onTimeout(startId: Int, fgsType: Int) {
        isRunning = false
        ServerPrefs.setKeepAliveEnabled(this, false)
        onStoppedListener?.invoke()
        runCatching { stopForeground(STOP_FOREGROUND_REMOVE) }
        stopSelf()
    }

    override fun onDestroy() {
        isRunning = false
        super.onDestroy()
    }
}
