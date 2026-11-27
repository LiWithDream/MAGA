package com.agystudio.remote

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat

object NotificationHelper {
    const val CHANNEL_APPROVALS = "agy_approvals"
    const val CHANNEL_COMPLETED = "agy_completed"
    const val EXTRA_CASCADE_ID = "com.agystudio.remote.EXTRA_CASCADE_ID"

    fun ensureChannels(context: Context) {
        val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as? NotificationManager ?: return
        val approvalChannel = NotificationChannel(
            CHANNEL_APPROVALS,
            context.getString(R.string.channel_approvals_name),
            NotificationManager.IMPORTANCE_HIGH
        ).apply {
            description = context.getString(R.string.channel_approvals_desc)
            enableVibration(true)
            vibrationPattern = longArrayOf(0, 80, 60, 80)
        }
        val completedChannel = NotificationChannel(
            CHANNEL_COMPLETED,
            context.getString(R.string.channel_completed_name),
            NotificationManager.IMPORTANCE_DEFAULT
        ).apply {
            description = context.getString(R.string.channel_completed_desc)
            enableVibration(true)
            vibrationPattern = longArrayOf(0, 35, 50, 35)
        }
        nm.createNotificationChannel(approvalChannel)
        nm.createNotificationChannel(completedChannel)
    }

    fun hasNotificationPermission(context: Context): Boolean {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return true
        return ContextCompat.checkSelfPermission(
            context,
            Manifest.permission.POST_NOTIFICATIONS
        ) == PackageManager.PERMISSION_GRANTED
    }

    fun showNotification(
        context: Context,
        title: String,
        body: String,
        tag: String,
        category: String,
        cascadeId: String
    ) {
        if (!hasNotificationPermission(context)) return
        ensureChannels(context)
        val isApproval = category.equals("approval", ignoreCase = true)
        val channelId = if (isApproval) CHANNEL_APPROVALS else CHANNEL_COMPLETED

        val intent = Intent(context, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
            if (cascadeId.isNotBlank()) {
                putExtra(EXTRA_CASCADE_ID, cascadeId)
            }
        }
        val reqCode = (tag.ifBlank { cascadeId.ifBlank { title } }).hashCode()
        val pi = PendingIntent.getActivity(
            context,
            reqCode,
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        val builder = NotificationCompat.Builder(context, channelId)
            .setSmallIcon(R.mipmap.ic_launcher)
            .setContentTitle(title.ifBlank { context.getString(R.string.app_name) })
            .setContentText(body)
            .setStyle(NotificationCompat.BigTextStyle().bigText(body))
            .setAutoCancel(true)
            .setContentIntent(pi)
            .setPriority(if (isApproval) NotificationCompat.PRIORITY_HIGH else NotificationCompat.PRIORITY_DEFAULT)

        try {
            NotificationManagerCompat.from(context).notify(tag.ifBlank { null }, reqCode, builder.build())
        } catch (_: SecurityException) {
            // Permission revoked at runtime
        }
    }

    fun vibratePattern(context: Context, timings: LongArray) {
        if (timings.isEmpty()) return
        val vibrator = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            val vm = context.getSystemService(Context.VIBRATOR_MANAGER_SERVICE) as? VibratorManager
            vm?.defaultVibrator
        } else {
            @Suppress("DEPRECATION")
            context.getSystemService(Context.VIBRATOR_SERVICE) as? Vibrator
        } ?: return
        try {
            if (!vibrator.hasVibrator()) return
            val fullPattern = LongArray(timings.size + 1)
            fullPattern[0] = 0L
            for (i in timings.indices) {
                fullPattern[i + 1] = timings[i].coerceIn(10L, 600L)
            }
            vibrator.vibrate(VibrationEffect.createWaveform(fullPattern, -1))
        } catch (_: Exception) {
            // Ignore haptic errors on devices without vibrator
        }
    }
}
